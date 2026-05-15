/**
 * ENGINE — MOTOR DE INTELIGÊNCIA 360 GESTÃO
 * ─────────────────────────────────────────────────────────────────────────────
 * Propriedade intelectual protegida. Hospedado exclusivamente no backend-cofre.
 * Toda a lógica de chamadas à API do ML, cruzamento de dados e classificação
 * Squad 360 reside aqui — invisível ao cliente e inacessível pelo frontend.
 * ─────────────────────────────────────────────────────────────────────────────
 */

var API_BASE        = "https://api.mercadolibre.com";
var _cacheCategoria = {}; // cache de árvore de categorias, por execução

// =============================================================================
// LOGGER 360 — Caixa Preta de Telemetria
// Buffer em memória acumulado durante a execução e gravado em lote no final.
// LOG_SHEET_ID deve estar em ScriptProperties para ativação; se ausente, é no-op.
// =============================================================================
var _logs         = [];
var _startBackend = 0;
var _vendedorId   = "";
var _vendedorNome = "";

function _log(msg) {
  _logs.push(msg);
}

function checkTimeout() {
  if (Date.now() - _startBackend > 50000) throw new Error("TIMEOUT_INTERNO");
}

function logImmediate(vendedorId, vendedorNome, idLote, mensagem) {
  var sheetId = PropertiesService.getScriptProperties().getProperty("LOG_SHEET_ID");
  if (!sheetId) return;
  try {
    var ss    = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName("LOGS");
    if (!sheet) sheet = ss.insertSheet("LOGS");
    var nextRow = sheet.getLastRow() + 1;
    sheet.getRange(nextRow, 1, 1, 5).setValues([[new Date(), vendedorId, vendedorNome, "IMEDIATO", mensagem]]);
  } catch(e) {
    console.error("logImmediate: falha — " + e.message);
  }
}

/**
 * Grava todos os logs acumulados em uma única operação batch (setValues) na planilha
 * de telemetria. Limpa o buffer mesmo que a gravação falhe.
 */
function flushLogs(idLote) {
  if (_logs.length === 0) return;
  var sheetId = PropertiesService.getScriptProperties().getProperty("LOG_SHEET_ID");
  if (!sheetId) { _logs = []; return; }
  try {
    var ss    = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName("LOGS");
    if (!sheet) sheet = ss.insertSheet("LOGS");
    var ts   = Utilities.formatDate(new Date(), "America/Sao_Paulo", "yyyy-MM-dd HH:mm:ss");
    var data = _logs.map(function(msg) { return [ts, _vendedorId, _vendedorNome, idLote, msg]; });
    sheet.getRange(sheet.getLastRow() + 1, 1, data.length, 5).setValues(data);
  } catch(e) {
    console.error("flushLogs: falha ao gravar — " + e.message);
  } finally {
    _logs = [];
  }
}

// =============================================================================
// 1. FETCH BLINDADO
// =============================================================================
function fetchComStatus(url, headers, maxTentativas) {
  maxTentativas = maxTentativas || 3;
  for (var t = 0; t < maxTentativas; t++) {
    try {
      var response = UrlFetchApp.fetch(url, {
        headers:            headers,
        muteHttpExceptions: true
      });
      var status = response.getResponseCode();
      if (status === 200)              return { status: 200, data: JSON.parse(response.getContentText()) };
      if (status === 429)              { Utilities.sleep(2000 * (t + 1)); continue; }
      if (status === 401)              return { status: 401, data: null };
      if (status === 403 || status === 404) return { status: status, data: null };
      Utilities.sleep(1000 * (t + 1));
    } catch (e) {
      if (t < maxTentativas - 1) Utilities.sleep(1000);
    }
  }
  return { status: 0, data: null };
}

