'use strict';
/**
 * services/estoqueService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Camada de domínio para estoque.
 *
 * PROBLEMA RESOLVIDO (sobrescrita concorrente):
 *   Antes: Aparelho A e B salvavam o array inteiro de estoque.
 *          O último a salvar sobrescrevia o outro → estoque errado.
 *   Agora: Cada baixa/entrada usa Firebase Transaction no documento
 *          do produto → lê o valor atual, valida, subtrai, salva.
 *          Impossível sobrescrever. Race condition eliminado.
 *
 * Modelos:
 *
 *   Produto (em estoque[]):
 *     id, nome, categoria, precoVenda (= precoUn), precoCusto (= custoUn),
 *     estoqueAtual (= qtdUn), estoqueMinimo, ativo, fornecedorId, unidade,
 *     packs, updatedAt, createdAt
 *
 *   Movimentação (em movimentacoes[]):
 *     id, produtoId, nomeProduto, tipo, quantidade,
 *     estoqueAntes, estoqueDepois, origem, operador,
 *     observacao, custo, fornecedorId, timestamp
 *
 *   Categoria (em categorias[]):
 *     id, nome, cor
 *
 *   Fornecedor (em fornecedores[]):
 *     id, nome, telefone, email, cnpj, observacao, ativo
 *
 * Requer: core.js + services/auditService.js carregados antes.
 */

