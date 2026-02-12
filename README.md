# A Plus Auto — Retell AI Inventory Search Middleware

This server acts as the bridge between your Retell AI phone agent and A Plus Auto's live website inventory. When a caller asks about a part, the agent calls this server, which searches the A Plus Auto website in real-time and returns results.

## How It Works

```
Caller → Retell AI Agent → This Server → aplusauto.parts → Results back to caller
```

The server uses multiple strategies to find parts:
1. **WooCommerce Store API** — Public, unauthenticated API for product search
2. **IIS Pro AJAX** — Direct plugin endpoint (if available)
3. **Page Scraping** — Fallback: scrapes search results from the website
4. **Vehicle Matching** — Checks latest arrivals for vehicle availability

## Quick Start

```bash
npm install
node server.js
```

Server starts on `http://localhost:3000`

## Test It

```bash
# Search for a part
curl -X POST http://localhost:3000/search-parts \
  -H "Content-Type: application/json" \
  -d '{"year": "2020", "make": "Honda", "model": "Accord", "part_type": "headlight"}'

# Check vehicle availability
curl -X POST http://localhost:3000/check-vehicle \
  -H "Content-Type: application/json" \
  -d '{"year": "2020", "make": "Honda", "model": "Accord"}'

# Get business info
curl http://localhost:3000/business-info
```

## Deploy & Connect to Retell

1. Deploy this server (Railway, Render, Vercel, or any hosting)
2. In Retell Dashboard → Your Agent → Custom Functions
3. Add the functions from `RETELL-SETUP-GUIDE.md`
4. Replace `YOUR-SERVER-URL` with your deployed URL
5. Test with a web call

See `RETELL-SETUP-GUIDE.md` for full Retell configuration including agent prompt and function schemas.

## Upgrading to Direct API Access

If you get WooCommerce API keys from A Plus Auto, you'll unlock:
- Full product catalog search with all fields
- Real-time stock quantities
- Ability to create orders programmatically
- Access to pricing tiers

Just add `WC_CONSUMER_KEY` and `WC_CONSUMER_SECRET` to your `.env` file.
