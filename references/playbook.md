# The method

Distilled from running a profit-first Google Ads robot and a senior-agency-style review on real shops
with 1–7 orders a day per account. Most of it is about not fooling yourself with small, partial data.

## 1. What we optimise

**Profit after ads = (goods revenue − product costs − extra costs per order) − ad spend**, on *all* shop
orders, per day or week. A change is good if this number rises (or spend falls with it flat). ROAS is a
tool, not the goal: cutting a campaign with ROAS 2 can lose money if those sales were profitable and
did not come back through other channels.

## 2. The shop is the truth; Google sees part of it

- With cookie consent banners, other devices and ad blockers, Google Ads usually sees **40–80 %** of the
  purchases. Compare `googleConversions` with shop orders (and with the shop's own attribution if
  WooCommerce 8.5+ records it). Most orders Google does not know about came through other channels
  (organic, direct, email), not "lost tracking" — don't credit them all to ads either.
- Google credits a purchase to the **clicked** product and colour, not the one bought. Judge colour /
  size variants of one model together, and keep "gateway" products (clicked, then the customer buys a
  sibling) — their own sales look poor.
- So: a campaign somewhat below break-even in Google's numbers may still pay; one far above may still
  be buying sales that would come anyway (brand). Prefer an experiment to a guess when it is close.

## 3. Break-even ROAS

`breakEven = 1 / margin`, where margin is profit before ads ÷ goods revenue. If Google's conversion
value is what the customer paid (tax and shipping included), multiply by avg order total ÷ avg goods
revenue — the audit picks the basis by comparing Google's average value per conversion with the shop's.
Below **0.8 × break-even** on enough spend = a loss worth acting on; between 0.8 and 1.0 = watch, check
attribution, maybe test.

## 4. Windows and minimum data

| Decision | Window | Minimum |
|---|---|---|
| Budget, target ROAS | 30 days, confirmed by the last 14 | ≥ 15–20 Google conversions |
| Campaign "loses money" | 30 days | spend ≥ 3 × average order profit |
| Product excluded from Shopping | 90 days | spend ≥ 3 × average order profit, ≥ 100 clicks, < 2 Google conversions, shop profit from it < ½ the spend |
| Search term negative | 30 days (check 12 months before blocking) | spend ≥ ~20 % of an order's profit, 0 conversions |
| Evaluating a change | 14 days before vs 14 after | — |

When the data does not reach the minimum, the answer is "not enough data yet — need ~N days", not a guess.

## 5. Where money leaks (check in this order — usually biggest first)

1. **Brand searches you would get for free.** If the shop ranks #1 organically for its own name
   (`gsc.mjs queries --brand`), paid brand clicks are partly bought twice. Only a test answers it:
   pause brand Search for 14–28 days, watch shop orders and free brand clicks (Search Console). In one
   real test, free brand clicks rose 3.5× and orders did not drop. Keep brand Shopping/ads if a
   competitor bids on the brand (check auction insights by hand).
2. **Smart Bidding chasing the wrong goal.** `ads.mjs goals`: add-to-cart, begin-checkout, page views
   or app installs marked biddable inflate conversions and ROAS — Google then optimises toward them.
3. **"Maximize conversion value" without a target ROAS** spends the whole budget whatever the return —
   set a first target (break-even, or current ROAS + 20 % if that is lower).
4. **Products that spend and never sell** (Shopping / PMax): rule in section 4.
5. **Search terms**: competitors' names, wrong product, research ("how to", "manual", "review", "vs",
   "free", "pdf", "used", "diy", "job"), wrong country or language. Classify each term; propose an
   **exact** negative in the campaign where it spent. Never a broad word.
