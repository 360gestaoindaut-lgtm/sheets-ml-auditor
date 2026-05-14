// CONFIGURAÇÕES DA 360 GESTÃO — NÃO EXPÕE O CLIENT_SECRET
var CLIENT_ID   = "334744915172650";
var WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyGFGO3cEpyc98h3lKLKDr5lpZi6MLr_HeS8t6ZPcyZnAhF6JbbhfGyg9mWxO79C4AH/exec";

// ← onOpen REMOVIDO daqui (está agora em motor360_gas.js)

function abrirLoginML() {
  var ssId        = SpreadsheetApp.getActiveSpreadsheet().getId();
  var redirectUri = encodeURIComponent(WEB_APP_URL);
  var url = "https://auth.mercadolivre.com.br/authorization?response_type=code"
          + "&client_id=" + CLIENT_ID
          + "&redirect_uri=" + redirectUri
          + "&state=" + ssId;

  var htmlContent = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;text-align:center;padding:20px;background:#f9f9f9;">
      <h3 style="color:#333;margin-bottom:20px;">Conexão 360 Gestão</h3>
      <div style="margin-bottom:25px;padding:15px;border:1px solid #ddd;border-radius:8px;background:white;">
        <p style="font-size:14px;margin-bottom:10px;"><b>Passo 1:</b> Autorize o acesso</p>
        <a href="${url}" target="_blank"
           style="background:#3483fa;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;display:inline-block;font-weight:bold;">
          ABRIR MERCADO LIVRE
        </a>
      </div>
      <div style="padding:15px;border:1px solid #ddd;border-radius:8px;background:white;">
        <p style="font-size:14px;margin-bottom:10px;"><b>Passo 2:</b> Confirme a conexão</p>
        <button onclick="verificar()"
           style="background:#00a650;color:white;padding:12px 24px;border:none;border-radius:6px;cursor:pointer;font-weight:bold;width:100%;">
          FINALIZAR CONEXÃO
        </button>
      </div>
      <script>
        function verificar() {
          google.script.run.withSuccessHandler(function(res) {
            if (res === "OK") {
              alert("✅ Conta conectada com sucesso!");
              google.script.host.close();
            } else {
              alert("Aguardando autorização... Certifique-se de ter completado o login na aba que abriu.");
            }
          }).tentarCapturarToken();
        }
      </script>
    </div>`;

  var html = HtmlService.createHtmlOutput(htmlContent).setWidth(380).setHeight(320);
  SpreadsheetApp.getUi().showModalDialog(html, "Configuração de Acesso");
}

function tentarCapturarToken() {
  var ssId    = SpreadsheetApp.getActiveSpreadsheet().getId();
  var payload = JSON.stringify({ action: "fetchToken", spreadsheetId: ssId });
  try {
    var response = UrlFetchApp.fetch(WEB_APP_URL, {
      method: "post", contentType: "application/json",
      payload: payload, muteHttpExceptions: true
    });
    var data = JSON.parse(response.getContentText());
    if (data.access_token) { salvarTokens(data); return "OK"; }
  } catch(e) { console.error("Erro no resgate: " + e.message); }
  return "WAIT";
}

function salvarTokens(data) {
  PropertiesService.getUserProperties().setProperties({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    user_id:       data.user_id.toString()
  });
}
