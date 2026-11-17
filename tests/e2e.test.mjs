// Runs the real scripts end to end against a fake Google + WooCommerce (tests/fixtures/mock-fetch.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-e2e-'));
const mockLog = path.join(home, 'mutations.log');
const env = { ...process.env, GOOGLE_ADS_PROFIT_HOME: home, MOCK_LOG: mockLog };

const cli = (script, ...args) => {
  const r = spawnSync(process.execPath, ['--import', path.join(root, 'tests/fixtures/mock-fetch.mjs'), path.join(root, 'scripts', script), ...args], { env, encoding: 'utf8', cwd: root });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
};
const mutations = () => (fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('end to end: setup → audit → propose → apply → undo, with limits', () => {
  let r = cli('setup.mjs', 'status');
  assert.match(r.out, /NEXT: setup step 2/);

  assert.equal(cli('setup.mjs', 'init').code, 0);
  fs.writeFileSync(path.join(home, 'google-oauth-client.json'), JSON.stringify({ installed: { client_id: 'cid.apps.googleusercontent.com', client_secret: 'csecret-123456' } }));
  fs.writeFileSync(path.join(home, 'google-token.json'), JSON.stringify({ refresh_token: 'rt-123456', scope: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly', created: '2026-11-17T00:00:00Z' }));
  for (const [k, v] of [
    ['google.developerToken', 'dev-token-123456'], ['google.customerId', '111-222-3333'], ['woo.url', 'shop.test'],
    ['woo.consumerKey', 'ck_abcdef123456'], ['woo.consumerSecret', 'cs_abcdef123456'], ['gsc.siteUrl', 'sc-domain:shop.test'],
    ['ga4.propertyId', '123456789'], ['brandTerms', 'acme'], ['profit.paymentFeePercent', '2'],
  ]) assert.equal(cli('setup.mjs', 'set', k, v).code, 0, `set ${k}`);

  r = cli('setup.mjs', 'show');
  assert.doesNotMatch(r.out, /dev-token-123456|cs_abcdef123456/, 'keys are masked');
  assert.match(r.out, /"customerId": "1112223333"/);
  assert.match(r.out, /"url": "https:\/\/shop.test"/);

  r = cli('setup.mjs', 'status');
  assert.match(r.out, /READY/);
  r = cli('setup.mjs', 'check');
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /✓ Google Ads: Test shop \(EUR/);
  assert.match(r.out, /✓ WooCommerce: \d+ orders in the shop; currency EUR/);

  r = cli('woo.mjs', 'cost-check');
  assert.match(r.out, /1 sold products have no cost/);

  r = cli('audit.mjs');
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /PROFIT AUDIT — Test shop/);
  assert.match(r.out, /PROFIT AFTER ADS/);
  assert.match(r.out, /Shopping all \(11\): ROAS [\d.]+ < break-even [\d.]+ .*first target ROAS/);
  assert.match(r.out, /location_interest|"interested in"/);
  assert.match(r.out, /Gold Plated Case/, 'product with spend and no shop sales is flagged');
  assert.match(r.out, /free headset manual pdf/);
  assert.doesNotMatch(r.out.split('Candidates')[1].split('BRAND')[0], /acme headset/, 'brand term is never a candidate');
  assert.match(r.out, /BRAND: paid brand searches 110/);
  assert.match(r.out, /hearing protection/, 'paid query already top 3 organically');
  assert.match(r.out, /ADD_TO_CART/);
  assert.ok(fs.readdirSync(path.join(home, 'reports')).some((f) => f.startsWith('audit-')));

  // Small change: negative keyword.
  r = cli('change.mjs', 'propose', '--json', JSON.stringify({ type: 'add_negative', campaignId: '11', text: 'free headset manual pdf', reason: 'test' }));
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /#1 PROPOSED/);
  assert.equal(mutations().length, 1);
  assert.equal(mutations()[0].validateOnly, true, 'propose only validates');

  r = cli('change.mjs', 'apply', '1');
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /#1 APPLIED/);
  const real = mutations().filter((m) => !m.validateOnly);
  assert.equal(real.length, 1);
  assert.equal(real[0].operations[0].create.keyword.text, 'free headset manual pdf');

  r = cli('change.mjs', 'undo', '1');
  assert.equal(r.code, 0, r.all);
  const undo = mutations().filter((m) => !m.validateOnly).at(-1);
  assert.match(undo.operations[0].remove, /created~/, 'undo removes exactly the created negative');

  // Brand negative is refused.
  r = cli('change.mjs', 'propose', '--json', JSON.stringify({ type: 'add_negative', campaignId: '12', text: 'acme manual' }));
  assert.equal(r.code, 2);
  assert.match(r.out, /brand/);

  // Big change, then a second big change is held for 14 days.
  r = cli('change.mjs', 'propose', '--json', JSON.stringify({ type: 'set_budget', campaignId: '11', to: 36, reason: 'test' }));
  assert.match(r.out, /#3 PROPOSED \(big change\)/, r.all);
  assert.equal(cli('change.mjs', 'apply', '3').code, 0);
  r = cli('change.mjs', 'propose', '--json', JSON.stringify({ type: 'set_target_roas', campaignId: '12', to: '700%', breakEvenRoas: 3 }));
  assert.equal(r.code, 2);
  assert.match(r.out, /one big change per 14 days/);
  r = cli('change.mjs', 'evaluate', '3');
  assert.match(r.out, /Too early/);

  r = cli('change.mjs', 'list', '--all');
  assert.match(r.out, /reverted/);
  assert.match(r.out, /applied/);

  r = cli('ads.mjs', 'query', 'DELETE everything');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /Only SELECT/);

  for (const file of ['config.json', 'journal.json']) {
    const mode = fs.statSync(path.join(home, file)).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600, `${file} is owner-only`);
  }
});
