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
var COFRE_URL = "https://script.google.com/macros/s/AKfycbzsq5T3x40SSgcKmhxJhEAZQNlphVd4xhKPJaZQFyV-WDdVIVvOw94p-erYoD3nX2my/exec";

var CONFIG = {
  SHEET_NAME:    "DESEMPENHO",
  TIMEOUT_TOTAL: 270000,   // 4.5 min — margem para lotes de até 60s antes do teto GAS de 6 min
  BATCH_SIZE:    10,
  API_BASE:      "https://api.mercadolibre.com",
  MODO_TESTE:    false,
  MAX_TESTE:     10
};

// Status conhecidos do ML consultados na descoberta de catálogo.
// Adicionados em ordem de relevância para o seller.
var STATUS_CONHECIDOS = [
  { status: "active",       label: "Ativo",       icone: "✅" },
  { status: "paused",       label: "Pausado",     icone: "⏸️" },
  { status: "closed",       label: "Encerrado",   icone: "🔒" },
  { status: "under_review", label: "Em revisão",  icone: "🔍" },
  { status: "inactive",     label: "Inativo",     icone: "⭕" }
];

// =============================================================================
// MENU
// =============================================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("360 Gestão - ML")
    .addItem("🔑 Ativar Licença",              "abrirSidebarAtivacao")
    .addSeparator()
    .addItem("1. Conectar Conta Mercado Livre", "abrirLoginML")
    .addItem("2. Raio-X do Catálogo",           "abrirSidebarRaioX")
    .addSeparator()
    .addItem("Criar Cabeçalho",                "criarCabecalho")
    .addToUi();
}

// =============================================================================
// PAINEL DE CONTROLE — Sidebar
// =============================================================================
function abrirSidebarAtivacao() {
  var html = HtmlService.createHtmlOutputFromFile("sidebar")
    .setTitle("Painel de Controle - 360 Gestão");
  SpreadsheetApp.getUi().showSidebar(html);
}

function abrirSidebarRaioX() {
  if (!_licencaAtiva()) {
    SpreadsheetApp.getUi().alert("⚠️ Acesso Bloqueado\n\nPor favor, ative sua licença primeiro para utilizar a ferramenta.");
    abrirSidebarAtivacao();
    return;
  }
  var html = HtmlService.createHtmlOutputFromFile("sidebar")
    .setTitle("Painel de Controle - 360 Gestão");
  SpreadsheetApp.getUi().showSidebar(html);
  // A sidebar conduz o fluxo: descoberta → seleção → sync → auditoria
}

function obterStatusRaioX() {
  var cache = CacheService.getUserCache();
  return {
    atual: parseInt(cache.get("PROGRESS_ATUAL") || "0"),
    total: parseInt(cache.get("PROGRESS_TOTAL") || "0"),
    msg:   cache.get("PROGRESS_MSG") || "Aguardando início..."
  };
}

function obterStatusSinc() {
  var cache = CacheService.getUserCache();
  return {
    status: cache.get("SINC_STATUS") || "idle",
    count:  parseInt(cache.get("SINC_COUNT") || "0"),
    msg:    cache.get("SINC_MSG")    || ""
  };
}

// =============================================================================
// 1. DESCOBERTA DO CATÁLOGO — paging.total por status (sem paginar IDs)
// =============================================================================
function descobrirCatalogo() {
  var props  = PropertiesService.getUserProperties();
  var token  = props.getProperty("access_token");
  var userId = props.getProperty("user_id");
  if (!token || !userId) return { error: "sem_token" };

  var headers       = { "Authorization": "Bearer " + token };
  var resultado     = [];
  var total         = 0;
  var tokenExpirado = false;

  STATUS_CONHECIDOS.forEach(function(s) {
    if (tokenExpirado) return;
    var url = CONFIG.API_BASE + "/users/" + userId +
              "/items/search?status=" + s.status + "&limit=1";
    var res = fetchComStatus(url, headers);
    if (res.status === 401) { tokenExpirado = true; return; }
    var count = (res.status === 200 && res.data && res.data.paging)
                ? (res.data.paging.total || 0) : 0;
    if (count > 0) {
      resultado.push({ status: s.status, label: s.label, icone: s.icone, count: count });
      total += count;
    }
  });

  if (tokenExpirado) return { error: "token_expirado" };
  return { statuses: resultado, total: total };
}

