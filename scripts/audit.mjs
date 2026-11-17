#!/usr/bin/env node
// The profit audit: real shop profit next to Google Ads spend, and where money leaks.
//   node scripts/audit.mjs [--days 30] [--product-days 90] [--account <id>] [--json]
// Prints a summary and saves the full report to ~/.google-ads-profit/reports/.
import path from 'node:path';
import { loadConfig, paths, writePrivateJson } from './lib/config.mjs';
import { accountId, ga4Report, ga4Rows, gscQuery } from './lib/google.mjs';
import { accountInfo, biddableGoals, campaignNegatives, campaigns, dailyTotals, products, searchTerms } from './lib/ads-data.mjs';
import { WooClient, computeProfit, fetchOrders, fetchProductsForOrders, itemIndex, loadCostCsv } from './lib/woo.mjs';
import { brandFindings, breakEven, campaignFindings, productFindings, searchTermFindings, weekly } from './lib/analysis.mjs';
import { readJournal, bigChangeStatus } from './lib/changes.mjs';
import { isoDay, lastDays, num, parseArgs, pct, printJson, round, run, table } from './lib/util.mjs';

const { flags } = parseArgs();

run(async () => {
  const config = loadConfig();
  const account = accountId(config, flags.account);
  const range = lastDays(num(flags.days, 30));
  const productRange = lastDays(Math.max(num(flags['product-days'], 90), range.days));
  const errors = {};
  const optional = async (name, fn) => { try { return await fn(); } catch (error) { errors[name] = error.message; return null; } };

  // Shop: one read of the longer range, the audit range is a subset of it.
  const woo = new WooClient(config.woo);
  const ordersLong = await fetchOrders(woo, productRange);
  const productIndex = await fetchProductsForOrders(woo, ordersLong);
  const csv = loadCostCsv();
  const inRange = (o) => String(o.date_created_gmt ?? '').slice(0, 10) >= range.from;
  const shop = computeProfit(ordersLong.filter(inRange), productIndex, config, { csv });
  const shopLong = computeProfit(ordersLong, productIndex, config, { csv, currency: shop.currency });

  const [info, camps, terms, prods, negatives, days, goals] = await Promise.all([
    accountInfo(config, account),
    campaigns(config, account, range),
    searchTerms(config, account, range),
    products(config, account, productRange),
    campaignNegatives(config, account),
    dailyTotals(config, account, range),
    optional('goals', () => biddableGoals(config, account)),
  ]);

  const gscRange = lastDays(28, 3);
  const gscRows = config.gsc.siteUrl ? await optional('searchConsole', async () => {
    const body = await gscQuery(config.gsc.siteUrl, { startDate: gscRange.from, endDate: gscRange.to, dimensions: ['query'], rowLimit: 5000 });
    return (body.rows ?? []).map((r) => ({ key: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position }));
  }) : null;
  const ga4 = config.ga4.propertyId ? await optional('ga4', async () => ga4Rows(await ga4Report(config.ga4.propertyId, {
    dateRanges: [{ startDate: range.from, endDate: range.to }], dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: ['sessions', 'ecommercePurchases', 'purchaseRevenue'].map((name) => ({ name })),
    orderBys: [{ metric: { metricName: 'purchaseRevenue' }, desc: true }], limit: 20,
  }))) : null;

  const google = days.reduce((s, d) => ({ cost: s.cost + d.cost, conversions: s.conversions + d.conversions, value: s.value + d.value }), { cost: 0, conversions: 0, value: 0 });
  const be = breakEven(shop.totals, google);
  const profitAfterAds = shop.totals.profitBeforeAds === null ? null : shop.totals.profitBeforeAds - google.cost;
  const avgOrderProfit = shop.totals.avgOrderProfit;
  const findings = campaignFindings(camps, be, { avgOrderProfit });
  const productReport = productFindings(prods, shopLong.products, itemIndex(shopLong.products), { avgOrderProfit: shopLong.totals.avgOrderProfit });
  const termReport = searchTermFindings(terms, { brandTerms: config.brandTerms, protectedTerms: config.protectedTerms, negatives, avgOrderProfit });
  const brand = config.brandTerms.length ? brandFindings(terms, gscRows ?? [], config.brandTerms) : null;
  const weeks = weekly(shop.byDay, days);
  const nonPurchaseBiddable = (goals ?? []).filter((g) => g.biddable && !/PURCHASE/.test(String(g.category)));
  const journal = readJournal();
  const discipline = bigChangeStatus(journal, account, config.limits.bigChangeCooldownDays);

  const report = {
    generated: new Date().toISOString(), account: info, range, productRange,
    currency: { ads: info.currency, shop: shop.currency, mismatch: Boolean(info.currency && shop.currency && info.currency !== shop.currency) },
    summary: {
      shopOrders: shop.totals.orders, shopRevenue: shop.totals.revenue, profitBeforeAds: shop.totals.profitBeforeAds,
      profitIsEstimated: shop.totals.profitIsEstimated, costCoverage: shop.totals.costCoverage, marginAfterCosts: shop.totals.marginAfterCosts,
      adCost: round(google.cost), googleConversions: round(google.conversions, 1), googleValue: round(google.value), googleRoas: google.cost ? round(google.value / google.cost) : null,
      profitAfterAds: round(profitAfterAds), adShareOfProfit: shop.totals.profitBeforeAds > 0 ? round(google.cost / shop.totals.profitBeforeAds, 3) : null,
      breakEven: be, avgOrderProfit,
      googleSeesShare: shop.attribution?.google_ads?.orders ? round(google.conversions / shop.attribution.google_ads.orders, 2) : null,
    },
    shop, weeks, campaigns: camps, campaignFindings: findings, products: productReport, searchTerms: termReport, brand,
    ga4Channels: ga4, nonPurchaseBiddableGoals: nonPurchaseBiddable, discipline, errors,
  };
  const file = path.join(paths.reports, `audit-${isoDay()}-${account}.json`);
  writePrivateJson(file, report);
  if (flags.json) { printJson(report); return; }

  const s = report.summary;
  const cur = shop.currency ?? info.currency;
  console.log(`PROFIT AUDIT — ${info.name || account} — ${range.from} … ${range.to} (${range.days} days, ${cur})`);
  if (report.currency.mismatch) console.log(`!! Google Ads is in ${info.currency}, the shop in ${shop.currency}: compare with care.`);
  const lines = [
    ['Shop paid orders', s.shopOrders],
    ['Goods revenue (no tax, no shipping)', s.shopRevenue],
    [`Profit before ads${s.profitIsEstimated ? ` (ESTIMATED: costs known for ${pct(s.costCoverage)}% of revenue)` : ''}`, s.profitBeforeAds],
    ['Google Ads spend', s.adCost],
    ['PROFIT AFTER ADS', s.profitAfterAds],
    ['Ads took this share of the profit', s.adShareOfProfit === null ? null : `${pct(s.adShareOfProfit)}%`],
    ['Google conversions / value / ROAS', `${s.googleConversions} / ${s.googleValue} / ${s.googleRoas}`],
    [`Break-even ROAS (${be?.basis ?? '?'} basis; if Google values = goods ${be?.ifValueIsGoods}, = order total ${be?.ifValueIsOrderTotal})`, be?.roas ?? null],
    ['Average profit per order before ads', avgOrderProfit],
  ];
  for (const [label, value] of lines) console.log(`  ${label}: ${value ?? '–'}`);
  if (shop.attribution) {
    const a = shop.attribution;
    console.log(`Shop attribution: Google Ads ${a.google_ads.orders} orders, Google organic ${a.google_organic.orders}, other ${a.other.orders}, unknown ${a.unknown.orders}.`
      + (s.googleSeesShare !== null ? ` Google Ads reports ${s.googleConversions} conversions (${round(s.googleSeesShare * 100, 0)}% of the orders the shop attributes to it).` : ''));
  }

  console.log('\nWEEKS (profit after ads)');
  console.log(table(weeks));

  console.log('\nCAMPAIGNS (by spend)');
  console.log(table(camps.filter((c) => c.cost > 0 || c.status === 'ENABLED').slice(0, 20).map((c) => ({
    id: c.id, name: c.name, type: c.type, bidding: c.bidding, tROAS: c.targetRoas ? `${round(c.targetRoas * 100, 0)}%` : null, budget: c.budget, cost: c.cost, conv: c.conversions,
    roas: c.roas, 'vs BE': be && c.roas !== null ? round(c.roas / be.roas) : null,
  }))));
  console.log('\nCAMPAIGN FINDINGS');
  console.log(findings.length ? findings.map((f) => `- [${f.size}] ${f.campaign} (${f.campaignId}): ${f.text}`).join('\n') : '(none)');

  console.log(`\nPRODUCTS ${productRange.from} … ${productRange.to}: Google item ids matched to shop products — ${productReport.matching.reliable ? 'reliable' : 'NOT reliable'}`
    + ` (${productReport.matching.convItemsMatched}/${productReport.matching.convItems} converting items, ${pct(productReport.matching.costMatchedShare)}% of spend)`);
  if (!productReport.matching.reliable) console.log('  Product judgements are skipped: the feed item ids do not match shop ids/SKUs. Look at a few item ids (ads.mjs products) and the shop products.');
  console.log(`Products that spent ≥ ${productReport.minSpendForLoss} with ≥ 100 clicks, < 2 Google conversions and shop profit < half the spend (shopProfit – = no shop sale found):`);
  console.log(table(productReport.losers.slice(0, 15), ['productId', 'title', 'adCost', 'clicks', 'googleConv', 'shopUnits', 'shopProfit']));
  console.log('Profitable products that got no ad spend:');
  console.log(table(productReport.sellsWithoutAds));

  console.log(`\nSEARCH TERMS: ${termReport.zeroConversionCost} of ${termReport.totalCost} (${pct(termReport.zeroConversionShare)}%) spent on terms with no conversion.`);
  console.log(`Candidates (≥ ${termReport.minCost} spent, no conversion, no brand word, not yet negative) — classify each before proposing a negative:`);
  console.log(table(termReport.candidates.slice(0, 30), ['term', 'campaign', 'campaignId', 'cost', 'clicks', 'protectedWord']));

  if (brand) {
    console.log(`\nBRAND: paid brand searches ${brand.paidBrand.cost} (${brand.paidBrand.clicks} clicks, ${brand.paidBrand.conversions} conv); `
      + `free brand clicks ${brand.organicBrand.clicks} at average position ${brand.organicBrand.avgPosition ?? '–'} (Search Console).`);
    if (brand.paidButWinningOrganically.length) {
      console.log('Paid queries where you are already top 3 organically:');
      console.log(table(brand.paidButWinningOrganically.slice(0, 10)));
    }
  } else {
    console.log('\nBRAND: brand words not set (node scripts/setup.mjs set brandTerms "mybrand, my brand").');
  }
  if (ga4) { console.log('\nGA4 channels (last click):'); console.log(table(ga4.slice(0, 8))); }
  if (nonPurchaseBiddable.length) {
    console.log(`\n!! Smart Bidding also counts non-purchase goals: ${nonPurchaseBiddable.map((g) => `${g.category}/${g.origin}`).join(', ')} — this inflates conversions and ROAS.`);
  }
  console.log(`\nCHANGE DISCIPLINE: ${discipline.text}`);
  for (const [name, message] of Object.entries(errors)) console.log(`(${name} skipped: ${message})`);
  console.log(`\nFull report: ${file}`);
});
