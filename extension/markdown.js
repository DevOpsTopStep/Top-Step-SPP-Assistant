// Small, safe markdown renderer for assistant replies. Everything is HTML-
// escaped first; only a fixed set of constructs is turned back into markup.
// Supports: fenced code, tables, headings, lists, quotes, bold/italic, inline
// code and http(s) links.
(function (root) {
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function inline(s) {
    // s is already escaped
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[Number(i)]}</code>`);
    return s;
  }

  function splitRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  }

  function renderBlocks(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // table: header row + separator row
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        out.push('<div class="table-wrap"><div class="block-bar"><span>Table · ' + rows.length + ' rows</span>' +
          '<button class="mini" data-act="csv">Download CSV</button><button class="mini" data-act="copy-table">Copy</button></div>' +
          '<div class="table-scroll"><table><thead><tr>' + head.map(h => '<th>' + inline(h) + '</th>').join('') +
          '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(c => (c.length > 24 ? '<td class="wrap">' : '<td>') + inline(c) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table></div></div>');
        continue;
      }
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { const n = Math.min(m[1].length + 1, 5); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); i++;
        }
        out.push((ordered ? '<ol>' : '<ul>') + items.map(t => '<li>' + inline(t) + '</li>').join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      if (/^&gt;\s?/.test(line)) {
        const q = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) { q.push(lines[i].replace(/^&gt;\s?/, '')); i++; }
        out.push('<blockquote>' + inline(q.join('<br>')) + '</blockquote>');
        continue;
      }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (!line.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*([-*]|\d+\.)\s|&gt;|\s*\|)/.test(lines[i])) { para.push(lines[i]); i++; }
      if (!para.length) { para.push(lines[i]); i++; }
      out.push('<p>' + inline(para.join('<br>')) + '</p>');
    }
    return out.join('');
  }

  function renderMarkdown(md) {
    const parts = String(md || '').split(/^```([\w+-]*)[^\n]*\n([\s\S]*?)^```\s*$/m);
    // split with 2 capture groups: [text, lang, code, text, lang, code, ...]
    let html = '';
    for (let i = 0; i < parts.length; i += 3) {
      html += renderBlocks(esc(parts[i] || ''));
      if (i + 2 < parts.length) {
        const lang = parts[i + 1] || 'text';
        const code = parts[i + 2].replace(/\n$/, '');
        html += '<div class="code"><div class="block-bar"><span>' + esc(lang) + '</span>' +
          '<button class="mini" data-act="copy-code">Copy</button>' +
          (/^(js|javascript)$/i.test(lang) ? '<button class="mini" data-act="download-code">Download .js</button>' : '') +
          '</div><pre><code>' + esc(code) + '</code></pre></div>';
      }
    }
    return html;
  }

  // Convert a rendered table element to CSV.
  function tableToCsv(table) {
    const q = (s) => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    return Array.from(table.rows).map(r => Array.from(r.cells).map(c => q(c.innerText.trim())).join(',')).join('\n');
  }

  const api = { renderMarkdown, tableToCsv, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
