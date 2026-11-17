import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blocked, bigChangeStatus, excludeOperations, parseRoas, prepare } from '../scripts/lib/changes.mjs';
import { TEMPLATE } from '../scripts/lib/config.mjs';

const config = { ...structuredClone(TEMPLATE), brandTerms: ['acme'], protectedTerms: ['earmuffs'] };
const campaign = (over = {}) => ({
  id: '11', name: 'Shopping', resourceName: 'customers/1/campaigns/11', status: 'ENABLED', type: 'SHOPPING',
  bidding: 'MAXIMIZE_CONVERSION_VALUE', portfolio: false, targetRoas: 4, budget: 50, budgetResourceName: 'customers/1/campaignBudgets/7', budgetShared: false, ...over,
});
const live = (over = {}) => ({ campaign: campaign(over), negatives: [], partitions: [] });
const ctx = (over = {}) => ({ config, entries: [], account: '1', today: '2026-11-17', ...over });
const blocked = (fn, re) => assert.throws(fn, (e) => e instanceof Blocked && re.test(e.message));

test('negatives: brand words are refused even with override; protected words need override', () => {
  blocked(() => prepare({ type: 'add_negative', campaignId: '11', text: 'acme manual' }, live(), ctx()), /brand/);
  blocked(() => prepare({ type: 'add_negative', campaignId: '11', text: 'acme manual' }, live(), ctx({ override: 'user insists' })), /brand/);
  blocked(() => prepare({ type: 'add_negative', campaignId: '11', text: 'kids earmuffs' }, live(), ctx()), /protected/);
  const ok = prepare({ type: 'add_negative', campaignId: '11', text: 'Free  PDF' }, live(), ctx());
  assert.deepEqual(ok.operations, [{ create: { campaign: 'customers/1/campaigns/11', negative: true, keyword: { text: 'free pdf', matchType: 'EXACT' } } }]);
  assert.deepEqual(ok.inverse(['customers/1/campaignCriteria/11~99']), { type: 'remove_negative', campaignId: '11', resourceName: 'customers/1/campaignCriteria/11~99', text: 'free pdf' });
  blocked(() => prepare({ type: 'add_negative', campaignId: '11', text: 'free pdf' }, { ...live(), negatives: [{ text: 'free pdf', matchType: 'EXACT' }] }, ctx()), /already/);
});

test('budget: ±20 % per 7 days counted from our own earlier change; shared budgets refused; undo is exempt', () => {
  const ok = prepare({ type: 'set_budget', campaignId: '11', to: 60 }, live(), ctx());
  assert.equal(ok.operations[0].update.amountMicros, '60000000');
  assert.deepEqual(ok.inverse(), { type: 'set_budget', campaignId: '11', to: 50 });
  blocked(() => prepare({ type: 'set_budget', campaignId: '11', to: 61 }, live(), ctx()), /±20%/);
  blocked(() => prepare({ type: 'set_budget', campaignId: '11', to: 55 }, live({ budgetShared: true }), ctx()), /shared/);
  // An earlier +20 % this week (40 → 48): the base stays 40, so 48 → 52 (+30 % on the week) is refused.
  const entries = [{ id: 1, account: '1', type: 'set_budget', spec: { campaignId: '11' }, status: 'applied', appliedAt: '2026-11-14T08:00:00Z', from: 40, to: 48, big: true }];
  blocked(() => prepare({ type: 'set_budget', campaignId: '11', to: 52 }, live({ budget: 48 }), ctx({ entries, override: null, today: '2026-11-17' })), /±20%|one big change/);
  assert.doesNotThrow(() => prepare({ type: 'set_budget', campaignId: '11', to: 40 }, live({ budget: 48 }), ctx({ entries, isUndo: true })));
});

