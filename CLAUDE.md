# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Visão Geral do Sistema

360-Auditor-ML é uma plataforma SaaS multi-tenant de auditoria para sellers do Mercado Livre, implementada como dois projetos Google Apps Script (GAS) independentes que se comunicam exclusivamente via HTTP POST autenticado.

**Arquitetura Thin Client / Terminal Burro:**
- O `frontend-seller` é um terminal burro: coleta IDs da planilha, empacota lotes e imprime as linhas de volta. Zero inteligência de negócio.
- O `backend-cofre` é o cérebro: executa todas as chamadas à API do ML, a classificação Squad 360 e os cálculos de performance. Nunca é compartilhado com o cliente.

Cada seller recebe uma cópia da planilha `frontend-seller` configurada com seu `CLIENT_ID` e `CLIENT_NAME`. O backend é único e serve todos os tenants.

---

## Estrutura de Pastas

```
360-Auditor-ML/
├── frontend-seller/          # GAS project: planilha add-on do seller
│   ├── auth.js               # OAuth flow: UUID CSRF, long polling, captura de token
│   ├── router.js             # Terminal: lê IDs → envia lotes ao backend → escreve linhas
│   └── sidebar.html          # Painel lateral: barra de progresso + dicas SEO rotativas
│
└── backend-cofre/            # GAS project: servidor privado 360 Gestão (nunca compartilhado)
    ├── gateway.js            # doGet (callback OAuth) + doPost (dispatcher de todas as rotas)
    └── engine.js             # Inteligência: API ML, Squad 360, Logger360, processarRaioX_Backend
```

---

## Contrato de Interface e Fluxo de Dados

### Payload (frontend → backend)

```js
// router.js → gateway.js (POST)
{
  action:        "processarRaioX",
  apiKey:        INTERNAL_API_KEY,       // chave de perímetro; rejeita origens desconhecidas
  access_token:  string,
  refresh_token: string,
  user_id:       string,                 // ID do seller no ML
  ids:           string[],              // ≤ 10 IDs MLB por lote
  vendedor_id:   string,                // 6 dígitos com zeros à esquerda, ex: "000042"
  vendedor_nome: string                 // nome legível do tenant, ex: "Loja Acme"
}

// gateway.js → router.js (resposta)
{
  rows:          any[][],               // sempre rows.length === ids.length (contrato posicional)
  novos_tokens?: { access_token, refresh_token }  // presente apenas se houve refresh mid-batch
}
```

**Contrato posicional:** `rows[i]` corresponde sempre a `ids[i]`. O backend garante isso empurrando `_rowErro()` (sentinela de 40 colunas) em qualquer falha por item — nunca pula índices. O frontend escreve cegamente por posição; quebrar esse contrato corrompe a planilha.

### Performance: Multiget e fetchAll (Fase 6)

Em vez de N chamadas sequenciais, o backend usa:

- **`_multigetItens(ids, headers, tentarRefresh)`** — uma chamada `GET /items?ids=A,B,...` para dados básicos de todos os IDs do lote (O(1) no loop via hash map).
- **`_fetchAllPerformance(ids, headers, tentarRefresh)`** — `UrlFetchApp.fetchAll()` dispara todas as requisições `/item/{id}/performance` em paralelo.

O loop principal acessa os resultados via dict lookup, reduzindo chamadas de N+N sequenciais para 1+1 (bulk + paralelo).

### Identificação de Origem Multi-tenant (Fase 10)

`vendedor_id` e `vendedor_nome` são incluídos em cada payload. O backend os lê do payload e os armazena nas variáveis de módulo `_vendedorId` e `_vendedorNome`, que alimentam o Logger360 em todas as linhas de telemetria.

---

## Mecanismos de Resiliência e Defesa

### Time-Awareness — Relógio Interno (Fase 9)

**Frontend (`router.js`):**
- `CONFIG.TIMEOUT_TOTAL = 270000` (4,5 min). A trava é verificada **antes** de cada lote — nunca depois — para não iniciar um ciclo de 60s com apenas 5s restantes.
- Se o tempo estourar: agenda o trigger `continuarRaioX` (1 min) e retorna. A execução seguinte relê os pendentes da planilha e continua de onde parou.

