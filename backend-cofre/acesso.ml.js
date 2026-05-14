/**
 * ACESSO.ML - O COFRE CENTRAL DA 360 GESTÃO
 * Este script recebe o código do ML e entrega o Token para a Planilha.
 */

function doGet(e) {
  var props = PropertiesService.getScriptProperties();
  var code = e.parameter.code;
  var state = e.parameter.state; // ID da planilha que solicitou

  if (!code) return HtmlService.createHtmlOutput("Erro: Código não recebido.");

  // 1. Troca o código pelo Token real
  var payload = {
    'grant_type': 'authorization_code',
    'client_id': props.getProperty('CLIENT_ID'),
    'client_secret': props.getProperty('CLIENT_SECRET'),
    'code': code,
    'redirect_uri': ScriptApp.getService().getUrl()
  };

  var response = UrlFetchApp.fetch("https://api.mercadolibre.com/oauth/token", {
    'method': 'post', 'payload': payload, 'muteHttpExceptions': true
  });
  
  var resObj = JSON.parse(response.getContentText());

  // 2. Se deu certo, guarda no cofre usando o ID da planilha como chave
  if (resObj.access_token) {
    if (state) {
      props.setProperty("TEMP_TOKEN_" + state, response.getContentText());
    }
    return HtmlService.createHtmlOutput(`
      <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h2 style="color: #2e7d32;">✅ Autorização Concluída!</h2>
        <p>Pode fechar esta aba e clicar em <b>"FINALIZAR CONEXÃO"</b> na sua planilha.</p>
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
 */
function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var data  = JSON.parse(e.postData.contents);

  // ── Entrega token temporário para a planilha do cliente ──────────────
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

  // ── Renova access_token via refresh_token (CLIENT_SECRET fica aqui) ──
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

  return ContentService
    .createTextOutput(JSON.stringify({ error: "Aguardando autorização..." }))
    .setMimeType(ContentService.MimeType.JSON);
}
