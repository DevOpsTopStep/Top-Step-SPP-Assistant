// SPP user scripting is ECMAScript 5 only. This checks generated scripts for
// (1) syntax errors and (2) ES2015+ features that SPP will reject, plus a few
// SPP-specific best-practice warnings. No dependencies.

// Blank out strings, template literals, regex-ish literals and comments so
// keyword scans don't trip on text inside them. Keeps line/column positions.
function mask(code) {
  let out = '', i = 0;
  const n = code.length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = code[i], d = code[i + 1];
    if (c === '/' && d === '/') { const j = code.indexOf('\n', i); const e = j < 0 ? n : j; out += blank(code.slice(i, e)); i = e; continue; }
    if (c === '/' && d === '*') { const j = code.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2; out += blank(code.slice(i, e)); i = e; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; while (j < n && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      out += c + blank(code.slice(i + 1, j)) + (code[j] === c ? c : ''); i = code[j] === c ? j + 1 : j; continue;
    }
    if (c === '`') { // keep backticks visible so we can flag template literals
      let j = i + 1; while (j < n && code[j] !== '`') j += code[j] === '\\' ? 2 : 1;
      out += '`' + blank(code.slice(i + 1, j)) + '`'; i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

const RULES = [
  [/(^|[^\w$.])let\s+[\w$[{]/m, 'uses `let` (ES2015). Use `var`.'],
  [/(^|[^\w$.])const\s+[\w$[{]/m, 'uses `const` (ES2015). Use `var`.'],
  [/=>/, 'uses an arrow function (ES2015). Use `function () {}`.'],
  [/`/, 'uses a template literal (ES2015). Use string concatenation.'],
  [/(^|[^\w$.])class\s+[\w$]/m, 'uses `class` (ES2015). Use constructor functions.'],
  [/for\s*\([^;)]*\sof\s/, 'uses `for...of` (ES2015). Use a classic `for` loop.'],
  [/\.\.\.[\w$[({]/, 'uses spread/rest `...` (ES2015).'],
  [/(^|[^\w$.])(async|await)\s/m, 'uses async/await (ES2017). SPP scripts are synchronous.'],
  [/(^|[^\w$.])(Promise|Symbol|Map|Set|WeakMap|Proxy|Reflect)\s*[.(]/m, 'uses an ES2015+ built-in (Promise/Map/Set/Symbol/Proxy/Reflect).'],
  [/(^|[^\w$.])(import|export)\s/m, 'uses ES modules (import/export). SPP scripts are plain functions.'],
  [/\.(includes|find|findIndex|startsWith|endsWith|padStart|padEnd|repeat|fill)\s*\(/, 'calls an ES2015+ method (includes/find/startsWith/padStart/...). Use indexOf or a loop.'],
  [/Object\.(assign|entries|values)\s*\(/, 'calls Object.assign/entries/values (ES2015+).'],
  [/Array\.(from|of)\s*\(/, 'calls Array.from/of (ES2015).'],
  [/function\s*\*|yield\s/, 'uses generators (ES2015).'],
  [/function\s*[\w$]*\s*\([^)]*=/, 'uses default parameter values (ES2015).'],
  [/\?\?|\?\./, 'uses ?? or ?. (ES2020).'],
];

export function checkEs5(code) {
  const errors = [], warnings = [];
  try { new Function(code); }
  catch (e) { errors.push(`Syntax error: ${e.message}`); }

  const masked = mask(code);
  const lines = masked.split('\n');
  for (const [re, msg] of RULES) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) { errors.push(`Line ${i + 1}: ${msg}`); break; }
    }
  }
  if (/NSOA\.wsapi\./.test(masked) && !/disableFilterSet/.test(masked))
    warnings.push('Calls NSOA.wsapi without NSOA.wsapi.disableFilterSet(...). Form scripts run as the signed-in user, so results depend on their filter set — decide this explicitly.');
  if (/NSOA\.wsapi\.(add|modify|upsert|delete|read)\s*\(/.test(masked) && !/errors|\.errors|error/.test(masked))
    warnings.push('wsapi results are not checked for errors (inspect result[i].errors).');
  if (/(for|while)\s*\([\s\S]{0,200}NSOA\.wsapi\./.test(masked))
    warnings.push('NSOA.wsapi call inside a loop: each call costs 10 governance units. Batch records into one call.');
  if (!/NSOA\.meta\.log|NSOA\.form\.(error|warning|confirmation)/.test(masked))
    warnings.push('No NSOA.meta.log or NSOA.form messaging — add logging so the script is debuggable in the Scripting Center.');
  return { ok: errors.length === 0, errors, warnings };
}
