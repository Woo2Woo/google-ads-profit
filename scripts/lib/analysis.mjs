// The judgement: pure functions (no network), so every threshold is visible and tested.
//
// Thresholds come from running this method on real accounts with 1–7 orders a day: with that little
// data nothing small can be proven, so budgets and targets are judged on 30 days, products on 90 days,
// and a "loss" is called only clearly below break-even (< 0.8 ×), because Google sees only part of
// the purchases.
import { containsAny, round } from './util.mjs';
import { matchItem } from './woo.mjs';

/**
 * Break-even ROAS: the Google ROAS at which ads exactly eat the profit.
 * Google's conversion value is either what the customer paid (tax + shipping included) or the goods
 * value; the basis is picked by comparing Google's average value per conversion with the shop's.
 */
export function breakEven(shopTotals, googleTotals) {
  const margin = shopTotals.marginAfterCosts;
  if (!margin || margin <= 0) return null;
  const goods = 1 / margin;
  const total = shopTotals.avgOrderRevenue > 0 ? (shopTotals.avgOrderTotal / shopTotals.avgOrderRevenue) / margin : goods;
  const googleAvg = googleTotals.conversions > 0 ? googleTotals.value / googleTotals.conversions : null;
  let basis = 'order-total';
  if (googleAvg && shopTotals.avgOrderRevenue && shopTotals.avgOrderTotal
    && Math.abs(googleAvg - shopTotals.avgOrderRevenue) < Math.abs(googleAvg - shopTotals.avgOrderTotal)) basis = 'goods';
  return {
    roas: round(basis === 'goods' ? goods : total),
    basis,
    ifValueIsGoods: round(goods),
    ifValueIsOrderTotal: round(total),
    googleAvgValue: round(googleAvg),
    shopAvgOrderTotal: shopTotals.avgOrderTotal,
    shopAvgGoods: shopTotals.avgOrderRevenue,
  };
}

const BIG = 'big';
const SMALL = 'small';

/** Campaign-level findings over one range (30 days recommended). */
export function campaignFindings(campaigns, be, { avgOrderProfit = null } = {}) {
  const out = [];
  const minSpend = avgOrderProfit && avgOrderProfit > 0 ? 3 * avgOrderProfit : 150;
  for (const c of campaigns) {
    if (c.status !== 'ENABLED') continue;
    const r = c.cost > 0 ? c.value / c.cost : null;
    if (c.budget && c.budget > 0 && c.impressions7 === 0) {
      out.push({ campaignId: c.id, campaign: c.name, kind: 'not_serving', size: SMALL,
        text: `enabled with budget ${c.budget}/day but 0 impressions in 7 days — check status, locations, budget, bids, products, policy` });
    }
    if (c.geo === 'PRESENCE_OR_INTEREST' && ['SEARCH', 'SHOPPING', 'PERFORMANCE_MAX'].includes(c.type) && c.cost > 0) {
      out.push({ campaignId: c.id, campaign: c.name, kind: 'location_interest', size: SMALL,
        text: 'shows to people "interested in" the location, not only people in it — usually wasted outside the delivery area' });
    }
    if (c.searchPartners === true && c.cost > 0) {
      out.push({ campaignId: c.id, campaign: c.name, kind: 'search_partners', size: SMALL, text: 'Search Partners network is on — usually lower quality traffic; check it in segments.ad_network_type' });
    }
    if (!be || r === null) continue;
    if (c.cost >= minSpend && r < 0.8 * be.roas) {
      let action;
      if (c.portfolio) action = 'uses a shared (portfolio) bid strategy — change the target there, by hand';
      else if (c.targetRoas) action = `raise target ROAS ${round(c.targetRoas * 100, 0)}% → ${round(Math.min(c.targetRoas * 1.1, c.targetRoas * 1.2) * 100, 0)}% (+10 %)`;
      else if (c.bidding === 'MAXIMIZE_CONVERSION_VALUE') action = `set a first target ROAS of ${round(Math.min(be.roas, r * 1.2) * 100, 0)}% (it spends the whole budget whatever the return)`;
      else action = 'check its search terms and products first; if no clear leak, consider a lower budget or pausing';
      out.push({ campaignId: c.id, campaign: c.name, kind: 'below_break_even', size: BIG,
        text: `ROAS ${round(r)} < break-even ${be.roas} on ${c.cost} spend → ${action}`,
        evidence: { roas: round(r), breakEven: be.roas, cost: c.cost, conversions: c.conversions } });
    }
    if (r >= 1.5 * be.roas && c.conversions >= 15 && (c.budgetLostIs ?? 0) >= 0.1 && c.budget && !c.budgetShared) {
      out.push({ campaignId: c.id, campaign: c.name, kind: 'budget_limited_profitable', size: BIG,
        text: `profitable (ROAS ${round(r)} ≥ 1.5 × break-even) but loses ${round(c.budgetLostIs * 100, 0)}% of impressions to budget → budget ${c.budget} → ${round(c.budget * 1.15)} (+15 %)`,
        evidence: { roas: round(r), breakEven: be.roas, conversions: c.conversions, budgetLostIs: c.budgetLostIs } });
    }
    if (c.targetRoas && !c.portfolio && r >= 2 * be.roas && c.conversions >= 20 && (c.budgetLostIs ?? 0) < 0.05 && (c.rankLostIs ?? 0) >= 0.4) {
      const to = Math.max(1.6 * be.roas, c.targetRoas * 0.9);
      if (to < c.targetRoas * 0.98) {
        out.push({ campaignId: c.id, campaign: c.name, kind: 'rank_limited_very_profitable', size: BIG,
          text: `very profitable (ROAS ${round(r)} ≥ 2 × break-even), not budget-limited, loses ${round(c.rankLostIs * 100, 0)}% to rank → target ROAS ${round(c.targetRoas * 100, 0)}% → ${round(to * 100, 0)}% (more sales)`,
          evidence: { roas: round(r), breakEven: be.roas, conversions: c.conversions, rankLostIs: c.rankLostIs } });
      }
    }
  }
  return out;
}

