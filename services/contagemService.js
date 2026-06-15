'use strict';
/**
 * services/contagemService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Módulo de Contagem Física de Estoque
 *
 * FLUXO:
 *   1. Colaborador inicia contagem (snapshot cego do estoque atual)
 *   2. Digita quantidades físicas contadas por produto
 *   3. Finaliza → contagem salva com status 'pendente_aprovacao'
 *   4. Admin revisa divergências e aplica ajustes (ou rejeita)
 *
 * MODELO — contagem:
 *   { id, tipo:'diaria'|'semanal'|'mensal', dataCurta, timestamp,
 *     operador, status:'pendente_aprovacao'|'aprovada'|'rejeitada',
 *     cega: true,
 *     itens: [{ produtoId, nome, categoria, unidade, packs,
 *               estoqueSistema, estoqueContado, diferenca,
 *               precoCusto, precoVenda, valorDiferenca }],
 *     totais: { qtdItens, qtdContados, qtdDivergentes,
 *               valorDivergCusto, valorDivergVenda },
 *     ajustesAplicados: bool, aprovadoPor, aprovadoEm,
 *     observacoes }
 *
 * STORAGE: localStorage CH_CONTAGENS + Firestore ch_dados/contagens
 * NUNCA COLAPSAR: append-only (igual saidas/ponto/financeiro)
 */