6. **Targeting**: campaigns aimed at the wrong country (one real campaign targeted the wrong country for
   two weeks — `ads.mjs locations` first when spend and sales don't match), "presence or interest"
   instead of "presence", Search Partners on, night hours with far lower ROAS (`segments.hour`).
7. **Stock-outs**: when most top sellers are out of stock, Shopping spends on what is left at a much
   worse return — lower the budget until restock instead of letting rules exclude products one by one.

## 6. Where growth is

- Profitable (≥ 1.5 × break-even, ≥ 15 conversions in 30 days) and losing ≥ 10 % impressions to
  **budget** → +15 % budget (max +20 % per week).
- Very profitable (≥ 2 × break-even, ≥ 20 conversions), not budget-limited, losing ≥ 40 % to **rank**
  → target ROAS −10 %, never below 1.6 × break-even.
- Shop's best-profit products with no ad spend (feed missing, disapproved, excluded by mistake).
- Queries where the shop ranks 4–15 organically with buying intent and sales on the site → a small
  Search test (14 days, small budget, decision rule written beforehand).

## 7. Negatives — check what they would block

A negative is judged by what it blocks, not by the word. A phrase negative like `headset` once blocked
"<brand> headset" searches that had sold repeatedly. Before proposing a negative, search 12 months of
terms for converting ones that contain it (`ads.mjs search-terms --days 365`, filter in GAQL with
`search_term_view.search_term LIKE '%word%'`). Prefer exact match. Never brand words; protected
category words only with the user's explicit override.

## 8. Change discipline

- **One big change per account per 14 days** (budget, target ROAS, status, product exclusions).
  Smart Bidding re-learns for 1–2 weeks; two changes at once make both unreadable.
- **Few, large, well-evidenced moves.** On one real account a robot made 19 changes in one morning;
  every result became unreadable and the owner lost trust. Rebuilding trust took weeks.
- Move budgets and targets in steps of ≤ 20 % per week.
- Plan around seasons: no big change in the 2 weeks before a peak (e.g. Black Friday) unless it is the
  peak plan itself; propose peak budgets 1–3 weeks ahead so the user can decide in time. After the peak,
  go back — ads after the season often buy little.
- Small negatives can go in a batch; everything else one at a time.

## 9. Evaluate every big change

After 14 days: `change.mjs evaluate <id>`. Look first at **profit after ads per day for the whole shop**
(before vs after), then at the campaign. Name what else changed in those weeks (season, promotion,
stock, price, other changes in `ads.mjs changes`). If it did not pay, undo it and say so plainly.

## 10. What the user should hear

The 1–3 things that matter, with money per month. Plain words — "you pay ~€300/month for clicks on your
own name that you get free" beats "brand cannibalisation". One clear proposal per item, each with what
it costs if wrong and how it is undone. Uncertainty said out loud, with what would settle it.

## 11. New markets — where does it pay?

The question is not "where are the most searches" but "where does a click cost less than it earns".

- **Break-even CPC = conversion rate × value of a sale.** Value of a sale = profit per sale of that product
  group (real orders) − extra cost per order − payment fee − extra shipping to that country.
- **Reserve** = how far the market's CPC is below break-even. ≥ 30 % with enough searches → worth a
  14-day test; 0–30 % → marginal (only with a strong reason, e.g. brand demand); below 0 → does not pay.
  A market is judged on the product groups that pay there — the others are simply left out of a test.
- **The conversion rate of a new market is the big unknown.** Plan with the account's own non-brand rate
  (brand clicks convert far better and would flatter every market), or 1 %. A site not in the market's
  language converts much worse (the tool halves it); missing local currency, payment methods, delivery
  times and reviews also lower it.
- **Signals that the demand is real**, strongest first: orders already arriving from the country without
  ads, brand searches there, Search Console impressions from the country, and only then search volume.
- **Shipping**: a market far away often loses its whole margin on shipping and returns — put the real extra
  cost per order in `markets.extraCostByCountry`.
- **Test, don't roll out**: one market at a time, small budget (about 10–20 × the break-even CPC per day),
  only the paying groups, 14 days, a decision rule written beforehand. Judge on shop orders and profit
  after ads from that country, not on Google's ROAS alone.
