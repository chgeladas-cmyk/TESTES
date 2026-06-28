# CH Geladas PDV — Fluxo Financeiro

> Baseado na leitura direta de `financeiroService.js`, `vendasService.js`, `estoqueService.js`, `syncService.js`.

---

## 1. Modelo de lançamento

```js
{
  id,
  tipo:       'receita' | 'despesa' | 'estorno',
  categoria:  'venda' | 'compra' | 'avaria' | 'ajuste' | 'cancelamento' | 'outro',
  descricao,
  valor,       // sempre positivo; o tipo define o sinal contábil
  formaPgto,
  referencia,  // vendaId, movimentacaoId — usado para idempotência
  operador,
  data,        // ISO 8601
  dataCurta,   // YYYY-MM-DD
  hora,
  lucro,       // apenas receitas de venda
  itens,       // apenas receitas de venda
  vendaId,     // apenas receitas de venda
}
```

---

## 2. Função central — `_lancar()`

Toda entrada financeira passa por `_lancar()`:

```
_lancar({ tipo, categoria, descricao, valor, formaPgto, referencia, extra })
    │
    ├─ valor <= 0? → retorna null (não registra)
    │
    ├─ referencia informada?
    │       Store.getFinanceiro().some(l => l.referencia === ref && l.tipo === tipo)
    │       ↓ já existe?
    │       → retorna null  ← IDEMPOTÊNCIA: impede duplo lançamento
    │
    ▼ novo lançamento
Store.mutateFinanceiro(fin => fin.unshift(lancamento))
    ← grava em CH_FINANCEIRO (localStorage)
    ← SyncQueue.enqueue('salvar', 'financeiro', lancamentos)
    ← _NUNCA_COLAPSAR → cada enqueue é item separado na fila

EventBus.emit('financeiro:lancado', lancamento)
```

---

## 3. Origens de lançamentos — completo

### 3a. Receita de venda
**Gatilho:** `EventBus.on('venda:finalizada')` — hook automático do `financeiroService`  
**Quem dispara:** `vendasService.finalizarVenda()` → `EventBus.emit('venda:finalizada')`  
**Quando:** somente para vendas com status `'concluida'` (fluxo direto sem aprovação)

```js
registrarReceita(venda)
→ _lancar({
    tipo:       'receita',
    categoria:  'venda',
    descricao:  `Venda #${venda.id.slice(-6)} — N item(ns)`,
    valor:      venda.total,
    formaPgto:  venda.formaPgto,
    referencia: venda.id,       // chave de idempotência
    extra: { lucro, itens, vendaId }
  })
```

### 3b. Receita de venda validada (fluxo de aprovação)
**Gatilho:** chamada direta em `aprovacaoService.validarVenda()`  
**Quando:** após `baixarEstoqueVendaLote()` confirmar, status muda para `'validada'`

```js
FinanceiroService.registrarReceita(venda)
→ mesmo _lancar() acima
→ idempotência por referencia=venda.id garante que não duplica
  mesmo que venda:finalizada tenha sido emitido antes
```

### 3c. Estorno de venda cancelada
**Gatilho:** `EventBus.on('venda:cancelada')` — hook automático  
**Quem dispara:** `vendasService.cancelarVenda()` → `EventBus.emit('venda:cancelada', { vendaId })`

```js
// financeiroService.js hook:
EventBus.on('venda:cancelada', ({ vendaId }) => {
  const venda = window.CH._Store().getVendas().find(v => v.id === vendaId);
  if (venda) registrarEstorno(venda);
});

registrarEstorno(venda)
→ _lancar({
    tipo:       'estorno',
    categoria:  'cancelamento',
    descricao:  `Estorno venda #${venda.id.slice(-6)}`,
    valor:      venda.total,
    referencia: venda.id,       // chave de idempotência
  })
```

**Nota de segurança:** O estorno **só** acontece via EventBus — não é chamado diretamente em `cancelarVenda()`. Isso evita duplo estorno.

### 3d. Despesa de compra de estoque
**Gatilho:** `EventBus.on('estoque:movimentado')` — hook automático  
**Quem dispara:** `estoqueService._registrarMovimentacao()` → `EventBus.emit('estoque:movimentado')`  
**Filtra:** apenas movimentações do tipo `'entrada'`

```js
EventBus.on('estoque:movimentado', mov => {
  if (mov.tipo === 'entrada') registrarCustoCompra(mov);
});