// =============================================================================
// 2. AUTO-RENOVAÇÃO DE TOKEN
// Usa CLIENT_SECRET do cofre — único ponto do sistema que pode fazer refresh real.
// =============================================================================
function autoRenovarToken(refreshToken) {
  var props = PropertiesService.getScriptProperties();
  var resp  = UrlFetchApp.fetch("https://api.mercadolibre.com/oauth/token", {
    method:             "post",
    payload:            {
      grant_type:    "refresh_token",
      client_id:     props.getProperty("CLIENT_ID"),
      client_secret: props.getProperty("CLIENT_SECRET"),
      refresh_token: refreshToken
    },
    muteHttpExceptions: true
  });
  var data = JSON.parse(resp.getContentText());
  if (data.access_token) {
    return {
      access_token:  data.access_token,
      refresh_token: data.refresh_token || refreshToken
    };
  }
  console.error("autoRenovarToken: falha — " + JSON.stringify(data));
  return null;
}

// =============================================================================
// 3. ÁRVORE DE CATEGORIAS
// =============================================================================
function getCategoryTree(categoryId, headers) {
  if (!categoryId || categoryId === "N/A") return "N/A";
  if (_cacheCategoria[categoryId]) return _cacheCategoria[categoryId];
  var res  = fetchComStatus(API_BASE + "/categories/" + categoryId, headers);
  var tree = categoryId;
  if (res.status === 200 && res.data && res.data.path_from_root) {
    tree = res.data.path_from_root.map(function(p) { return p.name; }).join(" > ");
  }
  _cacheCategoria[categoryId] = tree;
  return tree;
}

// =============================================================================
// 4. PRÉ-CARREGAMENTO DE VENDAS 30D
// =============================================================================
function preCarregarVendas30D(userId, headers) {
  var base  = {};
  var agora = new Date();

  var data30    = new Date(agora.getTime() - 30 * 24 * 60 * 60 * 1000);
  var data30ISO = Utilities.formatDate(data30, "UTC", "yyyy-MM-dd") + "T00:00:00.000-00:00";
  var corte15   = new Date(agora.getTime() - 15 * 24 * 60 * 60 * 1000);
  var corte7    = new Date(agora.getTime() -  7 * 24 * 60 * 60 * 1000);

  var offset = 0, totalPedidos = 0;

  while (true) {
    checkTimeout();
    var url = API_BASE + "/orders/search?seller=" + userId +
              "&order.date_created.from=" + encodeURIComponent(data30ISO) +
              "&order.status=paid&offset=" + offset + "&limit=50";
    var res = fetchComStatus(url, headers);

    if (!res.data || !res.data.results || res.data.results.length === 0) break;

    res.data.results.forEach(function(o) {
      var dt = new Date(o.date_created);
      (o.order_items || []).forEach(function(it) {
        var id  = it.item.id;
        var qtd = it.quantity;
        if (!base[id]) base[id] = { p7:0, p15:0, p30:0, u7:0, u15:0, u30:0 };
        base[id].p30 += 1; base[id].u30 += qtd;
        if (dt >= corte15) { base[id].p15 += 1; base[id].u15 += qtd; }
        if (dt >= corte7)  { base[id].p7  += 1; base[id].u7  += qtd; }
      });
    });

    totalPedidos += res.data.results.length;
    offset += 50;
    var total = (res.data.paging && res.data.paging.total) ? res.data.paging.total : 0;
    if (offset >= total) break;
  }

  console.log("Preload vendas: " + totalPedidos + " pedidos, " + Object.keys(base).length + " itens com vendas.");
  return base;
}

// =============================================================================
// 5. PRÉ-CARREGAMENTO DE VISITAS TOTAIS (50 IDs por chamada)
// =============================================================================
function preCarregarVisitasTotais(ids, headers) {
  var base = {};
  for (var i = 0; i < ids.length; i += 50) {
    var lote = ids.slice(i, i + 50).join(",");
    var res  = fetchComStatus(API_BASE + "/visits/items?ids=" + lote, headers);
    if (res.status === 200 && res.data) {
      Object.keys(res.data).forEach(function(id) { base[id] = res.data[id] || 0; });
    }
  }
  return base;
}

