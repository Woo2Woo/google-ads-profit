// Changes to Google Ads: what each change type does, its limits, and its exact undo.
// Pure functions + the local journal (~/.google-ads-profit/journal.json). The network part is in change.mjs.
//
// Nothing is ever deleted in Google Ads: campaigns are paused, products excluded, negatives removed
// only when this tool added them. Every applied change stores its inverse, so undo is the same path.
import { paths, readJson, writePrivateJson } from './config.mjs';
import { containsAny, isoDay, round, shiftDay, toMicros } from './util.mjs';

export const TYPES = ['add_negative', 'remove_negative', 'set_budget', 'set_target_roas', 'pause_campaign', 'enable_campaign', 'exclude_products', 'include_products'];
/** Changes that make Smart Bidding re-learn (1–2 weeks): at most one per account per cooldown. */
export const BIG = new Set(['set_budget', 'set_target_roas', 'pause_campaign', 'enable_campaign', 'exclude_products']);

export function readJournal() {
  return readJson(paths.journal, []);
}

export function writeJournal(entries) {
  writePrivateJson(paths.journal, entries);
}

export function nextId(entries) {
  return entries.reduce((max, e) => Math.max(max, e.id), 0) + 1;
}

/** "350%", "3.5" → 3.5 (Google's target ROAS is a ratio). */
export function parseRoas(value) {
  const text = String(value).trim();
  const n = Number(text.replace('%', '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return text.endsWith('%') || n > 30 ? n / 100 : n;
}

/** Is a big change allowed now in this account? Undo of a change does not count as a new one. */
export function bigChangeStatus(entries, account, cooldownDays = 14, today = isoDay()) {
  const recent = entries
    .filter((e) => e.account === account && e.status !== 'proposed' && e.status !== 'discarded' && e.status !== 'failed' && BIG.has(e.type) && !e.revertOf && e.appliedAt)
    .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))[0];
  if (!recent) return { allowed: true, last: null, text: 'no big change recorded — one big change (budget, target ROAS, status, product exclusion) may be made now.' };
  const day = recent.appliedAt.slice(0, 10);
  const next = shiftDay(day, cooldownDays);
  const allowed = next <= today;
  return {
    allowed, last: { id: recent.id, title: recent.title, day }, next,
    text: allowed
      ? `last big change #${recent.id} on ${day} ("${recent.title}") — evaluate it (change.mjs evaluate ${recent.id}) before the next one.`
      : `last big change #${recent.id} on ${day} ("${recent.title}"); the next big change is due on ${next} (Smart Bidding re-learns, and two changes at once cannot be told apart).`,
  };
}

/** The budget/target the campaign had 7 days ago according to our own journal (for the ±% per week limit). */
function weekBase(entries, account, type, campaignId, current, today) {
  const since = shiftDay(today, -7);
  const earlier = entries
    .filter((e) => e.account === account && e.type === type && e.spec.campaignId === campaignId && e.status === 'applied' && e.appliedAt?.slice(0, 10) >= since)
    .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt))[0];
  return earlier?.from ?? current;
}

/**
 * Builds a change from the spec and the live state of the account.
 * live = { campaign, negatives: [...], partitions: [...] }
 * Returns { title, service, operations, from, to, inverse(resourceNames) } or throws Blocked.
 */
export class Blocked extends Error {
  constructor(reasons) {
    super(reasons.join('; '));
    this.name = 'Blocked';
    this.reasons = reasons;
  }
}