/**
 * Products: Google spend per shop product next to the shop's real profit from it (all channels).
 * A product is flagged only when the matching between Google item ids and shop products is reliable —
 * otherwise "no sales" would just mean "not matched".
 */
export function productFindings(adsProducts, shopProducts, index, { avgOrderProfit = null } = {}) {
  const shopById = new Map(shopProducts.map((p) => [p.productId, p]));
  const rows = new Map();
  let convItems = 0;
  let convItemsMatched = 0;
  let cost = 0;
  let costMatched = 0;
  for (const item of adsProducts) {
    const productId = matchItem(index, item.itemId);
    cost += item.cost;
    if (productId !== null) costMatched += item.cost;
    if (item.conversions >= 1) { convItems += 1; if (productId !== null) convItemsMatched += 1; }
    const key = productId !== null ? `p${productId}` : `i${item.itemId}`;
    const cur = rows.get(key) ?? { productId, itemIds: new Set(), title: item.title, cost: 0, clicks: 0, googleConv: 0, googleValue: 0 };
    cur.itemIds.add(item.itemId);
    cur.cost += item.cost; cur.clicks += item.clicks; cur.googleConv += item.conversions; cur.googleValue += item.value;
    rows.set(key, cur);
  }
  const reliable = convItems >= 3 ? convItemsMatched / convItems >= 0.6 : costMatched / (cost || 1) >= 0.5;
  const minSpend = Math.max(avgOrderProfit && avgOrderProfit > 0 ? 3 * avgOrderProfit : 60, 20);

  const table = [...rows.values()].map((r) => {
    const shop = r.productId !== null ? shopById.get(r.productId) : null;
    return {
      productId: r.productId, title: shop?.name ?? r.title, itemIds: [...r.itemIds].slice(0, 5),
      adCost: round(r.cost), clicks: r.clicks, googleConv: round(r.googleConv, 1), googleValue: round(r.googleValue),
      shopUnits: shop?.units ?? 0, shopRevenue: shop?.revenue ?? 0, shopProfit: shop?.profit ?? (r.productId !== null ? 0 : null),
    };
  }).sort((a, b) => b.adCost - a.adCost);

  const losers = reliable
    ? table.filter((p) => p.adCost >= minSpend && p.clicks >= 100 && p.googleConv < 2 && (p.shopProfit ?? 0) < 0.5 * p.adCost)
    : [];
  const advertised = new Set(table.filter((p) => p.productId !== null && p.adCost > 0).map((p) => p.productId));
  const underAdvertised = shopProducts
    .filter((p) => (p.profit ?? 0) > 0 && !advertised.has(p.productId))
    .slice(0, 10)
    .map((p) => ({ productId: p.productId, name: p.name, units: p.units, profit: p.profit }));

  return {
    matching: { reliable, convItems, convItemsMatched, costMatchedShare: round(costMatched / (cost || 1), 3) },
    minSpendForLoss: round(minSpend),
    products: table,
    losers,
    sellsWithoutAds: underAdvertised,
  };
}

