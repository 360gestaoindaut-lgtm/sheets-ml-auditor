# 360-Auditor-ML

Plataforma SaaS multi-tenant de auditoria de anúncios para sellers do Mercado Livre, desenvolvida pela **360 Gestão**. Entrega um diagnóstico completo de performance do catálogo — vendas, visitas, conversão, score de qualidade e checklist de 13 critérios — diretamente em uma planilha Google Sheets, sem que o cliente precise sair do ambiente que já conhece.

---

## Problema que resolve

Sellers do Mercado Livre com catálogos grandes (centenas a milhares de anúncios) não têm visibilidade consolidada de quais produtos estão performando, quais precisam de ação imediata e por quê. A plataforma faz o Raio-X automatizado do catálogo inteiro, classifica cada anúncio em squads de prioridade (A, B, C, D, E, P, S) e entrega ações recomendadas — em minutos, não dias.

**Público-alvo dos tenants:** sellers com operação estruturada no ML (100–5000 anúncios ativos).  
**Público-alvo deste documento:** mantenedores e desenvolvedores da 360 Gestão.

---

## Arquitetura em três frentes

```
onboarding-api/                          frontend-seller/                         backend-cofre/
───────────────                          ────────────────                         ──────────────
Microsserviço de entrada                 Planilha Google Sheets (por tenant)      Servidor privado 360 Gestão (único)
webhook.js: recebe Hotmart               Planilha provisionada                    gateway.js: valida apiKey → despacha
registra no Banco Central                router.js: descobre catálogo,           engine.js: chama API ML, classifica,
envia e-mail ao comprador                  seleciona status, sync, lotes ─────►    monta linhas, loga telemetria
                                         sidebar.html: 6 fases de fluxo ◄── { rows[][], novos_tokens? } ────
                                         auth.js: OAuth flow ML          ◄── { rows[][], novos_tokens? } ────
                                                  escreve linhas por posição
```

Cada tenant recebe uma cópia isolada da planilha `frontend-seller` provisionada automaticamente pelo `onboarding-api`. O `backend-cofre` é compartilhado e nunca distribuído. Consulte [`CLAUDE.md`](CLAUDE.md) para a documentação técnica completa (contratos, invariantes, resiliência).

---

## Pré-requisitos

