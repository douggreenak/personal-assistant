/**
 * Finds credentials inside pasted API docs so they can be stored as secrets and replaced with <API_KEY_n> BEFORE the text
 * goes anywhere near the model. Heuristic by design: labelled values ("api_key: …", "Authorization: Bearer …", `?key=…`),
 * well-known key prefixes, and — as a last resort — a lone long token on its own line. Obvious placeholders are ignored.
 */
const PLACEHOLDER = /^(your|my|example|sample|test_?key|xxx|\.\.\.|<|\{|\[|\$|\*|api_?key$|token$|secret$|changeme|placeholder)/i;
const LABEL = '(?:api[_ -]?key|apikey|x-api-key|access[_ -]?token|auth[_ -]?token|bearer[_ -]?token|client[_ -]?secret|secret[_ -]?key|private[_ -]?key|token|secret|password|passwd|key)';
const VALUE = '[A-Za-z0-9][A-Za-z0-9._~+/=:-]{9,}';
const PATTERNS: RegExp[] = [
  new RegExp(`\\bBearer\\s+(${VALUE})`, 'gi'),
  new RegExp(`\\bBasic\\s+([A-Za-z0-9+/=]{12,})`, 'g'),
  new RegExp(`[?&]${LABEL}=(${VALUE})`, 'gi'),
  new RegExp(`${LABEL}["']?\\s*[:=]\\s*["']?(${VALUE})`, 'gi'),
  /\b((?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|shp(?:at|ss)_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g,
];
const looksReal = (v: string): boolean => !PLACEHOLDER.test(v) && !/^(.)\1+$/.test(v) && ((/\d/.test(v) && /[A-Za-z]/.test(v)) || v.length >= 32);

export interface Scan { clean: string; keys: string[] }
export function extractKeys(text: string): Scan {
  const found: string[] = [];
  let clean = text;
  const take = (v: string): void => { if (looksReal(v) && !found.includes(v)) found.push(v); };
  for (const re of PATTERNS) for (const m of text.matchAll(re)) take(m[1]);
  if (!found.length) {   // a lone token on its own line, e.g. the last line of the paste
    for (const line of text.split('\n').map((l) => l.trim())) if (/^[A-Za-z0-9._~+/=-]{24,}$/.test(line) && /\d/.test(line) && /[A-Za-z]/.test(line) && !/^https?:/.test(line)) take(line);
  }
  const ordered = [...found].sort((a, b) => text.indexOf(a) - text.indexOf(b));   // <API_KEY_1> is the one that appears first
  for (const k of [...found].sort((a, b) => b.length - a.length)) clean = clean.split(k).join(`<API_KEY_${ordered.indexOf(k) + 1}>`);   // longest first, so no tails are left behind
  return { clean, keys: ordered };
}
export const hint = (k: string): string => `…${k.slice(-4)}`;
