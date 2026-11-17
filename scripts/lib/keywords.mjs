// Search demand per market: monthly searches, click prices and competition for phrases.
//
// Two sources, same output:
//  - Google Keyword Planner (free) — through the user's Google Ads API token, but Google allows it only
//    with Basic or Standard access ("not allowed for use with explorer access").
//  - DataForSEO (paid, works at once) — the user's own account. Measured 2026-09: ~0.09 USD per request
//    of up to 1 000 phrases. Every paid call is estimated first, needs the user's yes, is capped per day
//    and written to ~/.google-ads-profit/dataforseo-spend.json. Answers are cached for 30 days.
import { paths, readJson, writePrivateJson } from './config.mjs';
import { adsCustomerMethod, adsSearch, GoogleError } from './google.mjs';
import { isoDay, micros, num, redact, round, UserError } from './util.mjs';

export class SourceError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'SourceError';
    this.hint = hint;
  }
}

/** One phrase in one market, whatever the source. Money in `currency`. */
export function keywordRow({ keyword, volume, competition = null, competitionIndex = null, cpcLow = null, cpcHigh = null, cpcAvg = null, currency }) {
  return { keyword, volume: volume === null || volume === undefined ? null : Number(volume), competition, competitionIndex, cpcLow, cpcHigh, cpcAvg, currency };
}

