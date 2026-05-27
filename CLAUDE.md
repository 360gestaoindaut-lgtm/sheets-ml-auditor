# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Visão Geral do Sistema

360-Auditor-ML é uma plataforma SaaS multi-tenant de auditoria para sellers do Mercado Livre, implementada como **três projetos Google Apps Script (GAS)** independentes.

**Arquitetura:**
- `onboarding-api` — microsserviço de entrada: recebe webhooks Hotmart, clona a planilha Master e entrega acesso ao cliente via e-mail. Não conhece nada do backend-cofre.
- `frontend-seller` é um terminal burro: coleta IDs da planilha, empacota lotes e imprime as linhas de volta. Zero inteligência de negócio.
- `backend-cofre` é o cérebro: executa todas as chamadas à API do ML, a classificação Squad 360 e os cálculos de performance. Nunca é compartilhado com o cliente.

Cada seller recebe uma cópia da planilha `frontend-seller` configurada automaticamente pelo `onboarding-api`. O backend-cofre é único e serve todos os tenants.

---

## Estrutura de Pastas

```
360-Auditor-ML/
├── onboarding-api/           # GAS project: microsserviço de entrada (Hotmart webhook)
│   ├── appsscript.json       # Manifest: webapp anônimo, escopos Drive/Sheets/MailApp
│   └── webhook.js            # doPost: valida hottok, clona Master, compartilha, envia e-mail
│
├── frontend-seller/          # GAS project: planilha add-on do seller
│   ├── auth.js               # OAuth flow: CSRF, leitura de TRANSACAO_ID via metadata, polling
│   ├── router.js             # Terminal: descoberta de catálogo, sync, lotes ao backend, progresso
│   └── sidebar.html          # Painel lateral: 6 fases (descoberta → seleção → sync → auditoria → concluído)
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

### Handshake Comercial via Hotmart (Fase 12)

O microsserviço de onboarding da Hotmart clona a planilha Master e injeta `TRANSACAO_ID` via `addDeveloperMetadata` na cópia. No momento do OAuth:

1. O frontend lê `TRANSACAO_ID` dos metadados da planilha via `createDeveloperMetadataFinder` e o inclui no `registerCsrfState` POST.
2. O backend armazena `CSRF_TID_{uuid}` em ScriptProperties ao lado da chave CSRF normal.
3. Em `doGet`, o `transacao_id` é recuperado e consumido atomicamente junto com o CSRF token.
4. `_registrarTenant(accessToken, transacaoId)` executa o upsert em três prioridades (ver Banco Central abaixo).

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

**Layout das 6 colunas na aba LOGS:**

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| DATA | VENDEDOR_ID_360 | VENDEDOR_ID_ML | VENDEDOR_NOME | LOTE / "IMEDIATO" | MENSAGEM |

> **Tipagem estrita:** ambas as funções usam `Range.setValues()`, nunca `appendRow()`. Isso preserva zeros à esquerda em `VENDEDOR_ID` (padrão `"000000"`) — `appendRow` convertiria a string numérica para float.

O `finally` de `processarRaioX_Backend` garante que `flushLogs()` execute mesmo em caso de erro, early return ou exceção não prevista.

---

## Guia de Onboarding de Novos Tenants

Para provisionar a planilha de um novo seller:

1. **Cópia da Master:** Duplique a planilha `frontend-seller` Master. Cada tenant deve ter sua própria cópia isolada.

2. **Autorização OAuth:** No menu **"1. Conectar Conta Mercado Livre"**, o seller autoriza o acesso. O `access_token` e `refresh_token` ficam em `UserProperties` da planilha do seller. O `CLIENT_SECRET` nunca sai do `backend-cofre`.

3. **Raio-X do Catálogo:** Menu **"2. Raio-X do Catálogo"** abre o painel lateral que conduz o fluxo completo em fases:
   - **Descoberta:** consulta `paging.total` por status (active, paused, closed, under_review, inactive) — 5 chamadas leves, sem paginar IDs.
   - **Seleção:** seller escolhe quais status auditar via checkboxes; a sidebar exibe contagem, proporção e estimativa de tempo.
   - **Sincronização:** scan completo dos IDs selecionados (sem teto fixo de anúncios), com barra de progresso em tempo real.
   - **Auditoria:** processamento em lotes de 10 com progresso em tempo real e continuação automática via trigger.

4. **Criar Cabeçalho:** Se a aba DESEMPENHO for nova, usar **"Criar Cabeçalho"** antes da primeira auditoria.

5. O progresso é visível em tempo real no sidebar. Se o seller fechar a aba, o script continua em segundo plano e o painel retoma o acompanhamento ao ser reaberto.

---

## Arquitetura de Segurança

**`INTERNAL_API_KEY`** é hardcoded em `auth.js` e deve ser idêntica à ScriptProperty `INTERNAL_API_KEY` do backend. Todo `doPost` rejeita requisições sem ela. É uma medida de perímetro — a exposição no frontend é aceitável por design.

**`CLIENT_SECRET`** nunca deixa o `backend-cofre`. Reside apenas em ScriptProperties do projeto GAS privado.

**CSRF:** `abrirLoginML()` gera um UUID, registra-o no backend via `registerCsrfState`, e usa apenas o UUID como parâmetro `state` do OAuth. `gateway.js:doGet()` resolve UUID → spreadsheetId e apaga o token CSRF atomicamente. O `transacao_id` Hotmart viaja como `CSRF_TID_{uuid}` no mesmo ciclo e é consumido junto.

---

## Banco Central — Aba CLIENTES (CLIENT_SHEET_ID)

ScriptProperty `CLIENT_SHEET_ID` aponta para a planilha do Diretório Central. A aba `CLIENTES` tem 9 colunas (A–I):

| Col | Campo | Observação |
|-----|-------|------------|
| A | DATA_CADASTRO | Timestamp do registro (formato `obterDataFormatada360()`) |
| B | SELLER_ID_360 | 6 dígitos com zeros à esquerda, ex: `"000042"` — formato texto obrigatório |
| C | SELLER_ID_ML | ID numérico do seller no ML — formato texto obrigatório |
| D | SELLER_NICKNAME_ML | Nickname no ML, atualizado a cada re-login |
| E | STATUS | `"Ativo"` em todos os fluxos (v2 — não há mais estado "Aguardando ML") |
| F | NOTAS | Uso livre |
| G | EMAIL_COMPRADOR | E-mail do comprador na Hotmart — base de busca de `_validarLicenca` |
| H | TRANSACAO_ID | ID da transação Hotmart; usado como chave de licença |
| I | ORIGEM | `"Hotmart"` (onboarding-api) ou `"Manual"` (OAuth direto) |
| J | PLANILHA_ID | ID da planilha do seller; gravado no primeiro OAuth (hardware binding) |

**Regras de tipagem:** `setNumberFormat("@")` aplicado nas colunas B e C antes de qualquer `setValues` que grave nelas. Nunca usar `appendRow` nesta aba.

**Upsert — três prioridades de `_registrarTenant`:**

1. **Handshake (col H):** Se `transacaoId` vier no payload, busca na col H. Se encontrar: UPDATE cols C (SELLER_ID_ML), D (SELLER_NICKNAME_ML), E (STATUS) — sem criar nova linha. Se `PLANILHA_ID` (col J) estiver vazia, grava o ID da planilha (primeiro acesso).
2. **Re-login (col C):** Busca `SELLER_ID_ML` na col C. Se encontrar: atualiza nickname se mudou. Também confirma/grava col J no primeiro acesso.
3. **Novo manual:** Gera próximo `SELLER_ID_360` sequencial e insere linha completa de 10 colunas (A–J) com ORIGEM = "Manual".

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

## CONFIG e STATUS_CONHECIDOS em router.js

```js
var CONFIG = {
  BATCH_SIZE:    10,      // máx por chamada ao backend — não aumentar sem análise de timeout
  MODO_TESTE:    false,   // true = processa só MAX_TESTE itens (desenvolvimento)
  MAX_TESTE:     10,
  TIMEOUT_TOTAL: 270000,  // 4.5 min — margem para lotes de até 60s antes do teto GAS de 6 min
};

