# Useful Google Ads queries (GAQL)

Run with `node scripts/ads.mjs query "<query>"`. Rules: select only needed fields, aggregate in the
query, always bound dates (`segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'` or `DURING LAST_30_DAYS`),
money is in micros (÷ 1 000 000). Reference: https://developers.google.com/google-ads/api/fields

**Spend by hour of day** (night hours with poor return → ad schedule)
```sql
SELECT segments.hour, metrics.cost_micros, metrics.conversions, metrics.conversions_value
FROM campaign WHERE segments.date DURING LAST_30_DAYS AND campaign.status = 'ENABLED'
```

**By device**
```sql
SELECT segments.device, metrics.cost_micros, metrics.conversions, metrics.conversions_value
FROM campaign WHERE segments.date DURING LAST_30_DAYS
```

**By country of the user** (where the money actually goes)
```sql
SELECT campaign.name, geographic_view.country_criterion_id, geographic_view.location_type,
  metrics.cost_micros, metrics.conversions, metrics.conversions_value
FROM geographic_view WHERE segments.date DURING LAST_30_DAYS
```
Resolve ids: `SELECT geo_target_constant.canonical_name FROM geo_target_constant WHERE geo_target_constant.id = 2276`

**Search Partners vs Google Search**
```sql
SELECT campaign.name, segments.ad_network_type, metrics.cost_micros, metrics.conversions, metrics.conversions_value
FROM campaign WHERE segments.date DURING LAST_30_DAYS
```

**Keywords with quality score**
```sql
SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
  ad_group_criterion.quality_info.quality_score, metrics.cost_micros, metrics.conversions, metrics.conversions_value
FROM keyword_view WHERE segments.date DURING LAST_30_DAYS AND metrics.cost_micros > 0
```

**Terms containing a word, 12 months, that converted** (before adding a negative)
```sql
SELECT search_term_view.search_term, campaign.name, metrics.cost_micros, metrics.conversions, metrics.conversions_value
FROM search_term_view
WHERE segments.date BETWEEN '2025-11-01' AND '2026-10-31'
  AND search_term_view.search_term LIKE '%headset%' AND metrics.conversions > 0
```

**Performance Max search categories** (needs one campaign id)
```sql
SELECT campaign_search_term_insight.category_label, metrics.clicks, metrics.conversions, metrics.conversions_value
FROM campaign_search_term_insight
WHERE segments.date DURING LAST_30_DAYS AND campaign_search_term_insight.campaign_id = '123456789'
```

**Impression share lost** (budget vs rank) per campaign
```sql
SELECT campaign.name, metrics.search_impression_share, metrics.search_budget_lost_impression_share,
  metrics.search_rank_lost_impression_share
FROM campaign WHERE segments.date DURING LAST_30_DAYS AND campaign.advertising_channel_type IN ('SEARCH','SHOPPING')
```

**Conversion actions and what they count**
```sql
SELECT conversion_action.name, conversion_action.category, conversion_action.primary_for_goal,
  conversion_action.counting_type, conversion_action.status
FROM conversion_action WHERE conversion_action.status = 'ENABLED'
```

**Shopping products with status / issues**
```sql
SELECT shopping_product.item_id, shopping_product.title, shopping_product.status, shopping_product.issues
FROM shopping_product WHERE shopping_product.status != 'ELIGIBLE'
```

**Daily spend vs Google conversions** (tracking break = spend steady, conversions drop to 0 while shop orders don't)
```sql
SELECT segments.date, metrics.cost_micros, metrics.conversions FROM customer WHERE segments.date DURING LAST_14_DAYS
```
