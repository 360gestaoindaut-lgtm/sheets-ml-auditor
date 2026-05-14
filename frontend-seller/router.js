/**
 * ROUTER — TERMINAL BURRO 360 GESTÃO
 * Google Apps Script — Versão SaaS Low Ticket
 *
 * Toda a inteligência analítica (Squad 360, chamadas à API do ML, pesos e
 * diagnósticos) reside exclusivamente no engine.js do backend-cofre.
 * Este arquivo é um terminal minimalista: coleta IDs, envia lotes ao
 * gateway e imprime as linhas recebidas na planilha.
 */

// =============================================================================
// CONFIGURAÇÕES GLOBAIS
// =============================================================================
var CONFIG = {
  SHEET_NAME:    "DESEMPENHO",
  TIMEOUT_TOTAL: 300000,   // 5 min (Google mata em 6 min)
  BATCH_SIZE:    10,
  MAX_ANUNCIOS:  5000,
  API_BASE:      "https://api.mercadolibre.com",
  MODO_TESTE:    false,     // ← true = processa só MAX_TESTE itens; false = todos
  MAX_TESTE:     10
};

// =============================================================================
// MENU
// =============================================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("360 Gestão - ML")
    .addItem("1. Conectar Conta Mercado Livre", "abrirLoginML")
    .addItem("2. Sincronizar Catálogo",          "sincronizarAnuncios")
    .addItem("3. Rodar Raio-X (Auditoria)",      "rodarRaioX")
    .addSeparator()
    .addItem("Criar Cabeçalho", "criarCabecalho")
    .addToUi();
}

// =============================================================================
// 1. SINCRONIZAÇÃO — Modo Scan
// =============================================================================
function sincronizarAnuncios() {
  var props  = PropertiesService.getUserProperties();
  var token  = props.getProperty("access_token");
  var userId = props.getProperty("user_id");
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var sheet  = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!token || !userId) {
    return SpreadsheetApp.getUi().alert("❌ Conecte a conta no Passo 1 primeiro.");
  }

  sheet.getRange("B2:B").clearContent();
  ss.toast("Buscando catálogo. Aguarde...", "360 Gestão", 20);

  var headers  = { "Authorization": "Bearer " + token };
  var todosIds = [];
  var urlScan  = CONFIG.API_BASE + "/users/" + userId +
                 "/items/search?status=active,paused&search_type=scan&limit=100";

  while (true) {
    var res = fetchComStatus(urlScan, headers);
    if (res.status === 401) {
      token = renovarToken();
      if (!token) return SpreadsheetApp.getUi().alert("❌ Token inválido. Reconecte a conta.");
      headers = { "Authorization": "Bearer " + token };
      res = fetchComStatus(urlScan, headers);
    }

    var ids = (res.data && res.data.results) ? res.data.results : [];
    if (ids.length === 0) break;

    todosIds.push.apply(todosIds, ids);
    ss.toast("Catálogo: " + todosIds.length + " IDs capturados...", "360 Gestão", 5);

    var scrollId = res.data.scroll_id;
    if (!scrollId || todosIds.length >= CONFIG.MAX_ANUNCIOS) break;
    urlScan = CONFIG.API_BASE + "/users/" + userId +
              "/items/search?search_type=scan&scroll_id=" + scrollId;
  }

  if (todosIds.length === 0) {
    return SpreadsheetApp.getUi().alert("⚠️ Nenhum anúncio encontrado.");
  }

  var formatados = todosIds.map(function(id) { return [id]; });
  sheet.getRange(2, 2, formatados.length, 1).setValues(formatados);
  SpreadsheetApp.getUi().alert("✅ " + todosIds.length + " anúncios capturados!\n\nAgora clique em 'Rodar Raio-X' para auditar.");
}

