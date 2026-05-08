'use strict';
/**
 * services/userService.js — CH Geladas PDV
 * Papéis:
 *   adm         → acesso total (alias admin)
 *   admin       → acesso total (legado)
 *   controlador → aprova vendas pendentes
 *   validador   → valida vendas aprovadas (aciona estoque/financeiro)
 *   colaborador → só vendas (fluxo pendente)
 *   gerente     → estoque, financeiro, relatórios
 *   operador    → vendas diretas + consulta estoque
 *   entregador  → delivery
 *   pdv         → vendas diretas (legado)
 */

(function () {
  const { Store, AuthService, Utils, EventBus, CryptoService } = window.CH;

  const USERS_KEY = 'CH_USERS';

  const PERMISSOES_ROLES = {
    adm: {
      label:   'Administrador',
      cor:     '#ef4444',
      icone:   '👑',
      acessos: ['estoque','vendas','financeiro','fiado','comandas','delivery','ponto','config','auditoria','relatorios','usuarios','aprovacao'],
    },
    admin: {
      label:   'Administrador',
      cor:     '#ef4444',
      icone:   '👑',
      acessos: ['estoque','vendas','financeiro','fiado','comandas','delivery','ponto','config','auditoria','relatorios','usuarios','aprovacao'],
    },
    controlador: {
      label:   'Controlador',
      cor:     '#f59e0b',
      icone:   '🔍',
      acessos: ['vendas:leitura','aprovacao:controle','relatorios'],
    },
    validador: {
      label:   'Validador',
      cor:     '#8b5cf6',
      icone:   '✅',
      acessos: ['vendas:leitura','aprovacao:validacao','estoque:leitura','financeiro:leitura','relatorios'],
    },
    colaborador: {
      label:   'Colaborador',
      cor:     '#3b82f6',
      icone:   '🛒',
      acessos: ['vendas'],
    },
    gerente: {
      label:   'Gerente',
      cor:     '#f59e0b',
      icone:   '📊',
      acessos: ['estoque','vendas','financeiro','fiado','comandas','delivery','ponto','relatorios'],
    },
    operador: {
      label:   'Operador',
      cor:     '#10b981',
      icone:   '🖥️',
      acessos: ['vendas','estoque:leitura','comandas','delivery'],
    },
    entregador: {
      label:   'Entregador',
      cor:     '#06b6d4',
      icone:   '🚴',
      acessos: ['delivery','pedidos:leitura'],
    },
    pdv: {
      label:   'PDV (Caixa)',
      cor:     '#10b981',
      icone:   '💵',
      acessos: ['vendas'],
    },
  };

  function _loadUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); } catch { return []; }
  }
  function _saveUsers(users) {
    try { localStorage.setItem(USERS_KEY, JSON.stringify(users)); } catch(e) {}
  }

  async function criarUsuario({ nome, role, pin }) {
    // Aceita perfis fixos (PERMISSOES_ROLES) OU perfis dinâmicos do PermissoesService
    const perfilDinamico = window.CH?.PermissoesService?.getPerfil(role);
    if (!PERMISSOES_ROLES[role] && !perfilDinamico) throw new Error(`Papel inválido: ${role}`);
    if (!pin || String(pin).length < 3) throw new Error('PIN deve ter pelo menos 3 dígitos');

    const users   = _loadUsers();
    const pinHash = await CryptoService.sha256(String(pin).trim());

    if (users.find(u => u.pinHash === pinHash)) throw new Error('Este PIN já está em uso');

    const user = {
      id:        Utils.generateId(),
      nome:      nome.trim(),
      role,
      pinHash,
      ativo:     true,
      criadoEm:  Utils.nowISO(),
      criadoPor: AuthService.getNome(),
    };

    users.push(user);
    _saveUsers(users);
    EventBus.emit('usuario:criado', { id: user.id, nome: user.nome, role: user.role });
    return { ...user, pinHash: undefined };
  }

  async function atualizarUsuario(id, campos) {
    const users = _loadUsers();
    const idx   = users.findIndex(u => u.id === id);
    if (idx < 0) throw new Error(`Usuário ${id} não encontrado`);
    if (campos.pin) {
      campos.pinHash = await CryptoService.sha256(String(campos.pin).trim());
      delete campos.pin;
    }
    Object.assign(users[idx], campos, { updatedAt: Utils.nowISO() });
    _saveUsers(users);
    return { ...users[idx], pinHash: undefined };
  }

  function desativarUsuario(id) { return atualizarUsuario(id, { ativo: false }); }

  function getUsuarios({ apenasAtivos = true } = {}) {
    let users = _loadUsers();
    if (apenasAtivos) users = users.filter(u => u.ativo);
    return users.map(u => ({ ...u, pinHash: undefined }));
  }

  async function validarPin(pin) {
    const pinHash = await CryptoService.sha256(String(pin).trim());
    const users   = _loadUsers();
    const user    = users.find(u => u.ativo && u.pinHash === pinHash);
    if (user) return { id: user.id, nome: user.nome, role: user.role };

    const legacyRole = await window.CH.CryptoService.validatePin(pin);
    if (legacyRole) {
      return { id: 'legacy', nome: legacyRole === 'admin' ? 'Administrador' : 'Colaborador', role: legacyRole };
    }
    return null;
  }

  function temAcesso(role, modulo) {
    const perms = PERMISSOES_ROLES[role];
    if (!perms) return false;
    if (role === 'adm' || role === 'admin') return true;
    return perms.acessos.some(a => a === modulo || a === `${modulo}:leitura` || a.startsWith(modulo));
  }

  function podeEscrever(role, modulo) {
    if (role === 'adm' || role === 'admin' || role === 'gerente') return true;
    const perms = PERMISSOES_ROLES[role];
    if (!perms) return false;
    return perms.acessos.includes(modulo);
  }

  function getRoleInfo(role) { return PERMISSOES_ROLES[role] || null; }
  function getRoles() { return Object.entries(PERMISSOES_ROLES).map(([id, info]) => ({ id, ...info })); }

  async function login(pin) {
    const user = await validarPin(pin);
    if (!user) return false;

    if (user.id === 'legacy') return window.CH.AuthService.login(pin);

    const session = { role: user.role, nome: user.nome, userId: user.id, loginAt: Date.now() };
    sessionStorage.setItem(window.CH.CONSTANTS.SESSION_KEY, JSON.stringify(session));
    window.CH.AuthService._session = session;

    const isFullAdmin = ['adm','admin'].includes(user.role);
    if (isFullAdmin) {
      // gerarAdminToken é só crypto local — não precisa de rede
      await window.CH.FirebaseService.gerarAdminToken(String(pin).trim());
      // Firebase init dispara em background — não bloqueia o login
      window.CH.FirebaseService.init().catch(e => console.warn('[UserService] Firebase init bg:', e));
    } else {
      window.CH.FirebaseService.clearAdminToken();
    }

    setTimeout(() => {
      window.CH.FirebaseService.init().then(() => window.CH.FirebaseService.subscribeRealtime());
    }, 300);
    setTimeout(() => window.CH.SyncService.pull(), 800);

    window.CH.EventBus.emit('auth:login', { role: user.role });
    return user;
  }

  window.CH.UserService = {
    criarUsuario, atualizarUsuario, desativarUsuario,
    getUsuarios, validarPin, login,
    temAcesso, podeEscrever,
    getRoleInfo, getRoles,
    PERMISSOES_ROLES,
  };

  console.info('%c UserService ✓  (adm | controlador | validador | colaborador | gerente | operador)', 'color:#10b981');
})();
