// Local HTTP + WebSocket bridge. Node built-ins only. Binds 127.0.0.1.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.BRIDGE_PORT || 8765);
const HOST = '127.0.0.1';
const MAX_FRAME = 16 * 1024 * 1024;
const MAX_BODY = 1024 * 1024;
const MAX_EVENTS = 200;

const SELECTORS_DIR = path.join(__dirname, 'selectors');
// Underscore so the file:// domain "_file" is legal. ".." still rejected below.
const DOMAIN_RE = /^[a-z0-9._-]+$/;

const startedAt = Date.now();
let extensionSocket = null;
let extensionVersion = null;
let requestId = 0;
const pending = new Map();
const events = [];
let eventSeq = 0;
const eventWaiters = [];

function log(...args) {
  console.log('[bridge]', ...args);
}

function createFrame(opcode, payload, fin = true) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const first = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  let header;
  if (buf.length <= 125) {
    header = Buffer.from([first, buf.length]);
  } else if (buf.length <= 65535) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(buf.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(buf.length), 2);
  }
  return Buffer.concat([header, buf]);
}

function closePayload(code, reason) {
  const why = Buffer.from(reason || '');
  const out = Buffer.alloc(2 + why.length);
  out.writeUInt16BE(code, 0);
  why.copy(out, 2);
  return out;
}

function sendJson(socket, obj) {
  if (!socket || socket.destroyed) return false;
  try {
    socket.write(createFrame(1, JSON.stringify(obj)));
    return true;
  } catch (_) {
    return false;
  }
}

function parseWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let header = 2;

    if (len === 126) {
      if (buffer.length < offset + 4) break;
      len = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (len === 127) {
      if (buffer.length < offset + 10) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      if (big > BigInt(MAX_FRAME)) return { error: 'FRAME_TOO_LARGE', frames, remainder: Buffer.alloc(0) };
      len = Number(big);
      header = 10;
    }

    if (len > MAX_FRAME) return { error: 'FRAME_TOO_LARGE', frames, remainder: Buffer.alloc(0) };
    const maskLen = masked ? 4 : 0;
    const total = header + maskLen + len;
    if (buffer.length < offset + total) break;

    let payload = buffer.slice(offset + header + maskLen, offset + total);
    if (masked) {
      const key = buffer.slice(offset + header, offset + header + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
    }
    frames.push({ fin, opcode, payload });
    offset += total;
  }
  return { frames, remainder: buffer.slice(offset) };
}

function pushEvent(event, data) {
  eventSeq += 1;
  const row = { seq: eventSeq, time: Date.now(), event, data };
  events.push(row);
  if (events.length > MAX_EVENTS) events.shift();
  const waiters = eventWaiters.splice(0);
  for (const waiter of waiters) waiter();
  return row;
}

function eventsSince(since) {
  return events.filter((row) => row.seq > since);
}

function failPending(code, message) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    const err = new Error(message);
    err.code = code;
    entry.reject(err);
  }
}

// selectors/<domain>.json. Pretty, 2 spaces, keys sorted. _meta kept but sorted with the rest.
function selectorFile(domain) {
  if (typeof domain !== 'string' || !DOMAIN_RE.test(domain) || domain.includes('..')) return null;
  return path.join(SELECTORS_DIR, domain + '.json');
}

function readDict(domain) {
  const file = selectorFile(domain);
  if (!file) {
    const err = new Error(`Bad domain: ${domain}`);
    err.code = 'BAD_REQUEST';
    throw err;
  }
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err) {
    const bad = new Error(`Bad selector file for ${domain}: ${err.message}`);
    bad.code = 'BAD_REQUEST';
    throw bad;
  }
}

function writeDict(domain, data) {
  const file = selectorFile(domain);
  fs.mkdirSync(SELECTORS_DIR, { recursive: true });
  const sorted = {};
  for (const key of Object.keys(data).sort()) sorted[key] = data[key];
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n');
  return sorted;
}

function statusCodeFor(code) {
  if (code === 'TIMEOUT') return 504;
  if (code === 'BAD_REQUEST') return 400;
  if (code === 'EXTENSION_OFFLINE' || code === 'EXTENSION_DISCONNECTED') return 503;
  return 500;
}

function reply(res, status, obj) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        failed = true;
        const err = new Error('Body exceeds 1MB');
        err.code = 'BAD_REQUEST';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

function sendCommand(id, command, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.destroyed) {
      const err = new Error('Extension offline');
      err.code = 'EXTENSION_OFFLINE';
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(id);
      const err = new Error(`Command timed out after ${timeoutMs}ms`);
      err.code = 'TIMEOUT';
      reject(err);
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const ok = sendJson(extensionSocket, { id, command, payload });
    if (!ok) {
      clearTimeout(timer);
      pending.delete(id);
      const err = new Error('Extension offline');
      err.code = 'EXTENSION_OFFLINE';
      reject(err);
    }
  });
}

