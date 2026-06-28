/**
 * tests/scenarios/concorrencia.test.js — CH Geladas PDV
 * ═══════════════════════════════════════════════════════════════════
 * Testes de concorrência: N usuários simultâneos vendendo o mesmo produto.
 *
 * Objetivo:
 *   Provar que nenhuma combinação de vendas simultâneas consegue:
 *   (a) levar o estoque a valores negativos
 *   (b) vender mais unidades do que o estoque físico disponível
 *   (c) criar reservas sobrepostas além do limite
 *   (d) registrar movimentações duplicadas para a mesma venda
 *
 * Estratégia:
 *   Simula o _cacheReservas global compartilhado (que na produção vive
 *   no Firestore e é sincronizado por onSnapshot entre todos os caixas).
 *   Cada "usuário" é uma função assíncrona que executa em paralelo via
 *   Promise.all(), lendo e escrevendo no mesmo estado compartilhado.
 *
 *   Três cenários de estoque testados:
 *     - Estoque suficiente para todos                     → todos vendem
 *     - Estoque parcial (alguns conseguem, outros não)    → parcial ok
 *     - Estoque zero / exatamente na medida               → bloqueio total
 */

// ═══════════════════════════════════════════════════════════════════
//  MOTOR DE SIMULAÇÃO — replica a lógica real sem Firebase
// ═══════════════════════════════════════════════════════════════════

/**
 * Cria um contexto de simulação isolado com seu próprio estado.
 * Cada describe() cria um contexto novo para isolamento total.
 */
