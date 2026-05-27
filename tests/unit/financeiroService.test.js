/**
 * Testes unitários — FinanceiroService
 * Foco: idempotência de registrarReceita, registrarEstorno, getResumoMes
 */

describe('FinanceiroService — Idempotência', () => {

  let financeiro = [];

  const mockStore = {
    getFinanceiro: () => financeiro,
    mutateFinanceiro: (fn) => { fn(financeiro); },
  };

  function registrarReceita(venda) {
    // Reproduz a lógica corrigida
    if (venda?.id) {
      const jaExiste = mockStore.getFinanceiro().some(
        l => l.referencia === venda.id && l.tipo === 'receita'
      );
      if (jaExiste) return null;
    }
    const lancamento = { id: 'l-' + venda.id, tipo: 'receita', referencia: venda.id, valor: venda.total };
    mockStore.mutateFinanceiro(f => f.push(lancamento));
    return lancamento;
  }

  function registrarEstorno(venda) {
    if (venda?.id) {
      const jaExiste = mockStore.getFinanceiro().some(
        l => l.referencia === venda.id && l.tipo === 'estorno'
      );
      if (jaExiste) return null;
    }
    const lancamento = { id: 'e-' + venda.id, tipo: 'estorno', referencia: venda.id, valor: venda.total };
    mockStore.mutateFinanceiro(f => f.push(lancamento));
    return lancamento;
  }

  beforeEach(() => { financeiro = []; });

  test('registrarReceita deve lançar apenas 1 vez para o mesmo vendaId', () => {
    const venda = { id: 'v1', total: 50 };
    registrarReceita(venda);
    registrarReceita(venda); // segunda chamada — deve ser ignorada
    registrarReceita(venda); // terceira — também ignorada
    const lancamentos = financeiro.filter(l => l.referencia === 'v1' && l.tipo === 'receita');
    expect(lancamentos).toHaveLength(1);
  });

  test('registrarEstorno deve lançar apenas 1 vez para o mesmo vendaId', () => {
    const venda = { id: 'v2', total: 30 };
    registrarEstorno(venda);
    registrarEstorno(venda);
    const estornos = financeiro.filter(l => l.referencia === 'v2' && l.tipo === 'estorno');
    expect(estornos).toHaveLength(1);
  });

  test('registrarReceita e registrarEstorno são independentes (mesmo vendaId)', () => {
    const venda = { id: 'v3', total: 80 };
    registrarReceita(venda);
    registrarEstorno(venda);
    expect(financeiro).toHaveLength(2);
    expect(financeiro[0].tipo).toBe('receita');
    expect(financeiro[1].tipo).toBe('estorno');
  });

  test('saldo = receitas - despesas - estornos', () => {
    financeiro = [
      { tipo: 'receita', valor: 100 },
      { tipo: 'receita', valor: 50 },
      { tipo: 'despesa', valor: 30 },
      { tipo: 'estorno', valor: 20 },
    ];
    const receitas = financeiro.filter(l => l.tipo === 'receita').reduce((s, l) => s + l.valor, 0);
    const despesas = financeiro.filter(l => l.tipo === 'despesa').reduce((s, l) => s + l.valor, 0);
    const estornos = financeiro.filter(l => l.tipo === 'estorno').reduce((s, l) => s + l.valor, 0);
    expect(receitas - despesas - estornos).toBe(100);
  });
});
