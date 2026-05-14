# Documento de Arquitetura e Segurança: Auditor ML - 360 Gestão
**Data:** Maio de 2026
**Status:** Revisão Arquitetural

---

## 1. Mapeamento de Vulnerabilidades e Pontos Críticos

O sistema atual apresenta falhas de segurança de infraestrutura, inconsistências no fluxo de dados do usuário e exposição de propriedade intelectual. 

### 1.1. Backend (O Cofre OAuth - `acesso_ml.gs.js`)
* **Vulnerabilidade A - Endpoint Aberto:** A função `doPost` recebe requisições sem validar a origem. Qualquer um com a URL do Web App pode disparar requisições, consumir a cota do Google e potencialmente "pescar" tokens temporários ou usar a rota como proxy reverso para o Mercado Livre.
* **Vulnerabilidade B - Lixo no Banco de Dados:** Se a rota `fetchToken` nunca for chamada pelo cliente (ex: fechou a aba antes da hora), o `TEMP_TOKEN` fica preso no `PropertiesService` indefinidamente, correndo o risco de estourar o limite de armazenamento do Google Apps Script.

### 1.2. Frontend (Autenticação - `link_mercado_livre.gs.js`)
* **Vulnerabilidade C - Condição de Corrida (Fator Humano):** A captura do token exige que o usuário clique em "FINALIZAR CONEXÃO". Se ele clicar rápido demais, a requisição falha antes do Backend terminar o armazenamento, resultando em um bloqueio silencioso da operação.
* **Vulnerabilidade D - Exposição de Parâmetro (State):** O ID da planilha está sendo passado em plain text no parâmetro `state` da URL do Mercado Livre. O `state` deve ser um UUID aleatório validado no retorno para prevenir ataques CSRF (Cross-Site Request Forgery).
* **Vulnerabilidade E - Loop Infinito de Token Morto:** Quando o `refresh_token` é revogado no ML ou falha de forma permanente, o frontend não apaga as credenciais locais, forçando a planilha a tentar renovar o token inutilmente a cada execução do Raio-X.

### 1.3. Regra de Negócio (O Motor - `motor360.gs.js`)
* **Vulnerabilidade F - Exposição de Propriedade Intelectual (IP):** Toda a lógica do método de consultoria da 360 Gestão (definição das categorias de Squad, diagnósticos e pesos de auditoria) está legível no código do cliente.
* **Vulnerabilidade G - Gargalo de Processamento Cliente-Side:** Fazer o frontend lidar com paginação complexa, cache de categorias e consolidação de chamadas da API do ML (como o cálculo de Visitas e Vendas) torna o script suscetível a travamentos caso a internet do cliente oscile ou a aba seja fechada durante o processo.

---

## 2. A Nova Arquitetura: Modelo "Thin Client" (Terminal Burro)

Para resolver a exposição da regra de negócio e escalar a operação, o sistema será reestruturado em duas camadas estritas:

### 2.1. Camada 1: Web App Central da 360 Gestão (O Cérebro)
Hospedado na sua conta. Ninguém tem acesso ao código.
* **Módulo OAuth:** Continua gerenciando as chaves secretas (`CLIENT_SECRET`) e gerando tokens.
* **Módulo Motor:** Absorve TODAS as funções de chamadas ao Mercado Livre, cálculo de performance e classificação do Squad 360.
* **Endpoint Seguro:** Recebe requisições POST autenticadas contendo apenas os IDs dos anúncios, processa a inteligência internamente e devolve um JSON com as linhas prontas para serem coladas na planilha.

### 2.2. Camada 2: Planilha do Seller (O Terminal)
Entregue ao cliente. Código minimalista e descartável.
* **Interface:** Gerencia os menus e alertas da interface gráfica.
* **Comunicação:** Possui rotas básicas de `UrlFetchApp` para enviar lotes de IDs (ex: de 50 em 50) para o Web App Central.
* **Apresentação:** Recebe a resposta do Web App Central e apenas "imprime" os dados nas células, sem saber como a decisão foi tomada.

---

## 3. Jornada de Implementação (Roadmap)

### Fase 1: Blindagem e Refatoração do OAuth
* **Passo 1:** Criar e embutir uma **API Key Interna** no código da planilha. O `doPost` do Backend passará a rejeitar qualquer requisição que não contenha essa chave no payload.
* **Passo 2:** Substituir o botão manual de "FINALIZAR CONEXÃO" por um mecanismo de **Long Polling**. Ao iniciar a autorização, a planilha passará a disparar requisições assíncronas a cada 3 segundos perguntando ao Backend se o token chegou, automatizando a conclusão da tela para o usuário.
* **Passo 3:** Implementar um gerador de UUID no frontend para o parâmetro `state` e adicionar rotinas automáticas de `PropertiesService.deleteAllProperties()` quando a API do Mercado Livre retornar um erro `invalid_grant`.

### Fase 2: Migração da Inteligência para o Backend
* **Passo 1:** Transferir todo o escopo analítico (`getVisitasCompletas`, `inteligencia360`, `preCarregarVendas30D`, etc.) para o Web App Central.
* **Passo 2:** Criar uma nova rota no `doPost` do Backend chamada `processarRaioX`.
    * *Input:* Lista de IDs dos anúncios e o `access_token` vigente do usuário.
    * *Processamento:* O Backend faz a comunicação com o ML, cruza os dados e roda a matriz do Squad 360.
    * *Output:* Array de arrays, formatado exatamente como a planilha espera receber nas células.

### Fase 3: Redução da Planilha a Terminal Burro
* **Passo 1:** Apagar toda a lógica de negócio do arquivo `motor360.gs.js` no cliente.
* **Passo 2:** Refatorar a função principal de auditoria no cliente para se comportar como um roteador de pacotes:
    1.  Lê os IDs da planilha.
    2.  Separa em lotes de 50.
    3.  Envia o Lote 1 para o Web App Central aguardando a resposta.
    4.  Imprime a resposta na aba `DESEMPENHO`.
    5.  Avança para o Lote 2, renovando o próprio tempo de execução (trigger) conforme necessário para evitar o limite de 6 minutos do Google.

### Fase 4: Auditoria de Segurança Final e Testes de Carga
* **Passo 1:** Simular injeção de erros nas rotas do Web App para testar a resiliência das validações de origem.
* **Passo 2:** Testar o tempo de resposta da API Central processando contas com mais de 5.000 anúncios para otimizar os tempos de limite (`Timeout`) entre o Terminal Burro e o Cérebro.