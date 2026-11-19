const {
  classifyProduct,
  classifyProductCondition
} = require("../product-matcher");

const API_URL = "https://comfy.ua/api/searcher/autosuggest";
const BASE_URL = "https://comfy.ua/ua/";
const USER_AGENT = "Mozilla/5.0 (compatible; DeshevchePricePrototype/1.0)";

async function searchComfy(query) {
  const url = new URL(API_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "10");
  url.searchParams.set("storeId", "5");
  url.searchParams.set("cityId", "506");
  url.searchParams.set("types", "product,tap,category");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json",
      "accept-language": "uk-UA,uk;q=0.9"
    }
  });

  if (!response.ok) {
    throw new Error(`COMFY HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data.products)) {
    throw new Error("COMFY: invalid products response");
  }

  const results = [];

  for (const item of data.products) {
    const offer = item.buybox?.offer;
    const available =
      item.remains === true &&
      item.buybox?.state === "available" &&
      offer?.availability === "available" &&
      offer?.remains?.flags?.isAvailable === true;

    if (!available) continue;

    let productUrl;

    try {
      productUrl = new URL(item.url, BASE_URL);

      if (
        productUrl.protocol !== "https:" ||
        productUrl.hostname !== "comfy.ua"
      ) {
        continue;
      }
    } catch {
      continue;
    }

    const price = Number(item.price ?? offer?.price?.specialPrice);

    if (!Number.isFinite(price) || price <= 0) continue;

    const normalized = {
      title: String(item.name || "").trim(),
      description: "",
      price,
      currency: "UAH",
      url: productUrl.toString(),
      seller: "COMFY",
      availability: "https://schema.org/InStock",
      listingTitle: String(item.name || "").trim()
    };

    if (!normalized.title) continue;

    const match = classifyProduct(normalized, query);

    if (match.status !== "match") continue;

    const condition = classifyProductCondition(normalized);

    if (["used", "refurbished", "discounted"].includes(condition)) {
      continue;
    }

    results.push({
      ...normalized,
      condition,
      source: "COMFY"
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

module.exports = { searchComfy };