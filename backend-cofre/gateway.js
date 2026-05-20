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
  var ssId        = uuid ? props.getProperty("CSRF_" + uuid) : null;
  if (uuid && ssId) props.deleteProperty("CSRF_" + uuid);
  // Recupera e consome o transacao_id vinculado ao CSRF state (Fase 12)
  var transacaoId = uuid ? props.getProperty("CSRF_TID_" + uuid) : null;
  if (transacaoId) props.deleteProperty("CSRF_TID_" + uuid);

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
      var identidade = _registrarTenant(resObj.access_token, transacaoId || "");
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
 * Upsert do tenant no Diretório Central (CLIENT_SHEET_ID → aba CLIENTES).
 * Três prioridades de busca:
 *   1. Handshake Hotmart: localiza linha via TRANSACAO_ID (col H) → UPDATE cols C, D, E, I.
 *   2. Re-login: localiza linha via SELLER_ID_ML (col C) → UPDATE nickname se mudou.
 *   3. Novo manual: insere linha com ID 360 sequencial.
 * Retorna { vendedor_id_360, vendedor_id_ml, vendedor_nome }.
 * Em qualquer falha retorna strings vazias — autenticação prossegue sem identidade.
 */
function _registrarTenant(accessToken, transacaoId) {
  var vazio = { vendedor_id_360: "", vendedor_id_ml: "", vendedor_nome: "" };
  var props   = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty("CLIENT_SHEET_ID");
  if (!sheetId) return vazio;

  // Obter identidade no ML
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
    // Lê B:H (7 colunas a partir da col 2) para cobrir TRANSACAO_ID na col H
    var dados = lastRow >= 2
      ? sheet.getRange(2, 2, lastRow - 1, 7).getValues()
      : [];
    // dados[i][0]=B SELLER_ID_360 | [1]=C SELLER_ID_ML | [2]=D SELLER_NICKNAME_ML
    // [3]=E STATUS | [4]=F NOTAS  | [5]=G EMAIL_COMPRADOR | [6]=H TRANSACAO_ID

    // ── Prioridade 1: Handshake Hotmart ──────────────────────────────────────
    if (transacaoId) {
      var idxTid = -1;
      for (var i = 0; i < dados.length; i++) {
        if (String(dados[i][6]) === transacaoId) { idxTid = i; break; }
      }
      if (idxTid >= 0) {
        var id360 = String(dados[idxTid][0]);
        var linha  = idxTid + 2; // +2: dados é 0-indexed a partir da linha 2
        sheet.getRange(linha, 3, 1, 2).setValues([[mlId, mlNick]]); // C:D
        sheet.getRange(linha, 5, 1, 1).setValues([["Ativo"]]);      // E (col I = ORIGEM já está correta)
        return { vendedor_id_360: id360, vendedor_id_ml: mlId, vendedor_nome: mlNick };
      }
    }

    // ── Prioridade 2: Re-login via SELLER_ID_ML ───────────────────────────────
    var idxMl = -1;
    for (var j = 0; j < dados.length; j++) {
      if (String(dados[j][1]) === mlId) { idxMl = j; break; }
    }
    if (idxMl >= 0) {
      var id360 = String(dados[idxMl][0]);
      if (String(dados[idxMl][2]) !== mlNick) {
        sheet.getRange(idxMl + 2, 4, 1, 1).setValues([[mlNick]]); // D
      }
      return { vendedor_id_360: id360, vendedor_id_ml: mlId, vendedor_nome: mlNick };
    }

    // ── Prioridade 3: Novo manual ─────────────────────────────────────────────
    var maxSeq = 0;
    dados.forEach(function(row) {
      var n = parseInt(String(row[0]).replace(/\D/g, ""), 10);
      if (!isNaN(n) && n > maxSeq) maxSeq = n;
    });
    var novoId360 = ("000000" + (maxSeq + 1)).slice(-6);
    var agora     = obterDataFormatada360();
    var origem    = transacaoId ? "Hotmart" : "Manual";

    // Força formato texto em B e C antes de gravar (preserva zeros à esquerda)
    sheet.getRange(lastRow + 1, 2, 1, 2).setNumberFormat("@");
    // Layout: A=DATA | B=SELLER_ID_360 | C=SELLER_ID_ML | D=SELLER_NICKNAME_ML |
    //         E=STATUS | F=NOTAS | G=ORIGEM | H=TRANSACAO_ID | I=DATA_ATIVACAO
    sheet.getRange(lastRow + 1, 1, 1, 9).setValues([[
      agora, novoId360, mlId, mlNick, "Ativo", "", origem, transacaoId || "", agora
    ]]);
    return { vendedor_id_360: novoId360, vendedor_id_ml: mlId, vendedor_nome: mlNick };

  } catch(e) {
    console.error("_registrarTenant: " + e.message);
    return { vendedor_id_360: "", vendedor_id_ml: mlId, vendedor_nome: mlNick };
  }
}

