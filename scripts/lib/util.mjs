// Small helpers shared by every script. No dependencies: only Node.js built-ins.

/** `--key value`, `--key=value` and bare `--flag` (true). Everything else is positional. */
export function parseArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq !== -1) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; } else flags[key] = true;
  }
  return { positional, flags };
}

export const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const round = (value, digits = 2) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

export const pct = (value) => (value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 1000) / 10);

/** Local calendar day, YYYY-MM-DD. */
export function isoDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function shiftDay(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  return isoDay(new Date(y, m - 1, d + delta));
}

/** The last `days` complete days, ending `endOffset` days ago (1 = yesterday). */
export function lastDays(days, endOffset = 1, today = isoDay()) {
  const to = shiftDay(today, -endOffset);
  return { from: shiftDay(to, -(days - 1)), to, days };
}

export function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

export const micros = (value) => num(value) / 1_000_000;
export const toMicros = (amount) => String(Math.round(Number(amount) * 100) * 10_000);

/** Google Ads ids are digits only: "123-456-7890" → "1234567890". */
export const cleanId = (value) => String(value ?? '').replace(/[^0-9]/g, '');

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Plain-text table that reads well in a terminal and in Claude's context. */
export function table(rows, columns) {
  if (!rows.length) return '(none)';
  const cols = columns ?? Object.keys(rows[0]);
  const cell = (v) => (v === null || v === undefined ? '–' : typeof v === 'number' ? String(round(v)) : String(v));
  const widths = cols.map((c) => Math.min(48, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))));
  const fit = (s, w) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));
  const line = (values) => values.map((v, i) => fit(v, widths[i])).join('  ').trimEnd();
  return [line(cols), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join('\n');
}

export class UserError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
  }
}

/** Runs a script's main(); prints a readable error (never a stack for expected problems). */
export async function run(main) {
  try {
    await main();
  } catch (error) {
    if (error && ['UserError', 'GoogleError', 'WooError', 'SourceError'].includes(error.name)) {
      process.stderr.write(`ERROR: ${error.message}\n`);
      if (error.hint) process.stderr.write(`NEXT STEP: ${error.hint}\n`);
    } else {
      process.stderr.write(`ERROR: ${error?.stack ?? error}\n`);
    }
    process.exitCode = 1;
  }
}

/** Removes every secret value from a text before it is printed. */
export function redact(text, secrets) {
  let result = String(text);
  for (const secret of secrets) {
    if (secret && String(secret).length >= 6) result = result.split(String(secret)).join('<hidden>');
  }
  return result;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive RE2 pattern for the brand words (Search Console filter), or null. */
export function brandRegex(terms) {
  const parts = (terms ?? []).map((t) => escapeRe(String(t).trim())).filter(Boolean);
  return parts.length ? `(?i)(${parts.join('|')})` : null;
}

/** True when a text contains one of the words (case-insensitive, plain substring). */
export function containsAny(text, words) {
  const t = String(text ?? '').toLowerCase();
  return (words ?? []).some((w) => String(w).trim() && t.includes(String(w).trim().toLowerCase()));
}
