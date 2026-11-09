const test = require("node:test");
const assert = require("node:assert/strict");
const { parsePromHtmlPrice } = require("./html-price-parser");

function priceTag(price, currency = "₴/шт.") {
  return `<span data-qaid="product_price" data-qaprice="${price}" data-qacurrency="${currency}">${price} ₴</span>`;
}

test("parses integer Prom product price from exact product_price marker", () => {
  assert.equal(parsePromHtmlPrice(priceTag("48449")).price, 48449);
});

test("preserves decimal kopecks from data-qaprice", () => {
  assert.equal(parsePromHtmlPrice(priceTag("543.51")).price, 543.51);
  assert.equal(parsePromHtmlPrice(priceTag("68.40")).price, 68.4);
});

test("accepts comma decimal and grouped spaces", () => {
  assert.equal(parsePromHtmlPrice(priceTag("1 234,50", "грн.")).price, 1234.5);
});

test("does not read installment, old, wholesale, or Rozetka bonus markers", () => {
  const html = [
    '<span data-qaid="product_pay_parts_price" data-qaprice="11569" data-qacurrency="₴">11 569 ₴ /міс</span>',
    '<span data-qaid="old_price" data-qaprice="86770" data-qacurrency="₴">86 770 ₴</span>',
    '<span data-qaid="opt_price" data-qaprice="50000" data-qacurrency="₴">50 000 ₴</span>',
    '<span data-qaid="rozetka_red_price" data-qaprice="5" data-qacurrency="₴">5%</span>'
  ].join("");
  assert.equal(parsePromHtmlPrice(html), null);
});

test("requires an accepted currency marker", () => {
  assert.equal(parsePromHtmlPrice(priceTag("149", "USD")), null);
});

test("returns null for malformed or non-positive prices", () => {
  assert.equal(parsePromHtmlPrice(priceTag("0")), null);
  assert.equal(parsePromHtmlPrice(priceTag("54.351")), null);
  assert.equal(parsePromHtmlPrice(priceTag("not-a-price")), null);
  assert.equal(parsePromHtmlPrice(null), null);
});

test("reports conflicting product_price values as ambiguous", () => {
  const html = priceTag("100") + priceTag("120");
  const parsed = parsePromHtmlPrice(html);
  assert.equal(parsed.price, null);
  assert.equal(parsed.reason, "ambiguous-product-price");
});