**Backend (`engine.js`):**
- `_startBackend` é uma variável de módulo zerada no início de cada `processarRaioX_Backend`.
- `checkTimeout()` lança `new Error("TIMEOUT_INTERNO")` se `Date.now() - _startBackend > 50000` (50 s).
- Injetada em três pontos: `preCarregarVendas30D` (while de paginação), `_fetchAllPerformance` (while de retry 429) e o loop principal de montagem de linhas.
- A exceção escapa do inner try/catch por item (pois `checkTimeout()` fica fora dele) e é capturada pelo catch externo, que chama `logImmediate` antes de retornar `{ error: "TIMEOUT_INTERNO", rows: [] }`.

### Retry 429 com Backoff Crescente (Fase 9)

`_fetchAllPerformance` implementa até `maxRetries429 = 3` tentativas para itens com rate limit:

```
retry 1 → sleep 2s
retry 2 → sleep 4s
retry 3 → sleep 6s
Após 3 tentativas: quebra o loop, itens restantes recebem null (sem dados de performance)
```

Cada iteração chama `checkTimeout()` para evitar que o loop de backoff prenda a execução por tempo excessivo.

### Tolerância a Falhas de Rede e HTTP 500 (Fase 8)

Quando um lote falha (exceção de rede, HTTP ≥ 500, ou erro JSON do backend):
- O frontend **não interrompe o loop**.
- Chama `_marcarLoteComoErro(sheet, lote)`, que escreve `"ERRO: Falha no Servidor Central"` na coluna D (título) de cada item do lote.
- Incrementa o contador de progresso e avança para o próximo lote.
- Na próxima execução, esses itens são re-enfileirados automaticamente (`titulo.startsWith("ERRO")`).
- **Exceção única:** `resposta.error === "Unauthorized"` → aborta imediatamente (falha de autenticação estrutural).

### Logger360 de Sobrevivência (Fase 7 + Fase 9)

O backend usa dois modos de gravação de telemetria, ativados pela ScriptProperty `LOG_SHEET_ID`:

| Método | Função | Quando grava | Modo |
|---|---|---|---|
| `logImmediate()` | Escrita imediata via `Range.setValues()` | INÍCIO do lote e ERROS FATAIS | Sobrevive ao Hard Kill de 360s |
| `flushLogs()` | Batch via `Range.setValues()` no `finally` | Fim de cada lote | Telemetria fina de timing |

**Layout das 5 colunas na aba LOGS:**

| A | B | C | D | E |
|---|---|---|---|---|
| DATA | VENDEDOR_ID | VENDEDOR_NOME | LOTE / "IMEDIATO" | MENSAGEM |

> **Tipagem estrita:** ambas as funções usam `Range.setValues()`, nunca `appendRow()`. Isso preserva zeros à esquerda em `VENDEDOR_ID` (padrão `"000000"`) — `appendRow` convertiria a string numérica para float.

O `finally` de `processarRaioX_Backend` garante que `flushLogs()` execute mesmo em caso de erro, early return ou exceção não prevista.

---

## Guia de Onboarding de Novos Tenants

Para provisionar a planilha de um novo seller:

1. **Cópia da Master:** Duplique a planilha `frontend-seller` Master. Cada tenant deve ter sua própria cópia isolada.

2. **Configurar ID do Cliente:** No menu **"360 Gestão - ML → 0. Configurar ID do Cliente"**, insira:
   - **ID do Seller:** string de 6 dígitos com zeros à esquerda (ex: `"000042"`) — salvo em `ScriptProperties['CLIENT_ID']`
   - **Nome do Cliente:** nome legível (ex: `"Loja Acme"`) — salvo em `ScriptProperties['CLIENT_NAME']`

3. **Autorização OAuth:** No menu **"1. Conectar Conta Mercado Livre"**, o seller autoriza o acesso. O `access_token` e `refresh_token` ficam em `UserProperties` da planilha do seller. O `CLIENT_SECRET` nunca sai do `backend-cofre`.

4. **Sincronizar Catálogo:** Menu **"2. Sincronizar Catálogo"** varre todos os anúncios ativos/pausados e preenche a coluna B (IDs MLB) na aba DESEMPENHO.

5. **Criar Cabeçalho:** Se a aba DESEMPENHO for nova, usar **"Criar Cabeçalho"** antes da primeira auditoria.

6. **Rodar Raio-X:** Menu **"3. Rodar Raio-X (Auditoria)"** abre o painel lateral e inicia a auditoria. O progresso é visível em tempo real no sidebar.

