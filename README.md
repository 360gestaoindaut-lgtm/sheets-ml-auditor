# 360-Auditor-ML

Plataforma SaaS multi-tenant de auditoria de anúncios para sellers do Mercado Livre, desenvolvida pela **360 Gestão**. Entrega um diagnóstico completo de performance do catálogo — vendas, visitas, conversão, score de qualidade e checklist de 13 critérios — diretamente em uma planilha Google Sheets, sem que o cliente precise sair do ambiente que já conhece.

---

## Problema que resolve

Sellers do Mercado Livre com catálogos grandes (centenas a milhares de anúncios) não têm visibilidade consolidada de quais produtos estão performando, quais precisam de ação imediata e por quê. A plataforma faz o Raio-X automatizado do catálogo inteiro, classifica cada anúncio em squads de prioridade (A, B, C, D, E, P, S) e entrega ações recomendadas — em minutos, não dias.

**Público-alvo dos tenants:** sellers com operação estruturada no ML (100–5000 anúncios ativos).  
**Público-alvo deste documento:** mantenedores e desenvolvedores da 360 Gestão.

---

## Arquitetura em duas frentes

```
frontend-seller/                         backend-cofre/
────────────────                         ──────────────
Planilha Google Sheets (por tenant)      Servidor privado 360 Gestão (único)
router.js: lê IDs → envia lote ─────────► gateway.js: valida apiKey → despacha
sidebar.html: painel de progresso        engine.js: chama API ML, classifica,
auth.js: OAuth flow ML                             monta linhas, loga telemetria
         ◄── { rows[][], novos_tokens? } ─────────
         escreve linhas por posição
```

Cada tenant recebe uma cópia isolada da planilha `frontend-seller`. O `backend-cofre` é compartilhado e nunca distribuído. Consulte [`CLAUDE.md`](CLAUDE.md) para a documentação técnica completa (contratos, invariantes, resiliência).

---

## Pré-requisitos

| Ferramenta | Versão mínima | Instalação |
|---|---|---|
| Node.js | 18 LTS | [nodejs.org](https://nodejs.org) |
| clasp | 3.x | `npm install -g @google/clasp` |
| Conta Google | — | Mesma conta proprietária dos dois projetos GAS |
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

O navegador abrirá o fluxo OAuth do Google. Use a conta `360gestaoindaut@gmail.com` (proprietária dos dois projetos GAS). O token de autenticação é salvo em `~/.clasprc.json` (fora do repositório).

> **Atenção:** o `clasp login` precisa ser feito uma única vez por máquina. Se já estiver autenticado com outra conta, faça `clasp logout` primeiro.

### 4. Verificar o vínculo com os projetos GAS

Os arquivos `.clasp.json` em cada diretório já apontam para os Script IDs corretos:

| Diretório | Script ID |
|---|---|
| `frontend-seller/` | `1UuGyNnXAdrtiBhk9Fn_gJNxdCr3FOxZ4aAXTUuwxblyaZa17qgELMe5C` |
| `backend-cofre/` | `1jmiOgxTRQNJCG44O4Exk3mFHnyRhfF4yN2g3uBnq8VDcrjUuLF63ovVQ` |

Confirme que o push funciona antes de fazer qualquer alteração:

```bash
cd frontend-seller && clasp push --force
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

1. Duplique a planilha Master `frontend-seller` no Google Drive.
2. Abra a nova planilha → menu **360 Gestão - ML → 0. Configurar ID do Cliente**.
   - **ID do Seller:** string de 6 dígitos com zeros à esquerda (ex: `"000042"`) — identificador único do tenant nos logs.
   - **Nome do Cliente:** nome legível (ex: `"Loja Acme"`).
3. Menu **1. Conectar Conta Mercado Livre** → o seller autoriza o OAuth.
4. Menu **2. Sincronizar Catálogo** → popula a coluna B da aba DESEMPENHO com todos os IDs MLB.
5. Clicar em **Criar Cabeçalho** se a aba DESEMPENHO for nova.
6. Menu **3. Rodar Raio-X (Auditoria)** → inicia a auditoria. O painel lateral mostra o progresso.

---

## Fluxo de deploy (dia a dia)

```bash
# Editar arquivos → push para o GAS

# Frontend (planilha do seller)
cd frontend-seller
clasp push --force

# Backend (servidor privado)
cd ../backend-cofre
clasp push --force
```

Logs de execução ficam no **Google Cloud Stackdriver**: editor GAS → Execuções.  
Logs de telemetria fina ficam na planilha configurada em `LOG_SHEET_ID` → aba **LOGS** (5 colunas: DATA | VENDEDOR_ID | VENDEDOR_NOME | LOTE | MENSAGEM).

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
├── frontend-seller/
│   ├── .clasp.json            # Vínculo com o Script ID do projeto GAS do frontend
│   ├── appsscript.json        # Manifest GAS (timezone, runtime)
│   ├── auth.js                # OAuth ML: CLIENT_ID, WEB_APP_URL, INTERNAL_API_KEY, CSRF, polling
│   ├── router.js              # Terminal: sincroniza catálogo, roda auditoria, sidebar
│   └── sidebar.html           # Painel lateral: barra de progresso + dicas SEO rotativas
│
└── backend-cofre/
    ├── .clasp.json            # Vínculo com o Script ID do projeto GAS do backend
    ├── appsscript.json        # Manifest GAS (oauthScopes, webapp config)
    ├── gateway.js             # doGet (callback OAuth) + doPost (dispatcher de rotas)
    └── engine.js              # Inteligência: API ML, Squad 360, Logger360, processarRaioX_Backend
```
