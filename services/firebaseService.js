'use strict';
/**
 * services/firebaseService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * RESPONSABILIDADE ÚNICA: comunicação com o Firebase/Firestore.
 *   init()           → autenticação anônima + inicialização
 *   salvar()         → grava coleção no Firestore
 *   ler()            → lê coleção do Firestore
 *   deletar()        → soft-delete de documentos
 *   atualizar()      → merge de documentos
 *   subscribeRealtime() → listeners em tempo real
 *
 * MULTI-TENANT (SaaS):
 *   Quando existe uma sessão SaaS ativa (window.CH.SaasService?.getEmpresaId()),
 *   todos os caminhos do Firestore são roteados para:
 *     ch_dados/{col}     → saas_dados/{empresaId}/ch_dados/{col}
 *     vendas/{id}        → saas_dados/{empresaId}/vendas/{id}
 *     movimentacoes/{id} → saas_dados/{empresaId}/movimentacoes/{id}
 *     reservasEstoque/   → saas_dados/{empresaId}/reservasEstoque/
 *   Assim cada empresa tem seus dados 100% isolados.
 *   Sem sessão SaaS: comportamento original (instalação local única).
 *
 * PARA CORRIGIR: toque APENAS este arquivo.
 * DEPENDÊNCIAS:  window.CH.{CONSTANTS, Utils, EventBus, Store}
 */
