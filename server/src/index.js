// HTTP server for the SPP Assistant. No framework: node:http only.
import http from 'node:http';
import crypto from 'node:crypto';
import { config, assertConfigured, features } from './config.js';
import { authStartUrl, handleCallback, sessionStatus, signOut, isValidSid } from './auth.js';
import { runAgent } from './agent.js';
import { confirmAction, cancelAction, runTool } from './tools.js';

const conversations = new Map(); // conversationId -> { sid, messages, updated }
const MAX_HISTORY = 80;

function trimHistory(msgs) {
  if (msgs.length <= MAX_HISTORY) return msgs;
  // Drop from the front, but only start on a plain user text message so we
  // never orphan a tool_result from its tool_use.
  let i = msgs.length - MAX_HISTORY;
  while (i < msgs.length && !(msgs[i].role === 'user' && typeof msgs[i].content === 'string')) i++;
  return msgs.slice(i);
}

function cors(req, res) {
  const origin = req.headers.origin;
  const allowed = origin && (config.allowedOrigins.length
    ? config.allowedOrigins.includes(origin)
    : origin.startsWith('chrome-extension://'));
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  return allowed || !origin;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 2e6) throw new Error('Request too large'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const page = (title, msg) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px system-ui;max-width:480px;margin:15vh auto;color:#1b1f24"><h2>${title}</h2><p>${msg}</p></body>`;

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, config.publicUrl);
    try {
      if (!cors(req, res)) return send(res, 403, { error: 'Origin not allowed' });
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

      if (url.pathname === '/health') return send(res, 200, { ok: true, missingConfig: assertConfigured(), features: features() });

      // ---- OAuth (opened in a normal browser tab) ----
      if (url.pathname === '/auth/start') {
        const sid = url.searchParams.get('sid');
        if (!isValidSid(sid)) return send(res, 400, page('Invalid request', 'Missing session.'), 'text/html');
        res.writeHead(302, { Location: authStartUrl(sid) }); return res.end();
      }
      if (url.pathname === '/auth/callback') {
        try {
          await handleCallback(Object.fromEntries(url.searchParams));
          return send(res, 200, page('Connected to SuiteProjects Pro', 'You can close this tab and go back to the assistant panel.'), 'text/html');
        } catch (e) {
          return send(res, 400, page('Could not connect', String(e.message)), 'text/html');
        }
      }

      // ---- API (side panel) ----
      if (url.pathname.startsWith('/api/')) {
        const sid = req.headers['x-session-id'];
        if (!isValidSid(sid)) return send(res, 401, { error: 'Missing session id' });

        if (url.pathname === '/api/status' && req.method === 'GET') {
          const st = sessionStatus(sid);
          if (st.connected && !st.user && features().xml) { try { await runTool(sid, 'spp_whoami', {}); } catch { /* ignore */ } }
          return send(res, 200, { ...sessionStatus(sid), account: config.spp.accountDomain, model: config.anthropic.model, features: features() });
        }
        if (url.pathname === '/api/signout' && req.method === 'POST') { signOut(sid); return send(res, 200, { ok: true }); }

        if (url.pathname === '/api/chat' && req.method === 'POST') {
          const { conversationId, message, page: pageCtx } = await readJson(req);
          if (!message || typeof message !== 'string') return send(res, 400, { error: 'message required' });
          let conv = conversationId && conversations.get(conversationId);
          if (conv && conv.sid !== sid) conv = null;
          const id = conv ? conversationId : crypto.randomUUID();
          const msgs = conv ? conv.messages : [];
          msgs.push({ role: 'user', content: message });
          try {
            const out = await runAgent({ sid, messages: trimHistory(msgs), page: pageCtx });
            conversations.set(id, { sid, messages: out.messages, updated: Date.now() });
            for (const [k, v] of conversations) if (Date.now() - v.updated > 12 * 3600e3) conversations.delete(k);
            return send(res, 200, { conversationId: id, reply: out.reply, proposals: out.proposals, steps: out.steps });
          } catch (e) {
            msgs.pop();
            if (e.code === 'NOT_CONNECTED') return send(res, 401, { error: e.message, code: 'NOT_CONNECTED' });
            throw e;
          }
        }

        const m = url.pathname.match(/^\/api\/actions\/([\w-]+)\/(confirm|cancel)$/);
        if (m && req.method === 'POST') {
          if (m[2] === 'cancel') { cancelAction(sid, m[1]); return send(res, 200, { ok: true }); }
          let result;
          try { result = await confirmAction(sid, m[1]); }
          catch (e) { return send(res, /expired|does not belong/.test(e.message) ? 409 : 502, { error: e.message }); }
          return send(res, 200, { ok: true, result });
        }
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      console.error(e);
      return send(res, 500, { error: String(e.message || e) });
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const missing = assertConfigured();
  if (missing.length) console.warn(`⚠ Missing config: ${missing.join(', ')} — see .env.example`);
  if (!features().xml) console.warn('ℹ XML API not configured (SPP_API_NAMESPACE / SPP_API_KEY): running REST-only. Script requests are disabled until both are set.');
  if (!config.allowedOrigins.length) console.warn('⚠ ALLOWED_ORIGINS not set: any Chrome extension may call this server. Set it to your extension origin before rollout.');
  createServer().listen(config.port, () => console.log(`SPP Assistant server on ${config.publicUrl} (port ${config.port}) → ${config.spp.accountDomain}`));
}