test('one big change per 14 days; the user can lift it with an explicit reason', () => {
  const entries = [{ id: 1, account: '1', type: 'pause_campaign', spec: { campaignId: '9' }, status: 'applied', appliedAt: '2026-11-10T08:00:00Z', title: 'pause X', big: true }];
  blocked(() => prepare({ type: 'set_target_roas', campaignId: '11', to: '440%' }, live(), ctx({ entries })), /one big change/);
  assert.doesNotThrow(() => prepare({ type: 'set_target_roas', campaignId: '11', to: '440%' }, live(), ctx({ entries, override: 'season plan' })));
  assert.equal(bigChangeStatus(entries, '1', 14, '2026-11-24').allowed, true);
  assert.equal(bigChangeStatus(entries, '2', 14, '2026-11-17').allowed, true, 'another account is not affected');
  // small changes are never blocked by the cooldown
  assert.doesNotThrow(() => prepare({ type: 'add_negative', campaignId: '11', text: 'jobs' }, live(), ctx({ entries })));
});

test('target ROAS: field by bidding type, never below break-even, portfolio refused', () => {
  const max = prepare({ type: 'set_target_roas', campaignId: '11', to: '440%' }, live(), ctx());
  assert.equal(max.operations[0].updateMask, 'maximize_conversion_value.target_roas');
  assert.equal(max.operations[0].update.maximizeConversionValue.targetRoas, 4.4);
  const troas = prepare({ type: 'set_target_roas', campaignId: '11', to: 3.6 }, live({ bidding: 'TARGET_ROAS' }), ctx());
  assert.equal(troas.operations[0].updateMask, 'target_roas.target_roas');
  blocked(() => prepare({ type: 'set_target_roas', campaignId: '11', to: 3.3, breakEvenRoas: 3.5 }, live(), ctx()), /break-even/);
  blocked(() => prepare({ type: 'set_target_roas', campaignId: '11', to: 4.4 }, live({ portfolio: true }), ctx()), /portfolio/);
  assert.equal(parseRoas('350%'), 3.5);
  assert.equal(parseRoas('3,5'), 3.5);
  assert.equal(parseRoas(350), 3.5);
});

test('product exclusion: splits an "all products" root, or adds negatives under an item-id subdivision', () => {
  const single = [{ adGroupId: '5', resourceName: 'customers/1/adGroupCriteria/5~1', parentResourceName: null, type: 'UNIT', itemId: null, negative: false, cpcBidMicros: '400000' }];
  const ops = excludeOperations('1', ['gla_7'], single);
  assert.equal(ops.length, 4);
  assert.deepEqual(ops[0], { remove: 'customers/1/adGroupCriteria/5~1' });
  assert.equal(ops[2].create.cpcBidMicros, '400000');
  assert.equal(ops[3].create.listingGroup.caseValue.productItemId.value, 'gla_7');

  const split = [
    { adGroupId: '5', resourceName: 'r', parentResourceName: null, type: 'SUBDIVISION', itemId: null, negative: false },
    { adGroupId: '5', resourceName: 'r~all', parentResourceName: 'r', type: 'UNIT', itemId: null, negative: false },
    { adGroupId: '5', resourceName: 'r~7', parentResourceName: 'r', type: 'UNIT', itemId: 'gla_7', negative: false },
    { adGroupId: '5', resourceName: 'r~8', parentResourceName: 'r', type: 'UNIT', itemId: 'gla_8', negative: true },
  ];
  const ops2 = excludeOperations('1', ['gla_7', 'gla_8', 'gla_9'], split);
  assert.deepEqual(ops2.map((o) => o.remove ?? o.create.listingGroup.caseValue.productItemId.value), ['r~7', 'gla_7', 'gla_9']);

  const byBrand = [
    { adGroupId: '5', resourceName: 'r', parentResourceName: null, type: 'SUBDIVISION', itemId: null, negative: false },
    { adGroupId: '5', resourceName: 'r~b', parentResourceName: 'r', type: 'UNIT', itemId: null, negative: false },
  ];
  assert.deepEqual(excludeOperations('1', ['gla_7'], byBrand), []);

  const change = prepare({ type: 'exclude_products', campaignId: '11', itemIds: ['GLA_7'] }, { ...live(), partitions: single }, ctx());
  const inverse = change.inverse(['removed', 'sub', 'all', 'customers/1/adGroupCriteria/5~77']);
  assert.deepEqual(inverse.resourceNames, ['customers/1/adGroupCriteria/5~77']);
  blocked(() => prepare({ type: 'exclude_products', campaignId: '11', itemIds: ['gla_7'] }, live({ type: 'PERFORMANCE_MAX' }), ctx()), /Standard Shopping/);
});
