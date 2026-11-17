
const {
  classifyProduct,
  classifyProductCondition
} = require("../product-matcher");

const BASE_URL = "https://www.moyo.ua/";
const SEARCH_URL = "https://www.moyo.ua/ua/search/new/";
const HOST = new URL(BASE_URL).hostname;

const USER_AGENT =
  "Mozilla/5.0 (compatible; DeshevchePricePrototype/1.0)";

async function fetchHtml(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "uk-UA,uk;q=0.9,ru;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`MOYO HTTP ${response.status}: ${url}`);
  }

  return response.text();
}

function getAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp(
      `\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      "i"
    )
  );

  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
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
    )
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteMoyoUrl(href) {
  if (!href) return null;

  try {
    const url = new URL(href, BASE_URL);

    if (
      url.protocol !== "https:" ||
      url.hostname !== HOST
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function extractProductCards(html) {
  const starts = [];

  const startRegex =
    /<div\b[^>]*class=["'][^"']*\bproduct-card\b[^"']*["'][^>]*>/gi;

  for (const match of html.matchAll(startRegex)) {
    starts.push(match.index);
  }

  const products = [];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = starts[i + 1] ?? html.length;
    const block = html.slice(start, end);

    const openingTag = block.match(/^<div\b[^>]*>/i)?.[0];

    if (!openingTag) continue;

    const title = decodeHtml(
      getAttribute(openingTag, "data-name")
    );

    const rawPrice = getAttribute(openingTag, "data-price");
    const brand = decodeHtml(
      getAttribute(openingTag, "data-brand")
    );

    const price = Number(
      String(rawPrice).replace(",", ".")
    );

    const linkMatch = block.match(
      /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/i
    );

    const href = linkMatch
      ? (linkMatch[1] ?? linkMatch[2] ?? linkMatch[3] ?? "")
      : "";

    const url = absoluteMoyoUrl(href);

    if (
      !title ||
      !Number.isFinite(price) ||
      price <= 0 ||
      !url
    ) {
      continue;
    }

    products.push({
      title,
      brand,
      price,
      currency: "UAH",
      url
    });
  }

  return products;
}

function getMicrodataValue(html, itemprop) {
  const escaped = itemprop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const regex = new RegExp(
    `<(?:meta|link)\\b(?=[^>]*\\bitemprop\\s*=\\s*["']${escaped}["'])[^>]*>`,
    "gi"
  );

  const match = regex.exec(html);

  if (!match) return "";

  return (
    getAttribute(match[0], "content") ||
    getAttribute(match[0], "href") ||
    ""
  );
}

function isInStock(value) {
  return /(?:^|\/)InStock\/?$/i.test(
    String(value || "").trim()
  );
}

function extractProductName(html) {
  const h1 = html.match(
    /<h1\b[^>]*\bitemprop\s*=\s*["']name["'][^>]*>([\s\S]*?)<\/h1>/i
  );

  if (h1) {
    const name = decodeHtml(
      h1[1].replace(/<[^>]+>/g, " ")
    );

    if (name) return name;
  }

  return decodeHtml(
    getMicrodataValue(html, "name")
  );
}

function parseMoyoProduct(html, pageUrl, query, card) {
  const availability = getMicrodataValue(
    html,
    "availability"
  );

  if (!isInStock(availability)) {
    return null;
  }

  const title = extractProductName(html) || card.title;

  const rawPrice = getMicrodataValue(html, "price");
  const pagePrice = Number(
    String(rawPrice).replace(",", ".")
  );

  const price =
    Number.isFinite(pagePrice) && pagePrice > 0
      ? pagePrice
      : card.price;

  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }

  const currency =
    getMicrodataValue(html, "priceCurrency") || "UAH";

  const itemCondition = getMicrodataValue(
    html,
    "itemCondition"
  );

  const normalized = {
    title,
    description: "",
    price,
    currency,
    url: pageUrl,
    seller: "MOYO",
    availability,
    itemCondition,
    listingTitle: card.title
  };

  const match = classifyProduct(normalized, query);

  if (match.status !== "match") {
    return null;
  }

  const condition = classifyProductCondition(normalized);

  return {
    ...normalized,
    condition:
      condition === "unknown" &&
      /(?:^|\/)NewCondition\/?$/i.test(
        String(itemCondition || "")
      )
        ? "new"
        : condition,
    source: "MOYO"
  };
}

async function searchMoyo(query) {
  const searchUrl = new URL(SEARCH_URL);
  searchUrl.searchParams.set("q", query);

  const html = await fetchHtml(searchUrl.toString());
  const cards = extractProductCards(html);

  const matchingCards = cards.filter(card => {
    const listingProduct = {
      title: card.title,
      description: "",
      price: card.price,
      currency: "UAH",
      url: card.url,
      seller: "MOYO",
      availability: "Unknown",
      listingTitle: card.title
    };

    const match = classifyProduct(listingProduct, query);

    return match.status === "match";
  });

  const results = [];

  for (const card of matchingCards) {
    try {
      const productHtml = await fetchHtml(card.url);

      const product = parseMoyoProduct(
        productHtml,
        card.url,
        query,
        card
      );

      if (product) {
        results.push(product);
      }
    } catch {
      // Пропускаем товар, страницу которого не удалось обработать.
    }
  }

  const unique = new Map();

  for (const product of results) {
    const previous = unique.get(product.url);

    if (!previous || product.price < previous.price) {
      unique.set(product.url, product);
    }
  }

  return [...unique.values()].sort(
    (a, b) => a.price - b.price
  );
}

module.exports = {
  searchMoyo,
  parseMoyoProduct
};