// =============================================================================
// 6. VISITAS DETALHADAS POR ITEM (total histórico + janelas 30/15/7d)
// =============================================================================
function getVisitasCompletas(itemId, headers, baseTotais) {
  var total = baseTotais[itemId] || 0;
  var hoje  = Utilities.formatDate(new Date(), "GMT-3", "yyyy-MM-dd");

  var url30 = API_BASE + "/items/" + itemId +
              "/visits/time_window?last=30&unit=day&ending=" + hoje;
  var res30 = fetchComStatus(url30, headers);

  if (!res30.data || !res30.data.results) return { total: total, v30: 0, v15: 0, v7: 0 };

  var dias = res30.data.results;
  var v30 = 0, v15 = 0, v7 = 0;
  dias.forEach(function(d, idx) {
    var qtd = d.total || 0;
    v30 += qtd;
    if (idx >= dias.length - 15) v15 += qtd;
    if (idx >= dias.length - 7)  v7  += qtd;
  });
  return { total: total, v30: v30, v15: v15, v7: v7 };
}

// =============================================================================
// 7. TOTAL DE PEDIDOS (toda a vida do anúncio)
// =============================================================================
function getTotalPedidos(itemId, userId, headers) {
  var url = API_BASE + "/orders/search?seller=" + userId +
            "&q=" + itemId + "&order.status=paid&limit=1";
  var res = fetchComStatus(url, headers);
  if (res.status === 200 && res.data && res.data.paging) {
    var t = res.data.paging.total;
    if (typeof t === "number") return t;
  }
  // Fallback com parâmetro alternativo da API
  url = API_BASE + "/orders/search?seller=" + userId +
        "&item=" + itemId + "&order.status=paid&limit=1";
  res = fetchComStatus(url, headers);
  if (res.status === 200 && res.data && res.data.paging) return res.data.paging.total || 0;
  console.warn("getTotalPedidos: sem resultado para " + itemId);
  return 0;
}

// =============================================================================
// 8. EXTRAÇÃO DE SKU
// =============================================================================
function getSKU(det) {
  var attrs = det.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    var a = attrs[i];
    if (a.id === "SELLER_SKU") {
      if (a.value_name) return a.value_name;
      if (a.values && a.values.length > 0 && a.values[0].name) return a.values[0].name;
    }
  }
  if (det.seller_custom_field) return det.seller_custom_field;
  console.warn("SEM SKU – " + det.id + " | attrs: " + (attrs.map(function(a) { return a.id; }).join(",")));
  return "SEM SKU";
}

// =============================================================================
// 9. INTELIGÊNCIA DE NEGÓCIO — Classificação Squad 360
// =============================================================================
function inteligencia360(vendas, uTotal, vis, estoque, status, score, pends, temPerf) {
  var conv30      = vis.v30 > 0 ? (vendas.p30 / vis.v30) : 0;
  var conv7       = vis.v7  > 0 ? (vendas.p7  / vis.v7)  : 0;
  var vDiaria7    = vendas.u7 / 7;
  var diasEstoque = vDiaria7 > 0 ? (estoque / vDiaria7) : 999;

  if (status !== "ACTIVE") {
    if (uTotal > 50) return ["⏸️ SQUAD P", "URGENTE: Produto campeão pausado. Perda de dinheiro."];
    return ["⏸️ PAUSADO", "REPOSIÇÃO: Anúncio inativo, repor estoque."];
  }
  if (vendas.u7 > 0 && diasEstoque < 10) {
    return ["🔥 SQUAD S", "REPOSIÇÃO URGENTE: Estoque acaba em " + Math.floor(diasEstoque) + " dias."];
  }
  if (vendas.p7 > 0 && conv7 > conv30 && conv30 > 0.02) {
    return ["💎 SQUAD A", "ESTRELA: Anúncio validado e crescendo. Escalar Ads."];
  }
  if (vis.v30 > 50 && conv30 < 0.01) {
    return ["🚀 SQUAD B", "CONVERSÃO: Tráfego alto, mas não fecha. Checar Preço/Fotos."];
  }
  if (uTotal > 100 && vendas.p30 === 0) {
    return ["🐢 SQUAD C", "RELEVÂNCIA: Histórico forte, mas esfriou. Aplicar Oferta."];
  }
  if (vis.v30 < 10 && (!temPerf || score < 80 || pends.length > 0)) {
    return ["🔍 SQUAD E", "SEO: Anúncio invisível. Resolver pendências."];
  }
  return ["💀 SQUAD D", "DIAGNÓSTICO: Baixa performance. Avaliar se vale manter."];
}

