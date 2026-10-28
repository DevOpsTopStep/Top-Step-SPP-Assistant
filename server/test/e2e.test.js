// End-to-end: real HTTP server, mocked outbound SPP + Claude APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-assist-'));
Object.assign(process.env, {
  ANTHROPIC_API_KEY: 'test-key', SPP_CLIENT_ID: 'cid', SPP_CLIENT_SECRET: 'secret',
  SPP_API_NAMESPACE: 'ns', SPP_API_KEY: 'apikey', SPP_COMPANY_ID: 'topstep',
  PUBLIC_URL: 'http://localhost:0', TOKEN_STORE_FILE: path.join(tmp, 's.json'), ALLOWED_ORIGINS: 'chrome-extension://abc',
});

const realFetch = globalThis.fetch;
const calls = { xml: [], claude: [], token: [] };
let claudeScript = []; // queue of responses

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.endsWith('/login/oauth2/v1/token')) {
    calls.token.push(String(opts.body));
    return Response.json({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 900, token_type: 'bearer' });
  }
  if (u.endsWith('/api.pl')) {
    const body = String(opts.body); calls.xml.push(body);
    assert.match(body, /<access_token>AT1<\/access_token>/);
    assert.match(body, /namespace="ns" key="apikey"/);
    let inner = '';
    if (body.includes('<Whoami')) inner = '<Whoami status="0"><User><id>7</id><name>Jackson, A</name><addr_email>a@x.com</addr_email></User></Whoami>';
    else if (body.includes('<Read type="Project"')) inner = '<Read status="0"><Project><id>2553</id><name>IMP - Rev Rec</name></Project></Read>';
    else if (body.includes('<Read type="Issue"')) inner = '<Read status="0"><Issue><id>2631</id><prefix>SR-</prefix><number>2739</number><description>IMP - Update Rev Rec</description><issue_categoryid>13</issue_categoryid><issue_stageid>9</issue_stageid><issue_sourceid>1</issue_sourceid><script_name__c>create_tasks_from_budgets.js</script_name__c><projectid>2553</projectid></Issue></Read>';
    else if (body.includes('<Add type="Issue"')) inner = '<Add status="0"><Issue><id>9001</id></Issue></Add>';
    return new Response(`<?xml version="1.0"?><response><Auth status="0"/>${inner}</response>`);
  }
  if (u.endsWith('/v1/messages')) {
    calls.claude.push(JSON.parse(opts.body));
    return Response.json(claudeScript.shift());
  }
  throw new Error('Unexpected fetch ' + u);
};

const { createServer } = await import('../src/index.js');
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const SID = 'test-session-0123456789abcdef';
const H = { 'X-Session-Id': SID, 'Content-Type': 'application/json', Origin: 'chrome-extension://abc' };

test.after(() => server.close());

test('rejects unknown extension origins', async () => {
  const r = await realFetch(`${base}/api/status`, { headers: { ...H, Origin: 'chrome-extension://evil' } });
  assert.equal(r.status, 403);
});

