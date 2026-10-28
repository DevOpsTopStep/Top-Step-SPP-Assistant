// SuiteProjects Pro API clients (REST for projects/time/bookings/users,
// XML API for everything REST doesn't cover, e.g. Issues = script requests).
import { config } from './config.js';
import { getAccessToken } from './auth.js';
import { el, fieldsXml, parseXml, recordToObject, find, esc } from './xml.js';

// Resources the REST API exposes (SPP docs, REST API endpoint reference).
export const REST_RESOURCES = [
  'bookings', 'contacts', 'customers', 'expense-reports', 'job-codes', 'projects',
  'project-milestones', 'project-phases', 'project-tasks', 'published-reports',
  'receipts', 'time-entries', 'users',
];

async function withAuthRetry(sid, fn) {
  let token = await getAccessToken(sid);
  let res = await fn(token);
  if (res.status === 401) {
    token = await getAccessToken(sid, { force: true });
    res = await fn(token);
  }
  return res;
}

// GET /rest/v1/<resource>[/<id>] with q/fields/limit/offset.
export async function restGet(sid, { resource, id, q, fields, limit = 100, offset = 0, filterSetId }) {
  if (!REST_RESOURCES.includes(resource)) throw new Error(`Unsupported REST resource "${resource}". Use one of: ${REST_RESOURCES.join(', ')}; for anything else use spp_xml_read.`);
  if (id !== undefined && !/^\d+$/.test(String(id))) throw new Error('id must be numeric');
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (fields) params.set('fields', fields);
  if (id === undefined) { params.set('limit', String(Math.min(Number(limit) || 100, 1000))); params.set('offset', String(Number(offset) || 0)); }
  if (filterSetId) params.set('filterSetId', String(filterSetId));
  const url = `${config.spp.restBase}/${resource}${id !== undefined ? '/' + id : ''}${params.size ? '?' + params : ''}`;
  const res = await withAuthRetry(sid, (t) => fetch(url, { headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' } }));
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`SPP REST ${res.status}: ${JSON.stringify(body)?.slice(0, 500)}`);
  return body;
}

// Wrap XML commands in the SPP <request> envelope with OAuth auth.
export function xmlEnvelope(token, commandsXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<request API_ver="1.0" client="Topstep SPP Assistant" client_ver="0.1" namespace="${esc(config.spp.apiNamespace)}" key="${esc(config.spp.apiKey)}">` +
    `<Auth><Login><access_token>${esc(token)}</access_token></Login></Auth>${commandsXml}</request>`;
}

export async function xmlCall(sid, commandsXml) {
  const res = await withAuthRetry(sid, async (t) => {
    const r = await fetch(config.spp.xmlEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xmlEnvelope(t, commandsXml),
    });
    // XML API reports auth failure as status 420 inside a 200 response.
    if (r.ok) {
      const text = await r.text();
      const authFail = /<Auth[^>]*status="420"/.test(text);
      return { status: authFail ? 401 : 200, text };
    }
    return { status: r.status, text: await r.text() };
  });
  if (res.status !== 200) throw new Error(`SPP XML API HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  const doc = parseXml(res.text);
  const auth = find(doc, 'Auth');
  if (auth && auth.attrs.status && auth.attrs.status !== '0') throw new Error(`SPP XML auth failed (status ${auth.attrs.status}).`);
  return doc;
}

function checkStatus(node, what) {
  const s = node?.attrs?.status;
  if (s && s !== '0') throw new Error(`SPP XML ${what} failed with status ${s}. See "XML API error codes" in SPP help.`);
}

// Read records of an XML datatype. equalTo: { field: value } (AND).
export async function xmlRead(sid, { type, equalTo, returnFields, limit = 100, offset = 0, enableCustom = true }) {
  const filter = equalTo && Object.keys(equalTo).length;
  const ret = returnFields?.length ? el('_Return', {}, returnFields.map(f => el(f)).join('')) : '';
  const cmd = el('Read', {
    type, method: filter ? 'equal to' : 'all',
    limit: `${Number(offset) || 0},${Math.min(Number(limit) || 100, 1000)}`,
    enable_custom: enableCustom ? '1' : undefined,
  }, (filter ? el(type, {}, fieldsXml(equalTo)) : '') + ret);
  const doc = await xmlCall(sid, cmd);
  const read = find(doc, 'Read');
  if (read?.attrs.status === '601') return []; // 601 = no records found
  checkStatus(read, 'Read');
  return read.children.filter(c => c.name === type).map(recordToObject);
}

export async function xmlAdd(sid, type, fields) {
  const doc = await xmlCall(sid, el('Add', { type, enable_custom: '1' }, el(type, {}, fieldsXml(fields))));
  const add = find(doc, 'Add');
  checkStatus(add, 'Add');
  return recordToObject(add.children.find(c => c.name === type) || { children: [] });
}

export async function xmlModify(sid, type, id, fields) {
  const doc = await xmlCall(sid, el('Modify', { type, enable_custom: '1' }, el(type, {}, fieldsXml({ id, ...fields }))));
  const mod = find(doc, 'Modify');
  checkStatus(mod, 'Modify');
  return recordToObject(mod.children.find(c => c.name === type) || { children: [] });
}

export async function whoami(sid) {
  const doc = await xmlCall(sid, el('Whoami'));
  const u = find(doc, 'User');
  return u ? recordToObject(u) : null;
}
