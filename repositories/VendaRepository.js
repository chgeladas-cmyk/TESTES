'use strict';
/**
 * repositories/VendaRepository.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Camada de acesso a dados para Vendas.
 *
 * RESPONSABILIDADE:
 *   Encapsula TODA comunicação com o Firestore e SyncQueue
 *   relativa a vendas. Os serviços (vendasService, aprovacaoService)
 *   não conhecem FirebaseService — chamam apenas este repository.
 *
 * CONTRATO PÚBLICO:
 *   salvar(venda)            → persiste nova venda (local + fila)
 *   atualizar(venda)         → atualiza status/campos de venda existente
 *   deletar(vendaId)         → soft-delete de venda
 *   buscarTodas()            → lê todas as vendas do Firestore
 *   buscarPorId(vendaId)     → lê uma venda do Store local
 *   buscarPendentes()        → vendas com status 'pendente'
 *   buscarHoje()             → vendas do dia atual
 *
 * INVARIANTES:
 *   - Nunca importa FirebaseService diretamente — acessa via window.CH
 *   - Nunca chama Store.mutateVendas — responsabilidade do service
 *   - Garante idempotência: venda já sincronizada não é reenviada
 *
 * Requer: core.js (window.CH.{Store, Utils, SyncQueue}) carregado antes.
 */

(function () {
  function _Store()     { return window.CH.Store; }
  function _Utils()     { return window.CH.Utils; }
  function _Queue()     { return window.CH.SyncQueue; }
  function _Firebase()  { return window.CH.FirebaseService; }

  // ── Helpers ───────────────────────────────────────────────────────

  function _isOnline() { return navigator.onLine; }

  function _firebaseDisponivel() {
    const fb = _Firebase();
    return _isOnline() && fb?.isReady?.();
  }

  // ── Operações de escrita ──────────────────────────────────────────

  /**
   * Persiste uma nova venda.
   * 1. Store.mutateVendas deve ser chamado ANTES pelo service.
   * 2. Este método apenas enfileira a sincronização com o Firestore.
   *
   * Separado do mutate para permitir que o repository seja
   * substituído em testes sem precisar mockar o Store.
   *
   * @param {object} venda - objeto venda completo com id e _fbSynced:false
   */
  function salvar(venda) {
    if (!venda?.id) {
      console.warn('[VendaRepository] salvar: venda sem id ignorada');
      return;
    }
    _Queue()?.enqueue('salvar', 'vendas', [venda]);
  }

  /**
   * Atualiza campos de uma venda existente no Firestore (merge).
   * Usado para mudanças de status (aprovada, validada, cancelada).
   *
   * @param {object} venda - objeto venda com id e campos atualizados
   */
  function atualizar(venda) {
    if (!venda?.id) {
      console.warn('[VendaRepository] atualizar: venda sem id ignorada');
      return;
    }
    _Queue()?.enqueue('atualizar', 'vendas', [venda]);
  }

  /**
   * Soft-delete de uma venda no Firestore.
   * Marca _deleted:true no documento — não remove fisicamente.
   *
   * @param {string} vendaId
   */
  function deletar(vendaId) {
    if (!vendaId) return;
    _Queue()?.enqueue('deletar', 'vendas', [vendaId]);
  }

  // ── Operações de leitura ──────────────────────────────────────────

  /**
   * Lê todas as vendas do Firestore.
   * Usado pelo monitor e reconciliação — não para operações de PDV
   * (que sempre leem do Store local para performance).
   *
   * @returns {Promise<object[]|null>}
   */
  async function buscarTodas() {
    if (!_firebaseDisponivel()) {
      console.info('[VendaRepository] buscarTodas: offline — retornando Store local');
      return _Store().getVendas();
    }
    try {
      return await _Firebase().ler('vendas');
    } catch (e) {
      console.warn('[VendaRepository] buscarTodas falhou:', e.message);
      return _Store().getVendas();
    }
  }

  /**
   * Busca uma venda pelo id no Store local.
   * Operação síncrona — sem acesso ao Firestore.
   *
   * @param {string} vendaId
   * @returns {object|null}
   */
  function buscarPorId(vendaId) {
    return _Store().getVendas().find(v => v.id === vendaId) || null;
  }

  /**
   * Retorna vendas com status 'pendente'.
   * Usado pelo painel de aprovação.
   *
   * @returns {object[]}
   */
  function buscarPendentes() {
    return _Store().getVendas().filter(v => v.status === 'pendente');
  }

  /**
   * Retorna vendas do dia atual.
   *
   * @returns {object[]}
   */
  function buscarHoje() {
    const hoje = _Utils().todayISO();
    return _Store().getVendas().filter(v => v.dataCurta === hoje);
  }

  /**
   * Retorna vendas por status.
   *
   * @param {string|string[]} status
   * @returns {object[]}
   */
  function buscarPorStatus(status) {
    const statuses = Array.isArray(status) ? status : [status];
    return _Store().getVendas().filter(v => statuses.includes(v.status));
  }

  /**
   * Retorna vendas concluídas/validadas do dia (para KPIs e faturamento).
   *
   * @returns {object[]}
   */
  function buscarConcluidasHoje() {
    const hoje = _Utils().todayISO();
    return _Store().getVendas().filter(v =>
      v.dataCurta === hoje &&
      ['concluida', 'validada'].includes(v.status)
    );
  }

  // ── Exportar ──────────────────────────────────────────────────────
  window.CH.VendaRepository = {
    // Escrita
    salvar,
    atualizar,
    deletar,
    // Leitura
    buscarTodas,
    buscarPorId,
    buscarPendentes,
    buscarHoje,
    buscarPorStatus,
    buscarConcluidasHoje,
  };

  console.info('%c VendaRepository ✓', 'color:#3b82f6;font-weight:bold');
})();
