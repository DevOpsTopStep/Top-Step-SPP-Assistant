// REST-only mode: no SPP_API_NAMESPACE / SPP_API_KEY configured.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-rest-'));
const SID = 'rest-only-session-0123456789abc';
const tok = path.join(tmp, 's.json');
fs.writeFileSync(tok, JSON.stringify({ [SID]: { access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 3600e3 } }));
Object.assign(process.env, {
  ANTHROPIC_API_KEY: 'k', SPP_CLIENT_ID: 'c', SPP_CLIENT_SECRET: 's', SPP_API_NAMESPACE: '', SPP_API_KEY: '',
  SPP_COMPANY_ID: 'topstep', TOKEN_STORE_FILE: tok, ALLOWED_ORIGINS: 'chrome-extension://abc',
});

const realFetch = globalThis.fetch;
const claude = []; let script = []; let xmlCalls = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.endsWith('/api.pl')) { xmlCalls++; throw new Error('XML must not be called'); }
  if (u.includes('/rest/v1/projects')) {
    assert.equal(opts.headers.Authorization, 'Bearer AT');
    return Response.json({ data: [{ id: 2542, name: 'Topstep - Onboarding Automation' }], meta: { totalCount: 1 } });
  }
  if (u.endsWith('/v1/messages')) { claude.push(JSON.parse(opts.body)); return Response.json(script.shift()); }
  throw new Error('unexpected ' + u);
};

const { createServer } = await import('../src/index.js');
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const H = { 'X-Session-Id': SID, 'Content-Type': 'application/json', Origin: 'chrome-extension://abc' };
test.after(() => server.close());

test('health and status report REST-only without flagging missing config', async () => {
  const h = await (await realFetch(`${base}/health`)).json();
  assert.deepEqual(h.missingConfig, []);
  assert.equal(h.features.xml, false);
  const st = await (await realFetch(`${base}/api/status`, { headers: H })).json();
  assert.equal(st.connected, true);
  assert.equal(st.features.scriptRequests, false);
  assert.equal(xmlCalls, 0, 'status must not call whoami over XML');
});

test('only REST tools are offered and the prompt says limited mode', async () => {
  script = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r1', name: 'spp_rest_get', input: { resource: 'projects', q: "name CONTAINS 'Onboarding'" } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Found it.' }] },
  ];
  const out = await (await realFetch(`${base}/api/chat`, { method: 'POST', headers: H, body: JSON.stringify({ message: 'find the onboarding project' }) })).json();
  assert.equal(out.reply, 'Found it.');
  const names = claude[0].tools.map(t => t.name).sort();
  assert.deepEqual(names, ['spp_rest_get', 'validate_user_script']);
  assert.match(claude[0].system[0].text, /LIMITED MODE/);
  assert.match(claude[1].messages.at(-1).content[0].content, /Onboarding Automation/);
});

test('an XML tool call is refused with a clear message, never reaches SPP', async () => {
  script = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x1', name: 'list_script_requests', input: {} }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'SRs are not available yet.' }] },
  ];
  await realFetch(`${base}/api/chat`, { method: 'POST', headers: H, body: JSON.stringify({ message: 'list SRs' }) });
  const tr = claude.at(-1).messages.at(-1).content[0];
  assert.equal(tr.is_error, true);
  assert.match(tr.content, /XML API/);
  assert.equal(xmlCalls, 0);
});
