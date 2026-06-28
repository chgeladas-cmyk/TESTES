'use strict';
/**
 * repositories/EstoqueRepository.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Camada de acesso a dados para Estoque.
 *
 * RESPONSABILIDADE:
 *   Encapsula TODA comunicação com o Firestore relativa a estoque:
 *   - Firebase Transactions em ch_dados/estoque
 *   - Documentos de movimentação (movimentacoes/{id})
 *   - Reservas globais (reservasEstoque/{vendaId})
 *
 *   O estoqueService chama este repository — não FirebaseService diretamente.
 *
 * CONTRATO PÚBLICO:
 *   executarTransactionEstoque(fn)           → Transaction genérica em ch_dados/estoque
 *   baixarLote(venda, itensParaBaixar)       → Transaction de baixa de todos os itens
 *   registrarMovimentacaoTransaction(opts)   → Transaction de movimentação unitária
 *   salvarMovimentacaoLocal(mov)             → persiste movimentação só no Store
 *   salvarEstoqueLocal(produtoId, novaQtd)   → atualiza estoque só no Store
 *   criarReserva(vendaId, reservaDoc)        → persiste reserva no Firestore
 *   liberarReserva(vendaId)                  → soft-delete de reserva no Firestore
 *   lerReservas()                            → lê reservas ativas do Firestore
 *   lerEstoque()                             → lê estoque do Firestore
 *
 * INVARIANTES:
 *   - Nunca modifica Store diretamente — devolve dados ao service
 *   - Todas as Transactions validam estoque antes de subtrair
 *   - Soft-delete em reservas (ativa:false), nunca hard-delete
 *
 * Requer: core.js + firebaseService.js carregados antes.
 */