function statusPend(pends, chaves, temPerf) {
  if (!temPerf) return "⚠️ S/ Dados";
  for (var i = 0; i < pends.length; i++) {
    var p = (pends[i] || "").toLowerCase();
    for (var j = 0; j < chaves.length; j++) {
      if (p.indexOf(chaves[j].toLowerCase()) > -1) return "❌ Pendente";
    }
  }
  return "✅ OK";
}

// =============================================================================
// HELPERS INTERNOS
// =============================================================================
function calcConv(ped, vis) {
  return vis > 0 ? ((ped / vis) * 100).toFixed(2) + "%" : "0.00%";
}

// Linha sentinela de erro com 40 colunas (preserva indexação posicional 1:1 com ids[])
function _rowErro(itemID, mensagem) {
  return [
    "ERRO", itemID, "", mensagem, "", "", "", "",  // A–H  (8)
    0, 0, 0, "0.00%",                              // I–L  (4) Geral
    0, 0, 0, "0.00%",                              // M–P  (4) 30d
    0, 0, 0, "0.00%",                              // Q–T  (4) 15d
    0, 0, 0, "0.00%",                              // U–X  (4) 7d
    0, 0, "",                                      // Y–AA (3) Estoque/Preço/Score
    "", "", "", "", "", "", "",                    // AB–AH (7) Checklist 1–7
    "", "", "", "", "", ""                         // AI–AN (6) Checklist 8–13
  ];
}

// =============================================================================
// HELPERS DE PERFORMANCE — Multiget e fetchAll
// =============================================================================

/**
 * Busca dados básicos de todos os IDs em uma única chamada à rota /items?ids=...
 * O ML retorna um array de { code, body }; aqui convertemos para hash map O(1).
 * Retorna null se o token expirou e o refresh falhou (caller deve abortar o lote).
 */
function _multigetItens(ids, headers, tentarRefresh) {
  var url = API_BASE + "/items?ids=" + ids.join(",");
  var res = fetchComStatus(url, headers);

  if (res.status === 401) {
    _log("MULTIGET 401 — acionando refresh");
    if (!tentarRefresh()) return null;
    res = fetchComStatus(url, headers);
    _log("MULTIGET retry pós-401 → status " + res.status);
  }

  var map = {};
  if (res.status === 200 && Array.isArray(res.data)) {
    res.data.forEach(function(entry) {
      if (entry.code === 200 && entry.body && entry.body.id) {
        map[entry.body.id] = entry.body;
      }
    });
  }
  return map;
}

/**
 * Dispara as requisições de /item/{id}/performance de todos os IDs em paralelo.
 * Trata 401 (refresh + retry de todos) e 429 (sleep 2s + retry só dos índices falhos).
 * Retorna um hash map { itemId: perfData | null }; null indica ausência de dados.
 */
