function parseNumericPrice(raw) {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().replace(/[\s\u00a0]+/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const price = Number(normalized);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function parsePromHtmlPrice(html) {
  if (typeof html !== "string") return null;

  const candidates = [];
  const openingTagPattern = /<[a-z][\w:-]*\b[^>]*>/gi;

  for (const match of html.matchAll(openingTagPattern)) {
    const tag = match[0];
    const qaid = tag.match(/\bdata-qaid\s*=\s*(["'])(.*?)\1/i);
    if (!qaid || qaid[2] !== "product_price") continue;

    const rawPriceMatch = tag.match(/\bdata-qaprice\s*=\s*(["'])(.*?)\1/i);
    const rawCurrencyMatch = tag.match(/\bdata-qacurrency\s*=\s*(["'])(.*?)\1/i);
    if (!rawPriceMatch || !rawCurrencyMatch) continue;

    const rawCurrency = rawCurrencyMatch[2].trim();
    if (!/^(?:₴|грн\.?|UAH)(?:\s*\/\s*шт\.?)?$/i.test(rawCurrency)) continue;

    const price = parseNumericPrice(rawPriceMatch[2]);
    if (price === null) continue;

    candidates.push({
      price,
      currency: "UAH",
      source: "html-data-qaprice",
      rawPrice: rawPriceMatch[2],
      rawCurrency
    });
  }

  const distinctPrices = [...new Set(candidates.map(candidate => candidate.price))];
  if (distinctPrices.length === 0) return null;
  if (distinctPrices.length > 1) {
    return {
      price: null,
      currency: "UAH",
      source: "html-data-qaprice",
      reason: "ambiguous-product-price",
      candidates
    };
  }

  return candidates[0];
}

module.exports = { parsePromHtmlPrice };
