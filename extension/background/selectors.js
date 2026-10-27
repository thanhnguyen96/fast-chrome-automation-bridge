// Selector dictionary files, owned by bridge_server.js. In-memory cache per domain.

import { BridgeError } from './tabs.js';

const BASE = 'http://127.0.0.1:8765';
const cache = new Map();

export function invalidateSelectors(domain) {
  if (domain) cache.delete(domain);
  else cache.clear();
}

export async function getSelectors(domain) {
  if (cache.has(domain)) return cache.get(domain);
  try {
    const res = await fetch(`${BASE}/api/selectors/${encodeURIComponent(domain)}`);
    if (res.ok) {
      const body = await res.json();
      const data = (body && body.data) || {};
      cache.set(domain, data);
      return data;
    }
  } catch (_) {
    // Server unreachable: empty dict, not cached, so a later call can retry.
  }
  return {};
}

export async function saveSelectors(domain, { merge, remove } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api/selectors/${encodeURIComponent(domain)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge: merge || {}, remove: remove || [] })
    });
  } catch (err) {
    throw new BridgeError(`Selector server unreachable: ${err.message}`, 'SELECTORS_OFFLINE');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok !== true) {
    const message = body && body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
    throw new BridgeError(message, (body && body.error && body.error.code) || 'SELECTORS_FAILED');
  }
  cache.set(domain, body.data || {});
  return body.data || {};
}
