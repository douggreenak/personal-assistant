// One-time: get a refresh token for your Google account (Gmail, Drive, Chat read).
// Usage: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run google-auth
// Works on a headless server: open the printed URL in any browser, approve, then paste the URL the browser ends up on
// (the page will fail to load — that's expected; the code is in the address bar).
import { createInterface } from 'node:readline/promises';

const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
if (!id || !secret) { console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (an OAuth "Desktop app" client).'); process.exit(1); }
const redirect = 'http://localhost:1';
const scopes = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly', 'https://www.googleapis.com/auth/chat.spaces.readonly'];
const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: scopes.join(' ') });
console.log('\n1. Open this URL and approve:\n\n' + url + '\n');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pasted = await rl.question('2. Paste the full URL you were redirected to: ');
rl.close();
const code = new URL(pasted.trim()).searchParams.get('code');
if (!code) { console.error('No ?code= found in that URL.'); process.exit(1); }
const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }) });
const j = await res.json() as { refresh_token?: string; error_description?: string };
if (!j.refresh_token) { console.error('Failed:', j.error_description ?? JSON.stringify(j)); process.exit(1); }
console.log('\nAdd to your .env (keep it private):\nGOOGLE_REFRESH_TOKEN=' + j.refresh_token);
