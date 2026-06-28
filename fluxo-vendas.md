# CH Geladas PDV — Fluxo de Vendas

> Baseado na leitura direta de `vendasService.js`, `financeiroService.js`, `aprovacaoService.js`, `estoqueService.js`, `auditService.js`.

---

## 1. Ponto de entrada

```
index.html → CartService.finalize() → VendasService.finalizarVenda(cart, formaPgto, extras)
```

`finalizarVenda()` é **síncrona** — retorna o objeto `venda` imediatamente antes de qualquer operação de estoque ou financeiro. Isso é intencional: o `CartService` precisa do retorno síncrono para limpar o carrinho e atualizar a UI.

---

## 2. Objeto venda criado

```js
{
  id,               // Utils.generateId()
  dataCurta,        // 'YYYY-MM-DD' (fuso local)
  data,             // 'DD/MM/YYYY'
  hora,             // 'HH:MM'
  criadoEm,         // ISO 8601
  itens,            // array do carrinho
  total,
  subtotal,
  desconto,
  lucro,            // soma de (preco - custo) * qtd por item - desconto
  formaPgto,
  origem: 'PDV',
  operador,         // AuthService.getNome()
  role,             // AuthService.getRole()
  status,           // 'pendente' ou 'concluida' (ver seção 3)
  _fbSynced: false,
  _troco,
  _parcelaDinheiro,
  _parcelaRestante,
  _formaRestante,
}
```

---

## 3. Decisão de status — requer aprovação?

```
PermissoesService.getFlag(role, 'vendas_requer_aprovacao')
        │
        ├─► true  → status = 'pendente'
        │           EstoqueService.reservarEstoque()   ← soft-bloqueia unidades
        │           EventBus.emit('venda:pendente')
        │           → para aqui. Sem estoque. Sem financeiro.
        │
        └─► false → status = 'concluida'
                    _processarEfeitosAsync(venda)      ← em background
                    EventBus.emit('venda:finalizada')
```

**Roles que NÃO requerem aprovação por padrão** (fallback sem PermissoesService):  
`adm`, `admin`, `gerente`, `operador`, `pdv`, `entregador`

---

## 4. Gravações imediatas (síncronas, antes de retornar)

| O quê | Onde | Como |
|---|---|---|
| Venda no Store local | `localStorage` (CH_VENDAS) | `Store.mutateVendas(v => v.unshift(venda))` |
| Venda na fila de sync | `localStorage` (CH_SYNC_QUEUE) | `SyncQueue.enqueue('salvar', 'vendas', [venda])` |
| Carrinho limpo | memória | `cart.clear()` |

---

## 5. Fluxo `concluida` — efeitos assíncronos

`_processarEfeitosAsync(venda)` é chamada com `.catch()` — erros são logados mas não travam a UI.

### 5a. Baixa de estoque

Ordem de tentativa:

```
1. IntegrityService.confirmarBaixaComRollback(venda)   ← se disponível
        ↓ falhou?
        EventBus.emit('integrity:venda_sem_baixa')     ← registra divergência

2. EstoqueService.baixarEstoqueVendaLote(venda)         ← caminho atual (IS removido)
        ↓ falhou?
        EventBus.emit('integrity:venda_sem_baixa')

3. Store.mutateEstoque() direto                         ← fallback local sem Firebase
```

`baixarEstoqueVendaLote()` executa **uma única Firebase Transaction** para todos os itens da venda:
- Lê `ch_dados/estoque` uma vez
- Valida disponibilidade de cada item
- Subtrai tudo atomicamente
- Escreve `ch_dados/estoque` atualizado
- Cria um documento `movimentacoes/{id}` para cada item — tudo na mesma Transaction

### 5b. Financeiro

**Não** é chamado diretamente em `_processarEfeitosAsync`.  
O registro financeiro acontece via **hook de evento**:

```js
// financeiroService.js — linha de boot
EventBus.on('venda:finalizada', venda => registrarReceita(venda));
```

`registrarReceita()` → `_lancar()`:
- Checa idempotência: se já existe lançamento com `referencia === venda.id` e `tipo === 'receita'`, ignora
- Cria lançamento `{ tipo:'receita', categoria:'venda', valor: venda.total, referencia: venda.id, ... }`
- `Store.mutateFinanceiro(fin => fin.unshift(lancamento))` → `SyncQueue.enqueue('salvar','financeiro')`

