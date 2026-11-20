
const http = require("node:http");
const {
  classifyProduct,
  classifyProductCondition
} = require("./product-matcher");
const { parsePageTitlePrice } = require("./price-parser");
const { parsePromHtmlPrice } = require("./html-price-parser");
const { searchKibernetiki } = require("./sources/kibernetiki");
const { searchMoyo } = require("./sources/moyo");
const { searchRozetka } = require("./sources/rozetka-reefapi");
const { searchComfy } = require("./sources/comfy");
const { searchFoxtrot } = require("./sources/foxtrot");
const { searchOlx } = require("./sources/olx");

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

  if (types.some(t => String(t).toLowerCase() === "product")) {
    found.push(value);
  }

  if (value["@graph"]) walk(value["@graph"], found);
  if (value.itemListElement) walk(value.itemListElement, found);
  if (value.item) walk(value.item, found);
}

function getPrice(offers) {
  const list = Array.isArray(offers) ? offers : [offers];
  const candidates = [];

  for (const offer of list) {
    if (!offer || typeof offer !== "object") continue;

    const price = Number(
      offer.price ??
      offer.lowPrice ??
      offer.priceSpecification?.price
    );

    if (Number.isFinite(price) && price > 0) {
      candidates.push({
        price,
        currency:
          offer.priceCurrency ||
          offer.priceSpecification?.priceCurrency ||
          "UAH",
        availability: offer.availability || null,
        seller:
          typeof offer.seller === "string"
            ? offer.seller
            : offer.seller?.name || null
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
    try {
      url = new URL(url, "https://prom.ua").toString();
    } catch {
      url = null;
    }
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
        "user-agent":
          "Mozilla/5.0 (compatible; DeshevchePricePrototype/1.0)",
        accept: "text/html,application/xhtml+xml"
      }
    });

    return {
      response,
      html: await response.text()
    };
  } finally {
    clearTimeout(timeout);
  }
}

function inspectVisiblePriceMarkup(html) {
  const candidates = [];

  const patterns = [
    /data-qaid=["']([^"']*price[^"']*)["']/gi,
    /itemprop=["']price["']/gi,
    /property=["']product:price:amount["']/gi
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const index = match.index || 0;

      const snippet = html.slice(
        Math.max(0, index - 180),
        Math.min(html.length, index + 520)
      );

      const textPreview = snippet
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220);

      candidates.push({
        marker: match[1] || match[0],
        textPreview
      });

      if (candidates.length >= 8) return candidates;
    }
  }

  return candidates;
}

function inspectJsonLd(html) {
  const scripts = [
    ...html.matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];

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
        rootKeys:
          parsed && typeof parsed === "object"
            ? Object.keys(parsed).slice(0, 20)
            : [],
        productNodesFound: found.length,
        productNodeDetails: found.slice(0, 5).map(product => ({
          name: product.name || null,
          hasOffers: Boolean(product.offers),
          offerDetails: (
            Array.isArray(product.offers)
              ? product.offers
              : [product.offers]
          )
            .filter(offer => offer && typeof offer === "object")
            .map(offer => ({
              price: offer.price ?? null,
              lowPrice: offer.lowPrice ?? null,
              highPrice: offer.highPrice ?? null,
              priceCurrency: offer.priceCurrency ?? null,
              availability: offer.availability ?? null,
              seller:
                typeof offer.seller === "string"
                  ? offer.seller
                  : offer.seller?.name ?? null,
              priceSpecification:
                offer.priceSpecification ?? null
            }))
        })),
        preview: raw.slice(0, 300)
      });

      for (const product of found) {
        const cleaned = cleanProduct(product);

        if (cleaned?.title && cleaned.url) {
          products.push(cleaned);
        }
      }
    } catch (error) {
      diagnostics.push({
        block: index + 1,
        parseError: error.message,
        preview: raw.slice(0, 200)
      });
    }
  }

  return {
    scriptsCount: scripts.length,
    diagnostics,
    products
  };
}