function criarSistema({ estoqueInicial }) {
  // Estado compartilhado — equivale ao Firestore + localStorage
  let estoqueFisico     = estoqueInicial;   // unidades físicas no "banco"
  let cacheReservas     = {};               // { [vendaId]: { itens: {[prodId]:qtd}, ativa, expiraEm } }
  let movimentacoes     = [];               // histórico de baixas
  let financeiro        = [];               // lançamentos financeiros
  let vendasRegistradas = [];               // vendas criadas

  const PROD_ID   = 'prod-teste';
  const PROD_NOME = 'Coca-Cola';

  // ── Helpers ─────────────────────────────────────────────────────

  function reservaAtiva(r) {
    if (!r || r.ativa === false) return false;
    if (!r.expiraEm) return true;
    return new Date(r.expiraEm).getTime() > Date.now();
  }

  function getQtdReservada() {
    return Object.values(cacheReservas)
      .filter(reservaAtiva)
      .reduce((s, r) => s + (r.itens?.[PROD_ID] || 0), 0);
  }

  function getEstoqueDisponivel() {
    return Math.max(0, estoqueFisico - getQtdReservada());
  }

  // ── Reservar (simula vendas pendentes) ───────────────────────────

  /**
   * Simula reservarEstoque() do estoqueService.
   * Lê o _cacheReservas global, valida disponibilidade e grava.
   * É síncrona aqui (sem Firestore), mas o algoritmo é idêntico.
   */
  async function reservar(vendaId, qtd) {
    // Simula latência de rede (0–5ms) — aumenta chance de race condition real
    await delay(Math.random() * 5);

    const reservaOutros = Object.entries(cacheReservas)
      .filter(([vid, r]) => vid !== vendaId && reservaAtiva(r))
      .reduce((s, [, r]) => s + (r.itens?.[PROD_ID] || 0), 0);

    const disponivel = Math.max(0, estoqueFisico - reservaOutros);

    if (disponivel < qtd) {
      return { ok: false, erro: `"${PROD_NOME}": disponível ${disponivel}, solicitado ${qtd}` };
    }

    cacheReservas[vendaId] = {
      vendaId,
      itens:    { [PROD_ID]: qtd },
      ativa:    true,
      criadaEm: new Date().toISOString(),
      expiraEm: new Date(Date.now() + 86_400_000).toISOString(),
    };

    return { ok: true, erro: null };
  }

  /** Simula liberarReserva() */
  function liberarReserva(vendaId) {
    if (cacheReservas[vendaId]) {
      cacheReservas[vendaId].ativa = false;
    }
  }

  // ── Baixar estoque (simula Firebase Transaction) ─────────────────

  /**
   * Simula baixarEstoqueVendaLote() com Transaction.
   * A Transaction garante atomicidade: lê → valida → subtrai.
   * Simulamos isso com um lock assíncrono (fila de Promises).
   */
  let _txLock = Promise.resolve(); // garante execução sequencial das Transactions

  async function baixarLote(venda, qtd) {
    // Simula latência de rede antes de entrar na Transaction
    await delay(Math.random() * 5);

    // Executa dentro do "lock" da Transaction — serializado
    const resultado = await (_txLock = _txLock.then(async () => {
      // Simula latência da Transaction no Firestore (1–3ms)
      await delay(1 + Math.random() * 2);

      // Leitura do estado atual (equivale a tx.get(ch_dados/estoque))
      const estoqueAtualFB = estoqueFisico;

      // Idempotência: já processada?
      const origemKey    = `venda:${venda.id}`;
      const jaProcessado = movimentacoes.some(
        m => m.origem === origemKey && m.produtoId === PROD_ID && m.tipo === 'venda'
      );
      if (jaProcessado) {
        return { ok: true, jaProcessado: true, estoqueDepois: estoqueAtualFB };
      }

      // Validação dentro da Transaction (equivale ao if (qtdAtualFB < qtdUn))
      if (estoqueAtualFB < qtd) {
        return {
          ok: false,
          erro: `"${PROD_NOME}": insuficiente na Transaction (${estoqueAtualFB} disponível, ${qtd} solicitado)`,
        };
      }

      // Escrita atômica (equivale a tx.set(ch_dados/estoque) + tx.set(movimentacoes/{id}))
      const estoqueDepois = estoqueAtualFB - qtd;
      estoqueFisico = estoqueDepois;

      movimentacoes.push({
        id:            `mov_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        produtoId:     PROD_ID,
        nomeProduto:   PROD_NOME,
        tipo:          'venda',
        quantidade:    -qtd,
        estoqueAntes:  estoqueAtualFB,
        estoqueDepois,
        origem:        origemKey,
        vendaId:       venda.id,
        correlationId: venda.correlationId || null,
        timestamp:     new Date().toISOString(),
      });

      return { ok: true, jaProcessado: false, estoqueDepois };
    }));

    return resultado;
  }

  // ── Registrar receita (simula financeiroService._lancar) ─────────

  function registrarReceita(venda, total) {
    // Idempotência: não duplica se já existe
    if (financeiro.some(l => l.referencia === venda.id && l.tipo === 'receita')) {
      return null; // já registrado
    }
    const lancamento = { tipo: 'receita', referencia: venda.id, valor: total };
    financeiro.push(lancamento);
    return lancamento;
  }

  // ── Fluxo completo de um usuário (simula uma instância do PDV) ───

  /**
   * Simula o fluxo completo de um usuário:
   *   1. Tenta reservar estoque (venda pendente)
   *   2. Se reserva ok → baixa Transaction → libera reserva → financeiro
   *   3. Se reserva falha → venda bloqueada
   *
   * @param {string} userId   - nome do caixa
   * @param {string} vendaId  - id único da venda
   * @param {number} qtd      - quantidade solicitada
   * @param {'direto'|'pendente'} fluxo
   *   'direto'   = colaborador sem aprovação (venda concluida direto)
   *   'pendente' = requer aprovação (reserva + validação)
   */
  async function simularUsuario(userId, vendaId, qtd, fluxo = 'direto') {
    const venda = {
      id:            vendaId,
      correlationId: `cid_${vendaId.slice(-6)}_${Date.now()}`,
      operador:      userId,
      total:         qtd * 10, // preço fictício
      itens:         [{ prodId: PROD_ID, qtd, label: 'UNID' }],
      status:        fluxo === 'pendente' ? 'pendente' : 'concluida',
    };

    vendasRegistradas.push(venda);

    if (fluxo === 'pendente') {
      // Fluxo com aprovação: reserva → (aprovação simulada) → baixa → libera
      const reservaResult = await reservar(vendaId, qtd);
      if (!reservaResult.ok) {
        venda.status = 'rejeitada_sem_estoque';
        return { userId, vendaId, sucesso: false, motivo: reservaResult.erro };
      }

      // Simula delay de aprovação (50–150ms)
      await delay(50 + Math.random() * 100);

      // Baixa Transaction
      const baixaResult = await baixarLote(venda, qtd);
      liberarReserva(vendaId);

      if (!baixaResult.ok) {
        venda.status = 'erro_validacao';
        return { userId, vendaId, sucesso: false, motivo: baixaResult.erro };
      }

      venda.status = 'validada';
      registrarReceita(venda, venda.total);
      return { userId, vendaId, sucesso: true, estoqueDepois: baixaResult.estoqueDepois };

    } else {
      // Fluxo direto: bloqueio local → baixa Transaction → financeiro
      const disponivelLocal = getEstoqueDisponivel();
      if (disponivelLocal < qtd) {
        venda.status = 'bloqueada';
        return {
          userId, vendaId, sucesso: false,
          motivo: `Bloqueio local: disponível ${disponivelLocal}, solicitado ${qtd}`,
        };
      }

      const baixaResult = await baixarLote(venda, qtd);

      if (!baixaResult.ok) {
        venda.status = 'erro_estoque';
        return { userId, vendaId, sucesso: false, motivo: baixaResult.erro };
      }

      venda.status = 'concluida';
      registrarReceita(venda, venda.total);
      return { userId, vendaId, sucesso: true, estoqueDepois: baixaResult.estoqueDepois };
    }
  }

  // ── Helpers de asserção ──────────────────────────────────────────

  function assertEstoqueNaoNegativo() {
    expect(estoqueFisico).toBeGreaterThanOrEqual(0);
    for (const mov of movimentacoes) {
      expect(mov.estoqueDepois).toBeGreaterThanOrEqual(0);
      expect(mov.estoqueAntes).toBeGreaterThanOrEqual(0);
    }
  }

  function assertNenhumaDuplicata() {
    const origens = movimentacoes.map(m => `${m.origem}:${m.produtoId}`);
    const unicos  = new Set(origens);
    expect(origens.length).toBe(unicos.size);
  }

  function assertFinanceiroSemDuplicata() {
    const refs = financeiro.map(l => l.referencia);
    const unicos = new Set(refs);
    expect(refs.length).toBe(unicos.size);
  }

  function assertBaixasTotaisCorretas(esperado) {
    const totalBaixado = movimentacoes
      .filter(m => m.tipo === 'venda')
      .reduce((s, m) => s + Math.abs(m.quantidade), 0);
    expect(totalBaixado).toBeLessThanOrEqual(estoqueInicial);
    if (esperado !== undefined) expect(totalBaixado).toBe(esperado);
  }

  function getResultados() {
    return {
      estoqueFinal:      estoqueFisico,
      movimentacoes:     [...movimentacoes],
      financeiro:        [...financeiro],
      vendas:            [...vendasRegistradas],
      reservasAtivas:    Object.values(cacheReservas).filter(reservaAtiva).length,
      totalBaixado:      movimentacoes.reduce((s, m) => s + Math.abs(m.quantidade), 0),
    };
  }

  return {
    reservar,
    liberarReserva,
    baixarLote,
    registrarReceita,
    simularUsuario,
    getEstoqueDisponivel,
    getQtdReservada,
    assertEstoqueNaoNegativo,
    assertNenhumaDuplicata,
    assertFinanceiroSemDuplicata,
    assertBaixasTotaisCorretas,
    getResultados,
    get estoqueFisico() { return estoqueFisico; },
  };
}

/** Delay assíncrono em ms */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════
//  TESTES — 2 USUÁRIOS SIMULTÂNEOS
// ═══════════════════════════════════════════════════════════════════

describe('Concorrência — 2 usuários simultâneos', () => {

  test('2 usuários, estoque=10, cada um vende 3 → ambos vendem, estoque=4', async () => {
    const s = criarSistema({ estoqueInicial: 10 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-001', 3),
      s.simularUsuario('Caixa-B', 'venda-002', 3),
    ]);

    const sucessos = resultados.filter(r => r.sucesso);
    expect(sucessos).toHaveLength(2);
    expect(s.estoqueFisico).toBe(4);
    s.assertEstoqueNaoNegativo();
    s.assertNenhumaDuplicata();
    s.assertFinanceiroSemDuplicata();
    s.assertBaixasTotaisCorretas(6);
  });

  test('2 usuários, estoque=3, ambos tentam vender 3 → apenas 1 vende', async () => {
    const s = criarSistema({ estoqueInicial: 3 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-003', 3),
      s.simularUsuario('Caixa-B', 'venda-004', 3),
    ]);

    const sucessos = resultados.filter(r => r.sucesso);
    const falhas   = resultados.filter(r => !r.sucesso);

    // Exatamente 1 vende, 1 é bloqueado
    expect(sucessos).toHaveLength(1);
    expect(falhas).toHaveLength(1);
    expect(s.estoqueFisico).toBe(0);
    s.assertEstoqueNaoNegativo();
    s.assertNenhumaDuplicata();
    s.assertBaixasTotaisCorretas(3);
  });

  test('2 usuários, estoque=0 → nenhum vende', async () => {
    const s = criarSistema({ estoqueInicial: 0 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-005', 1),
      s.simularUsuario('Caixa-B', 'venda-006', 1),
    ]);

    expect(resultados.every(r => !r.sucesso)).toBe(true);
    expect(s.estoqueFisico).toBe(0);
    s.assertEstoqueNaoNegativo();
    s.assertBaixasTotaisCorretas(0);
  });

  test('2 usuários fluxo pendente, estoque=5, cada um vende 3 → apenas 1 reserva', async () => {
    const s = criarSistema({ estoqueInicial: 5 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-007', 3, 'pendente'),
      s.simularUsuario('Caixa-B', 'venda-008', 3, 'pendente'),
    ]);

    const sucessos = resultados.filter(r => r.sucesso);
    const falhas   = resultados.filter(r => !r.sucesso);

    expect(sucessos).toHaveLength(1);
    expect(falhas).toHaveLength(1);
    expect(s.estoqueFisico).toBeGreaterThanOrEqual(0);
    s.assertEstoqueNaoNegativo();
    s.assertNenhumaDuplicata();
  });

  test('2 usuários, mesma venda (retry) → baixa ocorre apenas 1 vez', async () => {
    const s = criarSistema({ estoqueInicial: 10 });
    const venda = { id: 'venda-retry', correlationId: 'cid_retry_001', operador: 'Caixa-A', total: 30, itens: [] };

    // Dois retries simultâneos da mesma venda
    const resultados = await Promise.all([
      s.baixarLote(venda, 3),
      s.baixarLote(venda, 3),
    ]);

    // Apenas uma movimentação deve ter sido criada
    expect(s.estoqueFisico).toBe(7); // baixou apenas uma vez
    s.assertNenhumaDuplicata();
    s.assertEstoqueNaoNegativo();
  });
});

// ═══════════════════════════════════════════════════════════════════
//  TESTES — 3 USUÁRIOS SIMULTÂNEOS
// ═══════════════════════════════════════════════════════════════════

describe('Concorrência — 3 usuários simultâneos', () => {

  test('3 usuários, estoque=9, cada um vende 3 → todos vendem, estoque=0', async () => {
    const s = criarSistema({ estoqueInicial: 9 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-101', 3),
      s.simularUsuario('Caixa-B', 'venda-102', 3),
      s.simularUsuario('Caixa-C', 'venda-103', 3),
    ]);

    const sucessos = resultados.filter(r => r.sucesso);
    expect(sucessos).toHaveLength(3);
    expect(s.estoqueFisico).toBe(0);
    s.assertEstoqueNaoNegativo();
    s.assertNenhumaDuplicata();
    s.assertFinanceiroSemDuplicata();
    s.assertBaixasTotaisCorretas(9);
  });

  test('3 usuários, estoque=5, cada um tenta vender 3 → no máximo 1 vende', async () => {
    const s = criarSistema({ estoqueInicial: 5 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-104', 3),
      s.simularUsuario('Caixa-B', 'venda-105', 3),
      s.simularUsuario('Caixa-C', 'venda-106', 3),
    ]);

    const sucessos = resultados.filter(r => r.sucesso);
    expect(sucessos.length).toBeLessThanOrEqual(1);
    expect(s.estoqueFisico).toBeGreaterThanOrEqual(0);
    s.assertEstoqueNaoNegativo();
    s.assertNenhumaDuplicata();
    s.assertBaixasTotaisCorretas(sucessos.length * 3);
  });

  test('3 usuários, estoque=10, vendas de tamanhos diferentes', async () => {
    const s = criarSistema({ estoqueInicial: 10 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-107', 5),
      s.simularUsuario('Caixa-B', 'venda-108', 3),
      s.simularUsuario('Caixa-C', 'venda-109', 4),
    ]);

    // Total solicitado = 12 > 10. Pelo menos uma deve falhar.
    const sucessos    = resultados.filter(r => r.sucesso);
    const totalBaixado = sucessos.reduce((s, r) => {
      const qtds = { 'venda-107': 5, 'venda-108': 3, 'venda-109': 4 };
      return s + (qtds[r.vendaId] || 0);
    }, 0);

    expect(totalBaixado).toBeLessThanOrEqual(10);
    expect(s.estoqueFisico).toBeGreaterThanOrEqual(0);
    s.assertEstoqueNaoNegativo();
    s.assertNenhumaDuplicata();
    s.assertFinanceiroSemDuplicata();
  });

  test('3 usuários fluxo pendente, estoque=6, cada um vende 4 → somente 1 aprova', async () => {
    const s = criarSistema({ estoqueInicial: 6 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-110', 4, 'pendente'),
      s.simularUsuario('Caixa-B', 'venda-111', 4, 'pendente'),
      s.simularUsuario('Caixa-C', 'venda-112', 4, 'pendente'),
    ]);

    const sucessos = resultados.filter(r => r.sucesso);
    expect(sucessos).toHaveLength(1);
    expect(s.estoqueFisico).toBeGreaterThanOrEqual(0);
    s.assertEstoqueNaoNegativo();
    s.assertNenhumaDuplicata();
  });

  test('3 usuários — estoque exatamente suficiente para 2 (5+5+5, estoque=10)', async () => {
    const s = criarSistema({ estoqueInicial: 10 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-113', 5),
      s.simularUsuario('Caixa-B', 'venda-114', 5),
      s.simularUsuario('Caixa-C', 'venda-115', 5),
    ]);

    const sucessos = resultados.filter(r => r.sucesso);
    expect(sucessos).toHaveLength(2);
    expect(s.estoqueFisico).toBe(0);
    s.assertEstoqueNaoNegativo();
    s.assertNenhumaDuplicata();
    s.assertBaixasTotaisCorretas(10);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  TESTES — 5 USUÁRIOS SIMULTÂNEOS
// ═══════════════════════════════════════════════════════════════════

describe('Concorrência — 5 usuários simultâneos', () => {

  test('5 usuários, estoque=50, cada um vende 10 → todos vendem, estoque=0', async () => {
    const s = criarSistema({ estoqueInicial: 50 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-201', 10),
      s.simularUsuario('Caixa-B', 'venda-202', 10),
      s.simularUsuario('Caixa-C', 'venda-203', 10),
      s.simularUsuario('Caixa-D', 'venda-204', 10),
      s.simularUsuario('Caixa-E', 'venda-205', 10),
    ]);

    const sucessos = resultados.filter(r => r.sucesso);
    expect(sucessos).toHaveLength(5);
    expect(s.estoqueFisico).toBe(0);
    s.assertEstoqueNaoNegativo();
    s.assertNenhumaDuplicata();
    s.assertFinanceiroSemDuplicata();
    s.assertBaixasTotaisCorretas(50);
  });

  test('5 usuários, estoque=12, cada um tenta vender 5 → no máximo 2 vendem', async () => {
    const s = criarSistema({ estoqueInicial: 12 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-206', 5),
      s.simularUsuario('Caixa-B', 'venda-207', 5),
      s.simularUsuario('Caixa-C', 'venda-208', 5),
      s.simularUsuario('Caixa-D', 'venda-209', 5),
      s.simularUsuario('Caixa-E', 'venda-210', 5),
    ]);

    const sucessos = resultados.filter(r => r.sucesso);
    expect(sucessos.length).toBeLessThanOrEqual(2);
    expect(s.estoqueFisico).toBeGreaterThanOrEqual(0);
    s.assertEstoqueNaoNegativo();
    s.assertNenhumaDuplicata();
    s.assertFinanceiroSemDuplicata();
    s.assertBaixasTotaisCorretas(sucessos.length * 5);
  });

  test('5 usuários fluxo pendente, estoque=8, cada um reserva 3 → no máximo 2 reservam', async () => {
    const s = criarSistema({ estoqueInicial: 8 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-211', 3, 'pendente'),
      s.simularUsuario('Caixa-B', 'venda-212', 3, 'pendente'),
      s.simularUsuario('Caixa-C', 'venda-213', 3, 'pendente'),
      s.simularUsuario('Caixa-D', 'venda-214', 3, 'pendente'),
      s.simularUsuario('Caixa-E', 'venda-215', 3, 'pendente'),
    ]);

    const sucessos = resultados.filter(r => r.sucesso);
    expect(sucessos.length).toBeLessThanOrEqual(2); // 8 / 3 = 2 com sobra de 2
    expect(s.estoqueFisico).toBeGreaterThanOrEqual(0);
    s.assertEstoqueNaoNegativo();
    s.assertNenhumaDuplicata();
  });

  test('5 usuários, estoque=1, todos tentam vender 1 → apenas 1 vende', async () => {
    const s = criarSistema({ estoqueInicial: 1 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-216', 1),
      s.simularUsuario('Caixa-B', 'venda-217', 1),
      s.simularUsuario('Caixa-C', 'venda-218', 1),
      s.simularUsuario('Caixa-D', 'venda-219', 1),
      s.simularUsuario('Caixa-E', 'venda-220', 1),
    ]);

    const sucessos = resultados.filter(r => r.sucesso);
    const falhas   = resultados.filter(r => !r.sucesso);

    expect(sucessos).toHaveLength(1);
    expect(falhas).toHaveLength(4);
    expect(s.estoqueFisico).toBe(0);
    s.assertEstoqueNaoNegativo();
    s.assertNenhumaDuplicata();
    s.assertBaixasTotaisCorretas(1);
  });

  test('5 usuários mistos (direto + pendente), estoque=15 → sem divergência', async () => {
    const s = criarSistema({ estoqueInicial: 15 });

    const resultados = await Promise.all([
      s.simularUsuario('Caixa-A', 'venda-221', 4, 'direto'),
      s.simularUsuario('Caixa-B', 'venda-222', 5, 'pendente'),
      s.simularUsuario('Caixa-C', 'venda-223', 3, 'direto'),
      s.simularUsuario('Caixa-D', 'venda-224', 6, 'pendente'),
      s.simularUsuario('Caixa-E', 'venda-225', 4, 'direto'),
    ]);

    // Total solicitado = 22 > 15. Alguns devem falhar.
    const sucessos    = resultados.filter(r => r.sucesso);
    const totalBaixado = s.getResultados().totalBaixado;

    expect(totalBaixado).toBeLessThanOrEqual(15);
    expect(s.estoqueFisico).toBeGreaterThanOrEqual(0);
    s.assertEstoqueNaoNegativo();
    s.assertNenhumaDuplicata();
    s.assertFinanceiroSemDuplicata();

    // Estoque final = inicial - totalBaixado
    expect(s.estoqueFisico).toBe(15 - totalBaixado);
  });

  test('5 usuários com retries simultâneos — idempotência sob carga', async () => {
    const s = criarSistema({ estoqueInicial: 30 });

    // 5 usuários, cada um dispara 3 retries simultâneos da mesma venda
    const promises = [];
    for (let i = 1; i <= 5; i++) {
      const vendaId = `venda-retry-${i}`;
      const venda   = { id: vendaId, correlationId: `cid_ret_${i}`, operador: `Caixa-${i}`, total: 50, itens: [] };
      // 3 retries simultâneos da mesma venda
      promises.push(s.baixarLote(venda, 2));
      promises.push(s.baixarLote(venda, 2));
      promises.push(s.baixarLote(venda, 2));
    }

    await Promise.all(promises);

    // Cada venda deve ter baixado apenas 1 vez (2 un), total = 5 * 2 = 10
    expect(s.estoqueFisico).toBe(20);
    s.assertNenhumaDuplicata();
    s.assertEstoqueNaoNegativo();
    s.assertBaixasTotaisCorretas(10);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  TESTES — PROPRIEDADES INVARIANTES (rodam N vezes com dados aleatórios)
// ═══════════════════════════════════════════════════════════════════

describe('Invariantes de concorrência — property-based', () => {

  /**
   * Roda o cenário com N usuários e estoque aleatório.
   * Verifica invariantes em todos os casos.
   */
  async function rodarCenarioAleatorio(nUsuarios, estoqueInicial) {
    const s = criarSistema({ estoqueInicial });
    const promises = [];

    for (let i = 0; i < nUsuarios; i++) {
      const qtd = 1 + Math.floor(Math.random() * 5); // 1 a 5 por venda
      promises.push(
        s.simularUsuario(`Caixa-${i}`, `venda-rnd-${i}`, qtd)
      );
    }

    await Promise.all(promises);

    return s;
  }

  test('invariante: estoque nunca negativo (10 cenários aleatórios, 2 usuários)', async () => {
    for (let rodada = 0; rodada < 10; rodada++) {
      const estoque = Math.floor(Math.random() * 20); // 0 a 19
      const s = await rodarCenarioAleatorio(2, estoque);
      s.assertEstoqueNaoNegativo();
      s.assertNenhumaDuplicata();
      s.assertBaixasTotaisCorretas();
    }
  });

  test('invariante: estoque nunca negativo (10 cenários aleatórios, 3 usuários)', async () => {
    for (let rodada = 0; rodada < 10; rodada++) {
      const estoque = Math.floor(Math.random() * 30); // 0 a 29
      const s = await rodarCenarioAleatorio(3, estoque);
      s.assertEstoqueNaoNegativo();
      s.assertNenhumaDuplicata();
      s.assertBaixasTotaisCorretas();
    }
  });

  test('invariante: estoque nunca negativo (10 cenários aleatórios, 5 usuários)', async () => {
    for (let rodada = 0; rodada < 10; rodada++) {
      const estoque = Math.floor(Math.random() * 50); // 0 a 49
      const s = await rodarCenarioAleatorio(5, estoque);
      s.assertEstoqueNaoNegativo();
      s.assertNenhumaDuplicata();
      s.assertBaixasTotaisCorretas();
    }
  });

  test('invariante: soma das baixas nunca excede estoque inicial', async () => {
    const cenarios = [
      { usuarios: 2, estoque: 5  },
      { usuarios: 3, estoque: 7  },
      { usuarios: 5, estoque: 10 },
      { usuarios: 5, estoque: 3  },
      { usuarios: 5, estoque: 0  },
    ];

    for (const { usuarios, estoque } of cenarios) {
      const s = await rodarCenarioAleatorio(usuarios, estoque);
      const r = s.getResultados();
      expect(r.totalBaixado).toBeLessThanOrEqual(estoque);
      expect(r.estoqueFinal).toBeGreaterThanOrEqual(0);
      expect(r.estoqueFinal).toBe(estoque - r.totalBaixado);
    }
  });

  test('invariante: financeiro sem duplicatas em qualquer cenário', async () => {
    for (let rodada = 0; rodada < 5; rodada++) {
      const estoque = Math.floor(Math.random() * 25);
      const s = await rodarCenarioAleatorio(5, estoque);
      s.assertFinanceiroSemDuplicata();
    }
  });
});