/** Google allows ≤ 80 characters and ≤ 10 words; DataForSEO also refuses some symbols. */
export function cleanPhrase(text) {
  const t = String(text ?? '').toLowerCase().replace(/[!@%^*()={};~`<>?\\|,"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 80 || t.split(' ').length > 10) return null;
  return t;
}

// ---------- Google Keyword Planner ----------

const competitionOf = (value) => (value && value !== 'UNSPECIFIED' && value !== 'UNKNOWN' ? String(value) : null);

function plannerRow(text, m, currency) {
  return keywordRow({
    keyword: text, volume: m?.avgMonthlySearches ?? 0, competition: competitionOf(m?.competition), competitionIndex: m?.competitionIndex ?? null,
    cpcLow: m?.lowTopOfPageBidMicros ? round(micros(m.lowTopOfPageBidMicros)) : null,
    cpcHigh: m?.highTopOfPageBidMicros ? round(micros(m.highTopOfPageBidMicros)) : null,
    cpcAvg: m?.averageCpcMicros ? round(micros(m.averageCpcMicros)) : null,
    currency,
  });
}

/** Can this Google Ads token use Keyword Planner? (Explorer access cannot.) */
export async function plannerStatus(config, account) {
  try {
    await adsCustomerMethod(config, account, 'generateKeywordHistoricalMetrics', {
      keywords: ['test'], geoTargetConstants: ['geoTargetConstants/2840'], keywordPlanNetwork: 'GOOGLE_SEARCH',
    });
    return { available: true };
  } catch (error) {
    if (error instanceof GoogleError && /explorer access|DEVELOPER_TOKEN_NOT_APPROVED|test accounts/i.test(error.message)) {
      return { available: false, reason: 'the developer token has Explorer or Test access; Keyword Planner needs Basic access (references/setup.md step 6)' };
    }
    throw error;
  }
}

export async function plannerLanguageIds(config, account, codes) {
  const list = [...new Set(codes)].map((c) => `'${String(c).replace(/[^a-zA-Z_-]/g, '')}'`).join(',');
  const rows = await adsSearch(config, account, `SELECT language_constant.id, language_constant.code FROM language_constant WHERE language_constant.code IN (${list})`);
  return new Map(rows.map((r) => [r.languageConstant.code, String(r.languageConstant.id)]));
}

// Tests set GOOGLE_ADS_PROFIT_NO_WAIT=1; real runs keep the providers' rate limits.
const pause = (ms) => (process.env.GOOGLE_ADS_PROFIT_NO_WAIT ? Promise.resolve() : new Promise((done) => setTimeout(done, ms)));

export async function plannerMetrics(config, account, { geo, languageId, keywords, currency }) {
  const out = [];
  for (let i = 0; i < keywords.length; i += 1000) {
    const body = await adsCustomerMethod(config, account, 'generateKeywordHistoricalMetrics', {
      keywords: keywords.slice(i, i + 1000), geoTargetConstants: [`geoTargetConstants/${geo}`], language: `languageConstants/${languageId}`,
      keywordPlanNetwork: 'GOOGLE_SEARCH', historicalMetricsOptions: { includeAverageCpc: true },
    });
    for (const r of body.results ?? []) {
      out.push(plannerRow(r.text, r.keywordMetrics, currency));
      for (const variant of r.closeVariants ?? []) if (variant !== r.text) out.push({ ...plannerRow(variant, r.keywordMetrics, currency), variantOf: r.text });
    }
    await pause(1100);
  }
  return out;
}

export async function plannerIdeas(config, account, { geo, languageId, seeds, currency, pageSize = 300 }) {
  const body = await adsCustomerMethod(config, account, 'generateKeywordIdeas', {
    geoTargetConstants: [`geoTargetConstants/${geo}`], language: `languageConstants/${languageId}`, keywordPlanNetwork: 'GOOGLE_SEARCH',
    keywordSeed: { keywords: seeds.slice(0, 20) }, pageSize, historicalMetricsOptions: { includeAverageCpc: true },
  });
  await pause(1100);
  return (body.results ?? []).map((r) => plannerRow(r.text, r.keywordIdeaMetrics, currency));
}

// ---------- DataForSEO ----------

export const DFS_USD_PER_TASK = 0.09;

export function dataforseoConfigured(config) {
  return Boolean(config.dataforseo?.login && config.dataforseo?.password);
}

export function spentToday(today = isoDay()) {
  const ledger = readJson(paths.spend, []);
  return round(ledger.filter((e) => e.day === today).reduce((s, e) => s + num(e.usd), 0), 4);
}

function recordSpend(entry) {
  const ledger = readJson(paths.spend, []);
  ledger.push({ day: isoDay(), at: new Date().toISOString(), ...entry });
  writePrivateJson(paths.spend, ledger.slice(-2000));
}

let lastCall = 0;

async function dfsPost(config, endpoint, payload, { purpose, transport = fetch } = {}) {
  if (!dataforseoConfigured(config)) {
    throw new UserError('DataForSEO is not connected.', 'See references/setup.md step 13, then set dataforseo.login and dataforseo.password.');
  }
  const limit = num(config.dataforseo.dailyLimitUsd, 5);
  if (spentToday() + DFS_USD_PER_TASK > limit) {
    throw new SourceError(`DataForSEO daily limit reached (${spentToday()} of ${limit} USD today).`, 'Wait until tomorrow or raise it: node scripts/setup.mjs set dataforseo.dailyLimitUsd 10');
  }
  // Google Ads endpoints at DataForSEO allow about 12 live requests a minute.
  const wait = lastCall + 5_200 - Date.now();
  if (wait > 0) await pause(wait);
  lastCall = Date.now();
  const auth = Buffer.from(`${config.dataforseo.login}:${config.dataforseo.password}`).toString('base64');
  const response = await transport(`https://api.dataforseo.com/v3/${endpoint}`, {
    method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const answer = await response.json().catch(() => ({}));
  const task = answer.tasks?.[0];
  const cost = num(answer.cost ?? task?.cost, 0);
  if (cost > 0) recordSpend({ usd: cost, endpoint, purpose });
  const message = redact(task?.status_message ?? answer.status_message ?? `HTTP ${response.status}`, [config.dataforseo.password]);
  if (response.status === 401 || answer.status_code === 40100 || answer.status_code === 40101) {
    throw new SourceError('DataForSEO refused the login.', 'Use the API login and API password from app.dataforseo.com → API Access (not the website password).');
  }
  if (task?.status_code === 40200 || answer.status_code === 40200 || /payment required/i.test(message)) {
    throw new SourceError('DataForSEO: the account balance is empty.', 'Top it up at app.dataforseo.com → Billing.');
  }
  if (!response.ok || answer.status_code !== 20000 || task?.status_code !== 20000) throw new SourceError(`DataForSEO ${endpoint}: ${message}`);
  return task.result ?? [];
}

function dfsRow(r) {
  return keywordRow({
    keyword: r.keyword, volume: r.search_volume ?? 0, competition: r.competition ?? null, competitionIndex: r.competition_index ?? null,
    cpcLow: r.low_top_of_page_bid ?? null, cpcHigh: r.high_top_of_page_bid ?? null, cpcAvg: r.cpc ?? null, currency: 'USD',
  });
}

export async function dfsMetrics(config, { geo, lang, keywords }, options = {}) {
  const out = [];
  for (let i = 0; i < keywords.length; i += 1000) {
    const result = await dfsPost(config, 'keywords_data/google_ads/search_volume/live', [{ keywords: keywords.slice(i, i + 1000), location_code: geo, language_code: lang }], { purpose: `volumes ${geo}/${lang}`, ...options });
    out.push(...result.filter((r) => r.keyword).map(dfsRow));
  }
  return out;
}

export async function dfsIdeas(config, { geo, lang, seeds }, options = {}) {
  const result = await dfsPost(config, 'keywords_data/google_ads/keywords_for_keywords/live', [{ keywords: seeds.slice(0, 20), location_code: geo, language_code: lang, sort_by: 'search_volume' }], { purpose: `ideas ${geo}/${lang}`, ...options });
  return result.filter((r) => r.keyword).map(dfsRow);
}

// ---------- cache (30 days) ----------

const TTL = 30 * 86_400_000;

export function openCache() {
  const data = readJson(paths.keywordCache, {});
  const now = Date.now();
  for (const [k, v] of Object.entries(data)) if (now - v.at > TTL) delete data[k];
  return {
    get: (key) => data[key]?.value,
    set: (key, value) => { data[key] = { at: now, value }; },
    save: () => writePrivateJson(paths.keywordCache, data),
  };
}

// ---------- exchange rates (ECB, no key) ----------

export async function fxRates(transport = fetch) {
  const response = await transport('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new SourceError(`ECB exchange rates → ${response.status}`);
  const xml = await response.text();
  const rates = { EUR: 1 };
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) rates[m[1]] = Number(m[2]);
  return rates;
}

/** amount in `from` → `to`, through EUR. */
export function convert(amount, from, to, rates) {
  if (amount === null || amount === undefined) return null;
  if (from === to) return amount;
  if (!rates[from] || !rates[to]) throw new SourceError(`No exchange rate for ${from} → ${to}.`);
  return (amount / rates[from]) * rates[to];
}
