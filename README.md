# Price Tracker — Backend

Express API + MySQL + a Playwright-backed scraper that tracks live price and stock across ten
marketplaces (Flipkart, Meesho, JioMart, Myntra, Snapdeal, Tira, Nykaa, Purplle, plus any Shopify
or WooCommerce store), sends Telegram alerts on changes, mirrors everything to Google Sheets, and
uses AI (Hermes via OpenRouter) to draft replies to product reviews and WordPress Contact Form 7
submissions.

### What it serves

- **Checks** — price and stock per listing, on a schedule and on demand, with full history kept
- **Alerts** — out of stock, back in stock, price up/down, and below a per-listing target price
  (which fires on the crossing rather than every hour it stays under)
- **Dashboard data** — one endpoint (`GET /api/products/dashboard`) returning the headline figures,
  daily out-of-stock counts, biggest price moves, how often each listing changes price or stock,
  and the same product's price on each marketplace it is listed on
- **Sheets** — Log, Flagged, Price Variation, and an append-only Price & Stock Changes tab
- **Contact form** — CF7 submissions, an AI-drafted reply emailed out, and a manual reply path
- **Roles** — `admin` (E-commerce Executive), `superadmin`, and a read-only `viewer` whose writes
  are refused server-side, not only hidden in the UI

The companion frontend dashboard lives in a separate repo — see
[price-tracker-frontend](https://github.com/Nectorsoftware7/price-tracker-frontend).

## Tech Stack

- **Node.js + Express** — API server
- **MySQL** (`mysql2`, raw SQL, no ORM) — products, price history, stock events, contact submissions
- **Scraping — a plain-HTTP fetch first, Playwright as the fallback** (`src/scrapers/fastFetch.js`
  / `src/scrapers/browserScraper.js`): most sites already embed price/stock as schema.org JSON-LD
  in the server-rendered HTML, so a single no-browser HTTPS request is usually enough — a full
  Chromium launch only runs when that can't read the page confidently (no browser needed = far
  less data pulled per check, which matters directly on a metered residential proxy, and ~40x
  faster: ~0.7s vs ~30s). **Playwright** (headless Chromium) is what actually renders a page when
  the fast path isn't enough — real JS execution, for sites where price/stock only appears after
  client-side rendering, or where a plain request gets blocked outright.
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

Requires Node.js 20+ and MySQL 8 / MariaDB 10.5+ (window functions are used).

```bash
# 1. database — schema.sql is the whole schema
mysql -u root -p -e "CREATE DATABASE price_tracker"
mysql -u root -p price_tracker < schema.sql

# 2. dependencies and config
npm install
npx playwright install chromium
cp .env.example .env       # then fill in the values below

# 3. login accounts, created from ADMIN_* / SUPERADMIN_* in .env
npm run seed:admin

# 4. run
npm run dev                # or: npm start
```

Runs the API on `http://localhost:4000` (or `$PORT`). There is no in-process cron — trigger checks
via the dashboard, or set up external scheduling (see "Deploying" below).

### One-off scripts

`src/scripts/` holds maintenance scripts, each safe to re-run:

| Script | What it does |
|---|---|
| `seedAdmin.js` | Creates or updates the login accounts from `.env` |
| `createViewerUser.js` | Adds the read-only demo account |
| `formatSheets.js` | Applies header styling, banding, status colours and per-column filters to the Google Sheet |
| `addMyntraSite.js`, `addProductGroup.js`, `addTargetPrice.js` | Upgrade a database created before those columns existed. A fresh one from `schema.sql` already has them |

### Local development — exposing localhost with ngrok

