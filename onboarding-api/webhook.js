/**
 * ONBOARDING API — MICROSSERVIÇO DE WEBHOOK HOTMART
 * Arquitetura assíncrona de fila para respeitar o timeout de 10s da Hotmart.
 *
 *   doPost              → Recepcionista: valida token, enfileira payload, retorna 200 em < 1s.
 *   processarFilaVendas → Operário: lê a fila e executa o provisionamento pesado (~13s).
 *   instalarTrigger     → Executar UMA VEZ no editor GAS para agendar o operário.
 *
 * ScriptProperties obrigatórias:
 *   HOTMART_TOKEN      — token configurado na URL do webhook (?hottok=TOKEN)
 *   MASTER_SHEET_ID    — ID da planilha-template (frontend-seller Master)
 *   PASTA_CLIENTES_ID  — ID da pasta "01. Clientes Ativos" no Drive
 *   LOG_SHEET_ID       — ID da planilha de telemetria (aba LOGS, 6 colunas)
 *
 * Prefixos de ScriptProperties usados em runtime:
 *   QUEUE_{txId}        — payload bruto aguardando processamento
 *   TX_{txId}           — marca de idempotência (provisionamento concluído)
 *   ERROR_QUEUE_{txId}  — payload que falhou; requer intervenção manual
 */

// ── Helper de timestamp ───────────────────────────────────────────────────────
// Projeto GAS isolado: replica obterDataFormatada360 de engine.js localmente.
function obterDataFormatada360(dataOpcional) {
  var data = dataOpcional || new Date();
  return Utilities.formatDate(data, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
}

// ── Logger de telemetria ──────────────────────────────────────────────────────
// Layout de 6 colunas idêntico ao backend-cofre:
// A=DATA | B=ORIGEM | C=PLATAFORMA | D=AMBIENTE | E=TIPO | F=MENSAGEM
function _log(tipo, mensagem) {
  var sheetId = PropertiesService.getScriptProperties().getProperty("LOG_SHEET_ID");
  if (!sheetId) return;
  try {
    var ss    = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName("LOGS");
    if (!sheet) sheet = ss.insertSheet("LOGS");
    var nextRow  = sheet.getLastRow() + 1;
    var conteudo = String(mensagem).slice(0, 49000);
    sheet.getRange(nextRow, 1, 1, 6).setValues([[
      obterDataFormatada360(), "WEBHOOK", "HOTMART", "SANDBOX", tipo, conteudo
    ]]);
  } catch(e) {
    console.error("_log: " + e.message);
  }
}

// =============================================================================
// ABSORVEDOR DO 302 — evita 405 no downgrade GET feito pela Hotmart
// =============================================================================
function doGet(e) {
  return HtmlService.createHtmlOutput("OK");
}

// =============================================================================
// RECEPCIONISTA — retorna HTTP 200 em < 1s
// =============================================================================
function doPost(e) {
  var props      = PropertiesService.getScriptProperties();
  var rawPayload = (e.postData && e.postData.contents) ? e.postData.contents : "";

  // ── Validação do token Hotmart ────────────────────────────────────────────
  var hottokEsperado = props.getProperty("HOTMART_TOKEN");
  if (!hottokEsperado || e.parameter.hottok !== hottokEsperado) {
    return HtmlService.createHtmlOutput("OK");
  }

  // Log do payload bruto — origem confirmada
  _log("PAYLOAD_BRUTO", rawPayload || "(sem body)");

  // ── Extração mínima: apenas transacao_id (sem operações pesadas) ──────────
  var transacao_id = "";
  try {
    var parsed   = JSON.parse(rawPayload);
    var evento   = (parsed.event || "DESCONHECIDO").toUpperCase();
    transacao_id = String(((parsed.data || {}).purchase || {}).transaction || "").trim();
    _log("EVENTO_RECEBIDO", evento);
  } catch(parseErr) {
    _log("PARSE_ERROR", parseErr.message);
    return HtmlService.createHtmlOutput("OK");
  }

  if (!transacao_id) {
    _log("TRANSACAO_AUSENTE", "transacao_id nao encontrado no payload");
    return HtmlService.createHtmlOutput("OK");
  }

  // ── Idempotência: já foi processado com sucesso? ──────────────────────────
  if (props.getProperty("TX_" + transacao_id)) {
    _log("DUPLICADA_IGNORADA", transacao_id);
    return HtmlService.createHtmlOutput("OK");
  }

  // ── Já está na fila? (retentativa antes do operário rodar) ───────────────
  if (props.getProperty("QUEUE_" + transacao_id)) {
    _log("JA_NA_FILA", transacao_id);
    return HtmlService.createHtmlOutput("OK");
  }

  // ── Enfileira e retorna ───────────────────────────────────────────────────
  props.setProperty("QUEUE_" + transacao_id, rawPayload);
  _log("VENDA_ENFILEIRADA", transacao_id);

  return HtmlService.createHtmlOutput("OK");
}

// =============================================================================
// OPERÁRIO — acionado pelo trigger a cada 1 minuto
// =============================================================================
function processarFilaVendas() {
  // Lock de script: se outra instância já está rodando, sai silenciosamente
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    return; // outra instância está processando
  }

  try {
    var props = PropertiesService.getScriptProperties();
    var todas = props.getProperties();
    var chaves = Object.keys(todas).filter(function(k) { return k.startsWith("QUEUE_"); });

    if (chaves.length === 0) return;

    _log("FILA_INICIANDO", chaves.length + " item(ns) na fila");

    chaves.forEach(function(chave) {
      var transacaoId = chave.substring("QUEUE_".length);
      var rawPayload  = todas[chave];
      _provisionarVenda(transacaoId, rawPayload, props);
    });

  } finally {
    lock.releaseLock();
  }
}

