#!/usr/bin/env node
// In which markets does advertising the shop's products pay?
//
//   node scripts/markets.mjs overview [--days 365]
//        Free. Where the shop sells, ships and is found (orders, shipping zones, Search Console, Google Ads
//        by country), product groups with profit per sale, and the conversion rate to plan with.
//        Saves ~/.google-ads-profit/markets-context.json.
//   (Claude then writes ~/.google-ads-profit/market-seeds.json: buyer phrases per market in its language.)
//   node scripts/markets.mjs sources
//        Which search-data source works: Google Keyword Planner (free, needs Basic access) or DataForSEO (paid).
//   node scripts/markets.mjs research [--seeds <file>] [--source auto|planner|dataforseo] [--expand 30] [--yes]
//        Searches, click prices and competition per market → break-even CPC, reserve, rough monthly profit,
//        verdict. DataForSEO: prints the cost first and runs only with --yes (after the user agreed).
import path from 'node:path';
import { loadConfig, paths, readJson, writePrivateJson } from './lib/config.mjs';
import { accountId, adsSearch, gscQuery } from './lib/google.mjs';
import { accountInfo } from './lib/ads-data.mjs';
import { WooClient, attributionOf, computeProfit, fetchOrders, fetchProductsForOrders, loadCostCsv, orderCountry, shippingCountries } from './lib/woo.mjs';
import { byAlpha3, byGeo, COUNTRIES } from './lib/countries.mjs';
import { conversionEstimate, judgeMarket, productGroups, rankMarkets, relevantIdeas } from './lib/market-economics.mjs';
import {
  cleanPhrase, convert, dataforseoConfigured, DFS_USD_PER_TASK, dfsIdeas, dfsMetrics, fxRates, openCache, plannerIdeas, plannerLanguageIds,
  plannerMetrics, plannerStatus, spentToday,
} from './lib/keywords.mjs';
import { containsAny, isoDay, lastDays, micros, num, parseArgs, pct, printJson, round, run, table, UserError } from './lib/util.mjs';

const { positional, flags } = parseArgs();
const command = positional[0];

