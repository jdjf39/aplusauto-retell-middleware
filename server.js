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
// HELPER: Safe string - never return null/undefined to voice
// ============================================================
function safe(val) {
  if (!val || val === "undefined" || val === "null") return "";
  return String(val).trim();
}

// ============================================================
// SEARCH STRATEGY 1: Google site search (most reliable for 100k+ parts)
// Uses site:aplusauto.parts/parts/ to find actual part pages
// ============================================================
async function searchViaSiteScrape(query) {
  try {
    // Search their WordPress site directly
    const url = `${BASE_URL}/?s=${encodeURIComponent(query)}&post_type=product`;
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
      timeout: 15000,
    });
    const $ = cheerio.load(response.data);
    const products = [];
    $(".product, li.product, article.product").each((i, el) => {
      const name = cleanForVoice($(el).find("h2, h3, .woocommerce-loop-product__title").text());
      const priceText = $(el).find(".price .amount, .woocommerce-Price-amount").first().text().trim();
      const link = $(el).find("a").first().attr("href") || "";
      if (name) {
        products.push({ name, price: priceText || null, url: link, in_stock: true });
      }
    });
    return products;
  } catch (e) {
    console.log("Site scrape error:", e.message);
    return [];
  }
}

// ============================================================
// SEARCH STRATEGY 2: WooCommerce Store API
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
    console.log("WooCommerce error:", e.message);
    return [];
  }
}

// ============================================================
// SEARCH STRATEGY 3: Direct URL pattern for IIS Pro parts pages
// URL format: /parts/MAKE/MODEL/STOCK/YEAR/PART_TYPE/PART_ID
// ============================================================
async function searchPartsPages(make, model, year, partType) {
  try {
    // Build the URL path the way the site structures it
    const makePath = safe(make).toUpperCase().replace(/\s+/g, "_");
    const modelPath = safe(model).toUpperCase().replace(/\s+/g, "_");
    
    if (!makePath) return [];

    // Try the make/model listing page
    let searchUrl = `${BASE_URL}/parts/${makePath}/`;
    if (modelPath) {
      // The site uses encoded model names - try common patterns
      searchUrl = `${BASE_URL}/parts/${makePath}/${modelPath}/`;
    }

    console.log("Trying parts URL:", searchUrl);
    
    const response = await axios.get(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      timeout: 15000,
      maxRedirects: 5,
    });

    const $ = cheerio.load(response.data);
    const parts = [];

    // Look for part listings on the page - they show price, part type, stock, etc.
    // Based on the screenshot: price in red, Part Type, Part Numbers, Stock, etc.
    $(".iis-part, .part-item, tr, .product-item, article").each((i, el) => {
      const text = $(el).text();
      const priceMatch = text.match(/\$[\d,]+\.?\d*/);
      const partTypeMatch = text.match(/Part Type:\s*([^\n]+)/);
      const partNumMatch = text.match(/Part Numbers?:\s*([^\n]+)/);
      const stockMatch = text.match(/Stock:\s*(\d+)/);
      const detailsMatch = text.match(/Details:\s*([^\n]+)/);

      if (priceMatch || partTypeMatch) {
        parts.push({
          name: cleanForVoice(partTypeMatch ? partTypeMatch[1] : ""),
          price: priceMatch ? priceMatch[0] : null,
          part_number: partNumMatch ? partNumMatch[1].trim() : null,
          stock: stockMatch ? stockMatch[1] : null,
          details: detailsMatch ? cleanForVoice(detailsMatch[1]).substring(0, 100) : null,
        });
      }
    });

    return parts;
  } catch (e) {
    console.log("Parts page error:", e.message);
    return [];
  }
}

