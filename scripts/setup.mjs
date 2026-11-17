#!/usr/bin/env node
// Setup and status.
//   node scripts/setup.mjs status          what is connected, and the next step (no network)
//   node scripts/setup.mjs init            create ~/.google-ads-profit/config.json
//   node scripts/setup.mjs open            open the settings file in a text editor
//   node scripts/setup.mjs set <key> <v>   e.g. set woo.url https://myshop.com
//   node scripts/setup.mjs show            settings with keys masked
//   node scripts/setup.mjs check           live test of every connection
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  configExists, ensureHome, getPath, loadConfig, maskedConfig, parseValue, paths, readJson, saveConfig, SECRET_KEYS, setPath, TEMPLATE,
} from './lib/config.mjs';
import { accountId, adsSearch, ga4Report, grantedScopes, gscQuery, SCOPES } from './lib/google.mjs';
import { WooClient, loadCostCsv } from './lib/woo.mjs';
import { lastDays, parseArgs, printJson, run, UserError } from './lib/util.mjs';

const { positional } = parseArgs();
const command = positional[0] ?? 'status';

function status() {
  const config = loadConfig();
  const major = Number(process.versions.node.split('.')[0]);
  const client = readJson(paths.oauthClient, null);
  const token = readJson(paths.token, null);
  const scopes = grantedScopes();
  const has = (scope) => scopes.includes(scope);
  const items = [
    { step: 1, name: 'Node.js 18 or newer', ok: major >= 18, detail: `found ${process.versions.node}` },
    { step: 2, name: 'Settings file', ok: configExists(), detail: paths.config },
    { step: 5, name: 'Google OAuth client (Desktop app)', ok: Boolean(client?.installed?.client_id), detail: client ? 'saved' : 'missing' },
    { step: 5, name: 'Signed in to Google', ok: Boolean(token?.refresh_token), detail: token?.created ? `since ${token.created.slice(0, 10)}` : token?.refresh_token ? 'yes' : 'not yet' },
    { step: 6, name: 'Google Ads developer token', ok: Boolean(config.google.developerToken) },
    { step: 7, name: 'Google Ads account chosen', ok: Boolean(config.google.customerId), detail: config.google.customerId || '' },
    { step: 9, name: 'WooCommerce shop + REST key', ok: Boolean(config.woo.url && config.woo.consumerKey && config.woo.consumerSecret), detail: config.woo.url || '' },
    { step: 10, name: 'Product costs (for profit)', ok: config.profit.defaultMarginPercent !== null || fs.existsSync(paths.costs) || null,
      detail: config.profit.defaultMarginPercent !== null ? `default margin ${config.profit.defaultMarginPercent}%`
        : fs.existsSync(paths.costs) ? `costs.csv (${loadCostCsv().size} rows)` : 'run: node scripts/woo.mjs cost-check' },
    { step: 8, name: 'GA4 property (optional)', ok: config.ga4.propertyId ? true : null, optional: true, detail: config.ga4.propertyId || (token && !has(SCOPES[1]) ? 'permission not granted at sign-in' : '') },
    { step: 8, name: 'Search Console site (optional)', ok: config.gsc.siteUrl ? true : null, optional: true, detail: config.gsc.siteUrl || (token && !has(SCOPES[2]) ? 'permission not granted at sign-in' : '') },
    { step: 13, name: 'DataForSEO (optional, for market research)', ok: config.dataforseo.login && config.dataforseo.password ? true : null, optional: true, detail: config.dataforseo.login ? `daily limit ${config.dataforseo.dailyLimitUsd} USD` : 'or Keyword Planner with Basic access' },
    { step: 11, name: 'Brand words (recommended)', ok: config.brandTerms.length ? true : null, optional: true, detail: config.brandTerms.join(', ') },
  ];
  const mark = (ok) => (ok === true ? '✓' : ok === null ? '·' : '✗');
  console.log('google-ads-profit setup');
  for (const item of items) console.log(`  ${mark(item.ok)} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
  const next = items.find((i) => i.ok === false);
  if (next) {
    console.log(`\nNEXT: setup step ${next.step} in references/setup.md (${next.name}).`);
  } else {
    console.log('\nREADY. Run "node scripts/setup.mjs check" once to test every connection live, then "node scripts/audit.mjs".');
    const unknownCosts = items.find((i) => i.step === 10 && i.ok !== true);
    if (unknownCosts) console.log('Note: product costs not confirmed yet — run "node scripts/woo.mjs cost-check".');
  }
}

function openInEditor(file) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', ['-t', file]]
    : process.platform === 'win32' ? ['notepad', [file]] : ['xdg-open', [file]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`Open this file in any text editor: ${file}`));
  child.unref();
}

async function check() {
  const config = loadConfig();
  const results = [];
  const test = async (name, fn) => {
    try {
      results.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      results.push({ name, ok: false, detail: error.message, hint: error.hint });
    }
  };
  const range = lastDays(7);

  await test('Google Ads', async () => {
    const id = accountId(config);
    const rows = await adsSearch(config, id, 'SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer');
    const c = rows[0]?.customer ?? {};
    const spend = await adsSearch(config, id, `SELECT metrics.cost_micros FROM customer WHERE segments.date BETWEEN '${range.from}' AND '${range.to}'`);
    const cost = spend.reduce((s, r) => s + Number(r.metrics?.costMicros ?? 0), 0) / 1e6;
    return `${c.descriptiveName ?? id} (${c.currencyCode}, ${c.timeZone}); spend last 7 days ${cost.toFixed(2)}`;
  });
  if (config.ga4.propertyId) {
    await test('GA4', async () => {
      const r = await ga4Report(config.ga4.propertyId, { dateRanges: [{ startDate: range.from, endDate: range.to }], metrics: [{ name: 'sessions' }, { name: 'ecommercePurchases' }] });
      const v = r.rows?.[0]?.metricValues ?? [];
      return `sessions ${v[0]?.value ?? 0}, purchases ${v[1]?.value ?? 0} (last 7 days)`;
    });
  }
  if (config.gsc.siteUrl) {
    await test('Search Console', async () => {
      const r = await gscQuery(config.gsc.siteUrl, { startDate: lastDays(7, 3).from, endDate: lastDays(7, 3).to, rowLimit: 1 });
      return `clicks ${r.rows?.[0]?.clicks ?? 0} (7 days, data lags ~3 days)`;
    });
  }
  await test('WooCommerce', async () => {
    const woo = new WooClient(config.woo);
    const { total } = await woo.get('orders', { per_page: 1, _fields: 'id' });
    const { data } = await woo.get('data/currencies/current').catch(() => ({ data: {} }));
    return `${total ?? '?'} orders in the shop; currency ${data.code ?? 'unknown'}`;
  });

  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail}`);
    if (r.hint) console.log(`    NEXT STEP: ${r.hint}`);
  }
  if (results.every((r) => r.ok)) console.log('\nAll connected. Run: node scripts/audit.mjs');
  else process.exitCode = 1;
}

