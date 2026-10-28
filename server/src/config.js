// Loads settings from environment (and an optional .env file) plus the
// script-request field mapping in config/script-request.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// Minimal .env loader (KEY=value per line, # comments). Real env vars win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(root, '.env'));

// Empty values and the deploy placeholder REPLACE_ME count as unset.
const env = (k, d) => {
  const v = process.env[k];
  return v === undefined || v.trim() === '' || v.trim() === 'REPLACE_ME' ? d : v.trim();
};

const companyId = env('SPP_COMPANY_ID', 'company-id');
const sandbox = env('SPP_SANDBOX', 'false') === 'true';
const accountDomain = env('SPP_ACCOUNT_DOMAIN',
  `${companyId}.app.${sandbox ? 'sandbox.' : ''}netsuitesuiteprojectspro.com`);

export const config = {
  root,
  port: Number(env('PORT', 8787)),
  publicUrl: env('PUBLIC_URL', 'http://localhost:8787').replace(/\/$/, ''),
  // Comma-separated chrome-extension://<id> origins allowed to call the API.
  allowedOrigins: env('ALLOWED_ORIGINS', '').split(',').map(s => s.trim()).filter(Boolean),
  anthropic: {
    apiKey: env('ANTHROPIC_API_KEY', ''),
    model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
    baseUrl: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
    maxTokens: Number(env('ANTHROPIC_MAX_TOKENS', 8000)),
  },
  spp: {
    accountDomain,
    restBase: `https://${accountDomain}/rest/v1`,
    xmlEndpoint: `https://${accountDomain}/api.pl`,
    oauthBase: `https://${accountDomain}/login/oauth2/v1`,
    uiBase: `https://${accountDomain}`,
    clientId: env('SPP_CLIENT_ID', ''),
    clientSecret: env('SPP_CLIENT_SECRET', ''),
    scope: env('SPP_SCOPE', 'rest+xml'),
    apiNamespace: env('SPP_API_NAMESPACE', ''),
    apiKey: env('SPP_API_KEY', ''),
  },
  // 'memory' keeps SPP sign-ins in memory only (nothing on disk; a restart asks users to reconnect).
  tokenStoreFile: env('TOKEN_STORE_FILE', path.join(root, 'data', 'sessions.json')),
  maxAgentTurns: Number(env('MAX_AGENT_TURNS', 12)),
};

export const srConfig = JSON.parse(
  fs.readFileSync(path.join(root, 'config', 'script-request.json'), 'utf8'));

// The XML API (needed for script requests, invoices, charges, etc.) turns on
// automatically once both the namespace and key are set. Without them the
// assistant runs REST-only: script writing/review and REST reports still work.
// The OAuth scope keeps requesting xml so users won't need to reconnect later.
export function xmlEnabled() {
  return Boolean(config.spp.apiNamespace && config.spp.apiKey)
    && config.spp.scope.toLowerCase().includes('xml')
    && env('SPP_DISABLE_XML', 'false') !== 'true';
}

export function features() {
  return { xml: xmlEnabled(), scriptRequests: xmlEnabled() };
}

export function assertConfigured() {
  const missing = [];
  if (!config.anthropic.apiKey) missing.push('ANTHROPIC_API_KEY');
  if (!config.spp.clientId) missing.push('SPP_CLIENT_ID');
  if (!config.spp.clientSecret) missing.push('SPP_CLIENT_SECRET');
  return missing;
}
