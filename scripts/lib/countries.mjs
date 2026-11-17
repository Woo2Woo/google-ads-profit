// Countries the market research knows. Google's geo target id for a country is 2000 + its ISO 3166
// numeric code (Germany 276 → 2276); DataForSEO uses the same ids as location codes. `lang` is the
// main search language (override it per market in the seeds file, e.g. Belgium fr/nl, Switzerland de/fr).
export const COUNTRIES = {
  AT: { name: 'Austria', a3: 'aut', geo: 2040, lang: 'de', continent: 'EU' },
  AU: { name: 'Australia', a3: 'aus', geo: 2036, lang: 'en', continent: 'OC' },
  BE: { name: 'Belgium', a3: 'bel', geo: 2056, lang: 'nl', continent: 'EU' },
  BG: { name: 'Bulgaria', a3: 'bgr', geo: 2100, lang: 'bg', continent: 'EU' },
  CA: { name: 'Canada', a3: 'can', geo: 2124, lang: 'en', continent: 'NA' },
  CH: { name: 'Switzerland', a3: 'che', geo: 2756, lang: 'de', continent: 'EU' },
  CZ: { name: 'Czechia', a3: 'cze', geo: 2203, lang: 'cs', continent: 'EU' },
  DE: { name: 'Germany', a3: 'deu', geo: 2276, lang: 'de', continent: 'EU' },
  DK: { name: 'Denmark', a3: 'dnk', geo: 2208, lang: 'da', continent: 'EU' },
  EE: { name: 'Estonia', a3: 'est', geo: 2233, lang: 'et', continent: 'EU' },
  ES: { name: 'Spain', a3: 'esp', geo: 2724, lang: 'es', continent: 'EU' },
  FI: { name: 'Finland', a3: 'fin', geo: 2246, lang: 'fi', continent: 'EU' },
  FR: { name: 'France', a3: 'fra', geo: 2250, lang: 'fr', continent: 'EU' },
  GB: { name: 'United Kingdom', a3: 'gbr', geo: 2826, lang: 'en', continent: 'EU' },
  GR: { name: 'Greece', a3: 'grc', geo: 2300, lang: 'el', continent: 'EU' },
  HR: { name: 'Croatia', a3: 'hrv', geo: 2191, lang: 'hr', continent: 'EU' },
  HU: { name: 'Hungary', a3: 'hun', geo: 2348, lang: 'hu', continent: 'EU' },
  IE: { name: 'Ireland', a3: 'irl', geo: 2372, lang: 'en', continent: 'EU' },
  IT: { name: 'Italy', a3: 'ita', geo: 2380, lang: 'it', continent: 'EU' },
  LT: { name: 'Lithuania', a3: 'ltu', geo: 2440, lang: 'lt', continent: 'EU' },
  LU: { name: 'Luxembourg', a3: 'lux', geo: 2442, lang: 'fr', continent: 'EU' },
  LV: { name: 'Latvia', a3: 'lva', geo: 2428, lang: 'lv', continent: 'EU' },
  NL: { name: 'Netherlands', a3: 'nld', geo: 2528, lang: 'nl', continent: 'EU' },
  NO: { name: 'Norway', a3: 'nor', geo: 2578, lang: 'no', continent: 'EU' },
  NZ: { name: 'New Zealand', a3: 'nzl', geo: 2554, lang: 'en', continent: 'OC' },
  PL: { name: 'Poland', a3: 'pol', geo: 2616, lang: 'pl', continent: 'EU' },
  PT: { name: 'Portugal', a3: 'prt', geo: 2620, lang: 'pt', continent: 'EU' },
  RO: { name: 'Romania', a3: 'rou', geo: 2642, lang: 'ro', continent: 'EU' },
  SE: { name: 'Sweden', a3: 'swe', geo: 2752, lang: 'sv', continent: 'EU' },
  SI: { name: 'Slovenia', a3: 'svn', geo: 2705, lang: 'sl', continent: 'EU' },
  SK: { name: 'Slovakia', a3: 'svk', geo: 2703, lang: 'sk', continent: 'EU' },
  US: { name: 'United States', a3: 'usa', geo: 2840, lang: 'en', continent: 'NA' },
};

export const byGeo = new Map(Object.entries(COUNTRIES).map(([code, c]) => [c.geo, code]));
export const byAlpha3 = new Map(Object.entries(COUNTRIES).map(([code, c]) => [c.a3, code]));

/** Woo shipping zone locations → country codes ("country" DE, "continent" EU, "state" US:CA). */
export function countriesOfLocations(locations) {
  const out = new Set();
  for (const loc of locations) {
    const code = String(loc.code ?? '').toUpperCase();
    if (loc.type === 'country' && code) out.add(code === 'UK' ? 'GB' : code);
    else if (loc.type === 'state' && code.includes(':')) out.add(code.split(':')[0]);
    else if (loc.type === 'continent') for (const [cc, c] of Object.entries(COUNTRIES)) if (c.continent === code) out.add(cc);
  }
  return out;
}
