# CH Geladas PDV — Arquitetura de Persistência

> Gerado por análise direta do código-fonte (TESTES-main).  
> Proibido adicionar informações não confirmadas no código.

---

## 1. Duas camadas de persistência

O sistema tem **duas camadas separadas** que nunca se misturam:

```
localStorage (offline-first)
    ↓  via SyncQueue.enqueue()
Firestore (sync assíncrono)
```

Toda escrita passa **primeiro** pelo `localStorage` via `Store.mutate*()`.  
A subida para o Firestore é feita pela `SyncQueue` em background — exceto nas **Firebase Transactions** do `estoqueService`, que escrevem direto no Firestore e depois atualizam o `localStorage` como confirmação.

---

## 2. Estrutura do Firestore

O Firestore tem **dois padrões de documento** distintos:

### Padrão A — Coleção `vendas` (documentos individuais)
```
vendas/
  {vendaId}          ← cada venda é um documento próprio
  {vendaId}
  ...
```
Escrita via `batch.set(ref, venda)` — um documento por venda.

### Padrão B — Documento envelope em `ch_dados` (array no campo `dados`)
```
ch_dados/
  estoque            ← { dados: [...produtos], ts, adminToken }
  config             ← { dados: {...config},   ts, adminToken }
  fiado              ← { dados: [...fiados],   ts }
  comandas           ← { dados: [...comandas], ts }
  pedidos            ← { dados: [...pedidos],  ts }
  saidas             ← { dados: [...saidas],   ts }
  financeiro         ← { dados: [...lancamentos], ts, adminToken }
  ponto              ← { dados: [...pontos],   ts, adminToken }
  validade           ← { dados: [...lotes],    ts }
  contagens          ← { dados: [...contagens], ts }
  cambio             ← { dados: [...cambios],  ts }
  categorias         ← (via Store.mutateCategorias → SyncQueue)
  fornecedores       ← (via Store.mutateFornecedores → SyncQueue)
  movimentacoes      ← via Transaction (dentro de estoqueService)
  usuarios           ← via onSnapshot (leitura RT, escrita via userService)
```

> **Atenção:** `auditoria` e `movimentacoes` são `_localOnly` no `storeService` —  
> nunca sobem via SyncQueue. `movimentacoes` sobe **somente** via Firebase Transaction dentro de `estoqueService`.

---

## 3. Mapa completo — quem escreve em cada coleção

