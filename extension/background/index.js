// Service worker entry. Registers commands, then connects.

import { connect, send, startKeepAlive } from './connection.js';
import { register } from './commands.js';
import { resolveTab, waitForTabComplete, tabInfo, BridgeError, openAgentTab, agentWindowId } from './tabs.js';
import { ensureInjected } from './inject.js';
import { registerDownloadCommands } from './downloads.js';
import { trustedClick, trustedInsertText, trustedKey, trustedShortcut, trustedMove, captureScreenshot, detachDebugger, keepAlive, evaluate } from './input.js';
import { getSelectors, saveSelectors } from './selectors.js';

const CONTENT_ACTIONS = {
  'dom.query': 'dom.query',
  'dom.read': 'dom.read',
  'dom.exists': 'dom.exists',
  'dom.waitFor': 'dom.waitFor',
  'dom.click': 'dom.click',
  'dom.locate': 'dom.locate',
  'dom.rightClick': 'dom.rightClick',
  'dom.type': 'dom.type',
  'dom.press': 'dom.press',
  'dom.scroll': 'dom.scroll',
  'workflow.run': 'workflow.run',
  'workflow.list': 'workflow.list',
  'el.click': 'el.click',
  'el.rightClick': 'el.rightClick',
  'el.type': 'el.type',
  'el.press': 'el.press',
  'el.hover': 'el.hover',
  'el.waitAppear': 'el.waitAppear',
  'el.waitDisappear': 'el.waitDisappear',
  'el.waitEnabled': 'el.waitEnabled',
  'el.waitText': 'el.waitText',
  'el.waitCount': 'el.waitCount',
  'el.text': 'el.text',
  'el.attr': 'el.attr',
  'el.count': 'el.count',
  'el.clickMenu': 'el.clickMenu',
  'el.waitNew': 'el.waitNew',
  'sel.test': 'sel.test',
  'sel.sync': 'sel.sync'
};

function normalizePayload(payload) {
  const next = { ...payload };
  if (typeof next.selector === 'string' && next.locator == null) {
    next.locator = { css: next.selector };
  }
  return next;
}

async function forwardToContent(command, payload) {
  const tab = await resolveTab(payload.target || {});
  await ensureInjected(tab);
  const action = CONTENT_ACTIONS[command];
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { action, payload: normalizePayload(payload) });
  } catch (err) {
    throw new BridgeError(err.message || String(err), 'CONTENT_ERROR');
  }
  if (!res || res.ok !== true) {
    const message = res && res.error && res.error.message ? res.error.message : 'Empty content response';
    const code = res && res.error && res.error.code ? res.error.code : 'CONTENT_ERROR';
    throw new BridgeError(message, code);
  }
  return res.data;
}

function contentCommand(name) {
  register(name, (payload) => forwardToContent(name, payload));
}

register('ext.ping', async () => ({
  version: chrome.runtime.getManifest().version,
  time: Date.now()
}));

register('ext.reload', async () => {
  setTimeout(() => chrome.runtime.reload(), 200);
  return { reloading: true };
});

register('tabs.list', async () => {
  const tabs = await chrome.tabs.query({});
  return tabs.map(tabInfo);
});

// Default: agent window (background, no focus steal). foreground:true opens in the user's window.
register('tabs.open', async (payload) => {
  const url = payload.url || 'about:blank';
  const tab = payload.foreground
    ? await chrome.tabs.create({ url, active: payload.active !== false })
    : await openAgentTab(url);
  if (payload.wait !== false && payload.url) {
    await waitForTabComplete(tab.id, payload.timeoutMs || 30000, { urlIncludes: payload.url });
  }
  // Agent tabs run unattended: keep them unfrozen from the start (opt out with keepAlive:false).
  if (!payload.foreground && payload.keepAlive !== false) {
    try { await keepAlive(tab.id); } catch (_) {}
  }
  const fresh = await chrome.tabs.get(tab.id);
  return { tabId: fresh.id, url: fresh.url, windowId: fresh.windowId, agent: !payload.foreground };
});

// Move an existing tab (e.g. one the user opened) into the agent window.
register('tabs.adopt', async (payload) => {
  const tab = await resolveTab(payload.target || {});
  let windowId = await agentWindowId();
  if (windowId == null) {
    const opened = await openAgentTab('about:blank');
    windowId = opened.windowId;
    await chrome.tabs.move(tab.id, { windowId, index: -1 });
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.tabs.remove(opened.id);
  } else {
    await chrome.tabs.move(tab.id, { windowId, index: -1 });
    await chrome.tabs.update(tab.id, { active: true });
  }
  const fresh = await chrome.tabs.get(tab.id);
  return tabInfo(fresh);
});