(function () {
  function _Store()    { return window.CH.Store; }
  function _Auth()     { return window.CH.AuthService; }
  function _Utils()    { return window.CH.Utils; }
  function _Bus()      { return window.CH.EventBus; }
  const FirebaseService = window.CH.FirebaseService;

  // ── Helpers internos ─────────────────────────────────────────────
  function _usuario()   { return _Auth().getNome(); }
  function _isOnline()  { return navigator.onLine; }

  // ══════════════════════════════════════════════════════════════════
  //  RESERVA GLOBAL DE ESTOQUE — Firestore: reservasEstoque/{vendaId}
  //
  //  Problema resolvido:
  //    localStorage é local — cada dispositivo tinha sua própria visão
  //    das reservas. Caixa A reservava 3 Cocas; Caixa B não sabia,
  //    reservava as mesmas 3. Resultado: furo no inventário.
  //
  //  Solução:
  //    Reservas gravadas no Firestore sob reservasEstoque/{vendaId}.
  //    Todos os caixas leem do mesmo lugar via onSnapshot em tempo real.
  //    Cache em memória (_cacheReservas) serve como buffer local — é
  //    populado ao receber atualizações do Firestore e ao fazer leitura
  //    inicial. Em caso de offline, o cache da sessão é usado como
  //    fallback — nunca localStorage.
  //
  //  Estrutura de cada documento reservasEstoque/{vendaId}:
  //    {
  //      vendaId:   string,
  //      itens: {
  //        [produtoId]: number  // qtd de unidades reservadas
  //      },
  //      operador:  string,
  //      criadaEm:  ISO,
  //      expiraEm:  ISO,        // criadaEm + 24h — TTL de segurança
  //      ativa:     boolean,    // false quando liberada (soft-delete)
  //    }
  //
  //  Expiração:
  //    Reservas com expiraEm < now() são ignoradas nos cálculos e
  //    removidas do Firestore ao liberar ou ao boot do serviço.
  // ══════════════════════════════════════════════════════════════════

  // Cache em memória — { [vendaId]: { itens: {[prodId]:qtd}, expiraEm, ativa } }
  let _cacheReservas = {};
  let _reservasListener = null; // unsubscribe do onSnapshot

  const _RESERVA_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

  /** Retorna ISO string de expiração = agora + 24h */
  function _expiracao() {
    return new Date(Date.now() + _RESERVA_TTL_MS).toISOString();
  }

  /** Uma reserva está ativa se não expirou e tem ativa !== false */
  function _reservaAtiva(r) {
    if (!r || r.ativa === false) return false;
    if (!r.expiraEm) return true;
    return new Date(r.expiraEm).getTime() > Date.now();
  }

  /**
   * Inicia listener em tempo real das reservas ativas.
   * Chamado no boot do EstoqueService.
   * Atualiza _cacheReservas automaticamente quando outro caixa
   * cria ou libera uma reserva.
   */
  function _iniciarListenerReservas() {
    if (_reservasListener) return; // já está ouvindo
    if (!_isOnline() || !FirebaseService.isReady()) return;

    try {
      const colRef = FirebaseService.colRef('reservasEstoque');
      // Ouve somente reservas ativas (ativa == true)
      const q = window.CH._fb?.query
        ? window.CH._fb.query(colRef, window.CH._fb.where('ativa', '==', true))
        : colRef; // fallback sem filtro se _fb não exposto

      // FirebaseService não expõe onSnapshot diretamente — usamos subscribeRealtime se disponível
      // Caso contrário, fazemos polling leve a cada 10s via _sincronizarReservas()
      const _fb = window.__fbSDK || window.firebase?.firestore;

      if (typeof FirebaseService.subscribeRealtime === 'function') {
        // usa o canal já aberto pelo core.js
        FirebaseService.subscribeRealtime('reservasEstoque', (docs) => {
          _cacheReservas = {};
          for (const doc of docs) {
            if (_reservaAtiva(doc)) {
              _cacheReservas[doc.vendaId] = doc;
            }
          }
          _Bus().emit('estoque:reservas_atualizadas', _cacheReservas);
        });
      } else {
        // Fallback: sincroniza uma vez agora e agenda polling leve
        _sincronizarReservas();
        setInterval(_sincronizarReservas, 10_000);
      }

    } catch (e) {
      console.warn('[EstoqueService] Listener de reservas não iniciado:', e.message);
    }
  }

  /**
   * Lê todas as reservas ativas do Firestore e atualiza o cache.
   * Usada no boot e como fallback de polling.
   */
  async function _sincronizarReservas() {
    if (!_isOnline() || !FirebaseService.isReady()) return;
    try {
      const batch = await window.CH.EstoqueRepository?.lerReservas() || [];
      _cacheReservas = {};
      for (const r of batch) {
        if (_reservaAtiva(r)) {
          _cacheReservas[r.vendaId] = r;
        }
      }
    } catch (e) {
      console.warn('[EstoqueService] Sync de reservas falhou:', e.message);
    }
  }

  /**
   * Reserva unidades de estoque para uma venda pendente no Firestore.
   * Todos os caixas enxergam a mesma reserva via _cacheReservas (RT).
   * É idempotente: sobrescreve reserva anterior do mesmo vendaId.
   * Retorna { ok: boolean, erros: string[] }
   */
  async function reservarEstoque(vendaId, itens) {
    if (!vendaId || !itens?.length) return { ok: true, erros: [] };

    const itensReserva = {};
    const erros = [];

    for (const item of itens) {
      const prod = getProduto(item.prodId);
      if (!prod) continue;
      if (prod.controlaEstoque === false) continue;

      const pack  = prod.packs?.find(pk => pk.label === item.label || (pk.qtd + 'x') === item.label);
      const qtdUn = item.label === 'UNID' ? item.qtd : item.qtd * (pack?.qtd || 1);

      // ── BLOQUEIO ABSOLUTO na reserva ────────────────────────────
      // Soma reservas de OUTRAS vendas ativas no cache global.
      const reservaOutros = Object.entries(_cacheReservas)
        .filter(([vid, r]) => vid !== vendaId && _reservaAtiva(r))
        .reduce((s, [, r]) => s + (r.itens?.[item.prodId] || 0), 0);

      const disponivelParaReserva = Math.max(
        0, (prod.estoqueAtual ?? prod.qtdUn ?? 0) - reservaOutros
      );

      if (disponivelParaReserva < qtdUn) {
        const msg = `"${prod.nome}": disponível para reserva ${disponivelParaReserva}, solicitado ${qtdUn}`;
        console.error(`[EstoqueService] RESERVA BLOQUEADA — ${msg}`);
        erros.push(msg);
        continue;
      }

      itensReserva[item.prodId] = (itensReserva[item.prodId] || 0) + qtdUn;
    }

    if (erros.length > 0) {
      return { ok: false, erros };
    }

    const reservaDoc = {
      vendaId,
      itens:     itensReserva,
      operador:  _usuario(),
      criadaEm:  _Utils().nowISO(),
      expiraEm:  _expiracao(),
      ativa:     true,
    };

    // Atualiza cache imediatamente (otimista)
    _cacheReservas[vendaId] = reservaDoc;
    _Bus().emit('estoque:reserva_atualizada', { vendaId });

    // EstoqueRepository persiste no Firestore (best-effort — cache já está correto)
    window.CH.EstoqueRepository?.criarReserva(vendaId, reservaDoc).catch(e =>
      console.warn('[EstoqueService] criarReserva no repository falhou:', e.message)
    );

    return { ok: true, erros: [] };
  }

  /**
   * Libera a reserva de uma venda no Firestore.
   * Chamado ao rejeitar, validar ou cancelar uma venda.
   */
  async function liberarReserva(vendaId) {
    if (!vendaId) return;

    // Remove do cache imediatamente
    delete _cacheReservas[vendaId];
    _Bus().emit('estoque:reserva_atualizada', { vendaId });
    console.info(`[EstoqueService] Reserva liberada — venda ${vendaId}`);

    // EstoqueRepository persiste soft-delete no Firestore
    window.CH.EstoqueRepository?.liberarReserva(vendaId, _usuario()).catch(e =>
      console.warn('[EstoqueService] liberarReserva no repository falhou:', e.message)
    );
  }

  /**
   * Retorna o total de unidades reservadas para um produto
   * somando todas as reservas ativas do cache global.
   */
  function getQtdReservada(prodId) {
    return Object.values(_cacheReservas)
      .filter(_reservaAtiva)
      .reduce((s, r) => s + (r.itens?.[prodId] || 0), 0);
  }

  /**
   * Retorna o estoque disponível descontando reservas ativas de todos os caixas.
   */
  function getEstoqueDisponivel(prodId) {
    const prod = getProduto(prodId);
    if (!prod) return 0;
    const atual     = prod.estoqueAtual ?? prod.qtdUn ?? 0;
    const reservado = getQtdReservada(prodId);
    return Math.max(0, atual - reservado);
  }

  /** Retorna o cache atual de reservas (para diagnóstico). */
  function getReservas() { return { ..._cacheReservas }; }

  // Boot: sincroniza reservas e inicia listener
  _sincronizarReservas().then(() => _iniciarListenerReservas());

  // Alias de campos legados → modelo novo (retrocompat)
  function _normalizarProduto(p) {
    const estoqueAtual  = p.estoqueAtual ?? p.qtdUn ?? 0;
    const qtdReservada  = getQtdReservada(p.id);
    return {
      ...p,
      precoVenda:         p.precoVenda  ?? p.precoUn  ?? 0,
      precoCusto:         p.precoCusto  ?? p.custoUn  ?? 0,
      estoqueAtual,
      estoqueMinimo:      p.estoqueMinimo ?? 0,
      qtdUn:              p.qtdUn       ?? estoqueAtual,
      precoUn:            p.precoUn     ?? p.precoVenda ?? 0,
      custoUn:            p.custoUn     ?? p.precoCusto ?? 0,
      ativo:              p.ativo       ?? true,
      unidade:            p.unidade     ?? 'UN',
      qtdReservada,
      estoqueDisponivel:  Math.max(0, estoqueAtual - qtdReservada),
    };
  }

  // ════════════════════════════════════════════════════════════════
  //  PRODUTOS
  // ════════════════════════════════════════════════════════════════

  /** Retorna todos os produtos normalizados */
  function getProdutos() {
    return _Store().getEstoque().map(_normalizarProduto);
  }

  /** Retorna um produto pelo id */
  function getProduto(id) {
    const p = _Store().getEstoque().find(p => p.id === id);
    return p ? _normalizarProduto(p) : null;
  }

  /** Cria um novo produto */
  function adicionarProduto(dados) {
    const prod = {
      id:           _Utils().generateId(),
      nome:         dados.nome?.trim() || 'Produto sem nome',
      categoria:    dados.categoria    || '',
      precoVenda:   Number(dados.precoVenda  || dados.precoUn  || 0),
      precoCusto:   Number(dados.precoCusto  || dados.custoUn  || 0),
      estoqueAtual: Number(dados.estoqueAtual || dados.qtdUn   || 0),
      estoqueMinimo:Number(dados.estoqueMinimo || 0),
      qtdUn:        Number(dados.qtdUn       || dados.estoqueAtual || 0),
      precoUn:      Number(dados.precoUn     || dados.precoVenda   || 0),
      custoUn:      Number(dados.custoUn     || dados.precoCusto   || 0),
      ativo:           dados.ativo ?? true,
      controlaEstoque: dados.controlaEstoque ?? true,
      unidade:         dados.unidade || 'UN',
      fornecedorId:    dados.fornecedorId || null,
      packs:           dados.packs || [],
      createdAt:    _Utils().nowISO(),
      updatedAt:    _Utils().nowISO(),
    };

    _Store().mutateEstoque(estoque => { estoque.push(prod); });

    window.CH.AuditService?.auditarEstoque('criar', null, prod);
    _Bus().emit('estoque:adicionado', prod);
    return prod;
  }

  /** Atualiza campos de um produto existente */
  function atualizarProduto(id, campos) {
    let antes = null, depois = null;

    _Store().mutateEstoque(estoque => {
      const idx = estoque.findIndex(p => p.id === id);
      if (idx < 0) return;
      antes = { ...estoque[idx] };

      if ('precoVenda'   in campos) campos.precoUn   = campos.precoVenda;
      if ('precoCusto'   in campos) campos.custoUn   = campos.precoCusto;
      if ('estoqueAtual' in campos) campos.qtdUn     = campos.estoqueAtual;
      if ('precoUn'      in campos) campos.precoVenda = campos.precoUn;
      if ('custoUn'      in campos) campos.precoCusto = campos.custoUn;
      if ('qtdUn'        in campos) campos.estoqueAtual = campos.qtdUn;

      Object.assign(estoque[idx], campos, { updatedAt: _Utils().nowISO() });
      depois = { ...estoque[idx] };
    });

    if (!antes) { console.warn('[Estoque] atualizarProduto: id não encontrado', id); return null; }

    window.CH.AuditService?.auditarEstoque('editar', antes, depois);
    _Bus().emit('estoque:atualizado', depois);
    return depois;
  }

  /** Desativa um produto (soft delete) */
  function removerProduto(id) {
    const prod = getProduto(id);
    if (!prod) return false;
    atualizarProduto(id, { ativo: false });
    window.CH.AuditService?.auditarEstoque('deletar', prod, { ...prod, ativo: false });
    _Bus().emit('estoque:removido', prod);
    return true;
  }

  // ════════════════════════════════════════════════════════════════
  //  MOVIMENTAÇÕES — CORAÇÃO DO CONTROLE DE ESTOQUE
  // ════════════════════════════════════════════════════════════════

  /**
   * Registra uma movimentação com Firebase Transaction.
   * A transação garante que nunca haverá sobrescrita concorrente:
   *   - Lê o valor atual do documento no Firestore
   *   - Valida (não deixa ficar negativo em venda)
   *   - Subtrai/soma atomicamente
   *   - Registra a movimentação
   *
   * Se offline ou sem token, aplica localmente.
   */
  async function _registrarMovimentacao({
    produtoId,
    tipo,
    quantidade,
    origem       = 'manual',
    operador     = null,
    observacao   = '',
    custo        = null,
    fornecedorId = null,
    _forceDelta  = null,
    correlationId = null,
  }) {
    const prod = getProduto(produtoId);
    if (!prod) throw new Error(`Produto ${produtoId} não encontrado`);

    const estoqueAntes = prod.estoqueAtual ?? prod.qtdUn ?? 0;

    let delta;
    if (_forceDelta !== null) {
      delta = _forceDelta;
    } else {
      const eSaida = ['venda','avaria','transferencia'].includes(tipo);
      delta = eSaida ? -Math.abs(quantidade) : Math.abs(quantidade);
    }

    const estoqueDepois = Math.max(0, estoqueAntes + delta);
    const eSaida = delta < 0;

    // ── BLOQUEIO ABSOLUTO — valida ANTES de qualquer escrita ────────
    if (eSaida) {
      const disponivelLocal = getEstoqueDisponivel(produtoId);
      if (disponivelLocal < Math.abs(delta)) {
        const err = `[EstoqueService] BLOQUEADO — estoque insuficiente para "${prod.nome}": ` +
          `disponível ${disponivelLocal} (físico ${estoqueAntes} − reservas), ` +
          `solicitado ${Math.abs(delta)}`;
        console.error(err);
        throw new Error(
          `Estoque insuficiente para "${prod.nome}": ` +
          `disponível ${disponivelLocal}, solicitado ${Math.abs(delta)}`
        );
      }
    }

    // ── EstoqueRepository encapsula a Transaction no Firestore ──────
    const Repo = window.CH.EstoqueRepository;
    const resultado = await Repo.registrarMovimentacaoTransaction({
      produtoId, prod, tipo, delta,
      estoqueAntes, estoqueDepois,
      origem, operador: operador || _usuario(),
      observacao, custo, fornecedorId, correlationId,
    });

    if (resultado.ok) {
      // Confirma localmente após Transaction bem-sucedida (sem SyncQueue — Firestore já atualizado)
      Repo.salvarEstoqueLocal(produtoId, resultado.qtdDepois ?? estoqueDepois, true);
    } else if (resultado.localFallback) {
      // Offline ou falha de rede — aplica localmente
      console.info(`[Estoque] Modo local (${resultado.motivo || resultado.erro}): ${tipo} ${prod.nome}`);
      _movimentacaoLocal({ produtoId, prod, tipo, delta, estoqueAntes, estoqueDepois, origem, operador, observacao, custo, fornecedorId });
    } else {
      // Falha por estoque insuficiente dentro da Transaction — propaga
      throw new Error(resultado.erro);
    }

    const mov = {
      id:            _Utils().generateId(),
      produtoId,
      nomeProduto:   prod.nome,
      tipo,
      quantidade:    delta,
      estoqueAntes,
      estoqueDepois,
      origem,
      operador:      operador || _usuario(),
      observacao,
      custo:         custo ?? prod.precoCusto ?? 0,
      fornecedorId,
      correlationId: correlationId || null,
      timestamp:     _Utils().nowISO(),
      dataCurta:     _Utils().todayISO(),
    };

    _Store().mutateMovimentacoes(movs => { movs.unshift(mov); });

    window.CH.AuditService?.auditarMovimentacao(mov);
    _Bus().emit('estoque:movimentado', mov);
    return mov;
  }

  /** Aplica movimentação apenas no Store local (offline/fallback) */
  function _movimentacaoLocal({ produtoId, delta, estoqueDepois, origem }) {
    _Store().mutateEstoque(estoque => {
      const p = estoque.find(p => p.id === produtoId);
      if (p) {
        p.qtdUn        = estoqueDepois;
        p.estoqueAtual = estoqueDepois;
        p.updatedAt    = _Utils().nowISO();
      }
    });
    console.info(`[Estoque] Movimentação local (offline): ${origem}`);
  }

  // ── APIs de alto nível ───────────────────────────────────────────

  /** Entrada de mercadoria (compra de fornecedor) */
  async function entradaEstoque(produtoId, quantidade, { custo, fornecedorId, observacao } = {}) {
    return _registrarMovimentacao({
      produtoId, tipo: 'entrada', quantidade,
      origem: 'compra', custo, fornecedorId, observacao,
    });
  }

  /**
   * Baixa de estoque por venda — com Firebase Transaction.
   * Idempotente: uma segunda chamada com o mesmo vendaId não baixa de novo.
   */
  async function baixarEstoqueVenda(produtoId, quantidade, vendaId) {
    if (vendaId) {
      const origemKey = `venda:${vendaId}`;
      const jaProcessado = _Store().getMovimentacoes().some(
        m => m.origem === origemKey && m.produtoId === produtoId && m.tipo === 'venda'
      );
      if (jaProcessado) {
        console.info(`[EstoqueService] baixarEstoqueVenda ignorado — venda ${vendaId} já processada para produto ${produtoId}`);
        return null;
      }
    }
    return _registrarMovimentacao({
      produtoId, tipo: 'venda', quantidade,
      origem: `venda:${vendaId}`,
    });
  }

  /**
   * BAIXA TODOS OS ITENS DE UMA VENDA EM UMA ÚNICA TRANSACTION.
   *  - 1 leitura + 1 escrita em ch_dados/estoque (sem contention)
   *  - Sem SyncQueue intermediário entre itens (sem race condition)
   *  - Idempotente: pula produtos já processados para esta venda
   *
   * @param {object} venda  - objeto completo da venda
   * @returns {{ ok: boolean, itensProcessados: number, erros: string[] }}
   */
  async function baixarEstoqueVendaLote(venda) {
    if (!venda?.itens?.length) return { ok: true, itensProcessados: 0, erros: [] };

    const itensParaBaixar = [];
    for (const item of venda.itens) {
      const prod = getProduto(item.prodId);
      if (!prod)                          continue;
      if (prod.controlaEstoque === false) continue;

      const origemKey    = `venda:${venda.id}`;
      const jaProcessado = _Store().getMovimentacoes().some(
        m => m.origem === origemKey && m.produtoId === item.prodId && m.tipo === 'venda'
      );
      if (jaProcessado) continue;

      const pack = prod.packs?.find(pk =>
        pk.label === item.label || (pk.qtd + 'x') === item.label
      );
      const qtdUn = item.label === 'UNID'
        ? item.qtd
        : item.qtd * (pack?.qtd || 1);

      itensParaBaixar.push({ item, prod, qtdUn, origemKey });
    }

    if (itensParaBaixar.length === 0) {
      console.info(`[Estoque] Lote venda ${venda.id}: todos os itens já processados ou sem controle.`);
      return { ok: true, itensProcessados: 0, erros: [] };
    }

    // ── EstoqueRepository encapsula a Transaction ────────────────────
    const Repo      = window.CH.EstoqueRepository;
    const resultado = await Repo.baixarLote(venda, itensParaBaixar);

    if (resultado.ok || resultado.resultados?.length > 0) {
      // Confirma localmente após Transaction bem-sucedida
      for (const r of resultado.resultados || []) {
        Repo.salvarEstoqueLocal(r.produtoId, r.qtdDepois, true);
        window.CH.AuditService?.auditarMovimentacao({
          nomeProduto:   r.prod.nome,
          produtoId:     r.produtoId,
          tipo:          'venda',
          quantidade:    -r.qtdUn,
          estoqueAntes:  r.qtdAntes,
          estoqueDepois: r.qtdDepois,
          origem:        r.origemKey,
          vendaId:       venda.id,
          correlationId: venda.correlationId || null,
        });
      }
    }

    if (resultado.localFallback) {
      // Offline ou falha de rede — aplica localmente
      _baixarLoteLocal(venda, itensParaBaixar);
    }

    return {
      ok:               resultado.ok,
      localFallback:    resultado.localFallback || false,
      itensProcessados: (resultado.resultados?.length || 0) + (resultado.localFallback ? itensParaBaixar.length : 0),
      erros:            resultado.erros || [],
    };
  }


  /** Baixa local de todos os itens (fallback offline) */
  function _baixarLoteLocal(venda, itensParaBaixar) {
    const agora = new Date();
    _Store().mutateEstoque(estoque => {
      for (const { item, prod, qtdUn, origemKey } of itensParaBaixar) {
        const p = estoque.find(x => x.id === item.prodId);
        if (!p) continue;
        const qtdAntes = p.qtdUn ?? p.estoqueAtual ?? 0;

        // ── BLOQUEIO ABSOLUTO offline ────────────────────────────────
        // Nunca permite estoque negativo mesmo sem Firebase.
        // Desconta reservas de outras vendas pendentes.
        const reservado  = getQtdReservada(item.prodId);
        const disponivel = Math.max(0, qtdAntes - reservado);
        if (disponivel < qtdUn) {
          console.error(
            `[EstoqueService] BLOQUEADO offline — "${prod.nome}": ` +
            `disponível ${disponivel} (físico ${qtdAntes} − ${reservado} reservados), ` +
            `solicitado ${qtdUn}. Item ignorado na baixa local.`
          );
          _Bus().emit('estoque:bloqueio_negativo', {
            produtoId:  item.prodId,
            nomeProduto: prod.nome,
            disponivel,
            solicitado: qtdUn,
            vendaId:    venda.id,
            correlationId: venda.correlationId || null,
          });
          continue; // pula — não baixa, não registra, não vai a zero
        }

        const qtdDepois = qtdAntes - qtdUn; // garantido >= 0 pela validação acima
        p.qtdUn = qtdDepois; p.estoqueAtual = qtdDepois; p.updatedAt = _Utils().nowISO();

        _Store().mutateMovimentacoes(movs => {
          movs.unshift({
            id: _Utils().generateId(), produtoId: item.prodId, nomeProduto: prod.nome,
            tipo: 'venda', quantidade: -qtdUn, estoqueAntes: qtdAntes, estoqueDepois: qtdDepois,
            origem: origemKey, operador: venda.operador || _usuario(),
            correlationId: venda.correlationId || null,
            timestamp: agora.toISOString(), dataCurta: _Utils().todayISO(),
          });
        });

        window.CH.AuditService?.auditarMovimentacao({
          nomeProduto:   prod.nome,
          produtoId:     item.prodId,
          tipo:          'venda',
          quantidade:    -qtdUn,
          estoqueAntes:  qtdAntes,
          estoqueDepois: qtdDepois,
          origem:        origemKey,
          vendaId:       venda.id,
          correlationId: venda.correlationId || null,
        });
      }
    });
    console.info(`[Estoque] Lote local aplicado: ${itensParaBaixar.length} itens (venda ${venda.id})`);
  }

  /** Registra avaria/perda */
  async function registrarAvaria(produtoId, quantidade, observacao = '') {
    return _registrarMovimentacao({
      produtoId, tipo: 'avaria', quantidade, origem: 'avaria', observacao,
    });
  }

  /**
   * Ajuste de inventário — define a quantidade exata.
   * Calcula o delta entre o valor atual e o novo valor.
   */
  async function ajustarEstoque(produtoId, novaQuantidade, observacao = 'Ajuste de inventário') {
    const prod = getProduto(produtoId);
    if (!prod) throw new Error(`Produto ${produtoId} não encontrado`);

    const atual = prod.estoqueAtual ?? prod.qtdUn ?? 0;
    const diff  = novaQuantidade - atual;
    if (diff === 0) return null;

    return _registrarMovimentacao({
      produtoId,
      tipo:        'ajuste',
      quantidade:  Math.abs(diff),
      origem:      'inventario',
      observacao,
      _forceDelta: diff,
    });
  }

  /** Cancelamento de venda — estorna o estoque */
  async function cancelarVenda(vendaId, itens) {
    const movs = [];
    for (const item of itens) {
      const _prod = getProduto(item.prodId);
      const _pack = _prod?.packs?.find(pk =>
        pk.label === item.label || (pk.qtd + 'x') === item.label
      );
      const qtd = item.label === 'UNID'
        ? item.qtd
        : item.qtd * (_pack?.qtd || 1);
      const mov = await _registrarMovimentacao({
        produtoId:  item.prodId,
        tipo:       'cancelamento',
        quantidade: qtd,
        origem:     `cancelamento:${vendaId}`,
        observacao: `Cancelamento da venda ${vendaId}`,
      });
      movs.push(mov);
    }
    return movs;
  }

  // ── Consultas de movimentações ────────────────────────────────────
  function getMovimentacoes({ produtoId, tipo, dataDe, dataAte, limit = 500 } = {}) {
    let movs = _Store().getMovimentacoes();
    if (produtoId) movs = movs.filter(m => m.produtoId === produtoId);
    if (tipo)      movs = movs.filter(m => m.tipo      === tipo);
    if (dataDe)    movs = movs.filter(m => m.dataCurta >= dataDe);
    if (dataAte)   movs = movs.filter(m => m.dataCurta <= dataAte);
    return movs.slice(0, limit);
  }

  function getMovimentacoesHoje() {
    return getMovimentacoes({ dataDe: _Utils().todayISO(), dataAte: _Utils().todayISO() });
  }

  // ── Alertas ───────────────────────────────────────────────────────
  function getProdutosAbaixoMinimo() {
    const thr = _Store().getConfig()?.alertaEstoque || window.CH.CONSTANTS.LOW_STOCK;
    return getProdutos().filter(p => p.ativo && (p.estoqueAtual ?? p.qtdUn ?? 0) <= (p.estoqueMinimo || thr));
  }

  function getProdutosSemEstoque() {
    return getProdutos().filter(p => p.ativo && (p.estoqueAtual ?? p.qtdUn ?? 0) <= 0);
  }

  // ── Valorização do estoque ────────────────────────────────────────
  function getValorizacao() {
    const prods = getProdutos().filter(p => p.ativo);
    const custo = prods.reduce((s, p) => s + (p.precoCusto || p.custoUn || 0) * (p.estoqueAtual || p.qtdUn || 0), 0);
    const venda = prods.reduce((s, p) => s + (p.precoVenda || p.precoUn  || 0) * (p.estoqueAtual || p.qtdUn || 0), 0);
    return { custo, venda, margem: venda - custo };
  }

  // ════════════════════════════════════════════════════════════════
  //  CATEGORIAS
  // ════════════════════════════════════════════════════════════════

  function getCategorias() { return _Store().getCategorias(); }

  function adicionarCategoria(nome, cor = '#6b7280') {
    const cat = { id: _Utils().generateId(), nome: nome.trim(), cor, createdAt: _Utils().nowISO() };
    _Store().mutateCategorias(cats => { cats.push(cat); });
    return cat;
  }

  function removerCategoria(id) {
    _Store().mutateCategorias(cats => {
      const idx = cats.findIndex(c => c.id === id);
      if (idx >= 0) cats.splice(idx, 1);
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  FORNECEDORES
  // ════════════════════════════════════════════════════════════════

  function getFornecedores() { return _Store().getFornecedores(); }
  function getFornecedor(id) { return _Store().getFornecedores().find(f => f.id === id) || null; }

  function adicionarFornecedor({ nome, telefone = '', email = '', cnpj = '', observacao = '' }) {
    const forn = {
      id: _Utils().generateId(), nome: nome.trim(), telefone, email, cnpj, observacao,
      ativo: true, createdAt: _Utils().nowISO(),
    };
    _Store().mutateFornecedores(forns => { forns.push(forn); });
    return forn;
  }

  function atualizarFornecedor(id, campos) {
    _Store().mutateFornecedores(forns => {
      const f = forns.find(f => f.id === id);
      if (f) Object.assign(f, campos, { updatedAt: _Utils().nowISO() });
    });
  }

  // ── Reconciliação manual ─────────────────────────────────────────
  /**
   * Reconciliação completa: varre todas as vendas do dia e verifica
   * se cada uma teve o estoque baixado. Corrige automaticamente as que falharam.
   * Retorna relatório { verificadas, corrigidas, falhas, detalhes[] }
   */
  async function reconciliarEstoque(vendas) {
    const _tok = FirebaseService.getAdminToken?.();
    if (!_tok || !FirebaseService.isReady()) {
      return { ok: false, motivo: 'Sem adminToken ou Firebase offline' };
    }

    const alvo = vendas || _Store().getVendas().filter(v =>
      v.dataCurta === _Utils().todayISO() &&
      ['concluida', 'validada'].includes(v.status)
    );

    const relatorio = { verificadas: 0, corrigidas: 0, falhas: 0, detalhes: [] };

    for (const venda of alvo) {
      if (!venda.itens?.length) continue;
      relatorio.verificadas++;

      try {
        const movs = await FirebaseService.queryCollection('movimentacoes',
          [['origem', '==', `venda:${venda.id}`]]
        );

        if (movs && movs.length > 0) {
          relatorio.detalhes.push({ vendaId: venda.id, status: 'ok', msg: 'Movimentação já existe' });
          continue;
        }

        console.warn(`[Estoque] Reconciliação: venda ${venda.id} sem movimentação, corrigindo...`);
        try {
          const resCorr = await baixarEstoqueVendaLote(venda);
          if (resCorr.ok || resCorr.itensProcessados > 0) {
            relatorio.corrigidas++;
            relatorio.detalhes.push({ vendaId: venda.id, status: 'corrigido', msg: `${resCorr.itensProcessados} itens ajustados` });
          } else {
            relatorio.falhas++;
            relatorio.detalhes.push({ vendaId: venda.id, status: 'falhou', msg: resCorr.erros?.join('; ') || 'Baixa falhou' });
          }
        } catch (eLote) {
          relatorio.falhas++;
          relatorio.detalhes.push({ vendaId: venda.id, status: 'falhou', msg: eLote.message });
        }

      } catch (e) {
        relatorio.falhas++;
        relatorio.detalhes.push({ vendaId: venda.id, status: 'falhou', msg: e.message });
      }
    }

    try {
      const msg =
        `🔄 <b>Reconciliação de Estoque — CH Geladas</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `✅ <b>Verificadas:</b> ${relatorio.verificadas}\n` +
        `🔧 <b>Corrigidas:</b> ${relatorio.corrigidas}\n` +
        `❌ <b>Falhas:</b> ${relatorio.falhas}\n` +
        `🕐 ${new Date().toLocaleString('pt-BR')}` +
        (relatorio.falhas > 0 ? '\n\n⚠️ Algumas vendas não puderam ser corrigidas. Verifique manualmente.' : '');
      window.CH?.TelegramService?.enviar?.(msg);
    } catch (_) {}

    console.info('[Estoque] Reconciliação concluída:', relatorio);
    return relatorio;
  }

  /** Retorna lista de falhas registradas localmente */
  function getFalhasEstoque() {
    try { return JSON.parse(localStorage.getItem('CH_FALHAS_ESTOQUE') || '[]'); } catch(_) { return []; }
  }

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.EstoqueService = {
    // Produtos
    getProdutos,
    getProduto,
    adicionarProduto,
    atualizarProduto,
    removerProduto,

    // Movimentações
    entradaEstoque,
    baixarEstoqueVenda,
    registrarAvaria,
    ajustarEstoque,
    cancelarVenda,
    getMovimentacoes,
    getMovimentacoesHoje,

    // Reserva de Estoque (anti-paradoxo)
    reservarEstoque,
    liberarReserva,
    getQtdReservada,
    getEstoqueDisponivel,
    getReservas,

    // Alertas
    getProdutosAbaixoMinimo,
    getProdutosSemEstoque,
    getValorizacao,

    // Categorias
    getCategorias,
    adicionarCategoria,
    removerCategoria,

    // Fornecedores
    getFornecedores,
    getFornecedor,
    adicionarFornecedor,
    atualizarFornecedor,

    // Baixa em lote (todos os itens de uma venda em 1 transaction)
    baixarEstoqueVendaLote,

    // Reconciliação e auditoria de estoque
    reconciliarEstoque,
    getFalhasEstoque,
  };

  console.info('%c EstoqueService ✓  (Transactions + Movimentações + Reserva de Estoque)', 'color:#10b981');
})();