function _fetchAllPerformance(ids, headers, tentarRefresh) {
  var buildRequests = function() {
    return ids.map(function(id) {
      return {
        url:                API_BASE + "/item/" + id + "/performance",
        headers:            headers, // referência ao objeto mutável — atualizado pelo tentarRefresh
        muteHttpExceptions: true
      };
    });
  };

  var resps = UrlFetchApp.fetchAll(buildRequests());

  // 401: token expirado — renova e repete todas as requisições
  var count401 = resps.filter(function(r) { return r.getResponseCode() === 401; }).length;
  if (count401 > 0) {
    _log("FETCH_ALL_PERF 401: " + count401 + "/" + ids.length + " itens — acionando refresh");
    if (tentarRefresh()) {
      resps = UrlFetchApp.fetchAll(buildRequests()); // headers já atualizado in-place
      _log("FETCH_ALL_PERF retry pós-401 concluído");
    } else {
      _log("FETCH_ALL_PERF refresh falhou — performance omitida para todo o lote");
      console.warn("_fetchAllPerformance: refresh falhou — performance omitida para o lote.");
      return ids.reduce(function(m, id) { m[id] = null; return m; }, {});
    }
  }

  // 429: retry seletivo com limite de 3 tentativas e backoff crescente
  var maxRetries429 = 3;
  var retries429    = 0;
  while (retries429 < maxRetries429) {
    checkTimeout();
    var pending429 = [];
    resps.forEach(function(r, i) { if (r.getResponseCode() === 429) pending429.push(i); });
    if (pending429.length === 0) break;
    _log("FETCH_ALL_PERF 429: " + pending429.length + "/" + ids.length + " itens — retry " + (retries429 + 1) + "/" + maxRetries429);
    Utilities.sleep(2000 * (retries429 + 1));
    var retryReqs429  = pending429.map(function(i) {
      return { url: API_BASE + "/item/" + ids[i] + "/performance", headers: headers, muteHttpExceptions: true };
    });
    var retryResps429 = UrlFetchApp.fetchAll(retryReqs429);
    pending429.forEach(function(origIdx, j) { resps[origIdx] = retryResps429[j]; });
    retries429++;
  }
  if (retries429 === maxRetries429) {
    var still429 = resps.filter(function(r) { return r.getResponseCode() === 429; }).length;
    if (still429 > 0) _log("FETCH_ALL_PERF 429: max retries atingido — " + still429 + " itens marcados como falha");
  }

  var map = {};
  ids.forEach(function(id, i) {
    var code = resps[i].getResponseCode();
    if (code === 200) {
      try { map[id] = JSON.parse(resps[i].getContentText()); } catch(e) { map[id] = null; }
    } else {
      map[id] = null;
    }
  });
  return map;
}

