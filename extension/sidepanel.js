// Side panel UI: chat with the assistant server, attach page context,
// render replies, and confirm/cancel proposed writes.
(function () {
  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('input'), sendBtn = $('send'), statusEl = $('status');
  let backend = '', sid = '', conversationId = null, busy = false, pollTimer = null;

  // ---------- settings & session ----------
  async function loadSettings() {
    let managed = {};
    try { managed = await chrome.storage.managed.get('backendUrl'); } catch (e) { /* not managed */ }
    const local = await chrome.storage.local.get(['backendUrl', 'sid']);
    backend = (managed.backendUrl || local.backendUrl || '').replace(/\/$/, '');
    sid = local.sid;
    if (!sid) { sid = crypto.randomUUID() + '-' + crypto.randomUUID().slice(0, 8); await chrome.storage.local.set({ sid }); }
  }

  async function api(path, opts) {
    if (!backend) throw Object.assign(new Error('Set the assistant server URL in Settings first.'), { code: 'NO_BACKEND' });
    const res = await fetch(backend + path, Object.assign({}, opts, {
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-Session-Id': sid }, (opts && opts.headers) || {}),
    }));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || ('HTTP ' + res.status)), { code: body.code, status: res.status });
    return body;
  }

  function setStatus(text, kind, title) {
    statusEl.textContent = text; statusEl.className = 'status ' + (kind || ''); statusEl.title = title || '';
  }

  function applyFeatures(f) {
    const xml = !f || f.xml !== false;
    document.querySelectorAll('[data-requires="xml"]').forEach(el => { el.hidden = !xml; });
    $('limitedNote').hidden = xml;
  }

  async function refreshStatus() {
    try {
      const st = await api('/api/status', { method: 'GET' });
      applyFeatures(st.features);
      if (st.connected) {
        setStatus(st.user && st.user.name ? st.user.name : 'Connected', 'ok', st.account || '');
        $('connect').hidden = true;
        return true;
      }
      setStatus('Not connected', 'warn');
      $('connect').hidden = false;
      $('connectMsg').textContent = 'Connect your SuiteProjects Pro account so the assistant can read and draft records with your permissions.';
    } catch (e) {
      setStatus(e.code === 'NO_BACKEND' ? 'Setup needed' : 'Offline', 'err', e.message);
      $('connect').hidden = false;
      $('connectMsg').textContent = e.code === 'NO_BACKEND' ? e.message : 'Can\'t reach the assistant server: ' + e.message;
      $('connectBtn').textContent = e.code === 'NO_BACKEND' ? 'Open settings' : 'Retry';
      return false;
    }
    $('connectBtn').textContent = 'Connect SPP';
    return false;
  }

  $('connectBtn').addEventListener('click', async () => {
    if (!backend) return chrome.runtime.openOptionsPage();
    if ($('connectBtn').textContent === 'Retry') return refreshStatus();
    chrome.tabs.create({ url: backend + '/auth/start?sid=' + encodeURIComponent(sid) });
    setStatus('Waiting for sign-in…', 'warn');
    clearInterval(pollTimer);
    const started = Date.now();
    pollTimer = setInterval(async () => {
      if (await refreshStatus() || Date.now() - started > 180000) clearInterval(pollTimer);
    }, 2000);
  });
  $('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('newChat').addEventListener('click', () => {
    conversationId = null;
    Array.from(log.children).forEach(c => { if (c.id !== 'welcome') c.remove(); });
    $('welcome').hidden = false;
    input.focus();
  });

  // ---------- page context ----------
  async function getPageContext() {
    if (!$('useContext').checked) return null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !/netsuitesuiteprojectspro\.com|openair\.com/.test(tab.url || '')) return null;
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'SPP_ASSISTANT_GET_CONTEXT' });
      return res && res.ok ? res.context : null;
    } catch (e) { return null; } // content script not loaded yet (page opened before install)
  }

  // ---------- rendering ----------
  function addMsg(role, html, extraClass) {
    $('welcome').hidden = true;
    const div = document.createElement('div');
    div.className = 'msg ' + role + (extraClass ? ' ' + extraClass : '');
    div.innerHTML = html;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function stepsHtml(steps) {
    if (!steps || !steps.length) return '';
    const names = { spp_rest_get: 'Read SPP (REST)', spp_xml_read: 'Read SPP (XML)', list_script_requests: 'Listed script requests',
      spp_whoami: 'Checked your user', validate_user_script: 'Validated script (ES5)', propose_script_request: 'Drafted SR',
      propose_script_request_update: 'Drafted SR update' };
    return '<details class="steps"><summary>' + steps.length + ' step' + (steps.length > 1 ? 's' : '') + '</summary><ul>' +
      steps.map(s => '<li><b>' + esc(names[s.tool] || s.tool) + '</b> <code>' + esc(s.input) + '</code></li>').join('') + '</ul></details>';
  }

  function proposalCard(p) {
    const rows = Object.entries(p.details || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => '<tr><th>' + esc(k.replace(/_/g, ' ')) + '</th><td>' + (k === 'notes' ? '<div class="notes">' + esc(String(v)) + '</div>' : esc(String(v))) + '</td></tr>').join('');
    const card = addMsg('proposal', '<div class="p-head"><span class="badge">Needs your OK</span>' + esc(p.summary) + '</div>' +
      '<table class="kv">' + rows + '</table>' +
      '<div class="p-actions"><button class="primary" data-act="confirm">Confirm &amp; save to SPP</button><button data-act="cancel">Cancel</button></div>');
    card.querySelector('[data-act="confirm"]').addEventListener('click', async (ev) => {
      const btns = card.querySelectorAll('button'); btns.forEach(b => b.disabled = true);
      ev.target.textContent = 'Saving…';
      try {
        const out = await api('/api/actions/' + encodeURIComponent(p.id) + '/confirm', { method: 'POST' });
        const r = out.result || {};
        card.querySelector('.p-actions').innerHTML = '<span class="done">Saved' + (r.id ? ' (id ' + esc(String(r.id)) + ')' : '') + '.</span>' +
          (r.link ? ' <a href="' + esc(r.link) + '" target="_blank" rel="noopener">Open in SPP</a>' : '');
        card.classList.add('confirmed');
        send('[System note: the user confirmed "' + p.summary + '". Result: ' + JSON.stringify(r) + '. Acknowledge briefly.]', { silent: true });
      } catch (e) {
        card.querySelector('.p-actions').innerHTML = '<span class="error">Not saved: ' + esc(e.message) + '</span>';
      }
    });
    card.querySelector('[data-act="cancel"]').addEventListener('click', async () => {
      try { await api('/api/actions/' + encodeURIComponent(p.id) + '/cancel', { method: 'POST' }); } catch (e) { /* ignore */ }
      card.querySelector('.p-actions').innerHTML = '<span class="muted">Cancelled — nothing was saved.</span>';
      card.classList.add('cancelled');
    });
  }

  // Code / table toolbar buttons (event delegation)
  log.addEventListener('click', (ev) => {
    const b = ev.target.closest('button.mini'); if (!b) return;
    const block = b.closest('.code, .table-wrap');
    const flash = (t) => { const o = b.textContent; b.textContent = t; setTimeout(() => (b.textContent = o), 1200); };
    if (b.dataset.act === 'copy-code') { navigator.clipboard.writeText(block.querySelector('code').innerText); flash('Copied'); }
    if (b.dataset.act === 'download-code') {
      const code = block.querySelector('code').innerText;
      const m = code.match(/function\s+([A-Za-z_$][\w$]*)/);
      download((m ? m[1] : 'spp_script') + '.js', code, 'text/javascript');
    }
    if (b.dataset.act === 'csv') download('spp-report-' + new Date().toISOString().slice(0, 10) + '.csv', tableToCsv(block.querySelector('table')), 'text/csv');
    if (b.dataset.act === 'copy-table') { navigator.clipboard.writeText(tableToCsv(block.querySelector('table')).replace(/,/g, '\t')); flash('Copied'); }
  });

  function download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- sending ----------
  async function send(text, opts) {
    opts = opts || {};
    text = (text || '').trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true;
    if (!opts.silent) addMsg('user', '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>');
    const thinking = addMsg('assistant', '<div class="typing"><span></span><span></span><span></span></div>', 'pending');
    try {
      const page = await getPageContext();
      const out = await api('/api/chat', { method: 'POST', body: JSON.stringify({ conversationId, message: text, page }) });
      conversationId = out.conversationId;
      thinking.classList.remove('pending');
      thinking.innerHTML = stepsHtml(out.steps) + renderMarkdown(out.reply || '');
      (out.proposals || []).forEach(proposalCard);
    } catch (e) {
      thinking.classList.remove('pending');
      thinking.classList.add('error');
      thinking.innerHTML = '<p>' + esc(e.message) + '</p>';
      if (e.code === 'NOT_CONNECTED' || e.code === 'NO_BACKEND') refreshStatus();
    } finally {
      busy = false; sendBtn.disabled = false; log.scrollTop = log.scrollHeight;
    }
  }

  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); const t = input.value; input.value = ''; autosize(); send(t); }
  });
  sendBtn.addEventListener('click', () => { const t = input.value; input.value = ''; autosize(); send(t); });
  document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    const p = c.dataset.prompt;
    if (/ $/.test(p)) { input.value = p; autosize(); input.focus(); input.setSelectionRange(p.length, p.length); }
    else send(p);
  }));

  // Prompt handed over from the right-click menu.
  async function takePendingPrompt() {
    const { pendingPrompt } = await chrome.storage.session.get('pendingPrompt');
    if (pendingPrompt) { await chrome.storage.session.remove('pendingPrompt'); input.value = pendingPrompt; autosize(); input.focus(); }
  }
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.pendingPrompt && changes.pendingPrompt.newValue) takePendingPrompt(); });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.backendUrl) loadSettings().then(refreshStatus); });

  loadSettings().then(refreshStatus).then(takePendingPrompt);
})();
