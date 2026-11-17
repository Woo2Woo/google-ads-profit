import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WooClient, attributionOf, computeProfit, itemIndex, loadCostCsv, matchItem } from '../scripts/lib/woo.mjs';
import { TEMPLATE } from '../scripts/lib/config.mjs';

const config = (over = {}) => ({ ...structuredClone(TEMPLATE), ...over });
const meta = (pairs) => Object.entries(pairs).map(([key, value]) => ({ key, value }));

const order = (id, { status = 'completed', currency = 'EUR', day = '2026-11-01', total, lines, refunds = [], attribution = null }) => ({
  id, status, currency, date_created_gmt: `${day}T10:00:00`, total: String(total), total_tax: '0', shipping_total: '5',
  line_items: lines, refunds, meta_data: attribution ? meta(attribution) : [],
});

test('profit uses order-line cost first, then costs.csv, then product cost, then the default margin', () => {
  const products = new Map([
    [10, { id: 10, sku: 'A', name: 'Alpha', meta_data: meta({ _wc_cog_cost: '30' }) }],
    [20, { id: 20, sku: 'B', name: 'Beta', meta_data: [] }],
    [30, { id: 30, sku: 'C', name: 'Gamma', meta_data: [] }],
    [31, { id: 31, parent_id: 30, sku: 'C-RED', meta_data: [] }],
  ]);
  const orders = [
    order(1, { total: 125, lines: [{ product_id: 10, variation_id: 0, quantity: 2, total: '100', meta_data: meta({ _wc_cog_item_cost: '20' }) }] }),
    order(2, { total: 65, lines: [{ product_id: 20, variation_id: 0, quantity: 1, total: '60', sku: 'B', meta_data: [] }] }),
    order(3, { total: 45, lines: [{ product_id: 30, variation_id: 31, quantity: 1, total: '40', sku: 'C-RED', meta_data: [] }] }),
    order(4, { status: 'cancelled', total: 999, lines: [{ product_id: 10, quantity: 1, total: '999' }] }),
  ];
  const csv = new Map([['B', 15]]);
  const r = computeProfit(orders, products, config(), { csv });
  assert.equal(r.totals.orders, 3);
  assert.equal(r.totals.skippedStatus, 1);
  assert.equal(r.totals.revenue, 200);
  // line cost 2×20=40 (not product's 30), csv 15, Gamma has no cost
  assert.equal(r.totals.cogs, 55);
  assert.equal(r.totals.costCoverage, 0.8);
  assert.equal(r.totals.goodsMargin, round3((160 - 55) / 160));
  assert.equal(r.totals.profitIsEstimated, true);
  assert.equal(r.costSources.missing, 40);

  const withDefault = computeProfit(orders, products, config({ profit: { defaultMarginPercent: 50, extraCostPerOrder: 2, paymentFeePercent: 0 } }), { csv });
  assert.equal(withDefault.totals.cogs, 75);
  assert.equal(withDefault.totals.costCoverage, 1);
  assert.equal(withDefault.totals.extraCosts, 6);
  assert.equal(withDefault.totals.profitBeforeAds, 200 - 75 - 6);
});

test('partial refunds reduce revenue and cost proportionally; other currencies are left out', () => {
  const products = new Map([[10, { id: 10, sku: 'A', meta_data: meta({ _wc_cog_cost: '10' }) }]]);
  const orders = [
    order(1, { total: 100, refunds: [{ id: 9, total: '-50' }], lines: [{ product_id: 10, quantity: 2, total: '100', meta_data: [] }] }),
    order(2, { total: 100, lines: [{ product_id: 10, quantity: 2, total: '100', meta_data: [] }] }),
    order(3, { currency: 'USD', total: 100, lines: [{ product_id: 10, quantity: 2, total: '100', meta_data: [] }] }),
  ];
  const r = computeProfit(orders, products, config());
  assert.equal(r.currency, 'EUR');
  assert.equal(r.totals.skippedOtherCurrency, 1);
  assert.equal(r.totals.revenue, 150);
  assert.equal(r.totals.cogs, 30);
  assert.equal(r.totals.refunds, 50);
});

test('order attribution: Google Ads, Google organic, other, unknown', () => {
  assert.equal(attributionOf({ meta_data: meta({ _wc_order_attribution_source_type: 'utm', _wc_order_attribution_utm_source: 'google', _wc_order_attribution_utm_medium: 'cpc' }) }), 'google_ads');
  assert.equal(attributionOf({ meta_data: meta({ _wc_order_attribution_source_type: 'organic', _wc_order_attribution_utm_source: 'google' }) }), 'google_organic');
  assert.equal(attributionOf({ meta_data: meta({ _wc_order_attribution_source_type: 'typein' }) }), 'other');
  assert.equal(attributionOf({ meta_data: [] }), 'unknown');
});

test('Google item ids match shop products whole, through the common feed formats', () => {
  const index = itemIndex([{ productId: 30, sku: 'Hat-1', variationIds: [31, 32], skus: ['HAT-1-RED'] }]);
  assert.equal(matchItem(index, 'gla_31'), 30);
  assert.equal(matchItem(index, 'woocommerce_gpf_30'), 30);
  assert.equal(matchItem(index, 'hat-1-red'), 30);
  assert.equal(matchItem(index, 'HAT-1'), 30);
  assert.equal(matchItem(index, 'hat-1-red_31'), 30);
  assert.equal(matchItem(index, '3'), null);
  assert.equal(matchItem(index, 'gla_310'), null);
});

test('costs.csv: header, separators and decimal commas', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gap-')), 'costs.csv');
  fs.writeFileSync(file, 'sku,cost\nA-1,12.5\nB-2;7,25\n# note\n55,3\n');
  const map = loadCostCsv(file);
  assert.deepEqual([...map.entries()], [['A-1', 12.5], ['B-2', 7.25], ['55', 3]]);
});

test('WooClient pages through results and falls back to query auth when the host strips Authorization', async () => {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url: String(url), auth: Boolean(init.headers.authorization) });
    if (init.headers.authorization) return new Response('{"code":"woocommerce_rest_cannot_view"}', { status: 401 });
    const page = Number(new URL(url).searchParams.get('page'));
    const rows = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i })) : [{ id: 100 }];
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'x-wp-totalpages': '2', 'x-wp-total': '101' } });
  };
  const client = new WooClient({ url: 'https://shop.test/', consumerKey: 'ck_123456', consumerSecret: 'cs_123456' }, transport);
  const rows = await client.getAll('orders', {});
  assert.equal(rows.length, 101);
  assert.equal(calls[0].auth, true);
  assert.ok(calls.slice(1).every((c) => !c.auth && c.url.includes('consumer_key=ck_123456')));
});

test('WooClient refuses plain http (keys travel with every request)', () => {
  assert.throws(() => new WooClient({ url: 'http://shop.test', consumerKey: 'a', consumerSecret: 'b' }), /https/);
});

function round3(n) { return Math.round(n * 1000) / 1000; }
