const { classifyProduct, classifyProductCondition } =
  require("../product-matcher");

const BASE_URL = "https://kibernetiki.com.ua/";
const HOST = new URL(BASE_URL).hostname;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchHtml(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml"
    }
  });

  if (!response.ok) {
    throw new Error(`Kibernetiki HTTP ${response.status}: ${url}`);
  }

  return response.text();
}

function getAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
  );

  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function walkJsonLd(value, found = []) {
  if (!value || typeof value !== "object") return found;

  if (
    value["@type"] === "Product" ||
    (Array.isArray(value["@type"]) && value["@type"].includes("Product"))
  ) {
    found.push(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) walkJsonLd(item, found);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (key !== "@context") walkJsonLd(item, found);
    }
  }

  return found;
}

function collectOffers(value, result = []) {
  if (!value || typeof value !== "object") return result;

  if (Array.isArray(value)) {
    for (const item of value) collectOffers(item, result);
    return result;
  }

  if (value.price != null || value.lowPrice != null) {
    result.push(value);
  }

  if (value.offers) collectOffers(value.offers, result);

  return result;
}

function isInStock(value) {
  return /(?:^|\/)InStock$/i.test(String(value || ""));
}

function parseKibernetikiProduct(html, pageUrl, query) {
  const scripts = [
    ...html.matchAll(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];

  const products = [];

  for (const script of scripts) {
    try {
      walkJsonLd(JSON.parse(script[1]), products);
    } catch {
      // РџСЂРѕРїСѓСЃРєР°РµРј РЅРµРєРѕСЂСЂРµРєС‚РЅС‹Р№ JSON-LD Р±Р»РѕРє.
    }
  }

  for (const product of products) {
    const offers = collectOffers(product.offers)
      .filter(offer => isInStock(offer.availability))
      .map(offer => ({
        price: Number(
          offer.price ??
          offer.lowPrice ??
          offer.priceSpecification?.price
        ),
        currency:
          offer.priceCurrency ||
          offer.priceSpecification?.priceCurrency ||
          "UAH",
        availability: offer.availability,
        itemCondition: offer.itemCondition,
        seller:
          typeof offer.seller === "string"
            ? offer.seller
            : offer.seller?.name || "РљС–Р±РµСЂРЅРµС‚РёРєРё"
      }))
      .filter(offer =>
        Number.isFinite(offer.price) && offer.price > 0
      )
      .sort((a, b) => a.price - b.price);

    const offer = offers[0];
    if (!offer) continue;

    let url;

    try {
      url = new URL(product.url || product["@id"] || pageUrl, pageUrl)
        .toString();
    } catch {
      continue;
    }

    if (new URL(url).hostname !== HOST) continue;

    const normalized = {
      title: product.name || null,
      description: product.description || null,
      price: offer.price,
      currency: offer.currency,
      url,
      seller: offer.seller,
      availability: offer.availability,
      listingTitle: product.name || null
    };

    const match = classifyProduct(normalized, query);
    if (match.status !== "match") continue;

    const condition = classifyProductCondition(normalized);

    return {
      ...normalized,
      condition:
        condition === "unknown" &&
        /(?:^|\/)NewCondition$/i.test(
          String(offer.itemCondition || "")
        )
          ? "new"
          : condition,
      source: "Kibernetiki"
    };
  }

  return null;
}


async function searchKibernetiki(query) {
  const searchUrl = new URL("/api/backend/search/products", BASE_URL);
  searchUrl.searchParams.set("query", query);
  searchUrl.searchParams.set("pageSize", "60");
  searchUrl.searchParams.set("page", "1");
  searchUrl.searchParams.set("locale", "UA");

  const response = await fetch(searchUrl.toString(), {
    headers: {
      Accept: "application/json",
      locale: "UA",
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Kibernetiki API РІРµСЂРЅСѓР» HTTP ${response.status}`
    );
  }

  const data = await response.json();
  const products = data?.products;

  if (!Array.isArray(products)) {
    throw new Error("Р’ РѕС‚РІРµС‚Рµ API РљС–Р±РµСЂРЅРµС‚РёРєРё РѕС‚СЃСѓС‚СЃС‚РІСѓРµС‚ СЃРїРёСЃРѕРє С‚РѕРІР°СЂРѕРІ");
  }

  const results = [];

  for (const item of products) {
    if (
      item.inStock !== true ||
      item.preorder === true ||
      !item.urlName ||
      !item.category?.urlName
    ) {
      continue;
    }

    const price = Number(
      item.finalPrice ??
      item.promotionPrice ??
      item.regularPrice
    );

    if (!Number.isFinite(price) || price <= 0) continue;

    const url = new URL(
      `${item.category.urlName}/${item.urlName}.html`,
      BASE_URL
    ).toString();

    const listingProduct = {
      title: item.name || item.shortName || "",
      listingTitle: item.name || item.shortName || "",
      price,
      currency: "UAH",
      url,
      seller: "РљС–Р±РµСЂРЅРµС‚РёРєРё",
      availability: "https://schema.org/InStock"
    };

    const match = classifyProduct(listingProduct, query);

    if (match.status !== "match") continue;

    const html = await fetchHtml(url);
    const product = parseKibernetikiProduct(html, url, query);

    if (product) results.push(product);
  }

  const unique = new Map();

  for (const product of results) {
    const previous = unique.get(product.url);

    if (!previous || product.price < previous.price) {
      unique.set(product.url, product);
    }
  }

  return [...unique.values()].sort((a, b) => a.price - b.price);
}

module.exports = {
  searchKibernetiki,
  parseKibernetikiProduct
};
