'use strict';
/**
 * application/TransactionManager.js — CH Geladas PDV
 * ═══════════════════════════════════════════════════════════════════
 * Camada de aplicação: orquestra operações de venda como uma
 * unidade atômica com steps sequenciais, compensação (rollback) e
 * rastreabilidade completa.
 *
 * DIFERENÇA DO MEDIATOR (etapa 9):
 *   VendaMediator → reativo. Escuta eventos e delega. Baixo acoplamento.
 *   TransactionManager → imperativo. Executa steps em ordem, com
 *   resultado estruturado, compensação em cascata e histórico de execução.
 *
 * FLUXO DE UMA TRANSAÇÃO:
 *   Venda
 *    ↓  TransactionManager.executar(transacao)
 *    ├─ Step 1: Estoque  [execute → reservar / baixar]
 *    │     ↓ falhou? → compensate(Step 1) → resultado FALHOU
 *    ├─ Step 2: Financeiro [execute → registrarReceita]
 *    │     ↓ falhou? → compensate(Step 2) + compensate(Step 1) → resultado FALHOU
 *    ├─ Step 3: Auditoria [execute → registrar]
 *    │     ↓ falhou? → loga, não compensa (auditoria é append-only)
 *    └─ resultado SUCESSO
 *
 * CONTRATO PÚBLICO:
 *   executar(transacao)                         → TransactionResult
 *   criarTransacaoVendaFinalizada(venda)        → Transacao pronta para executar
 *   criarTransacaoVendaCancelada(venda, motivo) → Transacao pronta para executar
 *   criarTransacaoValidacao(venda)              → Transacao pronta para executar
 *   getHistorico(limit)                         → array de TransactionResult
 *   getEstatisticas()                           → { total, sucesso, falha, rollback }
 *
 * MODELO TransactionResult:
 *   {
 *     id:            string     — id único da transação
 *     tipo:          string     — 'finalizar_venda' | 'cancelar_venda' | 'validar_venda'
 *     vendaId:       string
 *     correlationId: string
 *     status:        'sucesso' | 'falhou' | 'parcial' | 'compensado'
 *     steps:         StepResult[]
 *     iniciadoEm:    ISO
 *     concluidoEm:   ISO
 *     duracaoMs:     number
 *   }
 *
 * MODELO StepResult:
 *   {
 *     nome:       string
 *     status:     'sucesso' | 'falhou' | 'pulado' | 'compensado'
 *     duracaoMs:  number
 *     erro?:      string
 *     dados?:     object
 *   }
 *
 * Requer: core.js + todos os services e repositories carregados antes.
 */