(function () {
  const { CONSTANTS, Utils, EventBus } = window.CH;

  const FirebaseService = (() => {
    const CONFIG = {
      apiKey:            'AIzaSyDdFvTRQQmomMiLD0byrBwGZnitSC0zwus',
      authDomain:        'new-ch-geladas.firebaseapp.com',
      projectId:         'new-ch-geladas',
      storageBucket:     'new-ch-geladas.firebasestorage.app',
      messagingSenderId: '898297448757',
      appId:             '1:898297448757:web:d59cb5336d61d19ad9a47c',
      measurementId:     'G-QYJRW9YEPW',
    };

    let _db=null, _auth=null, _fb=null;

    // ── Roteamento Multi-Tenant ─────────────────────────────────────
    // Retorna o empresaId da sessão SaaS ativa, ou null em instalação local.
    function _empresaId() {
      try { return window.CH?.SaasService?.getEmpresaId?.() || null; }
      catch (_) { return null; }
    }

    // Retorna o caminho do documento envelope ch_dados.
    // SaaS:  saas_dados/{empresaId}/ch_dados/{col}
    // Local: ch_dados/{col}
    function _chDadosRef(col) {
      const eid = _empresaId();
      if (eid) return _fb.doc(_db, 'saas_dados', eid, 'ch_dados', col);
      return _fb.doc(_db, 'ch_dados', col);
    }

    // Retorna a CollectionReference de vendas.
    // SaaS:  saas_dados/{empresaId}/vendas
    // Local: vendas
    function _vendasCol() {
      const eid = _empresaId();
      if (eid) return _fb.collection(_db, 'saas_dados', eid, 'vendas');
      return _fb.collection(_db, 'vendas');
    }

    // Retorna DocReference de uma venda.
    function _vendaRef(vendaId) {
      const eid = _empresaId();
      if (eid) return _fb.doc(_db, 'saas_dados', eid, 'vendas', vendaId);
      return _fb.doc(_db, 'vendas', vendaId);
    }

    // Retorna CollectionReference de movimentacoes.
    function _movCol() {
      const eid = _empresaId();
      if (eid) return _fb.collection(_db, 'saas_dados', eid, 'movimentacoes');
      return _fb.collection(_db, 'movimentacoes');
    }

    // Retorna DocReference de movimentacao.
    function _movRef(movId) {
      const eid = _empresaId();
      if (eid) return _fb.doc(_db, 'saas_dados', eid, 'movimentacoes', movId);
      return _fb.doc(_db, 'movimentacoes', movId);
    }

    // Retorna DocReference de reserva.
    function _reservaRef(vendaId) {
      const eid = _empresaId();
      if (eid) return _fb.doc(_db, 'saas_dados', eid, 'reservasEstoque', vendaId);
      return _fb.doc(_db, 'reservasEstoque', vendaId);
    }
    let _ready=false, _adminToken=null;
    let _unsubscribers=[];

    async function init() {
      if (_ready) return true;
      if (!CONFIG.apiKey) { console.info('[Firebase] Sem config — offline.'); return false; }
      try {
        const { initializeApp, getApps, getApp } =
          await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
        _fb   = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        const auth = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');

        const app = getApps().length ? getApp() : initializeApp(CONFIG);
        _db   = _fb.getFirestore(app);
        _auth = auth.getAuth(app);

        if (!_auth.currentUser) {
          await auth.signInAnonymously(_auth);
          console.info('[Firebase] ✓ Auth anônima. UID:', _auth.currentUser?.uid);
        }
        _ready = true;

        if (!_adminToken) {
          const saved = sessionStorage.getItem('CH_ADMIN_TOKEN');
          if (saved) { _adminToken=saved; console.info('[Firebase] ✓ adminToken restaurado.'); }
        }

        console.info('[Firebase] ✓ Projeto:', CONFIG.projectId);
        EventBus.emit('firebase:ready');
        _subscribeRealtime();
        return true;
      } catch(e) { console.warn('[Firebase] Falha:', e.message); return false; }
    }

    function _subscribeRealtime() {
      _unsubscribers.forEach(fn=>{try{fn();}catch(_){}});
      _unsubscribers=[];
      const role = window.CH?.AuthService?.getRole?.()??null;
      if (!role||!_db||!_fb) return;

      const Store = window.CH.Store;

      const colsRT = (['admin','adm'].includes(role))
        ? ['estoque','config','fiado','comandas','pedidos','saidas','financeiro','usuarios']
        : ['estoque','config','usuarios'];

      // Listener RT de vendas: apenas as 50 mais recentes.
      // Vendas antigas são buscadas sob demanda via VendaRepository.buscarPagina().
      try {
        const q = _fb.query(_vendasCol(),_fb.orderBy('criadoEm','desc'),_fb.limit(50));
        const unsub = _fb.onSnapshot(q, snap=>{
          const vendas=snap.docs.map(d=>({...d.data(),_fbSynced:true})).filter(v=>!v._deleted);
          try{localStorage.setItem(CONSTANTS.DB.VENDAS,JSON.stringify(vendas));}catch(_){}
          Store?.invalidate('vendas');
          EventBus.emit('store:updated','vendas');
          EventBus.emit('store:vendas');
          EventBus.emit('sync:ok','vendas');
        }, err=>console.warn('[RT] vendas:',err.code));
        _unsubscribers.push(unsub);
      } catch(e){console.warn('[RT] vendas subscribe falhou:',e.message);}

      // Coleções append-only: o snapshot NAO sobrescreve o local.
      // Faz merge por ID para não perder registros criados offline ou em outro dispositivo.
      const _APPEND_ONLY_RT = new Set(['saidas','financeiro','ponto','movimentacoes','contagens']);

      colsRT.forEach(col=>{
        try {
          const unsub = _fb.onSnapshot(_chDadosRef(col), snap=>{
            if (!snap.exists()) return;
            const dados=snap.data()?.dados;
            if (!dados) return;
            if (col==='usuarios') {
              if (Array.isArray(dados)) {
                try{localStorage.setItem('CH_USERS',JSON.stringify(dados));}catch(_){}
                EventBus.emit('usuarios:atualizados',dados);
              }
              return;
            }
            const key=CONSTANTS.DB[col.toUpperCase()];
            if (!key) return;

            if (_APPEND_ONLY_RT.has(col) && Array.isArray(dados)) {
              // Merge: preserva registros locais que ainda não chegaram no Firestore
              try {
                const local = JSON.parse(localStorage.getItem(key)||'[]');
                const fbIds = new Set(dados.map(d=>d.id).filter(Boolean));
                // Registros locais sem ID no Firestore = ainda não sincronizados, mantém
                const soPendentes = local.filter(d=>d.id && !fbIds.has(d.id));
                const merged = [...soPendentes, ...dados];
                // Ordena por criadoEm desc para manter consistência
                merged.sort((a,b)=>(b.criadoEm||'').localeCompare(a.criadoEm||''));
                localStorage.setItem(key, JSON.stringify(merged));
              } catch(_) {
                // Fallback: substitui normalmente
                try{localStorage.setItem(key,JSON.stringify(dados));}catch(__) {}
              }
            } else {
              try{localStorage.setItem(key,JSON.stringify(dados));}catch(_){}
            }

            Store?.invalidate(col);
            EventBus.emit('store:updated',col);
            EventBus.emit(`store:${col}`);
            EventBus.emit('sync:ok',col);
          }, err=>console.warn('[RT]',col,err.code));
          _unsubscribers.push(unsub);
        } catch(e){console.warn('[RT] subscribe falhou:',col,e.message);}
      });
    }

    async function gerarAdminToken(pin) {
      if (!_auth?.currentUser) return null;
      const uid=_auth.currentUser.uid;
      const raw=`${uid}:${pin}:ch_geladas_admin`;
      const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
      _adminToken=Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
      sessionStorage.setItem('CH_ADMIN_TOKEN',_adminToken);
      return _adminToken;
    }

    async function salvar(colName, dados) {
      if (!_ready||!_db||!_fb) return false;
      try {
        if (colName==='vendas') {
          const pendentes=Array.isArray(dados)?dados.filter(v=>v?.id&&!v._fbSynced).slice(0,50):[];
          if (!pendentes.length) return true;
          const batch=_fb.writeBatch(_db);
          pendentes.forEach(v=>{const ref=_vendaRef(v.id);batch.set(ref,{...v,_fbSynced:true,syncedAt:Utils.nowISO()});});
          await batch.commit();
          const key=CONSTANTS.DB.VENDAS;
          try{
            const vl=JSON.parse(localStorage.getItem(key)||'[]');
            const ids=new Set(pendentes.map(v=>v.id));
            vl.forEach(v=>{if(ids.has(v.id))v._fbSynced=true;});
            localStorage.setItem(key,JSON.stringify(vl));
            window.CH.Store?.invalidate('vendas');
          }catch(_){}
          console.info(`[Firebase] ✓ ${pendentes.length} venda(s) sincronizadas.`);
        } else {
          const _semAdminToken=new Set(['comandas','fiado','cambio']);
          const docData={dados,ts:Utils.nowISO()};
          if (_adminToken&&!_semAdminToken.has(colName)) docData.adminToken=_adminToken;
          await _fb.setDoc(_chDadosRef(colName),docData);
        }
        return true;
      } catch(e){console.warn('[Firebase] Salvar falhou:',colName,e.code||e.message);return false;}
    }

    async function deletar(colName, dados) {
      if (!_ready||!_db||!_fb) return false;
      try {
        if (colName==='vendas') {
          const ids=Array.isArray(dados)?dados:[dados];
          const batch=_fb.writeBatch(_db);
          ids.forEach(id=>{
            const ref=_vendaRef(typeof id==='string'?id:id.id);
            const d={_deleted:true,_fbSynced:true,updatedAt:Utils.nowISO()};
            if(_adminToken) d.adminToken=_adminToken;
            batch.set(ref,d,{merge:true});
          });
          await batch.commit();
          console.info('[Firebase] ✓ venda(s) deletada(s):',ids.length);
        }
        return true;
      } catch(e){console.warn('[Firebase] Deletar falhou:',colName,e.code||e.message);return false;}
    }

    async function atualizar(colName, dados) {
      if (!_ready||!_db||!_fb) return false;
      try {
        if (colName==='vendas') {
          const itens=Array.isArray(dados)?dados:[dados];
          const batch=_fb.writeBatch(_db);
          itens.forEach(v=>{const ref=_vendaRef(v.id);batch.set(ref,{...v,_fbSynced:true,updatedAt:Utils.nowISO()},{merge:true});});
          await batch.commit();
          console.info('[Firebase] ✓ venda(s) atualizada(s):',itens.length);
        }
        return true;
      } catch(e){console.warn('[Firebase] Atualizar falhou:',colName,e.code||e.message);return false;}
    }

    async function ler(colName, opts = {}) {
      if (!_ready||!_db||!_fb) return null;
      try {
        if (colName==='vendas') {
          // Paginação: limite padrão 50. Cursor opcional via opts.cursor (último DocumentSnapshot).
          const limite = opts.limite || 50;
          let q = _fb.query(
            _vendasCol(),
            _fb.orderBy('criadoEm','desc'),
            _fb.limit(limite)
          );
          if (opts.cursor) q = _fb.query(
            _vendasCol(),
            _fb.orderBy('criadoEm','desc'),
            _fb.startAfter(opts.cursor),
            _fb.limit(limite)
          );
          const snap = await _fb.getDocs(q);
          const docs = snap.docs.map(d=>({...d.data(),_fbSynced:true,_docSnapshot:d})).filter(v=>!v._deleted);
          const ultimoDoc = snap.docs[snap.docs.length - 1] || null;
          const temMais   = snap.docs.length === limite;
          return { docs, ultimoDoc, temMais, pagina: opts.pagina || 1 };
        } else {
          const snap=await _fb.getDoc(_chDadosRef(colName));
          return snap.exists()?snap.data().dados:null;
        }
      } catch(e){console.warn('[Firebase] Ler falhou:',colName,e.code||e.message);return null;}
    }

    function _req() { if(!_ready||!_db||!_fb) throw new Error('Firebase não inicializado.'); }

    return {
      init, salvar, ler, deletar, atualizar,
      isReady:           () => _ready,
      getUID:            () => _auth?.currentUser?.uid||null,
      getConfig:         () => ({...CONFIG}),
      setConfig(c)       { Object.assign(CONFIG,c); window.CH.Store?.mutateConfig(cfg=>{cfg.firebase={...c};}); },
      gerarAdminToken,
      getAdminToken:     () => _adminToken,
      clearAdminToken:   () => { _adminToken=null; sessionStorage.removeItem('CH_ADMIN_TOKEN'); },
      subscribeRealtime: _subscribeRealtime,
      runTransaction(fn) { _req(); return _fb.runTransaction(_db,fn); },
      docRef(colPath,docId) { _req(); return docId?_fb.doc(_db,colPath,docId):_fb.doc(_db,colPath); },
      colRef(colPath)    { _req(); return _fb.collection(_db,colPath); },
      newDocRef(colPath) { _req(); return _fb.doc(_fb.collection(_db,colPath)); },
      getBatch()         { _req(); return _fb.writeBatch(_db); },
      serverTimestamp()  { _req(); return _fb.serverTimestamp(); },
    };
  })();

  window.CH.FirebaseService = FirebaseService;
  console.info('%c firebaseService.js ✓','color:#10b981;font-weight:bold');
})();
