// Where everything lives on this computer. Nothing is ever sent anywhere except to the user's own
// Google accounts and the user's own shop. Keys are kept in ~/.google-ads-profit (owner-only access).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError } from './util.mjs';

export const HOME = process.env.GOOGLE_ADS_PROFIT_HOME || path.join(os.homedir(), '.google-ads-profit');

export const paths = {
  home: HOME,
  config: path.join(HOME, 'config.json'),
  oauthClient: path.join(HOME, 'google-oauth-client.json'),
  token: path.join(HOME, 'google-token.json'),
  journal: path.join(HOME, 'journal.json'),
  costs: path.join(HOME, 'costs.csv'),
  seeds: path.join(HOME, 'market-seeds.json'),
  marketsContext: path.join(HOME, 'markets-context.json'),
  keywordCache: path.join(HOME, 'keyword-cache.json'),
  spend: path.join(HOME, 'dataforseo-spend.json'),
  reports: path.join(HOME, 'reports'),
};

export const TEMPLATE = {
  google: {
    developerToken: '',
    customerId: '',
    loginCustomerId: '',
    apiVersion: 'v25',
  },
  ga4: { propertyId: '' },
  gsc: { siteUrl: '' },
  woo: {
    url: '',
    consumerKey: '',
    consumerSecret: '',
    paidStatuses: ['processing', 'completed'],
  },
  profit: {
    defaultMarginPercent: null,
    extraCostPerOrder: 0,
    paymentFeePercent: 0,
  },
  dataforseo: { login: '', password: '', dailyLimitUsd: 5 },
  markets: {
    conversionRate: null,
    clickShare: 0.05,
    minMonthlySearches: 300,
    siteLanguages: [],
    extraCostByCountry: {},
  },
  brandTerms: [],
  protectedTerms: [],
  limits: {
    maxBudgetChangePercent: 20,
    maxTargetRoasChangePercent: 20,
    bigChangeCooldownDays: 14,
    maxDailyBudget: null,
  },
};

/** Keys whose values must never be printed. */
export const SECRET_KEYS = ['google.developerToken', 'woo.consumerKey', 'woo.consumerSecret', 'dataforseo.password'];

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.reports, { recursive: true, mode: 0o700 });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new UserError(`${file} is not valid JSON (${error.message}).`, 'Fix the file by hand or delete it and run setup again.');
  }
}

/** Atomic write with owner-only permissions (the file may hold keys). */
export function writePrivateJson(file, data) {
  ensureHome();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
}

function merge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    out[key] = key in base && typeof base[key] === 'object' && base[key] !== null && !Array.isArray(base[key])
      ? merge(base[key], value)
      : value;
  }
  return out;
}

export function configExists() {
  return fs.existsSync(paths.config);
}

export function loadConfig() {
  return merge(TEMPLATE, readJson(paths.config, {}));
}

export function saveConfig(config) {
  writePrivateJson(paths.config, config);
}

export function getPath(object, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
}

/** Text from the command line → the value type the template expects. */
export function parseValue(raw) {
  const text = String(raw).trim();
  if (text === '') return '';
  if (text === 'null') return null;
  if (text === 'true' || text === 'false') return text === 'true';
  if (/^-?\d+(\.\d+)?$/.test(text) && !/^0\d/.test(text) && text.length < 10) return Number(text);
  if (text.startsWith('[') || text.startsWith('{')) {
    try { return JSON.parse(text); } catch { throw new UserError(`Not valid JSON: ${text}`); }
  }
  return text;
}

export function setPath(object, dotted, value) {
  const keys = dotted.split('.');
  let node = object;
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[keys.at(-1)] = value;
}

export function secretsOf(config) {
  const token = readJson(paths.token, {});
  const client = readJson(paths.oauthClient, {});
  const inner = client.installed ?? client.web ?? {};
  return [
    ...SECRET_KEYS.map((key) => getPath(config, key)),
    token.refresh_token, token.access_token, inner.client_secret,
  ].filter(Boolean);
}

/** Shows the config with secrets masked (last 4 characters kept so the user can recognise a key). */
export function maskedConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  for (const key of SECRET_KEYS) {
    const value = getPath(copy, key);
    if (value) setPath(copy, key, `••••${String(value).slice(-4)}`);
  }
  return copy;
}
