---
name: google-flow-video
description: Quy trình chuẩn tạo phim/video nhiều cảnh trên Google Flow (flow.google.com) qua bridge local - tạo nhân vật + giọng ở tab Nhân vật, gửi từng cảnh ở tab Cảnh qua agent chat (Omni), duyệt, dọn tile lỗi, chọn tất cả tải zip, nối bằng ffmpeg. Dùng khi người dùng muốn làm phim, truyện, clip nhiều cảnh, series video trên Google Flow.
---

# Google Flow: tạo phim nhiều cảnh

Bridge local điều khiển Flow trong agent window chạy nền (không chiếm chuột/focus).
Lệnh cơ bản và selector: xem skill `fast-browser` và `selectors/flow.google.com.json`.
Script hỗ trợ: `.claude/skills/google-flow-video/scripts/` (chạy từ thư mục gốc repo).

## 0. Chuẩn bị

```sh
curl -s 127.0.0.1:8765/api/status        # extensionConnected:true ?
node bridge_server.js                    # nếu chưa chạy (chạy nền)
node run_workflow.js call tabs.open '{"url":"https://flow.google.com","timeoutMs":45000}' --timeout 60000
node run_workflow.js workflow flow.newProject --tab <TAB>
```

- Lỗi websocket = server chưa chạy. Sửa `extension/**` thì `node run_workflow.js reload`.
- Ghi `tabId` lại, mọi lệnh sau đều `--tab <TAB>`.
- Nếu screenshot timeout: `node run_workflow.js call agent.keepAlive '{"target":{"tabId":<TAB>}}'`.
- Hỏi người dùng trước: số cảnh, phong cách, ngôn ngữ thoại. Mặc định model video **Omni** (rẻ, clip 10 giây).

## 1. Viết kịch bản trước (scenes.json)

Lưu kịch bản ra file trong scratchpad (không trong repo):

```json
[{ "chars": ["Tên nhân vật đúng như trong Flow"], "prompt": "..." }]
```

### Quy tắc viết prompt (quan trọng nhất)

- **Tiếng Anh toàn bộ**, chỉ câu thoại là tiếng Việt: `Dialogue in Vietnamese, <ai> says: "..."`.
- Mỗi cảnh là một mô tả **dễ hiểu với bất kỳ ai**, theo thứ tự:
  1. `10-second 3D animated video, 16:9.` (+ `Keep the attached characters exactly as they look in their reference images.` nếu có gắn nhân vật)
  2. **Location**: tả đặc điểm nhìn thấy được: kiến trúc, vật liệu, ánh sáng, thời tiết, giờ trong ngày, đồ vật. Không dùng địa danh hay tên nơi chốn mơ hồ/ít người biết; tả nơi đó trông như thế nào.
  3. **Characters**: gọi theo ngoại hình nhìn thấy (`the young man in the white jacket and red cape`), làm gì, biểu cảm. Tuổi dùng được nếu cần cho ngoại hình (xem cảnh báo bộ lọc bên dưới).
  4. **Camera**: góc máy, cỡ cảnh, chuyển động (wide shot, close-up, low angle, slowly moves closer...).
  5. **Sound**: nhạc, tiếng động.
  6. **Dialogue** tiếng Việt.
  7. Kết thúc bằng `No text on screen.`
- **Không** đưa vào prompt: tên truyện/phim, `Scene X of 10`, tên hãng/phong cách của studio nổi tiếng hay thập niên (`1950s Disney-style`...). Omni sẽ in dòng tiêu đề lên hình, và tên phong cách dễ bị chặn bản quyền.
- Mỗi tin nhắn = **1 cảnh**. Không nhờ agent của Flow tự lên kịch bản hay tự tạo nhân vật; nó làm kém.

### Bộ lọc của Omni (đã gặp thật)

