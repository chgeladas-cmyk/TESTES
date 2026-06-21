/**
 * @fileoverview CH Geladas PDV — Dialog System v1.0.0
 *
 * Substitui 100% dos confirm() e prompt() nativos do browser por modais
 * estilizados, animados e mobile-friendly.
 *
 * API Promise-based — drop-in replacement:
 *
 *   // Antes:
 *   if (!confirm('Apagar?')) return;
 *
 *   // Depois:
 *   if (!await Dialog.confirm({ title:'Apagar?', message:'...' })) return;
 *
 *   // Antes:
 *   const nome = prompt('Nome:', '');
 *
 *   // Depois:
 *   const nome = await Dialog.prompt({ title:'Nome', placeholder:'...' });
 *
 * Módulos:
 *  - DialogCore   → Injeta e controla modais no DOM (singleton)
 *  - Dialog       → API pública: confirm(), prompt(), danger()
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
   DIALOG CORE — Singleton que gerencia os modais injetados no DOM
═══════════════════════════════════════════════════════════════════ */
const DialogCore = (() => {

  // Injeta estilos e containers uma única vez
  function _bootstrap() {
    if (document.getElementById('ch-dialog-root')) return;

    // CSS extra para os dialogs (complementa o Tailwind existente)
    const style = document.createElement('style');
    style.textContent = `
      #ch-dialog-root .ch-dlg {
        position:fixed;inset:0;z-index:99990;
        display:flex;align-items:center;justify-content:center;padding:1rem;
        background:rgba(0,0,0,0);
        transition:background .2s ease;
        pointer-events:none;
      }
      #ch-dialog-root .ch-dlg.open {
        background:rgba(0,0,0,.75);
        pointer-events:auto;
      }
      #ch-dialog-root .ch-dlg-box {
        background:rgba(13,17,23,.99);
        border:1px solid rgba(255,255,255,.09);
        border-radius:1.5rem;
        width:100%;max-width:22rem;
        box-shadow:0 32px 64px rgba(0,0,0,.7);
        transform:scale(.93) translateY(10px);
        opacity:0;
        transition:transform .22s cubic-bezier(.34,1.56,.64,1), opacity .18s ease;
        overflow:hidden;
      }
      #ch-dialog-root .ch-dlg.open .ch-dlg-box {
        transform:scale(1) translateY(0);
        opacity:1;
      }
      #ch-dialog-root .ch-dlg-inp {
        width:100%;
        background:#1e293b;
        border:2px solid #334155;
        border-radius:.75rem;
        padding:12px 14px;
        color:#fff;
        font-size:16px;
        font-family:'Plus Jakarta Sans',sans-serif;
        font-weight:600;
        outline:none;
        transition:border-color .15s, box-shadow .15s;
      }
      #ch-dialog-root .ch-dlg-inp:focus {
        border-color:#3b82f6;
        box-shadow:0 0 0 4px rgba(59,130,246,.2);
        background:#0f172a;
      }
      #ch-dialog-root .ch-dlg-inp::placeholder { color:#4b5563; }
    `;

    const root = document.createElement('div');
    root.id = 'ch-dialog-root';

    document.head.appendChild(style);
    document.body.appendChild(root);
  }

  /**
   * Cria e monta um modal no DOM, retorna Promise que resolve quando o
   * usuário interage.
   *
   * @param {string} html - innerHTML do .ch-dlg-box
   * @returns {{ el: HTMLElement, resolve: Function, remove: Function }}
   */
  function mount(html) {
    _bootstrap();
    const root = document.getElementById('ch-dialog-root');

    const overlay = document.createElement('div');
    overlay.className = 'ch-dlg';
    overlay.innerHTML = `<div class="ch-dlg-box">${html}</div>`;
    root.appendChild(overlay);

    // Animação de entrada
    requestAnimationFrame(() => {
      requestAnimationFrame(() => overlay.classList.add('open'));
    });

    function remove() {
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 250);
    }

    // Fecha ao clicar no backdrop
    overlay.addEventListener('click', e => {
      if (e.target === overlay) _resolveBackdrop(overlay);
    });

    return { el: overlay, remove };
  }

  // Armazena resolvers para fechamento pelo backdrop
  const _resolvers = new WeakMap();
  function registerResolver(el, fn) { _resolvers.set(el, fn); }
  function _resolveBackdrop(el) { _resolvers.get(el)?.(); }

  return Object.freeze({ mount, registerResolver });
})();

