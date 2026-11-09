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
    description: product.description || null,
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

function isLikelyMismatch(product, query) {
  const q = String(query || "").toLowerCase();
  const text = ((product.title || "") + " " + (product.description || "")).toLowerCase();
  const asksForApple = /\b(iphone|айфон|apple)\b/i.test(q);
  if (!asksForApple) return false;
  return /android|копі[яї]|копия|імітац|имитац|реплік|реплик|муляж|якісна копія|гарейна копія/i.test(text);
}

async function searchProm(query) {
  const MAX_RESULTS = 29;
  const MAX_LISTING_PAGES = 4;
  const DETAIL_CONCURRENCY = 5;
  const listItems = [];
  const seenUrls = new Set();
  let listingStatus = null;
  let firstListing = null;
  let pagesChecked = 0;

  // Collect up to 99 distinct public listing entries across up to four search pages.
  for (let page = 1; page <= MAX_LISTING_PAGES && listItems.length < MAX_RESULTS; page++) {
    const url = new URL(SEARCH_BASE);
    url.searchParams.set("search_term", query);
    url.searchParams.set("page", String(page));

    try {
      const result = await fetchHtml(url);
      if (!result.response.ok) {
        if (page === 1) throw new Error("Prom.ua returned HTTP " + result.response.status);
        break;
      }
      pagesChecked++;
      listingStatus = result.response.status;
      if (!firstListing) firstListing = inspectJsonLd(result.html);

      let addedOnPage = 0;
      for (const match of result.html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
          const data = JSON.parse(match[1].trim());
          const roots = Array.isArray(data) ? data : [data];
          for (const root of roots) {
            if (root?.["@type"] !== "ItemList" || !Array.isArray(root.itemListElement)) continue;
            for (const entry of root.itemListElement) {
              const item = entry?.item && typeof entry.item === "object" ? entry.item : entry;
              const rawUrl = item?.url || entry?.url || null;
              if (!rawUrl) continue;
              try {
                const productUrl = new URL(rawUrl, "https://prom.ua");
                if (!(productUrl.hostname === "prom.ua" || productUrl.hostname.endsWith(".prom.ua"))) continue;
                const normalizedUrl = productUrl.toString();
                if (seenUrls.has(normalizedUrl)) continue;
                seenUrls.add(normalizedUrl);
                listItems.push({
                  title: item.name || entry.name || null,
                  url: normalizedUrl,
                  position: entry.position || listItems.length + 1,
                  listingPage: page
                });
                addedOnPage++;
                if (listItems.length >= MAX_RESULTS) break;
              } catch {}
              if (listItems.length >= MAX_RESULTS) break;
            }
            if (listItems.length >= MAX_RESULTS) break;
          }
        } catch {}
        if (listItems.length >= MAX_RESULTS) break;
      }
      if (addedOnPage === 0) break;
      if (page < MAX_LISTING_PAGES && listItems.length < MAX_RESULTS) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } catch (error) {
      if (page === 1) throw error;
      break;
    }
  }

  // Fetch product pages in a small worker pool instead of launching 99 requests at once.
  const detailChecks = new Array(listItems.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= listItems.length) return;
      const item = listItems[index];
      try {
        const detail = await fetchHtml(item.url);
        const inspected = inspectJsonLd(detail.html);
        const titleMatch = detail.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const parsedProducts = inspected.products.map(product => ({
          ...product,
          listingPosition: item.position,
          listingPage: item.listingPage,
          possibleMismatch: /android/i.test((product.title || "") + " " + (product.description || ""))
        }));
        detailChecks[index] = {
          listingTitle: item.title,
          listingUrl: item.url,
          listingPosition: item.position,
          listingPage: item.listingPage,
          httpStatus: detail.response.status,
          pageTitle: titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : null,
          parsedJsonLdBlocks: inspected.scriptsCount,
          productsParsed: parsedProducts,
          error: detail.response.ok ? null : "Product page returned HTTP " + detail.response.status
        };
      } catch (error) {
        detailChecks[index] = {
          listingTitle: item.title,
          listingUrl: item.url,
          listingPosition: item.position,
          listingPage: item.listingPage,
          error: error.name === "AbortError" ? "Product page request timed out" : error.message
        };
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(DETAIL_CONCURRENCY, listItems.length) },
    () => worker()
  ));

  const unique = new Map();
  const rejectedProducts = [];
  const rejectedUrls = new Set();
  const allProducts = detailChecks.flatMap(check => check?.productsParsed || []);
  for (const product of [...(firstListing?.products || []), ...allProducts]) {
    if (isLikelyMismatch(product, query)) {
      if (!rejectedUrls.has(product.url)) {
        rejectedUrls.add(product.url);
        rejectedProducts.push({
          title: product.title,
          price: product.price,
          url: product.url,
          reason: "Possible imitation or Android-based copy of an Apple product"
        });
      }
      continue;
    }
    const key = product.url;
    if (!unique.has(key) || product.price < unique.get(key).price) unique.set(key, product);
  }

  return {
    source: "Prom.ua public search page",
    query,
    checkedAt: new Date().toISOString(),
    httpStatus: listingStatus,
    pagesChecked,
    maxResults: MAX_RESULTS,
    itemListCount: listItems.length,
    candidateCount: listItems.length,
    checkedProductPages: detailChecks.filter(check => check && !check.error).length,
    failedProductPages: detailChecks.filter(check => check?.error).length,
    parsedJsonLdBlocks: firstListing?.scriptsCount || 0,
    jsonLdDiagnostics: firstListing?.diagnostics || [],
    firstListItems: listItems.slice(0, 10),
    productPageChecks: detailChecks,
    rejectedProducts,
    products: [...unique.values()].sort((a, b) => a.price - b.price).slice(0, MAX_RESULTS)
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
        : "No suitable structured product data was found among the checked public product pages. No CAPTCHA, login, or anti-bot challenge is bypassed."
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