### 5c. Auditoria

```js
// auditService.js — linha de boot
EventBus.on('venda:finalizada', venda => auditarVenda(venda));
```

Grava em `Store.mutateAuditoria()` — **somente localStorage**, nunca sobe ao Firestore (`_localOnly`).

---

## 6. Fluxo `pendente` — aprovação

```
status='pendente'
    │
    ▼ (aprovacao.html — controlador)
AprovacaoService.aprovarVenda(vendaId)
    │
    ├─► Store.mutateVendas → status='aprovada'
    ├─► SyncQueue.enqueue('atualizar','vendas')
    └─► EventBus.emit('venda:aprovada')

    │
    ▼ (aprovacao.html — validador)
AprovacaoService.validarVenda(vendaId)
    │
    ├─► EstoqueService.baixarEstoqueVendaLote(venda)   ← Transaction Firebase
    │       ↓ ok?
    ├─► Store.mutateVendas → status='validada'
    ├─► SyncQueue.enqueue('atualizar','vendas')
    ├─► FinanceiroService.registrarReceita(venda)       ← lançamento financeiro
    ├─► EstoqueService.liberarReserva(vendaId)          ← libera soft-block
    └─► EventBus.emit('venda:validada')
```

**Regra inviolável:** `status='validada'` nunca é definido antes de `baixarEstoqueVendaLote()` confirmar. Se a baixa falhar, o status vai para `'erro_validacao'` e aparece na aba "⚠️ Erros" do `aprovacao.html`.

---

## 7. Cancelamento de venda

```
VendasService.cancelarVenda(vendaId)
    │
    ├─► EstoqueService.cancelarVenda(vendaId, itens)   ← estorna estoque (se concluida/validada)
    ├─► Store.mutateVendas → status='cancelada', canceladaEm, canceladaPor
    ├─► SyncQueue.enqueue('atualizar','vendas')
    └─► EventBus.emit('venda:cancelada', { vendaId, operador })
            │
            └─► financeiroService hook:
                    getVendas().find(vendaId) → registrarEstorno(venda)
                    → _lancar({ tipo:'estorno', referencia: vendaId })
                    → SyncQueue.enqueue('salvar','financeiro')
```

**Nota:** O estorno financeiro é feito via `EventBus.on('venda:cancelada')` no `financeiroService` — não diretamente no `cancelarVenda()`. Isso evita duplo estorno.

---

## 8. Sync com Firestore — vendas

O `firebaseService.salvar('vendas', dados)` tem lógica especial:

```js
// Filtra apenas vendas não sincronizadas
const pendentes = dados.filter(v => v?.id && !v._fbSynced).slice(0, 50);

// Um documento por venda (não envelope)
const batch = writeBatch(db);
pendentes.forEach(v => {
  const ref = doc(db, 'vendas', v.id);
  batch.set(ref, { ...v, _fbSynced: true, syncedAt: nowISO() });
});
await batch.commit();

// Marca como sincronizadas no localStorage
// Store.invalidate('vendas') para forçar re-leitura do cache
```

`atualizar('vendas')` usa `batch.set(..., { merge: true })` — atualiza campos sem sobrescrever o documento inteiro.

---

## 9. Resumo das coleções tocadas por uma venda

| Coleção | Operação | Quem | Quando |
|---|---|---|---|
| `CH_VENDAS` (localStorage) | insert | `Store.mutateVendas` | imediato |
| `vendas/{id}` (Firestore) | `batch.set` | `SyncQueue` → `firebaseService` | assíncrono |
| `CH_FINANCEIRO` (localStorage) | insert | `Store.mutateFinanceiro` | via EventBus `venda:finalizada` |
| `ch_dados/financeiro` (Firestore) | `setDoc` | `SyncQueue` | assíncrono |
| `ch_dados/estoque` (Firestore) | `tx.set` Transaction | `estoqueService` | assíncrono (após retorno síncrono) |
| `movimentacoes/{id}` (Firestore) | `tx.set` Transaction | `estoqueService` | junto com estoque |
| `CH_AUDITORIA` (localStorage) | insert | `Store.mutateAuditoria` | via EventBus |
| `CH_RESERVAS_ESTOQUE` (localStorage) | insert/delete | `estoqueService` | só em fluxo pendente |
