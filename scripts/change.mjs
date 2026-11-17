#!/usr/bin/env node
// Changes to Google Ads — always in two steps, so nothing happens without the user's explicit yes.
//
//   node scripts/change.mjs propose --json '{"type":"add_negative","campaignId":"123","text":"free download","reason":"…"}'
//        Reads the live account, checks the limits, asks Google to validate (validateOnly — nothing changes),
//        and records the proposal. Prints exactly what would change and how it would be undone.
//   node scripts/change.mjs apply <id>        make the proposed change (only after the user said yes)
//   node scripts/change.mjs undo <id>         put it back exactly as it was
//   node scripts/change.mjs discard <id>      drop a proposal
//   node scripts/change.mjs list [--all]      the journal
//   node scripts/change.mjs evaluate <id>     14 days before vs after: campaign + shop profit after ads
//
// Types: add_negative {campaignId,text,matchType?=EXACT} · set_budget {campaignId,to} ·
//        set_target_roas {campaignId,to:"350%"|3.5,breakEvenRoas?} · pause_campaign / enable_campaign {campaignId} ·
//        exclude_products {campaignId,itemIds:[...]} (Standard Shopping)
// --override "<the user's reason>" lifts the 14-day / ±20 % limits for one change (never the brand-word rule).
import { loadConfig } from './lib/config.mjs';
import { accountId, adsMutate } from './lib/google.mjs';
import { campaignNegatives, campaigns, dailyTotals, partitions } from './lib/ads-data.mjs';
import { BIG, Blocked, nextId, prepare, readJournal, writeJournal } from './lib/changes.mjs';
import { shopProfit } from './lib/woo.mjs';
import { daysBetween, isoDay, lastDays, num, parseArgs, round, run, shiftDay, table, UserError } from './lib/util.mjs';

const { positional, flags } = parseArgs();
const command = positional[0];

async function liveState(config, account, spec) {
  const range = lastDays(7);
  const all = await campaigns(config, account, range);
  const campaign = spec.campaignId ? all.find((c) => c.id === String(spec.campaignId)) ?? null : null;
  const negatives = spec.type === 'add_negative' && campaign ? await campaignNegatives(config, account, campaign.id) : [];
  const tree = spec.type === 'exclude_products' && campaign ? await partitions(config, account, campaign.id) : [];
  return { campaign, negatives, partitions: tree };
}

function describe(entry) {
  return [
    `#${entry.id} ${entry.status.toUpperCase()}${entry.big ? ' (big change)' : ''}: ${entry.title}`,
    entry.reason ? `  why: ${entry.reason}` : null,
    entry.override ? `  limits lifted by the user: ${entry.override}` : null,
  ].filter(Boolean).join('\n');
}

async function execute(config, account, spec, options) {
  const entries = readJournal();
  const live = await liveState(config, account, spec);
  const change = prepare(spec, live, { config, entries, account, ...options });
  await adsMutate(config, account, change.service, change.operations, { validateOnly: true });
  return { change, live, entries };
}

