# CH Geladas PDV — Fluxo de Estoque

> Baseado na leitura direta de `estoqueService.js`, `syncService.js`, `firebaseService.js`, `auditService.js`.

---

## 1. Modelo de dados

### Produto (`ch_dados/estoque → dados[]`)
```js
{
  id, nome, categoria,
  precoVenda,     // alias: precoUn
  precoCusto,     // alias: custoUn
  estoqueAtual,   // alias: qtdUn — quantidade física
  estoqueMinimo,
  ativo,
  controlaEstoque, // false = produto não desconta estoque
  unidade,         // 'UN', 'CX', etc.
  fornecedorId,
  packs: [{ label, qtd, preco }],  // embalagens (ex: '12x')
  createdAt, updatedAt,
  // campos calculados em runtime (não persistidos):
  qtdReservada,        // soma de reservas de vendas pendentes
  estoqueDisponivel,   // estoqueAtual - qtdReservada
}
```

### Movimentação (`movimentacoes/{id}` no Firestore, `CH_MOVIMENTACOES` local)
```js
{
  id, produtoId, nomeProduto,
  tipo,          // 'entrada' | 'venda' | 'avaria' | 'ajuste' | 'cancelamento'
  quantidade,    // negativo para saída, positivo para entrada
  estoqueAntes, estoqueDepois,
  origem,        // 'compra' | 'venda:<vendaId>' | 'cancelamento:<vendaId>' | 'avaria' | 'inventario'
  operador,
  observacao,
  custo,
  fornecedorId,
  timestamp, dataCurta,
  vendaId,       // quando origem é 'venda:<id>'
  adminToken,    // só nas escritas Firebase
}
```

---

## 2. Operações disponíveis

| Função | Tipo | Descrição |
|---|---|---|
| `adicionarProduto(dados)` | Síncrona | Cria produto no Store + SyncQueue |
| `atualizarProduto(id, campos)` | Síncrona | Atualiza produto + auditoria + SyncQueue |
| `removerProduto(id)` | Síncrona | Soft delete (`ativo: false`) + SyncQueue |
| `entradaEstoque(prodId, qtd, opts)` | Async | Entrada via Transaction Firebase |
| `baixarEstoqueVenda(prodId, qtd, vendaId)` | Async | Baixa unitária (idempotente por vendaId) |
| `baixarEstoqueVendaLote(venda)` | Async | **Preferencial** — 1 Transaction por venda inteira |
| `registrarAvaria(prodId, qtd, obs)` | Async | Saída tipo 'avaria' via Transaction |
| `ajustarEstoque(prodId, novaQtd, obs)` | Async | Calcula delta e aplica via Transaction |
| `cancelarVenda(vendaId, itens)` | Async | Estorna todos os itens (loop de Transactions) |
| `reconciliarEstoque(vendas)` | Async | Detecta e corrige vendas sem baixa |

---

## 3. Caminho principal — `_registrarMovimentacao()`

Toda operação de entrada/saída passa por `_registrarMovimentacao()`:

```
_registrarMovimentacao({ produtoId, tipo, quantidade, ... })
    │
    ├─ online + Firebase pronto + adminToken?
    │       │
    │       ▼  SIM
    │   FirebaseService.runTransaction(async tx => {
    │       tx.get(ch_dados/estoque)          ← lê quantidade atual
    │       valida disponibilidade (saídas)   ← erro se insuficiente
    │       tx.set(ch_dados/estoque, novosDados)   ← atualiza produto
    │       tx.set(movimentacoes/{id}, movDoc)     ← cria movimentação
    │   })
    │       │
    │       ▼ sucesso
    │   Store.mutateEstoque()  ← confirma localmente (sem SyncQueue — _semSync:true)
    │
    └─ offline OU Firebase não pronto OU sem adminToken?
            │
            ▼  NÃO
        _movimentacaoLocal()
            Store.mutateEstoque()   ← atualiza localStorage
            (SyncQueue sobe o estoque quando online)
    │
    ▼ (sempre, independente do caminho)
Store.mutateMovimentacoes(movs => movs.unshift(mov))
    ← registra movimentação no localStorage (CH_MOVIMENTACOES)
    ← _localOnly: NÃO sobe via SyncQueue

AuditService.auditarMovimentacao(mov)
    ← registra auditoria em localStorage (CH_AUDITORIA)
    ← _localOnly
```

---

## 4. Baixa em lote — `baixarEstoqueVendaLote()` (caminho preferencial)

Este é o caminho usado para vendas finalizadas. Uma única Transaction para todos os itens:

```
baixarEstoqueVendaLote(venda)
    │
    ├─ Filtra itens:
    │   - prod.controlaEstoque !== false
    │   - Não processados ainda (idempotência via movimentacoes)
    │   - Converte label (UNID / pack) em unidades
    │
    ├─ online + Firebase + adminToken?
    │       │
    │       ▼ SIM — UMA TRANSACTION para tudo
    │   tx.get(ch_dados/estoque)          ← 1 leitura
    │   Para cada item:
    │       valida qtd disponível
    │       calcula novo estoque
    │       atualiza Map em memória
    │   tx.set(ch_dados/estoque, [...Map.values()])  ← 1 escrita
    │   Para cada item processado:
    │       tx.set(movimentacoes/{id}, movDoc)        ← N escritas
    │
    │   Pós-Transaction (fora do tx):
    │       Store.mutateEstoque()   ← confirma local (_semSync:true)
    │       AuditService.auditarMovimentacao() para cada item
    │
    └─ offline?
            _baixarLoteLocal(venda, itensParaBaixar)
                Para cada item:
                    Store.mutateEstoque()       ← localStorage
                    Store.mutateMovimentacoes() ← localStorage
                    AuditService.auditarMovimentacao()
```

**Por que `_semSync: true` no `mutateEstoque` pós-Transaction?**  
Porque o Firestore já foi atualizado pela Transaction. Fazer SyncQueue sobrescrever o documento logo depois seria desnecessário e causaria uma segunda escrita no Firestore com dados idênticos.

---

## 5. Reserva de estoque (vendas pendentes)

Para evitar que dois colaboradores vendam o mesmo item além do estoque disponível enquanto as vendas aguardam aprovação:

```
Venda entra como 'pendente'
    │
    ▼
EstoqueService.reservarEstoque(vendaId, itens)
    │
    ▼
localStorage['CH_RESERVAS_ESTOQUE'] = {
  [vendaId]: { [prodId]: qtdReservada, ... }
}
    │
    ▼ (cálculo de estoqueDisponivel)
estoqueDisponivel = estoqueAtual - Σ(qtdReservada de todas as vendas pendentes)

    │
    ▼ (quando venda é validada ou rejeitada)
EstoqueService.liberarReserva(vendaId)
    localStorage['CH_RESERVAS_ESTOQUE'][vendaId] = undefined
```

**Importante:** as reservas existem **somente em localStorage** — não sobem ao Firestore. Se o dispositivo for trocado, as reservas são perdidas.

---

## 6. Categorias e fornecedores

### Categorias (`ch_dados/categorias`)
```
adicionarCategoria(nome, cor)
    Store.mutateCategorias(cats => cats.push(cat))
    → SyncQueue.enqueue('salvar', 'categorias', ...)
    → firebaseService.salvar() → setDoc(ch_dados/categorias, { dados:[...] })
```

### Fornecedores (`ch_dados/fornecedores`)
```
adicionarFornecedor({ nome, telefone, ... })
    Store.mutateFornecedores(forns => forns.push(forn))
    → SyncQueue.enqueue('salvar', 'fornecedores', ...)
    → firebaseService.salvar() → setDoc(ch_dados/fornecedores, { dados:[...] })
```

---

## 7. Reconciliação automática

`reconciliarEstoque(vendas)` — chamada sob demanda (monitor ou admin):

```
Para cada venda com status 'concluida' ou 'validada' de hoje:
    │
    ▼
FirebaseService.queryCollection('movimentacoes', [['origem','==',`venda:${venda.id}`]])
    │
    ├─ tem movimentação? → ok, pula
    │
    └─ sem movimentação?
            baixarEstoqueVendaLote(venda)   ← corrige
            registra no relatório

Ao final → TelegramService.enviar(relatorio)
```

---

## 8. Hooks automáticos do `auditService`

```js
EventBus.on('estoque:movimentado', mov => auditarMovimentacao(mov));
```

Toda movimentação registrada emite `estoque:movimentado` — a auditoria é gravada automaticamente no localStorage. Não precisa ser chamada explicitamente pelo código de negócio.

---

## 9. Coleções tocadas pelo fluxo de estoque

| Coleção | Tipo | Operação | Quem | Via |
|---|---|---|---|---|
| `CH_ESTOQUE` | localStorage | mutate | `Store.mutateEstoque` | direto |
| `ch_dados/estoque` | Firestore | `tx.set` | `estoqueService` | Transaction |
| `ch_dados/estoque` | Firestore | `setDoc` | SyncQueue | fallback offline |
| `movimentacoes/{id}` | Firestore | `tx.set` | `estoqueService` | Transaction (junto com estoque) |
| `CH_MOVIMENTACOES` | localStorage | insert | `Store.mutateMovimentacoes` | sempre (local) |
| `CH_AUDITORIA` | localStorage | insert | `Store.mutateAuditoria` | via EventBus |
| `ch_dados/categorias` | Firestore | `setDoc` | SyncQueue | via `Store.mutateCategorias` |
| `ch_dados/fornecedores` | Firestore | `setDoc` | SyncQueue | via `Store.mutateFornecedores` |
| `CH_RESERVAS_ESTOQUE` | localStorage | insert/delete | `estoqueService` | somente local |