(function () {
  function _Bus()        { return window.CH.EventBus; }
  function _Store()      { return window.CH.Store; }
  function _Utils()      { return window.CH.Utils; }
  function _Estoque()    { return window.CH.EstoqueService; }
  function _Financeiro() { return window.CH.FinanceiroService; }
  function _Audit()      { return window.CH.AuditService; }
  function _VendaRepo()  { return window.CH.VendaRepository; }

  // ── Histórico em memória ──────────────────────────────────────────
  const _historico = []; // TransactionResult[]
  const MAX_HISTORICO = 200;

  // ═══════════════════════════════════════════════════════════════════
  //  MOTOR DE EXECUÇÃO
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Executa uma transação com steps sequenciais e compensação em cascata.
   *
   * @param {object} transacao
   * @param {string} transacao.id
   * @param {string} transacao.tipo
   * @param {string} transacao.vendaId
   * @param {string} transacao.correlationId
   * @param {Step[]} transacao.steps
   *   Cada Step: { nome, critico, execute: async()=>{dados}, compensate?: async()=>{} }
   *   - critico: se true e execute() falhar → inicia compensação e para
   *   - compensate: executado em ordem inversa se step crítico falhou
   *
   * @returns {Promise<TransactionResult>}
   */
  async function executar(transacao) {
    const inicio  = Date.now();
    const txId    = transacao.id || _Utils().generateId();
    const steps   = transacao.steps || [];

    const resultado = {
      id:            txId,
      tipo:          transacao.tipo,
      vendaId:       transacao.vendaId,
      correlationId: transacao.correlationId,
      status:        'sucesso',
      steps:         [],
      iniciadoEm:    _Utils().nowISO(),
      concluidoEm:   null,
      duracaoMs:     0,
    };

    console.info(
      `[TransactionManager] ▶ ${transacao.tipo} — vendaId=${transacao.vendaId} ` +
      `cid=${transacao.correlationId} txId=${txId}`
    );

    const executados = []; // steps executados com sucesso (para compensação)

    for (const step of steps) {
      const stepInicio = Date.now();
      const stepResult = { nome: step.nome, status: 'sucesso', duracaoMs: 0 };

      try {
        const dados = await step.execute();
        stepResult.duracaoMs = Date.now() - stepInicio;
        stepResult.dados     = dados || null;
        resultado.steps.push(stepResult);
        executados.push({ step, stepResult });

        console.info(
          `[TransactionManager]   ✓ ${step.nome} (${stepResult.duracaoMs}ms)`
        );

      } catch (e) {
        stepResult.status    = 'falhou';
        stepResult.duracaoMs = Date.now() - stepInicio;
        stepResult.erro      = e.message || String(e);
        resultado.steps.push(stepResult);

        console.error(
          `[TransactionManager]   ✗ ${step.nome} (${stepResult.duracaoMs}ms): ${e.message}`
        );

        if (step.critico !== false) {
          // Step crítico falhou → compensa todos os steps anteriores em ordem inversa
          resultado.status = 'compensado';
          await _compensar(executados, resultado);
          _finalizar(resultado, inicio);
          _registrarHistorico(resultado);
          _emitirResultado(resultado);
          return resultado;
        } else {
          // Step não crítico → registra falha parcial e continua
          resultado.status = 'parcial';
          console.warn(`[TransactionManager]   ⚠ ${step.nome} falhou (não crítico) — continuando`);
        }
      }
    }

    _finalizar(resultado, inicio);
    _registrarHistorico(resultado);
    _emitirResultado(resultado);

    console.info(
      `[TransactionManager] ■ ${transacao.tipo} ${resultado.status} — ${resultado.duracaoMs}ms`
    );

    return resultado;
  }

  /**
   * Executa compensações em ordem inversa para os steps que já foram executados.
   */
  async function _compensar(executados, resultado) {
    const inverso = [...executados].reverse();
    for (const { step, stepResult } of inverso) {
      if (!step.compensate) continue;
      try {
        await step.compensate();
        const compResult = { nome: `compensar:${step.nome}`, status: 'compensado', duracaoMs: 0 };
        resultado.steps.push(compResult);
        console.info(`[TransactionManager]   ↩ compensado: ${step.nome}`);
      } catch (ce) {
        const compResult = {
          nome:   `compensar:${step.nome}`,
          status: 'falhou',
          erro:   ce.message,
        };
        resultado.steps.push(compResult);
        console.error(`[TransactionManager]   ✗ falha na compensação: ${step.nome}:`, ce.message);
      }
    }
  }

  function _finalizar(resultado, inicio) {
    resultado.concluidoEm = _Utils().nowISO();
    resultado.duracaoMs   = Date.now() - inicio;
  }

  function _registrarHistorico(resultado) {
    _historico.unshift(resultado);
    if (_historico.length > MAX_HISTORICO) _historico.length = MAX_HISTORICO;
  }

  function _emitirResultado(resultado) {
    try {
      _Bus().emit('transacao:concluida', resultado);
      if (resultado.status === 'compensado') {
        _Bus().emit('transacao:falhou', resultado);
      }
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════
  //  FÁBRICAS DE TRANSAÇÕES
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Transação: FINALIZAR VENDA (fluxo direto, sem aprovação)
   * Steps: Estoque → Financeiro → Auditoria
   *
   * @param {object} venda - objeto venda com id, itens, correlationId, total...
   * @returns {Promise<TransactionResult>}
   */
  async function criarTransacaoVendaFinalizada(venda) {
    return executar({
      id:            `tx_fin_${venda.id.slice(-6)}_${Date.now()}`,
      tipo:          'finalizar_venda',
      vendaId:       venda.id,
      correlationId: venda.correlationId,
      steps: [

        // ── Step 1: Baixa de estoque (CRÍTICO — sem estoque, sem venda) ──
        {
          nome:    'estoque:baixar',
          critico: true,
          async execute() {
            const ES = _Estoque();
            if (!ES) return { pulado: true, motivo: 'EstoqueService não disponível' };

            const IS = window.CH.IntegrityService;
            if (IS?.confirmarBaixaComRollback) {
              const r = await IS.confirmarBaixaComRollback(venda, null);
              if (!r.ok && r.rollbackExecutado) {
                throw new Error(`Baixa com rollback falhou: ${r.erros?.join('; ')}`);
              }
              return { via: 'IntegrityService', itensProcessados: r.itensProcessados };
            }

            const r = await ES.baixarEstoqueVendaLote(venda);
            if (!r.ok && r.itensProcessados === 0) {
              throw new Error(`Baixa falhou: ${r.erros?.join('; ')}`);
            }
            return { via: 'baixarEstoqueVendaLote', itensProcessados: r.itensProcessados, erros: r.erros };
          },
          async compensate() {
            // Estorno de estoque — devolve unidades
            const ES = _Estoque();
            if (ES?.cancelarVenda) {
              await ES.cancelarVenda(venda.id, venda.itens || []);
            }
          },
        },

        // ── Step 2: Receita financeira (CRÍTICO — registra o faturamento) ──
        {
          nome:    'financeiro:receita',
          critico: true,
          async execute() {
            const FS = _Financeiro();
            if (!FS?.registrarReceita) return { pulado: true };
            const lancamento = FS.registrarReceita(venda);
            if (!lancamento) return { ignorado: true, motivo: 'idempotência — já registrado' };
            return { lancamentoId: lancamento.id, valor: lancamento.valor };
          },
          async compensate() {
            // Estorna a receita registrada
            const FS = _Financeiro();
            if (FS?.registrarEstorno) FS.registrarEstorno(venda);
          },
        },

        // ── Step 3: Auditoria (NÃO CRÍTICO — append-only, sem compensação) ──
        {
          nome:    'auditoria:venda',
          critico: false,
          async execute() {
            const AS = _Audit();
            if (!AS?.auditarVenda) return { pulado: true };
            AS.auditarVenda(venda);
            return { registrado: true };
          },
          // Sem compensate — auditoria é append-only por design
        },

        // ── Step 4: Sync com Firestore (NÃO CRÍTICO — SyncQueue garante retry) ──
        {
          nome:    'sync:venda',
          critico: false,
          async execute() {
            _VendaRepo()?.salvar(venda);
            return { enfileirado: true };
          },
        },

      ],
    });
  }

  /**
   * Transação: CANCELAR VENDA
   * Steps: Estorno Estoque → Estorno Financeiro → Auditoria → Sync
   *
   * @param {object} venda - objeto venda antes do cancelamento
   * @param {string} motivo
   * @returns {Promise<TransactionResult>}
   */
  async function criarTransacaoVendaCancelada(venda, motivo = '') {
    return executar({
      id:            `tx_can_${venda.id.slice(-6)}_${Date.now()}`,
      tipo:          'cancelar_venda',
      vendaId:       venda.id,
      correlationId: venda.correlationId,
      steps: [

        // ── Step 1: Estorno de estoque (só para vendas que baixaram estoque) ──
        {
          nome:    'estoque:estornar',
          critico: false, // falha no estorno não bloqueia o cancelamento
          async execute() {
            const ES = _Estoque();
            if (!ES?.cancelarVenda) return { pulado: true };
            if (!['concluida', 'validada'].includes(venda.status)) {
              return { pulado: true, motivo: `status "${venda.status}" não teve baixa` };
            }
            await ES.cancelarVenda(venda.id, venda.itens || []);
            return { itens: venda.itens?.length || 0 };
          },
        },

        // ── Step 2: Estorno financeiro (CRÍTICO — sem estorno = caixa errado) ──
        {
          nome:    'financeiro:estornar',
          critico: true,
          async execute() {
            const FS = _Financeiro();
            if (!FS?.registrarEstorno) return { pulado: true };
            const lancamento = FS.registrarEstorno(venda);
            if (!lancamento) return { ignorado: true, motivo: 'idempotência — já estornado' };
            return { lancamentoId: lancamento.id, valor: lancamento.valor };
          },
        },

        // ── Step 3: Auditoria de cancelamento ────────────────────────
        {
          nome:    'auditoria:cancelamento',
          critico: false,
          async execute() {
            const AS = _Audit();
            if (!AS?.auditarCancelamento) return { pulado: true };
            AS.auditarCancelamento(venda, motivo || 'Cancelamento operacional');
            return { registrado: true };
          },
        },

        // ── Step 4: Sync venda cancelada ─────────────────────────────
        {
          nome:    'sync:venda_cancelada',
          critico: false,
          async execute() {
            // Busca a venda já com status='cancelada' do Store
            const vendaCancelada = _Store().getVendas().find(v => v.id === venda.id) || venda;
            _VendaRepo()?.atualizar(vendaCancelada);
            return { enfileirado: true };
          },
        },

      ],
    });
  }

  /**
   * Transação: VALIDAR VENDA (aprovacao → validada)
   * Atenção: a BAIXA de estoque já ocorre ANTES desta transação,
   * dentro de aprovacaoService.validarVenda() — ordem crítica mantida.
   * Esta transação cuida dos efeitos pós-baixa.
   *
   * Steps: Liberar Reserva → Receita Financeiro → Auditoria → Sync
   *
   * @param {object} venda - objeto venda com status já='validada'
   * @returns {Promise<TransactionResult>}
   */
  async function criarTransacaoValidacao(venda) {
    return executar({
      id:            `tx_val_${venda.id.slice(-6)}_${Date.now()}`,
      tipo:          'validar_venda',
      vendaId:       venda.id,
      correlationId: venda.correlationId,
      steps: [

        // ── Step 1: Liberar reserva ───────────────────────────────────
        {
          nome:    'estoque:liberar_reserva',
          critico: false,
          async execute() {
            const ES = _Estoque();
            if (!ES?.liberarReserva || venda._cambio) return { pulado: true };
            await ES.liberarReserva(venda.id);
            return { liberado: true };
          },
        },

        // ── Step 2: Receita financeira ────────────────────────────────
        {
          nome:    'financeiro:receita',
          critico: true,
          async execute() {
            const FS = _Financeiro();
            if (!FS?.registrarReceita) return { pulado: true };
            const lancamento = FS.registrarReceita(venda);
            if (!lancamento) return { ignorado: true, motivo: 'idempotência — já registrado' };
            return { lancamentoId: lancamento.id, valor: lancamento.valor };
          },
          async compensate() {
            const FS = _Financeiro();
            if (FS?.registrarEstorno) FS.registrarEstorno(venda);
          },
        },

        // ── Step 3: Auditoria de validação ────────────────────────────
        {
          nome:    'auditoria:validacao',
          critico: false,
          async execute() {
            const AS = _Audit();
            if (!AS?.auditarMudancaStatus) return { pulado: true };
            AS.auditarMudancaStatus(venda, 'validada',
              `Validado — baixa confirmada por ${venda.validadaPor || 'sistema'}`
            );
            return { registrado: true };
          },
        },

        // ── Step 4: Sync venda validada ───────────────────────────────
        {
          nome:    'sync:venda_validada',
          critico: false,
          async execute() {
            _VendaRepo()?.atualizar(venda);
            return { enfileirado: true };
          },
        },

      ],
    });
  }

  /**
   * Transação: RESERVAR ESTOQUE (venda pendente)
   * Steps: Reserva Estoque → Auditoria → Sync
   *
   * @param {object} venda
   * @returns {Promise<TransactionResult>}
   */
  async function criarTransacaoReserva(venda) {
    return executar({
      id:            `tx_res_${venda.id.slice(-6)}_${Date.now()}`,
      tipo:          'reservar_estoque',
      vendaId:       venda.id,
      correlationId: venda.correlationId,
      steps: [

        // ── Step 1: Reservar estoque (CRÍTICO — sem reserva, venda volta para o usuário) ──
        {
          nome:    'estoque:reservar',
          critico: true,
          async execute() {
            const ES = _Estoque();
            if (!ES?.reservarEstoque) return { pulado: true };
            const resultado = await ES.reservarEstoque(venda.id, venda.itens || []);
            if (!resultado.ok) {
              throw new Error(`Reserva bloqueada: ${resultado.erros?.join('; ')}`);
            }
            return { itensReservados: Object.keys(resultado).length };
          },
          async compensate() {
            const ES = _Estoque();
            if (ES?.liberarReserva) await ES.liberarReserva(venda.id);
          },
        },

        // ── Step 2: Auditoria de venda pendente ───────────────────────
        {
          nome:    'auditoria:pendente',
          critico: false,
          async execute() {
            const AS = _Audit();
            if (!AS?.auditarVenda) return { pulado: true };
            AS.auditarVenda({ ...venda, status: 'pendente' });
            return { registrado: true };
          },
        },

        // ── Step 3: Sync venda pendente ───────────────────────────────
        {
          nome:    'sync:venda_pendente',
          critico: false,
          async execute() {
            _VendaRepo()?.salvar(venda);
            return { enfileirado: true };
          },
        },

      ],
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CONSULTAS
  // ═══════════════════════════════════════════════════════════════════

  function getHistorico(limit = 50) {
    return _historico.slice(0, limit);
  }

  function getEstatisticas() {
    const total     = _historico.length;
    const sucesso   = _historico.filter(r => r.status === 'sucesso').length;
    const parcial   = _historico.filter(r => r.status === 'parcial').length;
    const falhou    = _historico.filter(r => r.status === 'falhou').length;
    const compensado= _historico.filter(r => r.status === 'compensado').length;
    const duracaoMedia = total > 0
      ? Math.round(_historico.reduce((s, r) => s + r.duracaoMs, 0) / total)
      : 0;

    return { total, sucesso, parcial, falhou, compensado, duracaoMedia };
  }

  function buscarPorVenda(vendaId) {
    return _historico.filter(r => r.vendaId === vendaId);
  }

  function buscarPorCorrelation(correlationId) {
    return _historico.filter(r => r.correlationId === correlationId);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  INTEGRAÇÃO COM VENDAMEDIATOR
  //  O TransactionManager substitui as lógicas internas dos handlers
  //  do Mediator, centralizando a execução com steps e compensação.
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Conecta o TransactionManager ao EventBus — substitui handlers do Mediator
   * com execuções gerenciadas com steps, compensação e histórico.
   */
  function _conectarAoEventBus() {
    const bus = _Bus();

    // venda:finalizada → criarTransacaoVendaFinalizada
    bus.on('tx:venda:finalizada', async venda => {
      await criarTransacaoVendaFinalizada(venda);
    });

    // venda:pendente → criarTransacaoReserva
    bus.on('tx:venda:pendente', async venda => {
      await criarTransacaoReserva(venda);
    });

    // venda:cancelada → criarTransacaoVendaCancelada
    bus.on('tx:venda:cancelada', async ({ venda, motivo }) => {
      if (!venda) return;
      await criarTransacaoVendaCancelada(venda, motivo);
    });

    // venda:validada → criarTransacaoValidacao
    bus.on('tx:venda:validada', async venda => {
      await criarTransacaoValidacao(venda);
    });
  }

  _conectarAoEventBus();

  // ── Exportar ──────────────────────────────────────────────────────
  window.CH.TransactionManager = {
    // Motor
    executar,
    // Fábricas
    criarTransacaoVendaFinalizada,
    criarTransacaoVendaCancelada,
    criarTransacaoValidacao,
    criarTransacaoReserva,
    // Consultas
    getHistorico,
    getEstatisticas,
    buscarPorVenda,
    buscarPorCorrelation,
  };

  console.info(
    '%c TransactionManager ✓  (steps: estoque → financeiro → auditoria | compensação automática)',
    'color:#ec4899;font-weight:bold'
  );
})();