| Ferramenta | Versão mínima | Instalação |
|---|---|---|
| Node.js | 18 LTS | [nodejs.org](https://nodejs.org) |
| clasp | 3.x | `npm install -g @google/clasp` |
| Conta Google | — | Mesma conta proprietária dos três projetos GAS |
| Apps Script API | habilitada | [script.google.com/home/usersettings](https://script.google.com/home/usersettings) → ativar |

> O projeto foi desenvolvido e homologado com Node.js v24 e clasp v3.3.0.

---

## Setup do ambiente do zero

### 1. Clonar o repositório

```bash
git clone <url-do-repositorio>
cd 360-Auditor-ML
```

### 2. Instalar o clasp globalmente

```bash
npm install -g @google/clasp
```

### 3. Autenticar o clasp com a conta 360 Gestão

```bash
clasp login
```

O navegador abrirá o fluxo OAuth do Google. Use a conta `360gestaoindaut@gmail.com` (proprietária dos três projetos GAS). O token de autenticação é salvo em `~/.clasprc.json` (fora do repositório).

> **Atenção:** o `clasp login` precisa ser feito uma única vez por máquina. Se já estiver autenticado com outra conta, faça `clasp logout` primeiro.

### 4. Verificar o vínculo com os projetos GAS

Os arquivos `.clasp.json` em cada diretório já apontam para os Script IDs corretos:

| Diretório | Script ID |
|---|---|
| `onboarding-api/` | `1yy_LI5q_PIvrokFGQCyrwcub9T6xpYKJ0mQm1U86wXqmsd0MubdjAiwW` |
| `frontend-seller/` | `1UuGyNnXAdrtiBhk9Fn_gJNxdCr3FOxZ4aAXTUuwxblyaZa17qgELMe5C` |
| `backend-cofre/` | `1jmiOgxTRQNJCG44O4Exk3mFHnyRhfF4yN2g3uBnq8VDcrjUuLF63ovVQ` |

Confirme que o push funciona antes de fazer qualquer alteração:

```bash
cd onboarding-api && clasp push --force
cd ../frontend-seller && clasp push --force
cd ../backend-cofre && clasp push --force
```

Se retornar erro de permissão, verifique se a conta autenticada é a proprietária dos scripts no [GAS Dashboard](https://script.google.com).

### 5. Configurar as Script Properties do backend

No [editor do GAS](https://script.google.com), abra o projeto `backend-cofre` e vá em **Configurações do projeto → Propriedades do script**. Adicione:

| Chave | Valor | Observação |
|---|---|---|
| `CLIENT_ID` | `334744915172650` | ID do app no Mercado Livre |
| `CLIENT_SECRET` | `[obtido no portal ML]` | **Nunca commitar. Único segredo real do sistema.** |
| `INTERNAL_API_KEY` | `360_KEY_XAMdyAZnZk1BHZ57EswLstUryZpV22PW` | Deve ser idêntico à constante em `auth.js` |
| `LOG_SHEET_ID` | `[ID da planilha de telemetria]` | Opcional. Se ausente, logs são descartados silenciosamente. |

> O `CLIENT_SECRET` é obtido em [developers.mercadolibre.com.br](https://developers.mercadolibre.com.br) → sua aplicação → credenciais.

### 6. Publicar o backend como Web App

O backend precisa estar publicado como Web App para receber requisições. Faça isso **uma única vez** (ou após qualquer mudança de escopo OAuth):

1. No editor GAS do `backend-cofre`, clique em **Implantar → Nova implantação**.
2. Tipo: **Web App**.
3. Executar como: **Eu (360gestaoindaut@gmail.com)**.
4. Quem tem acesso: **Qualquer pessoa, mesmo anônimos**.
5. Clique em **Implantar** e autorize os escopos solicitados.
6. Copie a URL gerada — ela deve coincidir com a constante `WEB_APP_URL` em `frontend-seller/auth.js`.

> `clasp push` atualiza o código mas **não recria o deployment**. Após mudanças em `appsscript.json` (novos escopos), sempre crie uma nova versão via **Gerenciar implantações → editar → Nova versão**.

---

## Configuração de um novo tenant (onboarding)

### Via Hotmart (automático — caminho principal)

O microsserviço `onboarding-api` processa a compra aprovada sem intervenção manual:

1. Hotmart dispara o webhook `PURCHASE_APPROVED` para a URL do `onboarding-api`.
2. O serviço registra o tenant no Banco Central (STATUS = "Ativo") e envia e-mail ao comprador com dois dados: link para copiar a planilha Master (`/copy`) e o `TRANSACAO_ID` da compra como **chave de licença**.
3. O seller clica no link → cria sua própria cópia da planilha no Google Drive.
4. Na planilha copiada → menu **🔑 Ativar Licença** → informa o e-mail de compra e a chave recebida.
5. Menu **1. Conectar Conta Mercado Livre** → o OAuth vincula a identidade ML ao tenant via handshake (chave de licença).
6. Menu **2. Raio-X do Catálogo** → o painel lateral guia o seller pelas fases: descoberta de status → seleção via checkboxes → sincronização do catálogo completo → auditoria em lotes.

### Onboarding manual (fallback)

> Requer uma chave de licença válida (transacao_id). Sem ela, a ferramenta bloqueia o acesso.

1. Acesse o link de cópia da planilha Master e faça sua cópia no Google Drive.
2. Menu **🔑 Ativar Licença** → informe e-mail e chave de licença.
3. Menu **1. Conectar Conta Mercado Livre** → o seller autoriza o OAuth (cria novo registro no Banco Central).
4. Clicar em **Criar Cabeçalho** se a aba DESEMPENHO for nova.
5. Menu **2. Raio-X do Catálogo** → painel lateral guia descoberta → seleção de status → sync → auditoria.

---

## Fluxo de deploy (dia a dia)

```bash
# Frontend (planilha do seller)
cd frontend-seller && clasp push --force

# Backend (servidor privado)
cd ../backend-cofre && clasp push --force

# Onboarding API (microsserviço Hotmart)
cd ../onboarding-api && clasp push --force
```

Logs de execução ficam no **Google Cloud Stackdriver**: editor GAS → Execuções.  
Logs de telemetria fina ficam na planilha configurada em `LOG_SHEET_ID` → aba **LOGS** (6 colunas: DATA | VENDEDOR_ID_360 | VENDEDOR_ID_ML | VENDEDOR_NOME | LOTE | MENSAGEM).

### Setup inicial do onboarding-api (único por máquina)

O `onboarding-api` já tem `.clasp.json` vinculado ao projeto GAS. Para re-criar em outra conta:

```bash
cd onboarding-api
clasp create --title "360 Onboarding API" --type standalone
# O clasp cria um novo .clasp.json — atualize o Script ID nos registros internos
clasp push --force
```

No editor GAS do `onboarding-api`:

1. **Implantar → Nova implantação** → Tipo: Web App → Executar como: Eu → Acesso: Qualquer pessoa, mesmo anônimos.
2. Em **Configurações do projeto → Propriedades do script**, adicione:

| Chave | Valor |
|-------|-------|
| `HOTMART_TOKEN` | Token secreto — configure o mesmo valor na URL do webhook no painel Hotmart como `?hottok=TOKEN` |
| `MASTER_SHEET_ID` | ID da planilha Master `frontend-seller` (link `/copy` enviado ao comprador) |
| `CLIENT_SHEET_ID` | ID da planilha do Diretório Central (Banco Central de tenants) |
| `LOG_SHEET_ID` | ID da planilha de telemetria (aba LOGS) |

3. No painel Hotmart, configure o webhook para a URL gerada + `?hottok=TOKEN`, evento `purchase.approved`.
4. No editor GAS, execute `instalarTrigger()` uma única vez para agendar o worker `processarFilaVendas` a cada 1 minuto.

---

## Dependências de API (escopos OAuth)

O `backend-cofre/appsscript.json` declara explicitamente:

```json
"oauthScopes": [
  "https://www.googleapis.com/auth/script.external_request",
  "https://www.googleapis.com/auth/spreadsheets"
]
```

O `frontend-seller` usa escopos auto-detectados pelo GAS (Sheets, PropertiesService, CacheService, HtmlService, triggers).

A API do Mercado Livre não requer chave de API para leitura pública, mas exige OAuth 2.0 para dados do seller (pedidos, performance, visitas). O app ML deve ter o redirect URI configurado para a URL do Web App do `backend-cofre`.

---

## Estrutura de arquivos relevantes

```
360-Auditor-ML/
├── CLAUDE.md                  # Documentação técnica completa para mantenedores e Claude Code
├── README.md                  # Este arquivo
├── .gitignore
│
├── onboarding-api/            # GAS project: microsserviço de webhook Hotmart
│   ├── .clasp.json            # Vínculo com o Script ID do projeto GAS do onboarding
│   ├── appsscript.json        # Manifest: webapp anônimo, escopos Drive/Sheets/GmailApp/scriptapp
│   └── webhook.js             # doPost: valida hottok, enfileira; worker: provisiona, registra, envia e-mail
│
├── frontend-seller/
│   ├── .clasp.json            # Vínculo com o Script ID do projeto GAS do frontend
│   ├── appsscript.json        # Manifest GAS (timezone, runtime)
│   ├── auth.js                # OAuth ML: CSRF, leitura de TRANSACAO_ID via metadata, polling
│   ├── router.js              # Terminal: descobre catálogo por status, sync sem teto, lotes ao backend
│   └── sidebar.html           # Painel lateral: 6 fases (descoberta, seleção, sync, auditoria, concluído)
│
└── backend-cofre/
    ├── .clasp.json            # Vínculo com o Script ID do projeto GAS do backend
    ├── appsscript.json        # Manifest GAS (oauthScopes, webapp config)
    ├── gateway.js             # doGet (callback OAuth) + doPost (dispatcher de rotas)
    └── engine.js              # Inteligência: API ML, Squad 360, Logger360, processarRaioX_Backend
```
