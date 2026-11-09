function parsePageTitlePrice(title) {
  if (typeof title !== "string") return null;

  const match = title.match(/(?:цiна|ціна|цена|price)\s*:?\s*(?:від\s*)?([\d][\d\s\u00a0.,]*)\s*(₴|грн\.?|UAH)/i);
  if (!match) return null;

  const digits = match[1].replace(/\D/g, "");
  const price = Number(digits);
  if (!Number.isSafeInteger(price) || price <= 0) return null;

  return {
    price,
    currency: "UAH",
    source: "page-title"
  };
}

module.exports = { parsePageTitlePrice };
