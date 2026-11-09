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

async function searchProm(query) {
  const url = new URL(SEARCH_BASE);
  url.searchParams.set("search_term", query);
  url.searchParams.set("page", "1");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; DeshevchePricePrototype/1.0)",
        "accept": "text/html,application/xhtml+xml"
      }
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const error = new Error("Prom.ua returned HTTP " + response.status);
    error.status = response.status;
    throw error;
  }

  const html = await response.text();
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const products = [];

  for (const match of scripts) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const found = [];
      walk(parsed, found);
      for (const product of found) {
        const cleaned = cleanProduct(product);
        if (cleaned?.title && cleaned.url) products.push(cleaned);
      }
    } catch {
      // Ignore malformed JSON-LD blocks and continue parsing other blocks.
    }
  }

  const unique = new Map();
  for (const product of products) {
    const key = product.url;
    if (!unique.has(key) || product.price < unique.get(key).price) unique.set(key, product);
  }

  return {
    source: "Prom.ua public search page",
    query,
    checkedAt: new Date().toISOString(),
    httpStatus: response.status,
    parsedJsonLdBlocks: scripts.length,
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
        : "No Product JSON-LD offers were parsed. This does not prove Prom has no matching products."
    });
  } catch (error) {
    const status = error.status === 403 || error.status === 429 ? 502 : 502;
    return send(res, status, {
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
