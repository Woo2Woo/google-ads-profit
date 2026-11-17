#!/usr/bin/env node
// Google Ads, read only.
//   node scripts/ads.mjs accounts                       accounts this Google login can reach
//   node scripts/ads.mjs campaigns [--days 30]          spend, conversions, ROAS, budget, bidding, lost share
//   node scripts/ads.mjs search-terms [--days 30] [--min-cost 1] [--no-conversions] [--limit 100]
//   node scripts/ads.mjs products [--days 90] [--limit 100]
//   node scripts/ads.mjs negatives [--campaign <id>]
//   node scripts/ads.mjs locations                      countries/regions each campaign targets
//   node scripts/ads.mjs goals                          which conversion goals bidding optimises for
//   node scripts/ads.mjs changes [--days 14]            recent changes in the account (who/what)
//   node scripts/ads.mjs query "<GAQL>"                 any read query (references/gaql.md)
// Add --account <id> to use another account than the configured one, --json for raw JSON.
import { loadConfig } from './lib/config.mjs';
import { accountId, adsAccessibleCustomers, adsSearch } from './lib/google.mjs';
import { accountInfo, biddableGoals, campaignNegatives, campaigns, products, searchTerms } from './lib/ads-data.mjs';
import { lastDays, num, parseArgs, printJson, round, run, table, UserError, isoDay, shiftDay } from './lib/util.mjs';

const { positional, flags } = parseArgs();
const command = positional[0];

/** GAQL result rows → flat objects ("campaign.name": "…"). */
function flatten(row, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(row)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, name, out);
    else out[name] = value;
  }
  return out;
}

