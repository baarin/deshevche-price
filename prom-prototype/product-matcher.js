const ACCESSORY_TITLE_PATTERNS = [
  // The product type must appear before the requested model in the title.
  // This catches listings such as "Apple EarPods ... for iPhone 15" and
  // "Pitaka case for iPhone 15 Plus", without rejecting a phone whose
  // description/title mentions a replaced battery after the model name.
  /\b(?:чехол|чохол|кейс|case|cover|накладка|захисне\s+скло|защитное\s+стекло|стекло|скло|пленка|плівка|screen\s+protector|protector)\b/i,
  /\b(?:зарядка|зарядний\s+пристрій|зарядное\s+устройство|charger|charging\s+adapter|адаптер\s+питания|кабель|cable|шнур)\b/i,
  /\b(?:наушники|навушники|earpods|earbuds|headphones|headset|гарнитура|гарнітура|амбушюры|амбушури)\b/i,
  /\b(?:аккумулятор|батарея|battery|дисплей|экран|display|screen|шлейф|запчасть|запчастина|деталь|ремешок|ремінець|strap|держатель|тримач|подставка|підставка)\b/i
];

const VARIANT_MARKERS = new Set([
  "turbo", "plus", "max", "mini", "lite", "ultra", "neo", "se",
  "pro", "promax", "mk2", "mk3", "2024", "2025", "2026"
]);

const IMITATION_PATTERN = /android|копі[яї]|копия|імітац|имитац|реплік|реплик|муляж|підробк|подделк|аналог\s+під\s+виглядом|аналог\s+под\s+видом/i;
const BLOCKED_DEVICE_PATTERN = /icloud\s*[- ]?lock|icloud\s*заблок|\blocked\b|\bзаблокован\w*|\bзаблокирова\w*|на\s+запчасти|на\s+запчастин/i;
// These phrases are warning signs, not proof of a counterfeit. Keep such offers
// out of confirmed matches but preserve them for manual review.
const LOW_CONFIDENCE_LISTING_PATTERN = /высокое\s+качество|хорошее\s+качество|отличное\s+качество|висока\s+якість|хороша\s+якість|відмінна\s+якість|уточняйте\s+наличие|уточнюйте\s+наявність/i;

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

  if (LOW_CONFIDENCE_LISTING_PATTERN.test(title + " " + description)) {
    return { status: "uncertain", reason: "В объявлении есть предупреждающие формулировки о качестве или необходимости уточнить наличие" };
  }

  // Only treat a title as an accessory when its product-type marker occurs
  // before the requested model phrase. A battery/charger mention after the
  // phone model can describe the phone's condition or an included extra.
  const titlePhraseForAccessory = titleWords.join(" ");
  const queryPhraseForAccessory = queryWords.join(" ");
  const modelPosition = titlePhraseForAccessory.indexOf(queryPhraseForAccessory);
  const accessoryBeforeModel = modelPosition >= 0 && ACCESSORY_TITLE_PATTERNS.some(pattern => {
    const match = pattern.exec(titlePhraseForAccessory);
    return match && match.index < modelPosition;
  });
  if (accessoryBeforeModel) {
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

  return { status: "match", reason: "Название соответствует запросу; явных признаков аксессуара, блокировки или другой версии не найдено" };
}

module.exports = { normalizeWords, classifyProduct };