// =============================================================================
// 2. RAIO-X — Terminal Burro (roteador de lotes para o servidor 360)
// =============================================================================
function rodarRaioX() {
  var startTotal = Date.now();

  var ss      = SpreadsheetApp.getActiveSpreadsheet();
  var sheet   = ss.getSheetByName(CONFIG.SHEET_NAME);
  var props   = PropertiesService.getUserProperties();
  var token   = props.getProperty("access_token");
  var refresh = props.getProperty("refresh_token");
  var userId  = props.getProperty("user_id");

  if (!token || !userId) {
    return SpreadsheetApp.getUi().alert("❌ Conecte sua conta antes de continuar.");
  }

  var ultimaLinha   = Math.max(sheet.getLastRow(), 2);
  var dadosPlanilha = sheet.getRange("A2:AN" + ultimaLinha).getValues();

  // Identifica pares {indice, id} de linhas ainda não auditadas
  var idsPendentes = [];
  for (var idx = 0; idx < dadosPlanilha.length; idx++) {
    var id     = String(dadosPlanilha[idx][1] || "").trim();
    var titulo = String(dadosPlanilha[idx][3] || "").trim();
    if (id.startsWith("MLB") && (!titulo || titulo.startsWith("ERRO"))) {
      idsPendentes.push({ indice: idx, id: id });
    }
  }

  if (idsPendentes.length === 0) {
    return SpreadsheetApp.getUi().alert(
      "✅ Todos os anúncios já foram auditados!\n\nPara re-auditar, limpe a planilha e sincronize novamente."
    );
  }

  if (CONFIG.MODO_TESTE && idsPendentes.length > CONFIG.MAX_TESTE) {
    idsPendentes = idsPendentes.slice(0, CONFIG.MAX_TESTE);
    ss.toast("⚙️ MODO TESTE: auditando apenas " + CONFIG.MAX_TESTE + " anúncios.", "360 Gestão", 8);
  }

  var totalPendente      = idsPendentes.length;
  var processados        = 0;
  var numLotes           = Math.ceil(totalPendente / CONFIG.BATCH_SIZE);
  var falhasConsecutivas = 0;

  ss.toast(
    "Iniciando auditoria de " + totalPendente + " anúncios em " +
    numLotes + " lote(s) via servidor 360...",
    "360 Gestão", 12
  );

  for (var start = 0; start < idsPendentes.length; start += CONFIG.BATCH_SIZE) {

    // Trava de tempo: verifica ANTES de iniciar o próximo lote para não
    // começar um ciclo que estoure o limite de 6 min do Google Apps Script.
    if (Date.now() - startTotal > CONFIG.TIMEOUT_TOTAL) {
      var restantes = totalPendente - processados;
      _agendarContinuacao();
      ss.toast(
        "⏳ Limite de tempo: " + processados + " auditados, " + restantes +
        " pendentes. Continuando automaticamente em 1 minuto...",
        "360 Gestão", 60
      );
      return;
    }

    var lote    = idsPendentes.slice(start, start + CONFIG.BATCH_SIZE);
    var loteNum = Math.floor(start / CONFIG.BATCH_SIZE) + 1;

    ss.toast(
      "Processando lote " + loteNum + "/" + numLotes +
      " (" + lote.length + " anúncios)...",
      "360 Gestão", 30
    );

    // Envia o lote ao servidor e recebe as linhas prontas para colar
    var resposta;
    try {
      var httpResp = UrlFetchApp.fetch(WEB_APP_URL, {
        method:             "post",
        contentType:        "application/json",
        payload:            JSON.stringify({
          action:        "processarRaioX",
          apiKey:        INTERNAL_API_KEY,
          access_token:  token,
          refresh_token: refresh,
          user_id:       userId,
          ids:           lote.map(function(item) { return item.id; })
        }),
        muteHttpExceptions: true
      });
      resposta = JSON.parse(httpResp.getContentText());
    } catch (e) {
      ss.toast("⚠️ Lote " + loteNum + " — falha na comunicação: " + e.message, "360 Gestão", 10);
      falhasConsecutivas++;
      if (falhasConsecutivas >= 2) {
        SpreadsheetApp.getUi().alert(
          "❌ " + falhasConsecutivas + " lotes consecutivos com falha de comunicação.\n\n" +
          "Os itens pendentes serão reprocessados na próxima auditoria."
        );
        return;
      }
      continue;
    }

    if (resposta.error) {
      ss.toast("⚠️ Lote " + loteNum + " — erro do servidor: " + resposta.error, "360 Gestão", 10);
      if (resposta.error === "Unauthorized") {
        SpreadsheetApp.getUi().alert("❌ Chave de API inválida. Contate o suporte 360 Gestão.");
        return;
      }
      falhasConsecutivas++;
      if (falhasConsecutivas >= 2) {
        SpreadsheetApp.getUi().alert(
          "❌ " + falhasConsecutivas + " erros consecutivos de servidor.\n\n" +
          "Tente novamente em alguns minutos."
        );
        return;
      }
      continue;
    }

    falhasConsecutivas = 0;

    // Salva novos tokens IMEDIATAMENTE se o servidor os renovou durante o lote
    if (resposta.novos_tokens) {
      token   = resposta.novos_tokens.access_token;
      refresh = resposta.novos_tokens.refresh_token || refresh;
      props.setProperties({ access_token: token, refresh_token: refresh });
    }

    // Cola as linhas na planilha (indexação posicional 1:1 com lote[])
    var rows = resposta.rows || [];
    for (var r = 0; r < rows.length && r < lote.length; r++) {
      var row = rows[r];
      if (!row || row.length === 0) continue;
      sheet.getRange(lote[r].indice + 2, 1, 1, row.length).setValues([row]);
    }
    SpreadsheetApp.flush();

    processados += lote.length;
    ss.toast(
      "✅ " + processados + "/" + totalPendente + " anúncios auditados...",
      "360 Gestão", 6
    );
  }

  _cancelarTriggerContinuacao();
  SpreadsheetApp.getUi().alert(
    "🏁 Auditoria concluída!\n\n✅ " + processados + " anúncios processados com sucesso."
  );
}

