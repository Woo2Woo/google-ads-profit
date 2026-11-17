import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversionEstimate, judgeMarket, productGroups, relevantIdeas, verdict, weightedCpc } from '../scripts/lib/market-economics.mjs';
import { cleanPhrase, convert } from '../scripts/lib/keywords.mjs';
import { countriesOfLocations } from '../scripts/lib/countries.mjs';

test('conversion rate: measured from non-brand terms, scaled for purchases Google missed, else 1 %', () => {
  assert.equal(conversionEstimate({ clicks: 50, conversions: 1 }).rate, 0.01);
  assert.equal(conversionEstimate({ clicks: 1000, conversions: 15 }).rate, 0.015);
  assert.equal(conversionEstimate({ clicks: 1000, conversions: 15, shopAdsOrders: 30, googleConversions: 20 }).rate, 0.0225);
  assert.equal(conversionEstimate({ clicks: 1000, conversions: 15, shopAdsOrders: 90, googleConversions: 20 }).rate, 0.03, 'capped at × 2');
  assert.equal(conversionEstimate({ override: 0.02 }).rate, 0.02);
});

test('ideas must share a real word with the seeds', () => {
  const ideas = [
    { keyword: 'aktiver gehörschutz kaufen', volume: 500 },
    { keyword: 'gehörschutz', volume: 0 },
    { keyword: 'kopfhörer bluetooth', volume: 9000 },
    { keyword: 'aktiver gehörschutz', volume: 900 },
  ];
  assert.deepEqual(relevantIdeas(['aktiver gehörschutz'], ideas).map((i) => i.keyword), ['aktiver gehörschutz kaufen']);
});

test('CPC is weighted by searches; midpoint of top-of-page bids when no average', () => {
  assert.equal(weightedCpc([{ volume: 100, cpcAvg: 1 }, { volume: 300, cpcLow: 0.2, cpcHigh: 0.6, cpcAvg: null }, { volume: 0, cpcAvg: 9 }]), 0.55);
  assert.equal(weightedCpc([{ volume: 0, cpcAvg: 1 }]), null);
});

test('product groups and the market judgement', () => {
  const groups = productGroups([
    { name: 'A', categories: ['Headsets'], units: 10, lines: 10, revenue: 1000, profit: 500 },
    { name: 'B', categories: ['Headsets'], units: 5, lines: 5, revenue: 500, profit: 250 },
    { name: 'C', categories: ['Plugs'], units: 4, lines: 4, revenue: 40, profit: 10 },
  ]);
  assert.equal(groups[0].group, 'Headsets');
  assert.equal(groups[0].profitPerSale, 50);
  const ctx = {
    shopGroups: groups, shopAverage: { profitPerSale: 40, revenuePerSale: 80 }, conversion: { rate: 0.02 },
    profit: { extraCostPerOrder: 5, paymentFeePercent: 0 }, settings: { minMonthlySearches: 300, clickShare: 0.1, siteLanguages: ['de'], extraCostByCountry: { AT: 5 } },
    country: { ships: true }, language: 'de',
  };
  const de = judgeMarket('DE', [
    { group: 'Headsets', rows: [{ keyword: 'x', volume: 1000, cpcAvg: 0.4 }] },
    { group: 'Plugs', rows: [{ keyword: 'y', volume: 800, cpcAvg: 0.3 }] },
  ], ctx);
  // Headsets: value 50 − 5 = 45, break-even 0.9, reserve 56 %; Plugs: value 2.5 − 5 < 0 → does not pay, left out.
  assert.equal(de.groups[0].breakEvenCpc, 0.9);
  assert.equal(de.payingGroups, '1/2');
  assert.equal(de.verdict, 'worth a test');
  assert.equal(de.estProfitMonth, 50);
  const at = judgeMarket('AT', [{ group: 'Headsets', rows: [{ keyword: 'x', volume: 1000, cpcAvg: 0.4 }] }], ctx);
  assert.equal(at.groups[0].breakEvenCpc, 0.8, 'extra shipping cost to AT lowers the break-even');
  const pl = judgeMarket('PL', [{ group: 'Headsets', rows: [{ keyword: 'x', volume: 1000, cpcAvg: 0.4 }] }], { ...ctx, language: 'pl' });
  assert.equal(pl.groups[0].breakEvenCpc, 0.45, 'site not in Polish halves the conversion rate');
  const unknown = judgeMarket('DE', [{ group: 'Gloves', rows: [{ keyword: 'z', volume: 1000, cpcAvg: 0.1 }] }], ctx);
  assert.equal(unknown.groups[0].profitFrom, 'shop average');
  assert.equal(verdict({ volume: 100, reserve: 0.9, minVolume: 300, ships: true }), 'too little demand');
  assert.equal(verdict({ volume: 1000, reserve: 0.9, minVolume: 300, ships: false }), 'not shipped there');
});

test('phrases, currencies and shipping zones', () => {
  assert.equal(cleanPhrase('  Gehörschutz, Aktiv!  '), 'gehörschutz aktiv');
  assert.equal(cleanPhrase('a '.repeat(11)), null);
  const rates = { EUR: 1, USD: 1.1, PLN: 4.3 };
  assert.equal(Math.round(convert(1.1, 'USD', 'EUR', rates) * 100) / 100, 1);
  assert.equal(Math.round(convert(1, 'EUR', 'PLN', rates) * 100) / 100, 4.3);
  const set = countriesOfLocations([{ type: 'country', code: 'DE' }, { type: 'state', code: 'US:CA' }, { type: 'continent', code: 'OC' }, { type: 'postcode', code: '10*' }]);
  assert.deepEqual([...set].sort(), ['AU', 'DE', 'NZ', 'US']);
});
