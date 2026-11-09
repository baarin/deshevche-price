const test = require("node:test");
const assert = require("node:assert/strict");
const { parsePageTitlePrice } = require("./price-parser");

test("parses Prom page titles with Ukrainian hryvnia symbol", () => {
  assert.deepEqual(
    parsePageTitlePrice("Смартфон iPhone 17, ціна: 48 449 ₴, купити на Prom.ua"),
    { price: 48449, currency: "UAH", source: "page-title" }
  );
});

test("parses Prom page titles with грн currency", () => {
  assert.equal(
    parsePageTitlePrice("Захисне скло, ціна 149 грн: купити на Prom.ua").price,
    149
  );
});

test("returns null when a page title has no explicit price", () => {
  assert.equal(parsePageTitlePrice("Apple iPhone 17 256GB Mist Blue"), null);
  assert.equal(parsePageTitlePrice(null), null);
});

test("does not accept zero or malformed prices", () => {
  assert.equal(parsePageTitlePrice("Товар, ціна: 0 ₴"), null);
});

test("preserves decimal prices in page titles", () => {
  assert.equal(
    parsePageTitlePrice("Смарт-карта, ціна: 543.51 ₴, купити на Prom.ua").price,
    543.51
  );
  assert.equal(
    parsePageTitlePrice("Скло, ціна: 68.40 ₴, купити на Prom.ua").price,
    68.4
  );
});
