// Tools the assistant can call. Read tools run immediately. Write tools never
// write directly: they validate and return a proposal that the user must
// confirm in the side panel (POST /api/actions/:id/confirm).
import crypto from 'node:crypto';
import { config, srConfig, xmlEnabled } from './config.js';
import { restGet, xmlRead, xmlAdd, xmlModify, whoami, REST_RESOURCES } from './spp.js';
import { checkEs5 } from './es5check.js';
import { setSessionUser } from './auth.js';

const MAX_ROWS_TO_MODEL = 200;

export const toolDefinitions = [
  {
    name: 'spp_whoami',
    description: 'Return the signed-in SPP user (id, name, email, role). Use to resolve "me"/"my".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'spp_rest_get',
    description: `Read SuiteProjects Pro records through the REST API. Resources: ${REST_RESOURCES.join(', ')}. ` +
      'Use q for filters with SPP REST filter syntax, e.g. q=active IS 1 AND customerId IS 42, ' +
      "q=date BETWEEN ['2026-10-01','2026-10-31'], q=name CONTAINS 'Acme'. Use fields to limit columns. " +
      'Results are paged (limit max 1000; use offset). Results run with the user\'s own SPP permissions.',
    input_schema: {
      type: 'object',
      properties: {
        resource: { type: 'string', enum: REST_RESOURCES },
        id: { type: 'integer', description: 'Fetch a single record by internal id.' },
        q: { type: 'string' }, fields: { type: 'string', description: 'Comma-separated field names.' },
        limit: { type: 'integer' }, offset: { type: 'integer' },
      },
      required: ['resource'],
    },
  },
  {
    name: 'spp_xml_read',
    description: 'Read records via the SPP XML API for datatypes REST does not cover: Issue (script requests), Invoice, Slip (charges), ' +
      'Envelope (expense reports), Timesheet, Projectbillingrule, Revenue_recognition_rule, Customer, Project, Projecttask, User, Booking, etc. ' +
      'equal_to is an AND filter of exact field values using XML field names (e.g. {"projectid":"2553"}). Custom fields end in __c.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'XML datatype name, e.g. Issue, Invoice, Slip, Project.' },
        equal_to: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
        return_fields: { type: 'array', items: { type: 'string' }, description: 'Limit returned fields (recommended).' },
        limit: { type: 'integer' }, offset: { type: 'integer' },
      },
      required: ['type'],
    },
  },
  {
    name: 'list_script_requests',
    description: 'List Script Requests (SRs) with friendly stage/source/severity names. Filter by project, stage name, or script name substring.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer' },
        stage: { type: 'string', enum: Object.values(srConfig.stages) },
        script_name_contains: { type: 'string' },
        limit: { type: 'integer', description: 'Default 50.' },
      },
    },
  },
  {
    name: 'propose_script_request',
    description: 'Draft a NEW Script Request for the user to review and confirm. Nothing is written until the user clicks Confirm. ' +
      'Gather project, a clear one-line summary (description), script name, script type (source), and estimate before calling. ' +
      'Put the detailed spec (business requirement, trigger/event, records & fields touched, acceptance criteria, test steps) in notes.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'SPP project the SR belongs to.' },
        description: { type: 'string', description: 'One-line SR summary, e.g. "IMP - Update Rev Rec Rule Amount with Budget".' },
        script_name: { type: 'string', description: 'e.g. create_tasks_from_budgets.js' },
        source: { type: 'string', enum: Object.values(srConfig.sources), description: 'Script type: Scheduled, Form, Library, Boomi, Client, Internal.' },
        severity: { type: 'string', enum: Object.values(srConfig.severities) },
        estimated_hours: { type: 'number' },
        requested_date: { type: 'string', description: 'YYYY-MM-DD' },
        notes: { type: 'string', description: 'Full specification in plain text.' },
        stage: { type: 'string', enum: Object.values(srConfig.stages), description: 'Default Scoping.' },
      },
      required: ['project_id', 'description', 'notes'],
    },
  },
  {
    name: 'propose_script_request_update',
    description: 'Propose changes to an existing Script Request (e.g. move stage, set estimate, append code or notes). Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Internal id of the SR (not the SR- number).' },
        stage: { type: 'string', enum: Object.values(srConfig.stages) },
        estimated_hours: { type: 'number' },
        script_name: { type: 'string' },
        notes: { type: 'string', description: 'Replaces the SR notes. Read the SR first and include existing notes if appending.' },
        description: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'validate_user_script',
    description: 'Check a SuiteProjects Pro user script for syntax errors and ES2015+ features (SPP only runs ECMAScript 5) plus SPP best-practice warnings. ALWAYS run this on any script before showing it to the user; fix errors and re-run.',
    input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  },
];

