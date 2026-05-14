/**
 * MOTOR 360 GESTÃO - AUDITOR DE ANÚNCIOS MERCADO LIVRE
 * Google Apps Script — Versão SaaS Low Ticket
 *
 * Cole este código no editor do Google Apps Script da planilha do cliente.
 * As credenciais devem estar salvas via PropertiesService.getUserProperties():
 *   access_token, refresh_token, user_id, client_id, client_secret
 */

// =============================================================================
// CONFIGURAÇÕES GLOBAIS
// =============================================================================
var CONFIG = {
  SHEET_NAME:    "DESEMPENHO",
  TIMEOUT_TOTAL: 300000,   // 5 min (Google mata em 6 min)
  BATCH_SIZE:    40,
  MAX_ANUNCIOS:  5000,
  API_BASE:      "https://api.mercadolibre.com",
  MODO_TESTE:    true,     // ← true = processa só MAX_TESTE itens; false = todos
  MAX_TESTE:     10
};

// Cache de categorias (por execução) — evita chamada repetida por item
var _cacheCategoria = {};

// =============================================================================
// ÁRVORE DE CATEGORIAS
// =============================================================================
/**
 * Retorna a árvore completa da categoria ("Acessórios > Veículos > Pneus").
 * Usa cache em memória para não repetir a chamada por categoria.
 */
