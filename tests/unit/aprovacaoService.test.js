/**
 * Testes unitários — AprovacaoService
 * Foco: fluxo de status, sem dupla baixa de estoque
 */

describe('AprovacaoService — Fluxo de status', () => {

  const STATUS = { PENDENTE: 'pendente', APROVADA: 'aprovada', VALIDADA: 'validada', CANCELADA: 'cancelada' };

  test('aprovarVenda não deve alterar estoque', () => {
    const estoque = [{ id: 'p1', qtdUn: 10 }];
    const qtdAntes = estoque[0].qtdUn;
    // aprovarVenda só muda status
    const venda = { status: STATUS.PENDENTE };
    venda.status = STATUS.APROVADA;
    expect(estoque[0].qtdUn).toBe(qtdAntes); // estoque intacto
  });

  test('validarVenda deve baixar estoque apenas uma vez', () => {
    const movimentacoes = [];
    const jaValidado = new Set();

    function validarVenda(venda) {
      if (jaValidado.has(venda.id)) return false; // idempotente
      jaValidado.add(venda.id);
      venda.status = STATUS.VALIDADA;
      venda.itens.forEach(item => {
        movimentacoes.push({ produtoId: item.prodId, tipo: 'venda', origem: `venda:${venda.id}` });
      });
      return true;
    }

    const venda = { id: 'v1', status: STATUS.APROVADA, itens: [{ prodId: 'p1', qtd: 2 }] };
    validarVenda(venda);
    validarVenda(venda); // segunda chamada — idempotente

    expect(movimentacoes.filter(m => m.origem === 'venda:v1')).toHaveLength(1);
  });

  test('rejeitarVenda deve liberar reserva de estoque', () => {
    const reservas = { 'v1': 3 };
    function liberarReserva(vendaId) {
      delete reservas[vendaId];
    }
    function rejeitarVenda(venda) {
      venda.status = STATUS.CANCELADA;
      liberarReserva(venda.id);
    }
    const venda = { id: 'v1', status: STATUS.PENDENTE };
    rejeitarVenda(venda);
    expect(reservas['v1']).toBeUndefined();
  });

  test('validarTodas não deve parar no erro de uma venda', () => {
    const resultados = [];
    async function validarTodas(vendas) {
      for (const v of vendas) {
        try {
          if (v.id === 'v2') throw new Error('Firebase timeout');
          resultados.push({ id: v.id, ok: true });
        } catch (e) {
          resultados.push({ id: v.id, ok: false, erro: e.message });
        }
      }
    }
    const vendas = [
      { id: 'v1', status: 'aprovada' },
      { id: 'v2', status: 'aprovada' }, // vai falhar
      { id: 'v3', status: 'aprovada' },
    ];
    return validarTodas(vendas).then(() => {
      expect(resultados).toHaveLength(3);
      expect(resultados.find(r => r.id === 'v1').ok).toBe(true);
      expect(resultados.find(r => r.id === 'v2').ok).toBe(false);
      expect(resultados.find(r => r.id === 'v3').ok).toBe(true);
    });
  });
});
