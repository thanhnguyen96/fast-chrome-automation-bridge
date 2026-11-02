---
name: fast-browser
description: High-speed, token-efficient Chrome browser automation. Optimizes automation speed by prioritizing direct DOM manipulation via javascript_tool, eliminating unnecessary intermediate screenshots, enforcing scale:0.5 for visual checks, and using active JS polling instead of blind sleeps. Use when automating web tasks, driving web apps (Google Flow, GitLab, etc.), or when fast browser interaction is requested.
---

# Fast Browser Automation

The slow part is the model loop (screenshot, think, click: 10-30 s per step), not the browser.
To go fast: cut the number of model round trips and push repeated work into scripts.

## 1. Prefer the local bridge (this repo)

Runs in the user's open Chrome (already logged in), in a separate agent window, without stealing mouse or focus.

```sh
curl -s 127.0.0.1:8765/api/status          # server + extension online?
node bridge_server.js                       # if not running (run in background)
node run_workflow.js sel test --url gemini.google.com
node run_workflow.js el click @flow.submit --tab <TAB>
node run_workflow.js el waitAppear @flow.approve '{"timeout":60000}' --tab <TAB>
node run_workflow.js screenshot shot.jpg --tab <TAB>   # CDP, does not switch tabs
```

- Prefer `--tab <id>` over `--url`: several tabs can share a URL. Each tab is independent, so different tabs can run in parallel.
- Selectors per domain live in `selectors/<domain>.json`. Add with `sel add '{"name":{...}}' --url <domain> --tab <TAB>`: it saves through the bridge server and tests at once, no extension reload needed. A hand edit of the JSON file was not picked up in testing (`UNKNOWN_SELECTOR`) until the same entry was added with `sel add`.
- After editing `extension/**`: `node run_workflow.js reload`, then reload the tab.
- Commands: `README.md`. Plan: `WORKFLOW_PLAN.md`.

### Bridge pitfalls

- `el type` with a JSON value from the CLI may insert nothing. Use `call el.type '{"ref":...,"value":...,"target":{"tabId":<TAB>}}'`.
- Background tabs get throttled. If a screenshot times out or says "Detached while handling command": `call agent.keepAlive '{"target":{"tabId":<TAB>}}'`, then retry with `--timeout 60000`.
- Keyboard shortcuts with modifiers: `call input.shortcut '{"keys":"Control+A","target":{"tabId":<TAB>}}'` (`press` has no modifiers).
- Click only returns `clicked:true` for whatever is at that point. With `|| true` or optional clicks, count the element first (`el count`) so a miss does not pass silently.
- Angular Material toggles: the checked state (`mat-button-toggle-checked`) is on the `mat-button-toggle` wrapper, not on its inner `button`. Read it with `read '<locator>' className`.
- Side panels can cover other controls; close them before clicking what is underneath.

## 2. Using Claude in Chrome directly

- **DOM first, images second:** read and click through `find`, `read_page`, `javascript_tool`; do not guess coordinates from screenshots.
- **No intermediate screenshots.** Only capture when the user wants to see, when checking images/video, or when an error cannot be read from the DOM. Use `scale: 0.5`.
- **Poll, do not sleep:** short JS wait loops (≤ 30 s per call, below the 45 s CDP timeout) that return state.
- **Batch steps:** one `javascript_tool` call doing several things instead of many calls.

## 3. Google Flow

Use the `google-flow-video` skill for anything multi-scene (characters, batch scenes, download, join).

- Actions that spend credits (send prompt, Approve) only with the user's consent; never pick "Always approve".
- Download: on the Video tab, `Control+A` via `input.shortcut`, right-click a tile, "Download" gives one zip. A single clip gives a quality submenu instead (pick 720p "Original size") and an `.mp4`. Files go to `%USERPROFILE%\Downloads`.
- Join clips (Omni clips share codecs, so stream copy works):
```sh
ffmpeg -y -f concat -safe 0 -i list.txt -c copy output.mp4
```
