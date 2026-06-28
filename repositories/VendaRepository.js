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
 * PAGINAÇÃO:
 *   PAGE_SIZE = 50 — único lugar onde o tamanho de página é definido.
 *   Listeners RT carregam sempre as 50 mais recentes.
 *   Histórico completo via buscarPagina() + startAfter().
 *
 * CONTRATO PÚBLICO:
 *   salvar(venda)                        → persiste nova venda
 *   atualizar(venda)                     → atualiza venda existente
 *   deletar(vendaId)                     → soft-delete
 *   buscarPagina(cursor?, limite?)       → primeira ou próxima página do Firestore
 *   buscarProximaPagina(cursor, limite?) → alias explícito com cursor obrigatório
 *   buscarPorId(vendaId)                 → lê do Store local (síncrono)
 *   buscarPendentes()                    → vendas com status 'pendente'
 *   buscarHoje()                         → vendas do dia
 *   buscarConcluidasHoje()               → vendas concluídas/validadas hoje
 *   buscarPorStatus(status)              → filtra por status no Store local
 *
 * Requer: core.js (window.CH.{Store, Utils, SyncQueue}) carregado antes.
 */

(function () {
  function _Store()     { return window.CH.Store; }
  function _Utils()     { return window.CH.Utils; }
  function _Queue()     { return window.CH.SyncQueue; }
  function _Firebase()  { return window.CH.FirebaseService; }

  function _isOnline() { return navigator.onLine; }

  function _firebaseDisponivel() {
    const fb = _Firebase();
    return _isOnline() && fb?.isReady?.();
  }

  // ── Tamanho de página — único ponto de configuração ───────────────
  const PAGE_SIZE = 50;

  // ── Operações de escrita ──────────────────────────────────────────

  function salvar(venda) {
    if (!venda?.id) {
      console.warn('[VendaRepository] salvar: venda sem id ignorada');
      return;
    }
    _Queue()?.enqueue('salvar', 'vendas', [venda]);
  }

  function atualizar(venda) {
    if (!venda?.id) {
      console.warn('[VendaRepository] atualizar: venda sem id ignorada');
      return;
    }
    _Queue()?.enqueue('atualizar', 'vendas', [venda]);
  }

  function deletar(vendaId) {
    if (!vendaId) return;
    _Queue()?.enqueue('deletar', 'vendas', [vendaId]);
  }

  // ── Paginação — Firestore ─────────────────────────────────────────

  /**
   * Busca uma página de vendas do Firestore com paginação real via startAfter().
   *
   * @param {object} opts
   * @param {DocumentSnapshot} [opts.cursor]  — último doc da página anterior (para próxima página)
   * @param {number}           [opts.limite]  — itens por página (padrão: PAGE_SIZE)
   * @param {number}           [opts.pagina]  — número da página (informativo, para UI)
   * @returns {Promise<{
   *   docs:      object[],          — vendas desta página
   *   ultimoDoc: DocumentSnapshot|null, — cursor para próxima chamada
   *   temMais:   boolean,           — há mais páginas?
   *   pagina:    number,
   *   total:     number,            — docs nesta página
   * }>}
   */
  async function buscarPagina({ cursor = null, limite = PAGE_SIZE, pagina = 1 } = {}) {
    if (!_firebaseDisponivel()) {
      console.info('[VendaRepository] buscarPagina: offline — retornando Store local');
      const local = _Store().getVendas();
      const inicio = (pagina - 1) * limite;
      const docs   = local.slice(inicio, inicio + limite);
      return {
        docs,
        ultimoDoc: null,
        temMais:   inicio + docs.length < local.length,
        pagina,
        total:     docs.length,
        fonte:     'local',
      };
    }

    try {
      const resultado = await _Firebase().ler('vendas', { cursor, limite, pagina });
      if (!resultado) return _paginaVazia(pagina);

      // Remove o campo interno _docSnapshot dos objetos retornados para a UI
      const docs = resultado.docs.map(({ _docSnapshot, ...venda }) => venda);

      console.info(
        `[VendaRepository] Página ${pagina}: ${docs.length} vendas` +
        ` (temMais: ${resultado.temMais})`
      );

      return {
        docs,
        ultimoDoc: resultado.ultimoDoc || null,
        temMais:   resultado.temMais,
        pagina,
        total:     docs.length,
        fonte:     'firestore',
      };
    } catch (e) {
      console.warn('[VendaRepository] buscarPagina falhou:', e.message);
      return _paginaVazia(pagina);
    }
  }

  /**
   * Busca a próxima página a partir de um cursor (último doc da página anterior).
   * Alias explícito de buscarPagina com cursor obrigatório.
   *
   * @param {DocumentSnapshot} cursor
   * @param {number}           [limite]
   * @param {number}           [pagina]  — número da próxima página (informativo)
   */
  async function buscarProximaPagina(cursor, limite = PAGE_SIZE, pagina = 2) {
    if (!cursor) throw new Error('[VendaRepository] buscarProximaPagina: cursor é obrigatório');
    return buscarPagina({ cursor, limite, pagina });
  }

  /**
   * Carrega todas as páginas até não ter mais resultados.
   * ATENÇÃO: usar apenas para exportação/relatórios — pode gerar muitas leituras.
   *
   * @param {number} [limitePorPagina]
   * @returns {Promise<object[]>} array completo de vendas
   */
  async function buscarTodasPaginadas(limitePorPagina = PAGE_SIZE) {
    if (!_firebaseDisponivel()) return _Store().getVendas();

    const todas = [];
    let cursor = null;
    let pagina = 1;
    let temMais = true;

    while (temMais) {
      const resultado = await buscarPagina({ cursor, limite: limitePorPagina, pagina });
      todas.push(...resultado.docs);
      cursor  = resultado.ultimoDoc;
      temMais = resultado.temMais;
      pagina++;

      // Segurança: máximo de 20 páginas (1000 vendas) para evitar loop infinito
      if (pagina > 20) {
        console.warn('[VendaRepository] buscarTodasPaginadas: limite de 20 páginas atingido');
        break;
      }
    }

    return todas;
  }

  // ── Leitura — Store local (síncrona) ─────────────────────────────

  function buscarPorId(vendaId) {
    return _Store().getVendas().find(v => v.id === vendaId) || null;
  }

  function buscarPendentes() {
    return _Store().getVendas().filter(v => v.status === 'pendente');
  }

  function buscarHoje() {
    const hoje = _Utils().todayISO();
    return _Store().getVendas().filter(v => v.dataCurta === hoje);
  }

  function buscarPorStatus(status) {
    const statuses = Array.isArray(status) ? status : [status];
    return _Store().getVendas().filter(v => statuses.includes(v.status));
  }

  function buscarConcluidasHoje() {
    const hoje = _Utils().todayISO();
    return _Store().getVendas().filter(v =>
      v.dataCurta === hoje &&
      ['concluida', 'validada'].includes(v.status)
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────

  function _paginaVazia(pagina) {
    return { docs: [], ultimoDoc: null, temMais: false, pagina, total: 0, fonte: 'vazio' };
  }

  // ── Exportar ──────────────────────────────────────────────────────
  window.CH.VendaRepository = {
    // Escrita
    salvar,
    atualizar,
    deletar,
    // Paginação
    PAGE_SIZE,
    buscarPagina,
    buscarProximaPagina,
    buscarTodasPaginadas,
    // Leitura local (síncrona)
    buscarPorId,
    buscarPendentes,
    buscarHoje,
    buscarPorStatus,
    buscarConcluidasHoje,
  };

  console.info('%c VendaRepository ✓  (paginação: limit=50, startAfter)', 'color:#3b82f6;font-weight:bold');
})();
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
