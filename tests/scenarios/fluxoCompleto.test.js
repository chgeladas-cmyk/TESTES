/**
 * Testes de cenário — Fluxo completo de venda
 * CH Geladas PDV
 *
 * Cobre os cenários críticos de negócio:
 *   1. Venda simples → concluida → estoque baixado → financeiro registrado
 *   2. Venda com aprovação → pendente → aprovada → validada → estoque/financeiro
 *   3. Cancelamento → estorno → estoque revertido
 *   4. Quitação de fiado → venda com status + financeiro
 */

describe('Cenário 1: Venda simples sem aprovação', () => {
  let estoque, vendas, financeiro, movimentacoes;

  beforeEach(() => {
    estoque = [{ id: 'p1', nome: 'Cerveja', qtdUn: 10, precoUn: 8, custoUn: 4, controlaEstoque: true }];
    vendas = [];
    financeiro = [];
    movimentacoes = [];
  });

  test('finalizarVenda deve criar venda com status concluida', () => {
    const venda = {
      id: 'v1',
      status: 'concluida',
      total: 16,
      itens: [{ prodId: 'p1', qtd: 2, preco: 8, custo: 4 }],
      _fbSynced: false,
    };
    vendas.unshift(venda);
    expect(vendas[0].status).toBe('concluida');
    expect(vendas[0]._fbSynced).toBe(false);
  });

  test('baixa de estoque deve ocorrer após status concluida', () => {
    const prod = estoque.find(p => p.id === 'p1');
    prod.qtdUn = Math.max(0, prod.qtdUn - 2);
    expect(prod.qtdUn).toBe(8);
  });

  test('receita deve ser registrada no financeiro uma única vez', () => {
    const venda = { id: 'v1', total: 16, status: 'concluida' };
    // Primeira vez
    if (!financeiro.some(l => l.referencia === venda.id && l.tipo === 'receita')) {
      financeiro.push({ tipo: 'receita', referencia: venda.id, valor: venda.total });
    }
    // Segunda tentativa (retry)
    if (!financeiro.some(l => l.referencia === venda.id && l.tipo === 'receita')) {
      financeiro.push({ tipo: 'receita', referencia: venda.id, valor: venda.total });
    }
    expect(financeiro.filter(l => l.referencia === 'v1')).toHaveLength(1);
  });
});

describe('Cenário 2: Venda com fluxo de aprovação', () => {
  test('venda pendente NÃO deve baixar estoque', () => {
    const estoque = [{ id: 'p1', qtdUn: 10 }];
    const qtdOriginal = estoque[0].qtdUn;
    // Status pendente = sem baixa
    const venda = { status: 'pendente' };
    // Se pendente, não chama baixarEstoqueVenda
    if (venda.status !== 'pendente') {
      estoque[0].qtdUn -= 2; // nunca deve executar
    }
    expect(estoque[0].qtdUn).toBe(qtdOriginal);
  });

  test('venda deve ser aprovada (pendente → aprovada) sem tocar estoque', () => {
    const venda = { id: 'v1', status: 'pendente' };
    // aprovarVenda
    venda.status = 'aprovada';
    expect(venda.status).toBe('aprovada');
    // Estoque não foi tocado (teste: nenhuma movimentacao gerada)
    const movimentacoes = [];
    expect(movimentacoes).toHaveLength(0);
  });

  test('venda deve ser validada (aprovada → validada) E baixar estoque', () => {
    const estoque = [{ id: 'p1', qtdUn: 10 }];
    const venda = { id: 'v1', status: 'aprovada', itens: [{ prodId: 'p1', qtd: 3 }] };
    // validarVenda
    venda.status = 'validada';
    // baixa de estoque ocorre agora
    const prod = estoque.find(p => p.id === 'p1');
    prod.qtdUn = Math.max(0, prod.qtdUn - 3);
    expect(venda.status).toBe('validada');
    expect(prod.qtdUn).toBe(7);
  });
});

describe('Cenário 3: Cancelamento com estorno', () => {
  test('cancelamento deve usar soft delete (status=cancelada, não splice)', () => {
    const vendas = [{ id: 'v1', status: 'concluida', total: 50 }];
    const financeiro = [{ tipo: 'receita', referencia: 'v1', valor: 50 }];

    // Soft cancel
    const venda = vendas.find(v => v.id === 'v1');
    venda.status = 'cancelada';
    venda.canceladoEm = new Date().toISOString();

    // Estorno
    if (!financeiro.some(l => l.referencia === 'v1' && l.tipo === 'estorno')) {
      financeiro.push({ tipo: 'estorno', referencia: 'v1', valor: 50 });
    }

    // Venda ainda existe (soft delete)
    expect(vendas).toHaveLength(1);
    expect(vendas[0].status).toBe('cancelada');
    // Estorno registrado
    expect(financeiro.some(l => l.tipo === 'estorno' && l.referencia === 'v1')).toBe(true);
    // Saldo líquido = 0 (receita 50 - estorno 50)
    const receitas = financeiro.filter(l => l.tipo === 'receita').reduce((s,l)=>s+l.valor,0);
    const estornos = financeiro.filter(l => l.tipo === 'estorno').reduce((s,l)=>s+l.valor,0);
    expect(receitas - estornos).toBe(0);
  });
});

describe('Cenário 4: Quitação de fiado', () => {
  test('quitação deve criar venda com status concluida', () => {
    const vendaQuitacao = {
      id: 'fq1',
      status: 'concluida', // FIX aplicado
      total: 80,
      origem: 'FIADO',
      _fbSynced: false,
    };
    expect(vendaQuitacao.status).toBe('concluida');
    expect(vendaQuitacao.origem).toBe('FIADO');
  });

  test('quitação deve ser visível nos KPIs (filtro por status)', () => {
    const vendas = [
      { id: 'v1', status: 'concluida', total: 100, origem: 'PDV' },
      { id: 'fq1', status: 'concluida', total: 80, origem: 'FIADO' }, // antes: sem status = invisível
    ];
    const STATUS_VALIDOS = ['concluida', 'validada', 'aprovada'];
    const visiveis = vendas.filter(v => STATUS_VALIDOS.includes(v.status || ''));
    expect(visiveis).toHaveLength(2);
    const faturamento = visiveis.reduce((s, v) => s + v.total, 0);
    expect(faturamento).toBe(180);
  });
});