// Status consultados na fase de descoberta (paging.total por chamada, sem paginar IDs).
// Adicionados em ordem de relevância para o seller.
var STATUS_CONHECIDOS = [
  { status: "active",       label: "Ativo",       icone: "✅" },
  { status: "paused",       label: "Pausado",     icone: "⏸️" },
  { status: "closed",       label: "Encerrado",   icone: "🔒" },
  { status: "under_review", label: "Em revisão",  icone: "🔍" },
  { status: "inactive",     label: "Inativo",     icone: "⭕" }
];
```

### Fluxo de descoberta e seleção de catálogo

`descobrirCatalogo()` faz uma chamada `GET /users/{userId}/items/search?status={s}&limit=1` por entrada de `STATUS_CONHECIDOS`, lendo apenas `paging.total` sem paginar IDs. Retorna `{ statuses: [{status, label, icone, count}], total }` para a sidebar.

`sincronizarAnuncios(statusList)` recebe o array de status selecionados pelo seller, constrói `statusParam = statusList.join(",")` e executa o scan completo via `scroll_id` sem teto fixo de anúncios. Atualiza o `CacheService` com `SINC_STATUS / SINC_COUNT / SINC_MSG` a cada página para que a sidebar faça polling de progresso via `obterStatusSinc()`.

---

## Layout de Linhas (40 colunas, A → AN)

`engine.js:_rowErro()` e o array `row` em `processarRaioX_Backend` devem estar sincronizados com `router.js:criarCabecalho()`.

Ordem: `CONTA | ID | SKU | TÍTULO | STATUS | CATEGORIA | SQUAD 360 | AÇÃO RECOMENDADA` | `VENDAS/UNIDADES/VISITAS/CONV × {Geral, 30d, 15d, 7d}` | `ESTOQUE | PREÇO | SCORE` | 13 colunas de checklist (AB–AN).

---

## Microsserviço onboarding-api (Fase 13)

Projeto GAS **isolado** — não compartilha código, ScriptProperties nem secrets com o backend-cofre.

### Fluxo de provisionamento (assíncrono)

```
Hotmart ──POST /webhook?hottok=TOKEN──► doPost (recepcionista)
                                              │
                                     Valida hottok; extrai transacao_id
                                     props.setProperty("QUEUE_"+txId, rawPayload)
                                              │
                                     return HtmlService("OK")  ← < 1s
                                              │
                         [trigger a cada 1 min]
                                              │
                              processarFilaVendas → _provisionarVenda
                                              │
                                   Regista no Banco Central (CLIENT_SHEET_ID)
                                   novoId360 sequencial, STATUS = "Ativo"
                                              │
                                   linkCopia = "https://docs.google.com/spreadsheets/d/"
                                               + MASTER_SHEET_ID + "/copy"
                                              │
                                   GmailApp.sendEmail(email_comprador,
                                     linkCopia,           ← seller faz sua própria cópia
                                     transacaoId como chave de licença)
                                              │
                                   props.setProperty("TX_"+txId, "true")  ← idempotência