// Tools that need the SPP XML API (namespace + key).
export const XML_TOOLS = new Set(['spp_whoami', 'spp_xml_read', 'list_script_requests', 'propose_script_request', 'propose_script_request_update']);

export function activeToolDefinitions() {
  return xmlEnabled() ? toolDefinitions : toolDefinitions.filter(t => !XML_TOOLS.has(t.name));
}

// ---- pending write actions ------------------------------------------------
const pending = new Map(); // id -> { sid, kind, summary, run, created }
function propose(sid, kind, summary, details, run) {
  const id = crypto.randomUUID();
  pending.set(id, { sid, kind, summary, details, run, created: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.created > 30 * 60e3) pending.delete(k);
  return { id, kind, summary, details };
}

export async function confirmAction(sid, id) {
  const a = pending.get(id);
  if (!a || a.sid !== sid) throw new Error('This proposal expired or does not belong to you. Ask the assistant to draft it again.');
  pending.delete(id);
  return a.run();
}
export function cancelAction(sid, id) {
  const a = pending.get(id);
  if (a && a.sid === sid) pending.delete(id);
}

// ---- helpers ---------------------------------------------------------------
const byName = (map, name) => {
  if (name === undefined) return undefined;
  const hit = Object.entries(map).find(([, v]) => v.toLowerCase() === String(name).toLowerCase());
  if (!hit) throw new Error(`Unknown value "${name}". Valid: ${Object.values(map).join(', ')}`);
  return hit[0];
};
const F = srConfig.fields, CF = srConfig.customFields;

function srToFriendly(r) {
  return {
    id: r[F.id], sr: `${r[F.prefix] || 'SR-'}${r[F.number] || ''}`, description: r[F.description],
    script_name: r[CF.script_name], stage: srConfig.stages[r[F.stage_id]] || r[F.stage_id],
    source: srConfig.sources[r[F.source_id]] || r[F.source_id],
    severity: srConfig.severities[r[F.severity_id]] || r[F.severity_id],
    project_id: r[F.project_id], estimated_hours: r[CF.estimated_hours], requested_date: r[CF.requested_date],
    updated: r[F.updated],
    link: `${config.spp.uiBase}${srConfig.uiRecordUrl.replace('{id}', r[F.id])}`,
  };
}

function truncateRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.length > MAX_ROWS_TO_MODEL
    ? { rows: rows.slice(0, MAX_ROWS_TO_MODEL), truncated: true, total_returned: rows.length, note: `Only the first ${MAX_ROWS_TO_MODEL} rows are shown; narrow the filter or page with offset.` }
    : rows;
}