async function searchProm(query) {
  const MAX_RESULTS = 99;
  const MAX_LISTING_PAGES = 4;
  const DETAIL_CONCURRENCY = 5;

  const listItems = [];
  const seenUrls = new Set();

  let listingStatus = null;
  let firstListing = null;
  let pagesChecked = 0;

  for (
    let page = 1;
    page <= MAX_LISTING_PAGES && listItems.length < MAX_RESULTS;
    page++
  ) {
    const url = new URL(SEARCH_BASE);

    url.searchParams.set("search_term", query);
    url.searchParams.set("page", String(page));

    try {
      const result = await fetchHtml(url);

      if (!result.response.ok) {
        if (page === 1) {
          throw new Error(
            "Prom.ua returned HTTP " + result.response.status
          );
        }
        break;
      }

      pagesChecked++;
      listingStatus = result.response.status;

      if (!firstListing) {
        firstListing = inspectJsonLd(result.html);
      }

      let addedOnPage = 0;

      for (const match of result.html.matchAll(
        /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
      )) {
        try {
          const data = JSON.parse(match[1].trim());
          const roots = Array.isArray(data) ? data : [data];

          for (const root of roots) {
            if (
              root?.["@type"] !== "ItemList" ||
              !Array.isArray(root.itemListElement)
            ) {
              continue;
            }

            for (const entry of root.itemListElement) {
              const item =
                entry?.item && typeof entry.item === "object"
                  ? entry.item
                  : entry;

              const rawUrl = item?.url || entry?.url || null;
              if (!rawUrl) continue;

              try {
                const productUrl = new URL(rawUrl, "https://prom.ua");

                if (
                  !(
                    productUrl.hostname === "prom.ua" ||
                    productUrl.hostname.endsWith(".prom.ua")
                  )
                ) {
                  continue;
                }

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

        const titleMatch = detail.html.match(
          /<title[^>]*>([\s\S]*?)<\/title>/i
        );

        const pageTitle = titleMatch
          ? titleMatch[1].replace(/\s+/g, " ").trim()
          : null;

        const pageTitlePrice = parsePageTitlePrice(pageTitle);
        const htmlProductPrice = parsePromHtmlPrice(detail.html);

        const parsedProducts = inspected.products.map(product => {
          const jsonLdPrice = product.price;

          const usePageTitlePrice = Boolean(
            pageTitlePrice &&
            pageTitlePrice.currency === product.currency
          );

          const useHtmlPrice = Boolean(
            htmlProductPrice?.price &&
            htmlProductPrice.currency === "UAH"
          );

          const selectedPrice = useHtmlPrice
            ? htmlProductPrice.price
            : usePageTitlePrice
              ? pageTitlePrice.price
              : product.price;

          const selectedPriceSource = useHtmlPrice
            ? "html-data-qaprice"
            : usePageTitlePrice
              ? "page-title"
              : "json-ld";

          return {
            ...product,
            listingTitle: item.title,
            price: selectedPrice,
            currency: useHtmlPrice
              ? htmlProductPrice.currency
              : product.currency,
            jsonLdPrice,
            pageTitlePrice: pageTitlePrice?.price ?? null,
            htmlProductPrice: htmlProductPrice?.price ?? null,
            htmlProductPriceSource: htmlProductPrice?.source ?? null,
            htmlProductPriceIssue: htmlProductPrice?.reason ?? null,
            priceSource: selectedPriceSource,
            priceMismatch: Boolean(
              (
                useHtmlPrice &&
                (
                  Number(jsonLdPrice) !== Number(htmlProductPrice.price) ||
                  (
                    pageTitlePrice &&
                    Number(pageTitlePrice.price) !==
                      Number(htmlProductPrice.price)
                  )
                )
              ) ||
              (
                !useHtmlPrice &&
                usePageTitlePrice &&
                Number(jsonLdPrice) !== Number(pageTitlePrice.price)
              )
            ),
            listingPosition: item.position,
            listingPage: item.listingPage,
            possibleMismatch: /android/i.test(
              (product.title || "") +
              " " +
              (product.description || "")
            )
          };
        });

        detailChecks[index] = {
          listingTitle: item.title,
          listingUrl: item.url,
          listingPosition: item.position,
          listingPage: item.listingPage,
          httpStatus: detail.response.status,
          pageTitle,
          pageTitlePrice: pageTitlePrice?.price ?? null,
          htmlProductPrice,
          priceMarkupDiagnostics: inspectVisiblePriceMarkup(detail.html),
          parsedJsonLdBlocks: inspected.scriptsCount,
          jsonLdDiagnostics: inspected.diagnostics,
          productsParsed: parsedProducts,
          error: detail.response.ok
            ? null
            : "Product page returned HTTP " + detail.response.status
        };
      } catch (error) {
        detailChecks[index] = {
          listingTitle: item.title,
          listingUrl: item.url,
          listingPosition: item.position,
          listingPage: item.listingPage,
          error:
            error.name === "AbortError"
              ? "Product page request timed out"
              : error.message
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(DETAIL_CONCURRENCY, listItems.length) },
      () => worker()
    )
  );

  const unique = new Map();
  const rejectedProducts = [];
  const uncertainProducts = [];
  const classifiedUrls = new Set();

  const allProducts = detailChecks.flatMap(
    check => check?.productsParsed || []
  );

  for (const product of allProducts) {
    const classification = classifyProduct(product, query);
    const key = product.url;

    if (classification.status !== "match") {
      if (!classifiedUrls.has(key)) {
        classifiedUrls.add(key);

        const item = {
          title: product.title,
          price: product.price,
          currency: product.currency,
          url: product.url,
          seller: product.seller,
          reason: classification.reason
        };

        if (classification.status === "reject") {
          rejectedProducts.push(item);
        } else {
          uncertainProducts.push(item);
        }
      }

      continue;
    }

    const condition = classifyProductCondition(product);
    const classifiedProduct = { ...product, condition };

    if (
      !unique.has(key) ||
      product.price < unique.get(key).price
    ) {
      unique.set(key, classifiedProduct);
    }
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
    checkedProductPages: detailChecks.filter(
      check => check && !check.error
    ).length,
    failedProductPages: detailChecks.filter(
      check => check?.error
    ).length,
    parsedJsonLdBlocks: firstListing?.scriptsCount || 0,
    jsonLdDiagnostics: firstListing?.diagnostics || [],
    firstListItems: listItems.slice(0, 10),
    productPageChecks: detailChecks,
    rejectedProducts,
    uncertainProducts,
    products: [...unique.values()]
      .sort((a, b) => a.price - b.price)
      .slice(0, MAX_RESULTS)
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url,
    "http://" + (req.headers.host || "localhost")
  );

  if (url.pathname === "/health") {
    return send(res, 200, {
      ok: true,
      service: "prom-prototype"
    });
  }

  if (url.pathname === "/olx-diagnostic") {
    const targets = [
      { name: "OLX homepage", url: "https://www.olx.ua/" },
      { name: "OLX search", url: "https://www.olx.ua/uk/list/q-Logitech-G435/" }
    ];

    let egressIp = null;
    let egressIpError = null;
    try {
      const ipResponse = await fetch("https://api.ipify.org?format=json", {
        signal: AbortSignal.timeout(10000)
      });
      if (!ipResponse.ok) throw new Error(`IP lookup HTTP ${ipResponse.status}`);
      const ipData = await ipResponse.json();
      egressIp = ipData.ip || null;
    } catch (error) {
      egressIpError = error.message;
    }
    const results = await Promise.all(targets.map(async (target) => {
      try {
        const response = await fetch(target.url, {
          redirect: "follow",
          signal: AbortSignal.timeout(20000),
          headers: {
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            accept: "text/html,application/xhtml+xml"
          }
        });

        const body = await response.text();

        return {
          target: target.name,
          status: response.status,
          finalUrl: response.url,
          contentType: response.headers.get("content-type"),
          server: response.headers.get("server"),
          via: response.headers.get("via"),
          body: body.replace(/\s+/g, " ").slice(0, 500)
        };
      } catch (error) {
        return {
          target: target.name,
          error: error.message
        };
      }
    }));

    return send(res, 200, {
      ok: true,
      checkedAt: new Date().toISOString(),
      egressIp,
      egressIpError,
      results
    });
  }
  if (url.pathname !== "/search") {
    return send(res, 404, {
      ok: false,
      error: "Use /health or /search?q=product"
    });
  }

  const query = (url.searchParams.get("q") || "").trim();

  if (!query) {
    return send(res, 400, {
      ok: false,
      error: "Missing search query parameter q"
    });
  }

  if (query.length > 120) {
    return send(res, 400, {
      ok: false,
      error: "Query is too long (max 120 characters)"
    });
  }

  try {
    const [
      promResult,
      kibernetikiResult,
      moyoResult,
      rozetkaResult,
      comfyResult,
      foxtrotResult,
      olxResult
    ] = await Promise.allSettled([
      searchProm(query),
      searchKibernetiki(query),
      searchMoyo(query),
      searchRozetka(query),
      searchComfy(query),
      searchFoxtrot(query),
      searchOlx(query)
    ]);

    const promProducts =
      promResult.status === "fulfilled"
        ? promResult.value.products
        : [];

    const kibernetikiProducts =
      kibernetikiResult.status === "fulfilled"
        ? kibernetikiResult.value
        : [];

    const moyoProducts =
      moyoResult.status === "fulfilled"
        ? moyoResult.value
        : [];

    const rozetkaProducts =
      rozetkaResult.status === "fulfilled"
        ? rozetkaResult.value
        : [];

    const comfyProducts =       comfyResult.status === "fulfilled"         ? comfyResult.value         : [];      const foxtrotProducts =       foxtrotResult.status === "fulfilled"         ? foxtrotResult.value         : [];
    const olxProducts = olxResult.status === "fulfilled" ? olxResult.value : [];

    const products = [
      ...promProducts,
      ...kibernetikiProducts,
      ...moyoProducts,
      ...rozetkaProducts,
      ...comfyProducts,
      ...foxtrotProducts,
      ...olxProducts
    ];

    const inStockProducts = products.filter((product) => {
      if (product.source === "OLX") return Boolean(product.title && product.price > 0 && product.url);
      const availability = String(product.availability || "").trim().replace(/\/+$/, "").toLowerCase();
      return availability.endsWith("/instock");
    });

    const uniqueProducts = new Map();

    for (const product of inStockProducts) {
      const previous = uniqueProducts.get(product.url);

      if (!previous || product.price < previous.price) {
        uniqueProducts.set(product.url, product);
      }
    }

    const allProducts = [...uniqueProducts.values()].sort(
      (a, b) => a.price - b.price
    );

    const successfulSources = [];

    if (promResult.status === "fulfilled") {
      successfulSources.push("Prom.ua");
    }

    if (kibernetikiResult.status === "fulfilled") {
      successfulSources.push("Кібернетики");
    }

    if (moyoResult.status === "fulfilled") {
      successfulSources.push("MOYO");
    }

    if (rozetkaResult.status === "fulfilled") {
      successfulSources.push("Rozetka");
    }
     if (comfyResult.status === "fulfilled") {       successfulSources.push("COMFY");     }      if (foxtrotResult.status === "fulfilled") {       successfulSources.push("Foxtrot");     }

    
    if (olxResult.status === "fulfilled") successfulSources.push("OLX");const result = {
      ...(promResult.status === "fulfilled"
        ? promResult.value
        : {}),
      source:
        successfulSources.join(" + ") ||
        "Нет доступных источников",
      products: allProducts
    };

    const sourceErrors = [];

    if (promResult.status === "rejected") {
      sourceErrors.push({
        source: "Prom.ua",
        error: promResult.reason?.message || String(promResult.reason)
      });
    }

    if (kibernetikiResult.status === "rejected") {
      sourceErrors.push({
        source: "Кібернетики",
        error:
          kibernetikiResult.reason?.message ||
          String(kibernetikiResult.reason)
      });
    }

    if (moyoResult.status === "rejected") {
      sourceErrors.push({
        source: "MOYO",
        error: moyoResult.reason?.message || String(moyoResult.reason)
      });
    }

    if (rozetkaResult.status === "rejected") {
      sourceErrors.push({
        source: "Rozetka",
        error: rozetkaResult.reason?.message || String(rozetkaResult.reason)
      });
    }

    if (comfyResult.status === "rejected") {
      sourceErrors.push({ source: "COMFY", error: comfyResult.reason?.message || String(comfyResult.reason) });
    }

    if (foxtrotResult.status === "rejected") {
      sourceErrors.push({ source: "Foxtrot", error: foxtrotResult.reason?.message || String(foxtrotResult.reason) });
    }

    if (olxResult.status === "rejected") sourceErrors.push({ source: "OLX", error: olxResult.reason?.message || String(olxResult.reason) });

    const note =
      "Результаты объединены из доступных источников. " +
      "Сортировка по цене товара; доставка не учитывается.";

    const debug = url.searchParams.get("debug") === "1";

    if (debug) {
      return send(res, 200, {
        ok: true,
        ...result,
        resultCount: result.products.length,
        sourceErrors,
        note
      });
    }

    return send(res, 200, {
      ok: true,
      source: result.source,
      query: result.query,
      checkedAt: result.checkedAt,
      pagesChecked: result.pagesChecked,
      candidateCount: result.candidateCount,
      checkedProductPages: result.checkedProductPages,
      failedProductPages: result.failedProductPages,
      products: result.products.map(
        ({
          title,
          price,
          currency,
          url,
          seller,
          availability,
          condition
        }) => ({
          title,
          price,
          currency,
          url,
          seller,
          availability,
          condition
        })
      ),
      resultCount: result.products.length,
      note
    });
  } catch (error) {
    return send(res, 502, {
      ok: false,
      source: "Prom.ua public search page",
      query,
      error:
        error.name === "AbortError"
          ? "Prom.ua request timed out"
          : error.message,
      note:
        "Prototype only. No CAPTCHA, login, or anti-bot challenge is bypassed."
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    "Prom prototype listening on " + HOST + ":" + PORT
  );
});