| Thông báo | Nguyên nhân | Cách sửa |
|---|---|---|
| "lợi ích của các nhà cung cấp nội dung bên thứ ba" | Nhân vật/ảnh tham chiếu giống nhân vật nổi tiếng (vd công chúa tóc đỏ váy xanh kiểu phim hoạt hình lớn), tên truyện, tên phong cách studio | Bỏ ảnh tham chiếu của nhân vật đó trong cảnh, tả ngoại hình bằng chữ; bỏ chữ `princess`, `fairy-tale`; nếu vẫn lỗi thì thiết kế lại nhân vật cho khác hẳn |
| "nội dung gây hại liên quan đến trẻ vị thành niên" | Nhân vật nữ trẻ + giường/đồ ngủ/nằm, nhất là kèm tuổi thấp | Ghi rõ `adult woman`; cho mặc quần áo kín (váy dài + khăn choàng); quay toàn cảnh thay vì cận nằm trên giường; bỏ con số tuổi trong cảnh này |
| "Omni supports up to 3 character references" | Gắn > 3 nhân vật | Gắn tối đa 3, nhân vật thứ 4 tả bằng chữ theo đúng thiết kế |
| "Rất tiếc, không tạo được video này" | Lỗi tạm | Gửi lại y nguyên |

- Lượt lỗi được **hoàn credit**, gửi lại không tốn thêm.
- Credit không phải ưu tiên: clip hỏng/có chữ/lệch nhân vật thì tự tạo lại, chỉ hỏi khi chi phí chênh rất lớn.

## 2. Tạo nhân vật thủ công (tab Nhân vật)

Làm **trước** khi tạo cảnh, mỗi nhân vật một lần, để mọi cảnh đồng bộ mặt + giọng.

```sh
sh .claude/skills/google-flow-video/scripts/make_char.sh <TAB> <chars.json> <index>
```

`chars.json`: `[{ "name", "voice", "desc", "info" }]`.

- `desc` (tiếng Anh, càng chi tiết càng tốt): `Full-body character reference sheet, front view, standing, plain light background` + phong cách + vóc dáng, khuôn mặt (hình mặt, da, mắt, lông mày, mũi, môi, biểu cảm), tóc (màu, độ dài, kiểu), trang phục từng lớp (màu, chất liệu, chi tiết viền), phụ kiện. Kết thúc `Consistent design, no text, no watermark.`
- `voice`: tên giọng có sẵn trong danh sách của Flow. Các giọng đã thấy: Achernar (nữ, nhẹ, cao), Achird (nam, thân thiện), Algenib (nam, khàn, trầm), Algieba (nam, thoải mái, trầm vừa), Alnilam (nam, chắc), Aoede (nữ, thoáng), Autonoe (nữ, sáng), Callirrhoe (nữ), Charon (nam, trầm), Despina (nữ, mượt), Enceladus (nam, hơi thở), Erinome (nữ, trong), Fenrir (nam, trẻ, hăng).
- `info`: tính cách + `In all dialogue <he/she> speaks Vietnamese with a <...> voice.`
- **Không tạo nhân vật quá giống nhân vật nổi tiếng** (công chúa tóc đỏ váy xanh ngọc đã khiến mọi cảnh có ảnh tham chiếu đó bị chặn). Chọn phối màu, kiểu tóc, trang phục riêng.

Các bước script làm (để tự làm tay nếu cần):
1. `@flow.navCharacters`, rồi bấm thẻ "Nhân vật mới" (từ nhân vật thứ 2 trở đi danh sách hiện trước).
2. Gõ `desc` vào `@flow.charPrompt`, bấm `@flow.charSubmit`.
3. **Chờ `@flow.charImageReady`** (nút tải ảnh), không chờ ô tên (ô tên hiện sớm khi ảnh đang tạo).
4. Gõ tên vào `@flow.charName` + Enter.
5. `@flow.charVoice`, chọn giọng trong dialog, **bấm `@flow.voiceAdd`** ("Thêm vào nhân vật"). Chỉ chọn mà không bấm nút thì giọng không được gán.
6. Gõ `info` vào `@flow.charInfo`, bấm `@flow.charDone`.

Kiểm tra lại danh sách nhân vật bằng screenshot. Nhân vật nào đã tạo và ổn thì giữ, không làm lại.

## 3. Cài đặt agent (tab Cảnh)

