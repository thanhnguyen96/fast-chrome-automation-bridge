# Fast Automation Bridge

[English](README.md) · **Tiếng Việt**

Điều khiển **Chrome đang mở của bạn** (đúng profile, đã đăng nhập) từ script local, không cướp focus, không phụ thuộc npm.

Gồm một extension Chrome MV3 và một bridge Node.js nhỏ, giao tiếp qua WebSocket trên `127.0.0.1`. Logic riêng từng site (ví dụ Google Flow) nằm trong module cắm thêm và từ điển selector theo domain, không gắn cứng vào lõi.

---

## Mục lục

- [Vì sao có dự án này](#vì-sao-có-dự-án-này)
- [Tính năng](#tính-năng)
- [Kiến trúc](#kiến-trúc)
- [Yêu cầu](#yêu-cầu)
- [Cài đặt](#cài-đặt)
- [Bắt đầu nhanh](#bắt-đầu-nhanh)
- [CLI](#cli)
- [HTTP API](#http-api)
- [Danh sách lệnh](#danh-sách-lệnh)
- [Element API](#element-api)
- [Từ điển selector](#từ-điển-selector)
- [Agent window](#agent-window)
- [Phát triển](#phát-triển)
- [Lộ trình](#lộ-trình)

---

## Vì sao có dự án này

Playwright, Puppeteer cần Chrome mở với `--remote-debugging-port`, mà Chrome 136+ chặn cờ này trên profile mặc định. Hệ quả là phải dùng profile riêng và đăng nhập lại mọi thứ.

Bridge này chạy trong chính Chrome bạn đang dùng:

- **Không đăng nhập lại.** Dùng nguyên cookie, tài khoản, extension sẵn có.
- **Góc nhìn giống hệt bạn.** Debug và test trên đúng trạng thái người dùng thấy.
- **Không đụng chuột, bàn phím, focus.** Việc tự động chạy trong cửa sổ riêng.
- **Chạy lại nhanh.** Workflow viết bằng script, không tốn vòng hỏi model ở mỗi bước.

## Tính năng

- **Locator linh hoạt:** CSS, XPath, text, ARIA, role, `nth` (cả số âm), `within`, mảng fallback, xuyên shadow DOM.
- **Từ điển selector theo domain** (`selectors/<domain>.json`). Thêm, sửa, test lúc chạy, không cần reload extension.
- **Hàm chờ:** `waitAppear`, `waitDisappear`, `waitEnabled`, `waitText`, `waitCount`, `waitNew`.
- **Input tin cậy** qua Chrome DevTools Protocol cho các trang bỏ qua sự kiện giả.
- **Agent window:** cửa sổ nền không focus, có tab group "Bridge". Chụp màn hình qua CDP, không đổi tab.
- **Site module:** đi kèm `flow.*` cho Google Flow.
- **Không phụ thuộc:** chỉ dùng built-in của Node.js, không bước build.

## Kiến trúc

```
CLI / script ──HTTP──▶ bridge_server.js ──WebSocket──▶ extension (service worker) ──▶ content script trong tab
              :8765                        :8765                                      └─ CDP (chrome.debugger)
```

```
.
├── extension/                     # Extension Chrome (Load unpacked)
│   ├── manifest.json
│   ├── background/
│   │   ├── index.js               # Đăng ký lệnh, khởi động
│   │   ├── connection.js          # WebSocket client, backoff 1s→10s, ping 20s
│   │   ├── commands.js            # Registry + dispatch
│   │   ├── tabs.js                # Chọn tab, agent window, chờ tải trang
│   │   ├── inject.js              # Inject core + site module khớp URL
│   │   ├── sites.js               # Bảng site module
│   │   ├── selectors.js           # Cache từ điển selector (đọc/ghi qua server)
│   │   ├── input.js               # Input tin cậy + chụp màn hình qua CDP
│   │   └── downloads.js           # downloads.wait, sự kiện download_complete
│   ├── content/
│   │   ├── core.js                # Locator, action, hàm chờ, registry workflow
│   │   └── router.js              # Định tuyến message
│   └── sites/
│       └── google_flow.js         # Workflow flow.*
├── selectors/                     # Từ điển selector theo domain (server quản lý)
├── test/elements.html             # Trang test Element API
├── .claude/skills/fast-browser/   # Skill cho Claude Code
├── bridge_server.js               # Server HTTP + WebSocket
├── run_workflow.js                # CLI và client require() được
└── WORKFLOW_PLAN.md               # Kế hoạch v2.6+
```

## Yêu cầu

- Google Chrome (hoặc trình duyệt Chromium hỗ trợ MV3)
- Node.js 22 trở lên

## Cài đặt

1. Mở `chrome://extensions/`, bật **Developer mode**.
2. Bấm **Load unpacked**, chọn thư mục `extension/`.
3. Khởi động bridge:

   ```bash
   node bridge_server.js
   ```

4. Kiểm tra kết nối:

   ```bash
   node run_workflow.js status
   # { "running": true, "extensionConnected": true, "extensionVersion": "2.5.0", ... }
   ```

Extension tự nối tới `ws://127.0.0.1:8765` và thử lại với backoff nếu server tắt.

> **Lưu ý về cổng:** `BRIDGE_PORT` đổi cổng của server và CLI. Extension đặt cứng `8765` trong `extension/background/connection.js`. Muốn đổi thì sửa cả ở đó.

## Bắt đầu nhanh

```bash
# Mở trang trong agent window (không cướp focus)
node run_workflow.js call tabs.open '{"url":"https://example.com"}'

# Đọc và tương tác
node run_workflow.js read title --url example.com
node run_workflow.js el click "text=More information" --url example.com

# Chụp màn hình qua CDP
node run_workflow.js screenshot page.jpg --url example.com
```

Dùng từ Node.js:

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

| Cờ | Ý nghĩa |
| --- | --- |
| `--tab N` | Chọn tab theo id |
| `--url substr` | Chọn tab có URL chứa chuỗi |
| `--timeout ms` | Timeout HTTP (mặc định: timeout của payload + 10s, hoặc 30s) |
| `--file f.json` | Đọc entries cho `sel add` từ file |
| `--raw` | In JSON một dòng, không rút gọn |

Locator dạng CSS, object JSON, hoặc tiền tố `text=` / `aria=` / `role=`. Lệnh trả `ok:false` thì CLI thoát với mã 1.

## HTTP API

| Method | Đường dẫn | Mô tả |
| --- | --- | --- |
| `GET` | `/api/status` | `{running, extensionConnected, extensionVersion, pending, uptimeSec}` |
| `POST` | `/api/command` | Body `{command, payload, timeoutMs}`, trả `{ok, data}` hoặc `{ok:false, error:{message, code}}` |
| `GET` | `/api/events?since=<seq>&waitMs=<0..60000>` | Long-poll sự kiện (bộ đệm vòng 200 mục) |
| `GET` | `/api/selectors/:domain` | Từ điển selector của domain (`{}` nếu chưa có file) |
| `PUT` | `/api/selectors/:domain` | Body `{merge:{...}, remove:[...]}`, ghi JSON có sort key |

## Danh sách lệnh

| Nhóm | Lệnh |
| --- | --- |
| Extension | `ext.ping`, `ext.reload` |
| Tab | `tabs.list`, `tabs.open`, `tabs.adopt`, `tabs.navigate`, `tabs.activate`, `tabs.close`, `tabs.reload` |
| Agent | `agent.window`, `agent.release` |
| Trang | `page.screenshot`, `downloads.wait` |
| Input tin cậy | `input.click`, `input.type`, `input.press` |
| DOM | `dom.query`, `dom.read`, `dom.exists`, `dom.waitFor`, `dom.click`, `dom.rightClick`, `dom.type`, `dom.press`, `dom.scroll`, `dom.locate` |
| Element | `el.click`, `el.rightClick`, `el.type`, `el.press`, `el.hover`, `el.waitAppear`, `el.waitDisappear`, `el.waitEnabled`, `el.waitText`, `el.waitCount`, `el.waitNew`, `el.text`, `el.attr`, `el.count`, `el.clickMenu` |
| Selector | `sel.list`, `sel.add`, `sel.remove`, `sel.test` |
| Workflow | `workflow.list`, `workflow.run` |
| Google Flow | `flow.newProject`, `flow.submitPrompt`, `flow.approveCredits`, `flow.waitComplete`, `flow.downloadAll`, `flow.status` |

`dom.type` trên contenteditable nhận `"html": true` để chèn giá trị dạng HTML (`execCommand('insertHTML')`) thay vì text thường. Lệnh chạy trong content script nên vẫn dùng được trên trang mà `page.eval` lỗi do extension khác chèn iframe (ví dụ Gmail compose). Với `clear` mặc định, nó thay toàn bộ nội dung editor, kể cả signature.

```sh
node run_workflow.js call dom.type '{"locator":{"css":"div[contenteditable=true][role=textbox]"},"value":"<p>Hi,</p><ul><li>item</li></ul>","html":true,"target":{"tabId":<TAB>}}'
```

## Element API

Mọi lệnh `el.*` nhận một `ref`, có thể là:

- một locator: `"button.go"`, `{ "role": "button", "text": "Save" }`
- một mảng fallback, locator đầu tiên khớp được dùng
- tên trong từ điển: `"@flow.submit"`
- object ghi đè: `{ "ref": "@flow.tile", "nth": -1, "within": "@flow.grid" }`

Mặc định locator chỉ khớp phần tử đang hiển thị. Thêm `"includeHidden": true` (alias của `"visible": false`) để chạm tới phần tử bị ẩn bằng CSS, ví dụ `<input>` thật nằm sau checkbox tự vẽ: `{ "css": "input[value=api]", "includeHidden": true }`. Đọc `checked` bằng `read`, hoặc đếm `:checked` bằng `el count`.

| Lệnh | Hành vi |
| --- | --- |
| `el.count` | Đếm phần tử khớp ngay lúc gọi |
| `el.waitAppear` | Chờ phần tử hiện (mặc định 15000 ms, poll 250 ms) |
| `el.waitDisappear` | Chờ phần tử bị gỡ hoặc ẩn |
| `el.waitEnabled` | Hiện và không `disabled` / `aria-disabled="true"` |
| `el.waitText` | Chờ text khớp chuỗi hoặc `{regex}` |
| `el.waitCount` | Chờ số lượng thỏa `op` (`>=`, `==`, `<=`) |
| `el.waitNew` | Ghi nhận phần tử hiện có, chạy action tùy chọn, chờ phần tử mới |
| `el.click` | Chờ enabled (mặc định 5 s) rồi bấm. Tùy chọn `trusted`, `button`, `delay`, `waitTimeout` |
| `el.rightClick` / `el.hover` / `el.type` / `el.press` | Chuột phải, rê chuột, gõ, nhấn phím |
| `el.text` / `el.attr` | Đọc text hoặc thuộc tính |
| `el.clickMenu` | Bấm lần lượt từng mục menu, chờ mục hiện trước khi bấm |

**`trusted`:** `true` dùng click qua CDP, `false` dùng sự kiện DOM giả. `'auto'` (mặc định) dùng CDP khi từ điển của domain đặt `_meta.trustedClick`.

**XPath:** chuỗi bắt đầu bằng `/`, `(` hoặc `./` được hiểu là XPath. Chuỗi khác là CSS.

**Mã lỗi:** `TIMEOUT`, `UNKNOWN_SELECTOR`, `SELECTORS_NOT_LOADED`, `NO_TAB`, `INJECT_FAILED`, `EXTENSION_OFFLINE`.

```bash
node run_workflow.js el waitAppear "@flow.approve" '{"timeout":60000}' --url flow.google.com
node run_workflow.js el clickMenu '["@flow.menuDownload",{"role":"menuitem","text":"720p"}]'
node run_workflow.js el type '{"ref":"@gemini.prompt","value":"hello"}' --url gemini.google.com
```

## Từ điển selector

Mỗi domain một file `selectors/<hostname>.json`. Trang `file://` dùng chung domain `_file`. Giá trị là một locator hoặc mảng fallback.

```json
{
  "_meta": { "trustedClick": true },
  "flow.submit": [
    { "css": "button.generate-icon-button" },
    { "role": "button", "aria": ["Bắt đầu tạo", "Start generation"] }
  ]
}
```

- Server quản lý file. Extension cache trong bộ nhớ và làm mới sau mỗi lần ghi.
- `sel.add {entries, test, strict}` test entry ngay trong tab đích. Kết quả có `{name, count, firstAlt, sample}` và cảnh báo khi count bằng 0 hoặc lớn hơn 20. Với `strict:true`, entry không khớp sẽ không được lưu.
- Site module khai báo giá trị mặc định bằng `Bridge.sel.defaults(map)`. Giá trị trong file luôn được ưu tiên.

```bash
node run_workflow.js sel add '{"x.btn":{"css":"button.go"}}' --url example.com
node run_workflow.js sel test @flow.submit @flow.prompt --url flow.google.com
node run_workflow.js sel remove x.btn --url example.com
```

## Agent window

Tương tự Claude in Chrome, bridge làm việc trong cửa sổ riêng, không focus, có tab group **Bridge**:

- `tabs.open {url}` mở trong agent window. Cửa sổ này được tạo ở trạng thái không focus khi dùng lần đầu. Thêm `foreground:true` để mở trong cửa sổ của bạn.
- `tabs.adopt {target}` chuyển một tab có sẵn vào agent window.
- `agent.window` liệt kê các tab agent và `focusedWindowId` để xác nhận cửa sổ của bạn vẫn giữ focus.
- `agent.release {target}` tháo debugger ngay, thanh "đang được gỡ lỗi" sẽ mất.
- Khi không chỉ rõ target, bridge ưu tiên tab trong agent window.
- Phiên CDP giữ 60 s khi rảnh và bật `Emulation.setFocusEmulationEnabled`, nên trang ở nền vẫn hoạt động như đang được focus.

> Không thu nhỏ hoặc che kín hoàn toàn agent window. Chrome sẽ throttle cửa sổ bị ẩn, làm timer chậm lại và có thể khiến chụp màn hình bị trống.

## Phát triển

| Bạn sửa | Cần làm |
| --- | --- |
| Selector qua `sel add` / `sel remove` | Không cần làm gì |
| Sửa tay `selectors/*.json` | Chạy một lệnh `sel add`/`sel remove` bất kỳ, hoặc reload extension |
| Bất kỳ file nào trong `extension/` | `node run_workflow.js reload`, rồi reload tab đích |
| `bridge_server.js` | Khởi động lại server |

Trang test: mở `test/elements.html` trong Chrome rồi chạy lệnh `el.*` với `--url elements.html`.

## Lộ trình

Xem [WORKFLOW_PLAN.md](WORKFLOW_PLAN.md):

1. **Auto-wait.** Kiểm tra actionability kiểu Playwright: visible, enabled, stable, không bị che.
2. **Workflow JSON.** Sửa nóng, không reload. Báo thời gian từng bước.
3. **Trace khi lỗi.** Lưu ảnh chụp, DOM và các phần tử gần đúng.
4. **Recorder.** Ghi thao tác thành workflow và selector.
