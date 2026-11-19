const {
  classifyProduct,
  classifyProductCondition
} = require("../product-matcher");

const API_URL = "https://foxtrot-api.evinent.site/api/search/autocomplete";
const BASE_URL = "https://www.foxtrot.com.ua";
const CITY_ID = 11;
const LANGUAGE_ID = 1;

async function searchFoxtrot(query) {
  const url =
    `${API_URL}/${CITY_ID}/${LANGUAGE_ID}/${encodeURIComponent(query)}/`;

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
    headers: {
      "user-agent": "Mozilla/5.0 (compatible: DeshevchePricePrototype/1.0)",
      accept: "application/json",
      "accept-language": "uk-UA,uk;q=0.9"
    }
  });

  if (!response.ok) {
    throw new Error(`Foxtrot HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data.products)) {
    throw new Error("Foxtrot: invalid products response");
  }

  const results = [];

  for (const item of data.products) {
    if (item.isAvailable !== true) continue;

    let productUrl;

    try {
      productUrl = new URL(item.url, BASE_URL);

      if (
        productUrl.protocol !== "https:" ||
        productUrl.hostname !== "www.foxtrot.com.ua"
      ) {
        continue;
      }
    } catch {
      continue;
    }

    const price = Number(item.price);

    if (!Number.isFinite(price) || price <= 0) continue;

    const title = String(item.title || "").trim();

    if (!title) continue;

    const normalized = {
      title,
      description:
        typeof item.properties === "string"
          ? item.properties
          : JSON.stringify(item.properties || {}),
      price,
      currency: "UAH",
      url: productUrl.toString(),
      seller: "Foxtrot",
      availability: "https://schema.org/InStock",
      listingTitle: title
    };

    const match = classifyProduct(normalized, query);

    if (match.status !== "match") continue;

    const condition = classifyProductCondition(normalized);

    if (["used", "refurbished", "discounted"].includes(condition)) {
      continue;
    }

    results.push({
      ...normalized,
      condition,
      source: "Foxtrot"
    });
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

module.exports = { searchFoxtrot };