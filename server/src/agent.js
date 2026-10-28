// Agent loop over the Claude Messages API using plain fetch (no SDK needed).
import { config } from './config.js';
import { systemPrompt } from './prompts.js';
import { activeToolDefinitions, runTool } from './tools.js';
import { features } from './config.js';
import { sessionStatus } from './auth.js';

export async function callClaude(body, fetchImpl = fetch) {
  const res = await fetchImpl(`${config.anthropic.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${json?.error?.message || JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// messages: [{role:'user'|'assistant', content: string|blocks}] from the panel.
// Returns { messages (full history incl. tool turns), reply, proposals, steps }.
export async function runAgent({ sid, messages, page, deps = {} }) {
  const call = deps.callClaude || callClaude;
  const exec = deps.runTool || runTool;
  const user = sessionStatus(sid).user;
  const system = systemPrompt({ user, page, today: new Date().toISOString().slice(0, 10), features: features() });
  const history = [...messages];
  const proposals = [];
  const steps = [];

  for (let turn = 0; turn < config.maxAgentTurns; turn++) {
    const resp = await call({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: activeToolDefinitions(),
      messages: history,
    });
    history.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason !== 'tool_use') {
      const reply = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
      return { messages: history, reply, proposals, steps };
    }

    const results = [];
    for (const block of resp.content.filter(b => b.type === 'tool_use')) {
      steps.push({ tool: block.name, input: summarizeInput(block.input) });
      try {
        const out = await exec(sid, block.name, block.input);
        if (out && out.kind && out.id && block.name.startsWith('propose_')) {
          proposals.push(out);
          results.push({ type: 'tool_result', tool_use_id: block.id,
            content: JSON.stringify({ status: 'awaiting_user_confirmation', proposal: out.summary, details: out.details }) });
        } else {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out ?? null).slice(0, 60000) });
        }
      } catch (e) {
        if (e.code === 'NOT_CONNECTED') throw e;
        results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: String(e.message || e) });
      }
    }
    history.push({ role: 'user', content: results });
  }
  return { messages: history, reply: 'I hit my step limit for one request. Try narrowing the question.', proposals, steps };
}

function summarizeInput(input) {
  const s = JSON.stringify(input || {});
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
