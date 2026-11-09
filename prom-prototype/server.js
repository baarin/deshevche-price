const http = require("node:http");

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
const SEARCH_BASE = "https://prom.ua/ua/search";

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

function walk(value, found) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, found);
    return;
  }
  const type = value["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some(t => String(t).toLowerCase() === "product")) found.push(value);
  if (value["@graph"]) walk(value["@graph"], found);
  if (value.itemListElement) walk(value.itemListElement, found);
  if (value.item) walk(value.item, found);
}

function getPrice(offers) {
  const list = Array.isArray(offers) ? offers : [offers];
  const candidates = [];
  for (const offer of list) {
    if (!offer || typeof offer !== "object") continue;
    const price = Number(offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price);
    if (Number.isFinite(price) && price > 0) {
      candidates.push({
        price,
        currency: offer.priceCurrency || offer.priceSpecification?.priceCurrency || "UAH",
        availability: offer.availability || null,
        seller: typeof offer.seller === "string" ? offer.seller : offer.seller?.name || null
      });
    }
  }
  candidates.sort((a, b) => a.price - b.price);
  return candidates[0] || null;
}

function cleanProduct(product) {
  const offer = getPrice(product.offers);
  if (!offer) return null;
  let url = product.url || product["@id"] || null;
  if (url) {
    try { url = new URL(url, "https://prom.ua").toString(); } catch { url = null; }
  }
  return {
    title: product.name || null,
    price: offer.price,
    currency: offer.currency,
    url,
    seller: offer.seller,
    availability: offer.availability
  };
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; DeshevchePricePrototype/1.0)",
        "accept": "text/html,application/xhtml+xml"
      }
    });
    return { response, html: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

function inspectJsonLd(html) {
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const diagnostics = [];
  const products = [];
  for (let index = 0; index < scripts.length; index++) {
    const raw = scripts[index][1].trim();
    try {
      const parsed = JSON.parse(raw);
      const found = [];
      walk(parsed, found);
      const rootTypes = Array.isArray(parsed)
        ? parsed.map(item => item && item["@type"]).filter(Boolean)
        : [parsed && parsed["@type"]].filter(Boolean);
      diagnostics.push({
        block: index + 1,
        rootTypes,
        rootKeys: parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 20) : [],
        productNodesFound: found.length,
        productNodeDetails: found.slice(0, 5).map(product => ({
          name: product.name || null,
          hasOffers: Boolean(product.offers),
          offerKeys: product.offers && typeof product.offers === "object"
            ? Object.keys(Array.isArray(product.offers) ? product.offers[0] || {} : product.offers).slice(0, 15)
            : []
        })),
        preview: raw.slice(0, 300)
      });
      for (const product of found) {
        const cleaned = cleanProduct(product);
        if (cleaned?.title && cleaned.url) products.push(cleaned);
      }
    } catch (error) {
      diagnostics.push({ block: index + 1, parseError: error.message, preview: raw.slice(0, 200) });
    }
  }
  return { scriptsCount: scripts.length, diagnostics, products };
}

async function searchProm(query) {
  const url = new URL(SEARCH_BASE);
  url.searchParams.set("search_term", query);
  url.searchParams.set("page", "1");

  const { response, html } = await fetchHtml(url);
  if (!response.ok) throw new Error("Prom.ua returned HTTP " + response.status);

  const listing = inspectJsonLd(html);
  const listItems = [];
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(match[1].trim());
      const roots = Array.isArray(data) ? data : [data];
      for (const root of roots) {
        if (root?.["@type"] === "ItemList" && Array.isArray(root.itemListElement)) {
          for (const entry of root.itemListElement) {
            const item = entry?.item && typeof entry.item === "object" ? entry.item : entry;
            const rawUrl = item?.url || entry?.url || null;
            if (!rawUrl) continue;
            try {
              const productUrl = new URL(rawUrl, "https://prom.ua");
              if (productUrl.hostname === "prom.ua" || productUrl.hostname.endsWith(".prom.ua")) {
                listItems.push({
                  title: item.name || entry.name || null,
                  url: productUrl.toString(),
                  position: entry.position || null
                });
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  const detailChecks = [];
  for (const item of listItems.slice(0, 3)) {
    try {
      const detail = await fetchHtml(item.url);
      const inspected = inspectJsonLd(detail.html);
      const titleMatch = detail.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      detailChecks.push({
        listingTitle: item.title,
        listingUrl: item.url,
        listingPosition: item.position,
        httpStatus: detail.response.status,
        pageTitle: titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : null,
        parsedJsonLdBlocks: inspected.scriptsCount,
        jsonLdDiagnostics: inspected.diagnostics,
        productsParsed: inspected.products
      });
    } catch (error) {
      detailChecks.push({
        listingTitle: item.title,
        listingUrl: item.url,
        error: error.name === "AbortError" ? "Product page request timed out" : error.message
      });
    }
  }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const unique = new Map();
  for (const product of listing.products) {
    const key = product.url;
    if (!unique.has(key) || product.price < unique.get(key).price) unique.set(key, product);
  }

  return {
    source: "Prom.ua public search page",
    query,
    checkedAt: new Date().toISOString(),
    httpStatus: response.status,
    pageTitle: titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : null,
    htmlMentionsQuery: html.toLowerCase().includes(query.toLowerCase()),
    parsedJsonLdBlocks: listing.scriptsCount,
    jsonLdDiagnostics: listing.diagnostics,
    itemListCount: listItems.length,
    firstListItems: listItems.slice(0, 3),
    productPageChecks: detailChecks,
    products: [...unique.values()].sort((a, b) => a.price - b.price).slice(0, 30)
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  if (url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "prom-prototype" });
  }
  if (url.pathname !== "/search") {
    return send(res, 404, { ok: false, error: "Use /health or /search?q=product" });
  }
  const query = (url.searchParams.get("q") || "").trim();
  if (!query) return send(res, 400, { ok: false, error: "Missing search query parameter q" });
  if (query.length > 120) return send(res, 400, { ok: false, error: "Query is too long (max 120 characters)" });
  try {
    const result = await searchProm(query);
    return send(res, 200, {
      ok: true,
      ...result,
      resultCount: result.products.length,
      note: result.products.length
        ? "Parsed public structured product data; verify titles and prices before using in the main site."
        : "Diagnostic mode: checks ItemList entries and up to three public product pages. No CAPTCHA, login, or anti-bot challenge is bypassed."
    });
  } catch (error) {
    return send(res, 502, {
      ok: false,
      source: "Prom.ua public search page",
      query,
      error: error.name === "AbortError" ? "Prom.ua request timed out" : error.message,
      note: "Prototype only. No CAPTCHA, login, or anti-bot challenge is bypassed."
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log("Prom prototype listening on " + HOST + ":" + PORT);
});
