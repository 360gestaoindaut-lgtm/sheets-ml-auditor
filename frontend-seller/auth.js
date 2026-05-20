// CONFIGURAÇÕES DA 360 GESTÃO
var CLIENT_ID   = "334744915172650";
var WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzsq5T3x40SSgcKmhxJhEAZQNlphVd4xhKPJaZQFyV-WDdVIVvOw94p-erYoD3nX2my/exec";

// ← onOpen REMOVIDO daqui (está agora em motor360.js)

/**
 * Registra o par uuid → spreadsheetId no backend ANTES de abrir a URL do ML.
 * Garante que o parâmetro `state` da URL nunca exponha o ID da planilha em texto puro (Vuln. D).
 * Se a planilha tiver metadado TRANSACAO_ID (injetado pelo onboarding Hotmart), ele é incluído
 * no payload para que o backend faça o handshake de identidade na Fase 12.
 */
function registrarCsrfState(uuid, ssId) {
  var transacaoId = "";
  try {
    var metadados = SpreadsheetApp.getActiveSpreadsheet()
      .createDeveloperMetadataFinder()
      .withKey("TRANSACAO_ID")
      .find();
    if (metadados.length > 0) transacaoId = metadados[0].getValue();
  } catch(err) {
    console.error("registrarCsrfState: falha ao ler TRANSACAO_ID — " + err.message);
  }

  UrlFetchApp.fetch(WEB_APP_URL, {
    method:             "post",
    contentType:        "application/json",
    payload:            JSON.stringify({
      action:        "registerCsrfState",
      uuid:          uuid,
      spreadsheetId: ssId,
      transacao_id:  transacaoId
    }),
    muteHttpExceptions: true
  });
}

function abrirLoginML() {
  if (!_licencaAtiva()) {
    SpreadsheetApp.getUi().alert("⚠️ Acesso Bloqueado\n\nPor favor, ative sua licença primeiro para utilizar a ferramenta.");
    abrirSidebarAtivacao();
    return;
  }
  var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
  var uuid = Utilities.getUuid(); // opaco — não revela ssId na URL do ML
  registrarCsrfState(uuid, ssId);

  var redirectUri = encodeURIComponent(WEB_APP_URL);
  var url = "https://auth.mercadolivre.com.br/authorization?response_type=code"
          + "&client_id=" + CLIENT_ID
          + "&redirect_uri=" + redirectUri
          + "&state=" + uuid;

  var htmlContent = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;text-align:center;padding:20px;background:#f9f9f9;">
      <h3 style="color:#333;margin-bottom:20px;">Conexão 360 Gestão</h3>

      <div style="margin-bottom:16px;padding:15px;border:1px solid #ddd;border-radius:8px;background:white;">
        <p style="font-size:14px;margin-bottom:10px;"><b>Passo 1:</b> Autorize o acesso no Mercado Livre</p>
        <a id="btnML" href="${url}" target="_blank" onclick="iniciarPolling()"
           style="background:#3483fa;color:white;padding:10px 22px;text-decoration:none;border-radius:5px;display:inline-block;font-weight:bold;">
          ABRIR MERCADO LIVRE
        </a>
      </div>

      <div id="statusArea" style="padding:15px;border:1px solid #ddd;border-radius:8px;background:white;min-height:54px;">
        <p id="statusMsg" style="font-size:13px;color:#888;margin:0;">
          Aguardando você abrir o Mercado Livre...
        </p>
      </div>

      <script>
        var _interval    = null;
        var _tentativas  = 0;
        var MAX_TENTATIVAS = 100; // 100 × 3s = 5 minutos de janela

        function iniciarPolling() {
          document.getElementById('statusMsg').textContent = '🔄 Aguardando autorização... (verificando a cada 3s)';
          var btn = document.getElementById('btnML');
          btn.style.opacity = '0.5';
          btn.style.pointerEvents = 'none';

          _interval = setInterval(function() {
            _tentativas++;
            if (_tentativas > MAX_TENTATIVAS) {
              clearInterval(_interval);
              document.getElementById('statusMsg').textContent =
                '⏰ Tempo esgotado. Feche esta janela e tente novamente.';
              return;
            }
            google.script.run
              .withSuccessHandler(function(res) {
                if (res === 'OK') {
                  clearInterval(_interval);
                  document.getElementById('statusMsg').innerHTML =
                    '✅ <b>Conta conectada com sucesso!</b> Fechando...';
                  setTimeout(function() { google.script.host.close(); }, 1500);
                }
              })
              .tentarCapturarToken();
          }, 3000);
        }
      </script>
    </div>`;

  var html = HtmlService.createHtmlOutput(htmlContent).setWidth(400).setHeight(300);
  SpreadsheetApp.getUi().showModalDialog(html, "Configuração de Acesso");
}

function tentarCapturarToken() {
  var ssId    = SpreadsheetApp.getActiveSpreadsheet().getId();
  var payload = JSON.stringify({
    action:        "fetchToken",
    spreadsheetId: ssId
  });
  try {
    var response = UrlFetchApp.fetch(WEB_APP_URL, {
      method: "post", contentType: "application/json",
      payload: payload, muteHttpExceptions: true
    });
    var data = JSON.parse(response.getContentText());
    if (data.access_token) { salvarTokens(data); return "OK"; }
  } catch (e) { console.error("Erro no resgate: " + e.message); }
  return "WAIT";
}

function salvarTokens(data) {
  PropertiesService.getUserProperties().setProperties({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    user_id:       data.user_id.toString()
  });
  // Ancora de identidade imutável: gravada no momento do OAuth e nunca depende de input manual
  PropertiesService.getScriptProperties().setProperties({
    CLIENT_ID:     data.vendedor_id_360 || "",
    CLIENT_ID_ML:  data.vendedor_id_ml  || "",
    CLIENT_NAME:   data.vendedor_nome   || ""
  });
}

// =============================================================================
// GESTÃO DE LICENÇA — DocumentProperties (por documento, não por usuário)
// =============================================================================

function _licencaAtiva() {
  var lic = obterLicenca();
  return !!(lic && lic.email && lic.chave);
}

function salvarLicenca(email, chave) {
  PropertiesService.getDocumentProperties().setProperties({
    licenca_email: email.trim().toLowerCase(),
    licenca_chave: chave.trim()
  });
}

function obterLicenca() {
  var p     = PropertiesService.getDocumentProperties();
  var email = p.getProperty("licenca_email");
  var chave = p.getProperty("licenca_chave");
  if (!email || !chave) return null;
  return {
    email:      email,
    chave:      chave,
    planilhaId: SpreadsheetApp.getActiveSpreadsheet().getId()
  };
}
