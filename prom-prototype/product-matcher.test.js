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

test("rejects branded accessories listed for a requested phone", () => {
  const earpods = classifyProduct({
    title: "Apple EarPods USB-C для iPhone 15"
  }, "iPhone 15");
  assert.equal(earpods.status, "reject");

  const pitakaCase = classifyProduct({
    title: "Ультратонкий магнітний чохол Pitaka MagEZ Case 4 для iPhone 15 Plus"
  }, "iPhone 15");
  assert.equal(pitakaCase.status, "reject");
  assert.match(pitakaCase.reason, /аксессуар/i);
});

test("rejects a standalone battery for the requested phone", () => {
  assert.equal(classifyProduct({
    title: "Аккумулятор для Apple iPhone 15"
  }, "iPhone 15").status, "reject");
});

test("does not treat a battery mention as an accessory when the listing is a phone", () => {
  assert.equal(classifyProduct({
    title: "Apple iPhone 15 128GB Yellow",
    description: "Телефон с новым аккумулятором, состояние отличное"
  }, "iPhone 15").status, "match");
  assert.equal(classifyProduct({
    title: "Apple iPhone 15 256GB Black, аккумулятор 95%"
  }, "iPhone 15").status, "match");
  assert.equal(classifyProduct({
    title: "Apple iPhone 15 128GB с новым аккумулятором"
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

test("rejects Cyrillic accessory titles before the requested phone model", () => {
  assert.equal(classifyProduct({ title: "Захисне скло 9D iPhone 17" }, "iPhone 17").status, "reject");
  assert.equal(classifyProduct({ title: "Захисне скло для iPhone 17 загартоване скло айфон 17" }, "iPhone 17").status, "reject");
  assert.equal(classifyProduct({ title: "Чохол для iPhone 17 з MagSafe чорний матовий" }, "iPhone 17").status, "reject");
  assert.equal(classifyProduct({ title: "Зарядний пристрій для Apple iPhone 17" }, "iPhone 17").status, "reject");
});

test("rejects SIM unlock cards and R-Sim accessories for a phone query", () => {
  const cases = [
    "Смарт-карта R-Sim WELLSIM PRO для iPhone 6-17 Pro",
    "SIM-карта для разблокировки iPhone 17 Pro",
    "Чип для разблокировки iPhone 17 Pro"
  ];
  for (const title of cases) {
    assert.equal(classifyProduct({ title }, "iPhone 17 Pro").status, "reject", title);
  }
});

test("rejects Pro editions when the query asks for the base iPhone 17", () => {
  const titles = [
    "Apple iPhone 17 Pro 256GB Cosmic Orange",
    "Смартфон Apple iPhone 17 Pro 256GB eSim Silver",
    "Мобільний телефон Apple iPhone 17 Pro 512GB Deep Blue MG8N4"
  ];
  for (const title of titles) {
    const result = classifyProduct({ title }, "iPhone 17");
    assert.equal(result.status, "reject", title);
    assert.match(result.reason, /другая версия модели: pro/i);
  }
  const proMax = classifyProduct({ title: "Apple iPhone 17 Pro Max 512GB Silver" }, "iPhone 17");
  assert.equal(proMax.status, "reject");
  assert.match(proMax.reason, /другая версия модели: pro/i);
});

test("keeps the base iPhone 17 as a match for the exact base-model query", () => {
  const titles = [
    "Apple iPhone 17 256GB Black",
    "Смартфон Apple iPhone 17 256GB eSIM White",
    "Мобільний телефон Apple iPhone 17 512GB"
  ];
  for (const title of titles) {
    assert.equal(classifyProduct({ title }, "iPhone 17").status, "match", title);
  }
});

test("rejects R-Sim and WELLSIM even when the phone model range is written as 6-17", () => {
  const result = classifyProduct({
    title: "Смарт-карта R-Sim WELLSIM PRO для iPhone 6-17 Pro / Pro Max IOS 18.7.1 + 26 з підтримкою VoLTE та LTE",
    description: "WELLSIM eX, чіп для iPhone, чіп для розблокування iPhone, заблокованих на іноземних операторів"
  }, "iPhone 17 Pro");
  assert.equal(result.status, "reject");
  assert.match(result.reason, /SIM-карта або чип/i);
});

test("does not reject ordinary iPhone SIM or eSIM specifications", () => {
  assert.equal(classifyProduct({ title: "Apple iPhone 17 Pro 256GB eSIM Silver" }, "iPhone 17 Pro").status, "match");
  assert.equal(classifyProduct({ title: "Apple iPhone 17 Pro 256GB Dual SIM" }, "iPhone 17 Pro").status, "match");
});