run(async () => {
  const config = loadConfig();
  const days = num(flags.days, command === 'products' ? 90 : 30);
  const range = lastDays(days);
  const limit = num(flags.limit, 100);
  const show = (rows, columns, title) => {
    if (flags.json) { printJson(rows); return; }
    if (title) console.log(title);
    console.log(table(rows.slice(0, limit), columns));
    if (rows.length > limit) console.log(`… ${rows.length - limit} more (use --limit or --json)`);
  };

  switch (command) {
    case 'accounts': {
      const ids = await adsAccessibleCustomers(config);
      const out = [];
      for (const id of ids) {
        // Each account is asked as itself (login-customer-id = its own id): a direct grant needs no manager.
        const own = { ...config, google: { ...config.google, loginCustomerId: id } };
        try {
          const info = await accountInfo(own, id);
          out.push(info);
          if (info.manager) {
            const clients = await adsSearch(own, id, `SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code,
                customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.level = 1`);
            for (const r of clients) {
              const c = r.customerClient;
              out.push({ id: String(c.id), name: c.descriptiveName ?? '', currency: c.currencyCode ?? '', manager: Boolean(c.manager), via: id, status: c.status });
            }
          }
        } catch (error) {
          out.push({ id, name: `(not readable: ${String(error.message).split(': ').slice(1).join(': ').slice(0, 50) || error.message.slice(0, 50)})` });
        }
      }
      show(out, ['id', 'name', 'currency', 'manager', 'via', 'status'], 'Google Ads accounts this login can reach ("via" = reached through that manager account → set it as google.loginCustomerId):');
      break;
    }
    case 'campaigns': {
      const rows = await campaigns(config, accountId(config, flags.account), range);
      const visible = rows.filter((c) => c.status === 'ENABLED' || c.cost > 0);
      show(visible.map((c) => ({
        id: c.id, name: c.name, status: c.status, type: c.type, bidding: c.bidding, tROAS: c.targetRoas ? `${round(c.targetRoas * 100, 0)}%` : null, budget: c.budget,
        cost: c.cost, conv: c.conversions, value: c.value, roas: c.roas,
        'lost budget %': c.budgetLostIs === null ? null : round(c.budgetLostIs * 100, 0),
        'lost rank %': c.rankLostIs === null ? null : round(c.rankLostIs * 100, 0),
      })), null, `Campaigns ${range.from} … ${range.to}`);
      break;
    }
    case 'search-terms': {
      let rows = await searchTerms(config, accountId(config, flags.account), range, { minCost: num(flags['min-cost'], 0) });
      if (flags['no-conversions']) rows = rows.filter((t) => t.conversions === 0);
      show(rows, ['term', 'campaign', 'campaignId', 'status', 'cost', 'clicks', 'conversions', 'value'], `Search terms ${range.from} … ${range.to} (by cost)`);
      break;
    }
    case 'products': {
      const rows = await products(config, accountId(config, flags.account), range);
      show(rows.map((p) => ({ ...p, cost: round(p.cost), value: round(p.value), conversions: round(p.conversions, 1) })),
        ['itemId', 'title', 'campaign', 'cost', 'clicks', 'conversions', 'value'], `Products ${range.from} … ${range.to} (by cost)`);
      break;
    }
    case 'negatives': {
      const rows = await campaignNegatives(config, accountId(config, flags.account), flags.campaign ?? null);
      show(rows, ['campaign', 'campaignId', 'text', 'matchType']);
      break;
    }
    case 'locations': {
      const id = accountId(config, flags.account);
      const rows = await adsSearch(config, id, `SELECT campaign.id, campaign.name, campaign_criterion.location.geo_target_constant, campaign_criterion.negative
        FROM campaign_criterion WHERE campaign_criterion.type = 'LOCATION' AND campaign.status = 'ENABLED'`);
      const constants = [...new Set(rows.map((r) => r.campaignCriterion.location.geoTargetConstant))];
      const names = new Map();
      for (let i = 0; i < constants.length; i += 200) {
        const chunk = constants.slice(i, i + 200);
        const found = await adsSearch(config, id, `SELECT geo_target_constant.resource_name, geo_target_constant.canonical_name, geo_target_constant.target_type
          FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${chunk.map((c) => `'${c}'`).join(',')})`);
        for (const f of found) names.set(f.geoTargetConstant.resourceName, `${f.geoTargetConstant.canonicalName} (${f.geoTargetConstant.targetType})`);
      }
      show(rows.map((r) => ({ campaign: r.campaign.name, campaignId: String(r.campaign.id), location: names.get(r.campaignCriterion.location.geoTargetConstant) ?? r.campaignCriterion.location.geoTargetConstant, excluded: Boolean(r.campaignCriterion.negative) })));
      break;
    }
    case 'goals': {
      show(await biddableGoals(config, accountId(config, flags.account)), null, 'Conversion goals ("biddable" = counted as a conversion and used by Smart Bidding):');
      break;
    }
    case 'changes': {
      const since = shiftDay(isoDay(), -Math.min(29, num(flags.days, 14)));
      const rows = await adsSearch(config, accountId(config, flags.account), `SELECT change_event.change_date_time, change_event.change_resource_type,
          change_event.resource_change_operation, change_event.client_type, change_event.user_email, change_event.changed_fields, campaign.name
        FROM change_event WHERE change_event.change_date_time >= '${since}' AND change_event.change_date_time <= '${shiftDay(isoDay(), 1)}' ORDER BY change_event.change_date_time DESC LIMIT ${Math.min(10000, limit * 5)}`);
      show(rows.map((r) => ({
        when: String(r.changeEvent.changeDateTime).slice(0, 16), what: r.changeEvent.changeResourceType, op: r.changeEvent.resourceChangeOperation,
        campaign: r.campaign?.name ?? '', by: r.changeEvent.userEmail ?? r.changeEvent.clientType, fields: r.changeEvent.changedFields ?? '',
      })));
      break;
    }
    case 'query': {
      const query = positional.slice(1).join(' ') || flags.q;
      if (!query) throw new UserError('Usage: node scripts/ads.mjs query "SELECT ... FROM ... WHERE ..."');
      if (!/^\s*select\b/i.test(query)) throw new UserError('Only SELECT queries are allowed here. Changes go through scripts/change.mjs.');
      const rows = (await adsSearch(config, accountId(config, flags.account), query)).map((r) => flatten(r));
      show(rows);
      break;
    }
    default:
      throw new UserError(`Unknown command "${command ?? ''}".`, 'Use: accounts | campaigns | search-terms | products | negatives | locations | goals | changes | query');
  }
});