| Coleção Firestore | Quem escreve | Como | Via |
|---|---|---|---|
| `vendas/{id}` | `vendasService.finalizarVenda()` | `batch.set` por documento | `SyncQueue.enqueue('salvar','vendas')` → `firebaseService.salvar()` |
| `vendas/{id}` | `vendasService.cancelarVenda()` | `batch.set merge` | `SyncQueue.enqueue('atualizar','vendas')` → `firebaseService.atualizar()` |
| `ch_dados/estoque` | `estoqueService._registrarMovimentacao()` | `tx.set` (Transaction) | Direto — `FirebaseService.runTransaction()` |
| `ch_dados/estoque` | `estoqueService.baixarEstoqueVendaLote()` | `tx.set` (Transaction) | Direto — `FirebaseService.runTransaction()` |
| `ch_dados/estoque` | `Store.mutateEstoque()` (fallback offline) | `localStorage` → SyncQueue | `SyncQueue.enqueue('salvar','estoque')` |
| `movimentacoes/{id}` | `estoqueService._registrarMovimentacao()` | `tx.set` dentro da Transaction | Direto — junto com `ch_dados/estoque` na mesma Transaction |
| `movimentacoes/{id}` | `estoqueService.baixarEstoqueVendaLote()` | `tx.set` dentro da Transaction | Direto — junto com `ch_dados/estoque` na mesma Transaction |
| `ch_dados/financeiro` | `financeiroService._lancar()` via `Store.mutateFinanceiro()` | `setDoc` envelope | `SyncQueue.enqueue('salvar','financeiro')` |
| `ch_dados/saidas` | `saidas.html` via `Store.mutateSaidas()` | `setDoc` envelope | `SyncQueue.enqueue('salvar','saidas')` |
| `ch_dados/validade` | `validade.html` via `Store.mutateValidade()` | `setDoc` envelope | `SyncQueue.enqueue('salvar','validade')` |
| `ch_dados/ponto` | `ponto.html` via `Store.mutatePonto()` | `setDoc` envelope | `SyncQueue.enqueue('salvar','ponto')` |
| `ch_dados/fiado` | páginas de fiado via `Store.mutateFiado()` | `setDoc` envelope (sem adminToken) | `SyncQueue.enqueue('salvar','fiado')` |
| `ch_dados/comandas` | `comanda.html` via `Store.mutateComandas()` | `setDoc` envelope (sem adminToken) | `SyncQueue.enqueue('salvar','comandas')` |
| `ch_dados/cambio` | `cambio.html` via `Store.mutateCambio()` | `setDoc` envelope (sem adminToken) | `SyncQueue.enqueue('salvar','cambio')` |
| `ch_dados/config` | admin via `Store.mutateConfig()` | `setDoc` envelope | `SyncQueue.enqueue('salvar','config')` |
| `ch_dados/contagens` | `contagemService` via `Store.mutateContagens()` | `setDoc` envelope | `SyncQueue.enqueue('salvar','contagens')` |
| `ch_dados/categorias` | `estoqueService.adicionarCategoria()` | `setDoc` envelope | `SyncQueue` (via `Store.mutateCategorias`) |
| `ch_dados/fornecedores` | `estoqueService.adicionarFornecedor()` | `setDoc` envelope | `SyncQueue` (via `Store.mutateFornecedores`) |
| `ch_dados/auditoria` | **NUNCA** sobe ao Firestore | `_localOnly` | Apenas localStorage |
| `ch_dados/movimentacoes` | **NUNCA** via SyncQueue | `_localOnly` | Somente via Transaction do estoqueService |

---

## 4. Coleções com proteção `_NUNCA_COLAPSAR`

O `syncService` protege as seguintes coleções de colapso na fila:

```js
const _NUNCA_COLAPSAR = new Set([
  'vendas', 'saidas', 'financeiro', 'movimentacoes', 'ponto', 'validade', 'contagens'
]);
```

Colapsar significa: se dois enqueues da mesma coleção ficam pendentes antes do Firebase processar, o segundo sobrescreve o primeiro. Para coleções de histórico (append-only), isso apaga registros. As coleções acima **nunca** colapsam — cada enqueue gera um item separado na fila.

---

## 5. Coleções que exigem `adminToken`

O `firebaseService.salvar()` injeta `adminToken` por padrão, **exceto** nas coleções explicitamente isentas:

```js
const _semAdminToken = new Set(['comandas', 'fiado', 'cambio']);
```

Essas três coleções podem ser escritas por qualquer usuário autenticado sem o token de admin.

---

## 6. Fluxo de dados — visão geral

```
PDV / Tela
    │
    ▼
Store.mutate*()          ← sempre o primeiro passo
    │
    ├─► localStorage     ← persistência imediata (offline-first)
    │
    └─► SyncQueue.enqueue()
              │
              ▼ (quando online + Firebase pronto)
        FirebaseService.salvar/atualizar/deletar()
              │
              ├─► batch.set()   → coleção "vendas" (documentos individuais)
              └─► setDoc()      → "ch_dados/<colecao>" (documento envelope)

estoqueService (caminho especial):
    │
    ▼
FirebaseService.runTransaction()
    ├─► tx.get(ch_dados/estoque)    ← lê estado atual
    ├─► tx.set(ch_dados/estoque)    ← atualiza quantidades
    └─► tx.set(movimentacoes/{id})  ← registra movimentação
    │
    ▼
Store.mutateEstoque()   ← confirma localmente após Transaction
```

---

## 7. `integrityService` — status

```js
/* integrityService.js — removido. Arquivo stub para evitar 404. */
```

O `integrityService` foi removido do sistema. O arquivo existe como stub vazio.  
O `vendasService` ainda referencia `window.CH.IntegrityService?.confirmarBaixaComRollback` mas cai no caminho alternativo (`baixarEstoqueVendaLote`) quando o serviço não está presente.