// ============================================================
// SEARCH STRATEGY 4: Search by part number
// Searches the site for a specific OEM/manufacturer part number
// ============================================================
async function searchByPartNumber(partNumber) {
  try {
    const cleanNum = safe(partNumber).replace(/[^a-zA-Z0-9]/g, "");
    if (!cleanNum) return null;

    console.log("Searching part number:", cleanNum);

    // Try WordPress search with the part number
    const url = `${BASE_URL}/?s=${encodeURIComponent(cleanNum)}`;
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    
    // Check for part listings
    const parts = [];
    $(".product, li.product, article.product, article").each((i, el) => {
      const name = cleanForVoice($(el).find("h2, h3, .woocommerce-loop-product__title, .entry-title").text());
      const priceText = $(el).find(".price .amount, .woocommerce-Price-amount").first().text().trim();
      const link = $(el).find("a").first().attr("href") || "";
      if (name && name.length > 3) {
        parts.push({ name, price: priceText || null, url: link });
      }
    });

    // Also check the full page text for the part number
    const pageText = $("body").text();
    if (pageText.includes(cleanNum) || pageText.toLowerCase().includes(cleanNum.toLowerCase())) {
      // Part number exists on the site
      const priceMatch = pageText.match(new RegExp(cleanNum + "[\\s\\S]{0,200}?\\$(\\d[\\d,]*\\.?\\d*)", "i"));
      if (priceMatch && parts.length === 0) {
        parts.push({
          name: `Part #${partNumber}`,
          price: `$${priceMatch[1]}`,
        });
      }
    }

    // If WP search didn't work, try WooCommerce API
    if (parts.length === 0) {
      const wooResults = await searchWooCommerce(cleanNum);
      if (wooResults.length > 0) return wooResults[0];
    }

    return parts.length > 0 ? parts[0] : null;
  } catch (e) {
    console.log("Part number search error:", e.message);
    return null;
  }
}

// ============================================================
// SEARCH STRATEGY 5: Match homepage vehicles
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
// ENDPOINT: /search-parts (MAIN SEARCH)
// ============================================================
app.post("/search-parts", async (req, res) => {
  try {
    const args = req.body.args || req.body || {};
    const year = safe(args.year);
    const make = safe(args.make);
    const model = safe(args.model);
    const part_type = safe(args.part_type);
    const query = safe(args.query);
    const part_number = safe(args.part_number);

    console.log("=== SEARCH REQUEST ===");
    console.log(JSON.stringify({ year, make, model, part_type, query, part_number }));

    // -------------------------------------------
    // PART NUMBER SEARCH
    // -------------------------------------------
    if (part_number) {
      const result = await searchByPartNumber(part_number);
      if (result) {
        if (result.price) {
          return res.json(`Found it. Part number ${part_number}: ${result.name}, priced at ${result.price}. Want to go ahead with that?`);
        }
        return res.json(`Found part number ${part_number}: ${result.name}. Let me get exact pricing — can I grab your number so our team can follow up?`);
      }
      return res.json(`I'm not finding part number ${part_number} in our system. Could you double check that number, or tell me the year, make, model and what part you need?`);
    }

    // -------------------------------------------
    // BUILD SEARCH TERMS
    // -------------------------------------------
    const searchTerms = [year, make, model, part_type, query].filter(Boolean);
    if (searchTerms.length === 0) {
      return res.json("What vehicle is it for and what part do you need?");
    }

    const fullQuery = searchTerms.join(" ");
    console.log("Full search query:", fullQuery);

    let results = [];

    // -------------------------------------------
    // TRY MULTIPLE SEARCH STRATEGIES
    // -------------------------------------------

    // Strategy 1: WooCommerce API (fast, has pricing)
    results = await searchWooCommerce(fullQuery);
    if (results.length > 0) {
      console.log(`WooCommerce found ${results.length} results`);
    }

    // Strategy 2: Site scrape search
    if (results.length === 0) {
      results = await searchViaSiteScrape(fullQuery);
      if (results.length > 0) console.log(`Site scrape found ${results.length} results`);
    }

    // Strategy 3: Try direct parts page URL
    if (results.length === 0 && make) {
      const partsResults = await searchPartsPages(make, model, year, part_type);
      if (partsResults.length > 0) {
        console.log(`Parts page found ${partsResults.length} results`);
        // Filter by part type if specified
        if (part_type) {
          const filtered = partsResults.filter((p) =>
            p.name.toLowerCase().includes(part_type.toLowerCase()) ||
            (p.details && p.details.toLowerCase().includes(part_type.toLowerCase()))
          );
          if (filtered.length > 0) {
            results = filtered;
          } else {
            results = partsResults;
          }
        } else {
          results = partsResults;
        }
      }
    }

    // Strategy 4: Broader search without part type
    if (results.length === 0 && part_type) {
      const broader = [year, make, model].filter(Boolean).join(" ");
      if (broader) {
        results = await searchWooCommerce(broader);
        if (results.length === 0) results = await searchViaSiteScrape(broader);
      }
    }

    // Strategy 5: Check homepage vehicles
    if (results.length === 0 && (make || model)) {
      const vehicleMatches = await matchHomepageVehicles(year, make, model);
      if (vehicleMatches.length > 0) {
        const v = vehicleMatches[0];
        return res.json(`We have a ${v.name} in our inventory. Parts from this vehicle are available. What specific part do you need?`);
      }
    }

    // -------------------------------------------
    // FORMAT RESPONSE (always human-friendly)
    // -------------------------------------------
    if (results.length > 0) {
      const top = results[0];
      const partName = top.name || part_type || "that part";
      const vehicle = [year, make, model].filter(Boolean).join(" ");

      if (top.price) {
        if (results.length > 1 && results[1].price) {
          return res.json(`Yes we have that. Got a ${partName} at ${top.price}${results.length > 1 ? `, and ${results.length - 1} more option${results.length > 1 ? "s" : ""}` : ""}. Want me to set one up for you?`);
        }
        return res.json(`Yes we have a ${partName} at ${top.price}. Want to go ahead with it?`);
      }

      if (top.part_number) {
        return res.json(`We have a ${partName}, part number ${top.part_number}. Let me get exact pricing for you — can I get your phone number?`);
      }

      return res.json(`We have a ${partName} available${vehicle ? " for the " + vehicle : ""}. Want me to get you the exact price on that?`);
    }

    // -------------------------------------------
    // NOTHING FOUND - graceful fallback
    // -------------------------------------------
    const vehicle = [year, make, model].filter(Boolean).join(" ");
    const part = part_type || query || "that part";
    return res.json(`I'm not seeing a ${part}${vehicle ? " for a " + vehicle : ""} online right now, but our warehouse has over 100,000 parts. Want me to have the team check and call you back?`);

  } catch (error) {
    console.error("Search error:", error.message);
    return res.json("Let me get your info and have our parts team look into that for you.");
  }
});

