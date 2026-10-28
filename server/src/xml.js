// Tiny XML helpers for the SPP XML API: a builder for requests and a small
// parser for responses. SPP responses are simple (elements, text, a few
// attributes, no mixed content), so a full XML library is unnecessary.

export function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;
export function assertName(n) {
  if (!NAME.test(n)) throw new Error(`Invalid XML element/attribute name: ${n}`);
  return n;
}

// el('Issue', {attr: 1}, '<child/>') -> '<Issue attr="1"><child/></Issue>'
export function el(name, attrs = {}, inner = '') {
  assertName(name);
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${assertName(k)}="${esc(v)}"`).join('');
  return inner === '' || inner === null ? `<${name}${a}/>` : `<${name}${a}>${inner}</${name}>`;
}

// Object of scalar fields -> child elements with escaped text.
export function fieldsXml(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<${assertName(k)}>${esc(v)}</${k}>`).join('');
}

function decode(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
    switch (e) {
      case 'lt': return '<'; case 'gt': return '>'; case 'amp': return '&';
      case 'quot': return '"'; case 'apos': return "'";
      default: return e[1] === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16))
        : String.fromCodePoint(parseInt(e.slice(1), 10));
    }
  });
}

// Parse into nodes: { name, attrs, children: [], text }
export function parseXml(xml) {
  const src = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.\-:]*)((?:\s+[\w.\-:]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.text += m[1]; continue; }
    if (m[6] !== undefined) { top.text += decode(m[6]); continue; }
    const [, , closing, name, rawAttrs, selfClose] = m;
    if (closing) {
      if (top.name !== name) throw new Error(`Malformed XML: expected </${top.name}> got </${name}>`);
      stack.pop();
      continue;
    }
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([\w.\-:]+)\s*=\s*("([^"]*)"|'([^']*)')/g))
      attrs[a[1]] = decode(a[3] ?? a[4]);
    const node = { name, attrs, children: [], text: '' };
    top.children.push(node);
    if (!selfClose) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`Malformed XML: unclosed <${stack[stack.length - 1].name}>`);
  return root;
}

// Convert a record node (e.g. <Issue>...</Issue>) to a flat object.
// Nested complex fields (e.g. <date><Date><year>..) become ISO-ish strings.
export function recordToObject(node) {
  const out = {};
  for (const c of node.children) {
    if (c.children.length === 0) out[c.name] = c.text.trim();
    else if (c.children.length === 1 && c.children[0].name === 'Date') out[c.name] = dateNode(c.children[0]);
    else out[c.name] = recordToObject(c);
  }
  return out;
}

function dateNode(d) {
  const f = Object.fromEntries(d.children.map(c => [c.name, c.text.trim()]));
  if (!f.year) return '';
  const p = (x) => String(x || '0').padStart(2, '0');
  const date = `${f.year}-${p(f.month)}-${p(f.day)}`;
  return f.hour ? `${date} ${p(f.hour)}:${p(f.minute)}:${p(f.second)}` : date;
}

export function find(node, name) {
  if (node.name === name) return node;
  for (const c of node.children) { const r = find(c, name); if (r) return r; }
  return null;
}