// =============================================================================
// ORQUESTRADOR — processarRaioX_Backend
// Entrada : { access_token, refresh_token, user_id, ids[] }
// Saída   : { rows: [[...], ...], novos_tokens?: { access_token, refresh_token } }
// =============================================================================
function processarRaioX_Backend(payload) {
  _startBackend    = Date.now();
  _vendedorId      = payload.vendedor_id   || "";
  _vendedorNome    = payload.vendedor_nome || "";
  var token        = payload.access_token;
  var refreshToken = payload.refresh_token;
  var userId       = payload.user_id;
  var ids          = payload.ids;

  if (!token || !refreshToken || !userId || !Array.isArray(ids) || ids.length === 0) {
    return { error: "Payload inválido: access_token, refresh_token, user_id e ids são obrigatórios.", rows: [] };
  }

  // Inicia a caixa preta: ID curto do lote (últimos 4 chars do primeiro ID) e timer global
  _logs  = [];
  var idLote = String(ids[0]).slice(-4);
  var tTotal = Date.now();
  _log("INÍCIO: " + ids.length + " IDs | " + new Date().toISOString());
  logImmediate(_vendedorId, _vendedorNome, idLote, "INÍCIO lote=" + idLote + " | " + ids.length + " IDs | " + new Date().toISOString());

  var headers         = { "Authorization": "Bearer " + token };
  var tokensRenovados = false;
  var novosTokens     = null;

  // Fecha sobre as variáveis mutáveis do orquestrador.
  // Atualizar headers["Authorization"] em-lugar garante que todas as funções
  // que receberam a referência ao objeto (preloads, getVisitasCompletas, etc.)
  // usarão automaticamente o token renovado sem precisar de re-injeção.
  var tentarRefresh = function() {
    var novos = autoRenovarToken(refreshToken);
    if (!novos) return false;
    token        = novos.access_token;
    refreshToken = novos.refresh_token || refreshToken;
    headers["Authorization"] = "Bearer " + token;
    tokensRenovados = true;
    novosTokens     = { access_token: token, refresh_token: refreshToken };
    return true;
  };

  try {
    // ── Probe: valida o token ANTES dos preloads para evitar dados vazios por 401 ──
    var probe = fetchComStatus(API_BASE + "/users/" + userId, headers);
    if (probe.status === 401) {
      _log("PROBE 401 — acionando refresh");
      if (!tentarRefresh()) {
        _log("PROBE refresh falhou — abortando lote");
        return { error: "Token inválido e refresh falhou. Reconecte a conta.", rows: [] };
      }
    }

    // ── Preloads (headers já está com token válido após o probe) ──────────────
    var baseVendas        = preCarregarVendas30D(userId, headers);
    var baseVisitasTotais = preCarregarVisitasTotais(ids, headers);

    // ── Multiget: 1 chamada para dados de todos os IDs (vs N sequenciais) ────
    var t0      = Date.now();
    var itemMap = _multigetItens(ids, headers, tentarRefresh);
    _log("MULTIGET: " + (Date.now() - t0) + "ms — " + Object.keys(itemMap || {}).length + "/" + ids.length + " itens retornados");
    if (!itemMap) return { error: "Token expirado — refresh falhou durante o multiget.", rows: [] };

    // ── fetchAll: performance de todos os IDs em paralelo (vs N sequenciais) ─
    t0 = Date.now();
    var perfMap = _fetchAllPerformance(ids, headers, tentarRefresh);
    _log("FETCH_ALL_PERF: " + (Date.now() - t0) + "ms — " + ids.length + " itens processados");

    // ── Loop de processamento ─────────────────────────────────────────────────
    var rows  = [];
    var tLoop = Date.now();

    for (var k = 0; k < ids.length; k++) {
      checkTimeout();
      var itemID = String(ids[k]).trim();

      try {
        // Dados básicos do multiget (acesso O(1) ao hash map pré-carregado)
        var det = itemMap[itemID];
        if (!det || det.error) {
          rows.push(_rowErro(itemID, "Item indisponível no catálogo"));
          continue;
        }

        // Performance do fetchAll paralelo (null = sem dados de performance)
        var perf    = perfMap[itemID] || null;
        var temPerf = !!(perf && perf.buckets);

        var visitas = getVisitasCompletas(itemID, headers, baseVisitasTotais);

        // Total histórico de pedidos
        var pedidosGeral = getTotalPedidos(itemID, userId, headers);

        // Vendas 7/15/30d do pré-carregamento
        var vendas = baseVendas[itemID] || { p7:0, p15:0, p30:0, u7:0, u15:0, u30:0 };
        var uTotal = det.sold_quantity || 0;

        // Pendências e score de performance
        var pends = [];
        var score = 0;
        if (temPerf) {
          score = parseInt(perf.score || 0);
          (perf.buckets || []).forEach(function(b) {
            (b.variables || []).forEach(function(v) {
              if (v.status !== "COMPLETED" && v.status !== "OK" && v.title) pends.push(v.title);
            });
          });
        }

        var statusML  = (det.status || "N/A").toUpperCase();
        var squadAcao = inteligencia360(
          vendas, uTotal, visitas,
          det.available_quantity || 0, statusML, score, pends, temPerf
        );

        // Checklist de qualidade (13 critérios)
        var c_video, c_compat, c_promo, c_titulo, c_caract, c_fotos,
            c_codigo, c_tempo, c_estoque, c_preco, c_flex, c_frete, c_parcel;

        if (statusML === "PAUSED") {
          c_video = c_compat = c_promo = c_titulo = c_caract = c_fotos =
          c_codigo = c_tempo = c_estoque = c_preco = c_flex = c_frete = c_parcel = "⏸️ Pausado";
        } else {
          c_video   = statusPend(pends, ["clipe", "vídeo", "video"],                     temPerf);
          c_compat  = statusPend(pends, ["compatível", "veículo", "compatibilidade"],    temPerf);
          c_promo   = statusPend(pends, ["promoção"],                                    temPerf);
          c_titulo  = statusPend(pends, ["título"],                                      temPerf);
          c_caract  = statusPend(pends, ["características"],                             temPerf);
          c_fotos   = statusPend(pends, ["fotos"],                                       temPerf);
          c_codigo  = statusPend(pends, ["código universal", "ean"],                     temPerf);
          c_tempo   = statusPend(pends, ["tempo de disponibilidade", "disponibilidade"], temPerf);
          c_estoque = statusPend(pends, ["mais estoque"],                                temPerf);
          c_preco   = statusPend(pends, ["baixe o preço", "recuperar a exposição"],      temPerf);
          c_flex    = statusPend(pends, ["envios flex", "mesmo dia"],                    temPerf);
          c_frete   = statusPend(pends, ["frete grátis"],                                temPerf);
          c_parcel  = statusPend(pends, ["parcelamento", "sem juros"],                   temPerf);
        }

        // Array de 40 colunas — idêntico ao layout da aba DESEMPENHO (A→AN)
        var row = [
          "360 GESTÃO",                                          // A  CONTA
          itemID,                                                // B  ID
          getSKU(det),                                           // C  SKU
          det.title || "N/A",                                    // D  TÍTULO
          statusML,                                              // E  STATUS
          getCategoryTree(det.category_id, headers),             // F  CATEGORIA
          squadAcao[0],                                          // G  SQUAD 360
          squadAcao[1],                                          // H  AÇÃO RECOMENDADA
          pedidosGeral,                                          // I  VENDAS GERAL (PEDIDOS)
          uTotal,                                                // J  UNIDADES GERAL
          visitas.total,                                         // K  VISITAS GERAL
          calcConv(pedidosGeral, visitas.total),                 // L  CONV. GERAL
          vendas.p30, vendas.u30, visitas.v30, calcConv(vendas.p30, visitas.v30), // M–P  30d
          vendas.p15, vendas.u15, visitas.v15, calcConv(vendas.p15, visitas.v15), // Q–T  15d
          vendas.p7,  vendas.u7,  visitas.v7,  calcConv(vendas.p7,  visitas.v7),  // U–X  7d
          det.available_quantity || 0,                           // Y  ESTOQUE
          det.price || 0,                                        // Z  PREÇO
          temPerf ? score + "%" : "Sem acesso API",              // AA SCORE
          c_video, c_compat, c_promo, c_titulo, c_caract, c_fotos, c_codigo,      // AB–AH
          c_tempo, c_estoque, c_preco, c_flex, c_frete, c_parcel                  // AI–AN
        ];

        rows.push(row);

      } catch (err) {
        rows.push(_rowErro(itemID, err.message));
      }
    }

    _log("LOOP (visitas+pedidos): " + (Date.now() - tLoop) + "ms — " + rows.length + " rows montadas");
    _log("TOTAL: " + (Date.now() - tTotal) + "ms");

    var resultado = { rows: rows };
    if (tokensRenovados && novosTokens) {
      resultado.novos_tokens = novosTokens;
    }
    return resultado;

  } catch(err) {
    logImmediate(_vendedorId, _vendedorNome, idLote, "ERRO FATAL lote=" + idLote + ": " + err.message);
    _log("ERRO FATAL: " + err.message);
    return { error: err.message, rows: [] };
  } finally {
    flushLogs(idLote);
  }
}
