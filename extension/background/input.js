// Trusted input + capture via Chrome DevTools Protocol (chrome.debugger).
// Pages that ignore synthetic (isTrusted=false) events accept these, and none of it needs
// the tab to be active or the window focused, so the user keeps using the browser.

import { BridgeError } from './tabs.js';

const PROTOCOL = '1.3';
// Stay attached between calls (one "being debugged" bar instead of one per click).
const IDLE_DETACH_MS = 60000;

const sessions = new Map(); // tabId -> { timer }

function forget(tabId) {
  const s = sessions.get(tabId);
  if (s) clearTimeout(s.timer);
  sessions.delete(tabId);
}

function armIdle(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => detachDebugger(tabId), IDLE_DETACH_MS);
}

async function attach(tabId) {
  if (sessions.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  } catch (err) {
    if (!/already attached/i.test(err.message || '')) {
      throw new BridgeError(`debugger attach failed: ${err.message}`, 'DEBUGGER_FAILED');
    }
  }
  sessions.set(tabId, { timer: null });
  // Unfocused tab still behaves as focused (focus/blur-sensitive apps, caret, menus).
  try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (_) {}
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) forget(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => forget(tabId));

async function withDebugger(tabId, fn) {
  await attach(tabId);
  try {
    return await fn((method, params) => chrome.debugger.sendCommand({ tabId }, method, params || {}));
  } finally {
    armIdle(tabId);
  }
}

export async function detachDebugger(tabId) {
  forget(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

export async function trustedMove(tabId, x, y) {
  return withDebugger(tabId, async (send) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return { moved: true, x, y };
  });
}

export async function trustedClick(tabId, x, y, { button = 'left', clickCount = 1 } = {}) {
  return withDebugger(tabId, async (send) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
    return { clicked: true, x, y, button };
  });
}

export async function trustedInsertText(tabId, text) {
  return withDebugger(tabId, async (send) => {
    await send('Input.insertText', { text });
    return { inserted: true, length: text.length };
  });
}

export async function trustedKey(tabId, key) {
  const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46 };
  const keyCode = codes[key] || 0;
  return withDebugger(tabId, async (send) => {
    const base = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (key === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return { pressed: key };
  });
}

// Screenshot without activating the tab or focusing its window.
export async function captureScreenshot(tabId, { format = 'jpeg', quality = 80 } = {}) {
  return withDebugger(tabId, async (send) => {
    const params = { format, fromSurface: true };
    if (format === 'jpeg') params.quality = quality;
    const res = await send('Page.captureScreenshot', params);
    if (!res || !res.data) throw new BridgeError('Page.captureScreenshot returned empty', 'CAPTURE_FAILED');
    return { dataUrl: `data:image/${format};base64,${res.data}`, format };
  });
}
