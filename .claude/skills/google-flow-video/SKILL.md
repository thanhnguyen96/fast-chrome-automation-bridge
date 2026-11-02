---
name: google-flow-video
description: Standard workflow for making multi-scene films/videos on Google Flow (flow.google.com) through the local bridge - create characters + voices in parallel on the Characters tab, send scenes in one batch through the agent chat (Omni), approve, watch the Video tab, delete failed tiles, select all and download a zip, join with ffmpeg. Use when the user wants a film, story, multi-scene clip or video series on Google Flow.
---

# Google Flow: multi-scene films

The local bridge drives Flow in an agent window that runs in the background (no mouse or focus stealing).
Basic commands and selectors: see the `fast-browser` skill and `selectors/flow.google.com.json`.
Helper scripts: `.claude/skills/google-flow-video/scripts/` (run from the repo root).
Flow's UI is in the user's language (Vietnamese here); UI labels below are quoted as shown, with the English meaning.

## 0. Setup

```sh
curl -s 127.0.0.1:8765/api/status        # extensionConnected:true ?
node bridge_server.js                    # if not running (run in background)
node run_workflow.js call tabs.open '{"url":"https://flow.google.com","timeoutMs":45000}' --timeout 60000
node run_workflow.js workflow flow.newProject --tab <TAB>
```

- Websocket error = server not running. After editing `extension/**`: `node run_workflow.js reload`.
- Note the `tabId`; every later command uses `--tab <TAB>`.
- Screenshot timeout or "Detached while handling command": `node run_workflow.js call agent.keepAlive '{"target":{"tabId":<TAB>}}'`, then retry.
- Ask the user first: number of scenes, style, dialogue language. Default video model is **Omni** (cheap, 10-second clips).

## 1. Write the script first

Keep script files in the scratchpad, not in the repo.

### Prompt rules (most important)

- **All English**, only the spoken lines in the dialogue language: `Dialogue in Vietnamese, <who> says: "..."`.
- Each scene is a description **anyone can understand**, in this order:
  1. `10-second 3D animated video, 16:9.` (+ `Keep the attached characters exactly as they look in their reference images.` when characters are attached)
  2. **Location**: describe what can be seen: architecture, materials, light, weather, time of day, objects. No place names or vague/little-known locations; say what the place looks like.
  3. **Characters**: refer to them by visible appearance (`the young man in the white jacket and red cape`), what they do, their expression. Ages are fine when they matter for the look (see filter notes below).
  4. **Camera**: angle, shot size, movement (wide shot, close-up, low angle, slowly moves closer...).
  5. **Sound**: music, sound effects.
  6. **Dialogue** in the target language.
  7. End with `No text on screen.`
- **Never** put in a prompt: the story/film title, `Scene X of 10`, names of famous studios or era styles (`1950s Disney-style`...). Omni prints titles onto the video, and style names trigger the copyright filter.
- Do not ask Flow's agent to write the story or create characters; it does that badly. Given ready-written prompts it does well, including many scenes in one message (section 4).

### Omni filters (seen for real)

| Message (as shown in Flow) | Cause | Fix |
|---|---|---|
| "lợi ích của các nhà cung cấp nội dung bên thứ ba" (third-party content provider interests) | Character/reference image looks like a famous character (e.g. red-haired princess in a teal gown, big-studio look), story title, studio style name | Drop that character's reference image in the scene and describe the look in words; drop words like `princess`, `fairy-tale`; if it still fails, redesign the character to look clearly different |
| "nội dung gây hại liên quan đến trẻ vị thành niên" (harmful content involving minors) | Young female character + bed/nightwear/lying down, especially with a low age | Write `adult woman`; fully covered clothes (long dress + shawl); wide shot instead of a close-up on the bed; drop the age number in this scene |
| "Omni supports up to 3 character references" | More than 3 attached characters | Attach at most 3, describe the 4th in words matching their design |
| "Rất tiếc, không tạo được video này" (could not create this video) | Temporary error | Resend unchanged |

- Failed generations are **refunded**; resending costs nothing.
- Credits are not the priority: regenerate broken clips, clips with on-screen text or off-model characters yourself. Only ask when the cost difference is very large.

## 2. Create characters (Characters tab)

Do this **before** any scene, once per character, so every scene keeps the same face + voice.

**Parallel (default):** one tab per character, all on the same project. Tested: 3 characters done in about 1.5 minutes (sequential takes about 3 minutes per character).

```sh
sh .claude/skills/google-flow-video/scripts/make_chars.sh <TAB> <chars.json>
```