export function prepare(spec, live, { config, entries = [], account, today = isoDay(), override = null, isUndo = false }) {
  const c = live.campaign;
  const reasons = [];
  const limits = config.limits ?? {};
  const campaignRef = c ? `"${c.name}" (${c.id})` : '';
  if (!TYPES.includes(spec.type)) throw new Blocked([`unknown change type "${spec.type}"`]);
  if (spec.type !== 'remove_negative' && spec.type !== 'include_products' && !c) throw new Blocked([`campaign ${spec.campaignId} not found in this account`]);

  if (BIG.has(spec.type) && !isUndo && !override) {
    const status = bigChangeStatus(entries, account, limits.bigChangeCooldownDays ?? 14, today);
    if (!status.allowed) reasons.push(`one big change per ${limits.bigChangeCooldownDays ?? 14} days: ${status.text}`);
  }

  let result;
  switch (spec.type) {
    case 'add_negative': {
      const text = String(spec.text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
      const matchType = String(spec.matchType ?? 'EXACT').toUpperCase();
      if (!text) reasons.push('text is empty');
      if (!['EXACT', 'PHRASE', 'BROAD'].includes(matchType)) reasons.push('matchType must be EXACT, PHRASE or BROAD');
      if (text.length > 80 || text.split(' ').length > 10) reasons.push('Google allows at most 80 characters and 10 words');
      if (containsAny(text, config.brandTerms)) reasons.push('contains a brand word — a negative would block people searching for the brand');
      if (containsAny(text, config.protectedTerms) && !override) reasons.push('contains a protected word (protectedTerms) — it may block searches that sell');
      if (live.negatives.some((n) => n.text.toLowerCase() === text && n.matchType === matchType)) reasons.push('already a negative in this campaign');
      result = {
        title: `${campaignRef}: negative ${matchType.toLowerCase()} "${text}"`,
        service: 'campaignCriteria',
        operations: [{ create: { campaign: c.resourceName, negative: true, keyword: { text, matchType } } }],
        from: null, to: text,
        inverse: (names) => ({ type: 'remove_negative', campaignId: c.id, resourceName: names[0], text }),
      };
      break;
    }
    case 'remove_negative': {
      if (!spec.resourceName) reasons.push('resourceName of the negative is needed');
      result = {
        title: `remove negative "${spec.text ?? spec.resourceName}"`,
        service: 'campaignCriteria',
        operations: [{ remove: spec.resourceName }],
        from: spec.text ?? null, to: null,
        inverse: () => (spec.text && spec.campaignId ? { type: 'add_negative', campaignId: spec.campaignId, text: spec.text, matchType: spec.matchType ?? 'EXACT' } : null),
      };
      break;
    }
    case 'set_budget': {
      const to = round(Number(spec.to));
      const from = c.budget;
      if (!c.budgetResourceName || from === null) reasons.push('the campaign has no own budget');
      if (c.budgetShared) reasons.push('the budget is shared with other campaigns — change it by hand in Google Ads');
      if (!(to > 0)) reasons.push('"to" must be a positive daily amount');
      if (from && to > 0 && !isUndo && !override) {
        const limit = (limits.maxBudgetChangePercent ?? 20) / 100;
        const base = weekBase(entries, account, 'set_budget', c.id, from, today);
        if (Math.abs(to / base - 1) > limit + 1e-9) reasons.push(`more than ±${limits.maxBudgetChangePercent ?? 20}% in 7 days (${base} → ${to}); move in steps`);
      }
      if (limits.maxDailyBudget && to > limits.maxDailyBudget && !isUndo) reasons.push(`above the daily budget cap ${limits.maxDailyBudget} (limits.maxDailyBudget)`);
      result = {
        title: `${campaignRef}: daily budget ${from} → ${to}`,
        service: 'campaignBudgets',
        operations: [{ update: { resourceName: c.budgetResourceName, amountMicros: toMicros(to) }, updateMask: 'amount_micros' }],
        from, to,
        inverse: () => ({ type: 'set_budget', campaignId: c.id, to: from }),
      };
      break;
    }
    case 'set_target_roas': {
      const to = spec.to === null ? null : parseRoas(spec.to);
      const field = c.bidding === 'TARGET_ROAS' ? 'targetRoas' : c.bidding === 'MAXIMIZE_CONVERSION_VALUE' ? 'maximizeConversionValue' : null;
      if (c.portfolio) reasons.push('the campaign uses a shared (portfolio) bid strategy — change the target there, by hand');
      else if (!field) reasons.push(`bidding is ${c.bidding}; a target ROAS needs "Maximize conversion value" or "Target ROAS"`);
      if (spec.to !== null && to === null) reasons.push('"to" must be a ROAS like 3.5 or 350%');
      const from = c.targetRoas;
      if (from && to && !isUndo && !override) {
        const limit = (limits.maxTargetRoasChangePercent ?? 20) / 100;
        const base = weekBase(entries, account, 'set_target_roas', c.id, from, today);
        if (Math.abs(to / base - 1) > limit + 1e-9) reasons.push(`more than ±${limits.maxTargetRoasChangePercent ?? 20}% in 7 days (${round(base * 100, 0)}% → ${round(to * 100, 0)}%)`);
      }
      if (spec.breakEvenRoas && to && to < Number(spec.breakEvenRoas) && !override && !isUndo) reasons.push(`below break-even ROAS ${spec.breakEvenRoas} — that would buy sales at a loss`);
      const value = to === null ? {} : { targetRoas: to };
      result = {
        title: `${campaignRef}: target ROAS ${from === null ? 'none' : `${round(from * 100, 0)}%`} → ${to === null ? 'none' : `${round(to * 100, 0)}%`}`,
        service: 'campaigns',
        operations: [{
          update: field === 'targetRoas' ? { resourceName: c.resourceName, targetRoas: value } : { resourceName: c.resourceName, maximizeConversionValue: value },
          updateMask: field === 'targetRoas' ? 'target_roas.target_roas' : 'maximize_conversion_value.target_roas',
        }],
        from, to,
        inverse: () => ({ type: 'set_target_roas', campaignId: c.id, to: from }),
      };
      break;
    }
    case 'pause_campaign':
    case 'enable_campaign': {
      const status = spec.type === 'pause_campaign' ? 'PAUSED' : 'ENABLED';
      if (c.status === status) reasons.push(`the campaign is already ${status.toLowerCase()}`);
      result = {
        title: `${campaignRef}: ${status === 'PAUSED' ? 'pause' : 'enable'}`,
        service: 'campaigns',
        operations: [{ update: { resourceName: c.resourceName, status }, updateMask: 'status' }],
        from: c.status, to: status,
        inverse: () => ({ type: status === 'PAUSED' ? 'enable_campaign' : 'pause_campaign', campaignId: c.id }),
      };
      break;
    }
    case 'exclude_products': {
      const itemIds = (spec.itemIds ?? []).map((i) => String(i).toLowerCase()).filter(Boolean);
      if (c.type !== 'SHOPPING') reasons.push(`only Standard Shopping campaigns can be changed here; this one is ${c.type} (for Performance Max use a listing group filter by hand)`);
      if (!itemIds.length) reasons.push('itemIds is empty');
      const operations = c.type === 'SHOPPING' ? excludeOperations(account, itemIds, live.partitions ?? []) : [];
      if (c.type === 'SHOPPING' && itemIds.length && !operations.length) reasons.push('already excluded, or the product groups are subdivided by something else than item id (do it by hand)');
      result = {
        title: `${campaignRef}: exclude ${itemIds.length} product(s) ${itemIds.slice(0, 5).join(', ')}${itemIds.length > 5 ? '…' : ''}`,
        service: 'adGroupCriteria',
        operations,
        from: null, to: itemIds,
        // Only the new negative units are undone: subdivision + "everything else" acts like the old single node.
        inverse: (names) => ({
          type: 'include_products', campaignId: c.id, itemIds,
          resourceNames: names.filter((_, i) => operations[i]?.create?.negative === true),
        }),
      };
      break;
    }
    case 'include_products': {
      if (!spec.resourceNames?.length) reasons.push('nothing to include (resourceNames empty)');
      result = {
        title: `include again ${spec.itemIds?.length ?? spec.resourceNames?.length ?? 0} product(s)`,
        service: 'adGroupCriteria',
        operations: (spec.resourceNames ?? []).map((name) => ({ remove: name })),
        from: null, to: spec.itemIds ?? null,
        inverse: () => null,
      };
      break;
    }
    default:
      reasons.push(`unknown change type "${spec.type}"`);
  }
  if (reasons.length) throw new Blocked(reasons);
  return { ...result, big: BIG.has(spec.type) };
}

/**
 * Standard Shopping product exclusion. Two tree shapes are handled:
 *  1. the ad group's root is one "all products" unit → replaced by a subdivision by item id with
 *     "everything else" (same bid) + one negative unit per item, in one request;
 *  2. the root is already subdivided by item id → negative units are added (an existing positive unit is replaced).
 * Anything more complex (by brand, category, custom label) is left alone: returns no operations.
 */
export function excludeOperations(customerId, itemIds, partitions) {
  const operations = [];
  const groups = [...new Set(partitions.map((p) => p.adGroupId))];
  for (const adGroupId of groups) {
    const tree = partitions.filter((p) => p.adGroupId === adGroupId);
    const root = tree.find((p) => p.parentResourceName === null);
    if (!root) continue;
    const adGroup = `customers/${customerId}/adGroups/${adGroupId}`;
    const negativeUnit = (parent, itemId) => ({
      create: { adGroup, status: 'ENABLED', negative: true, listingGroup: { type: 'UNIT', parentAdGroupCriterion: parent, caseValue: { productItemId: { value: itemId } } } },
    });
    if (root.type === 'UNIT') {
      if (root.negative) continue;
      const temp = `customers/${customerId}/adGroupCriteria/${adGroupId}~-1`;
      operations.push({ remove: root.resourceName });
      operations.push({ create: { resourceName: temp, adGroup, status: 'ENABLED', listingGroup: { type: 'SUBDIVISION' } } });
      operations.push({
        create: {
          adGroup, status: 'ENABLED',
          listingGroup: { type: 'UNIT', parentAdGroupCriterion: temp, caseValue: { productItemId: {} } },
          ...(root.cpcBidMicros ? { cpcBidMicros: root.cpcBidMicros } : {}),
        },
      });
      for (const itemId of new Set(itemIds)) operations.push(negativeUnit(temp, itemId));
      continue;
    }
    const children = tree.filter((p) => p.parentResourceName === root.resourceName);
    if (!children.some((child) => child.itemId !== null)) continue;
    for (const itemId of new Set(itemIds)) {
      const existing = children.find((child) => child.itemId?.toLowerCase() === itemId);
      if (existing?.negative) continue;
      if (existing) {
        if (existing.type !== 'UNIT') continue;
        operations.push({ remove: existing.resourceName });
      }
      operations.push(negativeUnit(root.resourceName, itemId));
    }
  }
  return operations;
}
