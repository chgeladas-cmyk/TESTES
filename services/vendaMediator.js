'use strict';
/**
 * services/vendaMediator.js — CH Geladas PDV
 * ═══════════════════════════════════════════════════════════════════
 * Padrão Mediator: centraliza toda a orquestração entre
 * VendasService, EstoqueService e FinanceiroService.
 *
 * PROBLEMA RESOLVIDO:
 *   Antes: vendasService chamava EstoqueService diretamente.
 *          aprovacaoService chamava EstoqueService e FinanceiroService diretamente.
 *          financeiroService ouvia eventos para se auto-chamar.
 *   Resultado: acoplamento forte, difícil de testar, difícil de modificar.
 *
 *   Depois: cada service emite um evento e para.
 *           O Mediator escuta todos os eventos e orquestra a sequência.
 *           Services não se conhecem — só conhecem o Mediator via EventBus.
 *
 * CONTRATO:
 *   Eventos recebidos (emitidos pelos services):
 *     'venda:finalizada'          → baixa estoque + receita financeira + auditoria
 *     'venda:pendente'            → reserva estoque
 *     'venda:cancelada'           → estorno estoque + estorno financeiro + auditoria
 *     'venda:aprovada'            → auditoria de aprovação
 *     'venda:rejeitada'           → libera reserva + auditoria
 *     'venda:validada'            → libera reserva + receita financeira + auditoria
 *     'venda:erro_validacao'      → auditoria de erro
 *     'estoque:movimentado'       → custo de compra no financeiro
 *
 *   Eventos emitidos (para UI e outros sistemas):
 *     'mediator:estoque:baixa_ok'       → baixa confirmada com sucesso
 *     'mediator:estoque:baixa_falhou'   → baixa falhou (divergência detectada)
 *     'mediator:estoque:reserva_ok'     → reserva criada
 *     'mediator:estoque:reserva_falhou' → reserva bloqueada (sem estoque)
 *     'mediator:financeiro:lancado'     → lançamento registrado
 *     'mediator:erro'                   → erro inesperado no Mediator
 *
 * INVARIANTES:
 *   - Nunca modifica Store diretamente
 *   - Nunca chama FirebaseService diretamente
 *   - Toda chamada a services é via window.CH.<Service>
 *   - Se um service não estiver carregado, loga e segue
 *   - Idempotência herdada dos services chamados (sem duplicação aqui)
 *
 * Requer: core.js + todos os services carregados antes.
 */