[ngrok](https://ngrok.com) opens a temporary public HTTPS URL (e.g. `https://abcd1234.ngrok-free.app`)
that forwards straight to a server running on your own machine — useful for anything that needs to
*reach* your local server from the outside, since `localhost` itself is only reachable from your own
machine. That covers:

- **Shopify/WooCommerce webhooks** (order/product update notifications) — both platforms need a real
  public HTTPS URL to send webhooks to; `localhost` doesn't work as a webhook target
- **The WordPress Contact Form 7 → AI-reply integration** (`CF7_WEBHOOK_SECRET`) — same reason, the
  WordPress site needs a public URL to call
- **OAuth redirect URIs** during initial Shopify/WooCommerce app setup, before a permanent domain exists

Only actually needed **before** this API has a real deployed URL (i.e. before/without Render). Once
deployed — this project's live backend is `https://price-tracker-backend-ioqo.onrender.com` — every
webhook/redirect should point there instead; ngrok's URL is temporary (a free-tier tunnel gets a new
URL on every restart) and only forwards while your local machine and the `ngrok http 4000` process are
both running, so it's a dev-only tool, not something to leave configured in production. `dashboard.ngrok.com`
is ngrok's own web UI for managing tunnels, viewing an auth token, and inspecting live request/response
traffic through a tunnel — handy for debugging exactly what a webhook payload contained.

## Environment variables

**Core**
| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No (default 4000) | API port |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | Yes | Database connection |
| `JWT_SECRET` | Yes | Signs dashboard login tokens |
| `JWT_EXPIRES_IN` | No (default `7d`) | Token lifetime |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Yes | Dashboard login for the E-commerce Executive role |
| `ADMIN_ROLE` | No (default `admin`) | Role given to `ADMIN_USERNAME` when seeding |
| `SUPERADMIN_USERNAME`, `SUPERADMIN_PASSWORD` | No | Seeds a second, superadmin account |
| `GOOGLE_CLIENT_ID` | No | Enables "Sign in with Google" on the dashboard. Must be the same client ID the frontend uses, and the frontend's origin has to be listed as an authorised JavaScript origin in Google Cloud Console |

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

## Sites this server cannot reach

Two different problems, often confused, with different answers.

**Blocked by IP.** JioMart, Myntra and Snapdeal refuse a foreign datacenter address. From an Indian
IP they work directly; from a host outside India they need `SCRAPERAPI_KEY`, which was verified
using ScraperAPI's ordinary Indian addresses rather than its premium residential tier.

**Blocked by automation.** Meesho is different, and no proxy fixes it. Tested from one machine and
one connection, changing only the browser: a plain HTTP request was refused, an automated browser
was refused, and the same browser running normally with a window returned the real page. The
detection is of automation, not of the address — which is why paid scraping services fail here too,
being automated browsers themselves.

That is what `local-worker/` is for: a small agent on a PC with a real browser, reading just the
sites named in its `WORKER_SITES` and reporting back via `POST /api/products/:id/report-check`. List
those same sites in `PRICE_CHECK_SKIP_SITES` here so this server does not also try and fail. A cloud
host has no display and can only run the kind of browser Meesho rejects, so this part cannot be
moved to the server — and while that PC is off, those listings are not checked.

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
- `POST /api/products/:id/check-now`'s response includes `lastCheckSource` (which extraction
  strategy actually produced the reading — `json-ld-fetch`/`next-data-fetch` = the no-browser fast
  path, `json-ld`/`next-data`/`css-selector` = Playwright) and `lastCheckFastPath` (`"hit"`, or the
  reason the fast path was skipped for that check) — useful for confirming whether a given site is
  actually reachable via the cheap path from wherever this server is currently deployed, since that
  can differ from a local test (bot detection can key off more than just IP reputation).
- Public product pages rarely expose exact stock quantity, except where a platform's Seller/Admin
  API is configured (Flipkart Seller API).
- **Site reachability** — see "Sites this server cannot reach". Flipkart, Tira and Purplle work
  directly from anywhere; JioMart, Myntra and Snapdeal need an Indian IP or ScraperAPI; Meesho needs
  the local worker regardless of address.
- **Cross-marketplace links are set by hand** via `products.product_group`. Matching them from the
  titles was tried and abandoned — it merged Vitamin C with Vitamin B12 and a 30-count with a
  120-count, each of which would have reported a price gap that does not exist. Ungrouped listings
  are left out of the comparison, which is the right failure: a missing row is honest, a wrong one
  is not.
- **Contact-form replies need a verified sending domain.** Until one is verified with the email
  provider, replies only reach the provider account's own address. They are stored either way and
  can be re-sent from the dashboard once it is.
