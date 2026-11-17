const {
  classifyProduct,
  classifyProductCondition
} = require("../product-matcher");

const API_URL = "https://api.reefapi.com/rozetka/v1/search";
const IN_STOCK = "https://schema.org/InStock";

function normalizeRozetkaProduct(product, query) {
  if (!product || typeof product !== "object") return null;

  // Показываем только подтверждённый статус «в наличии».
  if (
    product.in_stock !== true ||
    product.sell_status !== "available"
  ) {
    return null;
  }

  const title = String(product.title || "").trim();
  const url = String(product.url || "").trim();
  const price = Number(product.price);

  // Не создаём искусственные названия, цены или ссылки.
  if (!title || !url || !Number.isFinite(price) || price <= 0) {
    return null;
  }

  const normalized = {
    ...product,
    title,
    price,
    currency: product.currency || "UAH",
    url,
    seller:
      product.seller_name ||
      (product.sold_by === "rozetka" ? "Rozetka" : null),
    availability: IN_STOCK,
    listingTitle: title
  };

  const match = classifyProduct(normalized, query);

  if (match.status !== "match") return null;

  const condition = classifyProductCondition(normalized);

  return {
    ...normalized,
    condition
  };
}

function normalizeRozetkaResponse(payload, query) {
  if (!payload || payload.ok !== true) {
    throw new Error(
      payload?.error?.message ||
      payload?.error ||
      "ReefAPI returned an unsuccessful response"
    );
  }

  const products = payload.data?.results;

  if (!Array.isArray(products)) {
    throw new Error(
      "Unexpected ReefAPI response: data.products is not an array"
    );
  }

  return products
    .map(product => normalizeRozetkaProduct(product, query))
    .filter(Boolean);
}

async function searchRozetka(query) {
  const normalizedQuery = String(query || "").trim();

  if (!normalizedQuery) {
    throw new Error("Missing Rozetka search query");
  }

  const apiKey = process.env.REEF_API_KEY;

  if (!apiKey) {
    throw new Error("REEF_API_KEY environment variable is not configured");
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      query: normalizedQuery,
      sort: "relevance",
      page: 1,
      lang: "ua"
    }),
    signal: AbortSignal.timeout(90000)
  });

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error(
      "ReefAPI returned invalid JSON (HTTP " + response.status + ")"
    );
  }

  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
      payload?.error ||
      "ReefAPI HTTP error " + response.status
    );
  }

  return normalizeRozetkaResponse(payload, normalizedQuery);
}

module.exports = {
  searchRozetka,
  normalizeRozetkaProduct,
  normalizeRozetkaResponse
};