// =============================================================================
// CONTINUAÇÃO AUTOMÁTICA — Trigger-based (resolve o limite de 6 min)
// =============================================================================
function continuarRaioX() {
  rodarRaioX();
}

function _agendarContinuacao() {
  _cancelarTriggerContinuacao();
  ScriptApp.newTrigger("continuarRaioX")
    .timeBased()
    .after(60 * 1000) // 1 minuto
    .create();
}

function _cancelarTriggerContinuacao() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "continuarRaioX") ScriptApp.deleteTrigger(t);
  });
}

// =============================================================================
// 3. FUNÇÕES DE API
// =============================================================================

/**
 * Fetch blindado. Retorna { status, data }.
 * Usado por sincronizarAnuncios para chamadas diretas ao catálogo do ML.
 */
function fetchComStatus(url, headers, maxTentativas) {
  maxTentativas = maxTentativas || 3;

  for (var t = 0; t < maxTentativas; t++) {
    try {
      var response = UrlFetchApp.fetch(url, {
        headers:            headers,
        muteHttpExceptions: true
      });
      var status = response.getResponseCode();

      if (status === 200) {
        return { status: 200, data: JSON.parse(response.getContentText()) };
      }
      if (status === 429) {
        Utilities.sleep(2000 * (t + 1));
        continue;
      }
      if (status === 401) {
        return { status: 401, data: null };
      }
      if (status === 403 || status === 404) {
        return { status: status, data: null };
      }
      Utilities.sleep(1000 * (t + 1));

    } catch (e) {
      if (t < maxTentativas - 1) Utilities.sleep(1000);
    }
  }

  return { status: 0, data: null };
}

/**
 * Renova o access_token via Ponte de Autenticação 360.
 * Usado por sincronizarAnuncios quando o token expira durante o scan.
 */
function renovarToken() {
  var props        = PropertiesService.getUserProperties();
  var refreshToken = props.getProperty("refresh_token");

  if (!refreshToken) {
    console.error("renovarToken: refresh_token ausente nas Properties.");
    return null;
  }

  try {
    var response = UrlFetchApp.fetch(WEB_APP_URL, {
      method:             "post",
      contentType:        "application/json",
      payload:            JSON.stringify({ action: "refreshToken", refresh_token: refreshToken, apiKey: INTERNAL_API_KEY }),
      muteHttpExceptions: true
    });

    var data = JSON.parse(response.getContentText());
    if (data.access_token) {
      props.setProperty("access_token", data.access_token);
      if (data.refresh_token) props.setProperty("refresh_token", data.refresh_token);
      return data.access_token;
    }
    // Token permanentemente revogado no ML: limpa credenciais locais (Vuln. E)
    if (data.error === "invalid_grant") {
      PropertiesService.getUserProperties().deleteAllProperties();
      SpreadsheetApp.getUi().alert(
        "❌ Conexão com o Mercado Livre revogada.\n\n" +
        "Reconecte a conta pelo menu '360 Gestão - ML → 1. Conectar Conta'."
      );
      return null;
    }
    console.error("renovarToken: Ponte retornou erro — " + JSON.stringify(data));
  } catch (e) {
    console.error("renovarToken: falha na chamada à Ponte — " + e.message);
  }
  return null;
}

// =============================================================================
// 4. UTILITÁRIOS
// =============================================================================
function escreverBuffer(sheet, buffer) {
  buffer.forEach(function(item) {
    sheet.getRange(item.linha, 1, 1, item.row.length).setValues([item.row]);
  });
}

function criarCabecalho() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);

  var cab = [
    "CONTA", "ID", "SKU", "TÍTULO", "STATUS", "CATEGORIA", "SQUAD 360", "AÇÃO RECOMENDADA",
    "VENDAS GERAL (PEDIDOS)", "UNIDADES GERAL", "VISITAS GERAL", "CONV. GERAL",
    "VENDAS 30D (PEDIDOS)", "UNIDADES 30D", "VISITAS 30D", "CONV. 30D",
    "VENDAS 15D (PEDIDOS)", "UNIDADES 15D", "VISITAS 15D", "CONV. 15D",
    "VENDAS 7D (PEDIDOS)", "UNIDADES 7D", "VISITAS 7D", "CONV. 7D",
    "ESTOQUE", "PREÇO", "SCORE",
    "VÍDEO CURTO", "COMPATIBILIDADE", "PROMOÇÃO", "TÍTULO PEND.", "CARACTERÍSTICAS",
    "FOTOS", "CÓD. UNIVERSAL", "TEMPO DISP.", "MAIS ESTOQUE", "BAIXAR PREÇO",
    "FLEX", "FRETE GRÁTIS", "PARCELAMENTO"
  ];

  sheet.getRange(1, 1, 1, cab.length).setValues([cab]).setFontWeight("bold");
  sheet.setFrozenRows(1);
  SpreadsheetApp.getUi().alert("✅ Cabeçalho criado na aba DESEMPENHO.");
}