The script opens extra tabs on the same project URL, runs `make_char.sh` in parallel, prints ok/FAIL per character (logs `char<i>.log` next to `chars.json`), closes the extra tabs and reloads the main tab so the character list and picker update. Rerun a failed character alone:

```sh
sh .claude/skills/google-flow-video/scripts/make_char.sh <TAB> <chars.json> <index>
```

- All tabs must be on **the same project**: characters belong to a project; other projects do not see them.

`chars.json`: `[{ "name", "voice", "desc", "info" }]`.

- `desc` (English, as detailed as possible): `Full-body character reference sheet, front view, standing, plain light background` + style + build, face (shape, skin, eyes, brows, nose, lips, expression), hair (color, length, style), each clothing layer (color, material, trim), accessories. End with `Consistent design, no text, no watermark.`
- `voice`: a voice name from Flow's list. Seen so far: Achernar (female, soft, high), Achird (male, friendly), Algenib (male, gravelly, low), Algieba (male, easygoing, mid-low), Alnilam (male, firm), Aoede (female, breezy), Autonoe (female, bright), Callirrhoe (female), Charon (male, deep), Despina (female, smooth), Enceladus (male, breathy), Erinome (female, clear), Fenrir (male, young, excitable).
- `info`: personality + `In all dialogue <he/she> speaks Vietnamese with a <...> voice.`
- **Do not make characters close to famous ones** (a red-haired princess in a teal gown got every scene with her reference blocked). Pick your own colors, hair and outfit.

Steps the script does (to do by hand if needed):
1. `@flow.navCharacters`, then the "Nhân vật mới" (New character) card if it exists (shown once the list has characters).
2. Type `desc` into `@flow.charPrompt`, click `@flow.charSubmit`.
3. **Wait for `@flow.charImageReady`** (image download button), not the name field (it shows early, while the image is still generating).
4. Type the name into `@flow.charName` + Enter.
5. `@flow.charVoice`, pick the voice in the dialog **by voice name** (`@flow.voiceItem` matches every row; clicking it picks the first voice, Achernar), then **click `@flow.voiceAdd`** ("Thêm vào nhân vật", Add to character). Selecting without that button does not assign the voice.
6. Type `info` into `@flow.charInfo`, click `@flow.charDone`.

Check the character list with a screenshot. Keep characters that are already fine; do not redo them.

## 3. Agent settings

Left nav: **Nhân vật** (Characters), **Cảnh** (`@flow.navScenes`, Scenes = settings/backdrops, not videos), **Video** (`@flow.navVideos`, grid of generated clips). The Video item only appears once the first clip exists. The agent chat is the right-hand panel, available on every tab.

- Open chat settings with `@flow.chatSettings` (icon text `tune`; its aria label is "Cài đặt", not "tune"):
  - The panel has two identical groups: **image** on top, **video** below. Only change the video group, using `nth:-1` (`{"css":"mat-button-toggle","text":"16:9","nth":-1}`, `{"css":"mat-button-toggle","textExact":"x1","nth":-1}`). Leave the image group (x2, Nano Banana) alone.
  - Check before changing: read `className` of `mat-button-toggle` (not the inner `button`); `mat-button-toggle-checked` means selected. The video model dropdown must read `Omni 1.1 Flash`. If all correct, click nothing.
  - Keep "Xác nhận trước khi tạo" (Confirm before generating) = **Luôn luôn** (Always). Click "Lưu" (Save) if you changed anything.
  - **Close the panel** (`arrow_back` button in the panel, `nth:-1`) before attaching characters: it covers the chat input, so the "+" button and picker time out.
- Start a new chat session (`@flow.chatNew`) for each big round so the agent does not mix in old context.
- **Do not click the "Tác nhân" (Agent) chip in the input box**: it turns agent mode off and switches to image generation. The book button next to the input is "Chỉ dẫn cho tác nhân" (agent instructions), not chat.

## 4. Send scenes in one batch (default)

Write every scene prompt yourself, send them in **one message** to Flow's agent, approve once. The agent only executes; it does not write the story.

```sh
sh .claude/skills/google-flow-video/scripts/run_batch.sh <TAB> <batch.json>
```

`batch.json`: `{ "chars": ["Character name", ...max 3], "scenes": ["scene 1 prompt", "scene 2 prompt", ...] }`.