// =============================================================================
// PROVISIONAMENTO — lógica pesada isolada, chamada pelo operário
// =============================================================================
function _provisionarVenda(transacaoId, rawPayload, props) {
  _log("PROVISIONAMENTO_INICIADO", transacaoId);

  try {
    // Extração completa dos dados do comprador
    var payload         = JSON.parse(rawPayload);
    var data_           = payload.data    || {};
    var buyer           = data_.buyer     || {};
    var email_comprador = String(buyer.email || "").trim().toLowerCase();
    var nome_comprador  = String(buyer.name  || "Cliente").trim();

    if (!email_comprador) throw new Error("email do comprador ausente no payload enfileirado");

    // ── 1. Registro no Banco Central ─────────────────────────────────────
    var clientSheetId = props.getProperty("CLIENT_SHEET_ID");
    if (!clientSheetId) throw new Error("CLIENT_SHEET_ID nao configurado");

    var ss    = SpreadsheetApp.openById(clientSheetId);
    var sheet = ss.getSheetByName("CLIENTES");
    if (!sheet) sheet = ss.insertSheet("CLIENTES");

    var lastRow = sheet.getLastRow();
    var dadosB  = lastRow >= 2
      ? sheet.getRange(2, 2, lastRow - 1, 1).getValues()  // só coluna B (SELLER_ID_360)
      : [];
    var maxSeq = 0;
    dadosB.forEach(function(row) {
      var n = parseInt(String(row[0]).replace(/\D/g, ""), 10);
      if (!isNaN(n) && n > maxSeq) maxSeq = n;
    });
    var novoId360 = ("000000" + (maxSeq + 1)).slice(-6);
    var dataAtual = obterDataFormatada360();

    // Força formato texto na coluna B da nova linha (preserva zeros à esquerda)
    sheet.getRange(lastRow + 1, 2, 1, 1).setNumberFormat("@");
    // Layout 9 colunas:
    // A=DATA | B=SELLER_ID_360 | C=SELLER_ID_ML | D=SELLER_NICKNAME_ML |
    // E=STATUS | F=NOTAS | G=EMAIL_COMPRADOR | H=TRANSACAO_ID | I=ORIGEM
    sheet.getRange(lastRow + 1, 1, 1, 9).setValues([[
      dataAtual, novoId360, "", "", "Ativo", "", email_comprador, transacaoId, "Hotmart"
    ]]);
    _log("CLIENTE_REGISTRADO", novoId360 + " — " + email_comprador);

    // ── 2. E-mail de boas-vindas com credenciais de ativação ─────────────
    var masterId  = props.getProperty("MASTER_SHEET_ID");
    if (!masterId) throw new Error("MASTER_SHEET_ID nao configurado");
    var linkCopia = "https://docs.google.com/spreadsheets/d/" + masterId + "/copy";

    GmailApp.sendEmail(
      email_comprador,
      "✅ Seu acesso ao Raio-X ML está pronto!",
      _emailTexto(nome_comprador, linkCopia, email_comprador, transacaoId),
      {
        htmlBody: _emailHtml(nome_comprador, linkCopia, email_comprador, transacaoId),
        from:     "onboarding@360gestaoindaut.com.br",
        name:     "360 Gestão"
      }
    );
    _log("EMAIL_ENVIADO", email_comprador);

    // Sucesso: remove da fila e grava marca de idempotência
    props.deleteProperty("QUEUE_" + transacaoId);
    props.setProperty("TX_" + transacaoId, "true");
    _log("PROVISIONAMENTO_CONCLUIDO", transacaoId);

  } catch(err) {
    _log("ERROR_FATAL", transacaoId + " — " + err.message);
    // Move para fila de erro: não perde a venda, mas para as retentativas automáticas
    props.deleteProperty("QUEUE_" + transacaoId);
    props.setProperty("ERROR_QUEUE_" + transacaoId, rawPayload);
    _log("MOVIDA_PARA_ERROR_QUEUE", transacaoId);
  }
}