/* ═══════════════════════════════════════════════════════════════════
   DIALOG — API pública
═══════════════════════════════════════════════════════════════════ */
const Dialog = (() => {

  /* ─── Ícone de cabeçalho ──────────────────────────────────── */
  function _iconHtml(icon, color) {
    if (!icon) return '';
    return `<div class="w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${color || 'bg-slate-800'}">
      <i class="fas ${icon} text-sm"></i>
    </div>`;
  }

  /* ─── Separador visual ───────────────────────────────────── */
  const _divider = `<div class="border-t border-white/5 mx-0"></div>`;

  /* ══════════════════════════════════════════════════════════
     confirm(options) → Promise<boolean>

     Substitui: confirm('mensagem')
     Uso:       await Dialog.confirm({ title, message, ... })
  ══════════════════════════════════════════════════════════ */
  /**
   * @param {{
   *   title?:        string,
   *   message?:      string,
   *   icon?:         string,   // classe FontAwesome ex: 'fa-trash'
   *   iconBg?:       string,   // classes de bg ex: 'bg-red-500/15'
   *   iconColor?:    string,   // cor do ícone ex: 'text-red-400'
   *   confirmLabel?: string,
   *   confirmCls?:   string,   // classes do botão confirmar
   *   cancelLabel?:  string,
   *   danger?:       boolean,  // atalho: vermelho + ícone de aviso
   * }} opts
   * @returns {Promise<boolean>}
   */
  function confirm(opts = {}) {
    const {
      title        = 'Confirmar',
      message      = '',
      icon         = opts.danger ? 'fa-exclamation-triangle' : 'fa-question-circle',
      iconBg       = opts.danger ? 'bg-red-500/15'   : 'bg-blue-500/10',
      iconColor    = opts.danger ? 'text-red-400'    : 'text-blue-400',
      confirmLabel = opts.danger ? 'Confirmar'        : 'Confirmar',
      confirmCls   = opts.danger
        ? 'bg-red-600 hover:bg-red-500 text-white'
        : 'bg-blue-600 hover:bg-blue-500 text-white',
      cancelLabel  = 'Cancelar',
    } = opts;

    return new Promise(resolve => {
      const uid = `dlg-${Date.now()}`;

      const html = `
        <div class="p-6">
          ${_iconHtml(icon, `${iconBg} ${iconColor}`)}
          <h3 class="text-sm font-black text-white mb-1">${_esc(title)}</h3>
          ${message ? `<p class="text-[11px] text-slate-400 font-medium leading-relaxed">${_esc(message)}</p>` : ''}
        </div>
        ${_divider}
        <div class="p-4 flex gap-2">
          <button id="${uid}-cancel"
            class="flex-1 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300
                   font-black text-xs uppercase tracking-wide transition-all active:scale-95">
            ${_esc(cancelLabel)}
          </button>
          <button id="${uid}-confirm"
            class="flex-1 py-3 rounded-xl ${confirmCls}
                   font-black text-xs uppercase tracking-wide transition-all active:scale-95">
            ${_esc(confirmLabel)}
          </button>
        </div>`;

      const { el, remove } = DialogCore.mount(html);

      function finish(result) {
        remove();
        resolve(result);
      }

      DialogCore.registerResolver(el, () => finish(false));

      el.querySelector(`#${uid}-confirm`).addEventListener('click', () => finish(true));
      el.querySelector(`#${uid}-cancel`).addEventListener('click',  () => finish(false));

      // ESC fecha como "cancelar"
      function onKey(e) {
        if (e.key !== 'Escape') return;
        document.removeEventListener('keydown', onKey);
        finish(false);
      }
      document.addEventListener('keydown', onKey);
    });
  }

  /* ══════════════════════════════════════════════════════════
     danger(opts) → Promise<boolean>
     Atalho semântico para confirms destrutivos.
  ══════════════════════════════════════════════════════════ */
  /**
   * @param {object} opts — mesmos campos de confirm(), danger=true implícito
   * @returns {Promise<boolean>}
   */
  function danger(opts = {}) {
    return confirm({ ...opts, danger: true });
  }

  /* ══════════════════════════════════════════════════════════
     prompt(options) → Promise<string|null>

     Substitui: prompt('mensagem', 'default')
     Uso:       await Dialog.prompt({ title, placeholder, defaultValue })
     Retorna:   string com o valor, ou null se cancelado/vazio
  ══════════════════════════════════════════════════════════ */
  /**
   * @param {{
   *   title?:        string,
   *   message?:      string,
   *   placeholder?:  string,
   *   defaultValue?: string,
   *   confirmLabel?: string,
   *   cancelLabel?:  string,
   *   icon?:         string,
   *   iconBg?:       string,
   *   iconColor?:    string,
   *   maxLength?:    number,
   * }} opts
   * @returns {Promise<string|null>}
   */
  function prompt(opts = {}) {
    const {
      title        = 'Informar',
      message      = '',
      placeholder  = '',
      defaultValue = '',
      confirmLabel = 'Confirmar',
      cancelLabel  = 'Cancelar',
      icon         = 'fa-pen',
      iconBg       = 'bg-blue-500/10',
      iconColor    = 'text-blue-400',
      maxLength    = 80,
    } = opts;

    return new Promise(resolve => {
      const uid = `dlg-${Date.now()}`;
      const inpId = `${uid}-input`;

      const html = `
        <div class="p-6 pb-4">
          ${_iconHtml(icon, `${iconBg} ${iconColor}`)}
          <h3 class="text-sm font-black text-white mb-1">${_esc(title)}</h3>
          ${message ? `<p class="text-[11px] text-slate-400 font-medium mb-3 leading-relaxed">${_esc(message)}</p>` : '<div class="mb-3"></div>'}
          <input
            id="${inpId}"
            class="ch-dlg-inp"
            type="text"
            placeholder="${_esc(placeholder)}"
            value="${_esc(defaultValue)}"
            maxlength="${maxLength}"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
          />
        </div>
        ${_divider}
        <div class="p-4 flex gap-2">
          <button id="${uid}-cancel"
            class="flex-1 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300
                   font-black text-xs uppercase tracking-wide transition-all active:scale-95">
            ${_esc(cancelLabel)}
          </button>
          <button id="${uid}-confirm"
            class="flex-1 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white
                   font-black text-xs uppercase tracking-wide transition-all active:scale-95">
            ${_esc(confirmLabel)}
          </button>
        </div>`;

      const { el, remove } = DialogCore.mount(html);
      const input = el.querySelector(`#${inpId}`);

      // Foca o input e seleciona o texto default
      setTimeout(() => {
        input?.focus();
        input?.select();
      }, 180);

      function finish(result) {
        document.removeEventListener('keydown', onKey);
        remove();
        resolve(result);
      }

      DialogCore.registerResolver(el, () => finish(null));

      el.querySelector(`#${uid}-confirm`).addEventListener('click', () => {
        const val = input?.value.trim() ?? '';
        finish(val || null);
      });

      el.querySelector(`#${uid}-cancel`).addEventListener('click', () => finish(null));

      function onKey(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          const val = input?.value.trim() ?? '';
          finish(val || null);
        }
        if (e.key === 'Escape') finish(null);
      }
      document.addEventListener('keydown', onKey);
    });
  }

  /* ══════════════════════════════════════════════════════════
     promptDanger(opts) → Promise<boolean>

     Modal especial de confirmação com campo de texto —
     o usuário precisa digitar uma palavra exata para confirmar.
     Substitui o padrão: prompt('Digite "DELETAR"') === 'DELETAR'
  ══════════════════════════════════════════════════════════ */
  /**
   * @param {{
   *   title?:       string,
   *   message?:     string,
   *   keyword?:     string,   // palavra que o user deve digitar (ex: 'DELETAR')
   *   confirmLabel?: string,
   * }} opts
   * @returns {Promise<boolean>}
   */
  function promptDanger(opts = {}) {
    const {
      title        = '⚠️ Ação Irreversível',
      message      = '',
      keyword      = 'DELETAR',
      confirmLabel = 'Confirmar Exclusão',
    } = opts;

    return new Promise(resolve => {
      const uid   = `dlg-${Date.now()}`;
      const inpId = `${uid}-input`;
      const btnId = `${uid}-confirm`;

      const html = `
        <div class="p-6 pb-4">
          <div class="w-10 h-10 rounded-xl flex items-center justify-center mb-3 bg-red-500/15 text-red-400">
            <i class="fas fa-skull-crossbones text-sm"></i>
          </div>
          <h3 class="text-sm font-black text-red-400 mb-1">${_esc(title)}</h3>
          ${message ? `<p class="text-[11px] text-slate-400 font-medium mb-3 leading-relaxed">${_esc(message)}</p>` : '<div class="mb-3"></div>'}
          <p class="text-[10px] text-slate-500 font-bold mb-2">
            Digite <span class="text-red-400 font-black tracking-widest">${_esc(keyword)}</span> para confirmar:
          </p>
          <input
            id="${inpId}"
            class="ch-dlg-inp"
            type="text"
            placeholder="${_esc(keyword)}"
            maxlength="30"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            style="border-color:rgba(239,68,68,.3)"
          />
        </div>
        ${_divider}
        <div class="p-4 flex gap-2">
          <button id="${uid}-cancel"
            class="flex-1 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300
                   font-black text-xs uppercase tracking-wide transition-all active:scale-95">
            Cancelar
          </button>
          <button id="${btnId}"
            class="flex-1 py-3 rounded-xl bg-slate-700 text-slate-500
                   font-black text-xs uppercase tracking-wide transition-all active:scale-95 cursor-not-allowed"
            disabled>
            ${_esc(confirmLabel)}
          </button>
        </div>`;

      const { el, remove } = DialogCore.mount(html);
      const input  = el.querySelector(`#${inpId}`);
      const btnEl  = el.querySelector(`#${btnId}`);

      // Habilita o botão só quando a palavra exata for digitada
      input?.addEventListener('input', () => {
        const match = input.value === keyword;
        btnEl.disabled = !match;
        if (match) {
          btnEl.className = btnEl.className
            .replace('bg-slate-700 text-slate-500 cursor-not-allowed',
                     'bg-red-600 hover:bg-red-500 text-white cursor-pointer');
        } else {
          btnEl.className = btnEl.className
            .replace('bg-red-600 hover:bg-red-500 text-white cursor-pointer',
                     'bg-slate-700 text-slate-500 cursor-not-allowed');
        }
      });

      setTimeout(() => input?.focus(), 180);

      function finish(result) {
        document.removeEventListener('keydown', onKey);
        remove();
        resolve(result);
      }

      DialogCore.registerResolver(el, () => finish(false));
      btnEl.addEventListener('click',              () => finish(true));
      el.querySelector(`#${uid}-cancel`).addEventListener('click', () => finish(false));

      function onKey(e) {
        if (e.key === 'Enter' && input?.value === keyword) finish(true);
        if (e.key === 'Escape') finish(false);
      }
      document.addEventListener('keydown', onKey);
    });
  }

  /* ─── Helper de escape ───────────────────────────────────── */
  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]
    );
  }

  return Object.freeze({ confirm, danger, prompt, promptDanger });
})();

/* ═══════════════════════════════════════════════════════════════════
   WINDOW BRIDGE — compatibilidade com HTML inline (se necessário)
═══════════════════════════════════════════════════════════════════ */
window.Dialog = Dialog;
