import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface TokenSource { token(scopes: string[]): Promise<string> }
interface Cached { tok: string; exp: number }

/** The owner's own Google account (Gmail, Drive, reading Chat), via a long-lived refresh token. */
export class UserOAuth implements TokenSource {
  clientId: string; clientSecret: string; refreshToken: string; fetchImpl: typeof fetch; cache?: Cached;
  constructor(clientId: string, clientSecret: string, refreshToken: string, fetchImpl: typeof fetch = fetch) {
    this.clientId = clientId; this.clientSecret = clientSecret; this.refreshToken = refreshToken; this.fetchImpl = fetchImpl;
  }
  async token(): Promise<string> {
    if (this.cache && this.cache.exp > Date.now() + 60000) return this.cache.tok;
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, refresh_token: this.refreshToken, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json() as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !j.access_token) throw new Error(`google oauth: ${j.error_description ?? res.status}`);
    this.cache = { tok: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }
}

/** The Chat app's identity (posting as the bot, pulling its Pub/Sub events). */
export class ServiceAccount implements TokenSource {
  email: string; key: string; fetchImpl: typeof fetch; cache = new Map<string, Cached>();
  constructor(json: { client_email: string; private_key: string }, fetchImpl: typeof fetch = fetch) { this.email = json.client_email; this.key = json.private_key; this.fetchImpl = fetchImpl; }
  static fromFile(path: string, fetchImpl?: typeof fetch): ServiceAccount { return new ServiceAccount(JSON.parse(readFileSync(path, 'utf8')), fetchImpl); }
  async token(scopes: string[]): Promise<string> {
    const k = scopes.join(' '); const c = this.cache.get(k);
    if (c && c.exp > Date.now() + 60000) return c.tok;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: this.email, scope: k, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(this.key).toString('base64url');
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }), signal: AbortSignal.timeout(15000),
    });
    const j = await res.json() as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !j.access_token) throw new Error(`google service account: ${j.error_description ?? res.status}`);
    this.cache.set(k, { tok: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
    return j.access_token;
  }
}

export async function gjson<T>(src: TokenSource, scopes: string[], url: string, init: { method?: string; body?: unknown } = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(url, {
    method: init.method ?? 'GET', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${await src.token(scopes)}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`google ${res.status} ${url.split('?')[0]}: ${text.slice(0, 200)}`) as Error & { status: number }; e.status = res.status; throw e; }
  return (text ? JSON.parse(text) : {}) as T;
}
