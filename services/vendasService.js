'use strict';
/**
 * services/vendasService.js — CH Geladas PDV
 *
 * REGRA CRÍTICA:
 *   finalizarVenda() é SÍNCRONA — retorna o objeto venda imediatamente.
 *   CartService.finalize() (core.js) depende disso para funcionar.
 *
 * ARQUITETURA:
 *   Após emitir 'venda:finalizada' ou 'venda:pendente', este service para.
 *   O VendaMediator → TransactionManager orquestram estoque, financeiro e auditoria.
 *
 * FLUXO DE APROVAÇÃO:
 *   Perfil com flag 'vendas_requer_aprovacao' → status 'pendente'
 *     → sem estoque, sem financeiro agora.
 *   Caso contrário → status 'concluida' → VendaMediator trata em background.
 */

(function () {
  function _Store()    { return window.CH.Store; }
  function _Auth()     { return window.CH.AuthService; }
  function _Utils()    { return window.CH.Utils; }
  function _Bus()      { return window.CH.EventBus; }

  // ── Guard de idempotência ─────────────────────────────────────────
  // Armazena idempotencyKeys das vendas em andamento.
  // Se finalizarVenda() for chamada duas vezes com a mesma chave,
  // a segunda chamada é rejeitada silenciosamente.
  // TTL de 5s: após 5 segundos, a chave expira e permite nova tentativa legítima.
  const _emAndamento = new Map(); // idempotencyKey → timestamp
  const _TTL_MS = 5_000;

  function _registrarChave(chave) {
    _limparExpirados();
    if (_emAndamento.has(chave)) return false; // já em andamento — rejeita
    _emAndamento.set(chave, Date.now());
    return true;
  }

  function _liberarChave(chave) {
    _emAndamento.delete(chave);
  }

  function _limparExpirados() {
    const agora = Date.now();
    for (const [k, ts] of _emAndamento) {
      if (agora - ts > _TTL_MS) _emAndamento.delete(k);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  FINALIZAR VENDA — SÍNCRONO (não async!)
  // ══════════════════════════════════════════════════════════════════
  function finalizarVenda(cart, formaPgto, extras = {}) {
    const itens    = cart.getItems    ? cart.getItems()    : (cart.itens    || []);
    const total    = cart.getTotal    ? cart.getTotal()    : (cart.total    || 0);
    const subtotal = cart.getSubtotal ? cart.getSubtotal() : (cart.subtotal || total);
    const desconto = cart.getDesconto ? cart.getDesconto() : (cart.desconto || 0);

    if (!itens.length) throw new Error('Carrinho vazio');

    // ── Idempotência: impede venda duplicada por duplo-clique ─────────
    // A chave é derivada do conteúdo do carrinho + operador + forma de pagamento.
    // Dois cliques rápidos geram a mesma chave → segundo é rejeitado.
    // Após 5s a chave expira, permitindo nova venda legítima com o mesmo conteúdo.
    const idempotencyKey = [
      _Auth().getNome(),
      formaPgto || 'Dinheiro',
      total.toFixed(2),
      itens.map(i => `${i.prodId}:${i.qtd}:${i.label}`).sort().join('|'),
    ].join('§');

    if (!_registrarChave(idempotencyKey)) {
      console.warn(`[VendasService] Duplo-clique detectado — venda ignorada (key=${idempotencyKey.slice(0,40)}...)`);
      return null; // retorna null: CartService não limpa, UI não avança
    }

    try {
      return _finalizarVendaInterno(cart, formaPgto, extras, itens, total, subtotal, desconto, idempotencyKey);
    } finally {
      // Libera a chave após execução síncrona — permite nova venda após o fluxo completo
      // O TTL de 5s protege contra cliques simultâneos enquanto o JS ainda está executando
      setTimeout(() => _liberarChave(idempotencyKey), _TTL_MS);
    }
  }

  function _finalizarVendaInterno(cart, formaPgto, extras, itens, total, subtotal, desconto, idempotencyKey) {

    const lucro = itens.reduce((s, i) => s + (i.preco - (i.custo || 0)) * i.qtd, 0) - desconto;
    const role  = _Auth().getRole();

    const _Perm = window.CH.PermissoesService;
    const _rolesLivres = ['adm', 'admin', 'gerente', 'operador', 'pdv', 'entregador'];
    let requerAprovacao;
    if (_Perm) {
      requerAprovacao = _Perm.getFlag(role, 'vendas_requer_aprovacao');
    } else {
      requerAprovacao = !_rolesLivres.includes(role);
      console.warn('[VendasService] PermissoesService não carregado — usando fallback conservador para role:', role);
    }

    const vendaId = _Utils().generateId();

    // ── Correlation ID ────────────────────────────────────────────
    // Gerado UMA vez aqui e propagado para estoque, financeiro e auditoria.
    // Permite rastrear toda a cadeia de operações de uma venda nos logs.
    // Formato: cid_<6 últimos chars do vendaId>_<timestamp ms>
    const correlationId = `cid_${vendaId.slice(-6)}_${Date.now()}`;

    const venda = {
      id:               vendaId,
      idempotencyKey,
      correlationId,
      dataCurta:        _Utils().todayISO(),
      data:             _Utils().today(),
      hora:             _Utils().nowTime(),
      criadoEm:         _Utils().nowISO(),
      itens, total, subtotal, desconto, lucro,
      formaPgto:        formaPgto || 'Dinheiro',
      origem:           'PDV',
      operador:         _Auth().getNome(),
      role,
      status:           requerAprovacao ? 'pendente' : 'concluida',
      _fbSynced:        false,
      _troco:           extras.troco           || 0,
      _parcelaDinheiro: extras.parcelaDinheiro || 0,
      _parcelaRestante: extras.parcelaRestante || 0,
      _formaRestante:   extras.formaRestante   || '',
    };

    // 1. Salva no Store
    // Store.mutateVendas → _mutate → SyncQueue.enqueue('salvar','vendas') automático.
    // Enqueue manual removido (era duplicata — causava dois batch.commit() no Firebase).
    _Store().mutateVendas(v => { v.unshift(venda); });

    // 3. Limpa carrinho imediatamente
    if (cart.clear) cart.clear();

    // ── REQUER APROVAÇÃO: para aqui, sem estoque/financeiro ──────
    // VendaMediator ouvirá 'venda:pendente' e chamará reservarEstoque.
    if (requerAprovacao) {
      _Bus().emit('venda:pendente', venda);
      console.info(`[VendasService] Venda PENDENTE (${role}) → ${venda.id}`);
      return venda;
    }

    // ── FLUXO DIRETO: emite evento — VendaMediator cuida do resto ──
    // VendaMediator ouvirá 'venda:finalizada' e executará:
    //   baixa de estoque → receita financeira
    _Bus().emit('venda:finalizada', venda);
    return venda;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CANCELAR VENDA
  // ══════════════════════════════════════════════════════════════════
  async function cancelarVenda(vendaId) {
    const venda = _Store().getVendas().find(v => v.id === vendaId);
    if (!venda)                       throw new Error(`Venda ${vendaId} não encontrada`);
    if (venda.status === 'cancelada') throw new Error('Venda já cancelada');
    if (venda.status === 'pendente')  throw new Error('Use "rejeitar" no painel de aprovação');
    if (venda.status === 'rejeitada') throw new Error('Venda já foi rejeitada');

    _Store().mutateVendas(vendas => {
      const v = vendas.find(v => v.id === vendaId);
      if (v) {
        v.status       = 'cancelada';
        v.canceladaEm  = _Utils().nowISO();
        v.canceladaPor = _Auth().getNome();
      }
    });

    window.CH.AuditService?.auditarCancelamento(venda,
      venda.motivoCancelamento || 'Cancelamento pelo operador');

    window.CH.IntegrityService?.desbloquearVenda?.(vendaId);

    // VendaRepository sincroniza com Firestore
    const v = _Store().getVendas().find(v => v.id === vendaId);
    if (v) window.CH.VendaRepository?.atualizar(v);

    // Emite evento — VendaMediator executa: estorno de estoque + estorno financeiro
    _Bus().emit('venda:cancelada', { vendaId, venda, operador: _Auth().getNome() });
    return true;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CONSULTAS
  // ══════════════════════════════════════════════════════════════════
  function getVendasPeriodo(dataDe, dataAte) {
    return _Store().getVendas().filter(v => v.dataCurta >= dataDe && v.dataCurta <= dataAte);
  }

  function getVendasHoje() {
    return getVendasPeriodo(_Utils().todayISO(), _Utils().todayISO());
  }

  function getResumoHoje() {
    const todas  = getVendasHoje();
    const vendas = todas.filter(v => ['concluida', 'validada'].includes(v.status));
    const total  = vendas.reduce((s, v) => s + (v.total || 0), 0);
    const lucro  = vendas.reduce((s, v) => s + (v.lucro || 0), 0);
    const qtdItens = vendas.reduce((s, v) =>
      s + (v.itens?.reduce((si, i) => si + i.qtd, 0) || 0), 0);
    const porForma = {};
    vendas.forEach(v => {
      const f = v.formaPgto || 'Outros';
      porForma[f] = (porForma[f] || 0) + v.total;
    });
    return {
      quantidade: vendas.length, total, lucro, qtdItens,
      ticketMedio: vendas.length ? total / vendas.length : 0,
      porForma,
      pendentes: todas.filter(v => v.status === 'pendente').length,
      aprovadas: todas.filter(v => v.status === 'aprovada').length,
    };
  }

  function getResumoSemana() {
    const hoje = new Date(), dom = new Date(hoje);
    dom.setDate(hoje.getDate() - hoje.getDay());
    const vendas = getVendasPeriodo(_localDateISO(dom), _Utils().todayISO()) // FIX #5b
      .filter(v => ['concluida', 'validada'].includes(v.status));
    return {
      quantidade: vendas.length,
      total:      vendas.reduce((s, v) => s + v.total, 0),
      lucro:      vendas.reduce((s, v) => s + (v.lucro || 0), 0),
    };
  }

  function getProdutosMaisVendidos(limite = 10, periodo = 30) {
    const dm = new Date();
    dm.setDate(dm.getDate() - periodo);
    const vendas = getVendasPeriodo(_localDateISO(dm), _Utils().todayISO()) // FIX #5b
      .filter(v => ['concluida', 'validada'].includes(v.status));
    const mapa = {};
    vendas.forEach(venda => {
      venda.itens?.forEach(item => {
        if (!mapa[item.prodId]) {
          mapa[item.prodId] = { prodId: item.prodId, nome: item.nome, qtd: 0, total: 0 };
        }
        mapa[item.prodId].qtd   += item.qtd;
        mapa[item.prodId].total += item.preco * item.qtd;
      });
    });
    return Object.values(mapa).sort((a, b) => b.qtd - a.qtd).slice(0, limite);
  }

  window.CH.VendasService = {
    finalizarVenda,
    cancelarVenda,
    getVendasPeriodo,
    getVendasHoje,
    getResumoHoje,
    getResumoSemana,
    getProdutosMaisVendidos,
  };

  console.info('%c VendasService ✓  (v3: baixa rastreável | sem fire-and-forget silencioso)', 'color:#10b981;font-weight:bold');
})();
