/**
 * @fileoverview CH Geladas PDV — Notificações Críticas + Log de Auditoria
 * @version 1.0.0
 *
 * Módulo responsável por:
 *  1. NotifService  — Telegram + WhatsApp para eventos críticos do negócio
 *  2. AuditService  — Log imutável de todas as ações relevantes (append-only)
 *
 * Eventos monitorados:
 *  • Venda concluída (PDV, Comanda, Delivery)
 *  • Estoque zerado após venda
 *  • Estoque baixo após venda (threshold configurável)
 *  • Caixa aberto / fechado
 *  • Ponto registrado (entrada/saída)
 *  • Login de utilizador
 *  • Exclusão de venda
 *  • Produto adicionado / editado / excluído
 *  • Desconto aplicado acima de X%
 *
 * Arquitetura:
 *  - Escuta eventos via EventBus (não polui outros módulos)
 *  - AuditLog = array append-only em Store.state.auditLog
 *  - Cada entrada: { id, ts, tipo, msg, dados, user, dispositivo }
 *  - Limite de 500 entradas (FIFO) para não estourar localStorage
 *  - Telegram via bot API (token + chatId em config)
 *  - WhatsApp via wa.me link (apenas para alertas urgentes)
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   CONSTANTES
═══════════════════════════════════════════════════════════════ */
const AUDIT_MAX_ENTRIES  = 500;   // máximo de entradas no log
const NOTIF_COOLDOWN_MS  = 60_000; // mínimo entre notificações do mesmo tipo
const DESCONTO_ALERTA_PCT = 20;   // % de desconto que gera alerta

/* ═══════════════════════════════════════════════════════════════
   AUDIT SERVICE — Log imutável append-only
═══════════════════════════════════════════════════════════════ */
const AuditService = (() => {

  /**
   * Registra uma entrada no log de auditoria.
   * Append-only: nunca edita, nunca remove (apenas trunca ao máximo).
   * @param {'venda'|'comanda'|'delivery'|'caixa'|'ponto'|'estoque'|'auth'|'config'|'exclusao'|'desconto'|'sistema'} tipo
   * @param {string} msg  — descrição legível
   * @param {object} [dados] — payload opcional
   */
  function registrar(tipo, msg, dados = {}) {
    try {
      const entry = {
        id:          Utils.generateId(),
        ts:          Date.now(),
        tsFormatado: Utils.timestamp(),
        tipo,
        msg,
        dados,
        user:        AuthService.getRole() ?? 'sistema',
        dispositivo: _getDispositivo(),
      };

      Store.mutate(state => {
        if (!Array.isArray(state.auditLog)) state.auditLog = [];
        state.auditLog.unshift(entry); // mais recente primeiro
        // Trunca ao máximo para não estourar localStorage
        if (state.auditLog.length > AUDIT_MAX_ENTRIES) {
          state.auditLog = state.auditLog.slice(0, AUDIT_MAX_ENTRIES);
        }
      }, true); // silent — não dispara re-render

      // BUG-05 FIX: usar persist() com debounce em vez de persistNow().
      // Após uma venda com estoque baixo, registrar() era chamado 3–4 vezes
      // consecutivas, disparando persistNow() (e CH_BACKUP) a cada chamada.
      // persist() agrupa todas as escritas em um único flush após 300ms.
      SyncService.persist();

    } catch (err) {
      console.warn('[AuditService] Falha ao registrar:', err);
    }
  }

  /** Retorna as últimas N entradas do log */
  function getLog(limit = 100) {
    const log = Store.getState().auditLog ?? [];
    return log.slice(0, limit);
  }

  /** Exporta log completo como JSON para download */
  function exportar() {
    const log = Store.getState().auditLog ?? [];
    const json = JSON.stringify({ exportado: new Date().toISOString(), total: log.length, entradas: log }, null, 2);
    Utils.downloadBlob(json, 'application/json', `AuditLog_${Utils.todayISO()}.json`);
  }

  /** Identificador simples do dispositivo */
  function _getDispositivo() {
    const ua = navigator.userAgent;
    if (/Android/i.test(ua))   return 'Android';
    if (/iPhone|iPad/i.test(ua)) return 'iOS';
    if (/Windows/i.test(ua))   return 'Windows';
    if (/Mac/i.test(ua))       return 'Mac';
    return 'Web';
  }

  return Object.freeze({ registrar, getLog, exportar });
})();

