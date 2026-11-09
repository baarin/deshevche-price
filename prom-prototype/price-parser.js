function parsePriceNumber(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/[\s\u00a0]+/g, "");
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) return null;
  const price = Number(value.replace(",", "."));
  return Number.isFinite(price) && price > 0 ? price : null;
}

function parsePageTitlePrice(title) {
  if (typeof title !== "string") return null;

  const match = title.match(/(?:цiна|ціна|цена|price)\s*:?\s*(?:від\s*)?([\d][\d\s\u00a0]*(?:[.,]\d{1,2})?)\s*(₴|грн\.?|UAH)/i);
  if (!match) return null;

  const price = parsePriceNumber(match[1]);
  if (price === null) return null;

  return {
    price,
    currency: "UAH",
    source: "page-title"
  };
}

module.exports = { parsePageTitlePrice };
