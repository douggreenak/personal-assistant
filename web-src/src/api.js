let token = localStorage.getItem('assistant_token') || '';
export const getToken = () => token;
export const hasToken = () => !!token;
export const setToken = (t) => { token = t; localStorage.setItem('assistant_token', t); };
export const clearToken = () => { token = ''; localStorage.removeItem('assistant_token'); };

export async function api(path, { method = 'GET', body, raw } = {}) {
  const r = await fetch(path, { method, headers: { authorization: 'Bearer ' + token, ...(raw ? {} : { 'content-type': 'application/json' }) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { window.dispatchEvent(new Event('auth-lost')); throw new Error('Signed out'); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
export async function login(password) {
  const r = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404) { setToken(password); await api('/status'); return; }   // password login not enabled: accept the API token itself
  if (!r.ok) throw new Error(j.error || 'Sign-in failed');
  setToken(j.token);
}