test('oauth: start redirects to SPP, callback stores tokens', async () => {
  const r = await realFetch(`${base}/auth/start?sid=${SID}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.host, 'topstep.app.netsuitesuiteprojectspro.com');
  assert.equal(loc.pathname, '/login/oauth2/v1/authorize');
  assert.match(r.headers.get('location'), /scope=rest\+xml/);
  const state = loc.searchParams.get('state');
  const cb = await realFetch(`${base}/auth/callback?code=C1&state=${state}`);
  assert.equal(cb.status, 200);
  assert.match(calls.token[0], /grant_type=authorization_code/);
  const replay = await realFetch(`${base}/auth/callback?code=C1&state=${state}`);
  assert.equal(replay.status, 400, 'state must be single use');
  const st = await (await realFetch(`${base}/api/status`, { headers: H })).json();
  assert.equal(st.connected, true);
  assert.equal(st.user.name, 'Jackson, A');
});

test('chat: tool loop proposes an SR, nothing written until confirm', async () => {
  claudeScript = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'propose_script_request', input: {
      project_id: 2553, description: 'IMP - Auto-create rev rec rules', script_name: 'create_rev_rules.js',
      source: 'Scheduled', severity: '4', estimated_hours: 8, notes: 'Business requirement: ...' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Drafted the SR — confirm it in the card.' }] },
  ];
  const r = await realFetch(`${base}/api/chat`, { method: 'POST', headers: H,
    body: JSON.stringify({ message: 'Create an SR for auto rev rec rules on IMP', page: { url: 'https://x/project.pl?id=2553' } }) });
  const out = await r.json();
  assert.equal(r.status, 200, JSON.stringify(out));
  assert.equal(out.proposals.length, 1);
  assert.match(out.proposals[0].summary, /IMP - Rev Rec/);
  assert.equal(calls.xml.filter(b => b.includes('<Add')).length, 0, 'no write before confirm');
  // tool result told Claude it awaits confirmation
  const toolResult = calls.claude[1].messages.at(-1).content[0];
  assert.match(toolResult.content, /awaiting_user_confirmation/);
  // system prompt includes page context + SR rules
  assert.match(calls.claude[0].system[0].text, /project\.pl\?id=2553/);

  const c = await (await realFetch(`${base}/api/actions/${out.proposals[0].id}/confirm`, { method: 'POST', headers: H })).json();
  assert.equal(c.result.id, '9001');
  const add = calls.xml.find(b => b.includes('<Add type="Issue"'));
  assert.match(add, /enable_custom="1"/);
  assert.match(add, /<issue_categoryid>13<\/issue_categoryid>/);
  assert.match(add, /<issue_stageid>1<\/issue_stageid>/);
  assert.match(add, /<issue_sourceid>1<\/issue_sourceid>/);
  assert.match(add, /<issue_severityid>7<\/issue_severityid>/);
  assert.match(add, /<script_name__c>create_rev_rules\.js<\/script_name__c>/);
  const again = await realFetch(`${base}/api/actions/${out.proposals[0].id}/confirm`, { method: 'POST', headers: H });
  assert.equal(again.status, 409, 'proposal is single use');

  // follow-up turn reuses conversation history
  claudeScript = [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }];
  await realFetch(`${base}/api/chat`, { method: 'POST', headers: H, body: JSON.stringify({ conversationId: out.conversationId, message: 'thanks' }) });
  assert.equal(calls.claude.at(-1).messages.length, 5);
});

test('another session cannot confirm my proposal', async () => {
  claudeScript = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'propose_script_request_update', input: { id: 2631, stage: 'Live' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Proposed.' }] },
  ];
  const out = await (await realFetch(`${base}/api/chat`, { method: 'POST', headers: H, body: JSON.stringify({ message: 'move SR-2739 to live' }) })).json();
  assert.equal(out.proposals[0].details.stage, 'Client UAT → Live');
  const other = await realFetch(`${base}/api/actions/${out.proposals[0].id}/confirm`, { method: 'POST', headers: { ...H, 'X-Session-Id': 'someone-else-0123456789abcd' } });
  assert.equal(other.status, 409);
});

test('tool errors are returned to the model, not thrown', async () => {
  claudeScript = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't3', name: 'spp_rest_get', input: { resource: 'issues' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Issues are not in REST; using XML.' }] },
  ];
  const out = await (await realFetch(`${base}/api/chat`, { method: 'POST', headers: H, body: JSON.stringify({ message: 'list issues' }) })).json();
  assert.equal(out.reply, 'Issues are not in REST; using XML.');
  const tr = calls.claude.at(-1).messages.at(-1).content[0];
  assert.equal(tr.is_error, true);
  assert.match(tr.content, /Unsupported REST resource/);
});

test('not connected → 401 NOT_CONNECTED when a tool needs SPP', async () => {
  claudeScript = [{ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'spp_whoami', input: {} }] }];
  const r = await realFetch(`${base}/api/chat`, { method: 'POST', headers: { ...H, 'X-Session-Id': 'never-connected-0123456789ab' },
    body: JSON.stringify({ message: 'who am I' }) });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'NOT_CONNECTED');
});
