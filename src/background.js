// Service worker: toggles capture when the toolbar icon is clicked and relays
// detection results from the offscreen document to the overlay in the tab.

const OFFSCREEN_URL = 'offscreen.html';

async function getActiveTabId() {
  const { tabId } = await chrome.storage.session.get('tabId');
  return tabId ?? null;
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Analyze tab audio to detect the chords being played.',
  });
}

async function injectOverlay(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function overlayAlive(tabId) {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: 'chordit:ping' })) === 'pong';
  } catch {
    return false;
  }
}

function setBadge(tabId, text, color = '#16a34a') {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

async function start(tabId) {
  // Grab the stream id first: it is tied to this icon click and expires quickly.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  await injectOverlay(tabId);
  const { delayMs = 0 } = await chrome.storage.local.get('delayMs');
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, tabId, delayMs });
  if (!res?.ok) throw new Error(res?.error || 'Audio capture failed');
  await chrome.storage.session.set({ tabId });
  setBadge(tabId, 'ON');
}

async function stop() {
  const tabId = await getActiveTabId();
  await chrome.storage.session.remove('tabId');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  if (tabId != null) {
    setBadge(tabId, '');
    chrome.tabs.sendMessage(tabId, { type: 'chordit:close' }).catch(() => {});
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  const activeTabId = await getActiveTabId();
  try {
    if (activeTabId === tab.id) {
      // A page reload wipes the overlay while capture keeps running; restore it
      // instead of stopping.
      if (await overlayAlive(tab.id)) await stop();
      else await injectOverlay(tab.id);
      return;
    }
    if (activeTabId != null) await stop();
    await start(tab.id);
  } catch (err) {
    console.error('ChordIt:', err);
    await stop();
    setBadge(tab.id, 'ERR', '#dc2626');
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.target !== 'background') return;
  switch (msg.type) {
    case 'update':
      chrome.tabs.sendMessage(msg.tabId, { type: 'chordit:update', data: msg.data }).catch(() => {});
      break;
    case 'ended':
      stop();
      break;
    case 'stop':
      // Sent by the overlay's close button.
      getActiveTabId().then((id) => { if (id === sender.tab?.id) stop(); });
      break;
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getActiveTabId()) === tabId) stop();
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete' || (await getActiveTabId()) !== tabId) return;
  // Re-show the overlay after a reload; this fails silently if the tab moved to
  // another site (activeTab no longer applies) until the icon is clicked again.
  if (!(await overlayAlive(tabId))) injectOverlay(tabId).catch(() => {});
  setBadge(tabId, 'ON');
});
