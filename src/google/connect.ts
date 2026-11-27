// Connecting the owner's Google account from the web page (the same steps as `npm run google-auth`, without a terminal):
// 1. the page opens Google's consent screen; 2. the browser ends up on a localhost address that does not load — the code is in it;
// 3. the owner pastes that address back and the server trades the code for a long-lived refresh token.
export const REDIRECT = 'http://localhost:1';
export const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly', 'https://www.googleapis.com/auth/chat.spaces.readonly'];

export function consentUrl(clientId: string): string {
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: SCOPES.join(' ') });
}

/** The authorization code from whatever was pasted: the whole address the browser ended on, its query part, or the bare code. */
export function codeFrom(pasted: string): string {
  const t = String(pasted ?? '').trim(); if (!t) throw new Error('Paste the address the browser ended up on after you approved.');
  let params: URLSearchParams | null = null;
  try { params = new URL(t).searchParams; } catch { if (t.includes('code=') || t.includes('error=')) params = new URLSearchParams(t.replace(/^[^?]*\?/, '')); }
  if (params) {
    const err = params.get('error'); if (err) throw new Error(err === 'access_denied' ? 'Access was denied on the Google page. Start again and approve.' : `Google reported: ${err}`);
    const c = params.get('code'); if (c) return c;
    throw new Error('That address has no ?code= in it. Copy the whole address from the browser\'s address bar after approving.');
  }
  if (/^4\/[\w-]{10,}$/.test(t)) return t;                       // a bare authorization code
  throw new Error('That does not look like the address (or code) Google gave you.');
}

export async function exchangeCode(clientId: string, clientSecret: string, pasted: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!clientId) throw new Error('Save the OAuth client ID and secret first (Settings → Google).');
  const code = codeFrom(pasted);
  const res = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(20000),
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }) });
  const j = await res.json().catch(() => ({})) as { refresh_token?: string; error?: string; error_description?: string };
  if (!j.refresh_token) {
    if (j.error === 'invalid_grant') throw new Error('That code was already used or has expired. Start again from step 1 and paste the new address.');
    if (j.error === 'invalid_client') throw new Error('Google does not accept the client ID / secret. Check them in Settings → Google (use an OAuth "Desktop app" client).');
    throw new Error(j.error_description || j.error || (res.ok ? 'Google did not return a refresh token. Start again (it must show the consent screen).' : `Google answered ${res.status}.`));
  }
  return j.refresh_token;
}