function getCategoryTree(categoryId, headers) {
  if (!categoryId || categoryId === "N/A") return "N/A";
  if (_cacheCategoria[categoryId]) return _cacheCategoria[categoryId];

  var res = fetchComStatus(CONFIG.API_BASE + "/categories/" + categoryId, headers);
  var tree = categoryId; // fallback: exibe só o ID se a chamada falhar
  if (res.status === 200 && res.data && res.data.path_from_root) {
    tree = res.data.path_from_root.map(function(p) { return p.name; }).join(" > ");
  }
  _cacheCategoria[categoryId] = tree;
  return tree;
}

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
// 2. RAIO-X — Auditoria profunda
// =============================================================================
function rodarRaioX() {
  // startTotal conta o tempo COMPLETO: preload + loop de itens
  // Assim nunca estoura o limite de 6 min do Google.
  var startTotal = Date.now();

  var ss      = SpreadsheetApp.getActiveSpreadsheet();
  var sheet   = ss.getSheetByName(CONFIG.SHEET_NAME);
  var props   = PropertiesService.getUserProperties();
  var token   = props.getProperty("access_token");
  var userId  = props.getProperty("user_id");

  if (!token || !userId) {
    return SpreadsheetApp.getUi().alert("❌ Conecte sua conta antes de continuar.");
  }

  var headers       = { "Authorization": "Bearer " + token };
  var ultimaLinha   = Math.max(sheet.getLastRow(), 2);
  var dadosPlanilha = sheet.getRange("A2:AN" + ultimaLinha).getValues();

  // --- Identifica quais IDs ainda precisam ser processados ---
  var idsPendentes = [];
  for (var idx = 0; idx < dadosPlanilha.length; idx++) {
    var id     = String(dadosPlanilha[idx][1] || "").trim();
    var titulo = String(dadosPlanilha[idx][3] || "").trim();
    if (id.startsWith("MLB") && (!titulo || titulo.startsWith("ERRO"))) {
      idsPendentes.push(idx); // guarda o índice da linha, não o ID
    }
  }

  if (idsPendentes.length === 0) {
    return SpreadsheetApp.getUi().alert("✅ Todos os anúncios já foram auditados!\n\nPara re-auditar, limpe a planilha e sincronize novamente.");
  }

  // Modo Teste: limita a MAX_TESTE itens para validação rápida
  if (CONFIG.MODO_TESTE && idsPendentes.length > CONFIG.MAX_TESTE) {
    idsPendentes = idsPendentes.slice(0, CONFIG.MAX_TESTE);
    ss.toast("⚙️ MODO TESTE: auditando apenas " + CONFIG.MAX_TESTE + " anúncios.", "360 Gestão", 8);
  }

  ss.toast(
    "Carregando vendas (30d) para " + idsPendentes.length + " anúncios pendentes...",
    "360 Gestão", 12
  );

  // --- Pré-carrega todas as vendas dos últimos 30 dias em memória ---
  var baseVendas = preCarregarVendas30D(userId, headers);

  // --- Pré-carrega visitas totais em lote (50 IDs por chamada = muito mais rápido) ---
  // Isso evita 1 chamada individual por item, melhorando o throughput.
  ss.toast("Pré-carregando visitas totais...", "360 Gestão", 8);
  var baseVisitasTotais = preCarregarVisitasTotais(
    idsPendentes.map(function(i) { return String(dadosPlanilha[i][1]).trim(); }),
    headers
  );

  var processados   = 0;
  var bufferEscrita = [];
  var totalPendente = idsPendentes.length;

  ss.toast(
    "Auditando " + totalPendente + " anúncios. Não feche a aba.\n" +
    "Este processo roda em lotes de ~50. Clique novamente quando terminar o lote.",
    "360 Gestão", 10
  );

  for (var k = 0; k < idsPendentes.length; k++) {
    var i      = idsPendentes[k];
    var itemID = String(dadosPlanilha[i][1]).trim();

    try {
      // Renovação preventiva de token a cada 800 itens
      if (processados > 0 && processados % 800 === 0) {
        var novoToken = renovarToken();
        if (novoToken) { token = novoToken; headers = { "Authorization": "Bearer " + token }; }
      }

      // Feedback visual a cada 10 itens
      if (processados % 10 === 0) {
        ss.toast(
          "Auditando: " + processados + "/" + totalPendente + " processados neste lote...",
          "360 Gestão", 8
        );
      }

      // --- (1) DADOS BÁSICOS ---
      var resItem = fetchComStatus(CONFIG.API_BASE + "/items/" + itemID, headers);
      if (resItem.status === 401) {
        token = renovarToken();
        if (!token) throw new Error("Token inválido — reconecte a conta.");
        headers = { "Authorization": "Bearer " + token };
        resItem = fetchComStatus(CONFIG.API_BASE + "/items/" + itemID, headers);
      }
      if (resItem.status !== 200 || !resItem.data || resItem.data.error) continue;
      var det = resItem.data;

      // --- (2) PERFORMANCE (URL CORRETA: /item/ SINGULAR, não /items/) ---
      var resPerf = fetchComStatus(CONFIG.API_BASE + "/item/" + itemID + "/performance", headers);
      var perf    = (resPerf.status === 200 && resPerf.data) ? resPerf.data : null;
      var temPerf = !!(perf && perf.buckets);

      // --- (3) VISITAS (total vem do pré-carregamento em lote; janela por item) ---
      var visitas = getVisitasCompletas(itemID, headers, baseVisitasTotais);

      // --- (4) VENDAS GERAL — total de pedidos de todos os tempos para este item ---
      // Usa limit=1 para a chamada ser leve (só precisamos do paging.total)
      var pedidosGeral = getTotalPedidos(itemID, userId, headers);

      // --- VENDAS dos últimos 30/15/7 dias (do pré-carregamento) ---
      var vendas    = baseVendas[itemID] || { p7:0, p15:0, p30:0, u7:0, u15:0, u30:0 };
      var uTotal    = det.sold_quantity || 0; // unidades totais históricas

      // --- PENDÊNCIAS ---
      var pends = [];
      var score = 0;
      if (temPerf) {
        score = parseInt(perf.score || 0);
        (perf.buckets || []).forEach(function(b) {
          (b.variables || []).forEach(function(v) {
            if (v.status !== "COMPLETED" && v.status !== "OK" && v.title) {
              pends.push(v.title);
            }
          });
        });
      }

      var statusML = (det.status || "N/A").toUpperCase();

      // --- SQUAD + AÇÃO ---
      var squadAcao = inteligencia360(
        vendas, uTotal, visitas,
        det.available_quantity || 0, statusML, score, pends, temPerf
      );

      // --- CHECKLIST DE QUALIDADE ---
      var c_video, c_compat, c_promo, c_titulo, c_caract, c_fotos,
          c_codigo, c_tempo, c_estoque, c_preco, c_flex, c_frete, c_parcel;

      if (statusML === "PAUSED") {
        c_video = c_compat = c_promo = c_titulo = c_caract = c_fotos =
        c_codigo = c_tempo = c_estoque = c_preco = c_flex = c_frete = c_parcel = "⏸️ Pausado";
      } else {
        c_video   = statusPend(pends, ["clipe", "vídeo", "video"],                    temPerf);
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

      var calcConv = function(ped, vis) {
        return vis > 0 ? ((ped / vis) * 100).toFixed(2) + "%" : "0.00%";
      };

      var row = [
        "360 GESTÃO",         // A - CONTA
        itemID,               // B - ID
        getSKU(det),          // C - SKU  ← FIX: busca no array attributes como o Python
        det.title || "N/A",   // D - TÍTULO
        statusML,             // E - STATUS
        getCategoryTree(det.category_id, headers), // F - CATEGORIA
        squadAcao[0],         // G - SQUAD 360
        squadAcao[1],         // H - AÇÃO RECOMENDADA

        // Geral (toda a vida do anúncio)
        pedidosGeral,                              // I - VENDAS GERAL (PEDIDOS) ← FIX
        uTotal,                                    // J - UNIDADES GERAL
        visitas.total,                             // K - VISITAS GERAL
        calcConv(pedidosGeral, visitas.total),     // L - CONV. GERAL ← FIX

        // 30 dias
        vendas.p30, vendas.u30, visitas.v30, calcConv(vendas.p30, visitas.v30),
        // 15 dias
        vendas.p15, vendas.u15, visitas.v15, calcConv(vendas.p15, visitas.v15),
        // 7 dias
        vendas.p7,  vendas.u7,  visitas.v7,  calcConv(vendas.p7, visitas.v7),

        det.available_quantity || 0,               // Y - ESTOQUE
        det.price || 0,                            // Z - PREÇO
        temPerf ? score + "%" : "Sem acesso API",  // AA - SCORE

        c_video, c_compat, c_promo, c_titulo, c_caract, c_fotos, c_codigo,
        c_tempo, c_estoque, c_preco, c_flex, c_frete, c_parcel
      ];

      bufferEscrita.push({ linha: i + 2, row: row });
      processados++;

      if (bufferEscrita.length >= CONFIG.BATCH_SIZE) {
        escreverBuffer(sheet, bufferEscrita);
        bufferEscrita = [];
        SpreadsheetApp.flush();
      }

      // Trava de tempo: conta a partir do início TOTAL (inclui preload)
      if (Date.now() - startTotal > CONFIG.TIMEOUT_TOTAL) {
        escreverBuffer(sheet, bufferEscrita);
        SpreadsheetApp.flush();
        var restantes = totalPendente - processados;
        // Agenda execução automática em 1 min — o usuário não precisa clicar
        _agendarContinuacao();
        ss.toast(
          "⏳ Lote concluído: " + processados + " auditados, " + restantes +
          " pendentes. Continuando automaticamente em 1 minuto...",
          "360 Gestão", 60
        );
        return;
      }

    } catch (e) {
      sheet.getRange(i + 2, 4).setValue("ERRO: " + e.message);
    }
  }

  if (bufferEscrita.length > 0) {
    escreverBuffer(sheet, bufferEscrita);
    SpreadsheetApp.flush();
  }

  _cancelarTriggerContinuacao(); // garante limpeza de qualquer trigger pendente
  SpreadsheetApp.getUi().alert(
    "🏁 Auditoria concluída!\n\n✅ " + processados + " anúncios processados com sucesso."
  );
}

// =============================================================================
// CONTINUAÇÃO AUTOMÁTICA — Trigger-based (resolve o limite de 6 min)
// =============================================================================
/**
 * Disparado automaticamente pelo trigger após timeout.
 * Itens já processados têm título preenchido → não entram em idsPendentes.
 * Portanto, a função retoma naturalmente de onde parou, sem salvar estado.
 */
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
 * Trata 401 (token), 429 (rate limit) e falhas de rede sem engolir erros.
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
      if (status === 429) {           // Rate limit
        Utilities.sleep(2000 * (t + 1));
        continue;
      }
      if (status === 401) {           // Token expirado — deixa o chamador tratar
        return { status: 401, data: null };
      }
      if (status === 403 || status === 404) {
        return { status: status, data: null };
      }
      Utilities.sleep(1000 * (t + 1)); // 5xx: tenta de novo com backoff

    } catch (e) {
      if (t < maxTentativas - 1) Utilities.sleep(1000);
    }
  }

  return { status: 0, data: null };
}

