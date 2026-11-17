// Market research end to end against the fake Google / WooCommerce / DataForSEO / ECB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function setup(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-markets-'));
  const log = path.join(home, 'calls.log');
  const env = { ...process.env, GOOGLE_ADS_PROFIT_HOME: home, MOCK_LOG: log, GOOGLE_ADS_PROFIT_NO_WAIT: '1', ...extraEnv };
  const cli = (script, ...args) => {
    const r = spawnSync(process.execPath, ['--import', path.join(root, 'tests/fixtures/mock-fetch.mjs'), path.join(root, 'scripts', script), ...args], { env, encoding: 'utf8', cwd: root });
    return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
  };
  fs.writeFileSync(path.join(home, 'google-oauth-client.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 'csecret-123456' } }));
  fs.writeFileSync(path.join(home, 'google-token.json'), JSON.stringify({ refresh_token: 'rt-123456', scope: 'https://www.googleapis.com/auth/adwords' }));
  cli('setup.mjs', 'init');
  for (const [k, v] of [['google.developerToken', 'dev-token-123456'], ['google.customerId', '1112223333'], ['woo.url', 'https://shop.test'],
    ['woo.consumerKey', 'ck_abcdef123456'], ['woo.consumerSecret', 'cs_abcdef123456'], ['brandTerms', 'acme'], ['markets.siteLanguages', 'de, fr, en']]) cli('setup.mjs', 'set', k, v);
  fs.writeFileSync(path.join(home, 'market-seeds.json'), JSON.stringify({
    brand: ['acme'],
    markets: {
      DE: { groups: { Headsets: ['aktiver gehörschutz', 'gehörschutz schießen'], Earplugs: ['gehörschutz stöpsel'] } },
      FR: { groups: { Headsets: ['casque anti bruit tir'] } },
      PL: { groups: { Headsets: ['ochronniki słuchu aktywne'] } },
    },
  }));
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { home, cli, calls };
}

test('markets: overview, source choice, cost approval, ranking, cache', () => {
  const { home, cli, calls } = setup();
  let r = cli('markets.mjs', 'research');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /overview first/);

  r = cli('markets.mjs', 'overview');
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /Ships to: DE, FR, PL/);
  assert.match(r.out, /DE .* yes .*\d+/);
  assert.match(r.out, /Headsets/);
  assert.match(r.out, /CONVERSION RATE to plan with: 1%/);
  const context = JSON.parse(fs.readFileSync(path.join(home, 'markets-context.json'), 'utf8'));
  assert.ok(context.countries.DE.orders > context.countries.FR.orders);
  assert.equal(context.countries.DE.adsCost, 500);

  r = cli('markets.mjs', 'research');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /explorer|Explorer/);
  assert.match(r.err, /DataForSEO is not connected/);

  cli('setup.mjs', 'set', 'dataforseo.login', 'me@example.com');
  cli('setup.mjs', 'set', 'dataforseo.password', 'dfs-secret-123');
  r = cli('markets.mjs', 'research');
  assert.equal(r.code, 3, r.all);
  assert.match(r.out, /7 requests needed/);
  assert.match(r.out, /Estimated DataForSEO cost: ~0\.63 USD/);
  assert.match(r.out, /NOT RUN/);
  assert.equal(calls().filter((c) => c.dataforseo).length, 0, 'nothing paid without --yes');

  r = cli('markets.mjs', 'research', '--yes');
  assert.equal(r.code, 0, r.all);
  const paid = calls().filter((c) => c.dataforseo);
  assert.equal(paid.length, 7, '4 idea requests (one per market group) + 3 volume requests (the brand phrase per market)');
  assert.match(r.out, /WHERE ADVERTISING PAYS/);
  const table = r.out.split('WHERE ADVERTISING PAYS')[1];
  // DE: the headsets pay (earplugs do not, and are left out of the market verdict); FR: clicks too expensive;
  // PL: cheap clicks but the site is not in Polish, so conversion is halved and it no longer pays.
  const order = [...table.matchAll(/^(DE|FR|PL)\s/gm)].map((m) => m[1]);
  assert.equal(order[0], 'DE');
  assert.match(table, /DE .* 1\/2 .*worth a test/);
  assert.match(table, /FR .*does not pay/);
  assert.match(r.out, /site not in pl \(conversion halved\)/);
  assert.match(r.out, /aktiver gehörschutz/);
  assert.doesNotMatch(r.out, /something else entirely/, 'unrelated ideas are dropped');
  const spend = JSON.parse(fs.readFileSync(path.join(home, 'dataforseo-spend.json'), 'utf8'));
  assert.equal(spend.length, 7);

  r = cli('markets.mjs', 'research', '--yes');
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /0 requests needed/);
  assert.equal(calls().filter((c) => c.dataforseo).length, 7, 'second run is served from the cache');

  cli('setup.mjs', 'set', 'dataforseo.dailyLimitUsd', '0.1');
  fs.rmSync(path.join(home, 'keyword-cache.json'));
  r = cli('markets.mjs', 'research', '--yes');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /daily DataForSEO limit/);
});

test('markets: Keyword Planner is used, free, when the token has Basic access', () => {
  const { cli, calls } = setup({ MOCK_PLANNER: '1' });
  assert.equal(cli('markets.mjs', 'overview').code, 0);
  const r = cli('markets.mjs', 'research');
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /Google Keyword Planner \(free\)/);
  assert.doesNotMatch(r.out, /Estimated DataForSEO cost/);
  assert.ok(calls().some((c) => c.planner === 'generateKeywordIdeas'));
  assert.equal(calls().filter((c) => c.dataforseo).length, 0);
});
