// Preloaded with `node --import` in the end-to-end test: replaces fetch with a fake Google + WooCommerce,
// so the real scripts run unchanged. Every mutate is appended to $MOCK_LOG.
import fs from 'node:fs';

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const stream = (results) => json([{ results }]);
const log = (entry) => { if (process.env.MOCK_LOG) fs.appendFileSync(process.env.MOCK_LOG, `${JSON.stringify(entry)}\n`); };

// Shop: products 1 (sells, cost 40), 2 (sells, cost on order line), 3 (no cost), 4 (never sells).
const PRODUCTS = {
  1: { id: 1, parent_id: 0, name: 'Pro Headset', sku: 'PH-1', type: 'simple', categories: [{ id: 5, name: 'Headsets' }], meta_data: [{ key: '_wc_cog_cost', value: '40' }] },
  2: { id: 2, parent_id: 0, name: 'Ear Plugs', sku: 'EP-2', type: 'variable', categories: [{ id: 6, name: 'Earplugs' }], meta_data: [] },
  21: { id: 21, parent_id: 2, name: 'Ear Plugs - Blue', sku: 'EP-2-BL', meta_data: [{ key: '_wc_cog_cost', value: '5' }] },
  3: { id: 3, parent_id: 0, name: 'Cleaning Kit', sku: 'CK-3', type: 'simple', categories: [{ id: 7, name: 'Accessories' }], meta_data: [] },
};

function orders() {
  const out = [];
  let id = 1000;
  for (let i = 1; i <= 95; i += 1) {
    const date = `${day(i)}T09:00:00`;
    out.push({ id: id++, status: 'completed', currency: 'EUR', date_created_gmt: date, total: '120.00', total_tax: '20.00', shipping_total: '0.00',
      line_items: [{ product_id: 1, variation_id: 0, quantity: 1, total: '100.00', sku: 'PH-1', name: 'Pro Headset', meta_data: [] }],
      refunds: [], shipping: { country: i % 4 === 0 ? 'FR' : 'DE' }, meta_data: [{ key: '_wc_order_attribution_source_type', value: i % 2 ? 'utm' : 'organic' }, { key: '_wc_order_attribution_utm_source', value: 'google' }, { key: '_wc_order_attribution_utm_medium', value: i % 2 ? 'cpc' : 'organic' }] });
    if (i % 3 === 0) {
      out.push({ id: id++, status: 'processing', currency: 'EUR', date_created_gmt: date, total: '30.00', total_tax: '5.00', shipping_total: '5.00',
        line_items: [
          { product_id: 2, variation_id: 21, quantity: 2, total: '16.00', sku: 'EP-2-BL', name: 'Ear Plugs - Blue', meta_data: [{ key: '_wc_cog_item_cost', value: '4' }] },
          { product_id: 3, variation_id: 0, quantity: 1, total: '4.00', sku: 'CK-3', name: 'Cleaning Kit', meta_data: [] },
        ], refunds: [], meta_data: [] });
    }
    if (i === 10) out.push({ id: id++, status: 'cancelled', currency: 'EUR', date_created_gmt: date, total: '999', line_items: [], refunds: [], meta_data: [] });
  }
  return out;
}

