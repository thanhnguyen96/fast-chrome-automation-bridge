// Inject core + matching site modules when a tab has no content script yet.

import { matchingSiteFiles } from './sites.js';
import { BridgeError } from './tabs.js';

const CORE_FILES = ['content/core.js', 'content/router.js'];

function ping(tabId) {
  const attempt = chrome.tabs.sendMessage(tabId, { action: '__ping' })
    .then((res) => !!(res && res.ok))
    .catch(() => false);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 2000));
  return Promise.race([attempt, timeout]);
}

export async function ensureInjected(tab) {
  const url = tab.url || '';
  if (!/^(https?|file):/i.test(url)) {
    throw new BridgeError(`Cannot inject into ${url || 'tab ' + tab.id}`, 'UNSCRIPTABLE_TAB');
  }
  if (await ping(tab.id)) return;

  const files = CORE_FILES.concat(matchingSiteFiles(url));
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
  } catch (err) {
    throw new BridgeError(`Inject failed (${url}): ${err.message}`, 'INJECT_FAILED');
  }
  if (!(await ping(tab.id))) {
    throw new BridgeError('Content script did not respond after inject', 'INJECT_FAILED');
  }
}
