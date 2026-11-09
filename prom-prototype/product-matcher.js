const ACCESSORY_TITLE_PATTERNS = [
  /^(?:чехол|чохол|кейс|case|cover|накладка|защитное стекло|захисне скло|стекло|скло|пленка|плівка)\b/i,
  /^(?:зарядка|зарядний пристрій|зарядное устройство|charger|charging adapter|адаптер питания|кабель|cable|шнур)\b/i,
  /^(?:наушники|навушники|earpods|earbuds|headphones|headset|гарнитура|гарнітура|амбушюры|амбушури)\b/i,
  /^(?:аккумулятор|батарея|battery|дисплей|экран|display|screen|шлейф|запчасть|запчастина|деталь|ремешок|ремінець|strap|держатель|тримач|подставка|підставка)\b/i,
  /\b(?:для|for)\s+(?:apple\s+)?iphone\s+\d+/i
];

const VARIANT_MARKERS = new Set([
  "turbo", "plus", "max", "mini", "lite", "ultra", "neo", "se",
  "pro", "promax", "mk2", "mk3", "2024", "2025", "2026"
]);

const IMITATION_PATTERN = /android|копі[яї]|копия|імітац|имитац|реплік|реплик|муляж|підробк|подделк|аналог\s+під\s+виглядом|аналог\s+под\s+видом/i;
const BLOCKED_DEVICE_PATTERN = /icloud\s*[- ]?lock|icloud\s*заблок|\blocked\b|\bзаблокован\w*|\bзаблокирова\w*|на\s+запчасти|на\s+запчастин/i;

function normalizeWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-яіїєґ0-9+]+/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .reduce((words, word, index, all) => {
      if (/^v$/i.test(word) && /^\d+$/.test(all[index + 1] || "")) {
        words.push("v" + all[index + 1]);
        all[index + 1] = "";
      } else if (word) {
        words.push(word);
      }
      return words;
    }, []);
}

function classifyProduct(product, query) {
  const queryWords = normalizeWords(query);
  const title = String(product?.title || "");
  const titleWords = normalizeWords(title);
  const titleText = titleWords.join(" ");
  const description = String(product?.description || "");
  const combinedText = titleText + " " + normalizeWords(description).join(" ");

  if (!queryWords.length || !titleWords.length) {
    return { status: "uncertain", reason: "Не удалось разобрать запрос или название товара" };
  }

  if (IMITATION_PATTERN.test(combinedText)) {
    return { status: "reject", reason: "В названии или описании есть признаки копии, имитации или подделки" };
  }

  if (BLOCKED_DEVICE_PATTERN.test(title + " " + description)) {
    return { status: "reject", reason: "Устройство заблокировано или продаётся на запчасти" };
  }

  // Accessory terms in a phone's description (for example, a replaced battery)
  // must not disqualify the phone. Detect accessory listings from the title itself.
  const accessoryPattern = ACCESSORY_TITLE_PATTERNS.find(pattern => pattern.test(title.trim()));
  if (accessoryPattern) {
    return { status: "reject", reason: "Это аксессуар или отдельная запчасть, а не искомое устройство" };
  }

  const querySet = new Set(queryWords);
  const missing = [...new Set(queryWords)].filter(word => !titleWords.includes(word));
  if (missing.length) {
    return {
      status: "uncertain",
      reason: "В названии не найдены все слова запроса: " + missing.join(", ")
    };
  }

  // Compare model editions immediately after the exact requested model phrase.
  // Thus iPhone 15 excludes Pro/Pro Max, and iPhone 15 Pro excludes Pro Max.
  const titlePhrase = titleWords.join(" ");
  const queryPhrase = queryWords.join(" ");
  const phraseIndex = titlePhrase.indexOf(queryPhrase);
  if (phraseIndex >= 0) {
    const afterPhrase = titlePhrase.slice(phraseIndex + queryPhrase.length).trim().split(/\s+/).filter(Boolean);
    const marker = afterPhrase.find(word => VARIANT_MARKERS.has(word) && !querySet.has(word));
    if (marker) {
      return { status: "reject", reason: "Обнаружена другая версия модели: " + marker };
    }
  }

  return { status: "match", reason: "Название соответствует запросу; признаков аксессуара, блокировки или другой версии не найдено" };
}

module.exports = { normalizeWords, classifyProduct };