/** Search terms with spend and no conversion (the user/Claude classifies them; brand words never become negatives). */
export function searchTermFindings(terms, { brandTerms = [], protectedTerms = [], negatives = [], avgOrderProfit = null } = {}) {
  const negated = new Set(negatives.map((n) => `${n.campaignId}|${String(n.text).toLowerCase()}`));
  const minCost = avgOrderProfit && avgOrderProfit > 0 ? Math.max(0.2 * avgOrderProfit, 2) : 5;
  const totalCost = terms.reduce((s, t) => s + t.cost, 0);
  const zero = terms.filter((t) => t.conversions === 0);
  const zeroCost = zero.reduce((s, t) => s + t.cost, 0);
  const candidates = zero
    .filter((t) => t.cost >= minCost && !containsAny(t.term, brandTerms))
    .map((t) => ({
      ...t,
      protectedWord: containsAny(t.term, protectedTerms),
      alreadyNegative: negated.has(`${t.campaignId}|${t.term.toLowerCase()}`),
    }))
    .filter((t) => !t.alreadyNegative)
    .slice(0, 60);
  const converting = terms.filter((t) => t.conversions > 0).sort((a, b) => b.conversions - a.conversions).slice(0, 25);
  return {
    totalCost: round(totalCost),
    zeroConversionCost: round(zeroCost),
    zeroConversionShare: round(zeroCost / (totalCost || 1), 3),
    minCost: round(minCost),
    candidates,
    converting,
  };
}

/** Brand: what is paid for brand searches vs what comes free, and paid queries already won organically. */
export function brandFindings(terms, gscRows, brandTerms) {
  const paid = terms.filter((t) => containsAny(t.term, brandTerms));
  const organic = gscRows.filter((r) => containsAny(r.key, brandTerms));
  const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const impressions = sum(organic, 'impressions');
  const position = impressions ? organic.reduce((s, r) => s + r.position * r.impressions, 0) / impressions : null;
  const gscByQuery = new Map(gscRows.map((r) => [r.key.toLowerCase(), r]));
  const overlap = terms
    .filter((t) => !containsAny(t.term, brandTerms))
    .map((t) => ({ term: t.term, campaign: t.campaign, adCost: t.cost, adClicks: t.clicks, adConv: t.conversions, org: gscByQuery.get(t.term.toLowerCase()) }))
    .filter((t) => t.org && t.org.position <= 3 && t.org.clicks >= 5)
    .map(({ org, ...t }) => ({ ...t, organicClicks: org.clicks, organicPosition: org.position }))
    .sort((a, b) => b.adCost - a.adCost)
    .slice(0, 20);
  return {
    paidBrand: { cost: round(sum(paid, 'cost')), clicks: sum(paid, 'clicks'), conversions: round(sum(paid, 'conversions'), 1), value: round(sum(paid, 'value')) },
    organicBrand: { clicks: sum(organic, 'clicks'), impressions, avgPosition: round(position, 1) },
    paidButWinningOrganically: overlap,
  };
}

/** Profit after ads per week: shop profit before ads minus ad spend, by ISO-ish week starting Monday. */
export function weekly(shopDays, adsDays) {
  const weekOf = (day) => {
    const d = new Date(`${day}T00:00:00Z`);
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000);
    return monday.toISOString().slice(0, 10);
  };
  const weeks = new Map();
  const get = (w) => weeks.get(w) ?? weeks.set(w, { week: w, orders: 0, revenue: 0, profitBeforeAds: 0, adCost: 0, googleConv: 0 }).get(w);
  for (const d of shopDays) { const w = get(weekOf(d.day)); w.orders += d.orders; w.revenue += d.revenue; w.profitBeforeAds += d.profitBeforeAds ?? 0; }
  for (const d of adsDays) { const w = get(weekOf(d.day)); w.adCost += d.cost; w.googleConv += d.conversions; }
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)).map((w) => ({
    week: w.week, orders: w.orders, revenue: round(w.revenue), adCost: round(w.adCost),
    profitAfterAds: round(w.profitBeforeAds - w.adCost), adShareOfProfit: w.profitBeforeAds > 0 ? round(w.adCost / w.profitBeforeAds, 3) : null,
    googleConv: round(w.googleConv, 1),
  }));
}
