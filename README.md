# google-ads-profit — a Claude Code skill

Profit-first Google Ads for WooCommerce shops. Ask Claude *"audit my Google Ads"* and it:

- reads your **Google Ads**, **WooCommerce** orders and product costs, **Search Console** and **GA4**;
- shows **profit after ads** (not just ROAS), your break-even ROAS, and how much of your sales Google
  actually sees;
- finds the leaks: campaigns below break-even, search terms that spend and never sell, Shopping
  products that cost more than they earn, brand clicks you would get for free, wrong conversion goals,
  campaigns aimed at the wrong place;
- tells you **which countries are worth advertising in**: search demand and click prices for your product
  groups in each market's language (Google Keyword Planner, or DataForSEO), against what a sale really
  earns you;
- proposes changes and makes them **only after you say yes** — each one checked by Google first,
  recorded, undoable with one command, and evaluated after 14 days.

**Runs entirely on your computer.** Your keys stay in `~/.google-ads-profit/`; the scripts talk only to
your own Google accounts and your own shop — no server of ours, no sign-up. The only optional third party is
DataForSEO, if you choose it for market research (plus the ECB's public exchange rates to convert its USD prices).

## Install

You need [Claude Code](https://claude.com/claude-code) (the terminal or the desktop app's Code tab) and
Node.js 18+.

```bash
git clone https://github.com/Woo2Woo/google-ads-profit ~/.claude/skills/google-ads-profit
```

Or ask Claude: *"install the skill from https://github.com/Woo2Woo/google-ads-profit"*.

## First run

Tell Claude: **"Connect my Google Ads and WooCommerce"**. It checks what is missing and guides you one
step at a time (about 20–40 minutes once): a free Google Cloud app of your own, a Google sign-in, a
Google Ads developer token, a read-only WooCommerce key, and your product costs. Full guide:
[references/setup.md](references/setup.md).

Then: **"Audit my Google Ads"**, **"Which search terms waste money?"**, **"Should I pay for brand
searches?"**, **"In which countries would ads pay?"**, **"How did last week go?"**, **"Undo change 3"**.

## Safety

- Reads by default. A change happens only through `scripts/change.mjs apply` after your explicit yes.
- Limits built in: one big change (budget, target ROAS, status, product exclusion) per account per 14
  days, budgets and targets ±20 % per week at most, target ROAS never below break-even, no negative
  keyword containing your brand.
- Nothing is deleted: campaigns are paused, products excluded; every change has a stored undo.
- The WooCommerce key needs only **Read** permission.
- Paid search data (DataForSEO) is optional; every paid run shows its cost first and waits for your yes,
  with a daily cap and a 30-day cache.

## What's inside

| | |
|---|---|
| `SKILL.md` | what Claude does and in which order |
| `references/setup.md` | step-by-step connection guide |
| `references/playbook.md` | the method: profit, break-even, windows, leaks, discipline |
| `references/gaql.md` | useful Google Ads queries |
| `scripts/` | Node.js scripts, no dependencies (`setup`, `google-login`, `ads`, `ga4`, `gsc`, `woo`, `audit`, `change`, `markets`) |

Tests: `npm test`.

## Lietuviškai

Claude Code įgūdis, skirtas pelningai Google Ads reklamai WooCommerce parduotuvėms. Viskas veikia jūsų
kompiuteryje: raktai saugomi `~/.google-ads-profit/` aplanke, o skriptai kalbasi tik su jūsų Google
paskyromis ir jūsų parduotuve. Įdiekite komanda aukščiau ir parašykite Claude: *„Prijunk mano Google Ads
ir WooCommerce“*. Claude pats paves per kiekvieną žingsnį ir atsakys jūsų kalba.

## License

MIT