run(async () => {
  switch (command) {
    case 'status':
      status();
      break;
    case 'init': {
      ensureHome();
      if (configExists()) console.log(`Settings file already exists: ${paths.config}`);
      else { saveConfig(TEMPLATE); console.log(`Created ${paths.config}`); }
      break;
    }
    case 'open':
      if (!configExists()) { ensureHome(); saveConfig(TEMPLATE); }
      openInEditor(paths.config);
      console.log(`Opened ${paths.config}. Fill in the values, save, and tell Claude when done.`);
      break;
    case 'set': {
      const [, key, ...rest] = positional;
      if (!key || !rest.length) throw new UserError('Usage: node scripts/setup.mjs set <key> <value>');
      const template = getPath(TEMPLATE, key);
      if (template === undefined) {
        throw new UserError(`Unknown setting "${key}".`, `Known: ${listKeys(TEMPLATE).join(', ')}`);
      }
      const raw = rest.join(' ');
      let value = typeof template === 'string' ? raw.trim() : parseValue(raw);
      if (Array.isArray(template) && typeof value === 'string') value = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (key === 'woo.url' && value && !/^https?:\/\//.test(value)) value = `https://${value}`;
      if ((key === 'google.customerId' || key === 'google.loginCustomerId') && value) value = String(value).replace(/[^0-9]/g, '');
      const config = configExists() ? readJson(paths.config, {}) : JSON.parse(JSON.stringify(TEMPLATE));
      setPath(config, key, value);
      saveConfig(config);
      console.log(`Saved ${key} = ${SECRET_KEYS.includes(key) ? `••••${String(value).slice(-4)}` : JSON.stringify(value)}`);
      break;
    }
    case 'show':
      printJson(maskedConfig(loadConfig()));
      break;
    case 'check':
      await check();
      break;
    default:
      throw new UserError(`Unknown command "${command}".`, 'Use: status | init | open | set | show | check');
  }
});

function listKeys(object, prefix = '') {
  return Object.entries(object).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? listKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}
