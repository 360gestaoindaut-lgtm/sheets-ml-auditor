/**
 * GATEWAY — O COFRE CENTRAL DA 360 GESTÃO
 * Recebe o código OAuth do ML, entrega o Token à Planilha e roteia todas as ações do backend.
 */

function doGet(e) {
  var props = PropertiesService.getScriptProperties();
  var code  = e.parameter.code;
  var uuid  = e.parameter.state; // Fase 1: agora é UUID opaco, não mais o ssId em texto puro

  if (!code) return HtmlService.createHtmlOutput("Erro: Código não recebido.");

  // Valida e consome o CSRF token: busca ssId via uuid, apaga a chave CSRF imediatamente
  var ssId = uuid ? props.getProperty("CSRF_" + uuid) : null;
  if (uuid && ssId) props.deleteProperty("CSRF_" + uuid);

  // 1. Troca o código pelo Token real
  var payload = {
    'grant_type': 'authorization_code',
    'client_id':  props.getProperty('CLIENT_ID'),
    'client_secret': props.getProperty('CLIENT_SECRET'),
    'code': code,
    'redirect_uri': ScriptApp.getService().getUrl()
  };

  var response = UrlFetchApp.fetch("https://api.mercadolibre.com/oauth/token", {
    'method': 'post', 'payload': payload, 'muteHttpExceptions': true
  });

  var resObj = JSON.parse(response.getContentText());

  // 2. Se deu certo, guarda no cofre usando o ssId (recuperado do CSRF) como chave
  if (resObj.access_token) {
    if (ssId) {
      props.setProperty("TEMP_TOKEN_" + ssId, response.getContentText());
    }
    return HtmlService.createHtmlOutput(`
      <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h2 style="color: #2e7d32;">✅ Autorização Concluída!</h2>
        <p>Pode fechar esta aba. Sua planilha será atualizada automaticamente.</p>
        <script>setTimeout(function() { window.close(); }, 2000);</script>
      </div>
    `);
  } else {
    return HtmlService.createHtmlOutput(`
      <div style="font-family: sans-serif; color: red; padding: 20px;">
        <h2>❌ Erro na Troca do Token</h2>
        <pre>${JSON.stringify(resObj, null, 2)}</pre>
      </div>
    `);
  }
}

/**
 * ESSENCIAL: Responde à planilha quando ela pede o token salvo.
 * Todas as rotas exigem apiKey válida — rejeita requisições de origem desconhecida.
 */
function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var data  = JSON.parse(e.postData.contents);

  // ── Validação de origem via API Key interna (Fase 1 — Vuln. A) ───────────
  var INTERNAL_KEY = props.getProperty('INTERNAL_API_KEY');
  if (!INTERNAL_KEY || data.apiKey !== INTERNAL_KEY) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: "Unauthorized" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── Registro de CSRF state: uuid → spreadsheetId (Fase 1 — Vuln. D) ─────
  if (data.action === "registerCsrfState") {
    if (data.uuid && data.spreadsheetId) {
      props.setProperty("CSRF_" + data.uuid, data.spreadsheetId);
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ── Entrega token temporário para a planilha do cliente ──────────────────
  if (data.action === "fetchToken") {
    var key       = "TEMP_TOKEN_" + data.spreadsheetId;
    var tokenData = props.getProperty(key);
    if (tokenData) {
      props.deleteProperty(key); // limpa após entrega (segurança)
      return ContentService
        .createTextOutput(tokenData)
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ── Renova access_token via refresh_token (CLIENT_SECRET fica aqui) ──────
  if (data.action === "refreshToken") {
    var refresh = data.refresh_token;
    if (!refresh) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: "refresh_token ausente" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var resp = UrlFetchApp.fetch("https://api.mercadolibre.com/oauth/token", {
      method:             "post",
      payload:            {
        grant_type:    "refresh_token",
        client_id:     props.getProperty("CLIENT_ID"),
        client_secret: props.getProperty("CLIENT_SECRET"),
        refresh_token: refresh
      },
      muteHttpExceptions: true
    });
    return ContentService
      .createTextOutput(resp.getContentText())
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── Processa lote de IDs e retorna linhas prontas para a planilha (Fase 2) ─
  if (data.action === "processarRaioX") {
    if (!data.access_token || !data.refresh_token || !data.user_id ||
        !Array.isArray(data.ids) || data.ids.length === 0) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: "Payload inválido.", rows: [] }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var resultado = processarRaioX_Backend({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      user_id:       data.user_id,
      ids:           data.ids
    });
    return ContentService
      .createTextOutput(JSON.stringify(resultado))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ error: "Ação desconhecida" }))
    .setMimeType(ContentService.MimeType.JSON);
}
