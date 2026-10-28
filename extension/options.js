(async function () {
  const $ = (id) => document.getElementById(id);
  $('extId').textContent = 'chrome-extension://' + chrome.runtime.id;
  let managed = {};
  try { managed = await chrome.storage.managed.get('backendUrl'); } catch (e) { /* none */ }
  const { backendUrl } = await chrome.storage.local.get('backendUrl');
  $('backend').value = managed.backendUrl || backendUrl || '';
  if (managed.backendUrl) { $('backend').disabled = true; $('save').textContent = 'Test connection'; $('managedHint').hidden = false; }

  $('save').addEventListener('click', async () => {
    const url = $('backend').value.trim().replace(/\/$/, '');
    if (!/^https:\/\/|^http:\/\/localhost(:\d+)?$/.test(url)) { $('msg').textContent = 'Use an https:// URL (or http://localhost for local testing).'; return; }
    if (!managed.backendUrl) await chrome.storage.local.set({ backendUrl: url });
    $('msg').textContent = 'Testing…';
    try {
      const r = await fetch(url + '/health');
      const h = await r.json();
      $('msg').textContent = h.missingConfig && h.missingConfig.length
        ? 'Server reachable, but it is missing configuration: ' + h.missingConfig.join(', ')
        : 'Saved. Server reachable and configured. Open the panel on any SPP page.';
    } catch (e) { $('msg').textContent = 'Saved, but the server could not be reached: ' + e.message; }
  });
})();
