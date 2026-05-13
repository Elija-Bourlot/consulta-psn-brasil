import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

const REGION = "br";
const LANGUAGE = "pt";
const STORE_ID = "999";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();

    if (!query) {
      return res.status(400).json({
        ok: false,
        error: "Digite o nome do jogo."
      });
    }

    const searchTerms = createSearchVariations(query);
    let allGames = [];

    for (const term of searchTerms) {
      try {
        const data = await searchPlayStationStore(term);
        const games = normalizeResults(data, query);
        allGames.push(...games);
      } catch (error) {
        console.log(`Falha buscando "${term}":`, error.message);
      }
    }

    allGames = removeDuplicates(allGames);

    allGames = allGames
      .map(game => ({
        ...game,
        matchScore: calculateMatchScore(query, game.name)
      }))
      .filter(game => game.matchScore >= 25)
      .sort((a, b) => b.matchScore - a.matchScore);

    return res.json({
      ok: true,
      query,
      total: allGames.length,
      games: allGames
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: "Erro interno ao consultar a PS Store."
    });
  }
});

async function searchPlayStationStore(query) {
  const url =
    `https://store.playstation.com/store/api/chihiro/00_09_000/tumbler/${REGION}/${LANGUAGE}/${STORE_ID}/${encodeURIComponent(query)}?suggested_size=80&mode=game`;

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Erro ao consultar a PS Store. Código: ${response.status}`);
  }

  return await response.json();
}

function createSearchVariations(query) {
  const original = String(query || "").trim();
  const clean = normalizeText(original);
  const words = clean.split(" ").filter(Boolean);

  const variations = [
    original,
    clean,
    original.replace(/[’']/g, ""),
    original.replace(/[’']/g, " "),
    words.join(" ")
  ];

  if (words.length >= 2) {
    variations.push(words.slice(0, 2).join(" "));
  }

  if (words.length >= 3) {
    variations.push(words.slice(0, 3).join(" "));
  }

  return [...new Set(variations.filter(Boolean))];
}

function normalizeResults(data, originalQuery) {
  let items = [];

  if (Array.isArray(data.links)) {
    items = data.links;
  } else if (Array.isArray(data.included)) {
    items = data.included;
  } else if (Array.isArray(data.products)) {
    items = data.products;
  } else if (Array.isArray(data.data)) {
    items = data.data;
  } else {
    items = findProductArrays(data);
  }

  return items
    .map(extractGame)
    .filter(Boolean)
    .filter(game => calculateMatchScore(originalQuery, game.name) >= 25);
}

function findProductArrays(obj) {
  const found = [];

  function walk(value) {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      const looksLikeProduct = value.some(item =>
        item &&
        typeof item === "object" &&
        (
          item.name ||
          item.title_name ||
          item.title ||
          item.productName ||
          item.localizedName ||
          item.playable_platform ||
          item.platforms ||
          item.skus ||
          item.default_sku
        )
      );

      if (looksLikeProduct) {
        found.push(...value);
      } else {
        value.forEach(walk);
      }

      return;
    }

    Object.values(value).forEach(walk);
  }

  walk(obj);
  return found;
}

function extractGame(item) {
  const name =
    item.name ||
    item.title_name ||
    item.title ||
    item.productName ||
    item.localizedName ||
    "";

  if (!name) return null;

  const platforms = extractPlatforms(item, name);
  const price = extractPrice(item);
  const image = extractImage(item);
  const storeUrl = createSafeStoreUrl(name);

  return {
    id: item.id || item.conceptId || item.product_id || item.skuId || name,
    name,
    platforms,
    platformType: classifyPlatform(platforms),
    currentPrice: price.current,
    originalPrice: price.original,
    discount: price.discount,
    onSale: price.onSale,
    image,
    storeUrl
  };
}

function extractPlatforms(item, title = "") {
  const platforms = [];

  function addPlatform(value) {
    if (!value) return;

    const text = String(value)
      .toUpperCase()
      .replace("PLAYSTATION®", "PLAYSTATION ")
      .replace(/\s+/g, " ")
      .trim();

    if (
      text === "PS4" ||
      text === "PLAYSTATION 4" ||
      text === "PLAYSTATION4"
    ) {
      platforms.push("PS4");
    }

    if (
      text === "PS5" ||
      text === "PLAYSTATION 5" ||
      text === "PLAYSTATION5"
    ) {
      platforms.push("PS5");
    }
  }

  function readArray(values) {
    if (!Array.isArray(values)) return;
    values.forEach(addPlatform);
  }

  readArray(item.playable_platform);
  readArray(item.platforms);
  readArray(item.platform);
  readArray(item.platform_types);
  readArray(item.console_platforms);

  addPlatform(item.platform);
  addPlatform(item.playable_platform);
  addPlatform(item.platformType);
  addPlatform(item.consolePlatform);

  if (item.default_sku) {
    readArray(item.default_sku.playable_platform);
    readArray(item.default_sku.platforms);
    readArray(item.default_sku.platform_types);
    readArray(item.default_sku.console_platforms);

    addPlatform(item.default_sku.platform);
    addPlatform(item.default_sku.platformType);
    addPlatform(item.default_sku.consolePlatform);
  }

  if (Array.isArray(item.skus)) {
    item.skus.forEach(sku => {
      readArray(sku.playable_platform);
      readArray(sku.platforms);
      readArray(sku.platform_types);
      readArray(sku.console_platforms);

      addPlatform(sku.platform);
      addPlatform(sku.platformType);
      addPlatform(sku.consolePlatform);
    });
  }

  addPlatformsFromTitle(title, platforms);

  return [...new Set(platforms)];
}

function addPlatformsFromTitle(title, platforms) {
  const text = String(title || "").toUpperCase();

  const mentionsPS4 =
    /\bPS4\b/.test(text) ||
    /PLAYSTATION\s*4/.test(text);

  const mentionsPS5 =
    /\bPS5\b/.test(text) ||
    /PLAYSTATION\s*5/.test(text);

  if (mentionsPS4) platforms.push("PS4");
  if (mentionsPS5) platforms.push("PS5");
}

function classifyPlatform(platforms) {
  const hasPS4 = platforms.includes("PS4");
  const hasPS5 = platforms.includes("PS5");

  if (hasPS4 && hasPS5) return "PS4 + PS5";
  if (hasPS4) return "Somente PS4";
  if (hasPS5) return "Somente PS5";

  return "Não identificado";
}

function extractPrice(item) {
  let current = "";
  let original = "";
  let discount = "";

  const candidates = [];

  if (item.default_sku) candidates.push(item.default_sku);
  if (Array.isArray(item.skus)) candidates.push(...item.skus);
  if (item.price) candidates.push(item.price);
  if (item.priceInfo) candidates.push(item.priceInfo);
  if (item.price_info) candidates.push(item.price_info);

  candidates.push(item);

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;

    current =
      current ||
      candidate.display_price ||
      candidate.displayPrice ||
      candidate.current_price ||
      candidate.currentPrice ||
      candidate.discounted_price ||
      candidate.discountedPrice ||
      candidate.formattedPrice ||
      candidate.formatted_price ||
      candidate.actual_price ||
      candidate.actualPrice ||
      "";

    original =
      original ||
      candidate.display_original_price ||
      candidate.displayOriginalPrice ||
      candidate.original_price ||
      candidate.originalPrice ||
      candidate.strikethrough_price ||
      candidate.strikethroughPrice ||
      candidate.list_price ||
      candidate.listPrice ||
      candidate.base_price ||
      candidate.basePrice ||
      "";

    discount =
      discount ||
      candidate.discount_text ||
      candidate.discountText ||
      candidate.discount ||
      candidate.discount_percent ||
      candidate.discountPercent ||
      "";
  }

  const allPrices = findAllBrazilianPrices(item);

  if (!current && allPrices.length) {
    current = allPrices[0];
  }

  if (!original && allPrices.length > 1) {
    original = allPrices.find(price => price !== current) || "";
  }

  const fullText = JSON.stringify(item).toLowerCase();

  const onSale =
    Boolean(discount) ||
    Boolean(original && current && original !== current) ||
    fullText.includes("discount") ||
    fullText.includes("sale") ||
    fullText.includes("promo") ||
    fullText.includes("promoção") ||
    fullText.includes("desconto");

  return {
    current: current || "Preço não encontrado na busca",
    original,
    discount,
    onSale
  };
}

function findAllBrazilianPrices(obj) {
  const prices = [];

  function walk(value) {
    if (value === null || value === undefined) return;

    if (typeof value === "string") {
      const matches = value.match(/R\$\s?[\d.]+,\d{2}/g);

      if (matches) {
        matches.forEach(price => prices.push(price));
      }

      return;
    }

    if (typeof value === "object") {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else {
        Object.values(value).forEach(walk);
      }
    }
  }

  walk(obj);

  return [...new Set(prices)];
}

function extractImage(item) {
  const images = [];

  if (Array.isArray(item.images)) images.push(...item.images);
  if (Array.isArray(item.media)) images.push(...item.media);

  if (item.image_url) images.push({ url: item.image_url });
  if (item.thumbnail_url) images.push({ url: item.thumbnail_url });
  if (item.cover) images.push({ url: item.cover });

  const image = images.find(img =>
    img &&
    (
      img.url ||
      img.src ||
      img.image_url
    )
  );

  return image ? image.url || image.src || image.image_url : "";
}

function createSafeStoreUrl(name) {
  return `https://store.playstation.com/pt-br/search/${encodeURIComponent(name)}`;
}

