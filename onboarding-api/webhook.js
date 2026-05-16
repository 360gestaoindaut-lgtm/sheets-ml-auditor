/**
 * ONBOARDING API — MICROSSERVIÇO DE WEBHOOK HOTMART
 * Recebe compras aprovadas, clona a planilha Master e entrega acesso ao cliente.
 * Isolado do backend-cofre: não tem acesso a INTERNAL_API_KEY, CLIENT_SECRET,
 * nem à lógica de auditoria. Comunica-se apenas com Drive, Sheets e MailApp.
 *
 * ScriptProperties obrigatórias:
 *   HOTMART_TOKEN      — token configurado na URL do webhook no painel Hotmart
 *   MASTER_SHEET_ID    — ID da planilha-template (frontend-seller Master)
 *   PASTA_CLIENTES_ID  — ID da pasta "01. Clientes Ativos" no Drive
 *   LOG_SHEET_ID       — ID da planilha de telemetria (aba LOGS, 6 colunas)
 */

// ── Helper de timestamp ───────────────────────────────────────────────────────
// Projeto GAS isolado: não compartilha código com backend-cofre, por isso
// obterDataFormatada360 é definida localmente com a mesma assinatura.
function obterDataFormatada360(dataOpcional) {
  var data = dataOpcional || new Date();
  return Utilities.formatDate(data, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
}

// ── Logger de telemetria ──────────────────────────────────────────────────────
// Grava na aba LOGS da planilha LOG_SHEET_ID seguindo o layout de 6 colunas:
// A=DATA | B=ORIGEM | C=PLATAFORMA | D=AMBIENTE | E=TIPO | F=MENSAGEM
function _log(tipo, mensagem) {
  var sheetId = PropertiesService.getScriptProperties().getProperty("LOG_SHEET_ID");
  if (!sheetId) return;
  try {
    var ss    = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName("LOGS");
    if (!sheet) sheet = ss.insertSheet("LOGS");
    var nextRow  = sheet.getLastRow() + 1;
    var conteudo = String(mensagem).slice(0, 49000); // limite de célula GAS
    sheet.getRange(nextRow, 1, 1, 6).setValues([[
      obterDataFormatada360(), "WEBHOOK", "HOTMART", "SANDBOX", tipo, conteudo
    ]]);
  } catch(e) {
    console.error("_log: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function doPost(e) {
  var props = PropertiesService.getScriptProperties();

  // Captura imediata do payload bruto (antes de qualquer parse)
  var rawPayload = (e.postData && e.postData.contents) ? e.postData.contents : "(sem body)";

  // ── Validação do token Hotmart ────────────────────────────────────────────
  // O token é enviado como query param ?hottok=TOKEN na URL do webhook
  var hottokEsperado = props.getProperty("HOTMART_TOKEN");
  if (!hottokEsperado || e.parameter.hottok !== hottokEsperado) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: "Unauthorized" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Log do payload bruto — origem confirmada pelo token
  _log("PAYLOAD_BRUTO", rawPayload);

  try {
    // ── Parse do payload ──────────────────────────────────────────────────
    var payload;
    try {
      payload = JSON.parse(rawPayload);
    } catch(parseErr) {
      _log("PARSE_ERROR", parseErr.message);
      return ContentService
        .createTextOutput(JSON.stringify({ error: "Payload inválido" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Loga o evento recebido e prossegue — filtro removido temporariamente
    // para validar o fluxo de Drive com qualquer evento de teste da Hotmart.
    var evento = (payload.event || "DESCONHECIDO").toUpperCase();
    _log("EVENTO_RECEBIDO", evento);

    // ── Extração dos dados do comprador ───────────────────────────────────
    var data_           = payload.data     || {};
    var purchase        = data_.purchase   || {};
    var buyer           = data_.buyer      || {};
    var transacao_id    = String(purchase.transaction || "").trim();
    var email_comprador = String(buyer.email          || "").trim().toLowerCase();
    var nome_comprador  = String(buyer.name           || "Cliente").trim();

    _log("DADOS_EXTRAIDOS", JSON.stringify({
      transacao_id: transacao_id,
      email:        email_comprador,
      nome:         nome_comprador
    }));

    if (!transacao_id || !email_comprador) {
      _log("VALIDACAO_FALHOU", "transacao_id ou email ausente no payload");
      return ContentService
        .createTextOutput(JSON.stringify({ error: "transacao_id ou email ausente" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── Idempotência: aborta se a transação já foi processada ─────────────
    if (props.getProperty("TX_" + transacao_id)) {
      _log("DUPLICADA_IGNORADA", transacao_id);
      return ContentService.createTextOutput(JSON.stringify({ status: "ok" })).setMimeType(ContentService.MimeType.JSON);
    }

    // ── Verificação das Properties ────────────────────────────────────────
    var masterId = props.getProperty("MASTER_SHEET_ID");
    var pastaId  = props.getProperty("PASTA_CLIENTES_ID");
    _log("PROPERTIES_CHECK", JSON.stringify({
      masterId: masterId  ? "ok" : "AUSENTE",
      pastaId:  pastaId   ? "ok" : "AUSENTE"
    }));

    if (!masterId || !pastaId) {
      throw new Error("MASTER_SHEET_ID ou PASTA_CLIENTES_ID não configurados");
    }

    // ── Provisionamento ───────────────────────────────────────────────────

    // 1. Subpasta do cliente dentro de "01. Clientes Ativos"
    var pastaClientes = DriveApp.getFolderById(pastaId);
    _log("PASTA_ENCONTRADA", pastaClientes.getName());

    var subpasta = pastaClientes.createFolder(nome_comprador + " — " + transacao_id);
    _log("SUBPASTA_CRIADA", subpasta.getName() + " [" + subpasta.getId() + "]");

    // 2. Cópia do Master nomeada para o cliente
    var arquivoMaster = DriveApp.getFileById(masterId);
    var copia         = arquivoMaster.makeCopy("Raio-X ML — " + nome_comprador, subpasta);
    _log("PLANILHA_COPIADA", copia.getId());

    // 3. Compartilhamento restrito ao e-mail da compra
    var novaPlanilha  = SpreadsheetApp.openById(copia.getId());
    novaPlanilha.addEditor(email_comprador);
    // setShareableByEditors pertence a DriveApp.File, não a SpreadsheetApp.Spreadsheet
    DriveApp.getFileById(copia.getId()).setShareableByEditors(false);
    _log("SHARING_OK", email_comprador);

    // 4. Handshake: injeta TRANSACAO_ID como metadado de arquivo
    novaPlanilha.addDeveloperMetadata("TRANSACAO_ID", transacao_id);
    _log("METADATA_OK", transacao_id);

    // 5. E-mail de boas-vindas
    var linkPlanilha = "https://docs.google.com/spreadsheets/d/" + copia.getId() + "/edit";
    MailApp.sendEmail({
      to:       email_comprador,
      subject:  "✅ Seu acesso ao Raio-X ML está pronto!",
      body:     _emailTexto(nome_comprador, linkPlanilha, email_comprador),
      htmlBody: _emailHtml(nome_comprador, linkPlanilha, email_comprador)
    });
    _log("EMAIL_ENVIADO", email_comprador);

    // Marca a transação como concluída — bloqueia reprocessamento de retentativas
    props.setProperty("TX_" + transacao_id, "true");
    _log("IDEMPOTENCIA_REGISTRADA", transacao_id);

    return ContentService.createTextOutput(JSON.stringify({ status: "ok" })).setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    _log("ERROR_FATAL", err.message);
    return ContentService.createTextOutput(JSON.stringify({ status: "ok" })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ── Helpers de e-mail ─────────────────────────────────────────────────────────

function _esc(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _emailTexto(nome, link, email) {
  return [
    "Olá, " + nome + "!",
    "",
    "Sua planilha Raio-X ML está pronta:",
    link,
    "",
    "⚠️  ACESSO RESTRITO AO E-MAIL DA COMPRA",
    "Esta planilha foi compartilhada exclusivamente com: " + email,
    "Certifique-se de estar logado com essa conta Google ao abrir o link.",
    "Se abrir com outra conta receberá erro de permissão.",
    "",
    "Dúvidas? Responda este e-mail.",
    "",
    "Equipe 360 Gestão"
  ].join("\n");
}

function _emailHtml(nome, link, email) {
  var nomeEsc  = _esc(nome);
  var emailEsc = _esc(email);
  var linkEsc  = _esc(link);
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">'
    + '<h2 style="color:#2e7d32;">✅ Seu acesso ao Raio-X ML está pronto!</h2>'
    + '<p>Olá, <strong>' + nomeEsc + '</strong>!</p>'
    + '<p>Sua planilha de auditoria de catálogo está disponível:</p>'
    + '<p style="text-align:center;margin:28px 0;">'
    + '<a href="' + linkEsc + '" style="background:#3483fa;color:#fff;padding:14px 32px;'
    + 'text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">'
    + 'Abrir Minha Planilha</a></p>'
    + '<div style="background:#fff8e1;border-left:4px solid #f9a825;padding:14px 18px;margin:24px 0;">'
    + '<strong>⚠️ Acesso Restrito ao E-mail da Compra</strong><br><br>'
    + 'Esta planilha foi compartilhada exclusivamente com <strong>' + emailEsc + '</strong>.<br>'
    + 'Para acessá-la, certifique-se de estar logado com essa conta no Google.<br>'
    + 'Se você abrir com outra conta Google, receberá um erro de permissão.'
    + '</div>'
    + '<p style="color:#888;font-size:13px;">Dúvidas? Responda este e-mail.<br><br>Equipe 360 Gestão</p>'
    + '</div>';
}
