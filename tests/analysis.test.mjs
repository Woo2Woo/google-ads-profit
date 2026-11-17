import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandFindings, breakEven, campaignFindings, productFindings, searchTermFindings, weekly } from '../scripts/lib/analysis.mjs';
import { itemIndex } from '../scripts/lib/woo.mjs';

const shopTotals = { marginAfterCosts: 0.4, avgOrderTotal: 120, avgOrderRevenue: 100 };

test('break-even picks the basis Google values are closest to', () => {
  const total = breakEven(shopTotals, { conversions: 10, value: 1180 });
  assert.equal(total.basis, 'order-total');
  assert.equal(total.roas, 3);
  const goods = breakEven(shopTotals, { conversions: 10, value: 1010 });
  assert.equal(goods.basis, 'goods');
  assert.equal(goods.roas, 2.5);
  assert.equal(breakEven({ ...shopTotals, marginAfterCosts: -0.1 }, { conversions: 0, value: 0 }), null);
});

const campaign = (over) => ({
  id: '1', name: 'C', status: 'ENABLED', type: 'SHOPPING', bidding: 'MAXIMIZE_CONVERSION_VALUE', portfolio: false, targetRoas: null,
  geo: 'PRESENCE', searchPartners: false, budget: 50, budgetShared: false, cost: 0, value: 0, conversions: 0,
  budgetLostIs: 0, rankLostIs: 0, impressions7: 100, ...over,
});

test('campaign findings: loss, budget-limited winner, rank-limited winner, not serving', () => {
  const be = { roas: 3 };
  const found = campaignFindings([
    campaign({ id: 'loss', cost: 400, value: 600, conversions: 6 }),
    campaign({ id: 'win', bidding: 'TARGET_ROAS', targetRoas: 4, cost: 1000, value: 5000, conversions: 30, budgetLostIs: 0.3 }),
    campaign({ id: 'rank', bidding: 'TARGET_ROAS', targetRoas: 8, cost: 1000, value: 7000, conversions: 40, budgetLostIs: 0.01, rankLostIs: 0.5 }),
    campaign({ id: 'dead', impressions7: 0 }),
    campaign({ id: 'small', cost: 50, value: 20, conversions: 1 }),
  ], be, { avgOrderProfit: 40 });
  const kinds = found.map((f) => `${f.campaignId}:${f.kind}`);
  assert.ok(kinds.includes('loss:below_break_even'));
  assert.match(found.find((f) => f.campaignId === 'loss').text, /first target ROAS of 180%/);
  assert.ok(kinds.includes('win:budget_limited_profitable'));
  assert.ok(kinds.includes('rank:rank_limited_very_profitable'));
  assert.ok(kinds.includes('dead:not_serving'));
  assert.ok(!kinds.some((k) => k.startsWith('small:below')), 'spend below 3 × order profit is not judged');
});

test('products: a loser needs spend, clicks, no Google sales AND little shop profit; unreliable matching flags nothing', () => {
  const shop = [
    { productId: 1, name: 'Seller', units: 10, revenue: 1000, profit: 400, variationIds: [], skus: ['S'], sku: 'S' },
    { productId: 2, name: 'Gateway', units: 1, revenue: 100, profit: 40, variationIds: [], skus: ['G'], sku: 'G' },
    { productId: 3, name: 'Quiet winner', units: 5, revenue: 500, profit: 200, variationIds: [], skus: ['Q'], sku: 'Q' },
  ];
  const ads = [
    { itemId: 'gla_1', title: 'Seller', cost: 200, clicks: 300, conversions: 8, value: 900 },
    { itemId: 'gla_2', title: 'Gateway', cost: 150, clicks: 200, conversions: 1, value: 100 },
    { itemId: 'gla_4', title: 'Never sold', cost: 180, clicks: 250, conversions: 0, value: 0 },
    { itemId: 'gla_5', title: 'B', cost: 10, clicks: 5, conversions: 1, value: 50 },
    { itemId: 'gla_6', title: 'C', cost: 10, clicks: 5, conversions: 1, value: 50 },
  ];
  const r = productFindings(ads, shop, itemIndex(shop), { avgOrderProfit: 40 });
  // converting items: gla_1 (matched), gla_5, gla_6 (unmatched) → 1/3 → not reliable
  assert.equal(r.matching.reliable, false);
  assert.equal(r.losers.length, 0);

  const ads2 = ads.filter((a) => !['gla_5', 'gla_6'].includes(a.itemId));
  const r2 = productFindings(ads2, shop, itemIndex(shop), { avgOrderProfit: 40 });
  assert.equal(r2.matching.reliable, true);
  assert.deepEqual(r2.losers.map((p) => p.title), ['Never sold', 'Gateway']);
  assert.deepEqual(r2.sellsWithoutAds.map((p) => p.name), ['Quiet winner']);
});

test('search terms: brand words never become candidates, existing negatives are skipped', () => {
  const terms = [
    { campaignId: '1', campaign: 'S', term: 'acme headset', cost: 30, clicks: 20, conversions: 0, value: 0 },
    { campaignId: '1', campaign: 'S', term: 'free headset pdf', cost: 25, clicks: 30, conversions: 0, value: 0 },
    { campaignId: '1', campaign: 'S', term: 'cheap earmuffs', cost: 20, clicks: 10, conversions: 0, value: 0 },
    { campaignId: '1', campaign: 'S', term: 'old negative', cost: 20, clicks: 10, conversions: 0, value: 0 },
    { campaignId: '1', campaign: 'S', term: 'buy headset', cost: 40, clicks: 10, conversions: 3, value: 300 },
  ];
  const r = searchTermFindings(terms, { brandTerms: ['acme'], protectedTerms: ['earmuffs'], negatives: [{ campaignId: '1', text: 'old negative' }], avgOrderProfit: 40 });
  assert.deepEqual(r.candidates.map((t) => t.term), ['free headset pdf', 'cheap earmuffs']);
  assert.equal(r.candidates[1].protectedWord, true);
  assert.equal(r.zeroConversionCost, 95);
  assert.deepEqual(r.converting.map((t) => t.term), ['buy headset']);
});

test('brand: paid vs organic, and paid queries already won organically', () => {
  const terms = [
    { campaignId: '1', campaign: 'Brand', term: 'acme', cost: 50, clicks: 100, conversions: 5, value: 500 },
    { campaignId: '2', campaign: 'Generic', term: 'ear defenders', cost: 80, clicks: 60, conversions: 1, value: 90 },
  ];
  const gsc = [
    { key: 'acme', clicks: 300, impressions: 1000, position: 1.1 },
    { key: 'ear defenders', clicks: 40, impressions: 900, position: 2.4 },
  ];
  const r = brandFindings(terms, gsc, ['acme']);
  assert.equal(r.paidBrand.cost, 50);
  assert.equal(r.organicBrand.clicks, 300);
  assert.equal(r.paidButWinningOrganically[0].term, 'ear defenders');
});

test('weekly profit after ads', () => {
  const w = weekly(
    [{ day: '2026-11-02', orders: 2, revenue: 200, profitBeforeAds: 80 }, { day: '2026-11-09', orders: 1, revenue: 100, profitBeforeAds: 40 }],
    [{ day: '2026-11-03', cost: 30, conversions: 1 }, { day: '2026-11-10', cost: 50, conversions: 0 }],
  );
  assert.deepEqual(w.map((x) => [x.week, x.profitAfterAds]), [['2026-11-02', 50], ['2026-11-09', -10]]);
});