(function () {
  const { Store, AuthService, Utils, EventBus, EstoqueService } = window.CH;

  const _KEY_LS   = 'CH_CONTAGENS';
  const _MAX      = 2_000;

  // ── Helpers localStorage ─────────────────────────────────────────
  function _ler() {
    try { return JSON.parse(localStorage.getItem(_KEY_LS) || '[]'); } catch { return []; }
  }

  function _salvar(arr) {
    try {
      const final = arr.slice(0, _MAX);
      localStorage.setItem(_KEY_LS, JSON.stringify(final));
    } catch (e) {
      console.error('[ContagemService] localStorage falhou:', e);
    }
  }

  function _push(contagem) {
    const lista = _ler();
    lista.unshift(contagem); // mais recente primeiro
    _salvar(lista);
    _sincronizar(contagem);
    EventBus.emit('contagem:salva', contagem);
  }

  function _atualizarLocal(id, campos) {
    const lista = _ler();
    const idx   = lista.findIndex(c => c.id === id);
    if (idx < 0) return null;
    Object.assign(lista[idx], campos, { updatedAt: Utils.nowISO() });
    _salvar(lista);
    return lista[idx];
  }

  // ── Sincronização Firestore (padrão ch_dados/contagens) ──────────
  function _sincronizar(contagem) {
    try {
      const FB = window.CH?.FirebaseService;
      if (!FB?.isReady?.()) return;
      const adminToken = Store.getConfig()?.adminToken;
      // contagem pendente pode ser criada por colaborador (sem adminToken)
      // aprovação/ajuste exige adminToken — validado na função aplicarAjustes
      const payload = { dados: contagem, ts: Utils.nowISO() };
      if (adminToken) payload.adminToken = adminToken;
      FB.salvar('contagens', contagem.id, payload).catch(e =>
        console.warn('[ContagemService] sync falhou:', e.message)
      );
    } catch (e) {
      console.warn('[ContagemService] _sincronizar:', e);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  SNAPSHOT — captura estado atual do estoque (cego)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Retorna a lista de produtos ativos agrupados por categoria,
   * SEM revelar estoqueAtual (contagem cega).
   * Usado para montar a UI de contagem.
   */
  function getSnapshotCego() {
    const produtos = EstoqueService.getProdutos().filter(p => p.ativo !== false);
    const categorias = {};

    for (const p of produtos) {
      const cat = p.categoria || 'Sem categoria';
      if (!categorias[cat]) categorias[cat] = [];
      categorias[cat].push({
        produtoId:  p.id,
        nome:       p.nome,
        categoria:  cat,
        unidade:    p.unidade || 'UN',
        packs:      p.packs || [],
        precoCusto: p.precoCusto || p.custoUn || 0,
        precoVenda: p.precoVenda || p.precoUn  || 0,
        // NÃO inclui estoqueAtual — contagem cega
      });
    }

    return categorias; // { 'Cerveja': [...], 'Destilado': [...], ... }
  }

  // ══════════════════════════════════════════════════════════════════
  //  SALVAR CONTAGEM
  // ══════════════════════════════════════════════════════════════════

  /**
   * Finaliza e salva uma contagem.
   *
   * @param {object} params
   * @param {'diaria'|'semanal'|'mensal'} params.tipo
   * @param {Array}  params.itensContados  [{ produtoId, estoqueContado }]
   * @param {string} [params.observacoes]
   * @returns {object} contagem salva
   */
  function salvarContagem({ tipo, itensContados = [], observacoes = '' }) {
    if (!['diaria', 'semanal', 'mensal'].includes(tipo)) {
      throw new Error('Tipo inválido. Use: diaria, semanal, mensal');
    }
    if (!itensContados.length) {
      throw new Error('Nenhum item contado.');
    }

    const operador = AuthService.getNome();
    const agora    = Utils.nowISO();
    const hoje     = Utils.todayISO();

    // Monta itens com divergência calculada
    const itens = [];
    let qtdDivergentes    = 0;
    let valorDivergCusto  = 0;
    let valorDivergVenda  = 0;

    for (const ic of itensContados) {
      const prod = EstoqueService.getProduto(ic.produtoId);
      if (!prod) continue;

      const sistemaSistema = prod.estoqueAtual ?? prod.qtdUn ?? 0;
      const contado        = Number(ic.estoqueContado ?? 0);
      const diferenca      = contado - sistemaSistema;
      const precoCusto     = prod.precoCusto || prod.custoUn  || 0;
      const precoVenda     = prod.precoVenda || prod.precoUn  || 0;
      const valorDif       = diferenca * precoCusto;

      if (diferenca !== 0) {
        qtdDivergentes++;
        valorDivergCusto += diferenca * precoCusto;
        valorDivergVenda += diferenca * precoVenda;
      }

      itens.push({
        produtoId:      prod.id,
        nome:           prod.nome,
        categoria:      prod.categoria || 'Sem categoria',
        unidade:        prod.unidade || 'UN',
        estoqueSistema: sistemaSistema,
        estoqueContado: contado,
        diferenca,
        precoCusto,
        precoVenda,
        valorDiferenca: valorDif, // negativo = perda, positivo = sobra
      });
    }

    const contagem = {
      id:              Utils.generateId(),
      tipo,
      dataCurta:       hoje,
      timestamp:       agora,
      operador,
      status:          'pendente_aprovacao',
      cega:            true,
      itens,
      totais: {
        qtdItens:        itens.length,
        qtdContados:     itensContados.length,
        qtdDivergentes,
        valorDivergCusto,
        valorDivergVenda,
      },
      ajustesAplicados: false,
      aprovadoPor:      null,
      aprovadoEm:       null,
      observacoes:      observacoes.trim(),
      _fbSynced:        false,
    };

    _push(contagem);
    console.info(`[ContagemService] Contagem ${tipo} salva — ${itens.length} itens, ${qtdDivergentes} divergências`);
    return contagem;
  }

  // ══════════════════════════════════════════════════════════════════
  //  APROVAÇÃO / REJEIÇÃO (ADMIN)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Admin aprova e aplica os ajustes de estoque da contagem.
   * Aplica apenas itens com diferença != 0.
   * Chama EstoqueService.ajustarEstoque() para cada divergência.
   */
  async function aplicarAjustes(contagemId) {
    if (!AuthService.isAdmin()) {
      throw new Error('Apenas admin pode aplicar ajustes de contagem.');
    }

    const lista    = _ler();
    const contagem = lista.find(c => c.id === contagemId);
    if (!contagem) throw new Error(`Contagem ${contagemId} não encontrada.`);
    if (contagem.ajustesAplicados) throw new Error('Ajustes já foram aplicados nesta contagem.');
    if (contagem.status === 'rejeitada') throw new Error('Contagem rejeitada não pode ter ajustes aplicados.');

    const erros = [];
    const itensAjustados = [];

    for (const item of contagem.itens) {
      if (item.diferenca === 0) continue;
      try {
        await EstoqueService.ajustarEstoque(
          item.produtoId,
          item.estoqueContado,
          `Contagem ${contagem.tipo} — ${contagem.dataCurta} — por ${AuthService.getNome()}`
        );
        itensAjustados.push(item.produtoId);
      } catch (e) {
        erros.push({ produtoId: item.produtoId, nome: item.nome, erro: e.message });
        console.error(`[ContagemService] ajuste falhou ${item.nome}:`, e);
      }
    }

    const camposAtualizar = {
      status:          'aprovada',
      ajustesAplicados: true,
      aprovadoPor:     AuthService.getNome(),
      aprovadoEm:      Utils.nowISO(),
      itensAjustados,
      errosAjuste:     erros,
    };

    const contagemAtualizada = _atualizarLocal(contagemId, camposAtualizar);
    _sincronizar(contagemAtualizada);
    EventBus.emit('contagem:aprovada', { contagemId, erros });

    console.info(`[ContagemService] Ajustes aplicados — ${itensAjustados.length} produtos, ${erros.length} erros`);
    return { ok: erros.length === 0, itensAjustados, erros };
  }

  /**
   * Admin rejeita contagem (não aplica ajustes).
   */
  function rejeitarContagem(contagemId, motivoRejeicao = '') {
    if (!AuthService.isAdmin()) {
      throw new Error('Apenas admin pode rejeitar contagens.');
    }

    const contagem = _ler().find(c => c.id === contagemId);
    if (!contagem) throw new Error(`Contagem ${contagemId} não encontrada.`);

    const atualizada = _atualizarLocal(contagemId, {
      status:        'rejeitada',
      rejeitadoPor:  AuthService.getNome(),
      rejeitadoEm:   Utils.nowISO(),
      motivoRejeicao,
    });

    _sincronizar(atualizada);
    EventBus.emit('contagem:rejeitada', { contagemId, motivoRejeicao });
    return atualizada;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CONSULTAS
  // ══════════════════════════════════════════════════════════════════

  /**
   * Lista contagens com filtros opcionais.
   */
  function getContagens({ tipo, status, dataDe, dataAte, limit = 500 } = {}) {
    let lista = _ler();
    if (tipo)    lista = lista.filter(c => c.tipo    === tipo);
    if (status)  lista = lista.filter(c => c.status  === status);
    if (dataDe)  lista = lista.filter(c => c.dataCurta >= dataDe);
    if (dataAte) lista = lista.filter(c => c.dataCurta <= dataAte);
    return lista.slice(0, limit);
  }

  /**
   * Retorna a última contagem de cada tipo (diaria/semanal/mensal).
   */
  function getUltimasContagens() {
    const lista = _ler();
    const result = {};
    for (const c of lista) {
      if (!result[c.tipo]) result[c.tipo] = c;
    }
    return result;
  }

  /**
   * KPIs de um período para o relatório.
   */
  function getResumoPeriodo({ dataDe, dataAte } = {}) {
    const lista = getContagens({ dataDe, dataAte });

    let totalContagens       = lista.length;
    let totalDivergencias    = 0;
    let valorPerdaTotalCusto = 0;
    let valorSobraTotalCusto = 0;
    let itemMaisDivergente   = null;
    let maxDivAbs            = 0;

    for (const c of lista) {
      totalDivergencias += c.totais?.qtdDivergentes ?? 0;
      for (const item of (c.itens || [])) {
        if (item.diferenca < 0) valorPerdaTotalCusto += Math.abs(item.valorDiferenca);
        if (item.diferenca > 0) valorSobraTotalCusto += item.valorDiferenca;
        if (Math.abs(item.diferenca) > maxDivAbs) {
          maxDivAbs = Math.abs(item.diferenca);
          itemMaisDivergente = { nome: item.nome, diferenca: item.diferenca };
        }
      }
    }

    return {
      totalContagens,
      totalDivergencias,
      valorPerdaTotalCusto,
      valorSobraTotalCusto,
      saldoDivergencia: valorSobraTotalCusto - valorPerdaTotalCusto,
      itemMaisDivergente,
    };
  }

  /**
   * Histórico de contagens de um produto específico.
   * Útil para ver evolução do estoque ao longo do tempo.
   */
  function getHistoricoProduto(produtoId, { dataDe, dataAte, limit = 100 } = {}) {
    const lista = getContagens({ dataDe, dataAte });
    const historico = [];

    for (const c of lista) {
      const item = c.itens?.find(i => i.produtoId === produtoId);
      if (!item) continue;
      historico.push({
        contagemId:     c.id,
        tipo:           c.tipo,
        dataCurta:      c.dataCurta,
        operador:       c.operador,
        status:         c.status,
        estoqueSistema: item.estoqueSistema,
        estoqueContado: item.estoqueContado,
        diferenca:      item.diferenca,
        valorDiferenca: item.valorDiferenca,
      });
    }

    return historico.slice(0, limit);
  }

  /**
   * Retorna contagens pendentes de aprovação (para badge/notificação admin).
   */
  function getContagensPendentes() {
    return _ler().filter(c => c.status === 'pendente_aprovacao');
  }

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.ContagemService = {
    // Snapshot
    getSnapshotCego,

    // CRUD
    salvarContagem,
    aplicarAjustes,
    rejeitarContagem,

    // Consultas
    getContagens,
    getUltimasContagens,
    getResumoPeriodo,
    getHistoricoProduto,
    getContagensPendentes,
  };

  console.info('%c ContagemService ✓  (Contagem cega · Aprovação admin · Ajuste atômico)', 'color:#6366f1');
})();
