// Tab pick + load wait.

export class BridgeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function isWeb(tab) {
  return !!(tab && tab.url && /^(https?|file):/i.test(tab.url));
}

export function tabInfo(tab) {
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    windowId: tab.windowId,
    groupId: tab.groupId,
    status: tab.status
  };
}

// ---- agent window ----------------------------------------------------------
// Like Claude in Chrome: the bridge works in its own unfocused window + tab group,
// so it never steals the user's active tab, window focus, mouse or keyboard.

const AGENT_KEY = 'agentWindowId';
const GROUP_TITLE = 'Bridge';

async function storedWindowId() {
  try {
    const got = await chrome.storage.local.get(AGENT_KEY);
    const id = got[AGENT_KEY];
    if (id == null) return null;
    await chrome.windows.get(id);
    return id;
  } catch (_) {
    return null;
  }
}

export async function agentWindowId() {
  return storedWindowId();
}

async function groupTab(tab) {
  try {
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId, title: GROUP_TITLE });
    if (groups.length) {
      await chrome.tabs.group({ groupId: groups[0].id, tabIds: [tab.id] });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'blue' });
    }
  } catch (_) {}
}

// Open url in the agent window (created unfocused on first use). Never focuses it.
export async function openAgentTab(url) {
  let userWin = null;
  try { userWin = (await chrome.windows.getLastFocused()).id; } catch (_) {}
  const tab = await openAgentTabRaw(url);
  // Chrome may raise the window on tab create/activate; hand focus back to the user.
  try {
    const now = (await chrome.windows.getLastFocused()).id;
    if (userWin != null && now !== userWin && userWin !== tab.windowId) {
      await chrome.windows.update(userWin, { focused: true });
    }
  } catch (_) {}
  return tab;
}

async function openAgentTabRaw(url) {
  let windowId = await storedWindowId();
  let tab;
  if (windowId == null) {
    const win = await chrome.windows.create({ url, focused: false, state: 'normal' });
    windowId = win.id;
    await chrome.storage.local.set({ [AGENT_KEY]: windowId });
    tab = win.tabs && win.tabs[0] ? win.tabs[0] : (await chrome.tabs.query({ windowId }))[0];
  } else {
    // active within its own window keeps the page visible (not throttled); window stays unfocused.
    tab = await chrome.tabs.create({ windowId, url, active: false });
    await chrome.tabs.update(tab.id, { active: true });
  }
  await groupTab(tab);
  return tab;
}

export async function isAgentTab(tab) {
  const id = await storedWindowId();
  return id != null && tab.windowId === id;
}

export async function resolveTab(target = {}) {
  if (target.tabId != null) {
    try {
      return await chrome.tabs.get(Number(target.tabId));
    } catch (_) {
      throw new BridgeError(`No tab with id ${target.tabId}`, 'NO_TAB');
    }
  }

  const tabs = await chrome.tabs.query({});
  let lastWinId = null;
  try {
    lastWinId = (await chrome.windows.getLastFocused()).id;
  } catch (_) {}
  const agentWin = await storedWindowId();

  // Agent-window tabs first, so commands never land on the tab the user is working in by accident.
  const prefer = (list) => list.find((t) => t.active && t.windowId === agentWin)
    || list.find((t) => t.windowId === agentWin)
    || list.find((t) => t.active && t.windowId === lastWinId)
    || list.find((t) => t.active)
    || list.find((t) => t.windowId === lastWinId)
    || list[0];

  if (target.url) {
    const needle = String(target.url).toLowerCase();
    const matches = tabs.filter((t) => t.url && t.url.toLowerCase().includes(needle));
    if (!matches.length) throw new BridgeError(`No tab matching url "${target.url}"`, 'NO_TAB');
    return prefer(matches);
  }

  const webs = tabs.filter(isWeb);
  if (!webs.length) throw new BridgeError('No scriptable tab', 'NO_TAB');
  return prefer(webs);
}

function urlMatches(tab, urlIncludes) {
  if (!urlIncludes) return true;
  const hint = String(urlIncludes).toLowerCase();
  const url = (tab.url || '').toLowerCase();
  return url.includes(hint) || url.includes(hint.replace(/^https?:\/\//, ''));
}

// skipInitial: ignore the already-complete state (navigate / reload).
// Resolves on the next complete load. urlIncludes required when the old URL
// would otherwise look done; redirects still resolve once loading finishes.
export function waitForTabComplete(tabId, timeoutMs = 30000, { urlIncludes, skipInitial = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sawLoading = false;

    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    const succeed = (tab) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(tab);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      const err = new BridgeError(`Timed out waiting for tab ${tabId} to load`, 'TIMEOUT');
      fail(err);
    }, timeoutMs);

    function consider(tab) {
      if (!tab || tab.status !== 'complete') return;
      if (skipInitial && !sawLoading) return;
      if (!urlIncludes || urlMatches(tab, urlIncludes)) {
        succeed(tab);
        return;
      }
      // Navigation finished on a redirected URL.
      if (sawLoading && !tab.pendingUrl) succeed(tab);
    }

    function onUpdated(id, info, tab) {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete') consider(tab);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);

    if (!skipInitial) {
      chrome.tabs.get(tabId).then((tab) => consider(tab)).catch(fail);
    }
  });
}
