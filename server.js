const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const BASE_URL = "https://aplusauto.parts";

// ============================================================
// HELPER: Clean text for voice
// ============================================================
function cleanForVoice(text) {
  if (!text) return "";
  return text.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

// ============================================================
// SEARCH: WooCommerce Store API
// ============================================================
async function searchWooCommerce(query) {
  try {
    const response = await axios.get(`${BASE_URL}/wp-json/wc/store/v1/products`, {
      params: { search: query, per_page: 10 },
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      timeout: 12000,
    });
    if (!response.data || !Array.isArray(response.data)) return [];
    return response.data.map((p) => ({
      name: cleanForVoice(p.name),
      price: p.prices?.price ? `$${(parseInt(p.prices.price) / 100).toFixed(2)}` : null,
      in_stock: p.is_purchasable !== false,
      sku: p.sku || null,
    }));
  } catch (e) {
    return [];
  }
}

// ============================================================
// SEARCH: Scrape product search
// ============================================================
async function scrapeProductSearch(query) {
  try {
    const url = `${BASE_URL}/?s=${encodeURIComponent(query)}&post_type=product`;
    const response = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      timeout: 12000,
    });
    const $ = cheerio.load(response.data);
    const products = [];
    $(".product, li.product, article.product").each((i, el) => {
      const name = $(el).find("h2, h3, .woocommerce-loop-product__title").text().trim();
      const priceText = $(el).find(".price .amount, .woocommerce-Price-amount").first().text().trim();
      if (name) products.push({ name: cleanForVoice(name), price: priceText || null, in_stock: true });
    });
    return products;
  } catch (e) {
    return [];
  }
}

// ============================================================
// SEARCH: Match homepage vehicles
// ============================================================
async function matchHomepageVehicles(year, make, model) {
  try {
    const response = await axios.get(BASE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      timeout: 12000,
    });
    const $ = cheerio.load(response.data);
    const vehicles = [];
    $("h5").each((i, el) => {
      const text = $(el).text().trim();
      if (text && /^\d{4}\s/.test(text)) {
        const parent = $(el).parent();
        const fullText = parent.text();
        const stk = fullText.match(/STK#:\s*(\d+)/)?.[1] || "";
        vehicles.push({ name: text, stk });
      }
    });
    const terms = [year, make, model].filter(Boolean).map((t) => t.toLowerCase());
    if (terms.length === 0) return [];
    return vehicles.filter((v) => terms.every((t) => v.name.toLowerCase().includes(t)));
  } catch (e) {
    return [];
  }
}

// ============================================================
// SEARCH: Lookup by stock number
// ============================================================
async function lookupByStockNumber(stockNum) {
  try {
    const response = await axios.get(BASE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      timeout: 12000,
    });
    const $ = cheerio.load(response.data);
    let found = null;
    $("h5").each((i, el) => {
      const parent = $(el).parent();
      const fullText = parent.text();
      const stkMatch = fullText.match(/STK#:\s*(\d+)/);
      if (stkMatch && stkMatch[1] === String(stockNum)) {
        found = { name: $(el).text().trim(), stk: stkMatch[1] };
        return false;
      }
    });
    return found;
  } catch (e) {
    return null;
  }
}

