const { classifyProduct, classifyProductCondition } =
  require("../product-matcher");

const BASE_URL = "https://www.olx.ua/";
const HOST = new URL(BASE_URL).hostname;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16))
    );
}

function stripHtml(value) {
  return decodeHtml(
    String(value || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function getElementText(html, testId) {
  const escaped = testId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(
      `<([a-z][\\w:-]*)\\b(?=[^>]*data-testid=["']${escaped}["'])[^>]*>([\\s\\S]*?)<\\/\\1>`,
      "i"
    )
  );

  return match ? stripHtml(match[2]) : "";
}

function getListingUrl(card) {
  const match = card.match(
    /<a\b(?=[^>]*href=["']([^"']*\/d\/uk\/obyavlenie\/[^"']+)["'])[^>]*>/i
  );

  if (!match) return null;

  try {
    const url = new URL(decodeHtml(match[1]), BASE_URL);
    if (url.hostname !== HOST) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parsePrice(value) {
  const normalized = String(value || "")
    .replace(/\s/g, "")
    .replace(/[^\d,\.]/g, "")
    .replace(",", ".");

  const price = Number(normalized);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function parseOlxCards(html, query) {
  const cards = html.split(
    /(?=<div\b[^>]*data-testid=["']l-card["'])/i
  ).slice(1);

  const results = [];

  for (const card of cards) {
    const title =
      getElementText(card, "ad-card-title") ||
      getElementText(card, "card-title-link");

    const priceText = getElementText(card, "ad-price");
    const price = parsePrice(priceText);
    const url = getListingUrl(card);

    if (!title || !price || !url) continue;

    const product = {
      title,
      listingTitle: title,
      price,
      currency: "UAH",
      url,
      seller: "OLX",
      source: "OLX"
    };

    const match = classifyProduct(product, query);
    if (match.status !== "match") continue;

    results.push({
      ...product,
      condition: classifyProductCondition(product)
    });
  }

  const unique = new Map();

  for (const product of results) {
    if (!unique.has(product.url)) {
      unique.set(product.url, product);
    }
  }

  return [...unique.values()].sort((a, b) => a.price - b.price);
}

async function searchOlx(query) {
  const slug = encodeURIComponent(
    String(query || "").trim().replace(/\s+/g, "-")
  );

  const searchUrl = new URL(`/uk/list/q-${slug}/`, BASE_URL);

  const response = await fetch(searchUrl.toString(), {
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml"
    }
  });

  if (!response.ok) {
    const responseBody = await response.text();
    const diagnostic = {
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get("content-type"),
      server: response.headers.get("server"),
      via: response.headers.get("via"),
      requestId:
        response.headers.get("x-request-id") ||
        response.headers.get("x-datadome-request-id"),
      datadome: response.headers.get("x-datadome"),
      body: responseBody.replace(/\s+/g, " ").slice(0, 500)
    };
    throw new Error(`OLX HTTP ${response.status}: ${JSON.stringify(diagnostic)}`);
  }

  const html = await response.text();
  return parseOlxCards(html, query);
}

module.exports = {
  searchOlx,
  parseOlxCards
};