// ---- handlers --------------------------------------------------------------
export async function runTool(sid, name, input) {
  if (XML_TOOLS.has(name) && !xmlEnabled())
    throw new Error('This needs the SPP XML API, which is not configured on the server yet (SPP_API_NAMESPACE / SPP_API_KEY). Script requests, invoices and charges are unavailable; REST data and script writing still work.');
  switch (name) {
    case 'spp_whoami': {
      const u = await whoami(sid);
      if (u) setSessionUser(sid, { id: u.id, name: u.name || u.nickname, email: u.addr_email || u.email });
      return u;
    }
    case 'spp_rest_get': {
      const body = await restGet(sid, input);
      if (body && Array.isArray(body.data)) return { ...body, data: truncateRows(body.data) };
      return body;
    }
    case 'spp_xml_read':
      return truncateRows(await xmlRead(sid, {
        type: input.type, equalTo: input.equal_to, returnFields: input.return_fields, limit: input.limit, offset: input.offset,
      }));
    case 'list_script_requests': {
      const eq = { [F.category_id]: srConfig.categoryId };
      if (input.project_id) eq[F.project_id] = input.project_id;
      if (input.stage) eq[F.stage_id] = byName(srConfig.stages, input.stage);
      let rows = await xmlRead(sid, { type: srConfig.xmlType, equalTo: eq, limit: 1000 });
      if (input.script_name_contains) {
        const s = input.script_name_contains.toLowerCase();
        rows = rows.filter(r => String(r[CF.script_name] || '').toLowerCase().includes(s));
      }
      rows.sort((a, b) => String(b[F.updated]).localeCompare(String(a[F.updated])));
      return truncateRows(rows.slice(0, input.limit || 50).map(srToFriendly));
    }
    case 'propose_script_request': {
      const fields = {
        [F.category_id]: srConfig.categoryId,
        [F.stage_id]: input.stage ? byName(srConfig.stages, input.stage) : srConfig.defaultStageId,
        [F.project_id]: input.project_id,
        [F.description]: input.description,
        [F.notes]: input.notes,
        [F.priority]: srConfig.defaults.priority,
        [F.source_id]: byName(srConfig.sources, input.source),
        [F.severity_id]: byName(srConfig.severities, input.severity),
        [CF.script_name]: input.script_name,
        [CF.estimated_hours]: input.estimated_hours,
        [CF.requested_date]: input.requested_date,
        [CF.create_task_for_script_request]: srConfig.defaults.create_task_for_script_request,
      };
      // Look up the project so the user can sanity-check where this lands.
      let project = null;
      try {
        const p = await xmlRead(sid, { type: 'Project', equalTo: { id: input.project_id }, returnFields: ['id', 'name', 'customer_name'], limit: 1 });
        project = p[0] || null;
      } catch { /* show proposal anyway */ }
      if (!project) throw new Error(`Project ${input.project_id} was not found or you don't have access to it. Ask the user which project.`);
      return propose(sid, 'create_script_request',
        `Create Script Request on project "${project.name}" (#${project.id})`,
        {
          project: `${project.name} (#${project.id})`, description: input.description, script_name: input.script_name,
          type: input.source, severity: input.severity, estimated_hours: input.estimated_hours,
          requested_date: input.requested_date, stage: input.stage || srConfig.stages[srConfig.defaultStageId], notes: input.notes,
        },
        async () => {
          const r = await xmlAdd(sid, srConfig.xmlType, fields);
          const id = r[F.id] || r.id;
          return { created: true, id, link: id ? `${config.spp.uiBase}${srConfig.uiRecordUrl.replace('{id}', id)}` : null };
        });
    }
    case 'propose_script_request_update': {
      const [current] = await xmlRead(sid, { type: srConfig.xmlType, equalTo: { [F.id]: input.id }, limit: 1 });
      if (!current) throw new Error(`Script request id ${input.id} not found or not accessible.`);
      if (String(current[F.category_id]) !== String(srConfig.categoryId)) throw new Error(`Issue ${input.id} is not a Script Request.`);
      const fields = {
        [F.stage_id]: input.stage ? byName(srConfig.stages, input.stage) : undefined,
        [F.description]: input.description, [F.notes]: input.notes,
        [CF.estimated_hours]: input.estimated_hours, [CF.script_name]: input.script_name,
      };
      for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
      if (!Object.keys(fields).length) throw new Error('No changes provided.');
      const cur = srToFriendly(current);
      const changes = {};
      if (input.stage) changes.stage = `${cur.stage} → ${input.stage}`;
      if (input.estimated_hours !== undefined) changes.estimated_hours = `${cur.estimated_hours || '—'} → ${input.estimated_hours}`;
      if (input.script_name) changes.script_name = `${cur.script_name || '—'} → ${input.script_name}`;
      if (input.description) changes.description = `${cur.description} → ${input.description}`;
      if (input.notes) changes.notes = input.notes;
      return propose(sid, 'update_script_request', `Update ${cur.sr}: ${cur.description}`, changes, async () => {
        await xmlModify(sid, srConfig.xmlType, input.id, fields);
        return { updated: true, id: input.id, link: cur.link };
      });
    }
    case 'validate_user_script':
      return checkEs5(input.code);
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
