---
name: google-flow-video
description: Standard workflow for making multi-scene films/videos on Google Flow (flow.google.com) through the local bridge - create characters + voices in parallel on the Characters tab, send scenes in one batch through the agent chat (Omni), approve, watch the Video tab, delete failed tiles, select all and download a zip, join with ffmpeg. Use when the user wants a film, story, multi-scene clip or video series on Google Flow.
---

# Google Flow: multi-scene films

The bridge drives Flow in a background agent window (no mouse or focus stealing). Commands and selectors: `fast-browser` skill, `selectors/flow.google.com.json`. Scripts: `.claude/skills/google-flow-video/scripts/` (run from repo root). UI labels are quoted in Vietnamese with the English meaning; the UI may also be English, so scripts/selectors accept both (`Select a voice`, `Add ingredients to the prompt box`, `Approve`).

## 0. Setup

```sh
curl -s 127.0.0.1:8765/api/status        # extensionConnected:true ?
node bridge_server.js                    # if not running (background)
node run_workflow.js call tabs.open '{"url":"https://flow.google.com","timeoutMs":45000}' --timeout 60000
node run_workflow.js workflow flow.newProject --tab <TAB>
```

- Websocket error = server not running. After editing `extension/**`: `node run_workflow.js reload`. Every later command uses `--tab <TAB>`.
- Screenshot timeout / "Detached while handling command": `node run_workflow.js call agent.keepAlive '{"target":{"tabId":<TAB>}}'`, retry.
- Ask the user first: number of scenes, style, dialogue language. Default model **Omni** (cheap, 10 s clips, 15 credits per scene).
- **Never invent a story the user named.** Find the real text (their link or a web search) and adapt it faithfully: same characters, events, order. Check the plan against the source before creating characters.
- **Debugger blocked** (`debugger attach failed: Cannot access a chrome-extension:// URL of different extension`, `DEBUGGER_FAILED` / `TRUSTED_INPUT_FAILED`): another extension in the profile (password manager, VPN, ad blocker, agent extension) holds the tab. Typing in the character editor and the chat send button need the debugger. Test `tabs.open https://example.com` + `agent.keepAlive`; if that works, ask the user to disable the other extensions (find them in each profile's `Secure Preferences`), reload, retry. Do not dodge with `trusted:false` clicks: they cannot press send.
- `chrome://` pages cannot be driven; read extension settings from the profile folder.

## 1. Write the script first (in the scratchpad, not the repo)

### Prompt rules

- **All English**; only spoken lines in the dialogue language: `Dialogue in Vietnamese, <who> says: "..."`.
- Plain description anyone understands, in this order:
  1. `10-second 3D animated video, 16:9.` + style sentence + `Keep the attached characters exactly as they look in their reference images.` (when attached).
  2. **Location**: what is visible (architecture, materials, colors, props, ground). No place names.
  3. **Time**: follows the story (`the next morning`, `a few days later, late afternoon`) so light changes on purpose.
  4. **Characters**: by visible look (`the young man in the white jacket and red cape`), action, expression.
  5. **Camera**: shot size, angle, movement. 6. **Sound**: music, effects. 7. **Dialogue**.
  8. End: `Only the people described above appear in this video. No other text on screen, no subtitles, no captions.` (stops extra passers-by who look like other cast members).
- **Never**: story/film title, `Scene X of 10`, studio or era style names (`1950s Disney-style`). Omni prints titles on screen; style names trip the copyright filter.
- **Story text on screen** (sign, letter): give exact text in quotes + `spelled correctly with all accents`. Short capitals (1-5 words) work best; small accent slips are acceptable to the user.
- Spoken lines: copy the source's own sentences when it has dialogue.
- Do not ask Flow's agent to write the story or create characters. Given ready prompts it executes well, many scenes per message.

### Consistency: build prompts from shared blocks

Each clip is generated alone, so any wording difference drifts (house color, sign, clothes, light). Generate prompts with `build.js` from fixed blocks so every scene repeats the same words:

```js
const HEAD = '10-second 3D animated video, 16:9. Stylized 3D animation with soft rounded shapes, warm natural colors and soft daylight, same look in every shot. Keep the attached characters exactly as they look in their reference images.';
const SET  = 'Location: <recurring place: building, walls, roof, door colors, props in fixed positions, ground>';
const HERO = 'the slim fish seller with short black hair parted on the left, a thin black mustache, a faded indigo-blue collarless shirt, a brown canvas apron and a white towel over his shoulder';
const END  = 'Only the people described above appear in this video. No other text on screen, no subtitles, no captions.';
const s = (...p) => p.join(' ');
const scenes = [ s(HEAD, SET, 'Time: early morning, pale golden light.', `Characters: ${HERO} hangs ...`, 'Camera: ...', 'Sound: ...', 'Dialogue in Vietnamese, the fish seller says: "..."', END), ... ];
// write batch_a.json / batch_b.json and scenes.json (single redos) from the same array
```

- One block per recurring place and per character (look words match the character's `desc`). Only Time, action, camera, sound, dialogue vary.
- Describe the look in words **and** attach the character: words stop invented extras, reference keeps the face.
- Plan batches by cast, ≤ 3 characters each (e.g. scenes 1-5 seller + old man + woman, 6-10 seller + young man + neighbor).

### State changes across scenes (sign edited, vase broken, meal eaten)

Omni cannot animate a change to text within a clip and does not remember the previous clip. Failed for a sign shrinking "Ở ĐÂY CÓ BÁN CÁ TƯƠI" to "CÁ": wiping with a cloth (wrong words), "at the start / at the end" (ignored), "paint over ONLY word X" (text unchanged or half-erased).

**Show the result, not the change** (tested 3/3): one fixed state per clip, first to last frame; the action is "he has just repainted it" (steps down holding a brush, looks up, nods). The cut between scenes shows the change.
```
Sign state: the change is already done before the video starts. From the first frame to the last frame the signboard shows exactly this Vietnamese text and nothing else, spelled correctly with all accents: "Ở ĐÂY CÓ BÁN CÁ". A fresh patch of wet white paint on the board shows where the removed word(s) used to be; the remaining letters are sharp, evenly spaced and fully readable. The signboard text never changes during the video.
```
- Before and after go in separate clips. Each scene restates the state from scratch; never "the same sign as before".
- Change-scenes fail most: check their last frame (section 5).

### Omni filters (seen for real)

| Message | Cause | Fix |
|---|---|---|
| "lợi ích của các nhà cung cấp nội dung bên thứ ba" (third-party content) | Character looks famous (red-haired princess in teal gown), title, studio style | Drop that reference in the scene and describe in words; drop `princess`, `fairy-tale`; else redesign the character |
| "nội dung gây hại liên quan đến trẻ vị thành niên" (minors) | Young female + bed/nightwear/lying down, low age | `adult woman`, fully covered clothes, wide shot, no age number |
| "Omni supports up to 3 character references" | > 3 attached | Attach 3, describe the 4th in words |
| "Rất tiếc, không tạo được video này" | Temporary | Resend unchanged |

Failed generations are refunded. Credits are not the priority: redo broken, off-model or captioned clips yourself; ask only when the cost is very large.

## 2. Create characters (before any scene)

Parallel, one tab per character on **the same project** (characters belong to a project). 3 characters in about 1.5 min vs 3 min each sequentially.

```sh
sh .claude/skills/google-flow-video/scripts/make_chars.sh <TAB> <chars.json>        # all; logs char<i>.log, reloads main tab
sh .claude/skills/google-flow-video/scripts/make_char.sh  <TAB> <chars.json> <index> # retry one
```

`chars.json`: `[{ "name", "voice", "desc", "info" }]`
- `desc` (English, detailed): `Full-body character reference sheet, front view, standing, plain light background` + style + build, face (shape, skin, eyes, brows, nose, lips, expression), hair, each clothing layer (color, material, trim), accessories. End `Consistent design, no text, no watermark.` Do not resemble famous characters.
- `voice`: Achernar (F soft high), Achird (M friendly), Algenib (M gravelly low), Algieba (M easygoing), Alnilam (M firm), Aoede (F breezy), Autonoe (F bright), Callirrhoe (F), Charon (M deep), Despina (F smooth), Enceladus (M breathy), Erinome (F clear), Fenrir (M young excitable).
- `info`: personality + `In all dialogue <he/she> speaks Vietnamese with a <...> voice.`

Manual steps (what the script does): `@flow.navCharacters`, "Nhân vật mới" (New character) card if present; type `desc` in `@flow.charPrompt`, `@flow.charSubmit`; **wait for `@flow.charImageReady`** (the name field shows early); name in `@flow.charName` + Enter; `@flow.charVoice`, pick the voice **by name** (`@flow.voiceItem` alone picks Achernar), then **`@flow.voiceAdd`** ("Thêm vào nhân vật", else the voice is not saved); `info` in `@flow.charInfo`, `@flow.charDone`. Screenshot the list; keep good characters.

## 3. Agent settings

Left nav: **Nhân vật** (Characters), **Cảnh** (`@flow.navScenes`, backdrops, not videos), **Video** (`@flow.navVideos`, appears after the first clip). Agent chat is the right panel on every tab.

- `@flow.chatSettings` (icon `tune`, aria "Cài đặt"): image group on top, **video group below**; change only video with `nth:-1` (`{"css":"mat-button-toggle","text":"16:9","nth":-1}`, `{"css":"mat-button-toggle","textExact":"x1","nth":-1}`). Check `className` of `mat-button-toggle` for `mat-button-toggle-checked` first; model must read `Omni 1.1 Flash`. "Xác nhận trước khi tạo" = **Luôn luôn** (Always). "Lưu" (Save) only if changed.
- **Close the panel** (`arrow_back`, `nth:-1`): it covers the input, so "+" and the picker time out.
- `@flow.chatNew` for each big round.
- **Do not click the "Tác nhân" (Agent) chip** (switches to image generation). The book button is agent instructions, not chat.

## 4. Send scenes

**Batch (default)**: all prompts in one message, approve once.
```sh
sh .claude/skills/google-flow-video/scripts/run_batch.sh <TAB> <batch.json>   # { "chars": [≤3 names], "scenes": ["...", ...] }
```
- Characters attach to the whole message. The script adds a header (N separate videos, prompts as written, labels not on screen) and `[Scene i]` tags; prompts themselves must not mention scene numbers.
- One approve chip + total cost; the script prints the plan, clicks "Phê duyệt" (Approve), switches to Video and waits. Batches of 4-6 (4 scenes took about 4 min).

**Single scene (redo)**:
```sh
sh .claude/skills/google-flow-video/scripts/run_scenes.sh <TAB> <scenes.json> 0 1 2 ...   # [{ "chars": [...], "prompt": "..." }]
```
Per scene: wait idle, attach via "+", type, send, click the **new** approve chip (`nth:-1`).

Rules for both:
- **Never click "Luôn phê duyệt" (Always approve).** Names in `chars` must match saved names exactly.
- Send button: `@flow.submit` matches 2; use the last, `{"css":"button","aria":["Bắt đầu tạo","Start generation","Create"],"nth":-1}`. Unsent text stays in the box: on `!! no approve chip` check `el text @flow.prompt`, then the chat (`el text body`) for agent questions; fix JSON and resend.
- Next batch only after the previous is done (`@flow.progress` = 0) and this batch's plan shows the right video count and cost.

### Waiting

Never poll by hand or wait for the user to ask. Run in background (`nohup sh run_batch.sh ... > run.log 2>&1 &`) with a **self-ending Monitor** (no `tail -f`) that emits only actionable lines and exits on done, `!!` or crash:
```sh
seen=0; while true; do
  n=$(wc -l < run.log); [ "$n" -gt "$seen" ] && sed -n "$((seen+1)),${n}p" run.log | grep -E "^== (sent|approved|done)|^!!|costing|tín dụng"; seen=$n
  grep -qE "^== done|^!!" run.log && break
  /usr/bin/ps -ef | grep -q "[r]un_batch.sh" || { grep -q "^== done" run.log || echo "!! script exited"; break; }
  sleep 5; done
```
- Git Bash has **no `pgrep`** (gives false "exited"); use `ps -ef` as above. Vietnamese plan line: `... 5 video này với chi phí là 75 tín dụng`. Do not emit `tiles=` lines.
- `== done` is a claim: verify the cost matched and the tile count rose by the scene count.
- Tiles exist in the DOM **only on the Video tab**; chat clips are thumbnails. Done = `flow-video-tile` count reached and `@flow.progress` 0 (no `%` or "Đang trong hàng đợi"/queued; queued tiles are not `flow-video-tile` yet, so track with `el text body`).

## 5. Check and clean up

- Failure reason: `el text {"css":"flow-video-tile","nth":i}`; fix per filter table.
- Delete failed tiles ("Không thành công"): their "Xoá" button, until 0. Delete poor versions: right-click, "Chuyển vào thùng rác" (Move to trash). Hover to read the title first (tiles are named by Flow from content, newest first).
- **Check every clip from the files, not the grid.** Download (section 6), unzip into its own folder, one 4-frame strip per clip plus the last frame of change-scenes:
  ```sh
  for f in raw/*.mp4; do ffmpeg -loglevel error -y -i "$f" -vf "fps=1/3,scale=480:-1,tile=4x1" -frames:v 1 "frames/$(basename "$f" .mp4).jpg"; done
  ffmpeg -loglevel error -y -sseof -0.5 -i raw/<clip>.mp4 -frames:v 1 frames/<clip>_last.jpg
  ```
  Check against the prompt: same set, characters on model, story state right, no extra people, no captions. Rewrite only failing scenes in `build.js`, redo with `run_scenes.sh`, trash the old versions, download again.

## 6. Download once

On the Video tab (**do not click a tile**, it opens the editor): `node run_workflow.js call input.shortcut '{"keys":"Control+A","target":{"tabId":<TAB>}}'`, right-click a tile, "Tải xuống" (Download).
- 2+ clips: multi-select menu ("Bỏ chọn"), one zip `tải xuống.zip`. 1 clip: quality submenu, pick **720p (Kích thước gốc)**, gives an `.mp4` named after the tile.
- Saved to `%USERPROFILE%\Downloads`; repeats become `tải xuống (1).zip`..., take the newest. Never download tile by tile.

## 7. Join

```sh
sh .claude/skills/google-flow-video/scripts/assemble.sh "<zip|mp4>" "<out_dir>" "<film_name>" <scene1_prefix> <scene2_prefix> ...
```
Prefix = start of a file name in the zip (the tile title Flow wrote, e.g. `Man_relights_lighthouse_lamp_…`; see `unzip -l`). The script unzips, renames `scene_01..`, joins with `-c copy` (Omni clips are all 1280x720 24 fps h264+aac; re-encodes otherwise) and writes a contact sheet to check order.

## 8. Report

Film path, duration, scenes still flawed. Say the check was visual and audio was not checked if you did not listen. New selectors: `sel add`, ask before committing.
