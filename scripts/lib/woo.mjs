// WooCommerce: read-only REST client, product costs and profit from real orders.
//
// The shop is the truth about sales and profit. Google Ads sees only part of the purchases (cookie
// consent, other devices) and credits the clicked product, not the bought one — so every profit
// judgement here is made from WooCommerce orders.
import fs from 'node:fs';
import { paths } from './config.mjs';
import { countriesOfLocations } from './countries.mjs';
import { num, redact, round, UserError } from './util.mjs';

export class WooError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'WooError';
    this.hint = hint;
  }
}

export class WooClient {
  constructor({ url, consumerKey, consumerSecret }, transport = fetch) {
    if (!url || !consumerKey || !consumerSecret) {
      throw new UserError('WooCommerce is not connected.', 'See references/setup.md step 9 (REST API key with Read permission), then set woo.url, woo.consumerKey, woo.consumerSecret.');
    }
    this.base = String(url).replace(/\/+$/, '');
    if (!/^https:\/\//.test(this.base) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(this.base)) {
      throw new UserError('The shop address must start with https:// (keys are sent with every request).');
    }
    this.key = consumerKey;
    this.secret = consumerSecret;
    this.transport = transport;
    this.useQueryAuth = false;
  }

  async get(path, params = {}) {
    const url = new URL(`${this.base}/wp-json/wc/v3/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    for (let attempt = 1; ; attempt += 1) {
      const target = new URL(url);
      const headers = { accept: 'application/json', 'user-agent': 'google-ads-profit-skill' };
      if (this.useQueryAuth) {
        target.searchParams.set('consumer_key', this.key);
        target.searchParams.set('consumer_secret', this.secret);
      } else {
        headers.authorization = `Basic ${Buffer.from(`${this.key}:${this.secret}`).toString('base64')}`;
      }
      let response;
      try {
        response = await this.transport(target, { headers, signal: AbortSignal.timeout(60_000) });
      } catch (error) {
        if (attempt < 3) { await new Promise((d) => setTimeout(d, 1500 * attempt)); continue; }
        throw new WooError(`Cannot reach the shop at ${this.base} (${error.message}).`, 'Check woo.url (the shop address, e.g. https://myshop.com).');
      }
      // Some hosts strip the Authorization header: WooCommerce then answers 401 — retry with query auth (HTTPS only).
      if (response.status === 401 && !this.useQueryAuth && this.base.startsWith('https://')) { this.useQueryAuth = true; continue; }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) { await new Promise((d) => setTimeout(d, 2000 * attempt)); continue; }
      const text = await response.text();
      if (!response.ok) {
        let code = '';
        try { code = JSON.parse(text).code ?? ''; } catch { /* html */ }
        const hint = response.status === 401 || /woocommerce_rest_cannot_view|authentication/i.test(code)
          ? 'The REST key is wrong or has no Read permission. Create a new one: WooCommerce → Settings → Advanced → REST API.'
          : response.status === 404 ? 'The WooCommerce REST API was not found. Is woo.url the shop address, and are WordPress permalinks set to anything but "Plain"?'
            : undefined;
        throw new WooError(`WooCommerce ${path} → ${response.status} ${code}: ${redact(text, [this.key, this.secret]).slice(0, 300)}`, hint);
      }
      let data;
      try { data = JSON.parse(text); } catch {
        throw new WooError(`WooCommerce ${path} did not return JSON (a security plugin or cache may be blocking /wp-json).`, 'Open <shop>/wp-json/wc/v3 in a browser; it must return JSON.');
      }
      return { data, total: num(response.headers.get('x-wp-total'), null), pages: num(response.headers.get('x-wp-totalpages'), 1) };
    }
  }

  async getAll(path, params = {}, { maxPages = 500 } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const { data, pages } = await this.get(path, { ...params, per_page: 100, page });
      if (!Array.isArray(data)) throw new WooError(`WooCommerce ${path} returned no list.`);
      out.push(...data);
      if (page >= pages || data.length < 100) break;
    }
    return out;
  }
}

// billing.country / shipping.country only: the market research needs the country, nothing else about the buyer.
const ORDER_FIELDS = 'id,status,currency,date_created_gmt,total,total_tax,shipping_total,discount_total,line_items,refunds,meta_data,billing.country,shipping.country';

/** Orders created in [from, to] (local days), all statuses — filtering happens in computeProfit. */
export async function fetchOrders(client, { from, to }) {
  const after = new Date(`${from}T00:00:00`).toISOString();
  const before = new Date(`${to}T23:59:59.999`).toISOString();
  return client.getAll('orders', { after, before, dates_are_gmt: 'true', orderby: 'date', order: 'asc', _fields: ORDER_FIELDS });
}

const PRODUCT_FIELDS = 'id,parent_id,name,sku,type,price,meta_data,cost_of_goods_sold,categories';

/** Products and variations that appear in the given orders, keyed by id. */
export async function fetchProductsForOrders(client, orders) {
  const parents = new Set();
  const variationsByParent = new Map();
  for (const order of orders) {
    for (const line of order.line_items ?? []) {
      if (line.product_id) parents.add(line.product_id);
      if (line.variation_id) {
        if (!variationsByParent.has(line.product_id)) variationsByParent.set(line.product_id, new Set());
        variationsByParent.get(line.product_id).add(line.variation_id);
      }
    }
  }
  const index = new Map();
  const ids = [...parents];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    for (const p of await client.getAll('products', { include: chunk.join(','), status: 'any', _fields: PRODUCT_FIELDS })) index.set(p.id, p);
  }
  for (const [parent, variationIds] of variationsByParent) {
    const list = [...variationIds];
    for (let i = 0; i < list.length; i += 100) {
      try {
        const rows = await client.getAll(`products/${parent}/variations`, { include: list.slice(i, i + 100).join(','), _fields: PRODUCT_FIELDS });
        for (const v of rows) index.set(v.id, { ...v, parent_id: v.parent_id || parent });
      } catch (error) {
        if (!(error instanceof WooError)) throw error; // a deleted parent: its variations just have no cost
      }
    }
  }
  return index;
}

// ---------- costs ----------

const PRODUCT_COST_KEYS = ['_wc_cog_cost', '_alg_wc_cog_cost', '_purchase_price', 'purchase_price', '_cost_price', 'cost_price', '_wc_cost'];
const LINE_COST_KEYS = ['_wc_cog_item_cost', '_alg_wc_cog_item_cost'];

const metaValue = (meta, keys) => {
  for (const key of keys) {
    const found = (meta ?? []).find((m) => m.key === key);
    const value = num(found?.value, NaN);
    if (Number.isFinite(value) && value > 0) return { value, key };
  }
  return null;
};

/** Unit cost stored on a product or variation (WooCommerce Cost of Goods, popular COGS plugins). */
export function productUnitCost(product) {
  if (!product) return null;
  const core = num(product.cost_of_goods_sold?.total_value, NaN);
  if (Number.isFinite(core) && core > 0) return { value: core, source: 'woocommerce-cogs' };
  const meta = metaValue(product.meta_data, PRODUCT_COST_KEYS);
  return meta ? { value: meta.value, source: meta.key } : null;
}

/** Unit cost frozen on the order line at the time of sale (preferred: it is what the goods really cost then). */
export function lineUnitCost(line) {
  const core = num(line.cost_of_goods_sold?.total_value, NaN);
  if (Number.isFinite(core) && core > 0 && num(line.quantity) > 0) return { value: core / num(line.quantity), source: 'order-line-cogs' };
  const meta = metaValue(line.meta_data, LINE_COST_KEYS);
  return meta ? { value: meta.value, source: 'order-line' } : null;
}

/** costs.csv: "sku,cost" or "product_id,cost" (header optional, ; or , separated). Keys are matched exactly. */
export function loadCostCsv(file = paths.costs) {
  if (!fs.existsSync(file)) return new Map();
  const map = new Map();
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
    const parts = line.split(sep).map((s) => s.trim().replace(/^"|"$/g, ''));
    const key = parts[0];
    // "sku,7,25" — a comma file with a decimal comma: the third field is the decimals.
    const cost = sep === ',' && parts.length === 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2]) ? `${parts[1]}.${parts[2]}` : parts[1];
    const value = num(String(cost ?? '').replace(',', '.'), NaN);
    if (!key || !Number.isFinite(value)) continue; // header or broken line
    map.set(key, value);
  }
  return map;
}

// ---------- attribution (WooCommerce 8.5+ order attribution) ----------

const orderMeta = (order, key) => (order.meta_data ?? []).find((m) => m.key === key)?.value ?? null;

/** google_ads | google_organic | other | unknown — from WooCommerce's own order attribution. */
export function attributionOf(order) {
  const type = orderMeta(order, '_wc_order_attribution_source_type');
  if (!type) return 'unknown';
  const source = String(orderMeta(order, '_wc_order_attribution_utm_source') ?? '').toLowerCase();
  const medium = String(orderMeta(order, '_wc_order_attribution_utm_medium') ?? '').toLowerCase();
  if (source.includes('google') && /^(cpc|ppc|paid|paidsearch|paid_search|shopping|pmax|display|youtube|video)/.test(medium)) return 'google_ads';
  if (type === 'organic' && source.includes('google')) return 'google_organic';
  return 'other';
}

// ---------- profit ----------

/**
 * Profit from real orders.
 *  revenue  = line totals after discounts, without tax (what the goods sold for)
 *  cogs     = unit cost × quantity (order line → costs.csv → product → default margin)
 *  extra    = extraCostPerOrder + paymentFeePercent × order total
 *  profitBeforeAds = revenue − cogs − extra   (ad spend is subtracted by the caller)
 * Partial refunds reduce revenue and cost of that order proportionally.
 * Orders in another currency than the main one are left out and counted.
 */
export function computeProfit(orders, products, config, { csv = new Map(), currency = null } = {}) {
  const paid = new Set((config.woo?.paidStatuses ?? ['processing', 'completed']).map((s) => String(s).toLowerCase()));
  const defaultMargin = config.profit?.defaultMarginPercent;
  const extraPerOrder = num(config.profit?.extraCostPerOrder);
  const feePct = num(config.profit?.paymentFeePercent) / 100;

  const currencies = new Map();
  for (const o of orders) if (paid.has(o.status)) currencies.set(o.currency, (currencies.get(o.currency) ?? 0) + 1);
  const mainCurrency = currency ?? [...currencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const totals = {
    orders: 0, revenue: 0, orderTotal: 0, shipping: 0, tax: 0, refunds: 0,
    revenueWithCost: 0, cogs: 0, extraCosts: 0, skippedOtherCurrency: 0, skippedStatus: 0,
  };
  const byProduct = new Map();
  const byDay = new Map();
  const attribution = { google_ads: { orders: 0, revenue: 0 }, google_organic: { orders: 0, revenue: 0 }, other: { orders: 0, revenue: 0 }, unknown: { orders: 0, revenue: 0 } };
  const costSources = new Map();

  for (const order of orders) {
    if (!paid.has(String(order.status))) { totals.skippedStatus += 1; continue; }
    if (mainCurrency && order.currency !== mainCurrency) { totals.skippedOtherCurrency += 1; continue; }
    const lines = (order.line_items ?? []).filter((l) => num(l.quantity) > 0);
    const goods = lines.reduce((s, l) => s + num(l.total), 0);
    const orderTotal = num(order.total);
    const refunded = Math.abs((order.refunds ?? []).reduce((s, r) => s + num(r.total), 0));
    const keep = orderTotal > 0 ? Math.max(0, 1 - refunded / orderTotal) : 1;

    totals.orders += 1;
    totals.orderTotal += orderTotal - refunded;
    totals.shipping += num(order.shipping_total);
    totals.tax += num(order.total_tax);
    totals.refunds += refunded;
    const extra = extraPerOrder + feePct * orderTotal;
    totals.extraCosts += extra;

    let orderRevenue = 0;
    let orderCogs = 0;
    let orderKnown = true;
    for (const line of lines) {
      const qty = num(line.quantity) * keep;
      const revenue = num(line.total) * keep;
      const productId = line.product_id || line.variation_id;
      const variation = line.variation_id ? products.get(line.variation_id) : null;
      const product = products.get(line.product_id);
      const sku = line.sku || variation?.sku || product?.sku || '';
      let unit = lineUnitCost(line);
      if (!unit && sku && csv.has(sku)) unit = { value: csv.get(sku), source: 'costs.csv' };
      if (!unit && csv.has(String(line.variation_id || ''))) unit = { value: csv.get(String(line.variation_id)), source: 'costs.csv' };
      if (!unit && csv.has(String(line.product_id))) unit = { value: csv.get(String(line.product_id)), source: 'costs.csv' };
      if (!unit) unit = productUnitCost(variation) ?? productUnitCost(product);
      let cogs = null;
      let source = unit?.source ?? null;
      if (unit) cogs = unit.value * qty;
      else if (defaultMargin !== null && defaultMargin !== undefined && defaultMargin !== '') {
        cogs = revenue * (1 - num(defaultMargin) / 100);
        source = 'default-margin';
      }
      costSources.set(source ?? 'missing', (costSources.get(source ?? 'missing') ?? 0) + revenue);

      totals.revenue += revenue;
      orderRevenue += revenue;
      if (cogs !== null) { totals.cogs += cogs; totals.revenueWithCost += revenue; orderCogs += cogs; } else orderKnown = false;

      const key = productId;
      if (!byProduct.has(key)) {
        byProduct.set(key, {
          productId: key, name: product?.name ?? String(line.name ?? '').replace(/ - .*$/, ''), sku: product?.sku ?? '',
          units: 0, lines: 0, revenue: 0, cogs: 0, revenueWithCost: 0, costSource: new Set(),
          categories: (product?.categories ?? []).map((c) => c.name).filter(Boolean),
          variationIds: new Set(), skus: new Set(),
        });
      }
      const p = byProduct.get(key);
      p.units += qty;
      p.lines += keep;
      p.revenue += revenue;
      if (cogs !== null) { p.cogs += cogs; p.revenueWithCost += revenue; }
      p.costSource.add(source ?? 'missing');
      if (line.variation_id) p.variationIds.add(line.variation_id);
      if (sku) p.skus.add(sku);
    }

    const day = String(order.date_created_gmt ?? '').slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { day, orders: 0, revenue: 0, cogs: 0, extra: 0, complete: true });
    const d = byDay.get(day);
    d.orders += 1; d.revenue += orderRevenue; d.cogs += orderCogs; d.extra += extra; d.complete &&= orderKnown;

    const a = attributionOf(order);
    attribution[a].orders += 1;
    attribution[a].revenue += orderRevenue;
  }

  const coverage = totals.revenue > 0 ? totals.revenueWithCost / totals.revenue : 0;
  const goodsMargin = totals.revenueWithCost > 0 ? (totals.revenueWithCost - totals.cogs) / totals.revenueWithCost : null;
  // When some products have no cost, the margin of the known ones is applied to the rest (flagged as estimated).
  const goodsProfit = goodsMargin === null ? null : totals.revenue * goodsMargin;
  const profitBeforeAds = goodsProfit === null ? null : goodsProfit - totals.extraCosts;
  const marginAfterCosts = profitBeforeAds !== null && totals.revenue > 0 ? profitBeforeAds / totals.revenue : null;

  const products_ = [...byProduct.values()].map((p) => {
    const margin = p.revenueWithCost > 0 ? (p.revenueWithCost - p.cogs) / p.revenueWithCost : goodsMargin;
    return {
      productId: p.productId, name: p.name, sku: p.sku, units: round(p.units, 1), lines: round(p.lines, 2), revenue: round(p.revenue), categories: p.categories,
      profit: margin === null ? null : round(p.revenue * margin),
      margin: margin === null ? null : round(margin, 3),
      costSource: [...p.costSource].join('+'),
      variationIds: [...p.variationIds], skus: [...p.skus],
    };
  }).sort((a, b) => (b.profit ?? b.revenue) - (a.profit ?? a.revenue));

  const attributionKnown = orders.length > 0 && attribution.unknown.orders < totals.orders;

  return {
    currency: mainCurrency,
    otherCurrencies: [...currencies.keys()].filter((c) => c !== mainCurrency),
    totals: {
      ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, round(v)])),
      costCoverage: round(coverage, 3),
      goodsMargin: goodsMargin === null ? null : round(goodsMargin, 3),
      goodsProfit: round(goodsProfit),
      profitBeforeAds: round(profitBeforeAds),
      marginAfterCosts: marginAfterCosts === null ? null : round(marginAfterCosts, 3),
      profitIsEstimated: coverage < 0.999,
      avgOrderTotal: totals.orders ? round(totals.orderTotal / totals.orders) : null,
      avgOrderRevenue: totals.orders ? round(totals.revenue / totals.orders) : null,
      avgOrderProfit: totals.orders && profitBeforeAds !== null ? round(profitBeforeAds / totals.orders) : null,
    },
    costSources: Object.fromEntries([...costSources.entries()].map(([k, v]) => [k, round(v)])),
    attribution: attributionKnown ? Object.fromEntries(Object.entries(attribution).map(([k, v]) => [k, { orders: v.orders, revenue: round(v.revenue) }])) : null,
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({
      day: d.day, orders: d.orders, revenue: round(d.revenue),
      profitBeforeAds: goodsMargin === null ? null : round(d.revenue * goodsMargin - d.extra),
    })),
    products: products_,
  };
}

// ---------- Google Shopping item id → shop product ----------

const PREFIXES = /^(gla_|woocommerce_gpf_|wc_post_id_|wc_|product_|online:[a-z]{2,3}:[a-z]{2}:)/i;

/**
 * Index of every id a feed plugin may have sent to Google for a sold product: product id, variation id,
 * SKU, "gla_<id>" (Google for WooCommerce), "woocommerce_gpf_<id>" (Product Feed), "<sku>_<id>".
 * Google lower-cases item ids, so the index is lower-case. Ids are matched whole, never partly.
 */
export function itemIndex(products) {
  const index = new Map();
  const add = (key, productId) => { if (key !== '' && key !== null && key !== undefined) index.set(String(key).toLowerCase(), productId); };
  for (const p of products) {
    const ids = [p.productId, ...p.variationIds];
    for (const id of ids) {
      add(id, p.productId); add(`gla_${id}`, p.productId); add(`woocommerce_gpf_${id}`, p.productId);
    }
    for (const sku of [p.sku, ...p.skus].filter(Boolean)) {
      add(sku, p.productId);
      for (const id of ids) add(`${sku}_${id}`, p.productId);
    }
  }
  return index;
}

export function matchItem(index, itemId) {
  const id = String(itemId ?? '').toLowerCase();
  if (index.has(id)) return index.get(id);
  const stripped = id.replace(PREFIXES, '');
  if (stripped !== id && index.has(stripped)) return index.get(stripped);
  return null;
}

/** Orders → products → profit for one range (the whole read path). */
export async function shopProfit(config, range, transport = fetch) {
  const client = new WooClient(config.woo, transport);
  const orders = await fetchOrders(client, range);
  const products = await fetchProductsForOrders(client, orders);
  return computeProfit(orders, products, config, { csv: loadCostCsv() });
}

/** Country of an order: shipping country, else billing country, else null. */
export const orderCountry = (order) => {
  const code = String(order.shipping?.country || order.billing?.country || '').toUpperCase();
  return code ? (code === 'UK' ? 'GB' : code) : null;
};

/** Countries the shop ships to, from its shipping zones. everywhere = the "other locations" zone has an enabled method. */
export async function shippingCountries(client) {
  const { data: zones } = await client.get('shipping/zones');
  const countries = new Set();
  let everywhere = false;
  for (const zone of zones ?? []) {
    const { data: methods } = await client.get(`shipping/zones/${zone.id}/methods`);
    if (!(methods ?? []).some((m) => m.enabled)) continue;
    if (zone.id === 0) { everywhere = true; continue; }
    const { data: locations } = await client.get(`shipping/zones/${zone.id}/locations`);
    for (const c of countriesOfLocations(locations ?? [])) countries.add(c);
  }
  return { countries: [...countries].sort(), everywhere };
}
