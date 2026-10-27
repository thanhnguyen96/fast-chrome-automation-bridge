# Plan v2.6: auto-wait, JSON workflows, trace, recorder

Goal: make repeated automation on the user's own Chrome (logged-in profile, same view) faster to write,
hot-editable without extension reload, and easy to debug. Ideas borrowed from Playwright
(actionability, codegen, trace viewer); no Playwright dependency.

Order: P1 auto-wait, P2 JSON workflows, P3 trace, P4 recorder. Each phase ships alone and bumps version
(2.6.0, 2.7.0, ...). Keep style of existing code: plain JS, Node built-ins only, short comments.

Constraints
- All code stays in this repo. No new npm deps.
- MV3: no `eval` / `new Function` on workflow text. Workflows are data, interpreted by a fixed runner.
- No focus stealing: keep v2.5 rules (agent window, CDP input/screenshot, no `windows.update focused`).
- Do not run anything on Flow that spends credits (submit prompt, approve, download) during tests.
  Test on `test/elements.html` and read-only steps on Flow/Gemini.

---

## P1. Auto-wait (actionability) — `extension/content/core.js`

Today: `elApi.click` waits visible + enabled (5s). `type`, `hover`, `text`, `attr`, `rightClick`(trusted path ok)
use `find()` once and fail with NOT_FOUND if the element is not there yet.

Change
1. New helper `actionable(ref, checks, opts)` built on `waitUntil`:
   - `attached`: `find(ref)` returns element.
   - `visible`: `isVisible(el)`.
   - `enabled`: `isEnabled(el)` (skip for hover/text).
   - `stable`: bounding rect unchanged across 2 consecutive animation frames
     (use `getBoundingClientRect` compare; if tab hidden and rAF stalls, fall back to 2 ticks 50ms apart).
   - `receivesEvents` (click/hover only): after `scrollIntoView`, `document.elementFromPoint(cx, cy)`
     is `el` or inside `el` (walk shadow roots via `el.contains` / `getRootNode().host`).
     If covered, keep waiting; on timeout error message names the covering element (`describe()`).
2. Apply:
   | action | checks |
   |---|---|
   | click, rightClick | attached, visible, enabled, stable, receivesEvents |
   | type | attached, visible, enabled (editable) |
   | hover | attached, visible, stable, receivesEvents |
   | text, attr | attached |
3. Options on every el action: `waitTimeout` (default 5000), `force: true` skips all checks
   (old behaviour), `noWaitAfter` reserved.
4. Error codes: `NOT_FOUND` (never attached), `NOT_VISIBLE`, `NOT_ENABLED`, `NOT_STABLE`, `COVERED`
   — pick the first check that was still failing at timeout.
5. Element passed directly (`ref instanceof Element`) still goes through visible/stable/receivesEvents
   unless `force`.

Test: extend `test/elements.html` with
- button enabled after 1s, button that slides in (CSS transition 500ms), button covered by an overlay
  removed after 1s, input inserted after 800ms.
- `node run_workflow.js el click '#slideBtn'` succeeds without explicit waitAppear; covered button
  returns `COVERED` with `force:false` + `waitTimeout:500`.

---

## P2. JSON workflows, hot-reload — server + background runner

Problem: site scripts (`extension/sites/*.js`) need extension reload + tab reload after every edit.