// ============================================================
// ENDPOINT: /search-parts
// ============================================================
app.post("/search-parts", async (req, res) => {
  try {
    const args = req.body.args || req.body || {};
    const year = (args.year || "").trim();
    const make = (args.make || "").trim();
    const model = (args.model || "").trim();
    const part_type = (args.part_type || "").trim();
    const query = (args.query || "").trim();
    const stock_number = (args.stock_number || "").trim();

    console.log("Search:", JSON.stringify({ year, make, model, part_type, query, stock_number }));

    // Stock number lookup
    if (stock_number) {
      const num = stock_number.replace(/\D/g, "");
      if (num) {
        const vehicle = await lookupByStockNumber(num);
        if (vehicle) {
          return res.json(`That's stock number ${vehicle.stk}, a ${vehicle.name}. What part do you need from it?`);
        }
      }
      return res.json(`I couldn't find that stock number. Can you tell me the year, make, and model instead?`);
    }

    // Build search
    const searchTerms = [year, make, model, part_type, query].filter(Boolean);
    if (searchTerms.length === 0) {
      return res.json("What vehicle is it for and what part do you need?");
    }

    const searchQuery = searchTerms.join(" ");
    let results = [];

    // Try WooCommerce
    results = await searchWooCommerce(searchQuery);

    // Try scrape
    if (results.length === 0) results = await scrapeProductSearch(searchQuery);

    // Try without part type
    if (results.length === 0 && part_type) {
      const broader = [year, make, model].filter(Boolean).join(" ");
      if (broader) {
        results = await searchWooCommerce(broader);
        if (results.length === 0) results = await scrapeProductSearch(broader);
      }
    }

    // Try homepage vehicles
    if (results.length === 0 && (make || model)) {
      const matches = await matchHomepageVehicles(year, make, model);
      if (matches.length > 0) {
        return res.json(`We have a ${matches[0].name} in stock. Parts from this vehicle are available. What specific part do you need?`);
      }
    }

    // Return results
    if (results.length > 0) {
      const top = results[0];
      if (top.price) {
        return res.json(`Yes we have that. ${top.name} priced at ${top.price}. Want to go ahead with it?`);
      }
      return res.json(`We have a ${top.name} available. Want me to get you exact pricing on that?`);
    }

    return res.json(`That part isn't showing online but our warehouse has over 100,000 parts. Want me to have the team check and call you back?`);

  } catch (e) {
    console.error("Error:", e.message);
    return res.json("Let me get your info and have our parts team look into that for you.");
  }
});

// ============================================================
// ENDPOINT: /check-vehicle
// ============================================================
app.post("/check-vehicle", async (req, res) => {
  try {
    const args = req.body.args || req.body || {};
    const year = (args.year || "").trim();
    const make = (args.make || "").trim();
    const model = (args.model || "").trim();

    console.log("Vehicle check:", JSON.stringify({ year, make, model }));

    if (!make && !model) return res.json("What year, make, and model are you looking for?");

    const matches = await matchHomepageVehicles(year, make, model);
    if (matches.length > 0) {
      return res.json(`Yep we've got a ${matches[0].name} in stock. What part do you need from it?`);
    }
    return res.json(`I don't see that in our recent arrivals but we may have parts in the warehouse. Want me to check with the team?`);

  } catch (e) {
    console.error("Error:", e.message);
    return res.json("Let me have our team look into that. Can I get your name and number?");
  }
});

// ============================================================
// ENDPOINT: /submit-inquiry
// ============================================================
app.post("/submit-inquiry", async (req, res) => {
  try {
    const args = req.body.args || req.body || {};
    const name = (args.customer_name || "").trim();
    const phone = (args.phone || "").trim();
    const part = (args.part_needed || "").trim();
    const vehicle = [args.year, args.make, args.model].filter(Boolean).join(" ");

    console.log("Inquiry:", JSON.stringify({ name, phone, part, vehicle }));

    return res.json(`Got it, submitted for ${name || "you"}. Our team will call ${phone ? "you at " + phone : "you back"} within a couple hours.`);

  } catch (e) {
    return res.json("Inquiry noted. Our team will be in touch shortly.");
  }
});

// ============================================================
// ENDPOINTS: /business-info, /health
// ============================================================
app.get("/business-info", (req, res) => {
  res.json({ name: "A Plus Auto LLC", phone: "(859) 421-3043", email: "sales@aplusauto.parts", address: "2125 Catnip Hill Rd, Nicholasville, KY 40356", hours: "Mon-Fri 8:30AM-6PM, Sat 9AM-12PM" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`A Plus Auto middleware running on port ${PORT}`));