```

> **Modelo self-service (v2):** o seller copia a planilha Master por conta própria (link `/copy`). O `TRANSACAO_ID` não é mais injetado via `addDeveloperMetadata` — chega ao backend como `licenca_chave` gravada em `DocumentProperties` no momento da ativação de licença.

### ScriptProperties do onboarding-api

| Chave | Valor |
|-------|-------|
| `HOTMART_TOKEN` | Token configurado na URL do webhook no painel Hotmart (parâmetro `?hottok=`) |
| `MASTER_SHEET_ID` | ID da planilha `frontend-seller` Master (template — link `/copy` enviado ao comprador) |
| `CLIENT_SHEET_ID` | ID da planilha do Diretório Central (mesma usada pelo backend-cofre) |
| `LOG_SHEET_ID` | ID da planilha de telemetria (aba LOGS, 6 colunas) |

### Como TRANSACAO_ID chega ao backend

`auth.js:registrarCsrfState` tenta duas fontes em ordem:

1. **V1 (legado — clones via DriveApp):** lê `TRANSACAO_ID` via `createDeveloperMetadataFinder` na planilha ativa.
2. **V2 (self-service — caminho principal):** se não houver metadado, lê `licenca_chave` de `DocumentProperties` — valor gravado pelo seller no momento da ativação de licença.

Em ambos os casos, o `transacao_id` é incluído no POST para `registerCsrfState`. O `backend-cofre/gateway.js` armazena `CSRF_TID_{uuid}`, recupera em `doGet` e passa para `_registrarTenant`, que executa o handshake pela Prioridade 1 (col H da aba CLIENTES).

### Validação de segurança

- Requisições sem `hottok` correto retornam `HtmlService("OK")` silenciosamente — evita vazar que o endpoint existe.
- Todos os eventos com hottok válido são enfileirados; a filtragem por tipo de evento não está implementada.
- HTML nos e-mails é escapado via `_esc()` antes de interpolação.
- Idempotência: `TX_{txId}` bloqueia re-processamento de transações já concluídas. `ERROR_QUEUE_{txId}` preserva payloads com falha para reprocessamento manual (renomear para `QUEUE_{txId}`).

---

## Comandos de Desenvolvimento

```bash
# Push do microsserviço de onboarding
cd onboarding-api && clasp push --force

# Push do frontend (planilha do seller)
cd frontend-seller && clasp push --force

# Push do backend (servidor privado 360 Gestão)
cd backend-cofre && clasp push --force

# Logs em tempo real (via GAS editor)
# Abrir projeto → Execuções → selecionar a execução desejada
# Logs de telemetria fina: planilha configurada em LOG_SHEET_ID → aba LOGS
```

> Não há build step. Os arquivos são enviados como estão. Após qualquer mudança de escopo OAuth em `appsscript.json`, é obrigatório criar um **novo deployment** no editor GAS (Implantar → Gerenciar implantações → Nova versão) — `clasp push` sozinho não re-autoriza o Web App.
