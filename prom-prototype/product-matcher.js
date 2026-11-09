const ACCESSORY_TERMS = new Set([
  "case", "cover", "чехол", "чохол", "кейс", "накладка",
  "charger", "charging", "зарядка", "зарядний", "адаптер",
  "cable", "кабель", "шнур", "провод",
  "screen", "скло", "стекло", "пленка", "плівка", "защитное", "захисне",
  "battery", "аккумулятор", "батарея",
  "replacement", "запчасть", "запчастина", "деталь", "шлейф",
  "ремешок", "ремінець", "strap", "earpads", "амбушюры", "амбушури",
  "насадки", "держатель", "тримач", "подставка", "підставка",
  "чехлы", "чохли", "защита", "захист", "стекла", "плівки", "protector", "захисне"
]);

const VARIANT_MARKERS = new Set([
  "turbo", "plus", "max", "mini", "lite", "ultra", "neo", "se",
  "pro", "promax", "mk2", "mk3", "2024", "2025", "2026"
]);

const IMITATION_PATTERN = /android|копі[яї]|копия|імітац|имитац|реплік|реплик|муляж|підробк|подделк|аналог\s+під\s+виглядом|аналог\s+под\s+видом/i;

function normalizeWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-яіїєґ0-9+]+/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .reduce((words, word, index, all) => {
      // Product listings often write model codes as "V 9" instead of "V9".
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
  const titleWords = normalizeWords(product?.title);
  const titleText = titleWords.join(" ");
  const description = String(product?.description || "");
  const combinedText = titleText + " " + normalizeWords(description).join(" ");

  if (!queryWords.length || !titleWords.length) {
    return { status: "uncertain", reason: "Не удалось разобрать запрос или название товара" };
  }

  if (IMITATION_PATTERN.test(combinedText)) {
    return { status: "reject", reason: "В названии или описании есть признаки копии, имитации или подделки" };
  }

  const querySet = new Set(queryWords);
  const missing = [...new Set(queryWords)].filter(word => !titleWords.includes(word));
  if (missing.length) {
    return {
      status: "uncertain",
      reason: "В названии не найдены все слова запроса: " + missing.join(", ")
    };
  }

  const accessoryWords = [...new Set(titleWords.filter(word => ACCESSORY_TERMS.has(word) && !querySet.has(word)))];
  if (accessoryWords.length) {
    return {
      status: "uncertain",
      reason: "В названии есть слова, характерные для аксессуаров или запчастей: " + accessoryWords.join(", ")
    };
  }

  // Detect a different named edition immediately after the complete requested model.
  // Markers already present in the query are ignored (e.g. repeated "V9" in a listing).
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

  return { status: "match", reason: "Все слова запроса присутствуют; явных признаков другой модели не найдено" };
}

module.exports = { normalizeWords, classifyProduct };
