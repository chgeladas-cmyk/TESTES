'use strict';
/**
 * repositories/FinanceiroRepository.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Camada de acesso a dados para Financeiro e Saídas.
 *
 * RESPONSABILIDADE:
 *   Encapsula TODA comunicação com Store + SyncQueue relativa
 *   a lançamentos financeiros e saídas. O financeiroService
 *   não toca Store nem SyncQueue diretamente — chama este repository.
 *
 * CONTRATO PÚBLICO:
 *   salvarLancamento(lancamento)   → persiste no Store + enfileira sync
 *   salvarSaida(saida)             → persiste saída no Store + enfileira sync
 *   buscarLancamentos(opts)        → filtra lançamentos do Store local
 *   buscarSaidas(opts)             → filtra saídas do Store local
 *   buscarPorReferencia(ref, tipo) → busca lançamento por vendaId (idempotência)
 *   lerDoFirestore()               → lê financeiro direto do Firestore
 *
 * INVARIANTES:
 *   - Nunca duplica lançamento com mesma referencia+tipo
 *   - Nunca toca FirebaseService diretamente — usa SyncQueue
 *   - valor <= 0 é rejeitado silenciosamente
 *
 * Requer: core.js (window.CH.{Store, Utils, SyncQueue}) carregado antes.
 */

