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

    const url =
      `https://store.playstation.com/store/api/chihiro/00_09_000/tumbler/${REGION}/${LANGUAGE}/${STORE_ID}/${encodeURIComponent(query)}?suggested_size=30&mode=game`;

    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: `Erro ao consultar a PS Store. Código: ${response.status}`
      });
    }

    const data = await response.json();
    const games = normalizeResults(data, query);

    return res.json({
      ok: true,
      query,
      total: games.length,
      games
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: "Erro interno ao consultar a PS Store."
    });
  }
});

function normalizeResults(data, query) {
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

  const cleanQuery = normalizeText(query);

  const games = items
    .map(extractGame)
    .filter(Boolean)
    .filter(game => {
      const title = normalizeText(game.name);
      return title.includes(cleanQuery) || cleanQuery.includes(title);
    });

  return removeDuplicates(games).sort((a, b) => {
    const aExact = normalizeText(a.name) === cleanQuery ? 0 : 1;
    const bExact = normalizeText(b.name) === cleanQuery ? 0 : 1;
    return aExact - bExact;
  });
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
          item.localizedStoreDisplayClassification ||
          item.playable_platform ||
          item.platforms ||
          item.skus
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

  const platforms = extractPlatforms(item);
  const price = extractPrice(item);
  const image = extractImage(item);
  const storeUrl = extractStoreUrl(item, name);

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

function extractPlatforms(item) {
  const platforms = [];

  if (Array.isArray(item.playable_platform)) platforms.push(...item.playable_platform);
  if (Array.isArray(item.platforms)) platforms.push(...item.platforms);
  if (Array.isArray(item.platform)) platforms.push(...item.platform);

  if (typeof item.platform === "string") platforms.push(item.platform);
  if (typeof item.playable_platform === "string") platforms.push(item.playable_platform);

  if (item.default_sku && Array.isArray(item.default_sku.playable_platform)) {
    platforms.push(...item.default_sku.playable_platform);
  }

  if (Array.isArray(item.skus)) {
    item.skus.forEach(sku => {
      if (Array.isArray(sku.playable_platform)) platforms.push(...sku.playable_platform);
      if (typeof sku.platform === "string") platforms.push(sku.platform);
    });
  }

  const fullText = JSON.stringify(item).toUpperCase();

  if (fullText.includes("PS4")) platforms.push("PS4");
  if (fullText.includes("PS5")) platforms.push("PS5");

  return [...new Set(
    platforms
      .map(p => String(p).toUpperCase())
      .filter(p => p.includes("PS4") || p.includes("PS5"))
      .map(p => p.includes("PS5") ? "PS5" : "PS4")
  )];
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

  candidates.push(item);

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;

    current =
      current ||
      candidate.display_price ||
      candidate.price ||
      candidate.current_price ||
      candidate.discounted_price ||
      candidate.formattedPrice ||
      "";

    original =
      original ||
      candidate.display_original_price ||
      candidate.original_price ||
      candidate.strikethrough_price ||
      candidate.list_price ||
      "";

    discount =
      discount ||
      candidate.discount_text ||
      candidate.discount ||
      candidate.discount_percent ||
      "";
  }

  const fullText = JSON.stringify(item);

  if (!current) {
    const priceMatch = fullText.match(/R\$\s?[\d.,]+/);
    if (priceMatch) current = priceMatch[0];
  }

  const onSale =
    Boolean(discount) ||
    Boolean(original && current && original !== current) ||
    fullText.toLowerCase().includes("discount") ||
    fullText.toLowerCase().includes("sale") ||
    fullText.toLowerCase().includes("promo");

  return {
    current: current || "Preço não encontrado",
    original,
    discount,
    onSale
  };
}

function extractImage(item) {
  const images = [];

  if (Array.isArray(item.images)) images.push(...item.images);
  if (Array.isArray(item.media)) images.push(...item.media);
  if (item.image_url) images.push({ url: item.image_url });
  if (item.thumbnail_url) images.push({ url: item.thumbnail_url });

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

function extractStoreUrl(item, name) {
  if (item.url) {
    if (String(item.url).startsWith("http")) return item.url;
    return "https://store.playstation.com/pt-br" + item.url;
  }

  return `https://store.playstation.com/pt-br/search/${encodeURIComponent(name)}`;
}

function removeDuplicates(games) {
  const map = new Map();

  games.forEach(game => {
    const key = normalizeText(game.name) + "|" + game.platformType;

    if (!map.has(key)) {
      map.set(key, game);
    }
  });

  return [...map.values()];
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[™®:()\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
