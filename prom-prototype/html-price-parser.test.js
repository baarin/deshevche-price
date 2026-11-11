const test = require("node:test");
const assert = require("node:assert/strict");
const { parsePromHtmlPrice } = require("./html-price-parser");

function priceTag(price, currency = String.fromCharCode(0x20B4, 0x2F, 0x0448, 0x0442, 0x002E)) {
  const hryvnia = String.fromCharCode(0x20B4);
  return `<span data-qaid="product_price" data-qaprice="${price}" data-qacurrency="${currency}">${price} ${hryvnia}</span>`;
}

test("parses integer Prom product price from exact product_price marker", () => {
  assert.equal(parsePromHtmlPrice(priceTag("48449")).price, 48449);
});

test("preserves decimal kopecks from data-qaprice", () => {
  assert.equal(parsePromHtmlPrice(priceTag("543.51")).price, 543.51);
  assert.equal(parsePromHtmlPrice(priceTag("68.40")).price, 68.4);
});

test("accepts comma decimal and grouped spaces", () => {
  assert.equal(parsePromHtmlPrice(priceTag("1 234,50", String.fromCharCode(0x0433, 0x0440, 0x043D, 0x002E))).price, 1234.5);
});

test("does not read installment, old, wholesale, or Rozetka bonus markers", () => {
  const html = [
    '<span data-qaid="product_pay_parts_price" data-qaprice="11569" data-qacurrency="UAH">11569 UAH / month</span>',
    '<span data-qaid="old_price" data-qaprice="86770" data-qacurrency="UAH">86770 UAH</span>',
    '<span data-qaid="opt_price" data-qaprice="50000" data-qacurrency="UAH">50000 UAH</span>',
    '<span data-qaid="rozetka_red_price" data-qaprice="5" data-qacurrency="UAH">5%</span>'
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

test('accepts the real hryvnia symbol', () => {
  const currency = String.fromCharCode(0x20B4, 0x2F, 0x0448, 0x0442, 0x002E);
  assert.equal(parsePromHtmlPrice(priceTag('149', currency)).price, 149);
});
