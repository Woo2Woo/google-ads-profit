// Google Ads reads used by several scripts. Every query aggregates in GAQL and selects only what is used,
// because new developer tokens have a small daily operations quota.
import { adsSearch } from './google.mjs';
import { micros, round } from './util.mjs';

const between = (range) => `segments.date BETWEEN '${range.from}' AND '${range.to}'`;

const metricsOf = (row) => ({
  cost: micros(row.metrics?.costMicros),
  clicks: Number(row.metrics?.clicks ?? 0),
  impressions: Number(row.metrics?.impressions ?? 0),
  conversions: Number(row.metrics?.conversions ?? 0),
  value: Number(row.metrics?.conversionsValue ?? 0),
});

export const roas = (m) => (m.cost > 0 ? m.value / m.cost : null);

export async function accountInfo(config, customerId) {
  const rows = await adsSearch(config, customerId, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer');
  const c = rows[0]?.customer ?? {};
  return { id: String(c.id ?? customerId), name: c.descriptiveName ?? '', currency: c.currencyCode ?? '', timeZone: c.timeZone ?? '', manager: Boolean(c.manager) };
}

/** Settings of every non-removed campaign + metrics for the range. */
export async function campaigns(config, customerId, range) {
  const [settings, metrics, recent] = await Promise.all([
    adsSearch(config, customerId, `SELECT campaign.id, campaign.resource_name, campaign.name, campaign.status, campaign.serving_status,
        campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.bidding_strategy,
        campaign.target_roas.target_roas, campaign.maximize_conversion_value.target_roas,
        campaign.geo_target_type_setting.positive_geo_target_type, campaign.network_settings.target_search_network,
        campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared
      FROM campaign WHERE campaign.status != 'REMOVED'`),
    adsSearch(config, customerId, `SELECT campaign.id, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value,
        metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
      FROM campaign WHERE campaign.status != 'REMOVED' AND ${between(range)}`),
    adsSearch(config, customerId, `SELECT campaign.id, metrics.impressions, metrics.cost_micros FROM campaign
      WHERE campaign.status = 'ENABLED' AND segments.date DURING LAST_7_DAYS`),
  ]);
  const byId = new Map();
  for (const row of settings) {
    const c = row.campaign;
    const bidding = c.biddingStrategyType ?? '';
    const target = c.targetRoas?.targetRoas ?? c.maximizeConversionValue?.targetRoas ?? null;
    byId.set(String(c.id), {
      id: String(c.id), resourceName: c.resourceName, name: c.name, status: c.status, serving: c.servingStatus,
      type: c.advertisingChannelType, bidding, portfolio: Boolean(c.biddingStrategy),
      targetRoas: target === null ? null : Number(target),
      geo: c.geoTargetTypeSetting?.positiveGeoTargetType ?? null,
      searchPartners: c.networkSettings?.targetSearchNetwork ?? null,
      budgetResourceName: row.campaignBudget?.resourceName ?? null,
      budget: row.campaignBudget?.amountMicros ? micros(row.campaignBudget.amountMicros) : null,
      budgetShared: Boolean(row.campaignBudget?.explicitlyShared),
      cost: 0, clicks: 0, impressions: 0, conversions: 0, value: 0, budgetLostIs: null, rankLostIs: null,
      impressions7: 0, cost7: 0,
    });
  }
  for (const row of metrics) {
    const c = byId.get(String(row.campaign.id));
    if (!c) continue;
    Object.assign(c, metricsOf(row));
    c.budgetLostIs = row.metrics?.searchBudgetLostImpressionShare ?? null;
    c.rankLostIs = row.metrics?.searchRankLostImpressionShare ?? null;
  }
  for (const row of recent) {
    const c = byId.get(String(row.campaign.id));
    if (c) { c.impressions7 = Number(row.metrics?.impressions ?? 0); c.cost7 = micros(row.metrics?.costMicros); }
  }
  return [...byId.values()].map((c) => ({ ...c, roas: round(roas(c)), cost: round(c.cost), value: round(c.value), conversions: round(c.conversions, 1) }))
    .sort((a, b) => b.cost - a.cost);
}

export async function searchTerms(config, customerId, range, { minCost = 0 } = {}) {
  const rows = await adsSearch(config, customerId, `SELECT campaign.id, campaign.name, ad_group.id, search_term_view.search_term, search_term_view.status,
      metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
    FROM search_term_view WHERE ${between(range)} AND metrics.cost_micros > ${Math.round(minCost * 1e6)}`);
  const byKey = new Map();
  for (const row of rows) {
    const term = String(row.searchTermView?.searchTerm ?? '');
    const key = `${row.campaign.id}|${term}`;
    const m = metricsOf(row);
    const cur = byKey.get(key) ?? { campaignId: String(row.campaign.id), campaign: row.campaign.name, term, status: row.searchTermView?.status, cost: 0, clicks: 0, conversions: 0, value: 0 };
    cur.cost += m.cost; cur.clicks += m.clicks; cur.conversions += m.conversions; cur.value += m.value;
    byKey.set(key, cur);
  }
  return [...byKey.values()].map((t) => ({ ...t, cost: round(t.cost), value: round(t.value), conversions: round(t.conversions, 1) })).sort((a, b) => b.cost - a.cost);
}

/** Shopping / Performance Max product rows (by item id), summed over the range. */
export async function products(config, customerId, range) {
  const rows = await adsSearch(config, customerId, `SELECT campaign.id, campaign.name, campaign.advertising_channel_type, segments.product_item_id, segments.product_title,
      metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
    FROM shopping_performance_view WHERE ${between(range)} AND metrics.impressions > 0`);
  const byKey = new Map();
  for (const row of rows) {
    const itemId = String(row.segments?.productItemId ?? '');
    const key = `${row.campaign.id}|${itemId}`;
    const m = metricsOf(row);
    const cur = byKey.get(key) ?? {
      campaignId: String(row.campaign.id), campaign: row.campaign.name, channel: row.campaign.advertisingChannelType,
      itemId, title: row.segments?.productTitle ?? '', cost: 0, clicks: 0, conversions: 0, value: 0,
    };
    cur.cost += m.cost; cur.clicks += m.clicks; cur.conversions += m.conversions; cur.value += m.value;
    byKey.set(key, cur);
  }
  return [...byKey.values()].sort((a, b) => b.cost - a.cost);
}

/** Standard Shopping listing-group tree of one campaign (needed to exclude a product). */
export async function partitions(config, customerId, campaignId) {
  const rows = await adsSearch(config, customerId, `SELECT ad_group.id, ad_group_criterion.resource_name, ad_group_criterion.listing_group.type,
      ad_group_criterion.listing_group.parent_ad_group_criterion, ad_group_criterion.listing_group.case_value.product_item_id.value,
      ad_group_criterion.negative, ad_group_criterion.cpc_bid_micros
    FROM ad_group_criterion WHERE ad_group_criterion.type = 'LISTING_GROUP' AND campaign.id = ${Number(campaignId)}
      AND ad_group.status = 'ENABLED' AND ad_group_criterion.status != 'REMOVED'`);
  return rows.map((row) => {
    const a = row.adGroupCriterion;
    return {
      adGroupId: String(row.adGroup.id),
      resourceName: a.resourceName,
      parentResourceName: a.listingGroup?.parentAdGroupCriterion ?? null,
      type: a.listingGroup?.type,
      itemId: a.listingGroup?.caseValue?.productItemId?.value ?? null,
      negative: Boolean(a.negative),
      cpcBidMicros: a.cpcBidMicros ?? null,
    };
  });
}

export async function campaignNegatives(config, customerId, campaignId = null) {
  const rows = await adsSearch(config, customerId, `SELECT campaign.id, campaign.name, campaign_criterion.resource_name, campaign_criterion.keyword.text,
      campaign_criterion.keyword.match_type
    FROM campaign_criterion WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign.status != 'REMOVED'
      ${campaignId ? `AND campaign.id = ${Number(campaignId)}` : ''}`);
  return rows.map((r) => ({
    campaignId: String(r.campaign.id), campaign: r.campaign.name, resourceName: r.campaignCriterion.resourceName,
    text: r.campaignCriterion.keyword?.text ?? '', matchType: r.campaignCriterion.keyword?.matchType ?? '',
  }));
}

/** Account totals per day (spend, Google conversions and value). */
export async function dailyTotals(config, customerId, range) {
  const rows = await adsSearch(config, customerId, `SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value
    FROM customer WHERE ${between(range)}`);
  return rows.map((r) => ({ day: r.segments.date, ...metricsOf(r) })).sort((a, b) => a.day.localeCompare(b.day));
}

/** Which conversion goals Smart Bidding optimises for (add-to-cart / app installs here inflate ROAS). */
export async function biddableGoals(config, customerId) {
  const rows = await adsSearch(config, customerId, `SELECT customer_conversion_goal.category, customer_conversion_goal.origin, customer_conversion_goal.biddable
    FROM customer_conversion_goal`);
  return rows.map((r) => ({ category: r.customerConversionGoal.category, origin: r.customerConversionGoal.origin, biddable: Boolean(r.customerConversionGoal.biddable) }));
}