/* ═══════════════════════════════════════════════════════════════
   NOTIF SERVICE — Telegram + WhatsApp críticos
═══════════════════════════════════════════════════════════════ */
const NotifService = (() => {

  /** Cooldown por tipo de notificação para evitar spam */
  const _lastSent = {};

  /**
   * Envia mensagem Telegram se configurado e fora do cooldown.
   * @param {string} msg — texto em Markdown
   * @param {string} tipo — chave de cooldown
   * @param {boolean} [urgente=false] — se true, ignora cooldown
   */
  async function telegram(msg, tipo, urgente = false) {
    const cfg = Store.Selectors.getConfig();
    const tg  = cfg.telegram;

    if (!tg?.token || !tg?.chatId) {
      console.warn('[NotifService] Telegram não configurado (token/chatId ausente).');
      return;
    }

    // Cooldown: evita flood de mensagens do mesmo tipo
    if (!urgente) {
      const last = _lastSent[tipo] ?? 0;
      if (Date.now() - last < NOTIF_COOLDOWN_MS) return;
    }
    _lastSent[tipo] = Date.now();

    try {
      const res  = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          chat_id:    tg.chatId,
          text:       msg,
          parse_mode: 'HTML',   // HTML é mais robusto que Markdown v1
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.warn('[NotifService] Telegram rejeitou mensagem:', res.status, body?.description ?? body);
      }
    } catch (e) {
      console.warn('[NotifService] Telegram falhou (rede):', e.message);
    }
  }

  /**
   * Envia mensagem de teste para validar token e chatId.
   * Útil para diagnóstico via console: NotifService.testTelegram()
   */
  async function testTelegram() {
    const cfg = Store.Selectors.getConfig();
    const tg  = cfg.telegram;
    if (!tg?.token || !tg?.chatId) {
      console.error('[NotifService] Token ou chatId não configurado.');
      return;
    }
    console.info('[NotifService] Enviando mensagem de teste...');
    try {
      const res  = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          chat_id:    tg.chatId,
          text:       `✅ <b>CH Gestão — Teste</b>\nNotificações funcionando!\n🕐 ${Utils.timestamp()}`,
          parse_mode: 'HTML',
        }),
      });
      const body = await res.json();
      if (body.ok) {
        console.info('[NotifService] ✅ Teste enviado com sucesso!');
      } else {
        console.error('[NotifService] ❌ Telegram recusou:', body.description);
      }
    } catch (e) {
      console.error('[NotifService] ❌ Erro de rede:', e.message);
    }
  }

  /**
   * Abre WhatsApp com mensagem (apenas alertas urgentes).
   * @param {string} msg
   */
  function whatsapp(msg) {
    const cfg = Store.Selectors.getConfig();
    if (!cfg.whatsapp) return;
    Utils.openWhatsApp(cfg.whatsapp, msg);
  }

  /* ── Formatadores de mensagem ─────────────────────────────── */

  function _fmtVenda(venda, origem) {
    const icone = origem === 'Comanda' ? '📋' : origem === 'Delivery' ? '🛵' : '🛒';
    let msg = `${icone} <b>Nova Venda — ${_esc(origem)}</b>\n`;
    if (venda.nomeComanda) msg += `📋 Comanda: <b>${_esc(venda.nomeComanda)}</b>\n`;
    if (venda.num)         msg += `#️⃣ Pedido: <b>#${_esc(String(venda.num))}</b>\n`;

    // Itens vendidos
    const itens = venda.itens || [];
    if (itens.length > 0) {
      msg += `\n<b>Itens:</b>\n`;
      itens.forEach(i => {
        const qtdLabel = i.label && i.label !== 'UNID' ? i.label : '1x';
        msg += `  · ${_esc(qtdLabel)} ${_esc(i.nome || '?')} — ${_esc(Utils.formatCurrency(i.preco))}\n`;
      });
      msg += `\n`;
    }

    if ((venda.subtotal || 0) > 0 && (venda.desconto || 0) > 0) {
      msg += `🏷️ Subtotal: ${_esc(Utils.formatCurrency(venda.subtotal))}\n`;
      msg += `➖ Desconto: ${_esc(Utils.formatCurrency(venda.desconto))}\n`;
    }
    msg += `💰 Total: <b>${_esc(Utils.formatCurrency(venda.total))}</b>\n`;
    msg += `💳 Pgto: ${_esc(venda.formaPgto || '—')}\n`;
    msg += `🕐 ${Utils.timestamp()}\n`;
    msg += `🔖 ID: <code>${_esc(String(venda.id))}</code>`;
    return msg;
  }

  function _fmtEstoqueZerado(produtos) {
    let msg = `🚨 <b>ESTOQUE ZERADO</b>\n`;
    msg    += `${produtos.map(p => `• ${_esc(p.nome)}`).join('\n')}\n`;
    msg    += `⚠️ Ação imediata necessária!`;
    return msg;
  }

  function _fmtEstoqueBaixo(produtos) {
    let msg = `⚠️ <b>Estoque Baixo</b>\n`;
    msg    += `${produtos.map(p => `• ${_esc(p.nome)} — ${p.qtdUn} un.`).join('\n')}`;
    return msg;
  }

  function _fmtCaixa(tipo, valor) {
    const icone = tipo === 'ABERTURA' ? '🟢' : '🔴';
    const acao  = tipo === 'ABERTURA' ? 'Aberto' : 'Fechado';
    let msg = `${icone} <b>Caixa ${acao}</b>\n`;
    if (valor > 0) msg += `💵 Valor: ${_esc(Utils.formatCurrency(valor))}\n`;
    msg += `🕐 ${Utils.timestamp()}`;
    return msg;
  }

  function _fmtPonto(nome, tipo) {
    const icone = tipo === 'ENTRADA' ? '✅' : '🏁';
    const acao  = tipo === 'ENTRADA' ? 'Entrada' : 'Saída';
    return `${icone} <b>Ponto — ${acao}</b>\n👤 ${_esc(nome)}\n🕐 ${Utils.timestamp()}`;
  }

  function _fmtDesconto(venda, pct) {
    return `🏷️ <b>Desconto Alto — ${pct.toFixed(0)}%</b>\n` +
           `💰 Subtotal: ${_esc(Utils.formatCurrency(venda.subtotal))}\n` +
           `➖ Desconto: ${_esc(Utils.formatCurrency(venda.desconto))}\n` +
           `✅ Cobrado: ${_esc(Utils.formatCurrency(venda.total))}\n` +
           `👤 ${_esc(AuthService.getRole())}\n🕐 ${Utils.timestamp()}`;
  }

  function _fmtExclusao(venda) {
    return `🗑️ <b>Venda Excluída</b>\n` +
           `💰 ${_esc(Utils.formatCurrency(venda.total || 0))}\n` +
           `🔖 ID: <code>${_esc(String(venda.id || '—'))}</code>\n` +
           `👤 ${_esc(AuthService.getRole())}\n🕐 ${Utils.timestamp()}`;
  }

  /** Escapa caracteres especiais do HTML para uso seguro nas mensagens */
  function _esc(t) {
    return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ── Handlers de eventos ──────────────────────────────────── */

  function _onVenda(venda) {
    const origem = venda.origem || 'PDV';

    // Audit
    AuditService.registrar('venda', `Venda ${origem} — ${Utils.formatCurrency(venda.total)}`, {
      id: venda.id, total: venda.total, desconto: venda.desconto,
      formaPgto: venda.formaPgto, itens: venda.itens?.length, origem,
    });

    // Alerta de desconto alto
    if ((venda.desconto || 0) > 0 && venda.subtotal > 0) {
      const pct = (venda.desconto / venda.subtotal) * 100;
      if (pct >= DESCONTO_ALERTA_PCT) {
        AuditService.registrar('desconto', `Desconto alto ${pct.toFixed(0)}% aplicado`, {
          id: venda.id, desconto: venda.desconto, subtotal: venda.subtotal, pct,
        });
        telegram(_fmtDesconto(venda, pct), 'desconto_alto');
      }
    }

    // Telegram por origem (sem cooldown excessivo — cada venda é diferente)
    telegram(_fmtVenda(venda, origem), `venda_${origem}`, true);

    // Verifica estoque após venda
    _checkEstoquePos();
  }

  function _checkEstoquePos() {
    const zerados = Store.Selectors.getOutOfStockItems();
    const baixos  = Store.Selectors.getLowStockItems();

    if (zerados.length > 0) {
      AuditService.registrar('estoque', `${zerados.length} produto(s) com estoque zerado`, {
        produtos: zerados.map(p => p.nome),
      });
      telegram(_fmtEstoqueZerado(zerados), 'estoque_zerado', true);
    } else if (baixos.length > 0) {
      AuditService.registrar('estoque', `${baixos.length} produto(s) com estoque baixo`, {
        produtos: baixos.map(p => ({ nome: p.nome, qtd: p.qtdUn })),
      });
      telegram(_fmtEstoqueBaixo(baixos), 'estoque_baixo');
    }
  }

  function _onCaixa(tipo, valor) {
    AuditService.registrar('caixa', `Caixa ${tipo === 'ABERTURA' ? 'aberto' : 'fechado'}`, {
      tipo, valor,
    });
    telegram(_fmtCaixa(tipo, valor || 0), `caixa_${tipo}`, true);
  }

  function _onPonto({ nome, tipo }) {
    AuditService.registrar('ponto', `${nome} — ${tipo}`, { nome, tipo });
    telegram(_fmtPonto(nome, tipo), `ponto_${nome}_${tipo}`);
  }

  function _onLogin({ role }) {
    AuditService.registrar('auth', `Login — ${role}`, { role });
  }

  function _onEstoqueUpdate() {
    // Chamado após edição manual de produto
    AuditService.registrar('estoque', 'Estoque atualizado manualmente', {
      user: AuthService.getRole(),
    });
  }

  function _onExclusaoVenda(venda) {
    AuditService.registrar('exclusao', `Venda excluída — ${Utils.formatCurrency(venda.total || 0)}`, {
      id: venda.id, total: venda.total, user: AuthService.getRole(),
    });
    telegram(_fmtExclusao(venda), 'exclusao_venda', true);
  }

  /** Inicializa listeners */
  function init() {
    // Vendas (PDV + Comanda + Delivery emitem cart:checkout)
    EventBus.on('venda:concluida',        venda  => _onVenda(venda));
    EventBus.on('comanda:finalizada',     venda  => _onVenda({ ...venda, origem: 'Comanda' }));
    EventBus.on('delivery:status-changed', pedido => {
      // FIX: status é uppercase 'ENTREGUE', não lowercase 'entregue'
      if (pedido?.status === 'ENTREGUE') _onVenda({ ...pedido, origem: 'Delivery' });
    });

    // Caixa
    EventBus.on('caixa:aberto',  val => _onCaixa('ABERTURA', val));
    EventBus.on('caixa:fechado', val => _onCaixa('FECHAMENTO', val));

    // Ponto
    EventBus.on('ponto:registered', data => _onPonto(data));

    // Auth
    EventBus.on('auth:login', data => _onLogin(data));

    // Estoque (edição manual)
    EventBus.on('estoque:updated', () => _onEstoqueUpdate());

    // Exclusão de venda (disparado pelo módulo de financeiro)
    // FIX: evento corrigido de 'venda:excluida' (nunca emitido) para 'finance:venda-deleted'
    EventBus.on('finance:venda-deleted', venda => _onExclusaoVenda(venda));

    console.info('[NotifService] ✅ Notificações + Auditoria ativas');
  }

  return Object.freeze({ init, telegram, testTelegram, whatsapp });
})();