/**
 * Renova o access_token via Ponte de Autenticação 360 (nunca expõe o CLIENT_SECRET
 * na planilha do cliente — o segredo fica apenas no projeto da Ponte).
 * WEB_APP_URL deve estar declarado no arquivo auth_ml.gs da planilha do cliente.
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
    // Token permanentemente revogado no ML: limpa credenciais locais e interrompe o loop (Vuln. E)
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

/**
 * Pré-carrega vendas dos últimos 30 dias em memória.
 * FIX: data ISO agora usa meia-noite do dia (igual ao Python) para evitar
 * diferenças de horário que faziam alguns pedidos escapar do filtro.
 * FIX: datas de corte calculadas UMA VEZ fora do loop.
 */
function preCarregarVendas30D(userId, headers) {
  var base  = {};
  var agora = new Date();

  // Igual ao Python: meia-noite do dia, 30 dias atrás
  var data30    = new Date(agora.getTime() - 30 * 24 * 60 * 60 * 1000);
  var data30ISO = Utilities.formatDate(data30, "UTC", "yyyy-MM-dd") + "T00:00:00.000-00:00";

  // Limites para classificação 7d e 15d (calculados UMA VEZ)
  var corte15 = new Date(agora.getTime() - 15 * 24 * 60 * 60 * 1000);
  var corte7  = new Date(agora.getTime() -  7 * 24 * 60 * 60 * 1000);

  var offset = 0;
  var totalPedidos = 0;

  while (true) {
    var url = CONFIG.API_BASE + "/orders/search?seller=" + userId +
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

        // Cada item dentro de um pedido conta como 1 pedido para aquele item
        base[id].p30 += 1;
        base[id].u30 += qtd;
        if (dt >= corte15) { base[id].p15 += 1; base[id].u15 += qtd; }
        if (dt >= corte7)  { base[id].p7  += 1; base[id].u7  += qtd; }
      });
    });

    totalPedidos += res.data.results.length;
    offset += 50;
    var total = (res.data.paging && res.data.paging.total) ? res.data.paging.total : 0;
    if (offset >= total) break;
  }

  console.log("Preload de vendas: " + totalPedidos + " pedidos carregados, " + Object.keys(base).length + " itens com vendas.");
  return base;
}

