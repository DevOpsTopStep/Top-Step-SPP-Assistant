// Runs on SuiteProjects Pro pages. When the side panel asks, it returns a
// compact description of the current page: record type/id, title, visible
// form field values, selected text and (in the Scripting Studio) the script.
// Password and hidden fields are never read.
(function () {
  const RECORD_PAGES = {
    'project.pl': 'Project', 'issue.pl': 'Issue / Script Request', 'customer.pl': 'Customer',
    'user.pl': 'User', 'timesheet.pl': 'Timesheet', 'envelope.pl': 'Expense report',
    'invoice.pl': 'Invoice', 'booking.pl': 'Booking', 'report.pl': 'Report', 'scripting.pl': 'Scripting Center',
  };

  function text(el) { return (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim(); }

  function labelFor(input) {
    if (input.id) {
      const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (l) return text(l);
    }
    const row = input.closest('tr');
    if (row) { const th = row.querySelector('th, td.label, td:first-child'); if (th && !th.contains(input)) return text(th); }
    const wrap = input.closest('label, .field, .form-group, [class*="field"]');
    if (wrap) { const t = text(wrap.querySelector('label, .label, [class*="label"]')); if (t) return t; }
    return input.getAttribute('aria-label') || input.name || input.id || '';
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function formFields(limit) {
    const out = [];
    const els = document.querySelectorAll('input, select, textarea');
    for (const el of els) {
      if (out.length >= limit) break;
      const type = (el.type || '').toLowerCase();
      if (['password', 'hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(type)) continue;
      if (/pass|token|secret|ssn/i.test(el.name || el.id || '')) continue;
      if (!visible(el)) continue;
      let value;
      if (el.tagName === 'SELECT') value = Array.from(el.selectedOptions).map(o => o.text).join(', ');
      else if (type === 'checkbox' || type === 'radio') { if (!el.checked && type === 'radio') continue; value = el.checked ? 'Yes' : 'No'; }
      else value = el.value;
      if (value === '' || value === undefined) continue;
      const label = labelFor(el).slice(0, 80);
      out.push({ label, value: String(value).slice(0, 500) });
    }
    return out;
  }

  function scriptEditorCode() {
    // Scripting Studio uses a code editor; try CodeMirror / Ace / Monaco, then textareas.
    const cm = document.querySelector('.CodeMirror');
    if (cm && cm.CodeMirror) return cm.CodeMirror.getValue();
    const ace = document.querySelector('.ace_editor');
    if (ace && window.ace) { try { return window.ace.edit(ace).getValue(); } catch (e) { /* ignore */ } }
    const lines = document.querySelectorAll('.view-lines .view-line');
    if (lines.length) return Array.from(lines).map(l => l.textContent).join('\n');
    const ta = Array.from(document.querySelectorAll('textarea')).find(t => /script|code/i.test(t.name || t.id || '') && t.value.length > 20);
    return ta ? ta.value : null;
  }

  function context() {
    const url = new URL(location.href);
    const file = url.pathname.split('/').pop();
    const params = Object.fromEntries(Array.from(url.searchParams).filter(([k]) => !/token|session|auth/i.test(k)));
    const h = document.querySelector('h1, .page-title, .title, [class*="pageTitle"]');
    const crumbs = Array.from(document.querySelectorAll('.breadcrumb a, .breadcrumbs a, [class*="breadcrumb"] a')).map(text).filter(Boolean);
    const ctx = {
      url: url.origin + url.pathname + (Object.keys(params).length ? '?' + new URLSearchParams(params) : ''),
      page: RECORD_PAGES[file] || file || 'Dashboard',
      title: document.title,
      heading: text(h).slice(0, 200) || undefined,
      breadcrumbs: crumbs.length ? crumbs.slice(0, 8) : undefined,
      recordId: params.id || params.project_id || params.issue_id || undefined,
      selection: String(getSelection() || '').slice(0, 4000) || undefined,
      fields: formFields(80),
    };
    const code = /script/i.test(file + document.title) ? scriptEditorCode() : null;
    if (code) ctx.scriptCode = code.slice(0, 30000);
    if (!ctx.fields.length) {
      // Read-only views/lists: send a short text snapshot of the main content instead.
      const main = document.querySelector('main, #content, .content, form') || document.body;
      ctx.pageText = text(main).slice(0, 4000);
    }
    return ctx;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'SPP_ASSISTANT_GET_CONTEXT') {
      try { reply({ ok: true, context: context() }); } catch (e) { reply({ ok: false, error: String(e) }); }
    }
  });
})();