function removeDuplicates(games) {
  const map = new Map();

  games.forEach(game => {
    const key = normalizeText(game.name);

    if (!map.has(key)) {
      map.set(key, game);
    } else {
      const existing = map.get(key);

      const existingPlatforms = new Set(existing.platforms);
      game.platforms.forEach(p => existingPlatforms.add(p));

      existing.platforms = [...existingPlatforms];
      existing.platformType = classifyPlatform(existing.platforms);

      if (
        existing.currentPrice === "Preço não encontrado na busca" &&
        game.currentPrice !== "Preço não encontrado na busca"
      ) {
        existing.currentPrice = game.currentPrice;
      }

      if (!existing.originalPrice && game.originalPrice) {
        existing.originalPrice = game.originalPrice;
      }

      if (!existing.discount && game.discount) {
        existing.discount = game.discount;
      }

      existing.onSale = existing.onSale || game.onSale;

      if (!existing.image && game.image) {
        existing.image = game.image;
      }
    }
  });

  return [...map.values()];
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/[™®:()\-–—.,!?"&+/\\|[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function calculateMatchScore(query, title) {
  const q = normalizeText(query);
  const t = normalizeText(title);

  if (!q || !t) return 0;

  if (q === t) return 100;
  if (t.startsWith(q)) return 90;
  if (t.includes(q)) return 80;

  const qWords = q.split(" ").filter(word => word.length > 1);
  const tWords = t.split(" ").filter(word => word.length > 1);

  if (!qWords.length || !tWords.length) return 0;

  let matches = 0;

  for (const qWord of qWords) {
    if (tWords.some(tWord => tWord === qWord || tWord.includes(qWord) || qWord.includes(tWord))) {
      matches++;
    }
  }

  const wordScore = Math.round((matches / qWords.length) * 70);
  const distanceScore = Math.max(0, 30 - levenshteinDistance(q, t));

  return Math.min(100, wordScore + distanceScore);
}

function levenshteinDistance(a, b) {
  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