// =============================================================================
// 2. SINCRONIZAÇÃO — scan completo dos status selecionados (sem teto fixo)
// =============================================================================
function sincronizarAnuncios(statusList) {
  var statusParam = (Array.isArray(statusList) && statusList.length > 0)
    ? statusList.join(",")
    : "active,paused";

  var props  = PropertiesService.getUserProperties();
  var token  = props.getProperty("access_token");
  var userId = props.getProperty("user_id");
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var sheet  = ss.getSheetByName(CONFIG.SHEET_NAME);
  var cache  = CacheService.getUserCache();

  if (!token || !userId) {
    cache.putAll({ SINC_STATUS: "error", SINC_MSG: "Token não encontrado. Reconecte a conta." }, 21600);
    return;
  }

  sheet.getRange("B2:B").clearContent();
  cache.putAll({ SINC_STATUS: "running", SINC_COUNT: "0", SINC_MSG: "Iniciando scan..." }, 21600);

  var headers  = { "Authorization": "Bearer " + token };
  var todosIds = [];
  var urlScan  = CONFIG.API_BASE + "/users/" + userId +
                 "/items/search?status=" + statusParam + "&search_type=scan&limit=100";

  while (true) {
    var res = fetchComStatus(urlScan, headers);

    if (res.status === 401) {
      token = renovarToken();
      if (!token) {
        cache.putAll({ SINC_STATUS: "error", SINC_MSG: "Token expirado. Reconecte a conta." }, 21600);
        return;
      }
      headers = { "Authorization": "Bearer " + token };
      res = fetchComStatus(urlScan, headers);
    }

    var ids = (res.data && res.data.results) ? res.data.results : [];
    if (ids.length === 0) break;

    todosIds.push.apply(todosIds, ids);
    cache.putAll({
      SINC_COUNT: String(todosIds.length),
      SINC_MSG:   todosIds.length + " anúncios encontrados..."
    }, 21600);

    var scrollId = res.data.scroll_id;
    if (!scrollId) break;
    urlScan = CONFIG.API_BASE + "/users/" + userId +
              "/items/search?search_type=scan&scroll_id=" + scrollId;
  }

  if (todosIds.length === 0) {
    cache.putAll({ SINC_STATUS: "empty", SINC_MSG: "Nenhum anúncio encontrado para os status selecionados." }, 21600);
    return;
  }

  var formatados = todosIds.map(function(id) { return [id]; });
  sheet.getRange(2, 2, formatados.length, 1).setValues(formatados);

  cache.putAll({
    SINC_STATUS: "done",
    SINC_COUNT:  String(todosIds.length),
    SINC_MSG:    "✅ " + todosIds.length + " anúncios sincronizados."
  }, 21600);
}

