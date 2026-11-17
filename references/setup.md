# Setup — step by step

Walk the user through these one at a time, in their language. Each step ends with a command that
proves it worked. First time: 20–40 minutes, most of it in Google Cloud and the Google Ads API Center.
Everything is stored in `~/.google-ads-profit/` on this computer only.

What the user needs before starting: the Google login that can see their Google Ads account (and
ideally GA4 and Search Console), and admin access to their WordPress / WooCommerce.

---

## Step 1 — Node.js

`node --version` must show 18 or newer. If missing: install the LTS version from https://nodejs.org
(macOS: `brew install node`; Windows: `winget install OpenJS.NodeJS.LTS`). Nothing else is installed —
the scripts use only Node's built-in modules.

## Step 2 — Settings file

`node scripts/setup.mjs init` → creates `~/.google-ads-profit/config.json`.

## Step 3 — A Google Cloud project with four APIs (free)

Why: Google lets a program read Google Ads only through the user's *own* registered app. This is that app;
it runs only on this computer.

1. Open https://console.cloud.google.com/projectcreate → name it e.g. `ads-profit` → **Create**.
   Make sure this project is selected in the top bar for the next steps.
2. Enable each API (open the link → **Enable**):
   - Google Ads API — https://console.cloud.google.com/apis/library/googleads.googleapis.com
   - Google Analytics Data API — https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com
   - Google Analytics Admin API — https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com
   - Google Search Console API — https://console.cloud.google.com/apis/library/searchconsole.googleapis.com

No billing account is needed for these APIs.

## Step 4 — The sign-in screen of that app (OAuth consent)

1. Open https://console.cloud.google.com/auth/overview → **Get started**.
2. App name: e.g. `Ads profit (private)`; support email: their own → **Next**.
3. Audience: **External** → **Next**. Contact email: their own → **Next** → agree → **Create**.
4. Open **Audience** (left menu) → **Publish app** → **Confirm**.
   Important: an app left in "Testing" logs the user out every 7 days. Published without Google's
   verification is fine for one's own use: Google just shows a "not verified" warning at sign-in.

## Step 5 — Desktop client + sign-in

1. Open https://console.cloud.google.com/auth/clients → **Create client**.
2. Application type: **Desktop app**; name: `ads-profit-desktop` → **Create** → **Download JSON**
   (a file named `client_secret_….json` lands in Downloads).
3. Claude runs (in the background):
   `node scripts/google-login.mjs --client ~/Downloads/client_secret_XXXX.json`
4. A browser opens. The user chooses the Google login that sees their Google Ads.
   "Google hasn't verified this app" → **Advanced** → **Go to Ads profit (unsafe)** — it is their own app.
   Tick **every** permission → **Continue**. The page says "Connected ✓".

Proof: the command prints `Signed in.` and no "not granted" warning.

## Step 6 — Google Ads developer token

Every program that uses the Google Ads API needs a developer token. It is issued in a **manager
account** (free; the ad account does not have to be moved under it).

1. If the user has no manager account: https://ads.google.com/home/tools/manager-accounts/ → create one
   with the same Google login (name, country, time zone, currency; "to manage my own accounts").
