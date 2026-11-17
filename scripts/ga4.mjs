#!/usr/bin/env node
// Google Analytics 4, read only.
//   node scripts/ga4.mjs properties                 GA4 properties this Google login can see
//   node scripts/ga4.mjs channels [--days 30]       sessions, purchases, revenue per channel
//   node scripts/ga4.mjs ads-campaigns [--days 30]  the same per Google Ads campaign (GA4's view)
//   node scripts/ga4.mjs landing-pages [--days 30] [--limit 50]
//   node scripts/ga4.mjs report --body '<runReport JSON>'
import { loadConfig } from './lib/config.mjs';
import { ga4Properties, ga4Report, ga4Rows } from './lib/google.mjs';
import { lastDays, num, parseArgs, printJson, run, table, UserError } from './lib/util.mjs';

const { positional, flags } = parseArgs();
const command = positional[0];

const METRICS = ['sessions', 'ecommercePurchases', 'purchaseRevenue'].map((name) => ({ name }));

run(async () => {
  const config = loadConfig();
  const range = lastDays(num(flags.days, 30));
  const limit = num(flags.limit, 50);
  const dateRanges = [{ startDate: range.from, endDate: range.to }];
  const show = (rows, title) => {
    if (flags.json) return printJson(rows);
    console.log(`${title} ${range.from} … ${range.to}`);
    console.log(table(rows.slice(0, limit)));
  };
  const byDimension = async (dimension, title, extra = {}) => {
    const report = await ga4Report(config.ga4.propertyId, {
      dateRanges, dimensions: [{ name: dimension }], metrics: METRICS,
      orderBys: [{ metric: { metricName: 'purchaseRevenue' }, desc: true }], limit: 1000, ...extra,
    });
    show(ga4Rows(report), title);
  };

  switch (command) {
    case 'properties': {
      const rows = await ga4Properties();
      if (flags.json) printJson(rows); else console.log(table(rows));
      break;
    }
    case 'channels':
      await byDimension('sessionDefaultChannelGroup', 'GA4 by channel (last click)');
      break;
    case 'ads-campaigns':
      await byDimension('sessionGoogleAdsCampaignName', 'GA4 by Google Ads campaign');
      break;
    case 'landing-pages':
      await byDimension('landingPage', 'GA4 by landing page');
      break;
    case 'report': {
      if (!flags.body) throw new UserError('Usage: node scripts/ga4.mjs report --body \'{"dimensions":[...],"metrics":[...]}\'');
      const body = JSON.parse(flags.body);
      body.dateRanges ??= dateRanges;
      const rows = ga4Rows(await ga4Report(config.ga4.propertyId, body));
      if (flags.json) printJson(rows); else console.log(table(rows.slice(0, limit)));
      break;
    }
    default:
      throw new UserError(`Unknown command "${command ?? ''}".`, 'Use: properties | channels | ads-campaigns | landing-pages | report');
  }
});
