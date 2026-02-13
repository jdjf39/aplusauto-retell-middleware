const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const BASE_URL = "https://aplusauto.parts";

// ============================================================
// APPROACH 1: WooCommerce Store API (unauthenticated, public)
// This searches WooCommerce products directly
// ============================================================
async function searchWooCommerceStore(query, perPage = 10) {
  try {
    const response = await axios.get(
      `${BASE_URL}/wp-json/wc/store/v1/products`,
      {
        params: {
          search: query,
          per_page: perPage,
        },
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        timeout: 10000,
      }
    );

    return response.data.map((product) => ({
      id: product.id,
      name: product.name,
      price: product.prices?.price
        ? `$${(parseInt(product.prices.price) / 100).toFixed(2)}`
        : "Call for price",
      regular_price: product.prices?.regular_price
        ? `$${(parseInt(product.prices.regular_price) / 100).toFixed(2)}`
        : null,
      on_sale: product.on_sale || false,
      in_stock: product.is_purchasable !== false,
      description: product.short_description
        ? product.short_description.replace(/<[^>]*>/g, "").trim()
        : "",
      url: product.permalink || `${BASE_URL}/?p=${product.id}`,
      image: product.images?.[0]?.src || null,
      sku: product.sku || null,
      categories: product.categories?.map((c) => c.name) || [],
    }));
  } catch (error) {
    console.log(
      "WooCommerce Store API not available or returned error:",
      error.message
    );
    return null;
  }
}

// ============================================================
// APPROACH 2: Scrape the IIS Pro search results page
// This mimics the search form on the website
// ============================================================
async function scrapeInventorySearch(year, make, model, partType) {
  try {
    // First, try the inventory-new page which uses IIS Pro
    const searchUrl = `${BASE_URL}/inventory-new/`;

    // The IIS Pro plugin typically uses admin-ajax.php for searches
    // Try the AJAX approach first
    const ajaxData = new URLSearchParams();
    ajaxData.append("action", "iis_search_parts");
    if (year) ajaxData.append("year", year);
    if (make) ajaxData.append("make", make);
    if (model) ajaxData.append("model", model);
    if (partType) ajaxData.append("part_type", partType);

    const ajaxResponse = await axios.post(
      `${BASE_URL}/wp-admin/admin-ajax.php`,
      ajaxData,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Referer: `${BASE_URL}/used-parts-inventory/`,
        },
        timeout: 10000,
      }
    );

    if (ajaxResponse.data && typeof ajaxResponse.data === "object") {
      return ajaxResponse.data;
    }

    // If AJAX doesn't work, try scraping the search results page
    return await scrapeSearchResultsPage(year, make, model, partType);
  } catch (error) {
    console.log("AJAX search failed, trying page scrape:", error.message);
    return await scrapeSearchResultsPage(year, make, model, partType);
  }
}

async function scrapeSearchResultsPage(year, make, model, partType) {
  try {
    // Search using WordPress search with product post type
    const searchTerms = [year, make, model, partType].filter(Boolean).join(" ");
    const url = `${BASE_URL}/?s=${encodeURIComponent(searchTerms)}&post_type=product`;

    console.log("Scraping search URL:", url);

    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const products = [];

    // Try multiple selectors that WooCommerce sites commonly use
    $(".product, li.product, .wc-block-grid__product, article.product").each((i, el) => {
      const name =
        $(el).find(".woocommerce-loop-product__title, h2, h3, .product-title, .woocommerce-loop-category__title").text().trim() || "";
      const price =
        $(el).find(".price, .amount, .woocommerce-Price-amount").first().text().trim() || "Call for price";
      const link = $(el).find("a").first().attr("href") || "";
      const image = $(el).find("img").first().attr("src") || "";

      if (name) {
        products.push({
          name,
          price,
          url: link,
          image,
          in_stock: true,
        });
      }
    });

    // Also check for any search results in general format
    if (products.length === 0) {
      $("article, .search-result, .entry").each((i, el) => {
        const name = $(el).find("h2, h3, .entry-title").text().trim();
        const link = $(el).find("a").first().attr("href") || "";
        if (name && (name.toLowerCase().includes(make?.toLowerCase() || "") || name.toLowerCase().includes(model?.toLowerCase() || ""))) {
          products.push({
            name,
            price: "Call for price",
            url: link,
            in_stock: true,
          });
        }
      });
    }

    console.log(`Scrape found ${products.length} products`);
    return products;
  } catch (error) {
    console.log("Page scrape failed:", error.message);
    return [];
  }
}