function woo(url) {
  const path = url.pathname.replace('/wp-json/wc/v3/', '');
  if (!url.searchParams.get('consumer_key') && !globalThis.__wooHeaderSeen) globalThis.__wooHeaderSeen = true;
  if (path === 'orders') {
    const after = url.searchParams.get('after');
    const before = url.searchParams.get('before');
    let rows = orders();
    if (after) rows = rows.filter((o) => `${o.date_created_gmt}Z` >= after.slice(0, 19));
    if (before) rows = rows.filter((o) => `${o.date_created_gmt}Z` <= before);
    if (url.searchParams.get('per_page') === '1') return json(rows.slice(0, 1), { 'x-wp-total': String(rows.length), 'x-wp-totalpages': String(rows.length) });
    const page = Number(url.searchParams.get('page') ?? 1);
    const pages = Math.max(1, Math.ceil(rows.length / 100));
    return json(rows.slice((page - 1) * 100, page * 100), { 'x-wp-total': String(rows.length), 'x-wp-totalpages': String(pages) });
  }
  if (path === 'products') {
    const ids = (url.searchParams.get('include') ?? '').split(',').map(Number);
    return json(ids.map((i) => PRODUCTS[i]).filter(Boolean), { 'x-wp-totalpages': '1' });
  }
  const variations = path.match(/^products\/(\d+)\/variations$/);
  if (variations) {
    const ids = (url.searchParams.get('include') ?? '').split(',').map(Number);
    return json(ids.map((i) => PRODUCTS[i]).filter(Boolean), { 'x-wp-totalpages': '1' });
  }
  if (path === 'data/currencies/current') return json({ code: 'EUR' });
  if (path === 'shipping/zones') return json([{ id: 0, name: 'Other' }, { id: 1, name: 'EU' }]);
  if (path === 'shipping/zones/0/methods') return json([]);
  if (path === 'shipping/zones/1/methods') return json([{ id: 1, enabled: true }]);
  if (path === 'shipping/zones/1/locations') return json([{ code: 'DE', type: 'country' }, { code: 'FR', type: 'country' }, { code: 'PL', type: 'country' }]);
  return new Response('{"code":"rest_no_route"}', { status: 404 });
}

