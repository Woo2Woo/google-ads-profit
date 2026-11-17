// Google: OAuth (the user's own Google Cloud "Desktop app" client), Google Ads REST, GA4, Search Console.
// Tokens stay in ~/.google-ads-profit/google-token.json. Errors never contain a token.
import { paths, readJson, writePrivateJson, secretsOf } from './config.mjs';
import { cleanId, redact, UserError } from './util.mjs';

export const SCOPES = [
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
];

/** Google consent URL for the loopback + PKCE flow. */
export function buildAuthUrl({ clientId, redirectUri, challenge, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export class GoogleError extends Error {
  constructor(message, { status = 0, details = null, hint = undefined } = {}) {
    super(message);
    this.name = 'GoogleError';
    this.status = status;
    this.details = details;
    this.hint = hint;
  }
}

export function readOAuthClient(file = paths.oauthClient) {
  const json = readJson(file, null);
  if (!json) {
    throw new UserError('Google OAuth client file is missing.',
      'Create a "Desktop app" OAuth client in Google Cloud, download its JSON and run: node scripts/google-login.mjs --client <downloaded.json>');
  }
  const inner = json.installed ?? json.web ?? json;
  if (!inner.client_id || !inner.client_secret) throw new UserError(`${file} is not a Google OAuth client file (no client_id / client_secret).`);
  return { clientId: inner.client_id, clientSecret: inner.client_secret, kind: json.installed ? 'installed' : json.web ? 'web' : 'unknown' };
}

let cached = null;

/** A fresh access token from the stored refresh token. */
export async function accessToken(transport = fetch) {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const token = readJson(paths.token, null);
  if (!token?.refresh_token) {
    throw new UserError('Not signed in to Google yet.', 'Run: node scripts/google-login.mjs');
  }
  const { clientId, clientSecret } = readOAuthClient();
  const response = await transport('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: token.refresh_token, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    if (body.error === 'invalid_grant') {
      throw new UserError('The Google sign-in has expired or was revoked.',
        'Run node scripts/google-login.mjs again. If this happens every 7 days, the OAuth app is still in "Testing": publish it (Google Auth Platform → Audience → Publish app).');
    }
    throw new GoogleError(`Google sign-in failed (${response.status}: ${body.error ?? 'unknown'} ${body.error_description ?? ''}).`, { status: response.status });
  }
  cached = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.value;
}

export function grantedScopes() {
  const token = readJson(paths.token, null);
  return String(token?.scope ?? '').split(/\s+/).filter(Boolean);
}

async function call(url, { method = 'GET', body, headers = {}, secrets = [], transport = fetch } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await transport(url, {
      method,
      headers: { authorization: `Bearer ${await accessToken(transport)}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    if (response.ok) return text ? JSON.parse(text) : {};
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await new Promise((done) => setTimeout(done, 2_000 * attempt));
      continue;
    }
    let details = text;
    try { details = JSON.parse(text); } catch { /* keep text */ }
    const summary = redact(summarizeError(details), [...secrets, cached?.value]).slice(0, 700);
    throw new GoogleError(`${new URL(url).host} → ${response.status}: ${summary}`, { status: response.status, details, hint: hintFor(summary, url) });
  }
}

/** The first error code and message Google returned, readable. */
export function summarizeError(details) {
  const first = Array.isArray(details) ? details[0] : details;
  const error = first?.error;
  const inner = error?.details?.find?.((d) => Array.isArray(d.errors))?.errors?.[0];
  if (inner) {
    const where = inner.location?.fieldPathElements?.map((e) => `${e.fieldName ?? ''}${e.index !== undefined ? `[${e.index}]` : ''}`).join('.');
    return `${Object.values(inner.errorCode ?? {}).join(',')}: ${inner.message ?? ''}${where ? ` (${where})` : ''}`;
  }
  if (error?.message) return `${error.status ?? ''} ${error.message}`.trim();
  return typeof details === 'string' ? details.slice(0, 400) : JSON.stringify(details).slice(0, 400);
}

export function hintFor(summary, url = '') {
  if (/DEVELOPER_TOKEN_NOT_APPROVED|only approved for use with test accounts/i.test(summary)) {
    return 'The developer token is only approved for test accounts. In the Google Ads manager account: Admin → API Center → apply for Basic access (or Explorer access, if offered). See references/setup.md step 6.';
  }
  if (/DEVELOPER_TOKEN_INVALID|developer token is not valid/i.test(summary)) return 'The developer token is wrong. Copy it again from API Center and run: node scripts/setup.mjs set google.developerToken <token>';
  if (/USER_PERMISSION_DENIED/.test(summary)) {
    return 'This Google login reaches the account only through a manager account. Set it: node scripts/setup.mjs set google.loginCustomerId <manager id> (see: node scripts/ads.mjs accounts).';
  }
  if (/CUSTOMER_NOT_ENABLED|CUSTOMER_NOT_FOUND/.test(summary)) return 'That Google Ads account id is not active or not reachable. Pick another with: node scripts/ads.mjs accounts';
  if (/has not been used in project|SERVICE_DISABLED|is disabled/i.test(summary)) {
    return 'This Google API is not enabled in your Google Cloud project. Open the link in the error, click "Enable", wait a minute and try again.';
  }
  if (/insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(summary)) {
    return 'The Google sign-in is missing a permission (a box was unticked). Run node scripts/google-login.mjs again and tick every box.';
  }
  if (/googleads/.test(url) && /404|UNSUPPORTED_VERSION|deprecated|sunset/i.test(summary)) {
    return 'This Google Ads API version is no longer served. Set a newer one, e.g.: node scripts/setup.mjs set google.apiVersion v26 (current versions: developers.google.com/google-ads/api/docs/sunset-dates).';
  }
  if (/PERMISSION_DENIED|does not have sufficient permission|User does not have/i.test(summary)) {
    return 'The signed-in Google user has no access to this property/site. Sign in with the right Google account or add this user to it.';
  }
  if (/RESOURCE_EXHAUSTED|RESOURCE_TEMPORARILY_EXHAUSTED|quota/i.test(summary)) return 'Google API quota reached. Wait (the error says how long) and use smaller queries.';
  return undefined;
}

// ---------- Google Ads ----------

function adsConfig(config) {
  const g = config.google ?? {};
  if (!g.developerToken) {
    throw new UserError('Google Ads developer token is not set.', 'See references/setup.md step 6, then: node scripts/setup.mjs set google.developerToken <token>');
  }
  return { token: g.developerToken, login: cleanId(g.loginCustomerId), version: g.apiVersion || 'v25' };
}

function adsHeaders(config) {
  const { token, login } = adsConfig(config);
  return { 'developer-token': token, ...(login ? { 'login-customer-id': login } : {}) };
}

export function accountId(config, override) {
  const id = cleanId(override ?? config.google?.customerId);
  if (!id) throw new UserError('No Google Ads account chosen.', 'List them with: node scripts/ads.mjs accounts — then: node scripts/setup.mjs set google.customerId <id>');
  return id;
}

export async function adsSearch(config, customerId, query, transport = fetch) {
  const { version } = adsConfig(config);
  const chunks = await call(`https://googleads.googleapis.com/${version}/customers/${cleanId(customerId)}/googleAds:searchStream`, {
    method: 'POST', body: { query }, headers: adsHeaders(config), secrets: secretsOf(config), transport,
  });
  return (Array.isArray(chunks) ? chunks : []).flatMap((chunk) => chunk.results ?? []);
}

/** One service mutate (campaignCriteria, campaignBudgets, campaigns, adGroupCriteria). */
export async function adsMutate(config, customerId, service, operations, { validateOnly = false, transport = fetch } = {}) {
  const { version } = adsConfig(config);
  return call(`https://googleads.googleapis.com/${version}/customers/${cleanId(customerId)}/${service}:mutate`, {
    method: 'POST', body: { operations, validateOnly }, headers: adsHeaders(config), secrets: secretsOf(config), transport,
  });
}

export async function adsAccessibleCustomers(config, transport = fetch) {
  const { version } = adsConfig(config);
  const body = await call(`https://googleads.googleapis.com/${version}/customers:listAccessibleCustomers`, {
    headers: adsHeaders(config), secrets: secretsOf(config), transport,
  });
  return (body.resourceNames ?? []).map((name) => name.split('/').pop());
}

/** A customer-level method such as generateKeywordIdeas (POST customers/{id}:{method}). */
export async function adsCustomerMethod(config, customerId, method, body, transport = fetch) {
  const { version } = adsConfig(config);
  return call(`https://googleads.googleapis.com/${version}/customers/${cleanId(customerId)}:${method}`, {
    method: 'POST', body, headers: adsHeaders(config), secrets: secretsOf(config), transport,
  });
}

// ---------- GA4 ----------

export async function ga4Properties(transport = fetch) {
  const out = [];
  let pageToken = '';
  do {
    const body = await call(`https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { transport });
    for (const account of body.accountSummaries ?? []) {
      for (const property of account.propertySummaries ?? []) {
        out.push({ propertyId: property.property.split('/').pop(), name: property.displayName, account: account.displayName });
      }
    }
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

export async function ga4Report(propertyId, body, transport = fetch) {
  const id = cleanId(propertyId);
  if (!id) throw new UserError('GA4 property is not set.', 'List them with: node scripts/ga4.mjs properties — then: node scripts/setup.mjs set ga4.propertyId <id>');
  return call(`https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`, { method: 'POST', body, transport });
}

/** GA4 runReport rows → plain objects keyed by dimension/metric names. */
export function ga4Rows(report) {
  const dims = (report.dimensionHeaders ?? []).map((h) => h.name);
  const mets = (report.metricHeaders ?? []).map((h) => h.name);
  return (report.rows ?? []).map((row) => ({
    ...Object.fromEntries(dims.map((d, i) => [d, row.dimensionValues?.[i]?.value ?? null])),
    ...Object.fromEntries(mets.map((m, i) => [m, Number(row.metricValues?.[i]?.value ?? 0)])),
  }));
}

// ---------- Search Console ----------

export async function gscSites(transport = fetch) {
  const body = await call('https://searchconsole.googleapis.com/webmasters/v3/sites', { transport });
  return (body.siteEntry ?? []).map((s) => ({ siteUrl: s.siteUrl, permission: s.permissionLevel }));
}

export async function gscQuery(siteUrl, body, transport = fetch) {
  if (!siteUrl) throw new UserError('Search Console site is not set.', 'List them with: node scripts/gsc.mjs sites — then: node scripts/setup.mjs set gsc.siteUrl "<site>"');
  return call(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, { method: 'POST', body, transport });
}