---

## Arquitetura de Segurança

**`INTERNAL_API_KEY`** é hardcoded em `auth.js` e deve ser idêntica à ScriptProperty `INTERNAL_API_KEY` do backend. Todo `doPost` rejeita requisições sem ela. É uma medida de perímetro — a exposição no frontend é aceitável por design.

**`CLIENT_SECRET`** nunca deixa o `backend-cofre`. Reside apenas em ScriptProperties do projeto GAS privado.

**CSRF:** `abrirLoginML()` gera um UUID, registra-o no backend via `registerCsrfState`, e usa apenas o UUID como parâmetro `state` do OAuth. `gateway.js:doGet()` resolve UUID → spreadsheetId e apaga o token CSRF atomicamente.

**Lifecycle do token:**
- `invalid_grant` → `renovarToken()` apaga todas as `UserProperties` e alerta o seller para reconectar.
- Expiração mid-batch → closure `tentarRefresh` no backend renova in-place (muta `headers["Authorization"]`), retorna `novos_tokens`. O frontend salva imediatamente em `UserProperties` antes de processar as linhas.

---

## Invariantes Críticos

1. **`rows.length === ids.length` sempre.** Todo caminho de código em `processarRaioX_Backend` termina com `rows.push(row)` ou `rows.push(_rowErro(...))`. Nunca use `continue` sem empurrar uma linha.

2. **Trava de tempo ANTES do lote, não depois.** O check em `router.js` fica no topo do loop para que um lote de 45s nunca comece com menos de 45s disponíveis.

3. **`headers` é passado por referência em `engine.js`.** `tentarRefresh()` muta `headers["Authorization"]` in-place — todas as funções que já receberam a referência usam o token renovado automaticamente.

4. **`checkTimeout()` deve ficar fora do inner try/catch por item.** O inner catch captura apenas exceções de item individual; `checkTimeout()` deve escapar para o catch externo.

5. **`logImmediate` e `flushLogs` usam `setValues`, nunca `appendRow`.** Garantia de tipagem estrita para `VENDEDOR_ID` com zeros à esquerda.

6. **Todos os timestamps usam `obterDataFormatada360()`.** Helper definido em `engine.js`; usa `Session.getScriptTimeZone()` e formato `"yyyy-MM-dd HH:mm:ss"`. Nunca chamar `Utilities.formatDate` inline — garante fuso horário consistente e facilita mudanças centralizadas. `gateway.js` chama essa função por ser co-deployado no mesmo projeto GAS.

---

## CONFIG em router.js

```js
var CONFIG = {
  BATCH_SIZE:    10,      // máx por chamada ao backend — não aumentar sem análise de timeout
  MODO_TESTE:    false,   // true = processa só MAX_TESTE itens (desenvolvimento)
  MAX_TESTE:     10,
  TIMEOUT_TOTAL: 270000,  // 4.5 min — margem para lotes de até 60s antes do teto GAS de 6 min
  MAX_ANUNCIOS:  5000,
};
```

---

## Layout de Linhas (40 colunas, A → AN)

`engine.js:_rowErro()` e o array `row` em `processarRaioX_Backend` devem estar sincronizados com `router.js:criarCabecalho()`.

Ordem: `CONTA | ID | SKU | TÍTULO | STATUS | CATEGORIA | SQUAD 360 | AÇÃO RECOMENDADA` | `VENDAS/UNIDADES/VISITAS/CONV × {Geral, 30d, 15d, 7d}` | `ESTOQUE | PREÇO | SCORE` | 13 colunas de checklist (AB–AN).

---

## Comandos de Desenvolvimento

```bash
# Push do frontend (planilha do seller)
cd frontend-seller && clasp push --force

# Push do backend (servidor privado 360 Gestão)
cd backend-cofre && clasp push --force

# Logs em tempo real (via GAS editor)
# Abrir projeto → Execuções → selecionar a execução desejada
# Logs de telemetria fina: planilha configurada em LOG_SHEET_ID → aba LOGS
```

> Não há build step. Os arquivos são enviados como estão. Após qualquer mudança de escopo OAuth em `appsscript.json`, é obrigatório criar um **novo deployment** no editor GAS (Implantar → Gerenciar implantações → Nova versão) — `clasp push` sozinho não re-autoriza o Web App.
