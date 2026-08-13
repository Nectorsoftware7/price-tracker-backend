# Price Tracker — Backend

Express API + MySQL + Playwright-based scraper that tracks live price/stock across 9 e-commerce
sites (Flipkart, Shopify, WooCommerce, JioMart, Purplle, Snapdeal, Nykaa, Tira, Meesho), sends
Telegram alerts on changes, logs to Google Sheets, and uses AI (Hermes via OpenRouter) to
auto-reply to product reviews and WordPress Contact Form 7 submissions.

The companion frontend dashboard lives in a separate repo — see
[price-tracker-frontend](https://github.com/Nectorsoftware7/price-tracker-frontend).

## Tech Stack

- **Node.js + Express** — API server
- **MySQL** (`mysql2`, raw SQL, no ORM) — products, price history, stock events, contact submissions
- **Playwright** (headless Chromium) — the scraper: opens each product page and reads live
  price/stock, since most of these sites don't expose a public data API
- **`playwright-extra` + `puppeteer-extra-plugin-stealth`** — hides browser-automation fingerprints
  (`navigator.webdriver`, missing plugins, etc.) that anti-bot systems can detect independent of IP
- **JWT** — dashboard login/auth

### Third-party services

| Service | Used for |
|---|---|
| Render | Hosting (Docker web service) |
| cron-job.org | External scheduler — hits `POST /api/cron/price-check` and `/api/cron/auto-reply` hourly. Required because Render's free tier sleeps and kills any in-process scheduler — there is **no** in-process `node-cron` here; running one alongside an external scheduler caused duplicate/racing check runs in the past |
| UptimeRobot (recommended) | Free monitor pinging `/api/health` every 5 min to stop Render from sleeping |
| Google Sheets API (service account) | `Log` tab (current product list), `Flagged` tab (out-of-stock/low-stock), `Price Variation` tab (24h min/max/avg) |
| Telegram Bot API | Price/stock-change alerts, manual "Check now" confirmations, hourly-run summaries |
| Resend | Contact Form 7 reply emails (Render blocks outbound SMTP, so email goes over Resend's HTTPS API). **Requires a verified domain in the Resend dashboard** — until verified, Resend can only deliver to the account's own email |
| OpenRouter (Hermes AI model) | AI replies to product reviews and contact-form messages |
| ScraperAPI (optional) | Bypasses cloud-IP blocking for JioMart/Purplle (works on the free tier) and Snapdeal/Nykaa/Tira/Meesho (needs ScraperAPI's paid premium-proxy-pool plan) |
| Residential proxy, e.g. IPRoyal (optional, alternative to ScraperAPI) | Routes Playwright's requests through a residential IP via `PROXY_SERVER`/`PROXY_USERNAME`/`PROXY_PASSWORD` |

## Setup

```bash
npm install
npx playwright install chromium
copy .env.example .env    # then fill in the values below
npm start
```

Runs the API on `http://localhost:4000` (or `$PORT`). There is no in-process cron — trigger checks
via the dashboard, or set up external scheduling (see "Deploying" below).

## Environment variables

**Core**
| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No (default 4000) | API port |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | Yes | Database connection |
| `JWT_SECRET` | Yes | Signs dashboard login tokens |
| `JWT_EXPIRES_IN` | No (default `7d`) | Token lifetime |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Yes | Dashboard login credentials |

**Scheduling / cron trigger**
| Variable | Required | Purpose |
|---|---|---|
| `CRON_SECRET` | Yes (for the external scheduler) | Checked against the `X-Cron-Secret` header on `/api/cron/*` — set the same value in cron-job.org's request headers |
| `PRICE_CHECK_SKIP_SITES` | No | Comma-separated site names this server should **not** scrape itself (blocked sites a `local-worker` handles instead — see the "Local worker" section) |

**Telegram alerts**
| Variable | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Yes | Sends alerts and check confirmations |

**Google Sheets sync**
| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_SHEET_ID` | Yes (to enable sync) | Target spreadsheet ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Yes on a deployed server | Full service-account key JSON as a single-line env var (the file-based alternative, `src/config/google-service-account.json`, is git-ignored and won't exist on a fresh deploy) |
| `GOOGLE_SHEETS_LOG_TAB`, `GOOGLE_SHEETS_FLAGGED_TAB`, `GOOGLE_SHEETS_VARIATION_TAB` | No (default `Log`, `Flagged`, `Price Variation`) | Tab names |

**Bypassing site blocks — pick one, or neither**
| Variable | Purpose |
|---|---|
| `SCRAPERAPI_KEY` | Routes JioMart/Purplle/Snapdeal/Nykaa/Tira/Meesho requests through ScraperAPI. Free tier covers JioMart/Purplle; the rest need ScraperAPI's paid premium-proxy plan (`premium=true` is already wired in, just needs the plan) |
| `PROXY_SERVER`, `PROXY_USERNAME`, `PROXY_PASSWORD` | Alternative: routes the same sites' Playwright requests through a residential proxy (e.g. IPRoyal) directly |

**AI auto-reply (Hermes via OpenRouter)**
| Variable | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes (to enable AI replies) | OpenRouter API key |
| `OPENROUTER_MODEL` | No | Model override |
| `JUDGEME_API_TOKEN`, `JUDGEME_SHOP_DOMAIN` | Optional | Shopify product review replies |
| `WP_USERNAME`, `WP_APP_PASSWORD` | Optional | WordPress comment replies |

**Contact Form 7 → AI email reply**
| Variable | Required | Purpose |
|---|---|---|
| `CF7_WEBHOOK_SECRET` | Yes (to enable this feature) | Shared secret the WordPress snippet sends |
| `RESEND_API_KEY` | Yes | Resend account API key |
| `RESEND_FROM` | No (default `onboarding@resend.dev`, sandbox-only) | Fallback sender when no per-platform domain is verified |
| `RESEND_FROM_SHOPIFY`, `RESEND_FROM_WOOCOMMERCE` | Optional | Per-store sender — only deliverable once that domain is verified in the Resend dashboard |
| `SMTP_FROM_NAME` | No | Display name on outgoing reply emails |

**Flipkart Seller API (optional, exact stock quantity)**
| Variable | Purpose |
|---|---|
| `FLIPKART_CLIENT_ID`, `FLIPKART_CLIENT_SECRET` | Only needed for products with a Flipkart SKU configured for exact-quantity stock — price still always comes from the public page |

**Shopify / WooCommerce (optional, only if a store needs authenticated API access)**
| Variable | Purpose |
|---|---|
| `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_SHOP_DOMAIN` | Shopify Admin API |
| `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET` | WooCommerce REST API |

**Local worker**
| Variable | Purpose |
|---|---|
| `LOCAL_WORKER_SECRET` | Checked (via `X-Worker-Secret` header) on `POST /api/products/:id/report-check` — must match `WORKER_SECRET` in the worker's `.env` |

## Sites that block cloud IPs — the local worker (free fallback)

Some sites block requests from cloud/datacenter IPs outright, no matter what the code does.
`local-worker/` is a small standalone script (separate from this repo) meant to run on a normal PC
— a residential IP looks like an ordinary customer to these sites. It scrapes just the sites listed
in `PRICE_CHECK_SKIP_SITES` and reports results back to this server via
`POST /api/products/:id/report-check`. The tradeoff: those sites only get checked while that
script/PC is actually running.

## Deploying so it runs on a schedule

This app has **no in-process cron** — `server.js` only starts the Express API. Scheduling is
entirely external:

1. Deploy as a Docker web service on Render (or similar).
2. Set up an external HTTP scheduler (e.g. **cron-job.org**) to `POST` to:
   - `/api/cron/price-check` (hourly) and `/api/cron/auto-reply` (every few hours)
   - both with header `X-Cron-Secret: <CRON_SECRET>`
3. Set up **UptimeRobot** (free) to ping `/api/health` every 5 minutes — keeps a free-tier Render
   instance from sleeping, so the scheduler's trigger doesn't get missed or hit a cold-start timeout.

**Do not** re-add an in-process `node-cron` alongside the external scheduler — running both was a
real bug: whenever Render was awake, both could fire near-simultaneously and race on the same
database rows, producing duplicate/contradictory Telegram alerts.

## Notes / limitations

- Site page structures change over time — if a check starts failing, check the server logs first
  (error messages include a debug snippet of what the scraper actually saw — useful for telling
  "site redesign" apart from "IP block" apart from "stale cache").
- Public product pages rarely expose exact stock quantity, except where a platform's Seller/Admin
  API is configured (Flipkart Seller API).
- **Known blocked sites**: Snapdeal, Nykaa, Tira, Meesho return a 403 (bot protection) from Render's
  IP and aren't fixable in code alone — either the local-worker fallback, ScraperAPI's paid
  premium-proxy plan, or a residential proxy is required. JioMart and Purplle are fixed via
  `SCRAPERAPI_KEY` on the free tier.
