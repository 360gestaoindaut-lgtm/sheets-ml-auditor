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
 */

function doPost(e) {
  var props = PropertiesService.getScriptProperties();

  // ── Validação do token Hotmart ────────────────────────────────────────────
  // O token é enviado como query param ?hottok=TOKEN na URL do webhook
  var hottokEsperado = props.getProperty("HOTMART_TOKEN");
  if (!hottokEsperado || e.parameter.hottok !== hottokEsperado) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: "Unauthorized" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── Parse do payload ──────────────────────────────────────────────────────
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch(err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: "Payload inválido" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Ignora silenciosamente eventos que não sejam compra aprovada
  var evento = (payload.event || "").toUpperCase();
  if (evento !== "PURCHASE_APPROVED") {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, ignorado: evento }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── Extração dos dados do comprador ───────────────────────────────────────
  var data           = payload.data     || {};
  var purchase       = data.purchase    || {};
  var buyer          = data.buyer       || {};
  var transacao_id   = String(purchase.transaction || "").trim();
  var email_comprador = String(buyer.email         || "").trim().toLowerCase();
  var nome_comprador  = String(buyer.name          || "Cliente").trim();

  if (!transacao_id || !email_comprador) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: "transacao_id ou email ausente" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── Provisionamento ───────────────────────────────────────────────────────
  try {
    var masterId = props.getProperty("MASTER_SHEET_ID");
    var pastaId  = props.getProperty("PASTA_CLIENTES_ID");
    if (!masterId || !pastaId) {
      throw new Error("MASTER_SHEET_ID ou PASTA_CLIENTES_ID não configurados");
    }

    // 1. Subpasta do cliente dentro de "01. Clientes Ativos"
    var pastaClientes = DriveApp.getFolderById(pastaId);
    var subpasta      = pastaClientes.createFolder(nome_comprador + " — " + transacao_id);

    // 2. Cópia do Master nomeada para o cliente
    var arquivoMaster = DriveApp.getFileById(masterId);
    var copia         = arquivoMaster.makeCopy("Raio-X ML — " + nome_comprador, subpasta);
    var novaPlanilha  = SpreadsheetApp.openById(copia.getId());

    // 3. Compartilhamento restrito ao e-mail da compra
    novaPlanilha.addEditor(email_comprador);
    // Bloqueia recompartilhamento: o cliente não pode adicionar outros editores
    novaPlanilha.setShareableByEditors(false);

    // 4. Handshake: injeta TRANSACAO_ID como metadado de arquivo (não em ScriptProperties)
    //    O frontend lê esse valor via createDeveloperMetadataFinder e o envia ao backend
    //    no registerCsrfState para que _registrarTenant faça o upsert correto (Fase 12).
    novaPlanilha.addDeveloperMetadata("TRANSACAO_ID", transacao_id);

    // 5. E-mail de boas-vindas com link e aviso de acesso restrito
    var linkPlanilha = "https://docs.google.com/spreadsheets/d/" + copia.getId() + "/edit";
    MailApp.sendEmail({
      to:       email_comprador,
      subject:  "✅ Seu acesso ao Raio-X ML está pronto!",
      body:     _emailTexto(nome_comprador, linkPlanilha, email_comprador),
      htmlBody: _emailHtml(nome_comprador, linkPlanilha, email_comprador)
    });

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, spreadsheetId: copia.getId() }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    console.error("Provisionamento falhou [" + transacao_id + "]: " + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
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