// =============================================================================
// 3. RAIO-X — Terminal Burro (roteador de lotes para o servidor 360)
// =============================================================================
function rodarRaioX() {
  var licenca = obterLicenca();
  if (!licenca) return;

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

  var docProps   = PropertiesService.getDocumentProperties();
  var emailSalvo = docProps.getProperty("licenca_email") || "";
  var chaveSalva = docProps.getProperty("licenca_chave") || "";

  var ultimaLinha   = Math.max(sheet.getLastRow(), 2);
  var dadosPlanilha = sheet.getRange("A2:AN" + ultimaLinha).getValues();

  var idsPendentes = [];
  var totalGlobal  = 0;
  for (var idx = 0; idx < dadosPlanilha.length; idx++) {
    var id     = String(dadosPlanilha[idx][1] || "").trim();
    var titulo = String(dadosPlanilha[idx][3] || "").trim();
    if (!id.startsWith("MLB")) continue;
    totalGlobal++;
    if (!titulo || titulo.startsWith("ERRO")) idsPendentes.push({ indice: idx, id: id });
  }
  var jaProcessados = totalGlobal - idsPendentes.length;

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
  var cache = CacheService.getUserCache();

  cache.putAll({
    PROGRESS_TOTAL: String(totalGlobal),
    PROGRESS_ATUAL: String(jaProcessados),
    PROGRESS_MSG:   "Iniciando auditoria de " + totalPendente + " anúncios..."
  }, 21600);

  var planilhaId   = ss.getId();
  var scriptProps  = PropertiesService.getScriptProperties();
  var vendedorId   = scriptProps.getProperty("CLIENT_ID")    || "";
  var vendedorIdMl = scriptProps.getProperty("CLIENT_ID_ML") || "";
  var vendedorNome = scriptProps.getProperty("CLIENT_NAME")  || "";

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
      cache.put("PROGRESS_MSG", "⏸️ Pausado. Continuando em 1 minuto...", 21600);
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
    cache.put("PROGRESS_MSG", "Auditando lote " + loteNum + " de " + numLotes + "...", 21600);

    var resposta   = null;
    var httpStatus = 0;
    try {
      var payloadObj = {
        action:         "processarRaioX",
        email:          emailSalvo,
        chave:          chaveSalva,
        planilhaId:     planilhaId,
        access_token:   token,
        refresh_token:  refresh,
        user_id:        userId,
        ids:            lote.map(function(item) { return item.id; }),
        vendedor_id:    vendedorId    || "",
        vendedor_id_ml: vendedorIdMl || "",
        vendedor_nome:  vendedorNome  || ""
      };
      try {
        var debugSheet = ss.getSheetByName("DEBUG_360");
        if (debugSheet) ss.deleteSheet(debugSheet);
      } catch(e) {}
      var httpResp = UrlFetchApp.fetch(COFRE_URL, {
        method:             "post",
        contentType:        "application/json",
        payload:            JSON.stringify(payloadObj),
        muteHttpExceptions: true
      });
      httpStatus = httpResp.getResponseCode();
      resposta   = JSON.parse(httpResp.getContentText());
    } catch (e) {
      ss.toast("⚠️ Lote " + loteNum + " — falha de rede: " + e.message, "360 Gestão", 10);
      _marcarLoteComoErro(sheet, lote);
      processados += lote.length;
      cache.putAll({
        PROGRESS_ATUAL: String(jaProcessados + processados),
        PROGRESS_MSG:   "Auditados " + (jaProcessados + processados) + " de " + totalGlobal + "..."
      }, 21600);
      continue;
    }

    if (httpStatus >= 500) {
      ss.toast("⚠️ Lote " + loteNum + " — servidor retornou HTTP " + httpStatus + ". Marcando como erro.", "360 Gestão", 10);
      _marcarLoteComoErro(sheet, lote);
      processados += lote.length;
      cache.putAll({
        PROGRESS_ATUAL: String(jaProcessados + processados),
        PROGRESS_MSG:   "Auditados " + (jaProcessados + processados) + " de " + totalGlobal + "..."
      }, 21600);
      continue;
    }

    if (resposta.error) {
      if (resposta.error === "Unauthorized") {
        SpreadsheetApp.getUi().alert("❌ Licença inválida ou expirada. Verifique o e-mail e a chave no painel de ativação.");
        return;
      }
      ss.toast("⚠️ Lote " + loteNum + " — erro do servidor: " + resposta.error + ". Marcando como erro.", "360 Gestão", 10);
      _marcarLoteComoErro(sheet, lote);
      processados += lote.length;
      cache.putAll({
        PROGRESS_ATUAL: String(jaProcessados + processados),
        PROGRESS_MSG:   "Auditados " + (jaProcessados + processados) + " de " + totalGlobal + "..."
      }, 21600);
      continue;
    }

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
    cache.putAll({
      PROGRESS_ATUAL: String(jaProcessados + processados),
      PROGRESS_MSG:   "Auditados " + (jaProcessados + processados) + " de " + totalGlobal + "..."
    }, 21600);
    ss.toast(
      "✅ " + processados + "/" + totalPendente + " anúncios auditados...",
      "360 Gestão", 6
    );
  }

  _cancelarTriggerContinuacao();
  cache.putAll({
    PROGRESS_ATUAL: String(totalGlobal),
    PROGRESS_MSG:   "✅ Auditoria concluída! " + processados + " anúncios processados."
  }, 21600);
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
    .after(60 * 1000)
    .create();
}

function _cancelarTriggerContinuacao() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "continuarRaioX") ScriptApp.deleteTrigger(t);
  });
}

// =============================================================================
// 4. FUNÇÕES DE API
// =============================================================================

/**
 * Fetch blindado. Retorna { status, data }.
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
 */
function renovarToken() {
  var props        = PropertiesService.getUserProperties();
  var refreshToken = props.getProperty("refresh_token");

  if (!refreshToken) {
    console.error("renovarToken: refresh_token ausente nas Properties.");
    return null;
  }

  try {
    var lic      = obterLicenca();
    var response = UrlFetchApp.fetch(COFRE_URL, {
      method:             "post",
      contentType:        "application/json",
      payload:            JSON.stringify({
        action:        "refreshToken",
        refresh_token: refreshToken,
        email:         lic ? lic.email : "",
        chave:         lic ? lic.chave : "",
        planilhaId:    SpreadsheetApp.getActiveSpreadsheet().getId()
      }),
      muteHttpExceptions: true
    });

    var data = JSON.parse(response.getContentText());
    if (data.access_token) {
      props.setProperty("access_token", data.access_token);
      if (data.refresh_token) props.setProperty("refresh_token", data.refresh_token);
      return data.access_token;
    }
    // Token permanentemente revogado no ML: limpa credenciais locais
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
// 5. UTILITÁRIOS
// =============================================================================
function _marcarLoteComoErro(sheet, lote) {
  lote.forEach(function(item) {
    sheet.getRange(item.indice + 2, 4, 1, 1).setValues([["ERRO: Falha no Servidor Central"]]);
  });
  SpreadsheetApp.flush();
}

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
