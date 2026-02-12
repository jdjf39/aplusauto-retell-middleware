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
    // Try the product category page with search params
    let url = `${BASE_URL}/product-category/iis-auto-parts/`;
    const params = {};
    if (year || make || model || partType) {
      // Try WooCommerce product search
      url = `${BASE_URL}/?s=${encodeURIComponent(
        [year, make, model, partType].filter(Boolean).join(" ")
      )}&post_type=product`;
    }

    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    const products = [];

    // Parse WooCommerce product listings
    $(".product, .iis-part, .woocommerce-loop-product").each((i, el) => {
      const name =
        $(el).find(".woocommerce-loop-product__title, h2, .part-title").text().trim() || "";
      const price =
        $(el).find(".price, .amount").first().text().trim() || "Call for price";
      const link = $(el).find("a").first().attr("href") || "";
      const image = $(el).find("img").first().attr("src") || "";
      const sku = $(el).find(".sku, [data-sku]").text().trim() || "";

      if (name) {
        products.push({
          name,
          price,
          url: link,
          image,
          sku,
          in_stock: true,
        });
      }
    });

    return products;
  } catch (error) {
    console.log("Page scrape failed:", error.message);
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
  const { year, make, model, part_type, query } = req.body;

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

  // Format response for Retell
  if (results.length > 0) {
    const topResults = results.slice(0, 5); // Limit to top 5 for voice
    const resultText = topResults
      .map((r, i) => {
        let line = `${i + 1}. ${r.name}`;
        if (r.price && r.price !== "Call for price") line += ` - ${r.price}`;
        if (r.sku) line += ` (SKU: ${r.sku})`;
        if (r.in_stock === false) line += " [OUT OF STOCK]";
        return line;
      })
      .join("\n");

    res.json({
      success: true,
      count: results.length,
      search_method: searchMethod,
      message: `I found ${results.length} part${results.length > 1 ? "s" : ""} matching your search. Here are the top results:\n${resultText}`,
      results: topResults,
      all_results_count: results.length,
    });
  } else {
    res.json({
      success: false,
      count: 0,
      message: `I wasn't able to find that specific part in the online inventory right now. I can take down your information and have our parts team check our full warehouse inventory and get back to you. We have over 100,000 parts in stock. Would you like me to submit an inquiry for you?`,
      results: [],
    });
  }
});

// ============================================================
// VEHICLE LOOKUP: Check if a specific vehicle is in inventory
// ============================================================
app.post("/check-vehicle", async (req, res) => {
  const { year, make, model } = req.body;
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
      res.json({
        success: true,
        message: `Yes! We have ${matches.length} ${searchQuery} vehicle${matches.length > 1 ? "s" : ""} in our inventory. The parts from ${matches.length > 1 ? "these vehicles are" : "this vehicle is"} available. Would you like me to look up a specific part?`,
        vehicles: matches,
      });
    } else {
      res.json({
        success: true,
        message: `I don't see a ${searchQuery} in our most recent arrivals, but we have a large warehouse with over 100,000 parts. We may still have parts from that vehicle. Would you like me to check with our parts team?`,
        vehicles: [],
      });
    }
  } catch (error) {
    res.json({
      success: false,
      message:
        "I'm having trouble checking inventory right now. Let me take down your information and have our team get back to you.",
      vehicles: [],
    });
  }
});

// ============================================================
// PART INQUIRY: Submit a part inquiry form
// ============================================================
app.post("/submit-inquiry", async (req, res) => {
  const { customer_name, email, phone, year, make, model, part_needed, message } = req.body;

  console.log("Part inquiry submission:", { customer_name, phone, part_needed });

  // In production, this would:
  // 1. Submit to A Plus Auto's inquiry form
  // 2. Send to their CRM (ProLine, etc.)
  // 3. Send email notification to sales@aplusauto.parts
  // 4. Create a lead in your system

  // For now, log and confirm
  res.json({
    success: true,
    message: `I've submitted your inquiry for a ${[year, make, model, part_needed].filter(Boolean).join(" ")}. Our parts team will reach out to you at ${phone || email} shortly. Our hours are Monday through Friday, 8:30 AM to 6 PM, and Saturday 9 AM to noon. Is there anything else I can help you with?`,
    inquiry: {
      customer_name,
      email,
      phone,
      vehicle: `${year} ${make} ${model}`,
      part_needed,
      message,
      submitted_at: new Date().toISOString(),
    },
  });
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
