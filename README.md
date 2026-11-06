# Fast Automation Bridge

**English** · [Tiếng Việt](README.vi.md)

Drive **the Chrome you already have open**, with your profile and your logins, from local scripts. It doesn't steal focus and needs no npm packages.

It is a Chrome MV3 extension plus a small Node.js bridge that talk over WebSocket on `127.0.0.1`. Site logic, such as Google Flow, lives in pluggable modules and per-domain selector dictionaries, not in the core.

---

## Contents

- [Why](#why)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [CLI](#cli)
- [HTTP API](#http-api)
- [Commands](#commands)
- [Element API](#element-api)
- [Selector dictionary](#selector-dictionary)
- [Agent window](#agent-window)
- [Development](#development)
- [Roadmap](#roadmap)

---

## Why

Playwright and Puppeteer need Chrome started with `--remote-debugging-port`, and Chrome 136+ ignores that flag on the default profile. In practice that means a separate profile and logging in to everything again.

This bridge runs inside the Chrome you already use:

- **No re-login.** Your existing cookies, accounts and extensions just work.
- **Same view as you.** You debug and test against exactly what you see.
- **Mouse, keyboard and focus untouched.** Automation runs in a separate background window.
- **Fast repeat runs.** Workflows are scripted, so no model round-trip is spent on each step.

## Features

- **Rich locators:** CSS, XPath, text, ARIA, role, `nth` (negative counts from the end), `within`, fallback arrays, shadow DOM.
- **Per-domain selector dictionary** (`selectors/<domain>.json`). You can add, edit and test selectors at runtime without reloading the extension.
- **Waits:** `waitAppear`, `waitDisappear`, `waitEnabled`, `waitText`, `waitCount`, `waitNew`.
- **Trusted input** via the Chrome DevTools Protocol, for pages that ignore synthetic events.
- **Agent window:** an unfocused background window in a "Bridge" tab group. Screenshots go through CDP and never switch tabs.
- **Site modules:** ships with `flow.*` for Google Flow.
- **Zero dependencies:** Node.js built-ins only, no build step.

## Architecture

```
CLI / script ──HTTP──▶ bridge_server.js ──WebSocket──▶ extension (service worker) ──▶ content script in tab
              :8765                        :8765                                      └─ CDP (chrome.debugger)
```

```
.
├── extension/                     # Chrome extension (Load unpacked)
│   ├── manifest.json
│   ├── background/
│   │   ├── index.js               # Command registration, startup
│   │   ├── connection.js          # WebSocket client, backoff 1s→10s, ping 20s
│   │   ├── commands.js            # Registry + dispatch
│   │   ├── tabs.js                # Tab resolution, agent window, load waits
│   │   ├── inject.js              # Injects core + matching site modules
│   │   ├── sites.js               # Site module table
│   │   ├── selectors.js           # Selector cache (read/write via server)
│   │   ├── input.js               # CDP trusted input + screenshots
│   │   └── downloads.js           # downloads.wait, download_complete events
│   ├── content/
│   │   ├── core.js                # Locators, actions, waits, workflow registry
│   │   └── router.js              # Message routing
│   └── sites/
│       └── google_flow.js         # flow.* workflows
├── selectors/                     # Per-domain selector dictionaries (server-owned)
├── test/elements.html             # Element API test page
├── .claude/skills/fast-browser/   # Claude Code skill
├── bridge_server.js               # HTTP + WebSocket server
├── run_workflow.js                # CLI and require()-able client
└── WORKFLOW_PLAN.md               # v2.6+ plan
```

## Requirements

- Google Chrome, or another Chromium-based browser with MV3 support
- Node.js 22 or later

## Installation

1. Open `chrome://extensions/` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Start the bridge:

   ```bash
   node bridge_server.js
   ```

4. Check the connection:

   ```bash
   node run_workflow.js status
   # { "running": true, "extensionConnected": true, "extensionVersion": "2.5.0", ... }
   ```

The extension connects to `ws://127.0.0.1:8765` and retries with backoff while the server is down.

> **Port:** `BRIDGE_PORT` changes the port for the server and CLI only. The extension hardcodes `8765` in `extension/background/connection.js`, so change it there too.

## Quick start

```bash
# Open a page in the agent window (no focus steal)
node run_workflow.js call tabs.open '{"url":"https://example.com"}'

# Read and interact
node run_workflow.js read title --url example.com
node run_workflow.js el click "text=More information" --url example.com

# Screenshot via CDP
node run_workflow.js screenshot page.jpg --url example.com
```

From Node.js:

```js
const { call } = require('./run_workflow');
const res = await call('el.text', { ref: 'h1', target: { url: 'example.com' } });
```

## CLI

```bash
node run_workflow.js status | events [since] | tabs | reload
node run_workflow.js open <url> | newTab <url> | activate <tabId> | close <tabId>
node run_workflow.js query <locator> | read <locator> [prop] | click <locator>
node run_workflow.js type <locator> <value> | press <key> | waitFor <locator>
node run_workflow.js screenshot [file]
node run_workflow.js workflows | workflow <name> [jsonArgs]
node run_workflow.js sel list | sel add '<json>' | sel remove <name...> | sel test [@name...]
node run_workflow.js el <action> <ref> [json]
node run_workflow.js call <command> [jsonPayload]
```

| Flag | Meaning |
| --- | --- |
| `--tab N` | Target a tab by id |
| `--url substr` | Target a tab whose URL contains the substring |
| `--timeout ms` | HTTP timeout (default: payload timeout + 10 s, else 30 s) |
| `--file f.json` | Read `sel add` entries from a file |
| `--raw` | Print compact JSON without shortening it |

A locator is CSS, a JSON object, or a `text=` / `aria=` / `role=` prefix. The CLI exits with code 1 when a command returns `ok:false`.

## HTTP API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/status` | `{running, extensionConnected, extensionVersion, pending, uptimeSec}` |
| `POST` | `/api/command` | Body `{command, payload, timeoutMs}`. Returns `{ok, data}` or `{ok:false, error:{message, code}}` |
| `GET` | `/api/events?since=<seq>&waitMs=<0..60000>` | Long-poll events (ring buffer of 200) |
| `GET` | `/api/selectors/:domain` | Selector dictionary for a domain (`{}` if there is no file yet) |
| `PUT` | `/api/selectors/:domain` | Body `{merge:{...}, remove:[...]}`. Writes JSON with sorted keys |

## Commands

| Group | Commands |
| --- | --- |
| Extension | `ext.ping`, `ext.reload` |
| Tabs | `tabs.list`, `tabs.open`, `tabs.adopt`, `tabs.navigate`, `tabs.activate`, `tabs.close`, `tabs.reload` |
| Agent | `agent.window`, `agent.release`, `agent.keepAlive` |
| Page | `page.screenshot`, `page.eval`, `downloads.wait` |
| Trusted input | `input.click`, `input.type`, `input.press`, `input.shortcut` |
| DOM | `dom.query`, `dom.read`, `dom.exists`, `dom.waitFor`, `dom.click`, `dom.rightClick`, `dom.type`, `dom.press`, `dom.scroll`, `dom.locate` |
| Element | `el.click`, `el.rightClick`, `el.type`, `el.press`, `el.hover`, `el.waitAppear`, `el.waitDisappear`, `el.waitEnabled`, `el.waitText`, `el.waitCount`, `el.waitNew`, `el.text`, `el.attr`, `el.count`, `el.clickMenu` |
| Selectors | `sel.list`, `sel.add`, `sel.remove`, `sel.test` |
| Workflows | `workflow.list`, `workflow.run` |
| Google Flow | `flow.newProject`, `flow.submitPrompt`, `flow.approveCredits`, `flow.waitComplete`, `flow.downloadAll`, `flow.status` |

`page.eval` runs a JavaScript expression in the page's main world through CDP `Runtime.evaluate` (top frame, `awaitPromise`, `returnByValue`). Unlike the content-script `dom.*` actions, it can reach into same-origin iframes such as rich-text editors. The result comes back as `{ value }`; a thrown error returns `EVAL_FAILED`.

```sh
node run_workflow.js call page.eval '{"expression":"document.title"}' --tab <TAB>
node run_workflow.js call page.eval '{"expression":"(async()=>{ /* ... */ return 1 })()","timeoutMs":25000}' --tab <TAB>
```

For long scripts, build the payload with `JSON.stringify` in a small Node helper rather than escaping quotes by hand in the shell.

## Element API

Every `el.*` command takes a `ref`, which can be:

- a locator: `"button.go"`, `{ "role": "button", "text": "Save" }`
- a fallback array, where the first locator that matches is used
- a dictionary name: `"@flow.submit"`
- an override object: `{ "ref": "@flow.tile", "nth": -1, "within": "@flow.grid" }`

Locators only match visible elements by default. Add `"includeHidden": true` (alias of `"visible": false`) to reach visually hidden elements, such as the real `<input>` behind a styled checkbox: `{ "css": "input[value=api]", "includeHidden": true }`. Read `checked` on it with `read`, or count `:checked` matches with `el count`.

| Command | Behaviour |
| --- | --- |
| `el.count` | Count matches right now |
| `el.waitAppear` | Wait until visible (default 15000 ms, polling every 250 ms) |
| `el.waitDisappear` | Wait until the element is removed or hidden |
| `el.waitEnabled` | Visible and not `disabled` / `aria-disabled="true"` |
| `el.waitText` | Wait until the text matches a string or `{regex}` |
| `el.waitCount` | Wait until the count satisfies `op` (`>=`, `==`, `<=`) |
| `el.waitNew` | Note the existing matches, run an optional action, wait for a new match |
| `el.click` | Wait until enabled (default 5 s), then click. Options: `trusted`, `button`, `delay`, `waitTimeout` |
| `el.rightClick` / `el.hover` / `el.type` / `el.press` | Right-click, hover, type, press a key |
| `el.text` / `el.attr` | Read text or an attribute |
| `el.clickMenu` | Click menu items in order, waiting for each one to appear first |

**`trusted`:** `true` clicks through CDP and `false` dispatches synthetic DOM events. `'auto'` (the default) uses CDP when the domain's dictionary sets `_meta.trustedClick`.

**XPath:** strings that start with `/`, `(` or `./` are treated as XPath. Anything else is CSS.

**Error codes:** `TIMEOUT`, `UNKNOWN_SELECTOR`, `SELECTORS_NOT_LOADED`, `NO_TAB`, `INJECT_FAILED`, `EXTENSION_OFFLINE`.

```bash
node run_workflow.js el waitAppear "@flow.approve" '{"timeout":60000}' --url flow.google.com
node run_workflow.js el clickMenu '["@flow.menuDownload",{"role":"menuitem","text":"720p"}]'
node run_workflow.js el type '{"ref":"@gemini.prompt","value":"hello"}' --url gemini.google.com
```

## Selector dictionary

Each domain has one file, `selectors/<hostname>.json`. Pages on `file://` share the `_file` domain. A value is either a locator or a fallback array.

```json
{
  "_meta": { "trustedClick": true },
  "flow.submit": [
    { "css": "button.generate-icon-button" },
    { "role": "button", "aria": ["Bắt đầu tạo", "Start generation"] }
  ]
}
```

- The server owns the files. The extension caches them in memory and refreshes after every write.
- `sel.add {entries, test, strict}` tests entries in the target tab and reports `{name, count, firstAlt, sample}`. It warns when the count is 0 or greater than 20. With `strict:true`, entries that match nothing are not saved.
- Site modules declare defaults with `Bridge.sel.defaults(map)`. Values in the file always take priority.

```bash
node run_workflow.js sel add '{"x.btn":{"css":"button.go"}}' --url example.com
node run_workflow.js sel test @flow.submit @flow.prompt --url flow.google.com
node run_workflow.js sel remove x.btn --url example.com
```

## Agent window

Like Claude in Chrome, the bridge works in its own unfocused window, inside a **Bridge** tab group:

- `tabs.open {url}` opens the page in the agent window, which is created unfocused the first time. Pass `foreground:true` to open it in your own window instead.
- `tabs.adopt {target}` moves an existing tab into the agent window.
- `agent.window` lists the agent tabs plus `focusedWindowId`, so you can confirm your window kept focus.
- `agent.release {target}` detaches the debugger right away, which removes the "being debugged" bar.
- When no target is given, tabs in the agent window are preferred.
- The CDP session stays attached for 60 s of idle time and enables `Emulation.setFocusEmulationEnabled`, so background pages behave as if they were focused.

> Don't minimize the agent window or cover it completely. Chrome throttles hidden windows, which slows timers and can make screenshots come back blank.

## Development

| You changed | Do this |
| --- | --- |
| Selectors via `sel add` / `sel remove` | Nothing |
| `selectors/*.json` by hand | Run any `sel add`/`sel remove`, or reload the extension |
| Any file under `extension/` | `node run_workflow.js reload`, then reload the target tab |
| `bridge_server.js` | Restart the server |

To test, open `test/elements.html` in Chrome and run `el.*` commands with `--url elements.html`.

## Roadmap

See [WORKFLOW_PLAN.md](WORKFLOW_PLAN.md):

1. **Auto-wait.** Playwright-style actionability checks: visible, enabled, stable, not covered.
2. **JSON workflows.** Hot-editable with no reload, plus per-step timings.
3. **Trace on failure.** Saves a screenshot, the DOM and near-match candidates.
4. **Recorder.** Turns your actions into a workflow plus selectors.
