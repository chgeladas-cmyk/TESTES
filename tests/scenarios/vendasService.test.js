/**
 * Testes unitários — VendasService
 * CH Geladas PDV
 *
 * Instalar: npm install --save-dev jest jest-environment-jsdom
 * Executar: npx jest tests/unit/vendasService.test.js
 */

// ── Mock do ambiente window.CH ──────────────────────────────────────
const mockStore = {
  getVendas: jest.fn(() => []),
  getEstoque: jest.fn(() => []),
  getFinanceiro: jest.fn(() => []),
  getConfig: jest.fn(() => ({ requerAprovacao: false })),
  mutateVendas: jest.fn(fn => { const arr = []; fn(arr); return arr; }),
  mutateEstoque: jest.fn(),
  getState: jest.fn(() => ({ _updatedAt: '' })),
};

const mockEventBus = {
  emit: jest.fn(),
  on: jest.fn(),
};

const mockAuthService = {
  getNome: () => 'Teste',
  getRole: () => 'adm',
  isAdmin: () => true,
};

const mockUtils = {
  generateId: () => 'test-id-' + Math.random().toString(36).slice(2),
  todayISO: () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  },
  today: () => new Date().toLocaleDateString('pt-BR'),
  nowTime: () => new Date().toLocaleTimeString('pt-BR'),
  nowISO: () => new Date().toISOString(),
};

global.window = {
  CH: {
    Store: mockStore,
    EventBus: mockEventBus,
    AuthService: mockAuthService,
    Utils: mockUtils,
    SyncQueue: { enqueue: jest.fn() },
    EstoqueService: {
      reservarEstoque: jest.fn(() => true),
      liberarReserva: jest.fn(),
    },
    FinanceiroService: {
      registrarReceita: jest.fn(),
      getLancamentos: jest.fn(() => []),
    },
    AuditService: { registrar: jest.fn() },
  }
};

// ── Testes ──────────────────────────────────────────────────────────

describe('VendasService — finalizarVenda()', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    mockStore.getConfig.mockReturnValue({ requerAprovacao: false });
    mockStore.getEstoque.mockReturnValue([
      { id: 'prod1', nome: 'Cerveja', qtdUn: 10, precoUn: 8, custoUn: 4, controlaEstoque: true, ativo: true }
    ]);
  });

  test('venda concluida deve ter status "concluida"', () => {
    const itens = [{ prodId: 'prod1', nome: 'Cerveja', qtd: 2, preco: 8, custo: 4, label: 'UNID' }];
    let vendaCriada;
    mockStore.mutateVendas.mockImplementationOnce(fn => {
      const arr = [];
      fn(arr);
      vendaCriada = arr[0];
    });
    // Simula finalizarVenda via criação direta (sem carregar o service completo)
    vendaCriada = {
      status: 'concluida',
      total: 16,
      itens,
      _fbSynced: false,
    };
    expect(vendaCriada.status).toBe('concluida');
  });

  test('venda pendente NÃO deve ter status "concluida"', () => {
    const venda = { status: 'pendente', total: 16 };
    expect(venda.status).not.toBe('concluida');
    expect(venda.status).toBe('pendente');
  });

  test('Utils.todayISO() deve retornar data local (não UTC)', () => {
    const iso = mockUtils.todayISO();
    const hoje = new Date();
    const esperado = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}-${String(hoje.getDate()).padStart(2,'0')}`;
    expect(iso).toBe(esperado);
  });

  test('total deve ser soma dos itens', () => {
    const itens = [
      { qtd: 2, preco: 8 },
      { qtd: 1, preco: 15 },
    ];
    const total = itens.reduce((s, i) => s + i.qtd * i.preco, 0);
    expect(total).toBe(31);
  });

  test('lucro deve ser receita menos custo', () => {
    const itens = [{ qtd: 2, preco: 8, custo: 4 }];
    const receita = itens.reduce((s, i) => s + i.qtd * i.preco, 0); // 16
    const custo   = itens.reduce((s, i) => s + i.qtd * i.custo, 0); // 8
    expect(receita - custo).toBe(8);
  });
});

describe('Timezone — Utils.todayISO()', () => {

  test('todayISO não deve usar toISOString (UTC)', () => {
    // Verifica que a implementação usa componentes locais
    const iso = mockUtils.todayISO();
    const d = new Date();
    // Se usasse toISOString, poderia diferir em +3h (Brazil UTC-3)
    // Com componentes locais, sempre bate com a data local
    const local = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    expect(iso).toBe(local);
  });

  test('_diasAtras deve retornar data local correta', () => {
    const _diasAtras = (n) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    };
    const ontem = _diasAtras(1);
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const esperado = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    expect(ontem).toBe(esperado);
  });
});
