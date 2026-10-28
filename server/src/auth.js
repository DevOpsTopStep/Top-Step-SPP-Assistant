// Per-user SuiteProjects Pro OAuth 2.0 (authorization code flow).
// Each browser install has a random session id; tokens are stored server-side
// against it so the client secret and refresh tokens never reach the browser.
// Every API call runs with the signed-in user's own SPP role and filter set.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const sessions = new Map();   // sid -> { access_token, refresh_token, expires_at, user }
const pendingStates = new Map(); // state -> { sid, created }
const refreshing = new Map(); // sid -> Promise (refresh tokens are single-use)

function load() {
  if (config.tokenStoreFile === 'memory') return;
  try {
    const raw = JSON.parse(fs.readFileSync(config.tokenStoreFile, 'utf8'));
    for (const [k, v] of Object.entries(raw)) sessions.set(k, v);
  } catch { /* first run */ }
}
function save() {
  if (config.tokenStoreFile === 'memory') return;
  fs.mkdirSync(path.dirname(config.tokenStoreFile), { recursive: true });
  fs.writeFileSync(config.tokenStoreFile, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
}
load();

export function isValidSid(sid) {
  return typeof sid === 'string' && /^[A-Za-z0-9-]{20,80}$/.test(sid);
}

export function authStartUrl(sid) {
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, { sid, created: Date.now() });
  for (const [k, v] of pendingStates) if (Date.now() - v.created > 15 * 60e3) pendingStates.delete(k);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.spp.clientId,
    redirect_uri: `${config.publicUrl}/auth/callback`,
    scope: config.spp.scope,
    state,
  });
  // SPP expects '+' between scopes; URLSearchParams encodes '+' as %2B.
  return `${config.spp.oauthBase}/authorize?${q.toString().replace(/scope=([^&]*)/, (m, s) => 'scope=' + decodeURIComponent(s))}`;
}

async function tokenRequest(params) {
  const basic = Buffer.from(`${config.spp.clientId}:${config.spp.clientSecret}`).toString('base64');
  const res = await fetch(`${config.spp.oauthBase}/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, redirect_uri: `${config.publicUrl}/auth/callback` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`SPP token request failed: ${body.error || res.status} ${body.error_description || ''}`.trim());
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (Number(body.expires_in) || 900) * 1000,
  };
}

export async function handleCallback({ code, state, error, error_description }) {
  const pending = pendingStates.get(state);
  pendingStates.delete(state);
  if (!pending) throw new Error('Sign-in link expired or was already used. Start again from the assistant panel.');
  if (error) throw new Error(`SPP did not authorize the assistant: ${error_description || error}`);
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code });
  sessions.set(pending.sid, { ...tokens, connected_at: Date.now() });
  save();
  return pending.sid;
}

export function sessionStatus(sid) {
  const s = sessions.get(sid);
  return s ? { connected: true, user: s.user || null } : { connected: false };
}

export function setSessionUser(sid, user) {
  const s = sessions.get(sid);
  if (s) { s.user = user; save(); }
}

export function signOut(sid) { sessions.delete(sid); save(); }

// Returns a valid access token, refreshing if within 60s of expiry.
export async function getAccessToken(sid, { force = false } = {}) {
  const s = sessions.get(sid);
  if (!s) throw Object.assign(new Error('Not connected to SuiteProjects Pro. Click "Connect SPP" in the panel.'), { code: 'NOT_CONNECTED' });
  if (!force && s.expires_at - Date.now() > 60e3) return s.access_token;
  if (!refreshing.has(sid)) {
    refreshing.set(sid, (async () => {
      try {
        const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refresh_token });
        sessions.set(sid, { ...s, ...t });
        save();
        return t.access_token;
      } catch (e) {
        sessions.delete(sid); save();
        throw Object.assign(new Error('Your SPP sign-in expired (refresh tokens last 24h). Click "Connect SPP" again.'), { code: 'NOT_CONNECTED', cause: e });
      } finally { refreshing.delete(sid); }
    })());
  }
  return refreshing.get(sid);
}