run(async () => {
  const config = loadConfig();

  switch (command) {
    case 'propose': {
      const raw = flags.json ?? positional.slice(1).join(' ');
      if (!raw) throw new UserError('Usage: node scripts/change.mjs propose --json \'{"type":"…","campaignId":"…",…,"reason":"…"}\'');
      let spec;
      try { spec = JSON.parse(raw); } catch { throw new UserError('The --json value is not valid JSON.'); }
      const account = accountId(config, spec.account ?? flags.account);
      const override = typeof flags.override === 'string' ? flags.override : null;
      let result;
      try {
        result = await execute(config, account, spec, { override });
      } catch (error) {
        if (error instanceof Blocked) {
          console.log('NOT PROPOSED — a limit blocks it:');
          for (const r of error.reasons) console.log(`  - ${r}`);
          process.exitCode = 2;
          return;
        }
        throw error;
      }
      const { change, entries } = result;
      const entry = {
        id: nextId(entries), account, type: spec.type, spec, title: change.title, reason: spec.reason ?? '', big: change.big,
        status: 'proposed', createdAt: new Date().toISOString(), from: change.from, to: change.to, override,
      };
      entries.push(entry);
      writeJournal(entries);
      console.log(describe(entry));
      console.log('  Google checked it (validateOnly) — nothing has changed yet.');
      const undo = change.inverse(['<created>']);
      console.log(`  undo: ${undo ? `${undo.type} ${JSON.stringify({ ...undo, type: undefined })}` : 'not needed'}`);
      console.log(`\nApply only after the user says yes: node scripts/change.mjs apply ${entry.id}`);
      break;
    }
    case 'apply': {
      const id = num(positional[1], NaN);
      const entries = readJournal();
      const entry = entries.find((e) => e.id === id);
      if (!entry) throw new UserError(`No change #${positional[1]}.`, 'See: node scripts/change.mjs list');
      if (entry.status !== 'proposed') throw new UserError(`#${id} is ${entry.status}, not proposed.`);
      if (Date.now() - Date.parse(entry.createdAt) > 3 * 86_400_000) throw new UserError(`#${id} was proposed more than 3 days ago.`, 'Propose it again so it is checked against today\'s account.');
      const { change } = await execute(config, entry.account, entry.spec, { override: entry.override });
      if (JSON.stringify(change.from) !== JSON.stringify(entry.from)) {
        throw new UserError(`The account changed since #${id} was proposed (was ${JSON.stringify(entry.from)}, now ${JSON.stringify(change.from)}).`, 'Propose it again.');
      }
      try {
        const response = await adsMutate(config, entry.account, change.service, change.operations);
        const names = (response.results ?? []).map((r) => r.resourceName ?? '');
        Object.assign(entry, { status: 'applied', appliedAt: new Date().toISOString(), resourceNames: names, inverse: change.inverse(names) });
      } catch (error) {
        Object.assign(entry, { status: 'failed', error: error.message });
        writeJournal(entries);
        throw error;
      }
      writeJournal(entries);
      console.log(describe(entry));
      console.log(`  Done in Google Ads. Undo any time: node scripts/change.mjs undo ${id}`);
      if (entry.big) console.log(`  Evaluate after 14 days (${shiftDay(isoDay(), 14)}): node scripts/change.mjs evaluate ${id}`);
      break;
    }
    case 'undo': {
      const id = num(positional[1], NaN);
      const entries = readJournal();
      const entry = entries.find((e) => e.id === id);
      if (!entry || entry.status !== 'applied') throw new UserError(`#${positional[1]} is not an applied change.`, 'See: node scripts/change.mjs list');
      if (!entry.inverse) throw new UserError(`#${id} has no stored undo.`);
      const { change } = await execute(config, entry.account, entry.inverse, { isUndo: true });
      const response = await adsMutate(config, entry.account, change.service, change.operations);
      const names = (response.results ?? []).map((r) => r.resourceName ?? '');
      const revert = {
        id: nextId(entries), account: entry.account, type: entry.inverse.type, spec: entry.inverse, title: `undo #${id}: ${change.title}`,
        reason: flags.reason ?? '', big: BIG.has(entry.inverse.type), status: 'applied', createdAt: new Date().toISOString(),
        appliedAt: new Date().toISOString(), from: change.from, to: change.to, revertOf: id, resourceNames: names, inverse: change.inverse(names),
      };
      entry.status = 'reverted';
      entry.revertedAt = revert.appliedAt;
      entries.push(revert);
      writeJournal(entries);
      console.log(`#${id} undone (${change.title}). Journal entry #${revert.id}.`);
      break;
    }
    case 'discard': {
      const id = num(positional[1], NaN);
      const entries = readJournal();
      const entry = entries.find((e) => e.id === id && e.status === 'proposed');
      if (!entry) throw new UserError(`#${positional[1]} is not an open proposal.`);
      entry.status = 'discarded';
      writeJournal(entries);
      console.log(`#${id} discarded.`);
      break;
    }
    case 'list': {
      const entries = readJournal().filter((e) => flags.all || e.status === 'proposed' || e.status === 'applied');
      console.log(table(entries.slice(-50).map((e) => ({
        id: e.id, status: e.status, day: (e.appliedAt ?? e.createdAt).slice(0, 10), big: e.big ? 'yes' : '', change: e.title, reason: e.reason,
      }))));
      break;
    }
    case 'evaluate': {
      const id = num(positional[1], NaN);
      const entry = readJournal().find((e) => e.id === id);
      if (!entry?.appliedAt) throw new UserError(`#${positional[1]} was never applied.`);
      const day = entry.appliedAt.slice(0, 10);
      const yesterday = shiftDay(isoDay(), -1);
      const before = { from: shiftDay(day, -14), to: shiftDay(day, -1) };
      const after = { from: shiftDay(day, 1), to: [shiftDay(day, 14), yesterday].sort()[0] };
      const afterDays = after.to >= after.from ? daysBetween(after.from, after.to) : 0;
      if (afterDays < 7) {
        console.log(`#${id} was applied on ${day}: only ${afterDays} full days since. Too early to judge — wait until ${shiftDay(day, 14)}.`);
        break;
      }
      const windows = [['before', before], ['after', after]];
      const rows = [];
      for (const [name, w] of windows) {
        const d = daysBetween(w.from, w.to);
        const ads = await dailyTotals(config, entry.account, w);
        const adCost = ads.reduce((s, x) => s + x.cost, 0);
        const shop = await shopProfit(config, w);
        let camp = null;
        if (entry.spec.campaignId) {
          const list = await campaigns(config, entry.account, w);
          camp = list.find((c) => c.id === String(entry.spec.campaignId)) ?? null;
        }
        rows.push({
          window: `${name} ${w.from}…${w.to}`, days: d,
          'orders/day': round(shop.totals.orders / d), 'ad cost/day': round(adCost / d),
          'profit after ads/day': shop.totals.profitBeforeAds === null ? null : round((shop.totals.profitBeforeAds - adCost) / d),
          'campaign cost/day': camp ? round(camp.cost / d) : null, 'campaign ROAS': camp?.roas ?? null,
          'campaign conv/day': camp ? round(camp.conversions / d) : null,
        });
      }
      console.log(describe(entry));
      console.log(table(rows));
      console.log('\nJudge on profit after ads per day for the whole shop first, the campaign second. Season, promotions,');
      console.log('stock-outs and other changes in the same weeks also move these numbers — name them before calling it.');
      console.log(`If it did not pay: node scripts/change.mjs undo ${id}`);
      break;
    }
    default:
      throw new UserError(`Unknown command "${command ?? ''}".`, 'Use: propose | apply | undo | discard | list | evaluate');
  }
});