(function () {
  function _Store()    { return window.CH.Store; }
  function _Utils()    { return window.CH.Utils; }
  function _Firebase() { return window.CH.FirebaseService; }

  function _isOnline()  { return navigator.onLine; }
  function _tok()       { return _Firebase().getAdminToken?.(); }

  function _pronto() {
    return _isOnline() && _Firebase().isReady() && !!_tok();
  }

  // ── Estoque — Firebase Transactions ──────────────────────────────

  /**
   * Executa uma Transaction genérica em ch_dados/estoque.
   * O callback recebe (tx, dadosFB) e deve retornar os dados modificados.
   *
   * @param {function} fn - async (tx, dadosFB: object[]) => object[]
   * @returns {Promise<{ ok: boolean, dados?: object[], erro?: string }>}
   */
  async function executarTransactionEstoque(fn) {
    if (!_pronto()) {
      return { ok: false, motivo: _motivoOffline() };
    }
    try {
      let dadosResultado;
      await _Firebase().runTransaction(async (tx) => {
        const ref  = _Firebase().docRef('ch_dados', 'estoque');
        const snap = await tx.get(ref);
        const dadosFB = snap.exists() ? (snap.data().dados || []) : [];

        dadosResultado = await fn(tx, dadosFB, ref);

        if (dadosResultado !== undefined) {
          tx.set(ref, {
            dados:      dadosResultado,
            ts:         _Utils().nowISO(),
            adminToken: _tok(),
          });
        }
      });
      return { ok: true, dados: dadosResultado };
    } catch (e) {
      console.warn('[EstoqueRepository] Transaction falhou:', e.message);
      return { ok: false, erro: e.message };
    }
  }

  /**
   * Baixa todos os itens de uma venda em UMA única Transaction.
   * Lê ch_dados/estoque uma vez, valida e subtrai todos os itens atomicamente,
   * cria documentos movimentacoes/{id} dentro da mesma Transaction.
   *
   * @param {object} venda
   * @param {Array<{item, prod, qtdUn, origemKey}>} itensParaBaixar
   * @returns {Promise<{
   *   ok: boolean,
   *   resultados: Array<{produtoId, prod, qtdAntes, qtdDepois, qtdUn, origemKey}>,
   *   erros: string[],
   *   localFallback?: boolean,
   *   motivo?: string
   * }>}
   */
  async function baixarLote(venda, itensParaBaixar) {
    if (!_pronto()) {
      return {
        ok: false,
        localFallback: true,
        motivo: _motivoOffline(),
        resultados: [],
        erros: [_motivoOffline()],
      };
    }

    const erros      = [];
    let   resultados = [];

    try {
      await _Firebase().runTransaction(async (tx) => {
        const estoqueRef = _Firebase().docRef('ch_dados', 'estoque');
        const snap       = await tx.get(estoqueRef);
        const dadosFB    = snap.exists() ? (snap.data().dados || []) : [];
        const dadosMapa  = new Map(dadosFB.map(p => [p.id, { ...p }]));

        resultados = [];

        for (const { item, prod, qtdUn, origemKey } of itensParaBaixar) {
          const prodFB   = dadosMapa.get(item.prodId) || prod;
          const qtdAtual = prodFB.qtdUn ?? prodFB.estoqueAtual ?? 0;

          if (qtdAtual < qtdUn) {
            erros.push(`"${prod.nome}": insuficiente (${qtdAtual} disponível, ${qtdUn} solicitado)`);
            console.warn(`[EstoqueRepository] ${prod.nome} insuficiente — pulando`);
            continue;
          }

          const novaQtd = Math.max(0, qtdAtual - qtdUn);
          dadosMapa.set(item.prodId, {
            ...prodFB,
            qtdUn:        novaQtd,
            estoqueAtual: novaQtd,
            updatedAt:    _Utils().nowISO(),
          });
          resultados.push({
            produtoId: item.prodId,
            prod,
            qtdAntes:  qtdAtual,
            qtdDepois: novaQtd,
            qtdUn,
            origemKey,
          });
        }

        if (resultados.length === 0) return;

        // Escrita atômica do estoque
        tx.set(estoqueRef, {
          dados:      [...dadosMapa.values()],
          ts:         _Utils().nowISO(),
          adminToken: _tok(),
        });

        // Criação dos documentos de movimentação
        for (const r of resultados) {
          const movRef = _Firebase().newDocRef('movimentacoes');
          tx.set(movRef, {
            id:            movRef.id,
            produtoId:     r.produtoId,
            nomeProduto:   r.prod.nome,
            tipo:          'venda',
            quantidade:    -r.qtdUn,
            estoqueAntes:  r.qtdAntes,
            estoqueDepois: r.qtdDepois,
            origem:        r.origemKey,
            operador:      venda.operador || '',
            vendaId:       venda.id,
            correlationId: venda.correlationId || null,
            timestamp:     _Utils().nowISO(),
            dataCurta:     _Utils().todayISO(),
            adminToken:    _tok(),
          });
        }
      });

      console.info(`[EstoqueRepository] ✓ Lote venda ${venda.id}: ${resultados.length} item(ns)`);
      return { ok: true, resultados, erros };

    } catch (e) {
      console.warn('[EstoqueRepository] Lote transaction falhou:', e.message);
      return { ok: false, localFallback: true, resultados: [], erros: [e.message] };
    }
  }

  /**
   * Transaction de movimentação unitária (entrada, avaria, ajuste, cancelamento).
   * Valida disponibilidade dentro da Transaction antes de subtrair.
   *
   * @returns {Promise<{
   *   ok: boolean,
   *   qtdAntes?: number,
   *   qtdDepois?: number,
   *   movRefId?: string,
   *   localFallback?: boolean,
   *   erro?: string
   * }>}
   */
  async function registrarMovimentacaoTransaction({
    produtoId,
    prod,
    tipo,
    delta,
    estoqueAntes,
    estoqueDepois,
    origem,
    operador,
    observacao,
    custo,
    fornecedorId,
    correlationId,
  }) {
    if (!_pronto()) {
      return { ok: false, localFallback: true, motivo: _motivoOffline() };
    }

    const eSaida = delta < 0;

    try {
      let qtdFinal, movRefId;

      await _Firebase().runTransaction(async (tx) => {
        const estoqueRef = _Firebase().docRef('ch_dados', 'estoque');
        const snap       = await tx.get(estoqueRef);
        const dadosFB    = snap.exists() ? (snap.data().dados || []) : [];

        const prodFB     = dadosFB.find(p => p.id === produtoId);
        const qtdAtualFB = prodFB ? (prodFB.qtdUn ?? prodFB.estoqueAtual ?? 0) : estoqueAntes;

        // Validação dentro da Transaction (segunda camada — após validação local no service)
        if (eSaida && qtdAtualFB < Math.abs(delta)) {
          throw new Error(
            `Estoque insuficiente para "${prod.nome}": ` +
            `disponível ${qtdAtualFB}, solicitado ${Math.abs(delta)}`
          );
        }

        qtdFinal = Math.max(0, qtdAtualFB + delta);

        const novosDados = dadosFB.map(p =>
          p.id === produtoId
            ? { ...p, qtdUn: qtdFinal, estoqueAtual: qtdFinal, updatedAt: _Utils().nowISO() }
            : p
        );
        if (!prodFB) novosDados.push({ ...prod, qtdUn: qtdFinal, estoqueAtual: qtdFinal });

        tx.set(estoqueRef, {
          dados:      novosDados,
          ts:         _Utils().nowISO(),
          adminToken: _tok(),
        });

        const movRef = _Firebase().newDocRef('movimentacoes');
        movRefId = movRef.id;
        tx.set(movRef, {
          id:            movRef.id,
          produtoId,
          nomeProduto:   prod.nome,
          tipo,
          quantidade:    delta,
          estoqueAntes:  qtdAtualFB,
          estoqueDepois: qtdFinal,
          origem,
          operador:      operador || '',
          observacao:    observacao || '',
          custo:         custo ?? prod.precoCusto ?? 0,
          fornecedorId:  fornecedorId || null,
          correlationId: correlationId || null,
          timestamp:     _Utils().nowISO(),
          dataCurta:     _Utils().todayISO(),
          adminToken:    _tok(),
        });
      });

      console.info(`[EstoqueRepository] ✓ Transaction ${tipo}: ${prod.nome} (${estoqueAntes}→${qtdFinal})`);
      return { ok: true, qtdAntes: estoqueAntes, qtdDepois: qtdFinal, movRefId };

    } catch (e) {
      if (e.message?.includes('insuficiente')) throw e; // propaga — não é problema de rede
      console.warn(`[EstoqueRepository] Transaction falhou, aplicando local: ${e.message}`);
      return { ok: false, localFallback: true, erro: e.message };
    }
  }

  // ── Estoque — operações locais (offline/fallback) ─────────────────

  /**
   * Atualiza a quantidade de um produto apenas no Store local.
   * Usado como confirmação pós-Transaction ou em modo offline.
   * NÃO enfileira sync — a Transaction já escreveu no Firebase.
   *
   * @param {string} produtoId
   * @param {number} novaQtd
   * @param {boolean} semSync - true = não enfileira SyncQueue
   */
  function salvarEstoqueLocal(produtoId, novaQtd, semSync = false) {
    _Store().mutateEstoque(estoque => {
      const p = estoque.find(p => p.id === produtoId);
      if (p) {
        p.qtdUn        = novaQtd;
        p.estoqueAtual = novaQtd;
        p.updatedAt    = _Utils().nowISO();
      }
    }, semSync ? { _semSync: true } : undefined);
  }

  /**
   * Persiste uma movimentação apenas no Store local.
   * Usado em modo offline e como complemento após Transaction Firebase.
   *
   * @param {object} mov
   */
  function salvarMovimentacaoLocal(mov) {
    _Store().mutateMovimentacoes(movs => { movs.unshift(mov); });
  }

  // ── Estoque — leitura ─────────────────────────────────────────────

  /**
   * Lê o estoque do Firestore.
   * @returns {Promise<object[]|null>}
   */
  async function lerEstoque() {
    if (!_isOnline() || !_Firebase().isReady()) return null;
    try {
      return await _Firebase().ler('estoque');
    } catch (e) {
      console.warn('[EstoqueRepository] lerEstoque falhou:', e.message);
      return null;
    }
  }

  // ── Reservas — Firestore ──────────────────────────────────────────

  /**
   * Persiste um documento de reserva no Firestore.
   * O cache em memória deve ser atualizado pelo service antes desta chamada.
   *
   * @param {string} vendaId
   * @param {object} reservaDoc
   */
  async function criarReserva(vendaId, reservaDoc) {
    if (!_isOnline() || !_Firebase().isReady()) {
      console.info('[EstoqueRepository] criarReserva: offline — reserva apenas em cache');
      return { ok: false, motivo: 'offline' };
    }
    try {
      const ref   = _Firebase().docRef('reservasEstoque', vendaId);
      const batch = _Firebase().getBatch();
      batch.set(ref, reservaDoc);
      await batch.commit();
      console.info(`[EstoqueRepository] ✓ Reserva criada — venda ${vendaId}`);
      return { ok: true };
    } catch (e) {
      console.warn('[EstoqueRepository] criarReserva falhou:', e.message);
      return { ok: false, erro: e.message };
    }
  }

  /**
   * Soft-delete de reserva no Firestore (ativa: false).
   *
   * @param {string} vendaId
   * @param {string} operador
   */
  async function liberarReserva(vendaId, operador) {
    if (!_isOnline() || !_Firebase().isReady()) {
      console.info('[EstoqueRepository] liberarReserva: offline — liberação apenas em cache');
      return { ok: false, motivo: 'offline' };
    }
    try {
      const ref   = _Firebase().docRef('reservasEstoque', vendaId);
      const batch = _Firebase().getBatch();
      batch.set(ref, {
        vendaId,
        itens:      {},
        ativa:      false,
        liberadaEm: _Utils().nowISO(),
        operador:   operador || '',
      });
      await batch.commit();
      console.info(`[EstoqueRepository] ✓ Reserva liberada — venda ${vendaId}`);
      return { ok: true };
    } catch (e) {
      console.warn('[EstoqueRepository] liberarReserva falhou:', e.message);
      return { ok: false, erro: e.message };
    }
  }

  /**
   * Lê todas as reservas ativas do Firestore.
   * Retorna array de documentos reservasEstoque.
   *
   * @returns {Promise<object[]>}
   */
  async function lerReservas() {
    if (!_isOnline() || !_Firebase().isReady()) return [];
    try {
      const dados = await _Firebase().ler('reservasEstoque');
      return Array.isArray(dados) ? dados : [];
    } catch (e) {
      console.warn('[EstoqueRepository] lerReservas falhou:', e.message);
      return [];
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  function _motivoOffline() {
    if (!_isOnline())              return 'offline';
    if (!_Firebase().isReady())   return 'Firebase não pronto';
    if (!_tok())                  return 'sem adminToken';
    return 'indisponível';
  }

  // ── Exportar ──────────────────────────────────────────────────────
  window.CH.EstoqueRepository = {
    // Transactions
    executarTransactionEstoque,
    baixarLote,
    registrarMovimentacaoTransaction,
    // Operações locais
    salvarEstoqueLocal,
    salvarMovimentacaoLocal,
    // Leitura
    lerEstoque,
    // Reservas
    criarReserva,
    liberarReserva,
    lerReservas,
  };

  console.info('%c EstoqueRepository ✓', 'color:#10b981;font-weight:bold');
})();