- Vào `@flow.navScenes`. Mở cài đặt chat (nút `tune`):
  - Video: **16:9, x1, Omni 1.1 Flash**, bấm "Lưu".
  - Giữ "Xác nhận trước khi tạo" = **Luôn luôn**.
- Bắt đầu phiên chat mới (`@flow.chatNew`) cho mỗi lượt lớn để tránh agent lẫn ngữ cảnh cũ.
- **Không bấm chip "Tác nhân" ở ô nhập dưới đáy**: nó tắt chế độ agent và chuyển sang tạo ảnh. Nút sách cạnh ô nhập là "Chỉ dẫn cho tác nhân", không phải chat.

## 4. Gửi từng cảnh

```sh
sh .claude/skills/google-flow-video/scripts/run_scenes.sh <TAB> <scenes.json> 0 1 2 ...
```

Mỗi cảnh: chờ agent rảnh, gắn nhân vật bằng nút "+" trong chat (click item trong picker, có lúc tự thêm luôn), gõ prompt, gửi, chờ chip duyệt **mới**, bấm `Phê duyệt` (chip mới nhất, `nth:-1`).

- **Không bao giờ bấm "Luôn phê duyệt"**.
- Tên trong `chars` phải khớp **đúng** tên nhân vật đã lưu trong Flow.
- Script in `!!` và dừng nếu không thấy chip duyệt; đọc chat (`el text body`) để xem agent hỏi gì.
- Agent có thể hỏi ngược lại (vd chọn 3 nhân vật). Khi đó dừng script, sửa `scenes.json`, gửi lại cảnh đó.
- Sau khi gửi hết, theo dõi lưới tile: tile còn `%` hoặc "Đang trong hàng đợi" là chưa xong.

## 5. Kiểm tra và dọn

- Đọc lý do lỗi: `el text {"css":"flow-video-tile","nth":i}`. Sửa prompt theo bảng bộ lọc, gửi lại.
- **Xoá tile lỗi** để lưới sạch (người dùng muốn vậy): lặp bấm nút `Xoá` trong tile có chữ "Không thành công" cho tới khi đếm = 0.
- Xoá bản thừa/kém (vd bản có chữ trên hình): chuột phải tile, "Chuyển vào thùng rác". Rê chuột để đọc tiêu đề tile trước khi xoá, tránh xoá nhầm.
- Map tile với cảnh: rê chuột lên từng tile và đọc tiêu đề (tile mới nhất nằm đầu lưới).
- Chụp nhanh để kiểm tra chữ trên hình, nhân vật lệch, cảnh sai nội dung.

## 6. Tải về một lần

1. Ở tab Video (lưới), **không click vào tile** (click mở trình chỉnh sửa).
2. `node run_workflow.js call input.shortcut '{"keys":"Control+A","target":{"tabId":<TAB>}}'` để chọn tất cả.
3. Chuột phải lên một tile, chọn menu "Tải xuống" (menu nhiều mục có "Bỏ chọn" là đúng menu chọn nhiều).
4. File zip về `%USERPROFILE%\Downloads` (tên dạng `tải xuống.zip`).

Không tải từng tile một.

## 7. Nối phim

```sh
sh .claude/skills/google-flow-video/scripts/assemble.sh "<zip>" "<out_dir>" "<film_name>" <prefix_cảnh_1> <prefix_cảnh_2> ...
```

- Prefix là đầu tên file trong zip (tên file = tiêu đề tile, vd `Prince_discarding`).
- Script giải nén vào thư mục riêng, đổi tên `scene_01..` theo thứ tự, kiểm tra cùng codec, nối bằng `-c copy`, tạo ảnh contact sheet để kiểm tra thứ tự.
- Clip Omni giống nhau (1280x720, 24fps, h264 + aac), nên nối copy được. Nếu khác codec, encode lại.

## 8. Báo cáo

- Đường dẫn file phim, thời lượng, những cảnh còn điểm chưa ổn (nhân vật lệch, thiếu ảnh tham chiếu...).
- Nói rõ mình đã kiểm tra bằng hình, chưa nghe tiếng nếu chưa nghe.
- Selector mới tìm được thì `sel add`, hỏi người dùng trước khi commit.