2. In the manager account open **Admin → API Center** (https://ads.google.com/aw/apicenter).
3. Fill in the form (name, website, contact email, "managing my own business's account") → accept the
   terms → the **developer token** appears.
4. Look at **Access level**:
   - **Test account** — works only with Google test accounts. Click **Apply for Basic access**, describe
     the use honestly ("reporting and optimising my own shop's account, used by me only"). Google
     answers by email, usually within a few business days. Until then real accounts answer
     `DEVELOPER_TOKEN_NOT_APPROVED`.
   - **Explorer** or **Basic** — works now. Explorer has a small daily operations cap; the skill keeps
     its queries few.
5. Save it: `node scripts/setup.mjs open` (paste into `google.developerToken`, save) or
   `node scripts/setup.mjs set google.developerToken <token>`.

## Step 7 — Choose the Google Ads account

`node scripts/ads.mjs accounts` lists every account the login reaches.
- `node scripts/setup.mjs set google.customerId <id>` — the shop's ad account (10 digits, dashes optional).
- If the account shows `via <manager id>` (reached through a manager account, typical for agencies):
  `node scripts/setup.mjs set google.loginCustomerId <manager id>`.

Proof: `node scripts/ads.mjs campaigns --days 7` lists campaigns.

## Step 8 — GA4 and Search Console (optional, recommended)

- `node scripts/ga4.mjs properties` → `node scripts/setup.mjs set ga4.propertyId <id>`
- `node scripts/gsc.mjs sites` → `node scripts/setup.mjs set gsc.siteUrl "<exact site as listed>"`
  (e.g. `sc-domain:myshop.com` or `https://myshop.com/`).

If a property or site is missing, the signed-in Google user has no access to it: add that user in GA4
(Admin → Property access management → Viewer) or Search Console (Settings → Users and permissions →
Restricted), or sign in again with the right login (step 5.3).

## Step 9 — WooCommerce read-only key

1. WordPress admin → **WooCommerce → Settings → Advanced → REST API → Add key**.
2. Description: `Google Ads profit (read only)`; User: an administrator; Permissions: **Read** →
   **Generate API key**.
3. Copy **Consumer key** (`ck_…`) and **Consumer secret** (`cs_…`) — shown only once.
4. Save (editor via `setup.mjs open`, or): `setup.mjs set woo.url https://myshop.com`,
   `setup.mjs set woo.consumerKey ck_…`, `setup.mjs set woo.consumerSecret cs_…`.

Proof: `node scripts/woo.mjs profit --days 7`.
Troubleshooting: 404 → WordPress **Settings → Permalinks** must not be "Plain". A non-JSON answer → a
security plugin, firewall or Cloudflare rule blocks `/wp-json/` for programs; allow `/wp-json/wc/`.
Only orders in `woo.paidStatuses` (default processing, completed) count as sales.

## Step 10 — Product costs (without them there is no profit)

`node scripts/woo.mjs cost-check` shows which sold products have a cost. Ways to add costs (any one):

- **In WooCommerce**: newer WooCommerce versions have a built-in "Cost of Goods Sold" feature
  (WooCommerce → Settings → Advanced → Features); otherwise a Cost of Goods plugin (for example
  "Cost of Goods for WooCommerce" by WPFactory, or "WooCommerce Cost of Goods" by SkyVerge). Both are
  read automatically, including the cost frozen on each order line.
- **A file**: `~/.google-ads-profit/costs.csv` with lines `sku,cost` or `product_id,cost` (cost per
  unit, without VAT, in the shop currency).
- **An average**: `node scripts/setup.mjs set profit.defaultMarginPercent 35` (gross margin % on
  goods). Least exact, but enough to start.

Also, once: what does an order cost beyond the goods?
- `profit.extraCostPerOrder` — packaging, picking, and the shipping the shop pays beyond what the
  customer pays, on average per order.
- `profit.paymentFeePercent` — card/PayPal fees, typically 1.5–3.

## Step 11 — Brand and protected words

- `node scripts/setup.mjs set brandTerms "mybrand, my brand, mybrnd"` — the shop's/brand's own name
  and common misspellings. Negatives never contain these; brand spend is measured separately.
- `node scripts/setup.mjs set protectedTerms "earmuffs, ear defenders"` — category words people buy
  with. A negative containing one is blocked unless the user explicitly overrides.

## Step 12 — Final check

`node scripts/setup.mjs check` → every line ✓. Then: `node scripts/audit.mjs`.

## Step 13 — Search data for new markets (only for "which markets pay?")

The market research needs monthly searches and click prices per country. Two sources:

- **Google Keyword Planner** — free, uses the same Google Ads connection, but Google allows it through the
  API only with **Basic access** (Explorer access answers "not allowed for use with explorer access").
  Apply in API Center (step 6). Check: `node scripts/markets.mjs sources`.
- **DataForSEO** — works at once, paid by use (about 0.09 USD per request of up to 1 000 phrases; checking
  10 markets costs roughly 1–2 USD). 
  1. Create an account at https://app.dataforseo.com/register and add funds (Billing).
  2. **API Access** shows the API login (an email) and the **API password** — not the website password.
  3. `node scripts/setup.mjs set dataforseo.login <login>` and `… set dataforseo.password <API password>`
     (or `setup.mjs open`).
  4. Optional spending cap per day (default 5 USD): `node scripts/setup.mjs set dataforseo.dailyLimitUsd 5`.

Every DataForSEO run shows its estimated cost first and waits for the user's yes. Answers are cached for
30 days in `~/.google-ads-profit/keyword-cache.json`; every paid call is logged in `dataforseo-spend.json`.

---

### Later

- Another computer: copy the folder `~/.google-ads-profit/` (it holds the keys — treat it like a password).
- Disconnect: remove the app at https://myaccount.google.com/permissions, delete the WooCommerce REST key,
  delete `~/.google-ads-profit/`.
- "This Google Ads API version is no longer served": `node scripts/setup.mjs set google.apiVersion v<N>`
  with a current version from https://developers.google.com/google-ads/api/docs/sunset-dates.