// ============================================================
// APPROACH 5: Search homepage vehicles and match to caller request
// ============================================================
async function searchHomepageVehicles(year, make, model) {
  try {
    const response = await axios.get(BASE_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const vehicles = [];

    // Parse the latest arrivals from the homepage
    $("h5, h4, h3").each((i, el) => {
      const text = $(el).text().trim();
      if (text && /^\d{4}\s/.test(text)) {
        vehicles.push(text);
      }
    });

    // Also grab stock numbers
    $("*:contains('STK#')").each((i, el) => {
      const text = $(el).text().trim();
      if (text.includes("STK#") && text.length < 200) {
        vehicles.push(text);
      }
    });

    const searchTerms = [year, make, model].filter(Boolean).map(t => t.toLowerCase());
    const matches = vehicles.filter(v => 
      searchTerms.every(term => v.toLowerCase().includes(term))
    );

    console.log(`Homepage search: found ${vehicles.length} vehicles, ${matches.length} matches`);
    return matches;
  } catch (error) {
    console.log("Homepage vehicle search failed:", error.message);
    return [];
  }
}

// ============================================================
// APPROACH 3: Scrape latest arrivals (vehicles in inventory)
// ============================================================
async function getLatestArrivals() {
  try {
    const response = await axios.get(`${BASE_URL}/latest-arrivals/`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    const vehicles = [];

    $(".vehicle-card, .iis-vehicle, [class*='vehicle']").each((i, el) => {
      const name = $(el).find("h3, h4, h5, .vehicle-title").text().trim();
      const stk = $(el).find("[class*='stk'], [class*='stock']").text().trim();
      const vin = $(el).find("[class*='vin']").text().trim();

      if (name) {
        vehicles.push({ name, stock_number: stk, vin });
      }
    });

    return vehicles;
  } catch (error) {
    console.log("Latest arrivals fetch failed:", error.message);
    return [];
  }
}

// ============================================================
// APPROACH 4: Search WooCommerce product categories
// ============================================================
async function searchProductCategories(searchTerm) {
  try {
    const response = await axios.get(
      `${BASE_URL}/wp-json/wc/store/v1/products/categories`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        timeout: 10000,
      }
    );
    return response.data;
  } catch (error) {
    console.log("Category search failed:", error.message);
    return [];
  }
}

// ============================================================
// MAIN ENDPOINT: Retell Custom Function handler
// This is what your Retell agent calls
// ============================================================
app.post("/search-parts", async (req, res) => {
  // Retell sends data inside req.body.args
  const args = req.body.args || req.body;
  const { year, make, model, part_type, query } = args;

  console.log("Search request received:", { year, make, model, part_type, query });

  let results = [];
  let searchMethod = "";

  // Strategy 1: If we have a free-text query, try WooCommerce Store API
  const searchQuery = query || [year, make, model, part_type].filter(Boolean).join(" ");

  if (searchQuery) {
    const wcResults = await searchWooCommerceStore(searchQuery);
    if (wcResults && wcResults.length > 0) {
      results = wcResults;
      searchMethod = "woocommerce_store_api";
    }
  }

  // Strategy 2: If WooCommerce didn't return results, try scraping
  if (results.length === 0) {
    const scraped = await scrapeInventorySearch(year, make, model, part_type);
    if (scraped && scraped.length > 0) {
      results = Array.isArray(scraped) ? scraped : [scraped];
      searchMethod = "iis_scrape";
    }
  }

  // Strategy 3: If still no results, try a broader WooCommerce search
  if (results.length === 0 && (make || model)) {
    const broadQuery = [make, model].filter(Boolean).join(" ");
    const wcBroad = await searchWooCommerceStore(broadQuery);
    if (wcBroad && wcBroad.length > 0) {
      results = wcBroad;
      searchMethod = "woocommerce_broad";
    }
  }

  // Strategy 4: Check homepage vehicles for matches
  if (results.length === 0 && (year || make || model)) {
    const vehicleMatches = await searchHomepageVehicles(year, make, model);
    if (vehicleMatches.length > 0) {
      results = vehicleMatches.map(v => ({
        name: v,
        price: "Call for price",
        in_stock: true,
      }));
      searchMethod = "homepage_vehicle_match";
    }
  }

  // Format response for Retell
  if (results.length > 0) {
    const topResults = results.slice(0, 3);
    const first = topResults[0];
    let message = "";
    
    if (first.price && first.price !== "Call for price") {
      message = `Found: ${first.name} - ${first.price}. In stock.`;
    } else {
      message = `Found: ${first.name}. In stock. Price available upon request.`;
    }
    
    if (topResults.length > 1) {
      message += ` Plus ${topResults.length - 1} more option${topResults.length - 1 > 1 ? 's' : ''}.`;
    }
    
    console.log("Returning results:", message);
    res.json(message);
  } else {
    res.json("Part not found in online inventory. We have 100,000+ parts in our warehouse. Offer to take their info and have the parts team check.");
  }
});

// ============================================================
// VEHICLE LOOKUP: Check if a specific vehicle is in inventory
// ============================================================
app.post("/check-vehicle", async (req, res) => {
  // Retell sends data inside req.body.args
  const args = req.body.args || req.body;
  const { year, make, model } = args;
  const searchQuery = [year, make, model].filter(Boolean).join(" ");

  console.log("Vehicle check:", searchQuery);

  try {
    // Scrape the homepage latest arrivals for vehicle matches
    const response = await axios.get(BASE_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    const vehicles = [];

    // Parse the latest arrivals section
    $("h5, .vehicle-title, [class*='vehicle']").each((i, el) => {
      const text = $(el).text().trim();
      if (
        text &&
        (text.match(/^\d{4}\s/) || text.includes("STK#"))
      ) {
        vehicles.push(text);
      }
    });

    // Filter matches
    const searchTerms = searchQuery.toLowerCase().split(" ");
    const matches = vehicles.filter((v) =>
      searchTerms.every((term) => v.toLowerCase().includes(term))
    );

    if (matches.length > 0) {
      res.json(`Yes! We have ${matches.length} ${searchQuery} vehicle${matches.length > 1 ? "s" : ""} in our inventory. The parts from ${matches.length > 1 ? "these vehicles are" : "this vehicle is"} available. Would you like me to look up a specific part?`);
    } else {
      res.json(`I don't see a ${searchQuery} in our most recent arrivals, but we have a large warehouse with over 100,000 parts. We may still have parts from that vehicle. Would you like me to check with our parts team?`);
    }
  } catch (error) {
    res.json("I'm having trouble checking inventory right now. Let me take down your information and have our team get back to you.");
  }
});

// ============================================================
// PART INQUIRY: Submit a part inquiry form
// ============================================================
app.post("/submit-inquiry", async (req, res) => {
  // Retell sends data inside req.body.args
  const args = req.body.args || req.body;
  const { customer_name, email, phone, year, make, model, part_needed, message } = args;

  console.log("Part inquiry submission:", { customer_name, phone, part_needed });

  // In production, this would:
  // 1. Submit to A Plus Auto's inquiry form
  // 2. Send to their CRM (ProLine, etc.)
  // 3. Send email notification to sales@aplusauto.parts
  // 4. Create a lead in your system

  // For now, log and confirm
  res.json(`I've submitted your inquiry for a ${[year, make, model, part_needed].filter(Boolean).join(" ")}. Our parts team will reach out to you at ${phone || email} shortly. Our hours are Monday through Friday, 8:30 AM to 6 PM, and Saturday 9 AM to noon. Is there anything else I can help you with?`);
});

// ============================================================
// BUSINESS INFO: Quick reference for the agent
// ============================================================
app.get("/business-info", (req, res) => {
  res.json({
    name: "A Plus Auto LLC",
    phone: "(859) 421-3043",
    email: "sales@aplusauto.parts",
    address: "2125 Catnip Hill Rd, Nicholasville, KY 40356",
    hours: {
      weekdays: "Monday - Friday: 8:30 AM - 6:00 PM",
      saturday: "Saturday: 9:00 AM - 12:00 PM",
      sunday: "Closed",
    },
    warranty: "1-year standard warranty on all parts, 2-year and 3-year extended available",
    shipping: "Ships within 1 business day",
    return_policy: "30-day satisfaction guarantee",
    website: "https://aplusauto.parts",
    ebay_store: "https://ebay.com/str/aplus4",
    specialties: [
      "Premium recycled auto parts",
      "Grade A+ quality",
      "All parts cleaned, photographed, and inspected",
      "Over 100,000 parts in inventory",
    ],
  });
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`A Plus Auto - Retell Middleware running on port ${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  POST /search-parts     - Search inventory`);
  console.log(`  POST /check-vehicle    - Check vehicle availability`);
  console.log(`  POST /submit-inquiry   - Submit part inquiry`);
  console.log(`  GET  /business-info    - Get business details`);
  console.log(`  GET  /health           - Health check`);
});