register('agent.window', async () => {
  const windowId = await agentWindowId();
  const tabs = windowId == null ? [] : await chrome.tabs.query({ windowId });
  let focusedWindowId = null;
  try { focusedWindowId = (await chrome.windows.getLastFocused()).id; } catch (_) {}
  return { windowId, focusedWindowId, tabs: tabs.map(tabInfo) };
});

register('agent.release', async (payload) => {
  const tab = await resolveTab(payload.target || {});
  await detachDebugger(tab.id);
  return { detached: true, tabId: tab.id };
});

register('tabs.navigate', async (payload) => {
  if (!payload.url) throw new BridgeError('url required', 'BAD_REQUEST');
  const tab = await resolveTab(payload.target || {});
  const wait = payload.wait !== false;
  const pending = wait
    ? waitForTabComplete(tab.id, payload.timeoutMs || 30000, { urlIncludes: payload.url, skipInitial: true })
    : null;
  await chrome.tabs.update(tab.id, { url: payload.url });
  if (!wait) return { tabId: tab.id, url: payload.url };
  const done = await pending;
  return { tabId: done.id, url: done.url };
});

// Activates the tab inside its own window only. Raising the window is opt-in (focus:true).
register('tabs.activate', async (payload) => {
  const tab = await resolveTab(payload.target || {});
  await chrome.tabs.update(tab.id, { active: true });
  if (payload.focus === true && tab.windowId != null) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
  }
  return tabInfo(await chrome.tabs.get(tab.id));
});

// Attach CDP so the tab keeps running at full speed in the background (no freeze, focus emulated).
register('agent.keepAlive', async (payload) => {
  const tab = await resolveTab(payload.target || {});
  await keepAlive(tab.id);
  return { tabId: tab.id, lifecycle: 'active' };
});

register('tabs.close', async (payload) => {
  const tab = await resolveTab(payload.target || {});
  await chrome.tabs.remove(tab.id);
  return { closed: true, tabId: tab.id };
});

register('tabs.reload', async (payload) => {
  const tab = await resolveTab(payload.target || {});
  const wait = payload.wait !== false;
  const pending = wait
    ? waitForTabComplete(tab.id, payload.timeoutMs || 30000, { skipInitial: true })
    : null;
  await chrome.tabs.reload(tab.id);
  if (pending) await pending;
  return { tabId: tab.id };
});

register('page.screenshot', async (payload) => {
  const tab = await resolveTab(payload.target || {});
  const format = payload.format === 'png' ? 'png' : 'jpeg';
  const quality = typeof payload.quality === 'number' ? payload.quality : 80;
  // CDP capture: no tab switch, no window focus.
  if (!payload.activate) return captureScreenshot(tab.id, { format, quality: Math.max(0, Math.min(100, quality)) });
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
  }
  const options = { format };
  if (format === 'jpeg') options.quality = Math.max(0, Math.min(100, quality));
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, options);
  if (!dataUrl) throw new BridgeError('captureVisibleTab returned empty', 'CAPTURE_FAILED');
  return { dataUrl, format };
});

contentCommand('dom.query');
contentCommand('dom.read');
contentCommand('dom.exists');
contentCommand('dom.waitFor');
contentCommand('dom.click');
contentCommand('dom.rightClick');
contentCommand('dom.type');
contentCommand('dom.press');
contentCommand('dom.scroll');
contentCommand('workflow.run');
contentCommand('workflow.list');
contentCommand('dom.locate');

for (const elName of [
  'el.click', 'el.rightClick', 'el.type', 'el.press', 'el.hover',
  'el.waitAppear', 'el.waitDisappear', 'el.waitEnabled', 'el.waitText', 'el.waitCount',
  'el.text', 'el.attr', 'el.count', 'el.clickMenu', 'el.waitNew'
]) {
  contentCommand(elName);
}

// Domain of a selector file: explicit payload.domain, else the target tab's hostname.
// file:// pages have no hostname and share the "_file" domain.
async function domainOf(payload) {
  if (payload.domain) return String(payload.domain);
  const tab = await resolveTab(payload.target || {});
  let host = '';
  try { host = new URL(tab.url || '').hostname; } catch (_) {}
  return host || '_file';
}

register('sel.list', async (payload) => {
  const domain = await domainOf(payload);
  return { domain, data: await getSelectors(domain) };
});

// Push the file just written into an already-open page, whose dict was loaded earlier.
async function syncTab(payload) {
  if (!payload.target && !payload.test) return;
  try {
    const tab = await resolveTab(payload.target || {});
    await forwardToContent('sel.sync', { target: { tabId: tab.id } });
  } catch (_) {}
}