registrarCustoCompra(mov)
→ custo = |mov.custo| * |mov.quantidade|
→ _lancar({
    tipo:       'despesa',
    categoria:  'compra',
    descricao:  `Compra: ${mov.nomeProduto} (N un.)`,
    valor:      custo,
    referencia: mov.id,         // chave de idempotência
  })
```

### 3e. Despesa manual (saidas.html, financeiro.html)
**Quem chama:** páginas de saídas e financeiro diretamente

```js
FinanceiroService.registrarDespesa({ descricao, valor, categoria, formaPgto, referencia })
→ _lancar({ tipo: 'despesa', ... })
```

---

## 4. Idempotência — proteção contra duplo lançamento

```js
if (referencia) {
  const jaExiste = Store.getFinanceiro().some(
    l => l.referencia === referencia && l.tipo === tipo
  );
  if (jaExiste) return null; // silencioso — não lança erro
}
```

**Cobertura:** receitas e estornos de venda (têm `referencia = venda.id`).  
**Sem cobertura:** despesas manuais sem `referencia` informada — podem duplicar se chamadas duas vezes.

---

## 5. Sync com Firestore

```
Store.mutateFinanceiro()
    ↓ _mutate() interno
SyncQueue.enqueue('salvar', 'financeiro', [...lancamentos])
    ↓ _NUNCA_COLAPSAR protege: cada enqueue é item separado
    ↓ (quando online)
FirebaseService.salvar('financeiro', dados)
    → setDoc(doc(db, 'ch_dados', 'financeiro'), {
        dados: [...lancamentos],
        ts,
        adminToken,    // financeiro sempre exige adminToken
      })
```

---

## 6. Consultas disponíveis

| Função | Filtra por | Retorna |
|---|---|---|
| `getLancamentos(opts)` | tipo, categoria, dataDe, dataAte, limit | array de lançamentos |
| `getCaixaDia(data)` | data (padrão: hoje) | `{ receitas, despesas, estornos, saldo, lucro, porForma }` |
| `getFluxoCaixa(dataDe, dataAte)` | período | array por dia `{ data, receitas, despesas, estornos, saldo }` |
| `getResumoMes(ano, mes)` | ano e mês | `{ receitas, despesas, saldo, lucro }` |
| `exportarCSV(dataDe, dataAte)` | período | download CSV |

---

## 7. Saídas (`saidas.html`)

As saídas (compras avulsas, retiradas, despesas operacionais) são um módulo separado do financeiro:

```
saidas.html
    │
    ▼ registro de saída
Store.mutateSaidas(arr => arr.unshift(saida))
    ← CH_SAIDAS (localStorage)
    ← SyncQueue.enqueue('salvar', 'saidas', [...])
    ← _NUNCA_COLAPSAR protege
    ← setDoc(ch_dados/saidas, { dados:[...] })
```

As saídas **não** passam por `FinanceiroService` — são uma coleção separada (`ch_dados/saidas`), não integradas ao DRE do `financeiroService`. A tela `contabil.html` lê ambas as fontes (`CH_FINANCEIRO` + `CH_SAIDAS`) para montar o DRE.

---

## 8. Resumo das coleções tocadas pelo módulo financeiro

| Coleção | Tipo | Operação | Quem | Gatilho |
|---|---|---|---|---|
| `CH_FINANCEIRO` | localStorage | insert | `Store.mutateFinanceiro` | `_lancar()` |
| `ch_dados/financeiro` | Firestore | `setDoc` com `adminToken` | SyncQueue → `firebaseService` | assíncrono |
| `CH_SAIDAS` | localStorage | insert | `Store.mutateSaidas` | `saidas.html` |
| `ch_dados/saidas` | Firestore | `setDoc` com `adminToken` | SyncQueue → `firebaseService` | assíncrono |

---

## 9. O que NÃO está integrado ao `financeiroService`

| Módulo | Situação |
|---|---|
| `cambio.html` | Lançamentos de câmbio vão para `CH_CAMBIO` / `ch_dados/cambio` — **não** para `CH_FINANCEIRO` |
| `saidas.html` | Coleção separada `CH_SAIDAS` — `contabil.html` consolida |
| `fiado.html` | Saldo de fiado em `CH_FIADO` — sem integração automática com financeiro |
| `ponto.html` | Nenhuma integração financeira |
| Auditoria financeira | `AuditService.auditarFinanceiro()` existe mas **não** é chamada automaticamente pelos hooks — precisa ser chamada manualmente |
