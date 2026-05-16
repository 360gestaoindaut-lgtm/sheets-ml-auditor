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

  // 2. Se deu certo: registra/atualiza tenant no Diretório Central e guarda token estendido
  if (resObj.access_token) {
    if (ssId) {
      var identidade = _registrarTenant(resObj.access_token);
      var tokenFinal = {
        access_token:    resObj.access_token,
        refresh_token:   resObj.refresh_token,
        user_id:         resObj.user_id,
        vendedor_id_360: identidade.vendedor_id_360,
        vendedor_id_ml:  identidade.vendedor_id_ml,
        vendedor_nome:   identidade.vendedor_nome
      };
      props.setProperty("TEMP_TOKEN_" + ssId, JSON.stringify(tokenFinal));
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
 * Registra ou atualiza o tenant no Diretório Central (planilha CLIENT_SHEET_ID → aba CLIENTES).
 * Retorna { vendedor_id_360, vendedor_id_ml, vendedor_nome }.
 * Em qualquer falha retorna strings vazias — autenticação prossegue sem identidade.
 */
function _registrarTenant(accessToken) {
  var vazio = { vendedor_id_360: "", vendedor_id_ml: "", vendedor_nome: "" };
  var props   = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty("CLIENT_SHEET_ID");
  if (!sheetId) return vazio;

  // 1. Obter identidade no ML
  var meResp = UrlFetchApp.fetch("https://api.mercadolibre.com/users/me", {
    headers: { "Authorization": "Bearer " + accessToken }, muteHttpExceptions: true
  });
  var me = JSON.parse(meResp.getContentText());
  if (!me || !me.id) return vazio;

  var mlId   = String(me.id);
  var mlNick = me.nickname || "";

  try {
    var ss    = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName("CLIENTES");
    if (!sheet) sheet = ss.insertSheet("CLIENTES");

    var lastRow = sheet.getLastRow();
    var dados   = lastRow >= 2
      ? sheet.getRange(2, 2, lastRow - 1, 3).getValues()  // B:D a partir da linha 2
      : [];

    // 2. Buscar ML ID na coluna C (índice 1 dentro de dados[][])
    var idxEncontrado = -1;
    for (var i = 0; i < dados.length; i++) {
      if (String(dados[i][1]) === mlId) { idxEncontrado = i; break; }
    }

    if (idxEncontrado >= 0) {
      // Cliente reconectando — recupera ID 360 e atualiza nickname se mudou
      var id360 = String(dados[idxEncontrado][0]);
      if (String(dados[idxEncontrado][2]) !== mlNick) {
        sheet.getRange(idxEncontrado + 2, 4, 1, 1).setValues([[mlNick]]);
      }
      return { vendedor_id_360: id360, vendedor_id_ml: mlId, vendedor_nome: mlNick };
    }

    // 3. Novo tenant — próximo ID sequencial de 6 dígitos
    var maxSeq = 0;
    dados.forEach(function(row) {
      var n = parseInt(String(row[0]).replace(/\D/g, ""), 10);
      if (!isNaN(n) && n > maxSeq) maxSeq = n;
    });
    var novoId360 = ("000000" + (maxSeq + 1)).slice(-6);
    var hoje      = Utilities.formatDate(new Date(), "America/Sao_Paulo", "yyyy-MM-dd");

    // Força formato de texto nas colunas B (ID 360) e C (ID ML) antes de gravar,
    // garantindo que strings numéricas com zeros à esquerda não sejam convertidas para float.
    sheet.getRange(lastRow + 1, 2, 1, 2).setNumberFormat("@");
    sheet.getRange(lastRow + 1, 1, 1, 6).setValues([[hoje, novoId360, mlId, mlNick, "Ativo", ""]]);
    return { vendedor_id_360: novoId360, vendedor_id_ml: mlId, vendedor_nome: mlNick };

  } catch(e) {
    console.error("_registrarTenant: " + e.message);
    return { vendedor_id_360: "", vendedor_id_ml: mlId, vendedor_nome: mlNick };
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
      ids:           data.ids,
      vendedor_id:    data.vendedor_id    || "",
      vendedor_id_ml: data.vendedor_id_ml || "",
      vendedor_nome:  data.vendedor_nome  || ""
    });
    return ContentService
      .createTextOutput(JSON.stringify(resultado))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ error: "Ação desconhecida" }))
    .setMimeType(ContentService.MimeType.JSON);
}