async function overview(config) {
  const account = accountId(config, flags.account);
  const range = lastDays(num(flags.days, 365));
  const recent = lastDays(90);
  const errors = {};
  const optional = async (name, fn) => { try { return await fn(); } catch (error) { errors[name] = error.message; return null; } };

  const woo = new WooClient(config.woo);
  const orders = await fetchOrders(woo, range);
  const products = await fetchProductsForOrders(woo, orders);
  const shop = computeProfit(orders, products, config, { csv: loadCostCsv() });
  const groups = productGroups(shop.products);
  const t = shop.totals;
  const shopAverage = {
    group: 'shop average', profitPerSale: t.orders && t.goodsProfit !== null ? round(t.goodsProfit / t.orders) : null,
    revenuePerSale: t.orders ? round(t.revenue / t.orders) : null,
  };
  if (shopAverage.profitPerSale === null) throw new UserError('No profit per order yet — product costs are missing.', 'Run node scripts/woo.mjs cost-check and add costs (or profit.defaultMarginPercent).');

  const paid = new Set(config.woo.paidStatuses);
  const countries = {};
  const country = (cc) => (countries[cc] ??= { orders: 0, revenue: 0, gscClicks: 0, gscImpressions: 0, adsCost: 0, adsConversions: 0, ships: null });
  for (const o of orders) {
    if (!paid.has(o.status) || o.currency !== shop.currency) continue;
    const cc = orderCountry(o) ?? '??';
    country(cc).orders += 1;
    country(cc).revenue += (o.line_items ?? []).reduce((s, l) => s + num(l.total), 0);
  }

  const shipping = await optional('shippingZones', () => shippingCountries(woo));
  if (shipping) for (const cc of Object.keys(COUNTRIES)) country(cc).ships = shipping.everywhere || shipping.countries.includes(cc);

  if (config.gsc.siteUrl) {
    await optional('searchConsole', async () => {
      const body = await gscQuery(config.gsc.siteUrl, { startDate: lastDays(90, 3).from, endDate: lastDays(90, 3).to, dimensions: ['country'], rowLimit: 300 });
      for (const r of body.rows ?? []) {
        const cc = byAlpha3.get(String(r.keys[0]).toLowerCase());
        if (cc) { country(cc).gscClicks += r.clicks; country(cc).gscImpressions += r.impressions; }
      }
    });
  }

  const info = await accountInfo(config, account);
  const between = `segments.date BETWEEN '${recent.from}' AND '${recent.to}'`;
  await optional('adsByCountry', async () => {
    const rows = await adsSearch(config, account, `SELECT geographic_view.country_criterion_id, metrics.cost_micros, metrics.conversions
      FROM geographic_view WHERE ${between}`);
    for (const r of rows) {
      const cc = byGeo.get(Number(r.geographicView.countryCriterionId));
      if (cc) { country(cc).adsCost += micros(r.metrics.costMicros); country(cc).adsConversions += Number(r.metrics.conversions ?? 0); }
    }
  });
  const terms = await optional('searchTerms', () => adsSearch(config, account, `SELECT search_term_view.search_term, metrics.clicks, metrics.conversions
    FROM search_term_view WHERE ${between} AND metrics.clicks > 0`));
  const nonBrand = (terms ?? []).filter((r) => !containsAny(r.searchTermView.searchTerm, config.brandTerms));
  const googleTotal = await optional('adsTotals', async () => (await adsSearch(config, account, `SELECT metrics.conversions FROM customer WHERE ${between}`))
    .reduce((s, r) => s + Number(r.metrics.conversions ?? 0), 0));
  const shopAdsOrders = orders.filter((o) => paid.has(o.status) && String(o.date_created_gmt).slice(0, 10) >= recent.from && attributionOf(o) === 'google_ads').length;
  const conversion = conversionEstimate({
    clicks: nonBrand.reduce((s, r) => s + Number(r.metrics.clicks ?? 0), 0),
    conversions: nonBrand.reduce((s, r) => s + Number(r.metrics.conversions ?? 0), 0),
    shopAdsOrders: shopAdsOrders || null, googleConversions: googleTotal, override: config.markets.conversionRate,
  });

  const context = {
    generated: new Date().toISOString(), range, currency: shop.currency, adsCurrency: info.currency,
    shopAverage, groups, conversion, shipping, profit: config.profit,
    countries: Object.fromEntries(Object.entries(countries).map(([cc, c]) => [cc, { ...c, revenue: round(c.revenue), adsCost: round(c.adsCost), adsConversions: round(c.adsConversions, 1) }])),
    errors,
  };
  writePrivateJson(paths.marketsContext, context);
  if (flags.json) { printJson(context); return; }

  const rows = Object.entries(context.countries)
    .filter(([cc, c]) => cc !== '??' && (c.orders || c.gscImpressions || c.adsCost || c.ships))
    .map(([cc, c]) => ({ country: cc, name: COUNTRIES[cc]?.name ?? '', ships: c.ships === null ? '?' : c.ships ? 'yes' : 'no', orders: c.orders, revenue: c.revenue, 'GSC impr. 90d': c.gscImpressions, 'GSC clicks': c.gscClicks, 'Ads cost 90d': c.adsCost, 'Ads conv': c.adsConversions }))
    .sort((a, b) => b.orders - a.orders || b['GSC impr. 90d'] - a['GSC impr. 90d']);
  console.log(`MARKETS NOW — ${range.from} … ${range.to} (${shop.currency}); orders ${t.orders}, profit per order before ads ${t.avgOrderProfit}`);
  if (shipping) console.log(shipping.everywhere ? 'Ships everywhere ("other locations" zone is on).' : `Ships to: ${shipping.countries.join(', ') || '(no zone with a method)'}`);
  console.log(table(rows.slice(0, 40)));
  console.log('\nPRODUCT GROUPS (first WooCommerce category) — what a sale is worth:');
  console.log(table(groups.slice(0, 15).map((g) => ({ group: g.group, sales: g.sales, revenue: g.revenue, profit: g.profit, 'margin %': pct(g.margin), 'profit/sale': g.profitPerSale, top: g.topProducts.slice(0, 3).join('; ') }))));
  console.log(`Shop average: profit per order ${shopAverage.profitPerSale}, revenue per order ${shopAverage.revenuePerSale}.`);
  console.log(`\nCONVERSION RATE to plan with: ${pct(conversion.rate)}% — ${conversion.source}.`);
  for (const [name, message] of Object.entries(errors)) console.log(`(${name} skipped: ${message})`);
  console.log(`\nNEXT: write ${paths.seeds} — per market, per product group, 3–8 phrases buyers type in that market's language (see SKILL.md "Which markets pay?").`);
}

async function chooseSource(config, account) {
  const wanted = String(flags.source ?? 'auto');
  if (wanted === 'dataforseo') return { source: 'dataforseo' };
  const planner = await plannerStatus(config, account);
  if (wanted === 'planner') {
    if (!planner.available) throw new UserError(`Keyword Planner is not available: ${planner.reason}.`, 'Use --source dataforseo, or apply for Basic access.');
    return { source: 'planner' };
  }
  if (planner.available) return { source: 'planner' };
  if (dataforseoConfigured(config)) return { source: 'dataforseo', note: `Keyword Planner not available (${planner.reason})` };
  throw new UserError(`No search-data source: Keyword Planner is not available (${planner.reason}) and DataForSEO is not connected.`,
    'Either apply for Basic access in the Google Ads API Center (free, a few days), or connect DataForSEO (paid): references/setup.md step 13.');
}

