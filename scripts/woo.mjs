#!/usr/bin/env node
// WooCommerce, read only.
//   node scripts/woo.mjs profit [--days 30]        orders, revenue, product costs, profit before ads, attribution
//   node scripts/woo.mjs products [--days 90] [--limit 50]   profit per product
//   node scripts/woo.mjs cost-check [--days 90]    which sold products have no cost (profit needs it)
import { loadConfig } from './lib/config.mjs';
import { shopProfit } from './lib/woo.mjs';
import { lastDays, num, parseArgs, pct, printJson, run, table, UserError } from './lib/util.mjs';

const { positional, flags } = parseArgs();
const command = positional[0] ?? 'profit';

run(async () => {
  const config = loadConfig();
  const range = lastDays(num(flags.days, command === 'profit' ? 30 : 90));
  const limit = num(flags.limit, 50);
  const result = await shopProfit(config, range);
  if (flags.json) { printJson(result); return; }
  const t = result.totals;
  const cur = result.currency ?? '';

  switch (command) {
    case 'profit': {
      console.log(`Shop ${range.from} … ${range.to} (${cur})`);
      console.log(table([
        { what: 'paid orders', value: t.orders },
        { what: 'goods revenue (after discounts, no tax/shipping)', value: t.revenue },
        { what: 'product costs', value: t.cogs },
        { what: 'goods margin %', value: pct(t.goodsMargin) },
        { what: 'extra costs (per order + payment fees)', value: t.extraCosts },
        { what: `profit before ads${t.profitIsEstimated ? ' (estimated, see coverage)' : ''}`, value: t.profitBeforeAds },
        { what: 'products with a known cost, % of revenue', value: pct(t.costCoverage) },
        { what: 'average order total (customer paid)', value: t.avgOrderTotal },
        { what: 'average profit per order before ads', value: t.avgOrderProfit },
        { what: 'refunds', value: t.refunds },
      ]));
      if (result.attribution) {
        console.log('\nWhere orders came from (WooCommerce order attribution):');
        console.log(table(Object.entries(result.attribution).map(([source, v]) => ({ source, orders: v.orders, revenue: v.revenue }))));
      } else {
        console.log('\nOrder attribution: not available (needs WooCommerce 8.5+ with Order Attribution enabled).');
      }
      if (t.skippedOtherCurrency) console.log(`\nLeft out ${t.skippedOtherCurrency} orders in other currencies (${result.otherCurrencies.join(', ')}).`);
      break;
    }
    case 'products':
      console.log(`Profit per product ${range.from} … ${range.to} (${cur}), all channels`);
      console.log(table(result.products.slice(0, limit).map((p) => ({ id: p.productId, name: p.name, sku: p.sku, units: p.units, revenue: p.revenue, profit: p.profit, 'margin %': pct(p.margin), cost: p.costSource }))));
      break;
    case 'cost-check': {
      const missing = result.products.filter((p) => p.costSource.includes('missing'));
      console.log(`Cost sources by revenue ${range.from} … ${range.to}:`);
      console.log(table(Object.entries(result.costSources).map(([source, revenue]) => ({ source, revenue, share: `${pct(revenue / (t.revenue || 1))}%` }))));
      if (!missing.length) {
        console.log('\nEvery sold product has a cost. Profit is exact.');
      } else {
        console.log(`\n${missing.length} sold products have no cost (${pct(1 - t.costCoverage)}% of revenue). Top ones:`);
        console.log(table(missing.slice(0, limit).map((p) => ({ id: p.productId, name: p.name, sku: p.sku, revenue: p.revenue }))));
        console.log('\nFix (any one): add costs in WooCommerce (Cost of Goods field or a COGS plugin), put "sku,cost" lines in ~/.google-ads-profit/costs.csv,');
        console.log('or set an average margin: node scripts/setup.mjs set profit.defaultMarginPercent 35');
        if (t.costCoverage >= 0.5) console.log(`Until then the margin of the known products (${pct(t.goodsMargin)}%) is used for the rest.`);
      }
      break;
    }
    default:
      throw new UserError(`Unknown command "${command}".`, 'Use: profit | products | cost-check');
  }
});