function settle(msg) {
  if (msg.id == null || !pending.has(msg.id)) return;
  const entry = pending.get(msg.id);
  clearTimeout(entry.timer);
  pending.delete(msg.id);
  if (msg.ok === true) {
    entry.resolve(msg.data);
    return;
  }
  if (msg.ok === false || msg.error) {
    const errBody = msg.error;
    const message = typeof errBody === 'string' ? errBody : (errBody && errBody.message) || 'Command failed';
    const code = errBody && typeof errBody === 'object' && errBody.code ? errBody.code : 'COMMAND_FAILED';
    const err = new Error(message);
    err.code = code;
    entry.reject(err);
  }
}

function onTextMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (err) {
    log('bad json from extension:', err.message);
    return;
  }
  if (msg.type === 'ping') {
    sendJson(extensionSocket, { type: 'pong' });
    return;
  }
  if (msg.type === 'pong') return;
  if (msg.type === 'event') {
    if (msg.event === 'hello' && msg.data && msg.data.version) extensionVersion = String(msg.data.version);
    pushEvent(msg.event || 'event', msg.data);
    return;
  }
  if (msg.id != null) settle(msg);
}

function attachSocket(socket) {
  // Two Chrome profiles with the extension would replace each other every second.
  // BRIDGE_KEEP_FIRST=1 keeps the live connection and turns newcomers away instead.
  if (process.env.BRIDGE_KEEP_FIRST && extensionSocket && !extensionSocket.destroyed) {
    try { socket.write(createFrame(8, closePayload(1013, 'busy'))); } catch (_) {}
    socket.destroy();
    return;
  }
  const previous = extensionSocket;
  extensionSocket = socket;
  extensionVersion = null;
  if (previous && previous !== socket) {
    try { previous.write(createFrame(8, closePayload(1000, 'replaced'))); } catch (_) {}
    previous.destroy();
  }

  let rx = Buffer.alloc(0);
  let fragOpcode = null;
  const fragParts = [];

  log('extension connected');

  // BRIDGE_WANT_TAB=<text>: drop a profile whose tabs do not contain <text> (e.g. flow.google.com/project).
  if (process.env.BRIDGE_WANT_TAB) {
    sendCommand(++requestId, 'tabs.list', {}, 5000).then((tabs) => {
      if (extensionSocket !== socket) return;
      if (!JSON.stringify(tabs || []).includes(process.env.BRIDGE_WANT_TAB)) {
        log('profile without wanted tab, dropped');
        try { socket.write(createFrame(8, closePayload(1013, 'unwanted'))); } catch (_) {}
        socket.destroy();
      } else log('wanted profile attached');
    }).catch(() => {});
  }

  function closeSocket(code, reason) {
    try { socket.write(createFrame(8, closePayload(code, reason))); } catch (_) {}
    socket.destroy();
  }

  function takeMessage(opcode, payload) {
    if (opcode === 1 || opcode === 2) onTextMessage(payload.toString('utf8'));
  }

  socket.on('data', (chunk) => {
    rx = Buffer.concat([rx, chunk]);
    const parsed = parseWsFrames(rx);
    if (parsed.error) {
      log('frame rejected:', parsed.error);
      closeSocket(1009, parsed.error);
      return;
    }
    rx = parsed.remainder;
    for (const frame of parsed.frames) {
      if (frame.opcode === 8) {
        closeSocket(1000, 'bye');
        return;
      }
      if (frame.opcode === 9) {
        try { socket.write(createFrame(10, frame.payload)); } catch (_) {}
        continue;
      }
      if (frame.opcode === 10) continue;
      if (frame.opcode === 1 || frame.opcode === 2) {
        if (!frame.fin) {
          fragOpcode = frame.opcode;
          fragParts.length = 0;
          fragParts.push(frame.payload);
          continue;
        }
        takeMessage(frame.opcode, frame.payload);
        continue;
      }
      if (frame.opcode === 0) {
        fragParts.push(frame.payload);
        if (frame.fin) {
          const all = Buffer.concat(fragParts);
          fragParts.length = 0;
          takeMessage(fragOpcode || 1, all);
          fragOpcode = null;
        }
      }
    }
  });

  socket.on('close', () => {
    if (extensionSocket !== socket) return;
    extensionSocket = null;
    extensionVersion = null;
    log('extension disconnected');
    failPending('EXTENSION_DISCONNECTED', 'Extension disconnected');
  });

  socket.on('error', (err) => {
    log('socket error:', err.message);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    reply(res, 204, {});
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch (_) {
    reply(res, 400, { ok: false, error: { message: 'Bad URL', code: 'BAD_REQUEST' } });
    return;
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    const connected = !!(extensionSocket && !extensionSocket.destroyed);
    reply(res, 200, {
      running: true,
      extensionConnected: connected,
      extensionVersion: connected ? extensionVersion : null,
      pending: pending.size,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000)
    });
    return;
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    let waitMs = Number(url.searchParams.get('waitMs') || 0);
    if (!Number.isFinite(waitMs) || waitMs < 0) waitMs = 0;
    if (waitMs > 60000) waitMs = 60000;
    const ready = eventsSince(Number.isFinite(since) ? since : 0);
    if (ready.length || waitMs === 0) {
      reply(res, 200, { events: ready });
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      reply(res, 200, { events: eventsSince(since) });
    };
    const timer = setTimeout(() => {
      const idx = eventWaiters.indexOf(finish);
      if (idx >= 0) eventWaiters.splice(idx, 1);
      finish();
    }, waitMs);
    const waiter = () => {
      clearTimeout(timer);
      finish();
    };
    eventWaiters.push(waiter);
    req.on('close', () => {
      clearTimeout(timer);
      const idx = eventWaiters.indexOf(waiter);
      if (idx >= 0) eventWaiters.splice(idx, 1);
    });
    return;
  }

  const selMatch = url.pathname.match(/^\/api\/selectors\/([^/]+)$/);
  if (selMatch) {
    const domain = decodeURIComponent(selMatch[1]);
    if (!selectorFile(domain)) {
      reply(res, 400, { ok: false, error: { message: `Bad domain: ${domain}`, code: 'BAD_REQUEST' } });
      return;
    }
    if (req.method === 'GET') {
      try {
        reply(res, 200, { ok: true, data: readDict(domain) });
      } catch (err) {
        reply(res, 400, { ok: false, error: { message: err.message, code: err.code || 'BAD_REQUEST' } });
      }
      return;
    }
    if (req.method === 'PUT') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (err) {
        reply(res, 400, { ok: false, error: { message: err.message || 'Bad body', code: 'BAD_REQUEST' } });
        return;
      }
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (_) {
        reply(res, 400, { ok: false, error: { message: 'Invalid JSON', code: 'BAD_REQUEST' } });
        return;
      }
      try {
        const data = readDict(domain);
        const merge = body.merge && typeof body.merge === 'object' && !Array.isArray(body.merge) ? body.merge : {};
        for (const key of Object.keys(merge)) data[key] = merge[key];
        for (const name of Array.isArray(body.remove) ? body.remove : []) delete data[name];
        reply(res, 200, { ok: true, data: writeDict(domain, data) });
      } catch (err) {
        reply(res, 400, { ok: false, error: { message: err.message, code: err.code || 'BAD_REQUEST' } });
      }
      return;
    }
  }

  if (url.pathname === '/api/command' && req.method === 'POST') {
    if (!extensionSocket || extensionSocket.destroyed) {
      reply(res, 503, { ok: false, error: { message: 'Extension offline', code: 'EXTENSION_OFFLINE' } });
      return;
    }
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      reply(res, 400, { ok: false, error: { message: err.message || 'Bad body', code: 'BAD_REQUEST' } });
      return;
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (_) {
      reply(res, 400, { ok: false, error: { message: 'Invalid JSON', code: 'BAD_REQUEST' } });
      return;
    }
    if (!body.command || typeof body.command !== 'string') {
      reply(res, 400, { ok: false, error: { message: 'command required', code: 'BAD_REQUEST' } });
      return;
    }
    let timeoutMs = Number(body.timeoutMs != null ? body.timeoutMs : body.timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 30000;
    const id = ++requestId;
    try {
      const data = await sendCommand(id, body.command, body.payload || {}, timeoutMs);
      reply(res, 200, { ok: true, data });
    } catch (err) {
      const code = err.code || 'COMMAND_FAILED';
      reply(res, statusCodeFor(code), { ok: false, error: { message: err.message, code } });
    }
    return;
  }

  reply(res, 404, { ok: false, error: { message: 'Not found', code: 'NOT_FOUND' } });
});

server.on('upgrade', (req, socket) => {
  const wsKey = req.headers['sec-websocket-key'];
  if (!wsKey) {
    socket.destroy();
    return;
  }
  const hash = crypto.createHash('sha1')
    .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${hash}`,
    '',
    ''
  ].join('\r\n'));
  if (socket.setNoDelay) socket.setNoDelay(true);
  attachSocket(socket);
});

function shutdown() {
  log('shutting down');
  if (extensionSocket && !extensionSocket.destroyed) {
    try { extensionSocket.write(createFrame(8, closePayload(1001, 'server shutdown'))); } catch (_) {}
    extensionSocket.destroy();
  }
  failPending('EXTENSION_DISCONNECTED', 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  log(`http://${HOST}:${PORT}  ws://${HOST}:${PORT}`);
});