function ads(url, body) {
  if (url.pathname.endsWith('customers:listAccessibleCustomers')) return json({ resourceNames: ['customers/1112223333'] });
  if (url.pathname.endsWith(':generateKeywordHistoricalMetrics') || url.pathname.endsWith(':generateKeywordIdeas')) {
    log({ planner: url.pathname.split(':').pop(), geo: body.geoTargetConstants?.[0] });
    if (!process.env.MOCK_PLANNER) {
      return new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission', details: [{ errors: [{ errorCode: { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }, message: 'This method is not allowed for use with explorer access. Please apply for basic or standard access.' }] }] } }), { status: 403 });
    }
    const metric = (text) => ({ avgMonthlySearches: String(text.length * 100), competition: 'MEDIUM', lowTopOfPageBidMicros: '300000', highTopOfPageBidMicros: '900000' });
    if (url.pathname.endsWith(':generateKeywordIdeas')) {
      const seeds = body.keywordSeed.keywords;
      return json({ results: [...seeds, `${seeds[0]} test`, 'unrelated thing'].map((text) => ({ text, keywordIdeaMetrics: metric(text) })) });
    }
    return json({ results: body.keywords.map((text) => ({ text, keywordMetrics: metric(text) })) });
  }
  if (url.pathname.endsWith(':mutate')) {
    log({ service: url.pathname.split('/').pop(), validateOnly: Boolean(body.validateOnly), operations: body.operations });
    if (body.validateOnly) return json({});
    return json({ results: body.operations.map((op, i) => ({ resourceName: op.remove ?? `${url.pathname.split('/')[3]}/created~${Date.now()}${i}` })) });
  }
  const q = body.query.replace(/\s+/g, ' ');
  if (/FROM customer_conversion_goal/.test(q)) {
    return stream([
      { customerConversionGoal: { category: 'PURCHASE', origin: 'WEBSITE', biddable: true } },
      { customerConversionGoal: { category: 'ADD_TO_CART', origin: 'WEBSITE', biddable: true } },
    ]);
  }
  if (/customer\.descriptive_name/.test(q)) return stream([{ customer: { id: '1112223333', descriptiveName: 'Test shop', currencyCode: 'EUR', timeZone: 'Europe/Berlin', manager: false } }]);
  if (/segments\.date, metrics\.cost_micros/.test(q) && /FROM customer/.test(q)) {
    const [, from, to] = q.match(/BETWEEN '([\d-]+)' AND '([\d-]+)'/);
    const rows = [];
    for (let i = 1; i <= 120; i += 1) { const d = day(i); if (d >= from && d <= to) rows.push({ segments: { date: d }, metrics: { costMicros: '25000000', conversions: 0.6, conversionsValue: 70 } }); }
    return stream(rows);
  }
  if (/metrics\.cost_micros FROM customer/.test(q)) return stream([{ metrics: { costMicros: '175000000' } }]);
  if (/SELECT metrics\.conversions FROM customer/.test(q)) return stream([{ metrics: { conversions: 50 } }]);
  if (/FROM language_constant/.test(q)) return stream([{ languageConstant: { id: '1001', code: 'de' } }, { languageConstant: { id: '1030', code: 'pl' } }, { languageConstant: { id: '1002', code: 'fr' } }]);
  if (/FROM geographic_view/.test(q)) return stream([{ geographicView: { countryCriterionId: '2276' }, metrics: { costMicros: '500000000', conversions: 12 } }, { geographicView: { countryCriterionId: '2250' }, metrics: { costMicros: '100000000', conversions: 1 } }]);
  if (/campaign_budget\.amount_micros/.test(q)) {
    return stream([
      { campaign: { id: '11', resourceName: 'customers/1112223333/campaigns/11', name: 'Shopping all', status: 'ENABLED', servingStatus: 'SERVING', advertisingChannelType: 'SHOPPING', biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE', geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE_OR_INTEREST' }, networkSettings: { targetSearchNetwork: false } }, campaignBudget: { resourceName: 'customers/1112223333/campaignBudgets/71', amountMicros: '30000000', explicitlyShared: false } },
      { campaign: { id: '12', resourceName: 'customers/1112223333/campaigns/12', name: 'Brand search', status: 'ENABLED', servingStatus: 'SERVING', advertisingChannelType: 'SEARCH', biddingStrategyType: 'TARGET_ROAS', targetRoas: { targetRoas: 8 }, geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' }, networkSettings: { targetSearchNetwork: true } }, campaignBudget: { resourceName: 'customers/1112223333/campaignBudgets/72', amountMicros: '10000000', explicitlyShared: false } },
    ]);
  }
  if (/search_budget_lost_impression_share/.test(q)) {
    return stream([
      { campaign: { id: '11' }, metrics: { costMicros: '600000000', clicks: '900', impressions: '40000', conversions: 9, conversionsValue: 1000, searchBudgetLostImpressionShare: 0.05, searchRankLostImpressionShare: 0.3 } },
      { campaign: { id: '12' }, metrics: { costMicros: '150000000', clicks: '400', impressions: '3000', conversions: 9, conversionsValue: 1100, searchBudgetLostImpressionShare: 0, searchRankLostImpressionShare: 0.02 } },
    ]);
  }
  if (/LAST_7_DAYS/.test(q)) return stream([{ campaign: { id: '11' }, metrics: { impressions: '9000', costMicros: '140000000' } }, { campaign: { id: '12' }, metrics: { impressions: '700', costMicros: '35000000' } }]);
  if (/FROM search_term_view/.test(q)) {
    return stream([
      { campaign: { id: '12', name: 'Brand search' }, searchTermView: { searchTerm: 'acme headset', status: 'NONE' }, metrics: { clicks: '300', costMicros: '110000000', conversions: 9, conversionsValue: 1100 } },
      { campaign: { id: '11', name: 'Shopping all' }, searchTermView: { searchTerm: 'free headset manual pdf', status: 'NONE' }, metrics: { clicks: '40', costMicros: '31000000', conversions: 0, conversionsValue: 0 } },
      { campaign: { id: '11', name: 'Shopping all' }, searchTermView: { searchTerm: 'hearing protection', status: 'NONE' }, metrics: { clicks: '50', costMicros: '45000000', conversions: 2, conversionsValue: 240 } },
    ]);
  }
  if (/FROM shopping_performance_view/.test(q)) {
    return stream([
      { campaign: { id: '11', name: 'Shopping all', advertisingChannelType: 'SHOPPING' }, segments: { productItemId: 'gla_1', productTitle: 'Pro Headset' }, metrics: { clicks: '500', costMicros: '900000000', conversions: 20, conversionsValue: 2400 } },
      { campaign: { id: '11', name: 'Shopping all', advertisingChannelType: 'SHOPPING' }, segments: { productItemId: 'gla_21', productTitle: 'Ear Plugs Blue' }, metrics: { clicks: '60', costMicros: '30000000', conversions: 2, conversionsValue: 60 } },
      { campaign: { id: '11', name: 'Shopping all', advertisingChannelType: 'SHOPPING' }, segments: { productItemId: 'gla_4', productTitle: 'Gold Plated Case' }, metrics: { clicks: '400', costMicros: '420000000', conversions: 0, conversionsValue: 0 } },
    ]);
  }
  if (/LISTING_GROUP/.test(q)) {
    return stream([{ adGroup: { id: '51' }, adGroupCriterion: { resourceName: 'customers/1112223333/adGroupCriteria/51~1', listingGroup: { type: 'UNIT' }, negative: false, cpcBidMicros: '500000' } }]);
  }
  if (/FROM campaign_criterion/.test(q)) return stream([]);
  return new Response(JSON.stringify([{ error: { code: 400, message: `mock: unknown query ${q.slice(0, 80)}`, status: 'INVALID_ARGUMENT' } }]), { status: 400 });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  if (url.host === 'oauth2.googleapis.com') return json({ access_token: 'at-mock-123456', expires_in: 3600 });
  if (url.host === 'googleads.googleapis.com') {
    if (init.headers?.['developer-token'] !== 'dev-token-123456') return new Response('[{"error":{"code":401,"message":"bad token"}}]', { status: 401 });
    return ads(url, body ?? {});
  }
  if (url.host === 'searchconsole.googleapis.com') {
    return json({ rows: [
      { keys: ['acme'], clicks: 800, impressions: 2000, ctr: 0.4, position: 1.1 },
      { keys: ['acme headset'], clicks: 200, impressions: 600, ctr: 0.33, position: 1.0 },
      { keys: ['hearing protection'], clicks: 30, impressions: 3000, ctr: 0.01, position: 2.5 },
    ] });
  }
  if (url.host === 'analyticsdata.googleapis.com') {
    return json({ dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }], metricHeaders: [{ name: 'sessions' }, { name: 'ecommercePurchases' }, { name: 'purchaseRevenue' }],
      rows: [{ dimensionValues: [{ value: 'Paid Shopping' }], metricValues: [{ value: '1200' }, { value: '25' }, { value: '3000' }] }] });
  }
  if (url.host === 'shop.test') return woo(url);
  if (url.host === 'www.ecb.europa.eu') return new Response("<Cube><Cube time='2026-11-16'><Cube currency='USD' rate='1.1000'/><Cube currency='PLN' rate='4.30'/></Cube></Cube>", { status: 200 });
  if (url.host === 'api.dataforseo.com') {
    const [task] = body;
    log({ dataforseo: url.pathname, location: task.location_code, language: task.language_code, n: (task.keywords ?? []).length });
    const row = (keyword) => ({ keyword, search_volume: task.location_code === 2616 ? 2000 : 900, competition: 'LOW', competition_index: 20,
      low_top_of_page_bid: task.location_code === 2250 ? 2.5 : 0.2, high_top_of_page_bid: task.location_code === 2250 ? 4.5 : 0.6, cpc: null });
    const result = url.pathname.includes('keywords_for_keywords')
      ? [...task.keywords, `${task.keywords[0]} kaufen`, 'something else entirely'].map(row)
      : task.keywords.map(row);
    return json({ status_code: 20000, cost: 0.075, tasks: [{ status_code: 20000, status_message: 'Ok.', cost: 0.075, result }] });
  }
  throw new Error(`mock-fetch: unexpected request ${url.host}`);
};
