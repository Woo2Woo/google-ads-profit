#!/usr/bin/env node
// Google Search Console, read only. Data lags about 3 days, so ranges end 3 days ago.
//   node scripts/gsc.mjs sites
//   node scripts/gsc.mjs queries [--days 28] [--brand] [--limit 100]   free (organic) Google searches
//   node scripts/gsc.mjs pages [--days 28] [--limit 50]
//   node scripts/gsc.mjs query --body '<searchAnalytics JSON>'
import { loadConfig } from './lib/config.mjs';
import { gscQuery, gscSites } from './lib/google.mjs';
import { brandRegex, lastDays, num, parseArgs, printJson, round, run, table, UserError } from './lib/util.mjs';

const { positional, flags } = parseArgs();
const command = positional[0];

run(async () => {
  const config = loadConfig();
  const range = lastDays(num(flags.days, 28), 3);
  const limit = num(flags.limit, 100);
  const rowsOf = (body) => (body.rows ?? []).map((r) => ({
    key: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions, ctr: round((r.ctr ?? 0) * 100, 1), position: round(r.position, 1),
  }));

  switch (command) {
    case 'sites': {
      const rows = await gscSites();
      if (flags.json) printJson(rows); else console.log(table(rows));
      break;
    }
    case 'queries':
    case 'pages': {
      const body = { startDate: range.from, endDate: range.to, dimensions: [command === 'pages' ? 'page' : 'query'], rowLimit: Math.min(25000, Math.max(limit, 1000)) };
      if (flags.brand) {
        const regex = brandRegex(config.brandTerms ?? []);
        if (!regex) throw new UserError('No brand words set.', 'node scripts/setup.mjs set brandTerms "mybrand, my brand"');
        body.dimensionFilterGroups = [{ filters: [{ dimension: 'query', operator: 'includingRegex', expression: regex }] }];
      }
      const rows = rowsOf(await gscQuery(config.gsc.siteUrl, body));
      if (flags.json) { printJson(rows); break; }
      const clicks = rows.reduce((s, r) => s + r.clicks, 0);
      console.log(`Search Console ${command}${flags.brand ? ' (brand only)' : ''} ${range.from} … ${range.to}: ${clicks} clicks in ${rows.length} rows`);
      console.log(table(rows.slice(0, limit)));
      break;
    }
    case 'query': {
      if (!flags.body) throw new UserError('Usage: node scripts/gsc.mjs query --body \'{"dimensions":["query","country"]}\'');
      const body = { startDate: range.from, endDate: range.to, ...JSON.parse(flags.body) };
      const result = await gscQuery(config.gsc.siteUrl, body);
      printJson(result.rows ?? []);
      break;
    }
    default:
      throw new UserError(`Unknown command "${command ?? ''}".`, 'Use: sites | queries | pages | query');
  }
});