// =============================================================================
// INSTALAÇÃO DO TRIGGER — executar UMA VEZ no editor GAS (Run → instalarTrigger)
// =============================================================================
function instalarTrigger() {
  // Remove triggers duplicados antes de criar (seguro executar múltiplas vezes)
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === "processarFilaVendas"; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger("processarFilaVendas")
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log("Trigger instalado: processarFilaVendas a cada 1 minuto.");
}

// =============================================================================
// HELPERS DE E-MAIL
// =============================================================================

function _esc(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _emailTexto(nome, linkCopia, email, chave) {
  return [
    "Olá, " + nome + "!",
    "",
    "Sua compra foi confirmada. Siga os passos abaixo para acessar a ferramenta:",
    "",
    "PASSO 1 — Faça uma cópia gratuita da planilha:",
    linkCopia,
    "",
    "PASSO 2 — Na planilha copiada, acesse o menu '360 Gestão - ML' e clique em",
    "'Ativar Licença'. Informe as credenciais abaixo:",
    "",
    "  E-mail de Compra : " + email,
    "  Chave de Licença : " + chave,
    "",
    "Guarde esta chave em local seguro — ela é intransferível.",
    "",
    "Dúvidas? Responda este e-mail.",
    "",
    "Equipe 360 Gestão"
  ].join("\n");
}

function _emailHtml(nome, linkCopia, email, chave) {
  var nomeEsc   = _esc(nome);
  var emailEsc  = _esc(email);
  var chaveEsc  = _esc(chave);
  var linkEsc   = _esc(linkCopia);
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">'
    + '<h2 style="color:#2e7d32;">✅ Sua compra foi confirmada!</h2>'
    + '<p>Olá, <strong>' + nomeEsc + '</strong>! Siga os dois passos abaixo para começar.</p>'

    + '<div style="margin:24px 0;">'
    + '<p style="font-size:15px;font-weight:700;margin-bottom:8px;">Passo 1 — Faça sua cópia da planilha</p>'
    + '<p style="margin-bottom:16px;color:#555;">Clique no botão abaixo para criar sua cópia gratuita da ferramenta no Google Drive:</p>'
    + '<p style="text-align:center;">'
    + '<a href="' + linkEsc + '" style="background:#3483fa;color:#fff;padding:14px 32px;'
    + 'text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">'
    + 'Fazer Minha Cópia</a></p>'
    + '</div>'

    + '<div style="margin:24px 0;">'
    + '<p style="font-size:15px;font-weight:700;margin-bottom:8px;">Passo 2 — Ative sua licença</p>'
    + '<p style="color:#555;margin-bottom:12px;">Na planilha copiada, acesse o menu '
    + '<strong>360 Gestão - ML → &#x1F511; Ativar Licença</strong> e insira as credenciais abaixo:</p>'
    + '<div style="background:#f5f5f5;border-radius:8px;padding:16px 20px;font-family:monospace;font-size:14px;line-height:2;">'
    + '<div><span style="color:#888;font-size:12px;">E-MAIL DE COMPRA</span><br>'
    + '<strong>' + emailEsc + '</strong></div>'
    + '<div style="margin-top:10px;"><span style="color:#888;font-size:12px;">CHAVE DE LICENÇA</span><br>'
    + '<strong>' + chaveEsc + '</strong></div>'
    + '</div>'
    + '</div>'

    + '<p style="color:#888;font-size:12px;border-top:1px solid #eee;padding-top:16px;margin-top:8px;">'
    + 'Guarde esta chave em local seguro — ela é intransferível.<br>'
    + 'Dúvidas? Responda este e-mail.<br><br>Equipe 360 Gestão</p>'
    + '</div>';
}
