// Does a market pay? Pure functions, no network.
//
// For every market and product group:
//   value of a sale   = shop profit per sale of that group (real orders) − extra cost per order
//                       − payment fee − extra cost of shipping to that country
//   break-even CPC    = conversion rate × value of a sale
//   market CPC        = what a click costs there (search-volume-weighted over the group's phrases)
//   reserve           = (break-even CPC − market CPC) ÷ break-even CPC
// A market is "worth a test" with enough searches and a reserve of ≥ 30 % — a ranking of where to run a
// small 14-day test first, not a promise. Rough monthly profit = searches × click share × (CR × value − CPC).
import { round } from './util.mjs';

/** Shop product groups (first WooCommerce category) with profit per sale. */
export function productGroups(products) {
  const groups = new Map();
  for (const p of products) {
    const name = p.categories?.[0] ?? 'Uncategorized';
    const g = groups.get(name) ?? { group: name, units: 0, lines: 0, revenue: 0, profit: 0, profitKnown: true, products: [] };
    g.units += p.units; g.lines += p.lines ?? p.units; g.revenue += p.revenue;
    if (p.profit === null || p.profit === undefined) g.profitKnown = false; else g.profit += p.profit;
    g.products.push(p);
    groups.set(name, g);
  }
  return [...groups.values()].map((g) => ({
    group: g.group, units: round(g.units, 1), sales: round(g.lines, 1), revenue: round(g.revenue), profit: g.profitKnown ? round(g.profit) : null,
    margin: g.profitKnown && g.revenue > 0 ? round(g.profit / g.revenue, 3) : null,
    revenuePerSale: g.lines > 0 ? round(g.revenue / g.lines) : null,
    profitPerSale: g.profitKnown && g.lines > 0 ? round(g.profit / g.lines) : null,
    topProducts: g.products.sort((a, b) => b.units - a.units).slice(0, 5).map((p) => p.name),
  })).sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0));
}

/**
 * Conversion rate of a click from a NEW, non-brand searcher — the kind a new market brings.
 * From the account's non-brand search terms; Google sees only part of the purchases, so it is scaled
 * by shop orders from Google Ads ÷ Google conversions when the shop records attribution (capped × 2).
 */
export function conversionEstimate({ clicks = 0, conversions = 0, shopAdsOrders = null, googleConversions = null, override = null } = {}) {
  if (override) return { rate: Number(override), source: 'setting markets.conversionRate' };
  if (clicks < 200 || conversions < 3) return { rate: 0.01, source: 'default 1 % — too little non-brand data in the account to measure it' };
  let factor = 1;
  if (shopAdsOrders && googleConversions && shopAdsOrders > googleConversions) factor = Math.min(2, shopAdsOrders / googleConversions);
  const rate = Math.min(0.08, (conversions / clicks) * factor);
  return {
    rate: round(rate, 4),
    source: `non-brand search terms of the last 90 days: ${round(conversions, 1)} conversions / ${clicks} clicks${factor > 1 ? `, × ${round(factor)} for purchases Google did not see` : ''}`,
  };
}

const tokens = (text) => String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4);

/** Related phrases from the source, kept only when they share a real word with the group's own phrases. */
export function relevantIdeas(seeds, ideas, limit = 30) {
  const seedSet = new Set(seeds);
  const words = new Set(seeds.flatMap(tokens));
  return ideas
    .filter((i) => !seedSet.has(i.keyword) && (i.volume ?? 0) > 0 && tokens(i.keyword).some((t) => words.has(t)))
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, limit);
}

const cpcOf = (r) => r.cpcAvg ?? (r.cpcLow !== null && r.cpcHigh !== null ? (r.cpcLow + r.cpcHigh) / 2 : r.cpcHigh ?? r.cpcLow);

/** Search-volume-weighted click price; null when no phrase has both a volume and a price. */
export function weightedCpc(rows) {
  let w = 0;
  let sum = 0;
  for (const r of rows) {
    const cpc = cpcOf(r);
    if (!(r.volume > 0) || cpc === null || cpc === undefined) continue;
    w += r.volume; sum += r.volume * cpc;
  }
  return w > 0 ? sum / w : null;
}

export function verdict({ volume, reserve, minVolume, ships }) {
  if (ships === false) return 'not shipped there';
  if (volume < minVolume) return 'too little demand';
  if (reserve === null) return 'no price data';
  if (reserve >= 0.3) return 'worth a test';
  if (reserve >= 0) return 'marginal';
  return 'does not pay';
}

