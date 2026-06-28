'use strict';
/**
 * services/auditService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Auditoria forense completa de todas as operações do sistema.
 *
 * Modelo de cada registro:
 *   {
 *     id:            string
 *     acao:          string   ('criar'|'editar'|'deletar'|'venda'|'cancelar'|
 *                              'aprovar'|'rejeitar'|'validar'|'movimentacao'|
 *                              'login'|'receita'|'despesa'|'estorno')
 *     modulo:        string   ('estoque'|'vendas'|'financeiro'|'auth'|'aprovacao')
 *     usuario:       string   nome do operador
 *     role:          string   ('admin'|'gerente'|'colaborador'|...)
 *     motivo:        string?  razão da operação (rejeição, cancelamento, ajuste...)
 *     antes:         object?  estado ANTES da operação (snapshot forense)
 *     depois:        object?  estado DEPOIS da operação (snapshot forense)
 *     delta:         object?  diferença calculada entre antes e depois
 *     resumo:        string   descrição legível para humanos
 *     correlationId: string?  rastreia cadeia venda→estoque→financeiro→auditoria
 *     origem:        string?  'PDV'|'aprovacao'|'avulsa'|'fiado'|'cambio'|'sistema'
 *     data:          string   ISO 8601
 *     dataCurta:     string   YYYY-MM-DD
 *     hora:          string   HH:MM
 *     device:        string   plataforma do operador
 *   }
 *
 * Requer: core.js carregado antes (window.CH disponível)
 */