register('sel.add', async (payload) => {
  const entries = payload.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new BridgeError('entries object required', 'BAD_REQUEST');
  }
  const domain = await domainOf(payload);
  const names = Object.keys(entries);
  let tested = null;
  if (payload.test) {
    const tab = await resolveTab(payload.target || {});
    // Entries are not in the page dict yet; test them as an overlay, then save.
    tested = await forwardToContent('sel.test', { names, entries, target: { tabId: tab.id } });
    if (payload.strict && tested.some((row) => row.count === 0 || row.error)) {
      return { domain, saved: false, results: tested };
    }
  }
  const saved = payload.persist !== false;
  const data = saved ? await saveSelectors(domain, { merge: entries }) : null;
  if (saved) await syncTab(payload);
  return { domain, saved, results: tested, data };
});

register('sel.remove', async (payload) => {
  const names = payload.names;
  if (!Array.isArray(names)) throw new BridgeError('names array required', 'BAD_REQUEST');
  const domain = await domainOf(payload);
  const data = await saveSelectors(domain, { remove: names });
  await syncTab(payload);
  return { domain, data };
});

register('sel.test', async (payload) => {
  const tab = await resolveTab(payload.target || {});
  const results = await forwardToContent('sel.test', { names: payload.names, target: { tabId: tab.id } });
  return { domain: await domainOf(payload), results };
});

// Trusted input (CDP). Use when a page ignores synthetic events.
async function locateTrusted(payload) {
  const tab = await resolveTab(payload.target || {});
  const pos = payload.locator != null
    ? await forwardToContent('dom.locate', { ...payload, target: { tabId: tab.id } })
    : null;
  return { tab, pos };
}

register('input.click', async (payload) => {
  const { tab, pos } = await locateTrusted(payload);
  const x = pos ? pos.x : payload.x;
  const y = pos ? pos.y : payload.y;
  if (x == null || y == null) throw new BridgeError('locator or x/y required', 'BAD_REQUEST');
  return trustedClick(tab.id, x, y, { button: payload.button || 'left' });
});

register('input.type', async (payload) => {
  const { tab } = await locateTrusted({ ...payload, focus: true });
  if (payload.clear !== false && payload.locator != null) {
    await forwardToContent('dom.type', { ...payload, value: '', target: { tabId: tab.id } });
  }
  const res = await trustedInsertText(tab.id, String(payload.value ?? ''));
  if (payload.submit) await trustedKey(tab.id, 'Enter');
  return res;
});

register('input.press', async (payload) => {
  const { tab } = await locateTrusted({ ...payload, focus: true });
  if (!payload.key) throw new BridgeError('key required', 'BAD_REQUEST');
  return trustedKey(tab.id, payload.key);
});

// Page-level shortcut ("Control+A") sent to the tab as trusted CDP key events; no element focus.
register('input.shortcut', async (payload) => {
  if (!payload.keys) throw new BridgeError('keys required, e.g. "Control+A"', 'BAD_REQUEST');
  const tab = await resolveTab(payload.target || {});
  return trustedShortcut(tab.id, payload.keys);
});

registerDownloadCommands(register);

// Run JS in the page main world via CDP. payload: { expression, timeoutMs }.
register('page.eval', async (payload) => {
  if (!payload.expression) throw new BridgeError('expression required', 'BAD_REQUEST');
  const tab = await resolveTab(payload.target || {});
  return evaluate(tab.id, String(payload.expression), payload.timeoutMs || 30000);
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  send({
    type: 'event',
    event: 'tab_updated',
    data: { tabId, url: tab.url, title: tab.title, status: 'complete' }
  });
});

// Content scripts request trusted input or the selector dictionary.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab) return;
  if (msg.type === 'selectors_get') {
    const domain = msg.domain || '_file';
    getSelectors(domain)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: { message: err.message, code: 'SELECTORS_FAILED' } }));
    return true;
  }
  if (msg.type !== 'trusted_input') return;
  const tabId = sender.tab.id;
  const run = msg.kind === 'key'
    ? trustedKey(tabId, msg.key)
    : msg.kind === 'text'
      ? trustedInsertText(tabId, msg.text)
      : msg.kind === 'move'
        ? trustedMove(tabId, msg.x, msg.y)
        : trustedClick(tabId, msg.x, msg.y, { button: msg.button || 'left' });
  run.then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: { message: err.message, code: err.code || 'TRUSTED_INPUT_FAILED' } }));
  return true;
});

startKeepAlive();
connect();