### Files
- `workflows/<domain>.json` (same domain rule as selectors, `_file` for file://). Format:
```json
{
  "_meta": { "version": 1 },
  "gemini.ask": {
    "description": "Send a prompt to Gemini and return the last code block",
    "params": { "prompt": { "required": true }, "model": { "default": "Argon" } },
    "steps": [
      { "do": "tabs.open", "url": "https://gemini.google.com/app", "reuse": true },
      { "do": "el.click", "ref": "@gemini.modelPicker", "if": { "notText": ["@gemini.modelPicker", "{{model}}"] } },
      { "do": "el.click", "ref": { "ref": "@gemini.modelArgon", "text": "{{model}}" }, "if": "$prev.ran" },
      { "do": "el.type", "ref": "@gemini.prompt", "value": "{{prompt}}" },
      { "do": "el.click", "ref": "@gemini.send" },
      { "do": "el.waitAppear", "ref": "@gemini.stop", "timeout": 20000, "optional": true },
      { "do": "el.waitDisappear", "ref": "@gemini.stop", "timeout": 300000 },
      { "do": "dom.read", "locator": { "css": "model-response code-block code", "nth": -1 },
        "prop": "textContent", "save": "code" }
    ],
    "returns": "{{code}}"
  }
}
```

### Server (`bridge_server.js`)
- `GET /api/workflows/:domain` → `{ ok, data }` (read file each request; no cache → hot edit).
- `PUT /api/workflows/:domain` body `{ merge, remove }` like selectors.
- Validate on PUT: each workflow has `steps` array, each step has `do` from allowed list.

### Runner — `extension/background/workflows.js` (background, not content)
Runs in the service worker so it survives page navigation and can call tab/download commands.
- `wf.list { domain? }`, `wf.run { name, params, target?, domain?, dryRun? }`, `wf.save { domain, entries }`.
- Name lookup: `domain` explicit, else target tab hostname, else search all workflow files for the name
  (needed when the first step opens the tab).
- Each step = one existing registered command (`el.*`, `dom.*`, `tabs.*`, `page.screenshot`,
  `input.*`, `downloads.*`, `sel.test`) dispatched through the same registry as `/api/command`.
  Plus runner-only steps:
  - `wait { ms }` (cap 60000)
  - `set { name, value }`
  - `assert { ref, count?, text? }` → fails step with `ASSERT_FAILED`
  - `call { workflow, params }` (nested, depth ≤ 5)
  - `repeat { times | whileRef, steps, max }` (max default 50)
- Step fields: `if` (condition), `optional` (failure = skip, recorded), `save` (store result in vars),
  `timeout`, `retry { times, delayMs }`, `label`.
- Templating: `{{name}}` in any string value, from params + saved vars. `$prev` = previous step result.
  Only string substitution, no expressions. Conditions: `{ exists: ref }`, `{ notExists: ref }`,
  `{ text: [ref, pattern] }`, `{ notText: [...] }`, `{ var: name, eq: value }`, or `"$prev.ran"`.
- Target tab: a `tabs.open` step result `tabId` becomes default `target` for later steps. `reuse: true`
  on `tabs.open` reuses an agent-window tab whose URL starts with the url.
- Result: `{ ok, returns, vars, steps: [{ i, do, label, ms, ok, skipped, error }] , totalMs }`.
  Per-step timing is required (user wants to see where time goes).
- Overall timeout `payload.timeoutMs` default 600000; HTTP call in CLI must use it.

### CLI (`run_workflow.js`)
- `node run_workflow.js wf list [--url substr]`
- `node run_workflow.js wf run <name> '<params json>' [--tab N] [--dry]`
- `node run_workflow.js wf add --file f.json [--domain d]`
- Print step table (i, do, label, ms, status) then `returns`.

### Migrate
- Port `gemini.ask` (above) as first JSON workflow; verify on Gemini with a harmless prompt
  (it does not spend credits but sends a message: run once, report).
- Flow: write `flow.makeVideo` JSON (open project, type, submit, waitNew approve, click approve,
  waitNew videoTile, rightClick tile, clickMenu download/720p). Validate with `--dry` and `sel.test`
  only. Do NOT run it live; user must approve credits.
- Keep `sites/google_flow.js` working; JSON workflows are additive.

---

## P3. Trace on failure — `extension/background/workflows.js` + server

- On any failing step (non-optional) and when `trace: true` on `wf.run`:
  - CDP screenshot (`captureScreenshot`, jpeg q60) of the target tab.
  - DOM snippet: outerHTML of `document.body` trimmed to 200KB, plus `describe()` of up to 20 nearest
    candidates for the failing ref (new content action `dom.near { ref }`: same tag/role/text matches
    with visibility, rect, covering element).
  - `sel.test` result for every `@name` used in the workflow.
  - URL, title, step list with timings, error code/message.
- Send to server `POST /api/traces` → saves `traces/<YYYYMMDD-HHMMSS>_<workflow>/`
  (`trace.json`, `shot.jpg`, `dom.html`). Keep last 50 folders.
- `trace: "all"` captures a screenshot after every step (for debugging slow pages).
- CLI: `node run_workflow.js trace last` prints summary + paths.
- No screenshot on success unless asked — keeps runs fast.

---

## P4. Recorder (codegen) — content + background

- `rec.start { target }`: content script listens (capture phase) to click, contextmenu, input/change,
  keydown Enter/Escape, and page navigation (background `tabs.onUpdated`).
- For each event build a locator, best first:
  1. existing dictionary name that matches the element (`find('@name') === el`)
  2. `aria-label` → `{ role, aria }`
  3. `data-testid` / `id` (skip ids that look generated: digits ≥ 4 or hash-like)
  4. visible text (≤ 40 chars) → `{ tag, text }`
  5. short CSS path (≤ 4 levels)
  Verify uniqueness with `findAll`; add `nth` if needed.
- Typed values become params (`{{text1}}`), passwords never recorded (skip `type=password`, mark step
  `{ "do": "el.type", "value": "{{secret}}" }` with a note).
- Show a small fixed badge "● REC n steps" (pointer-events none) in the page.
- `rec.stop { name, domain, saveSelectors: true }` → returns workflow JSON; with save, writes new
  selectors via `sel.add` (named `<domain-short>.<role|tag><n>`, user can rename) and workflow via
  `wf.save`.
- Recording runs in the user's tab (user drives it); must not use debugger or move focus.
- CLI: `node run_workflow.js rec start [--tab N]`, `rec stop <name>`.

---

## Docs & version
- README: sections for auto-wait options, workflow JSON format + step list, trace folder, recorder.
- `.claude/skills/fast-browser/SKILL.md`: add "prefer `wf run`; write new JSON workflow after first
  manual exploration; on failure read `traces/` instead of taking ad-hoc screenshots".
- Bump `manifest.json` + `core.js` VERSION per phase.

## Acceptance
- P1: test page cases pass without explicit waits; existing Flow/Gemini selectors unaffected
  (`sel test` on both domains).
- P2: edit `workflows/_file.json` step, rerun `wf run` → new behaviour with no extension reload;
  per-step ms shown; `gemini.ask` returns code text.
- P3: forced failure (bad ref) produces trace folder with shot.jpg + candidates.
- P4: record 3 clicks + 1 type on test page, replay with `wf run` succeeds.