(function () {
  function _Store()    { return window.CH.Store; }
  function _Auth()     { return window.CH.AuthService; }
  function _Utils()    { return window.CH.Utils; }
  function _Bus()      { return window.CH.EventBus; }

  // ── Device fingerprint (sem dados pessoais) ──────────────────────
  function _getDevice() {
    const ua = navigator.userAgent;
    if (/Android/i.test(ua))    return 'Android';
    if (/iPhone|iPad/i.test(ua)) return 'iOS';
    if (/Windows/i.test(ua))    return 'Windows';
    if (/Mac/i.test(ua))        return 'macOS';
    if (/Linux/i.test(ua))      return 'Linux';
    return 'Desconhecido';
  }

  // ── Calcula delta entre dois snapshots ───────────────────────────
  // Retorna apenas os campos que mudaram: { campo: { de, para } }
  function _calcularDelta(antes, depois) {
    if (!antes || !depois) return null;
    const delta = {};
    const chaves = new Set([...Object.keys(antes), ...Object.keys(depois)]);
    for (const k of chaves) {
      if (k.startsWith('_')) continue; // ignora campos internos
      const a = antes[k], d = depois[k];
      if (JSON.stringify(a) !== JSON.stringify(d)) {
        delta[k] = { de: a ?? null, para: d ?? null };
      }
    }
    return Object.keys(delta).length > 0 ? delta : null;
  }

  // ── Registrar ────────────────────────────────────────────────────
  /**
   * Função base de auditoria forense.
   * @param {string} acao    - tipo da operação
   * @param {string} modulo  - módulo do sistema
   * @param {object} opts    - { antes, depois, motivo, resumo, correlationId, origem, extra }
   */
  function registrar(acao, modulo, opts = {}) {
    const {
      antes         = null,
      depois        = null,
      motivo        = null,
      resumo        = '',
      correlationId = null,
      origem        = null,
      extra         = {},
    } = opts;

    const antesClean  = antes  ? _sanitize(antes)  : null;
    const depoisClean = depois ? _sanitize(depois) : null;

    const reg = {
      id:            _Utils().generateId(),
      acao,
      modulo,
      usuario:       _Auth().getNome(),
      role:          _Auth().getRole() || 'desconhecido',
      motivo:        motivo || null,
      antes:         antesClean,
      depois:        depoisClean,
      delta:         _calcularDelta(antesClean, depoisClean),
      resumo:        resumo || `${acao} em ${modulo}`,
      correlationId: correlationId || extra.correlationId || null,
      origem:        origem || extra.origem || null,
      data:          _Utils().nowISO(),
      dataCurta:     _Utils().todayISO(),
      hora:          _Utils().nowTime(),
      device:        _getDevice(),
    };

    _Store().mutateAuditoria(audit => { audit.unshift(reg); });
    _Bus().emit('auditoria:registrada', reg);
    return reg;
  }

  // ── Auditoria de Estoque ─────────────────────────────────────────

  /**
   * Audita criação, edição ou remoção de produto.
   * antes e depois são objetos produto completos.
   */
  function auditarEstoque(acao, produtoAntes, produtoDepois, motivo = '') {
    const antes  = produtoAntes  ? _produtoResumido(produtoAntes)  : null;
    const depois = produtoDepois ? _produtoResumido(produtoDepois) : null;
    return registrar(acao, 'estoque', {
      antes,
      depois,
      motivo:  motivo || null,
      resumo:  _resumoEstoque(acao, antes, depois),
      origem:  'sistema',
    });
  }

  /**
   * Audita uma movimentação de estoque (venda, entrada, avaria, ajuste, cancelamento).
   * Registra antes, depois, quantidade, origem e motivo de forma forense.
   */
  function auditarMovimentacao(mov) {
    // Extrai vendaId de origens como 'venda:<id>' ou 'cancelamento:<id>'
    let vendaId = mov.vendaId || null;
    if (!vendaId && mov.origem) {
      if (mov.origem.startsWith('venda:'))             vendaId = mov.origem.slice('venda:'.length);
      else if (mov.origem.startsWith('cancelamento:')) vendaId = mov.origem.slice('cancelamento:'.length);
    }

    // Motivo legível por tipo de movimentação
    const _motivos = {
      venda:         vendaId ? `Venda ${vendaId}` : 'Venda PDV',
      entrada:       mov.fornecedorId ? `Compra fornecedor ${mov.fornecedorId}` : 'Entrada de mercadoria',
      avaria:        mov.observacao   || 'Avaria/perda registrada',
      ajuste:        mov.observacao   || 'Ajuste de inventário',
      cancelamento:  vendaId ? `Cancelamento venda ${vendaId}` : 'Cancelamento',
      estorno:       vendaId ? `Estorno venda ${vendaId}` : 'Estorno',
      transferencia: mov.observacao   || 'Transferência',
    };

    return registrar('movimentacao', 'estoque', {
      antes: {
        produto:      mov.nomeProduto,
        produtoId:    mov.produtoId || null,
        estoqueAtual: mov.estoqueAntes,
      },
      depois: {
        produto:      mov.nomeProduto,
        produtoId:    mov.produtoId || null,
        estoqueAtual: mov.estoqueDepois,
        quantidade:   mov.quantidade,
        tipo:         mov.tipo,
        origem:       mov.origem || null,
        vendaId,
      },
      motivo:        _motivos[mov.tipo] || mov.tipo,
      resumo:        `${mov.tipo} ${Math.abs(mov.quantidade)} un. — ${mov.nomeProduto} (${mov.estoqueAntes}→${mov.estoqueDepois})`,
      correlationId: mov.correlationId || null,
      origem:        vendaId ? 'venda' : (mov.origem || 'sistema'),
    });
  }

  // ── Auditoria de Vendas ──────────────────────────────────────────

  /**
   * Audita finalização de uma venda.
   * 'antes' é null pois a venda não existia. 'depois' é o snapshot completo.
   */
  function auditarVenda(venda) {
    return registrar('venda', 'vendas', {
      antes: null,
      depois: {
        id:        venda.id,
        status:    venda.status,
        total:     venda.total,
        lucro:     venda.lucro || 0,
        formaPgto: venda.formaPgto,
        operador:  venda.operador,
        itens:     (venda.itens || []).map(i => ({
          nome: i.nome, qtd: i.qtd, preco: i.preco,
        })),
      },
      motivo:        venda.status === 'pendente' ? 'Aguarda aprovação' : 'Venda direta',
      resumo:        `Venda ${_Utils().formatCurrency(venda.total)} — ${venda.formaPgto} — ${venda.itens?.length || 0} item(ns) [${venda.status}]`,
      correlationId: venda.correlationId || null,
      origem:        venda.origem || 'PDV',
    });
  }

  /**
   * Audita mudança de status de venda no fluxo de aprovação.
   * Registra o estado ANTES e DEPOIS com o motivo da mudança.
   */
  function auditarMudancaStatus(vendaAntes, statusDepois, motivo = '') {
    return registrar(statusDepois, 'aprovacao', {
      antes: {
        id:        vendaAntes.id,
        status:    vendaAntes.status,
        operador:  vendaAntes.operador,
        total:     vendaAntes.total,
      },
      depois: {
        id:        vendaAntes.id,
        status:    statusDepois,
        operador:  _Auth().getNome(),
        total:     vendaAntes.total,
      },
      motivo:        motivo || `Status alterado de "${vendaAntes.status}" para "${statusDepois}"`,
      resumo:        `Venda ${vendaAntes.id.slice(-6)} — ${vendaAntes.status} → ${statusDepois}${motivo ? ' — ' + motivo : ''}`,
      correlationId: vendaAntes.correlationId || null,
      origem:        'aprovacao',
    });
  }

  /**
   * Audita cancelamento de venda.
   * Registra o snapshot completo da venda antes do cancelamento.
   */
  function auditarCancelamento(venda, motivo = '') {
    return registrar('cancelar', 'vendas', {
      antes: {
        id:        venda.id,
        status:    venda.status,
        total:     venda.total,
        operador:  venda.operador,
        itens:     (venda.itens || []).map(i => ({ nome: i.nome, qtd: i.qtd, preco: i.preco })),
      },
      depois: {
        id:        venda.id,
        status:    'cancelada',
        canceladoPor: _Auth().getNome(),
        canceladaEm:  _Utils().nowISO(),
      },
      motivo:        motivo || 'Cancelamento operacional',
      resumo:        `Venda ${_Utils().formatCurrency(venda.total)} cancelada por ${_Auth().getNome()}${motivo ? ' — ' + motivo : ''}`,
      correlationId: venda.correlationId || null,
      origem:        'PDV',
    });
  }

  // ── Auditoria Financeira ─────────────────────────────────────────

  /**
   * Audita um lançamento financeiro (receita, despesa, estorno).
   * 'antes' é o saldo do dia antes do lançamento.
   * 'depois' é o lançamento criado.
   */
  function auditarFinanceiro(lancamento, saldoAntesDia = null) {
    const _tipoLabel = {
      receita: 'Receita',
      despesa: 'Despesa',
      estorno: 'Estorno',
    };
    return registrar(lancamento.tipo || 'lancamento', 'financeiro', {
      antes:  saldoAntesDia !== null ? { saldoDia: saldoAntesDia } : null,
      depois: {
        id:         lancamento.id,
        tipo:       lancamento.tipo,
        categoria:  lancamento.categoria,
        valor:      lancamento.valor,
        formaPgto:  lancamento.formaPgto || null,
        referencia: lancamento.referencia || null,
        operador:   lancamento.operador,
      },
      motivo:        lancamento.descricao || null,
      resumo:        `${_tipoLabel[lancamento.tipo] || lancamento.tipo}: ${_Utils().formatCurrency(lancamento.valor)} — ${lancamento.descricao}`,
      correlationId: lancamento.correlationId || null,
      origem:        lancamento.referencia ? 'venda' : 'manual',
    });
  }

  // ── Auditoria de Auth ────────────────────────────────────────────

  function auditarLogin(role) {
    return registrar('login', 'auth', {
      antes:  null,
      depois: { role, usuario: _Auth().getNome() },
      motivo: `Login como ${role}`,
      resumo: `Login — ${_Auth().getNome()} (${role})`,
      origem: 'auth',
    });
  }

  function auditarLogout() {
    return registrar('logout', 'auth', {
      antes:  { usuario: _Auth().getNome(), role: _Auth().getRole() },
      depois: null,
      motivo: 'Sessão encerrada',
      resumo: `Logout — ${_Auth().getNome()}`,
      origem: 'auth',
    });
  }

  // ── Consultas ─────────────────────────────────────────────────────

  function getHistorico({ modulo, acao, usuario, dataDe, dataAte, correlationId, limit = 200 } = {}) {
    let audit = _Store().getAuditoria();
    if (modulo)        audit = audit.filter(r => r.modulo        === modulo);
    if (acao)          audit = audit.filter(r => r.acao          === acao);
    if (usuario)       audit = audit.filter(r => r.usuario       === usuario);
    if (dataDe)        audit = audit.filter(r => r.dataCurta     >= dataDe);
    if (dataAte)       audit = audit.filter(r => r.dataCurta     <= dataAte);
    if (correlationId) audit = audit.filter(r => r.correlationId === correlationId);
    return audit.slice(0, limit);
  }

  function getHoje() {
    return getHistorico({ dataDe: _Utils().todayISO(), dataAte: _Utils().todayISO() });
  }

  function getModulos() {
    return [...new Set(_Store().getAuditoria().map(r => r.modulo))];
  }

  /** Busca todos os registros de uma cadeia pelo correlationId */
  function getRastreamento(correlationId) {
    return getHistorico({ correlationId, limit: 1000 });
  }

  // Exportar CSV — inclui todos os campos forenses
  function exportarCSV() {
    const audit  = _Store().getAuditoria();
    const header = ['data','hora','acao','modulo','usuario','role','motivo','resumo',
                    'correlationId','origem','device'];
    const rows   = audit.map(r =>
      header.map(k => `"${String(r[k] ?? '').replace(/"/g,'""')}"`).join(',')
    );
    const csv = [header.join(','), ...rows].join('\n');
    _Utils().downloadBlob('\uFEFF' + csv, 'text/csv;charset=utf-8',
      `auditoria_${_Utils().todayISO()}.csv`);
    return audit.length;
  }

  // ── Utils internos ────────────────────────────────────────────────

  // Remove campos internos/pesados do snapshot para não inchar a auditoria
  function _sanitize(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const {
      _fbSynced, syncedAt, _semSync, _statusAnterior,
      _fbSynced: _1, ...rest
    } = obj;
    return rest;
  }

  function _produtoResumido(p) {
    return {
      id:           p.id,
      nome:         p.nome,
      estoqueAtual: p.estoqueAtual ?? p.qtdUn ?? 0,
      estoqueMinimo:p.estoqueMinimo ?? 0,
      precoVenda:   p.precoVenda ?? p.precoUn ?? 0,
      precoCusto:   p.precoCusto ?? p.custoUn ?? 0,
      ativo:        p.ativo ?? true,
    };
  }

  function _resumoEstoque(acao, antes, depois) {
    const nome = depois?.nome || antes?.nome || '?';
    if (acao === 'criar')  return `Produto criado: ${nome}`;
    if (acao === 'deletar') return `Produto desativado: ${nome}`;
    if (acao === 'editar') {
      const diff = [];
      const estAntes  = antes?.estoqueAtual;
      const estDepois = depois?.estoqueAtual;
      const preAntes  = antes?.precoVenda;
      const preDepois = depois?.precoVenda;
      if (estAntes  !== estDepois)  diff.push(`estoque: ${estAntes}→${estDepois}`);
      if (preAntes  !== preDepois)  diff.push(`preço: ${_Utils().formatCurrency(preAntes)}→${_Utils().formatCurrency(preDepois)}`);
      return `Produto editado: ${nome}${diff.length ? ' — ' + diff.join(', ') : ''}`;
    }
    return `${acao}: ${nome}`;
  }

  // ── Hooks automáticos ────────────────────────────────────────────
  _Bus().on('venda:finalizada',    venda       => auditarVenda(venda));
  _Bus().on('auth:login',          ({ role })  => auditarLogin(role));
  _Bus().on('auth:logout',         ()          => auditarLogout());
  _Bus().on('estoque:movimentado', mov         => auditarMovimentacao(mov));

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.AuditService = {
    registrar,
    auditarEstoque,
    auditarVenda,
    auditarMudancaStatus,
    auditarCancelamento,
    auditarLogin,
    auditarLogout,
    auditarMovimentacao,
    auditarFinanceiro,
    getHistorico,
    getHoje,
    getModulos,
    getRastreamento,
    exportarCSV,
  };

  console.info('%c AuditService ✓  (v2: forense — antes/depois/delta/motivo/correlationId)', 'color:#10b981;font-weight:bold');
})();