(function () {
  function _Store()  { return window.CH.Store; }
  function _Utils()  { return window.CH.Utils; }
  function _Queue()  { return window.CH.SyncQueue; }

  function _isOnline() { return navigator.onLine; }

  // ── Escrita — Lançamentos ─────────────────────────────────────────

  /**
   * Persiste um lançamento financeiro.
   * 1. Valida que o valor é positivo.
   * 2. Verifica idempotência por referencia+tipo.
   * 3. Grava no Store local.
   * 4. Enfileira sync com Firestore via SyncQueue.
   *
   * @param {object} lancamento - objeto completo com id, tipo, valor, referencia...
   * @returns {object|null} lancamento gravado ou null se rejeitado
   */
  function salvarLancamento(lancamento) {
    if (!lancamento?.id) {
      console.warn('[FinanceiroRepository] salvarLancamento: sem id — ignorado');
      return null;
    }
    if (!lancamento.valor || lancamento.valor <= 0) {
      console.warn('[FinanceiroRepository] salvarLancamento: valor inválido — ignorado');
      return null;
    }

    // Idempotência: não duplica se já existe com mesma referencia+tipo
    if (lancamento.referencia) {
      const jaExiste = _Store().getFinanceiro().some(
        l => l.referencia === lancamento.referencia && l.tipo === lancamento.tipo
      );
      if (jaExiste) {
        console.info(
          `[FinanceiroRepository] Lançamento já existe — referencia=${lancamento.referencia} tipo=${lancamento.tipo}`
        );
        return null;
      }
    }

    // Persiste no Store local
    _Store().mutateFinanceiro(fin => { fin.unshift(lancamento); });

    // Enfileira sync com Firestore (_NUNCA_COLAPSAR protege)
    _Queue()?.enqueue('salvar', 'financeiro', _Store().getFinanceiro());

    console.info(
      `[FinanceiroRepository] ✓ Lançamento salvo — ${lancamento.tipo} R$${lancamento.valor} ref=${lancamento.referencia || 'manual'}`
    );
    return lancamento;
  }

  /**
   * Persiste uma saída (despesa operacional, compra avulsa, retirada).
   * Saídas ficam em coleção separada (ch_dados/saidas) — não vão para financeiro.
   *
   * @param {object} saida
   * @returns {object|null}
   */
  function salvarSaida(saida) {
    if (!saida?.id) {
      console.warn('[FinanceiroRepository] salvarSaida: sem id — ignorado');
      return null;
    }

    _Store().mutateSaidas(arr => { arr.unshift(saida); });
    _Queue()?.enqueue('salvar', 'saidas', _Store().getSaidas());

    console.info(`[FinanceiroRepository] ✓ Saída salva — ${saida.descricao} R$${saida.valor}`);
    return saida;
  }

  // ── Leitura — Store local ─────────────────────────────────────────

  /**
   * Retorna lançamentos financeiros com filtros opcionais.
   *
   * @param {object} opts
   * @param {string}   [opts.tipo]       - 'receita'|'despesa'|'estorno'
   * @param {string}   [opts.categoria]  - 'venda'|'compra'|'avaria'|...
   * @param {string}   [opts.dataDe]     - YYYY-MM-DD
   * @param {string}   [opts.dataAte]    - YYYY-MM-DD
   * @param {string}   [opts.operador]   - nome do operador
   * @param {number}   [opts.limit]      - máximo de registros
   * @returns {object[]}
   */
  function buscarLancamentos({ tipo, categoria, dataDe, dataAte, operador, limit = 500 } = {}) {
    let result = _Store().getFinanceiro();
    if (tipo)      result = result.filter(l => l.tipo      === tipo);
    if (categoria) result = result.filter(l => l.categoria === categoria);
    if (dataDe)    result = result.filter(l => l.dataCurta >= dataDe);
    if (dataAte)   result = result.filter(l => l.dataCurta <= dataAte);
    if (operador)  result = result.filter(l => l.operador  === operador);
    return result.slice(0, limit);
  }

  /**
   * Retorna saídas com filtros opcionais.
   *
   * @param {object} opts
   * @param {string}   [opts.dataDe]
   * @param {string}   [opts.dataAte]
   * @param {string}   [opts.categoria]
   * @param {number}   [opts.limit]
   * @returns {object[]}
   */
  function buscarSaidas({ dataDe, dataAte, categoria, limit = 500 } = {}) {
    let result = _Store().getSaidas() || [];
    if (dataDe)    result = result.filter(s => s.dataCurta >= dataDe);
    if (dataAte)   result = result.filter(s => s.dataCurta <= dataAte);
    if (categoria) result = result.filter(s => s.categoria === categoria);
    return result.slice(0, limit);
  }

  /**
   * Busca um lançamento por referencia e tipo — usado para checar idempotência.
   *
   * @param {string} referencia - vendaId ou outro identificador
   * @param {string} tipo       - 'receita'|'despesa'|'estorno'
   * @returns {object|null}
   */
  function buscarPorReferencia(referencia, tipo) {
    if (!referencia) return null;
    return _Store().getFinanceiro().find(
      l => l.referencia === referencia && l.tipo === tipo
    ) || null;
  }

  /**
   * Retorna lançamentos do dia atual.
   * @returns {object[]}
   */
  function buscarHoje() {
    const hoje = _Utils().todayISO();
    return buscarLancamentos({ dataDe: hoje, dataAte: hoje });
  }

  /**
   * Retorna o saldo calculado de um período.
   * Receitas somam, despesas e estornos subtraem.
   *
   * @param {string} dataDe
   * @param {string} dataAte
   * @returns {{ receitas: number, despesas: number, estornos: number, saldo: number }}
   */
  function calcularSaldo(dataDe, dataAte) {
    const lancamentos = buscarLancamentos({ dataDe, dataAte });
    const receitas  = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + l.valor, 0);
    const despesas  = lancamentos.filter(l => l.tipo === 'despesa').reduce((s, l) => s + l.valor, 0);
    const estornos  = lancamentos.filter(l => l.tipo === 'estorno').reduce((s, l) => s + l.valor, 0);
    return { receitas, despesas, estornos, saldo: receitas - despesas - estornos };
  }

  /**
   * Retorna o saldo do dia atual — usado pela auditoria para registrar
   * o estado ANTES de um novo lançamento.
   *
   * @returns {number}
   */
  function saldoHoje() {
    const hoje = _Utils().todayISO();
    return calcularSaldo(hoje, hoje).saldo;
  }

  // ── Leitura — Firestore ───────────────────────────────────────────

  /**
   * Lê lançamentos financeiros direto do Firestore.
   * Usado apenas para reconciliação e backup — não para operações de PDV.
   *
   * @returns {Promise<object[]|null>}
   */
  async function lerDoFirestore() {
    const FB = window.CH.FirebaseService;
    if (!_isOnline() || !FB?.isReady()) return null;
    try {
      return await FB.ler('financeiro');
    } catch (e) {
      console.warn('[FinanceiroRepository] lerDoFirestore falhou:', e.message);
      return null;
    }
  }

  // ── Exportar ──────────────────────────────────────────────────────
  window.CH.FinanceiroRepository = {
    // Escrita
    salvarLancamento,
    salvarSaida,
    // Leitura
    buscarLancamentos,
    buscarSaidas,
    buscarPorReferencia,
    buscarHoje,
    calcularSaldo,
    saldoHoje,
    lerDoFirestore,
  };

  console.info('%c FinanceiroRepository ✓', 'color:#8b5cf6;font-weight:bold');
})();