/**
 * Valida licença e aplica vínculo de instância (hardware binding).
 * Localiza a linha pelo par (email, chave=transacaoId) na aba CLIENTES.
 * Busca a coluna PLANILHA_ID dinamicamente na linha 1 para resiliência a
 * mudanças de índice.
 *
 * Condição 1 — Primeiro acesso: célula PLANILHA_ID vazia → grava planilhaId e retorna true.
 * Condição 2 — Acessos subsequentes: compara PLANILHA_ID salvo; true se igual, false se divergir.
 * Se a coluna PLANILHA_ID ainda não existir no cabeçalho, permite o acesso sem binding.
 */
function _validarLicenca(email, chave, planilhaId) {
  if (!email || !chave || !planilhaId) return false;

  var emailNorm = String(email).trim().toLowerCase();
  var chaveNorm = String(chave).trim();
  var idNorm    = String(planilhaId).trim();

  var props   = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty("CLIENT_SHEET_ID");
  if (!sheetId) return false;

  try {
    var ss    = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName("CLIENTES");
    if (!sheet) return false;

    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return false;

    // Localiza coluna PLANILHA_ID dinamicamente na linha 1 (imune a espaços acidentais)
    var headers  = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var colIndex = headers.map(function(h) { return String(h).trim(); }).indexOf("PLANILHA_ID");
    // colIndex é 0-based; -1 se não encontrado

    // Lê todas as linhas de dados (lastCol já cobre PLANILHA_ID pois está na linha 1)
    var dados = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

    // Localiza linha pelo par email (col G = índice 6) + chave (col H = índice 7)
    var idxRow = -1;
    for (var i = 0; i < dados.length; i++) {
      if (String(dados[i][6] || "").trim().toLowerCase() === emailNorm &&
          String(dados[i][7] || "").trim()                === chaveNorm) {
        idxRow = i;
        break;
      }
    }
    if (idxRow < 0) return false; // licença não encontrada

    // Sem coluna PLANILHA_ID: binding não configurado — permite acesso
    if (colIndex < 0) return true;

    // Aplica hardware binding com lógica à prova de falhas
    var savedId     = dados[idxRow][colIndex];
    var isCellEmpty = (!savedId || String(savedId).trim() === "");

    if (isCellEmpty) {
      // Primeiro acesso: vincula esta planilha à licença (idxRow+2: +1 header, +1 base-1)
      sheet.getRange(idxRow + 2, colIndex + 1).setValue(idNorm);
      return true;
    }

    // Acessos subsequentes: verifica vínculo
    return String(savedId).trim() === idNorm;

  } catch(err) {
    console.error("_validarLicenca: " + err.message);
    return false;
  }
}

/**
 * ESSENCIAL: Responde à planilha quando ela pede o token salvo.
 * Rotas OAuth (registerCsrfState, fetchToken) são isentas de validação de licença.
 * Todas as demais rotas exigem email + chave + planilhaId válidos.
 */
function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var data  = JSON.parse(e.postData.contents);

  // ── Middleware: validação de licença e vínculo de instância ──────────────
  var ROTAS_SISTEMA = ["registerCsrfState", "fetchToken"];
  if (ROTAS_SISTEMA.indexOf(data.action) === -1) {
    if (!_validarLicenca(data.email || "", data.chave || "", data.planilhaId || "")) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: "Unauthorized" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ── Registro de CSRF state: uuid → spreadsheetId (Fase 1 — Vuln. D) ─────
  if (data.action === "registerCsrfState") {
    if (data.uuid && data.spreadsheetId) {
      props.setProperty("CSRF_" + data.uuid, data.spreadsheetId);
      if (data.transacao_id) props.setProperty("CSRF_TID_" + data.uuid, data.transacao_id);
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
