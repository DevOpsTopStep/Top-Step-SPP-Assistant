// Service worker: open the side panel from the toolbar button, only enable it
// on SuiteProjects Pro tabs, and add a right-click "Ask SPP Assistant" item.
const SPP_RE = /^https:\/\/[^/]*\.(netsuitesuiteprojectspro\.com|openair\.com)\//;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.create({
    id: 'ask-spp-assistant',
    title: 'Ask SPP Assistant about "%s"',
    contexts: ['selection'],
    documentUrlPatterns: ['https://*.netsuitesuiteprojectspro.com/*', 'https://*.openair.com/*'],
  });
});

async function syncPanel(tabId, url) {
  if (!url) return;
  await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: SPP_RE.test(url) }).catch(() => {});
}
chrome.tabs.onUpdated.addListener((tabId, info, tab) => { if (info.url || info.status === 'complete') syncPanel(tabId, tab.url); });
chrome.tabs.onActivated.addListener(async ({ tabId }) => { const t = await chrome.tabs.get(tabId); syncPanel(tabId, t.url); });

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ask-spp-assistant' || !tab) return;
  await chrome.sidePanel.open({ tabId: tab.id });
  // Let the panel load, then hand it the selection.
  await chrome.storage.session.set({ pendingPrompt: `About this from the page:\n"""\n${info.selectionText}\n"""\n` });
});