function readSeeds(file) {
  const seeds = readJson(file, null);
  if (!seeds?.markets || typeof seeds.markets !== 'object') {
    throw new UserError(`No seeds file at ${file}.`, 'Run markets.mjs overview, then write the seeds file as SKILL.md describes.');
  }
  const markets = [];
  for (const [rawCode, m] of Object.entries(seeds.markets)) {
    const code = rawCode.toUpperCase() === 'UK' ? 'GB' : rawCode.toUpperCase();
    const c = COUNTRIES[code];
    if (!c) throw new UserError(`Unknown market "${rawCode}". Known: ${Object.keys(COUNTRIES).join(', ')}`);
    const groups = Object.entries(m.groups ?? {}).map(([group, list]) => ({ group, phrases: [...new Set((list ?? []).map(cleanPhrase).filter(Boolean))] })).filter((g) => g.phrases.length);
    if (!groups.length) throw new UserError(`Market ${code} has no phrases.`);
    markets.push({ code, geo: c.geo, language: m.language ?? c.lang, groups });
  }
  return { markets, brand: [...new Set((seeds.brand ?? []).map(cleanPhrase).filter(Boolean))] };
}

async function research(config) {
  const account = accountId(config, flags.account);
  const context = readJson(paths.marketsContext, null);
  if (!context) throw new UserError('Run node scripts/markets.mjs overview first (free).');
  const seedsFile = flags.seeds ? path.resolve(String(flags.seeds)) : paths.seeds;
  const { markets, brand } = readSeeds(seedsFile);
  const expand = flags.expand === undefined ? 30 : flags.expand === 'false' ? 0 : num(flags.expand, 30);
  const { source, note } = await chooseSource(config, account);
  const cache = openCache();
  const key = (m, ...parts) => [source, m.geo, m.language, ...parts].join('|');

  // Plan: which calls are needed after the cache.
  const plan = markets.map((m) => {
    const ideaCalls = expand ? m.groups.filter((g) => cache.get(key(m, 'ideas', ...g.phrases.slice(0, 20).sort())) === undefined).length : 0;
    const phrases = [...new Set([...m.groups.flatMap((g) => g.phrases), ...brand])];
    const missing = phrases.filter((p) => cache.get(key(m, p)) === undefined);
    return { m, ideaCalls, missing, volumeCalls: Math.ceil(missing.length / 1000) };
  });
  const calls = plan.reduce((s, p) => s + p.ideaCalls + p.volumeCalls, 0);
  console.log(`Source: ${source === 'planner' ? 'Google Keyword Planner (free)' : 'DataForSEO (paid)'}${note ? ` — ${note}` : ''}. ${markets.length} markets, ${calls} requests needed (${plan.reduce((s, p) => s + p.missing.length, 0)} phrases not cached).`);
  if (source === 'dataforseo' && calls > 0) {
    const usd = round(calls * DFS_USD_PER_TASK, 2);
    const limit = num(config.dataforseo.dailyLimitUsd, 5);
    console.log(`Estimated DataForSEO cost: ~${usd} USD (spent today ${spentToday()} of the ${limit} USD daily limit).`);
    if (spentToday() + usd > limit) throw new UserError('That would pass the daily DataForSEO limit.', `Fewer markets/phrases, --expand 0, or raise it: node scripts/setup.mjs set dataforseo.dailyLimitUsd ${Math.ceil(spentToday() + usd + 1)}`);
    if (!flags.yes) {
      console.log('NOT RUN — ask the user to approve this cost, then run the same command with --yes.');
      process.exitCode = 3;
      return;
    }
  }

  const needsFx = source === 'dataforseo' ? context.currency !== 'USD' : context.adsCurrency !== context.currency;
  const rates = needsFx ? await fxRates() : null;
  const languageIds = source === 'planner' ? await plannerLanguageIds(config, account, markets.map((m) => m.language)) : null;
  const toShop = (row) => {
    if (row.currency === context.currency || !rates) return row;
    const c = (v) => (v === null ? null : round(convert(v, row.currency, context.currency, rates)));
    return { ...row, cpcLow: c(row.cpcLow), cpcHigh: c(row.cpcHigh), cpcAvg: c(row.cpcAvg), currency: context.currency };
  };

  const results = [];
  for (const { m, missing } of plan) {
    const langId = languageIds?.get(m.language);
    if (source === 'planner' && !langId) throw new UserError(`Google does not know the language code "${m.language}" (market ${m.code}).`);
    const args = { geo: m.geo, lang: m.language, languageId: langId, currency: context.adsCurrency };
    process.stderr.write(`… ${m.code} (${m.language})\n`);
    const groups = [];
    for (const g of m.groups) {
      let ideas = [];
      if (expand) {
        const ideaKey = key(m, 'ideas', ...g.phrases.slice(0, 20).sort());
        ideas = cache.get(ideaKey);
        if (ideas === undefined) {
          ideas = source === 'planner' ? await plannerIdeas(config, account, { ...args, seeds: g.phrases }) : await dfsIdeas(config, { ...args, seeds: g.phrases });
          cache.set(ideaKey, ideas);
          for (const row of ideas) if (cache.get(key(m, row.keyword)) === undefined) cache.set(key(m, row.keyword), row);
          cache.save();
        }
      }
      groups.push({ group: g.group, seeds: g.phrases, ideas: relevantIdeas(g.phrases, ideas, expand) });
    }
    const stillMissing = missing.filter((p) => cache.get(key(m, p)) === undefined);
    if (stillMissing.length) {
      const rows = source === 'planner' ? await plannerMetrics(config, account, { ...args, keywords: stillMissing }) : await dfsMetrics(config, { ...args, keywords: stillMissing });
      for (const row of rows) cache.set(key(m, row.keyword), row);
      // A phrase Google has no figure for is cached as zero, so it is not paid for again.
      for (const p of stillMissing) if (cache.get(key(m, p)) === undefined) cache.set(key(m, p), { keyword: p, volume: 0, cpcLow: null, cpcHigh: null, cpcAvg: null, currency: args.currency });
      cache.save();
    }
    const judged = judgeMarket(m.code, groups.map((g) => ({
      group: g.group,
      rows: [...g.seeds.map((p) => cache.get(key(m, p))), ...g.ideas].filter(Boolean).map(toShop),
    })), {
      shopGroups: context.groups, shopAverage: context.shopAverage, conversion: context.conversion, profit: config.profit,
      settings: config.markets, country: context.countries[m.code] ?? null, language: m.language,
    });
    const brandRows = brand.map((p) => cache.get(key(m, p))).filter(Boolean).map(toShop);
    judged.brandSearches = brandRows.reduce((s, r) => s + (r.volume ?? 0), 0);
    judged.now = context.countries[m.code] ?? null;
    results.push(judged);
  }

  const ranked = rankMarkets(results);
  const report = { generated: new Date().toISOString(), source, currency: context.currency, conversion: context.conversion, settings: config.markets, markets: ranked };
  const file = path.join(paths.reports, `markets-${isoDay()}.json`);
  writePrivateJson(file, report);
  if (flags.json) { printJson(report); return; }

  console.log(`\nWHERE ADVERTISING PAYS (${context.currency}; conversion rate ${pct(context.conversion.rate)}%; searches, CPC and reserve of the paying groups; rough profit assumes you buy ${pct(config.markets.clickShare ?? 0.05)}% of their searches)`);
  console.log(table(ranked.map((r) => ({
    market: r.market, lang: r.language, 'paying groups': r.payingGroups, 'searches/mo': r.volume, 'avg CPC': r.cpc, 'break-even CPC': r.breakEvenCpc,
    'reserve %': pct(r.reserve), 'rough profit/mo': r.estProfitMonth, 'brand searches': brand.length ? r.brandSearches : null,
    [`orders ${context.range.days}d`]: r.now?.orders ?? 0, ships: r.now?.ships === null || r.now?.ships === undefined ? '?' : r.now.ships ? 'yes' : 'no', verdict: r.verdict,
  }))));
  for (const r of ranked.slice(0, num(flags.detail, 5))) {
    console.log(`\n${r.market} — ${r.verdict}${r.flags.length ? ` (${r.flags.join('; ')})` : ''}`);
    console.log(table(r.groups.map((g) => ({
      group: g.group, 'searches/mo': g.volume, 'avg CPC': g.cpc, 'break-even CPC': g.breakEvenCpc, 'reserve %': pct(g.reserve),
      'rough profit/mo': g.estProfitMonth, 'value/sale': g.valuePerSale, from: g.profitFrom, verdict: g.verdict,
      'top phrases': g.topPhrases.slice(0, 3).map((p) => `${p.keyword} (${p.volume})`).join('; '),
    }))));
  }
  console.log(`\nFull report: ${file}`);
}

run(async () => {
  const config = loadConfig();
  switch (command) {
    case 'overview':
      await overview(config);
      break;
    case 'sources': {
      const account = accountId(config, flags.account);
      const planner = await plannerStatus(config, account);
      console.log(`Google Keyword Planner: ${planner.available ? 'available (free)' : `not available — ${planner.reason}`}`);
      console.log(`DataForSEO: ${dataforseoConfigured(config) ? `connected (spent today ${spentToday()} of ${config.dataforseo.dailyLimitUsd} USD)` : 'not connected (references/setup.md step 13)'}`);
      break;
    }
    case 'research':
      await research(config);
      break;
    default:
      throw new UserError(`Unknown command "${command ?? ''}".`, 'Use: overview | sources | research');
  }
});
