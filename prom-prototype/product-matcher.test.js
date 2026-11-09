const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeWords, classifyProduct } = require("./product-matcher");

test("normalizes split model code V 9 to V9", () => {
  assert.deepEqual(normalizeWords("MCHOSE V 9 Pro Red"), ["mchose", "v9", "pro", "red"]);
  assert.equal(classifyProduct({ title: "MCHOSE V9 Pro v 9 red" }, "MCHOSE V9 Pro").status, "match");
});

test("allows color and ordinary bundle wording", () => {
  assert.equal(classifyProduct({ title: "MCHOSE V9 Pro Red" }, "MCHOSE V9 Pro").status, "match");
  assert.equal(classifyProduct({ title: "Apple iPhone 15 128GB Black" }, "iPhone 15").status, "match");
});

test("does not confirm a different iPhone edition", () => {
  assert.equal(classifyProduct({ title: "Apple iPhone 15 Pro 128GB" }, "iPhone 15").status, "reject");
  assert.equal(classifyProduct({ title: "Apple iPhone 15 Pro Max 256GB" }, "iPhone 15").status, "reject");
  assert.equal(classifyProduct({ title: "Apple iPhone 15 Pro 128GB" }, "iPhone 15 Pro").status, "match");
  assert.equal(classifyProduct({ title: "Apple iPhone 15 Pro Max 256GB" }, "iPhone 15 Pro").status, "reject");
});

test("rejects accessory listings instead of confirming them", () => {
  assert.equal(classifyProduct({ title: "Чехол для Apple iPhone 15" }, "iPhone 15").status, "reject");
  assert.equal(classifyProduct({ title: "Захисне скло iPhone 15" }, "iPhone 15").status, "reject");
  assert.equal(classifyProduct({ title: "Наушники EarPods USB-C для iPhone 15/16" }, "iPhone 15").status, "reject");
  assert.equal(classifyProduct({ title: "Apple EarPods USB-C для iPhone 15" }, "iPhone 15").status, "reject");
});

test("does not treat a battery mention as an accessory when the listing is a phone", () => {
  assert.equal(classifyProduct({
    title: "Apple iPhone 15 128GB Yellow",
    description: "Телефон с новым аккумулятором, состояние отличное"
  }, "iPhone 15").status, "match");
});

test("rejects locked phones and phones sold for parts", () => {
  assert.equal(classifyProduct({
    title: "Apple iPhone 15 Pro 256GB",
    description: "iCloud lock, заблокирован"
  }, "iPhone 15 Pro").status, "reject");
  assert.equal(classifyProduct({ title: "iPhone 15 на запчасти" }, "iPhone 15").status, "reject");
});

test("rejects obvious imitations", () => {
  assert.equal(classifyProduct({ title: "iPhone 15 копия Android" }, "iPhone 15").status, "reject");
});

test("does not confirm a title missing query terms", () => {
  assert.equal(classifyProduct({ title: "Apple iPhone 15 128GB" }, "iPhone 15 Pro").status, "uncertain");
});