/* ═══════════════════════════════════════════════════════════════
   AUDIT RENDERER — Painel de log na aba DADOS
═══════════════════════════════════════════════════════════════ */
const AuditRenderer = (() => {

  const ICONES = {
    venda:    '🛒', comanda: '📋', delivery: '🛵',
    caixa:    '💰', ponto:   '👤', estoque:  '📦',
    auth:     '🔐', config:  '⚙️', exclusao: '🗑️',
    desconto: '🏷️', sistema: '🖥️',
  };

  const CORES = {
    venda:    'text-emerald-400', comanda:  'text-emerald-400',
    delivery: 'text-blue-400',   caixa:    'text-amber-400',
    ponto:    'text-purple-400', estoque:  'text-red-400',
    auth:     'text-slate-400',  config:   'text-slate-400',
    exclusao: 'text-red-500',    desconto: 'text-amber-500',
    sistema:  'text-slate-500',
  };

  function render() {
    const container = Utils.el('auditLogContainer');
    if (!container) return;

    const log    = AuditService.getLog(100);
    const filtro = Utils.el('auditFiltro')?.value || 'todos';

    const filtrado = filtro === 'todos' ? log : log.filter(e => e.tipo === filtro);

    if (filtrado.length === 0) {
      container.innerHTML = `
        <div class="text-center py-8 text-slate-600">
          <p class="text-2xl mb-2">📋</p>
          <p class="text-xs font-bold uppercase">Nenhum registro encontrado</p>
        </div>`;
      return;
    }

    container.innerHTML = filtrado.map(e => {
      const icone = ICONES[e.tipo] || '•';
      const cor   = CORES[e.tipo]  || 'text-slate-400';
      const hora  = e.tsFormatado || new Date(e.ts).toLocaleString('pt-BR');
      return `
        <div class="flex items-start gap-3 py-2.5 border-b border-white/5 last:border-0">
          <span class="text-base flex-shrink-0 mt-0.5">${icone}</span>
          <div class="flex-1 min-w-0">
            <p class="text-[11px] font-bold text-white leading-snug">${_esc(e.msg)}</p>
            <div class="flex items-center gap-2 mt-0.5 flex-wrap">
              <span class="text-[9px] font-black uppercase ${cor}">${e.tipo}</span>
              <span class="text-[9px] text-slate-600">•</span>
              <span class="text-[9px] text-slate-500">${_esc(hora)}</span>
              <span class="text-[9px] text-slate-600">•</span>
              <span class="text-[9px] text-slate-500">${_esc(e.user)} · ${_esc(e.dispositivo)}</span>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function _esc(t) {
    return String(t ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return Object.freeze({ render });
})();

/* ═══════════════════════════════════════════════════════════════
   INICIALIZAÇÃO
═══════════════════════════════════════════════════════════════ */
NotifService.init();

// Renderiza painel quando a aba DADOS é aberta
EventBus.on('tab:switched', id => {
  if (id === 'dados') AuditRenderer.render();
});

// Atualiza o log quando novos registros chegam
EventBus.on('sync:remote-applied', () => {
  const dadosAtivo = document.querySelector('#tab-dados.active');
  if (dadosAtivo) AuditRenderer.render();
});

// Funções globais para o HTML
window.auditExportar   = () => AuditService.exportar();
window.auditRender     = () => AuditRenderer.render();
window.testTelegram    = () => NotifService.testTelegram(); // diagnóstico: rode no console

/* ═══════════════════════════════════════════════════════════════
   SOM SERVICE — Web Audio API para alertas sonoros
═══════════════════════════════════════════════════════════════ */
const SomService = (() => {
  let _ctx = null;

  function _getCtx() {
    if (!_ctx) {
      try { _ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
    }
    return _ctx;
  }

  /**
   * Toca um padrão sonoro por tipo de alerta
   * @param {'venda'|'alerta'|'critico'|'ponto'} tipo
   */
  function tocar(tipo = 'alerta') {
    if (!Store.Selectors.getConfig()?.somNotificacoes) return;
    const ctx = _getCtx();
    if (!ctx) return;

    const padroes = {
      venda:   [{ freq: 523, dur: 0.1 }, { freq: 659, dur: 0.1 }, { freq: 784, dur: 0.2 }],
      alerta:  [{ freq: 440, dur: 0.15 }, { freq: 330, dur: 0.15 }, { freq: 440, dur: 0.3 }],
      critico: [{ freq: 880, dur: 0.1 }, { freq: 880, dur: 0.1 }, { freq: 660, dur: 0.3 }],
      ponto:   [{ freq: 523, dur: 0.12 }, { freq: 659, dur: 0.2 }],
    };

    let t = ctx.currentTime;
    (padroes[tipo] || padroes.alerta).forEach(({ freq, dur }) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.start(t);
      osc.stop(t + dur);
      t += dur + 0.05;
    });
  }

  return Object.freeze({ tocar });
})();

/* ── Toca som em eventos relevantes ─────────────────────────── */
EventBus.on('venda:concluida',       () => SomService.tocar('venda'));
EventBus.on('comanda:finalizada',    () => SomService.tocar('venda'));
EventBus.on('ponto:registered',      () => SomService.tocar('ponto'));
EventBus.on('caixa:aberto',          () => SomService.tocar('alerta'));
EventBus.on('caixa:fechado',         () => SomService.tocar('alerta'));
EventBus.on('notif:alerta-comanda',  () => SomService.tocar('critico'));
EventBus.on('notif:alerta-delivery', () => SomService.tocar('critico'));
// FIX: som ao delivery ser entregue
EventBus.on('delivery:status-changed', pedido => {
  if (pedido?.status === 'ENTREGUE') SomService.tocar('venda');
});

/* ── Alerta Telegram para comandas atrasadas ─────────────────── */
EventBus.on('notif:alerta-comanda', ({ qtd }) => {
  NotifService.telegram(
    `⏰ <b>Comanda Atrasada</b>\n${qtd} comanda(s) com mais de 20 min sem fechar.\nVerifique o monitor.`,
    'comanda_atraso'
  );
});

/* ── Alerta Telegram para deliveries atrasados ───────────────── */
EventBus.on('notif:alerta-delivery', ({ qtd }) => {
  NotifService.telegram(
    `🛵 <b>Delivery Atrasado</b>\n${qtd} pedido(s) acima do tempo estimado.\nVerifique as entregas.`,
    'delivery_atraso'
  );
});

/* ── Config: soma notificacoes habilitado por padrão ─────────── */
EventBus.on('core:ready', () => {
  if (Store.Selectors.getConfig().somNotificacoes === undefined) {
    Store.mutate(s => { s.config.somNotificacoes = true; }, true);
  }
});

window.SomService = SomService;