- Characters are attached **to the whole message**, so every scene in a batch shares the same ≤ 3 characters. Scenes needing a different set go in another batch (describe a 4th character in words).
- The script builds the message with a header ("create N separate videos, use prompts as written, scene labels are only for you, never put them in the videos") and starts each scene with `[Scene i]`. The scene prompts themselves must still **not** mention scene numbers (the script warns).
- The agent answers with **one approve chip for the whole batch**, plus the total cost (Omni: 15 credits per scene). The script prints the agent's plan, clicks "Phê duyệt" (Approve), then switches to the Video tab and waits until the clips are done. If the video count or cost does not match the scene count, stop and read the chat.
- Tested with 4 scenes in one message: no text on screen, characters on model, done in about 4 minutes after approval. For more scenes, split into batches of about 4-6 so results are easy to check.
- Tiles appear in the order the agent generates them. Match tiles to scenes by tile title (Flow names them from the content).

### One scene per message (to redo a single scene)

```sh
sh .claude/skills/google-flow-video/scripts/run_scenes.sh <TAB> <scenes.json> 0 1 2 ...
```

`scenes.json`: `[{ "chars": ["Exact character name"], "prompt": "..." }]`.

Per scene: wait until the agent is idle, attach characters via the chat "+" button (click the item in the picker; sometimes it adds right away), type the prompt, send, wait for a **new** approve chip, click "Phê duyệt" (newest chip, `nth:-1`).

- **Never click "Luôn phê duyệt" (Always approve).**
- Names in `chars` must match the saved Flow character names **exactly**.
- The script prints `!!` and stops when no approve chip shows; read the chat (`el text body`) to see what the agent asked.
- The agent may ask back (e.g. pick 3 characters). Then stop, fix the JSON, resend that scene.

### Waiting for clips

- **Go to the Video tab** (`@flow.navVideos`). Tiles only exist in the DOM on the Video tab: on Characters/Scenes, counting `flow-video-tile` stays 0 even when clips are done. Clips shown in the chat are only thumbnails.
- Done when, on the Video tab, the `flow-video-tile` count reaches the scene count and `@flow.progress` is 0. Tiles still showing `%` or "Đang trong hàng đợi" (queued) are not done.

## 5. Check and clean up

- Queued tiles (0%) are not `flow-video-tile` yet, so `el text {"css":"flow-video-tile"}` returns NOT_FOUND. Track progress with `el text body` or `@flow.progress`.
- Read a failure reason: `el text {"css":"flow-video-tile","nth":i}`. Fix the prompt per the filter table, resend.
- **Delete failed tiles** to keep the grid clean (the user wants this): click the "Xoá" (Delete) button in tiles containing "Không thành công" (Failed) until the count is 0.
- Delete extra/poor versions (e.g. one with on-screen text): right-click the tile, "Chuyển vào thùng rác" (Move to trash). Hover to read the tile title first so you do not delete the wrong one.
- Map tiles to scenes by hovering each tile and reading its title (newest tile is first in the grid).
- Screenshot to check for on-screen text, off-model characters, wrong scene content.

## 6. Download once

1. On the Video tab (`@flow.navVideos`), **do not click a tile** (that opens the editor).
2. `node run_workflow.js call input.shortcut '{"keys":"Control+A","target":{"tabId":<TAB>}}'` to select all.
3. Right-click a tile, choose "Tải xuống" (Download).
   - 2+ clips: multi-select menu (has "Bỏ chọn", Deselect), downloads one zip `tải xuống.zip`.
   - 1 clip: normal menu, "Tải xuống" opens a quality submenu; pick **720p (Kích thước gốc / Original size)**. The file is an `.mp4` named after the tile title, not a zip.
4. Files go to `%USERPROFILE%\Downloads`. Repeated names become `tải xuống (1).zip`...; take the newest.

Do not download tiles one by one.

## 7. Join the film

```sh
sh .claude/skills/google-flow-video/scripts/assemble.sh "<zip|mp4>" "<out_dir>" "<film_name>" <scene1_prefix> <scene2_prefix> ...
```

- A prefix is the start of a file name in the zip. File name = tile title, which Flow **writes itself** from the content (e.g. `Man_relights_lighthouse_lamp_…`), not the start of the prompt. List the zip (`unzip -l`) or hover tiles to see which is which.
- The script unzips into its own folder, renames to `scene_01..` in order, checks codecs match, joins with `-c copy`, and writes a contact sheet (one frame per clip) to check order.
- Omni clips match (1280x720, 24 fps, h264 + aac), so stream copy works. Otherwise it re-encodes.

## 8. Report

- Film path, duration, scenes that still have issues (off-model characters, missing reference images...).
- Say you checked visually, and that audio was not checked if you did not listen.
- New selectors found: `sel add`; ask the user before committing.
