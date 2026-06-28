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
  //  Origem: vendasService.finalizarVenda() (fluxo direto, sem aprovação)
  //  Ação:   baixa de estoque → receita financeira
  //          (auditoria já é disparada pelo AuditService via seu próprio hook)
  // ═══════════════════════════════════════════════════════════════════
  async function _onVendaFinalizada(venda) {
    if (!venda?.id) return;
    console.info(`[VendaMediator] venda:finalizada — id=${venda.id} cid=${venda.correlationId}`);

    // ── 1. Baixa de estoque ──────────────────────────────────────────
    const ES = _Estoque();
    if (ES) {
      try {
        // Tenta via IntegrityService primeiro (rastreabilidade máxima)
        const IS = window.CH.IntegrityService;
        if (IS?.confirmarBaixaComRollback) {
          const r = await IS.confirmarBaixaComRollback(venda, null);
          if (!r.ok && r.rollbackExecutado) {
            console.error(`[VendaMediator] Baixa com rollback falhou: venda ${venda.id}`, r.erros);
            _emit('mediator:estoque:baixa_falhou', {
              vendaId:       venda.id,
              correlationId: venda.correlationId,
              erros:         r.erros,
              motivo:        r.erros?.join('; '),
            });
            _emit('integrity:venda_sem_baixa', {
              vendaId: venda.id,
              status:  'concluida',
              motivo:  r.erros?.join('; '),
            });
            return; // não registra receita se estoque falhou
          }
        } else if (ES.baixarEstoqueVendaLote) {
          const r = await ES.baixarEstoqueVendaLote(venda);
          if (!r.ok && r.itensProcessados === 0) {
            console.error(`[VendaMediator] baixarEstoqueVendaLote falhou: venda ${venda.id}`);
            _emit('mediator:estoque:baixa_falhou', {
              vendaId:       venda.id,
              correlationId: venda.correlationId,
              erros:         r.erros,
            });
            _emit('integrity:venda_sem_baixa', {
              vendaId: venda.id,
              status:  'concluida',
              motivo:  r.erros?.join('; '),
            });
            return;
          }
        }
        _emit('mediator:estoque:baixa_ok', { vendaId: venda.id, correlationId: venda.correlationId });
      } catch (e) {
        _erro('venda:finalizada → estoque', e, { vendaId: venda.id });
        _emit('integrity:venda_sem_baixa', {
          vendaId: venda.id,
          status:  'concluida',
          motivo:  e.message,
        });
        return; // não registra receita se estoque lançou exceção
      }
    }

    // ── 2. Receita financeira ────────────────────────────────────────
    const FS = _Financeiro();
    if (FS?.registrarReceita) {
      try {
        const lancamento = FS.registrarReceita(venda);
        if (lancamento) {
          _emit('mediator:financeiro:lancado', {
            tipo:          'receita',
            vendaId:       venda.id,
            valor:         venda.total,
            correlationId: venda.correlationId,
          });
        }
      } catch (e) {
        _erro('venda:finalizada → financeiro', e, { vendaId: venda.id });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: venda:pendente
  //  Origem: vendasService.finalizarVenda() (fluxo com aprovação)
  //  Ação:   reserva de estoque
  // ═══════════════════════════════════════════════════════════════════
  async function _onVendaPendente(venda) {
    if (!venda?.id) return;
    console.info(`[VendaMediator] venda:pendente — id=${venda.id}`);

    const ES = _Estoque();
    if (!ES?.reservarEstoque) return;

    try {
      const resultado = await ES.reservarEstoque(venda.id, venda.itens || []);
      if (resultado?.ok) {
        _emit('mediator:estoque:reserva_ok', { vendaId: venda.id });
      } else {
        console.warn(`[VendaMediator] Reserva falhou para venda ${venda.id}:`, resultado?.erros);
        _emit('mediator:estoque:reserva_falhou', {
          vendaId: venda.id,
          erros:   resultado?.erros || [],
        });
      }
    } catch (e) {
      _erro('venda:pendente → reservar', e, { vendaId: venda.id });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: venda:cancelada
  //  Origem: vendasService.cancelarVenda()
  //  Ação:   estorno de estoque + estorno financeiro
  // ═══════════════════════════════════════════════════════════════════
  async function _onVendaCancelada({ vendaId, venda, operador }) {
    if (!vendaId) return;
    console.info(`[VendaMediator] venda:cancelada — id=${vendaId}`);

    // venda pode vir no payload ou buscamos no Store
    const v = venda || window.CH.Store?.getVendas()?.find(x => x.id === vendaId);

    // ── 1. Estorno de estoque ────────────────────────────────────────
    if (v && ['concluida', 'validada'].includes(v.status)) {
      const ES = _Estoque();
      if (ES?.cancelarVenda) {
        try {
          await ES.cancelarVenda(vendaId, v.itens || []);
        } catch (e) {
          _erro('venda:cancelada → estoque', e, { vendaId });
        }
      }
    }

    // ── 2. Estorno financeiro ────────────────────────────────────────
    if (v) {
      const FS = _Financeiro();
      if (FS?.registrarEstorno) {
        try {
          const lancamento = FS.registrarEstorno(v);
          if (lancamento) {
            _emit('mediator:financeiro:lancado', {
              tipo:    'estorno',
              vendaId,
              valor:   v.total,
            });
          }
        } catch (e) {
          _erro('venda:cancelada → financeiro', e, { vendaId });
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: venda:aprovada
  //  Origem: aprovacaoService.aprovarVenda()
  //  Ação:   auditoria (EstoqueService e FinanceiroService não atuam aqui)
  // ═══════════════════════════════════════════════════════════════════
  function _onVendaAprovada({ vendaId, operador }) {
    if (!vendaId) return;
    // Auditoria já é feita diretamente pelo aprovacaoService via AuditService.
    // O Mediator loga para rastreabilidade do fluxo.
    console.info(`[VendaMediator] venda:aprovada — id=${vendaId} por ${operador}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: venda:rejeitada
  //  Origem: aprovacaoService.rejeitarVenda()
  //  Ação:   libera reserva de estoque
  //          (auditoria já feita pelo aprovacaoService)
  // ═══════════════════════════════════════════════════════════════════
  async function _onVendaRejeitada({ vendaId, motivo, operador }) {
    if (!vendaId) return;
    console.info(`[VendaMediator] venda:rejeitada — id=${vendaId}`);

    const ES = _Estoque();
    if (!ES?.liberarReserva) return;

    const venda = window.CH.Store?.getVendas()?.find(v => v.id === vendaId);
    if (venda?._cambio) return; // câmbio não tem reserva

    try {
      await ES.liberarReserva(vendaId);
    } catch (e) {
      _erro('venda:rejeitada → liberarReserva', e, { vendaId });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: venda:validada
  //  Origem: aprovacaoService.validarVenda()
  //  Ação:   libera reserva + receita financeira
  //          (baixa de estoque já foi feita pelo aprovacaoService ANTES de
  //           mudar o status — a ordem é crítica e não pode ser delegada aqui)
  // ═══════════════════════════════════════════════════════════════════
  async function _onVendaValidada(venda) {
    if (!venda?.id) return;
    console.info(`[VendaMediator] venda:validada — id=${venda.id}`);

    // ── 1. Libera reserva ────────────────────────────────────────────
    // A baixa já ocorreu — a reserva pode ser liberada agora
    const ES = _Estoque();
    if (ES?.liberarReserva && !venda._cambio) {
      try {
        await ES.liberarReserva(venda.id);
      } catch (e) {
        _erro('venda:validada → liberarReserva', e, { vendaId: venda.id });
      }
    }

    // ── 2. Receita financeira ────────────────────────────────────────
    // Idempotência do FinanceiroRepository garante não duplicar
    const FS = _Financeiro();
    if (FS?.registrarReceita) {
      try {
        const lancamento = FS.registrarReceita(venda);
        if (lancamento) {
          _emit('mediator:financeiro:lancado', {
            tipo:          'receita',
            vendaId:       venda.id,
            valor:         venda.total,
            correlationId: venda.correlationId,
          });
        }
      } catch (e) {
        _erro('venda:validada → financeiro', e, { vendaId: venda.id });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: venda:erro_validacao
  //  Origem: aprovacaoService._marcarErroValidacao()
  //  Ação:   log + evento de alerta
  // ═══════════════════════════════════════════════════════════════════
  function _onErroValidacao({ vendaId, motivo, operador }) {
    console.warn(`[VendaMediator] venda:erro_validacao — id=${vendaId} motivo=${motivo}`);
    _emit('mediator:erro', { contexto: 'erro_validacao', vendaId, motivo });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HANDLER: estoque:movimentado
  //  Origem: estoqueService._registrarMovimentacao() → EventBus
  //  Ação:   custo de compra no financeiro (apenas entradas)
  // ═══════════════════════════════════════════════════════════════════
  function _onEstoqueMovimentado(mov) {
    if (mov.tipo !== 'entrada') return;

    const custo = Math.abs(mov.custo ?? 0) * Math.abs(mov.quantidade ?? 0);
    if (custo <= 0) return;

    const FS = _Financeiro();
    if (!FS?.registrarCustoCompra) return;

    try {
      FS.registrarCustoCompra(mov);
    } catch (e) {
      _erro('estoque:movimentado → financeiro', e, { produtoId: mov.produtoId });
    }
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