/**
 * Pré-carrega visitas totais em lote (50 IDs por chamada).
 * FIX: evita 1 chamada individual por item, acelerando o loop principal.
 */
function preCarregarVisitasTotais(ids, headers) {
  var base = {};

  for (var i = 0; i < ids.length; i += 50) {
    var lote = ids.slice(i, i + 50).join(",");
    var res  = fetchComStatus(CONFIG.API_BASE + "/visits/items?ids=" + lote, headers);
    if (res.status === 200 && res.data) {
      Object.keys(res.data).forEach(function(id) {
        base[id] = res.data[id] || 0;
      });
    }
  }

  return base;
}

/**
 * Busca visitas detalhadas: total (do pré-carregamento em lote) + janela 30d por dia.
 * FIX anterior: 'total' e 'v30' eram iguais porque somavam os mesmos dias.
 *   Agora 'total' vem do pré-carregamento via /visits/items (visitas da vida toda).
 */
function getVisitasCompletas(itemId, headers, baseTotais) {
  var total = baseTotais[itemId] || 0;
  var hoje  = Utilities.formatDate(new Date(), "GMT-3", "yyyy-MM-dd");

  var url30 = CONFIG.API_BASE + "/items/" + itemId +
              "/visits/time_window?last=30&unit=day&ending=" + hoje;
  var res30 = fetchComStatus(url30, headers);

  if (!res30.data || !res30.data.results) {
    return { total: total, v30: 0, v15: 0, v7: 0 };
  }

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

/**
 * Total de pedidos de TODA A VIDA do anúncio (não só 30d).
 * Usa limit=1 para a chamada ser leve — só precisamos do paging.total.
 * FIX: antes estava hardcoded como "N/A".
 */
function getTotalPedidos(itemId, userId, headers) {
  // "&q=" faz busca textual pelo ID do item nos pedidos (mais compatível que "&item=")
  var url = CONFIG.API_BASE + "/orders/search?seller=" + userId +
            "&q=" + itemId + "&order.status=paid&limit=1";
  var res = fetchComStatus(url, headers);
  if (res.status === 200 && res.data && res.data.paging) {
    var t = res.data.paging.total;
    if (typeof t === "number") return t;
  }
  // Fallback: tenta variante com "&item=" (algumas versões da API aceitam)
  url = CONFIG.API_BASE + "/orders/search?seller=" + userId +
        "&item=" + itemId + "&order.status=paid&limit=1";
  res = fetchComStatus(url, headers);
  if (res.status === 200 && res.data && res.data.paging) {
    return res.data.paging.total || 0;
  }
  console.warn("getTotalPedidos: sem resultado para " + itemId + " (status=" + res.status + ")");
  return 0;
}

/**
 * Extrai o SKU do anúncio.
 * FIX: o Python usa o array 'attributes' com id === 'SELLER_SKU'.
 * O campo 'seller_custom_field' é diferente e nem sempre está preenchido.
 * Agora busca em ambos, com fallback.
 */
function getSKU(det) {
  var attrs = det.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    var a = attrs[i];
    if (a.id === "SELLER_SKU") {
      // value_name é o campo principal; se nulo, tenta o array values
      if (a.value_name) return a.value_name;
      if (a.values && a.values.length > 0 && a.values[0].name) return a.values[0].name;
    }
  }
  if (det.seller_custom_field) return det.seller_custom_field;
  // Log para depuração: exibe quais IDs de atributo o item retornou
  console.warn("SEM SKU – " + det.id + " | attrs: " + attrs.map(function(a) { return a.id; }).join(","));
  return "SEM SKU";
}

// =============================================================================
// 4. INTELIGÊNCIA DE NEGÓCIO — Squad 360
// =============================================================================
function inteligencia360(vendas, uTotal, vis, estoque, status, score, pends, temPerf) {
  var conv30   = vis.v30 > 0 ? (vendas.p30 / vis.v30) : 0;
  var conv7    = vis.v7  > 0 ? (vendas.p7  / vis.v7)  : 0;
  var vDiaria7 = vendas.u7 / 7;
  var ids      = vDiaria7 > 0 ? (estoque / vDiaria7) : 999;

  if (status !== "ACTIVE") {
    if (uTotal > 50) return ["⏸️ SQUAD P", "URGENTE: Produto campeão pausado. Perda de dinheiro."];
    return ["⏸️ PAUSADO", "REPOSIÇÃO: Anúncio inativo, repor estoque."];
  }

  if (vendas.u7 > 0 && ids < 10) {
    return ["🔥 SQUAD S", "REPOSIÇÃO URGENTE: Estoque acaba em " + Math.floor(ids) + " dias."];
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
// 5. UTILITÁRIOS
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
