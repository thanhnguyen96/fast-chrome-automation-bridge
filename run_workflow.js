// CLI + require()-able client for the local bridge. Node built-ins only.
//   node run_workflow.js call <command> [jsonPayload] [--tab N] [--url substr] [--timeout ms] [--raw]

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.BRIDGE_PORT || 8765);
const HOST = '127.0.0.1';

function call(command, payload = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000;
  const body = JSON.stringify({ command, payload, timeoutMs });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: '/api/command',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (_) {
          reject(new Error(raw || `HTTP ${res.statusCode}`));
        }
      });
    });
    req.setTimeout(timeoutMs + 5000, () => {
      req.destroy(new Error('client timeout'));
    });
    req.on('error', (err) => {
      reject(new Error(`Bridge server connection error: ${err.message}. Is 'node bridge_server.js' running?`));
    });
    req.write(body);
    req.end();
  });
}

function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: HOST, port: PORT, path: urlPath }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (_) {
          reject(new Error(raw || `HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', (err) => {
      reject(new Error(`Bridge server connection error: ${err.message}. Is 'node bridge_server.js' running?`));
    });
  });
}

function parseLocator(arg) {
  if (arg == null) return undefined;
  if (arg.startsWith('{')) return JSON.parse(arg);
  if (arg.startsWith('text=')) return { text: arg.slice(5) };
  if (arg.startsWith('aria=')) return { aria: arg.slice(5) };
  if (arg.startsWith('role=')) return { role: arg.slice(5) };
  return arg;
}

function splitArgs(argv) {
  const positional = [];
  const flags = { raw: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--raw') flags.raw = true;
    else if (arg === '--tab') flags.tab = Number(argv[++i]);
    else if (arg === '--url') flags.url = argv[++i];
    else if (arg === '--timeout') flags.timeout = Number(argv[++i]);
    else if (arg === '--file') flags.file = argv[++i];
    else positional.push(arg);
  }
  return { positional, flags };
}

function targetFrom(flags) {
  const target = {};
  if (flags.tab) target.tabId = flags.tab;
  if (flags.url) target.url = flags.url;
  return Object.keys(target).length ? target : undefined;
}

function withTarget(payload, flags) {
  const target = targetFrom(flags);
  if (!target) return payload;
  return Object.assign({}, payload, { target: Object.assign({}, payload.target, target) });
}

function ensureHttp(url) {
  if (!url) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return 'https://' + url;
}

function shrink(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(shrink);
  const out = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (key === 'dataUrl' && typeof item === 'string' && item.length > 80) {
      out[key] = `${item.slice(0, 32)}…(${item.length} chars)`;
    } else {
      out[key] = shrink(item);
    }
  }
  return out;
}

function printResult(result, raw) {
  const body = raw ? result : shrink(result);
  console.log(raw ? JSON.stringify(body) : JSON.stringify(body, null, 2));
}

const USAGE = `Usage:
  node run_workflow.js status
  node run_workflow.js events [since]
  node run_workflow.js tabs
  node run_workflow.js open <url> [--tab N] [--url substr]
  node run_workflow.js newTab <url>
  node run_workflow.js activate <tabId>
  node run_workflow.js close <tabId>
  node run_workflow.js screenshot [file]
  node run_workflow.js query <locator> [--url substr]
  node run_workflow.js read <locator> [prop]     (alias readDom)
  node run_workflow.js click <locator>
  node run_workflow.js type <locator> <value>    (alias setValue)
  node run_workflow.js press <key>
  node run_workflow.js waitFor <locator>
  node run_workflow.js workflow <name> [jsonArgs]
  node run_workflow.js workflows
  node run_workflow.js sel list
  node run_workflow.js sel add '<json>' [--file f.json] [--url substr]
  node run_workflow.js sel remove <name> [name...]
  node run_workflow.js sel test [@name...]
  node run_workflow.js el <action> <ref> [json]     (click, waitAppear, count, text, ...)
  node run_workflow.js reload
  node run_workflow.js call <command> [jsonPayload] [--tab N] [--url substr] [--timeout ms] [--raw]

Locator: CSS, JSON object, or text= / aria= / role= prefix.`;

async function main(argv) {
  const { positional, flags } = splitArgs(argv);
  const [commandType, ...args] = positional;
  if (!commandType || commandType === 'help' || commandType === '--help') {
    console.log(USAGE);
    return 0;
  }

  // HTTP timeout follows the payload timeout when --timeout is not given.
  function timeoutFor(payload, fallback) {
    if (flags.timeout) return flags.timeout;
    const inner = payload && (payload.timeout || payload.timeoutMs);
    return inner ? Number(inner) + 10000 : (fallback || 30000);
  }

  const timeoutMs = flags.timeout || 30000;

  if (commandType === 'status') {
    printResult(await getJson('/api/status'), flags.raw);
    return 0;
  }

  if (commandType === 'events') {
    const since = args[0] ? Number(args[0]) : 0;
    printResult(await getJson(`/api/events?since=${since}&waitMs=0`), flags.raw);
    return 0;
  }

  let command;
  let payload = {};

  if (commandType === 'call') {
    command = args[0];
    if (!command) throw new Error('call requires a command name');
    if (args[1]) payload = JSON.parse(args[1]);
    payload = withTarget(payload, flags);
  } else if (commandType === 'tabs') {
    command = 'tabs.list';
  } else if (commandType === 'open' || commandType === 'navigate') {
    command = 'tabs.navigate';
    payload = withTarget({ url: ensureHttp(args[0]), wait: true }, flags);
  } else if (commandType === 'newTab') {
    command = 'tabs.open';
    payload = { url: ensureHttp(args[0]), active: true, wait: true };
  } else if (commandType === 'activate') {
    command = 'tabs.activate';
    payload = { target: { tabId: Number(args[0]) } };
  } else if (commandType === 'close') {
    command = 'tabs.close';
    payload = { target: { tabId: Number(args[0]) } };
  } else if (commandType === 'reload') {
    command = 'ext.reload';
  } else if (commandType === 'query') {
    command = 'dom.query';
    payload = withTarget({ locator: parseLocator(args[0]) }, flags);
  } else if (commandType === 'read' || commandType === 'readDom') {
    command = 'dom.read';
    let prop = args[1] || 'innerText';
    if (!args[1] && (args[0] === 'title' || args[0] === 'url')) prop = args[0];
    payload = withTarget({ locator: parseLocator(args[0]), prop }, flags);
  } else if (commandType === 'click') {
    command = 'dom.click';
    payload = withTarget({ locator: parseLocator(args[0]) }, flags);
  } else if (commandType === 'type' || commandType === 'setValue') {
    command = 'dom.type';
    payload = withTarget({ locator: parseLocator(args[0]), value: args.slice(1).join(' ') }, flags);
  } else if (commandType === 'press') {
    command = 'dom.press';
    payload = withTarget({ key: args[0] }, flags);
  } else if (commandType === 'waitFor') {
    command = 'dom.waitFor';
    payload = withTarget({ locator: parseLocator(args[0]) }, flags);
  } else if (commandType === 'workflow') {
    command = 'workflow.run';
    let wfArgs = {};
    if (args[1]) {
      try { wfArgs = JSON.parse(args[1]); } catch (_) { wfArgs = { text: args[1] }; }
    }
    payload = withTarget({ name: args[0], args: wfArgs }, flags);
  } else if (commandType === 'workflows') {
    command = 'workflow.list';
    payload = withTarget({}, flags);
  } else if (commandType === 'sel') {
    const sub = args[0];
    if (sub === 'list') {
      command = 'sel.list';
      payload = withTarget({}, flags);
    } else if (sub === 'add') {
      command = 'sel.add';
      let entries;
      if (flags.file) entries = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
      else if (args[1]) entries = JSON.parse(args[1]);
      else throw new Error('sel add needs a JSON argument or --file');
      payload = withTarget({ entries, persist: true, test: true }, flags);
    } else if (sub === 'remove') {
      command = 'sel.remove';
      if (!args[1]) throw new Error('sel remove needs at least one name');
      payload = withTarget({ names: args.slice(1) }, flags);
    } else if (sub === 'test') {
      command = 'sel.test';
      const names = args.slice(1).map((n) => n.replace(/^@/, ''));
      payload = withTarget(names.length ? { names } : {}, flags);
    } else {
      throw new Error('sel needs list, add, remove, or test');
    }
  } else if (commandType === 'el') {
    const sub = args[0];
    const known = ['click', 'rightClick', 'type', 'press', 'hover', 'waitAppear', 'waitDisappear',
      'waitEnabled', 'waitText', 'waitCount', 'waitNew', 'text', 'attr', 'count', 'clickMenu'];
    if (!known.includes(sub)) throw new Error(`Unknown el action: ${sub}`);
    command = 'el.' + sub;
    let extra = {};
    const last = args[args.length - 1];
    const hasJson = args.length > 2 && last && last.startsWith('{');
    if (hasJson) extra = JSON.parse(last);
    // A lone {...} or [...] argument is a locator, not a CSS string.
    function refArg(arg) {
      if (arg && (arg.startsWith('{') || arg.startsWith('['))) return JSON.parse(arg);
      return arg;
    }
    // Single JSON object with ref/locator/key/path = the whole payload: el type '{"ref":"@x","value":"hi"}'.
    let whole = null;
    if (args.length === 2 && args[1] && args[1].startsWith('{')) {
      const obj = JSON.parse(args[1]);
      if (['ref', 'locator', 'key', 'path'].some((k) => obj[k] != null)) whole = obj;
    }
    if (whole) {
      payload = withTarget(whole, flags);
    } else if (sub === 'press') {
      payload = withTarget(Object.assign({ key: args[1] }, extra), flags);
    } else if (sub === 'type') {
      payload = withTarget(Object.assign({ ref: refArg(args[1]), value: hasJson ? args.slice(2, -1).join(' ') : args.slice(2).join(' ') }, extra), flags);
    } else if (sub === 'clickMenu') {
      payload = withTarget(Object.assign({ path: JSON.parse(args[1]) }, extra), flags);
    } else {
      payload = withTarget(Object.assign({ ref: refArg(args[1]) }, extra), flags);
    }
  } else if (commandType === 'screenshot') {
    command = 'page.screenshot';
    const outputPath = args[0] || `screenshot_${Date.now()}.jpg`;
    const format = outputPath.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
    payload = withTarget({ format, quality: 80 }, flags);
    const result = await call(command, payload, { timeoutMs: timeoutFor(payload, timeoutMs) });
    if (result.ok && result.data && result.data.dataUrl) {
      const b64 = result.data.dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const full = path.resolve(outputPath);
      fs.writeFileSync(full, Buffer.from(b64, 'base64'));
      console.log(`Screenshot saved: ${full}`);
      return 0;
    }
    printResult(result, flags.raw);
    return 1;
  } else {
    throw new Error(`Unknown command: ${commandType}`);
  }

  const result = await call(command, payload, { timeoutMs: timeoutFor(payload, timeoutMs) });
  printResult(result, flags.raw);
  return result && result.ok === false ? 1 : 0;
}

module.exports = { call };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code || 0),
    (err) => {
      console.error(err.message || err);
      process.exit(1);
    }
  );
}