(function () {
  function _Bus()        { return window.CH.EventBus; }
  function _Store()      { return window.CH.Store; }
  function _Estoque()    { return window.CH.EstoqueService; }
  function _Financeiro() { return window.CH.FinanceiroService; }
  function _Audit()      { return window.CH.AuditService; }

  // ── Helper: emite evento de resultado do Mediator ─────────────────
  function _emit(evento, dados) {
    try { _Bus().emit(evento, dados); } catch (_) {}
  }

  function _erro(contexto, e, extra = {}) {
    console.error(`[VendaMediator] Erro em ${contexto}:`, e.message || e);
    _emit('mediator:erro', { contexto, erro: e.message || String(e), ...extra });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: venda:finalizada
  //  Delega para TransactionManager.criarTransacaoVendaFinalizada()
  //  que executa: Estoque → Financeiro → Auditoria → Sync
  // ═══════════════════════════════════════════════════════════════════
  async function _onVendaFinalizada(venda) {
    if (!venda?.id) return;
    const TM = window.CH.TransactionManager;
    if (TM) {
      const resultado = await TM.criarTransacaoVendaFinalizada(venda);
      if (resultado.status === 'compensado') {
        _emit('mediator:estoque:baixa_falhou', {
          vendaId:       venda.id,
          correlationId: venda.correlationId,
          erros:         resultado.steps.filter(s => s.status === 'falhou').map(s => s.erro),
        });
        _emit('integrity:venda_sem_baixa', {
          vendaId: venda.id,
          status:  'concluida',
          motivo:  resultado.steps.find(s => s.status === 'falhou')?.erro,
        });
      } else {
        _emit('mediator:estoque:baixa_ok', { vendaId: venda.id, correlationId: venda.correlationId });
        _emit('mediator:financeiro:lancado', { tipo: 'receita', vendaId: venda.id, valor: venda.total });
      }
      return;
    }
    // Fallback: TransactionManager não disponível — executa diretamente
    console.warn('[VendaMediator] TransactionManager não disponível — execução direta');
    await _onVendaFinalizadaDireto(venda);
  }

  // Fallback usado quando TransactionManager não está carregado
  async function _onVendaFinalizadaDireto(venda) {
    const ES = _Estoque();
    if (ES?.baixarEstoqueVendaLote) {
      try {
        const r = await ES.baixarEstoqueVendaLote(venda);
        if (!r.ok && r.itensProcessados === 0) {
          _emit('integrity:venda_sem_baixa', { vendaId: venda.id, motivo: r.erros?.join('; ') });
          return;
        }
      } catch (e) {
        _emit('integrity:venda_sem_baixa', { vendaId: venda.id, motivo: e.message });
        return;
      }
    }
    const FS = _Financeiro();
    if (FS?.registrarReceita) FS.registrarReceita(venda);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: venda:pendente
  //  Delega para TransactionManager.criarTransacaoReserva()
  // ═══════════════════════════════════════════════════════════════════
  async function _onVendaPendente(venda) {
    if (!venda?.id) return;
    const TM = window.CH.TransactionManager;
    if (TM) {
      const resultado = await TM.criarTransacaoReserva(venda);
      if (resultado.status === 'compensado') {
        _emit('mediator:estoque:reserva_falhou', {
          vendaId: venda.id,
          erros:   resultado.steps.filter(s => s.status === 'falhou').map(s => s.erro),
        });
      } else {
        _emit('mediator:estoque:reserva_ok', { vendaId: venda.id });
      }
      return;
    }
    const ES = _Estoque();
    if (!ES?.reservarEstoque) return;
    try {
      const r = await ES.reservarEstoque(venda.id, venda.itens || []);
      if (r?.ok) _emit('mediator:estoque:reserva_ok', { vendaId: venda.id });
      else _emit('mediator:estoque:reserva_falhou', { vendaId: venda.id, erros: r?.erros || [] });
    } catch (e) {
      _erro('venda:pendente → reservar', e, { vendaId: venda.id });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: venda:cancelada
  //  Delega para TransactionManager.criarTransacaoVendaCancelada()
  // ═══════════════════════════════════════════════════════════════════
  async function _onVendaCancelada({ vendaId, venda, operador }) {
    if (!vendaId) return;
    const v = venda || _Store()?.getVendas()?.find(x => x.id === vendaId);
    if (!v) return;
    const TM = window.CH.TransactionManager;
    if (TM) {
      await TM.criarTransacaoVendaCancelada(v, v.motivoCancelamento || 'Cancelamento operacional');
      return;
    }
    // Fallback direto
    const ES = _Estoque();
    if (v && ['concluida', 'validada'].includes(v.status) && ES?.cancelarVenda) {
      try { await ES.cancelarVenda(vendaId, v.itens || []); } catch (e) { _erro('cancelada→estoque', e, { vendaId }); }
    }
    const FS = _Financeiro();
    if (v && FS?.registrarEstorno) {
      try { FS.registrarEstorno(v); } catch (e) { _erro('cancelada→financeiro', e, { vendaId }); }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: venda:aprovada
  //  Sem delegação ao TransactionManager — apenas log
  // ═══════════════════════════════════════════════════════════════════
  function _onVendaAprovada({ vendaId, operador }) {
    if (!vendaId) return;
    console.info(`[VendaMediator] venda:aprovada — id=${vendaId} por ${operador}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: venda:rejeitada
  //  Libera reserva — operação simples, sem TransactionManager
  // ═══════════════════════════════════════════════════════════════════
  async function _onVendaRejeitada({ vendaId, motivo, operador }) {
    if (!vendaId) return;
    const ES = _Estoque();
    if (!ES?.liberarReserva) return;
    const venda = _Store()?.getVendas()?.find(v => v.id === vendaId);
    if (venda?._cambio) return;
    try { await ES.liberarReserva(vendaId); }
    catch (e) { _erro('venda:rejeitada → liberarReserva', e, { vendaId }); }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: venda:validada
  //  Delega para TransactionManager.criarTransacaoValidacao()
  // ═══════════════════════════════════════════════════════════════════
  async function _onVendaValidada(venda) {
    if (!venda?.id) return;
    const TM = window.CH.TransactionManager;
    if (TM) {
      await TM.criarTransacaoValidacao(venda);
      return;
    }
    // Fallback direto
    const ES = _Estoque();
    if (ES?.liberarReserva && !venda._cambio) {
      try { await ES.liberarReserva(venda.id); } catch (e) { _erro('validada→reserva', e); }
    }
    const FS = _Financeiro();
    if (FS?.registrarReceita) {
      try { FS.registrarReceita(venda); } catch (e) { _erro('validada→financeiro', e); }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: venda:erro_validacao
  // ═══════════════════════════════════════════════════════════════════
  function _onErroValidacao({ vendaId, motivo, operador }) {
    console.warn(`[VendaMediator] venda:erro_validacao — id=${vendaId} motivo=${motivo}`);
    _emit('mediator:erro', { contexto: 'erro_validacao', vendaId, motivo });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: estoque:movimentado
  //  Custo de compra → financeiro (apenas entradas)
  // ═══════════════════════════════════════════════════════════════════
  function _onEstoqueMovimentado(mov) {
    if (mov.tipo !== 'entrada') return;
    const custo = Math.abs(mov.custo ?? 0) * Math.abs(mov.quantidade ?? 0);
    if (custo <= 0) return;
    const FS = _Financeiro();
    if (!FS?.registrarCustoCompra) return;
    try { FS.registrarCustoCompra(mov); }
    catch (e) { _erro('estoque:movimentado → financeiro', e, { produtoId: mov.produtoId }); }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  REGISTRO DOS HANDLERS NO EVENTBUS
  // ═══════════════════════════════════════════════════════════════════
  _Bus().on('venda:finalizada',     venda => _onVendaFinalizada(venda));
  _Bus().on('venda:pendente',       venda => _onVendaPendente(venda));
  _Bus().on('venda:cancelada',      payload => _onVendaCancelada(payload));
  _Bus().on('venda:aprovada',       payload => _onVendaAprovada(payload));
  _Bus().on('venda:rejeitada',      payload => _onVendaRejeitada(payload));
  _Bus().on('venda:validada',       venda => _onVendaValidada(venda));
  _Bus().on('venda:erro_validacao', payload => _onErroValidacao(payload));
  _Bus().on('estoque:movimentado',  mov => _onEstoqueMovimentado(mov));

  // ── Exportar API de diagnóstico ───────────────────────────────────
  window.CH.VendaMediator = {
    /**
     * Retorna os handlers registrados (para diagnóstico).
     */
    getHandlers() {
      return [
        'venda:finalizada',
        'venda:pendente',
        'venda:cancelada',
        'venda:aprovada',
        'venda:rejeitada',
        'venda:validada',
        'venda:erro_validacao',
        'estoque:movimentado',
      ];
    },
  };

  console.info('%c VendaMediator ✓  (desacoplamento: Venda → Mediator → Estoque/Financeiro)', 'color:#f59e0b;font-weight:bold');
})();
