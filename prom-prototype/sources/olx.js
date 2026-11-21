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

function decodeXml(value) {
  return decodeHtml(String(value || ""));
}

function getAtomTag(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  if (!match) return "";
  return match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, "$1").trim();
}

function getAtomAttribute(tag, attribute) {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function parseOlxAtom(xml, query) {
  if (!/<feed\b/i.test(xml)) {
    throw new Error("OLX RSS-Bridge: получен ответ без Atom feed");
  }

  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  if (!entries.length) return [];

  const results = [];

  for (const entry of entries) {
    const rawTitle = getAtomTag(entry, "title");
    const title = stripHtml(decodeXml(rawTitle));

    if (/^Bridge returned error/i.test(title)) {
      throw new Error(`OLX RSS-Bridge: ${title}`);
    }

    const links = entry.match(/<link\b[^>]*\/?>/gi) || [];
    const alternate = links.find(link => /\brel=["']alternate["']/i.test(link));
    const enclosure = links.find(link => /\brel=["']enclosure["']/i.test(link));

    const rawUrl = alternate && getAtomAttribute(alternate, "href");
    const image = enclosure && getAtomAttribute(enclosure, "href");

    let url = null;
    try {
      const parsedUrl = new URL(rawUrl || "");
      if (
        parsedUrl.protocol === "https:" &&
        (parsedUrl.hostname === "olx.ua" || parsedUrl.hostname === "www.olx.ua") &&
        /^\/d\/uk\/obyavlenie\//i.test(parsedUrl.pathname)
      ) {
        url = parsedUrl.toString();
      }
    } catch {}

    const rawContent = getAtomTag(entry, "content");
    const html = decodeXml(rawContent);
    const cityMatch = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const city = cityMatch ? stripHtml(cityMatch[1]) : "";

    const priceMatch = html.match(
      /<span\b(?=[^>]*font-weight\s*:\s*bold)[^>]*>([\s\S]*?)<\/span>/i
    );
    const priceText = priceMatch ? stripHtml(priceMatch[1]) : "";
    const price = parsePrice(priceText);

    if (!title || !price || !url) continue;

    const product = {
      title,
      listingTitle: title,
      price,
      currency: "UAH",
      url,
      image: image || null,
      city: city || null,
      priceLabel: priceText || null,
      negotiable: /договірн|договорн/i.test(priceText),
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
    if (!unique.has(product.url)) unique.set(product.url, product);
  }

  return [...unique.values()].sort((a, b) => a.price - b.price);
}

async function searchOlx(query) {
  const slug = encodeURIComponent(
    String(query || "").trim().replace(/\s+/g, "-")
  );

  const targetUrl = new URL(`/uk/list/q-${slug}/?currency=UAH`, BASE_URL);
  const bridgeUrl = new URL("https://bridge.folk.zone/");

  bridgeUrl.searchParams.set("action", "display");
  bridgeUrl.searchParams.set("bridge", "OLXBridge");
  bridgeUrl.searchParams.set("url", targetUrl.toString());
  bridgeUrl.searchParams.set("format", "Atom");
  bridgeUrl.searchParams.set("_", String(Date.now()));

  const response = await fetch(bridgeUrl.toString(), {
    redirect: "follow",
    signal: AbortSignal.timeout(25000),
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/atom+xml,application/xml,text/xml"
    }
  });

  if (!response.ok) {
    throw new Error(`OLX RSS-Bridge HTTP ${response.status}`);
  }

  const xml = await response.text();
  return parseOlxAtom(xml, query);
}

module.exports = {
  searchOlx,
  parseOlxCards,
  parseOlxAtom
};