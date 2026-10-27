// WebSocket client. One socket, exponential backoff, no stacked timers.

import { dispatch } from './commands.js';

export const BRIDGE_URL = 'ws://127.0.0.1:8765';

let socket = null;
let backoffMs = 1000;
let reconnectTimer = null;
let pingTimer = null;

export function isOpen() {
  return !!(socket && socket.readyState === WebSocket.OPEN);
}

export function send(obj) {
  if (!isOpen()) return false;
  socket.send(JSON.stringify(obj));
  return true;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, 10000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

export function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  let ws;
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (err) {
    console.debug('[bridge] ws construct failed', err && err.message);
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    if (socket !== ws) return;
    backoffMs = 1000;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), 20000);
    const version = chrome.runtime.getManifest().version;
    send({ type: 'event', event: 'hello', data: { version, ua: navigator.userAgent } });
    console.log('[bridge] connected', BRIDGE_URL);
  };

  ws.onmessage = async (event) => {
    if (socket !== ws) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    if (message.type === 'ping') {
      send({ type: 'pong' });
      return;
    }
    if (message.type === 'pong' || message.type === 'event') return;
    if (message.id == null || !message.command) return;
    const response = await dispatch(message);
    send(response);
  };

  ws.onerror = () => {
    console.debug('[bridge] ws error');
  };

  ws.onclose = () => {
    if (socket !== ws) return;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    socket = null;
    console.log('[bridge] disconnected, retry in', backoffMs, 'ms');
    scheduleReconnect();
  };
}

export function startKeepAlive() {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepalive' && !isOpen()) connect();
  });
}