// ============================================================
// ENDPOINT: /check-vehicle
// ============================================================
app.post("/check-vehicle", async (req, res) => {
  try {
    const args = req.body.args || req.body || {};
    const year = safe(args.year);
    const make = safe(args.make);
    const model = safe(args.model);

    console.log("=== VEHICLE CHECK ===");
    console.log(JSON.stringify({ year, make, model }));

    if (!make && !model) {
      return res.json("What year, make, and model are you looking for?");
    }

    const matches = await matchHomepageVehicles(year, make, model);
    if (matches.length > 0) {
      if (matches.length === 1) {
        return res.json(`Yep we've got a ${matches[0].name} in stock. What part do you need from it?`);
      }
      return res.json(`We've got ${matches.length} of those. What part are you looking for?`);
    }

    return res.json(`I don't see that vehicle in our recent arrivals but we may have parts in the warehouse. Want me to check with the team?`);

  } catch (error) {
    console.error("Vehicle check error:", error.message);
    return res.json("Let me have our team look into that. Can I get your name and number?");
  }
});

// ============================================================
// ENDPOINT: /submit-inquiry
// ============================================================
app.post("/submit-inquiry", async (req, res) => {
  try {
    const args = req.body.args || req.body || {};
    const name = safe(args.customer_name) || "you";
    const phone = safe(args.phone);
    const part = safe(args.part_needed);
    const vehicle = [safe(args.year), safe(args.make), safe(args.model)].filter(Boolean).join(" ");

    console.log("=== INQUIRY ===");
    console.log(JSON.stringify({ name, phone, part, vehicle }));

    return res.json(`Got it. Submitted for ${name}${part ? " looking for a " + part : ""}${vehicle ? " for a " + vehicle : ""}. Our team will call ${phone ? phone : "you back"} within a couple hours.`);

  } catch (error) {
    return res.json("Inquiry noted. Our team will be in touch shortly.");
  }
});

// ============================================================
// UTILITY ENDPOINTS
// ============================================================
app.get("/business-info", (req, res) => {
  res.json({
    name: "A Plus Auto LLC",
    phone: "(859) 421-3043",
    email: "sales@aplusauto.parts",
    address: "2125 Catnip Hill Rd, Nicholasville, KY 40356",
    hours: "Mon-Fri 8:30AM-6PM, Sat 9AM-12PM",
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.json({ service: "A Plus Auto Retell Middleware", status: "running" });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`A Plus Auto middleware running on port ${PORT}`));