/**
 * One market. groups: [{ group, rows }] with rows already in the shop currency.
 * ctx: { shopGroups, shopAverage, conversion, profit: {extraCostPerOrder, paymentFeePercent}, settings: config.markets, country: {...} }
 */
export function judgeMarket(code, groups, ctx) {
  const settings = ctx.settings ?? {};
  const minVolume = settings.minMonthlySearches ?? 300;
  const clickShare = settings.clickShare ?? 0.05;
  const siteLanguages = (settings.siteLanguages ?? []).map((l) => String(l).toLowerCase());
  const siteLanguage = siteLanguages.length ? siteLanguages.includes(String(ctx.language).toLowerCase()) : null;
  const cr = ctx.conversion.rate * (siteLanguage === false ? 0.5 : 1);
  const extraCountry = Number(settings.extraCostByCountry?.[code] ?? 0);
  const fee = Number(ctx.profit?.paymentFeePercent ?? 0) / 100;
  const extraOrder = Number(ctx.profit?.extraCostPerOrder ?? 0);
  const flags = [];
  if (siteLanguage === false) flags.push(`site not in ${ctx.language} (conversion halved)`);
  if (extraCountry) flags.push(`+${extraCountry} shipping cost per order`);

  const rows = groups.map(({ group, rows: phrases }) => {
    const shop = ctx.shopGroups.find((g) => g.group.toLowerCase() === String(group).toLowerCase());
    const base = shop && shop.sales >= 3 && shop.profitPerSale !== null ? shop : ctx.shopAverage;
    const value = base.profitPerSale - extraOrder - fee * (base.revenuePerSale ?? 0) - extraCountry;
    const unique = phrases.filter((p) => !p.variantOf);
    const volume = unique.reduce((s, p) => s + (p.volume ?? 0), 0);
    const cpc = weightedCpc(unique);
    const beCpc = cr * value;
    const reserve = beCpc > 0 && cpc !== null ? (beCpc - cpc) / beCpc : beCpc <= 0 ? -1 : null;
    const clicks = volume * clickShare;
    const profit = cpc === null ? null : clicks * (cr * value - cpc);
    return {
      group, volume, cpc: round(cpc), breakEvenCpc: round(beCpc), reserve: reserve === null ? null : round(reserve, 3),
      estProfitMonth: round(profit, 0), valuePerSale: round(value), profitFrom: base === shop ? 'group' : 'shop average',
      verdict: verdict({ volume, reserve, minVolume: minVolume / 3, ships: ctx.country?.ships }),
      topPhrases: unique.filter((p) => p.volume > 0).sort((a, b) => b.volume - a.volume).slice(0, 8)
        .map((p) => ({ keyword: p.keyword, volume: p.volume, cpc: round(cpcOf(p)), competition: p.competition })),
    };
  });

  // The market is judged on the groups a test would advertise (break-even or better); when none pays,
  // on all of them. Losing groups are simply left out of a test, so they must not sink a good market.
  const paying = rows.filter((r) => r.reserve !== null && r.reserve >= 0 && r.volume > 0);
  const basis = paying.length ? paying : rows;
  const volume = basis.reduce((s, r) => s + r.volume, 0);
  const priced = basis.filter((r) => r.cpc !== null && r.volume > 0);
  const w = priced.reduce((s, r) => s + r.volume, 0);
  const cpc = w ? priced.reduce((s, r) => s + r.cpc * r.volume, 0) / w : null;
  const beCpc = w ? priced.reduce((s, r) => s + r.breakEvenCpc * r.volume, 0) / w : null;
  const reserve = beCpc && beCpc > 0 && cpc !== null ? (beCpc - cpc) / beCpc : null;
  return {
    market: code, language: ctx.language, volume, totalVolume: rows.reduce((s, r) => s + r.volume, 0),
    payingGroups: `${paying.length}/${rows.length}`,
    cpc: round(cpc), breakEvenCpc: round(beCpc), reserve: reserve === null ? null : round(reserve, 3),
    estProfitMonth: round(paying.reduce((s, r) => s + Math.max(0, r.estProfitMonth ?? 0), 0), 0),
    conversionRate: round(cr, 4),
    verdict: verdict({ volume, reserve, minVolume, ships: ctx.country?.ships }),
    flags, groups: rows.sort((a, b) => (b.estProfitMonth ?? -1e9) - (a.estProfitMonth ?? -1e9)),
  };
}

const ORDER = ['worth a test', 'marginal', 'does not pay', 'no price data', 'too little demand', 'not shipped there'];

export function rankMarkets(markets) {
  return [...markets].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || (b.estProfitMonth ?? 0) - (a.estProfitMonth ?? 0));
}
