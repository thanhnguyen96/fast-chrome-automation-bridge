// Track completed downloads and push download_complete events.

import { send } from './connection.js';

const recent = [];
const waiters = new Set();

function record(item) {
  const row = { time: Date.now(), item };
  recent.push(row);
  if (recent.length > 50) recent.shift();
  for (const fn of waiters) fn(row);
  send({ type: 'event', event: 'download_complete', data: item });
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || delta.state.current !== 'complete') return;
  chrome.downloads.search({ id: delta.id }, (results) => {
    const item = results && results[0];
    if (!item) return;
    record({
      id: item.id,
      filename: item.filename,
      fileSize: item.fileSize,
      mime: item.mime,
      url: item.url,
      endTime: item.endTime
    });
  });
});

function matchRow(row, sinceMs, regex) {
  if (row.time < sinceMs) return false;
  if (regex && !regex.test(row.item.filename || '')) return false;
  return true;
}

export function registerDownloadCommands(register) {
  register('downloads.wait', (payload) => {
    const timeoutMs = payload.timeoutMs ?? 120000;
    const sinceMs = payload.sinceMs ?? Date.now();
    let regex = null;
    if (payload.filenameRegex) {
      try {
        regex = new RegExp(payload.filenameRegex, 'i');
      } catch (err) {
        const bad = new Error(`Bad filenameRegex: ${err.message}`);
        bad.code = 'BAD_REQUEST';
        return Promise.reject(bad);
      }
    }
    const found = recent.find((row) => matchRow(row, sinceMs, regex));
    if (found) return Promise.resolve(found.item);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(onRow);
        const err = new Error('Timed out waiting for download');
        err.code = 'TIMEOUT';
        reject(err);
      }, timeoutMs);

      function onRow(row) {
        if (!matchRow(row, sinceMs, regex)) return;
        clearTimeout(timer);
        waiters.delete(onRow);
        resolve(row.item);
      }

      waiters.add(onRow);
    });
  });
}
