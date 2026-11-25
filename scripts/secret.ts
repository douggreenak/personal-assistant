// Stores a connector credential outside the model's reach: npm run secret -- set NAME   (value read from stdin)
//   read -s v; echo "$v" | npm run secret -- set ACME_API_KEY
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
const [cmd, name] = process.argv.slice(2);
const dir = process.env.ASSISTANT_DATA ?? './data'; const file = `${dir}/secrets.json`;
if (cmd !== 'set' || !/^[A-Z][A-Z0-9_]{2,60}$/.test(name ?? '')) { console.error('usage: npm run secret -- set UPPER_SNAKE_NAME  (value on stdin)'); process.exit(1); }
let value = ''; for await (const c of process.stdin) value += c; value = value.trim();
if (!value) { console.error('empty value'); process.exit(1); }
mkdirSync(dir, { recursive: true });
const cur = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, string> : {};
cur[name] = value; writeFileSync(file, JSON.stringify(cur, null, 2)); chmodSync(file, 0o600);
console.log(`stored ${name}`);
