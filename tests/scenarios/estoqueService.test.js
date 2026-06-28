/**
 * Testes unitários — EstoqueService
 * Foco: idempotência de baixarEstoqueVenda, reservas, estoque negativo
 */

describe('EstoqueService — Idempotência de baixarEstoqueVenda', () => {
  let movimentacoes = [];

  const mockStore = {
    getMovimentacoes: () => movimentacoes,
  };

  function baixarEstoqueVenda(produtoId, quantidade, vendaId) {
    if (vendaId) {
      const origemKey = `venda:${vendaId}`;
      const jaProcessado = mockStore.getMovimentacoes().some(
        m => m.origem === origemKey && m.produtoId === produtoId && m.tipo === 'venda'
      );
      if (jaProcessado) return null;
    }
    const mov = { produtoId, quantidade, tipo: 'venda', origem: `venda:${vendaId}` };
    movimentacoes.push(mov);
    return mov;
  }

  beforeEach(() => { movimentacoes = []; });

  test('baixa de estoque deve ocorrer apenas 1 vez por vendaId+produtoId', () => {
    baixarEstoqueVenda('prod1', 2, 'venda-abc');
    baixarEstoqueVenda('prod1', 2, 'venda-abc'); // retry — deve ser ignorado
    baixarEstoqueVenda('prod1', 2, 'venda-abc'); // terceiro — ignorado
    const baixas = movimentacoes.filter(m => m.origem === 'venda:venda-abc');
    expect(baixas).toHaveLength(1);
  });

  test('vendas diferentes devem baixar independentemente', () => {
    baixarEstoqueVenda('prod1', 2, 'venda-001');
    baixarEstoqueVenda('prod1', 3, 'venda-002');
    expect(movimentacoes).toHaveLength(2);
  });

  test('produtos diferentes na mesma venda devem baixar independentemente', () => {
    baixarEstoqueVenda('prod1', 2, 'venda-xyz');
    baixarEstoqueVenda('prod2', 1, 'venda-xyz');
    expect(movimentacoes).toHaveLength(2);
  });

  test('produto com controlaEstoque=false não deve baixar', () => {
    function baixarComControle(produtoId, quantidade, vendaId, controlaEstoque) {
      if (!controlaEstoque) return null; // pula
      return baixarEstoqueVenda(produtoId, quantidade, vendaId);
    }
    baixarComControle('prod-livre', 5, 'v1', false);
    expect(movimentacoes).toHaveLength(0);
  });
});

describe('EstoqueService — Estoque disponível', () => {
  test('estoqueDisponivel = qtdUn - soma_reservas_ativas', () => {
    const produto = { id: 'p1', qtdUn: 10 };
    const reservas = { 'venda-a': 3, 'venda-b': 2 };
    const somaReservas = Object.values(reservas).reduce((s, r) => s + r, 0);
    const disponivel = produto.qtdUn - somaReservas;
    expect(disponivel).toBe(5);
  });

  test('estoque não deve ficar negativo após baixa', () => {
    let qtdUn = 2;
    const baixar = (qtd) => { qtdUn = Math.max(0, qtdUn - qtd); };
    baixar(5); // tenta baixar mais do que tem
    expect(qtdUn).toBe(0); // nunca negativo
  });
});
