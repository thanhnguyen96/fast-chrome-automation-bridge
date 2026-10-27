---
name: fast-browser
description: High-speed, token-efficient Chrome browser automation. Optimizes automation speed by prioritizing direct DOM manipulation via javascript_tool, eliminating unnecessary intermediate screenshots, enforcing scale:0.5 for visual checks, and using active JS polling instead of blind sleeps. Use when automating web tasks, driving web apps (Google Flow, GitLab, etc.), or when fast browser interaction is requested.
---

# Fast Browser Automation

Chậm nhất là vòng lặp model (chụp → nghĩ → bấm, 10–30s/bước), không phải trình duyệt.
Muốn nhanh: giảm số vòng model, đẩy việc lặp lại vào script.

## 1. Ưu tiên bridge local (repo này)

Chạy trên Chrome đang mở của người dùng (đã đăng nhập), trong agent window riêng, không cướp focus.

```powershell
curl -s 127.0.0.1:8765/api/status          # server + extension online?
node bridge_server.js                       # nếu chưa chạy
node run_workflow.js sel test --url gemini.google.com
node run_workflow.js el click @flow.submit --url flow.google.com
node run_workflow.js el waitAppear "@flow.approve" "{\"timeout\":60000}" --url flow.google.com
node run_workflow.js screenshot shot.jpg --url flow.google.com   # CDP, không đổi tab
```

- Selector theo domain ở `selectors/<domain>.json`; thêm bằng `sel add` (không cần reload extension).
- Sửa `extension/**` thì `node run_workflow.js reload` + reload tab.
- Chi tiết lệnh: `README.md`. Kế hoạch tiếp: `WORKFLOW_PLAN.md`.

## 2. Khi dùng Claude in Chrome trực tiếp

- **DOM trước, ảnh sau:** đọc/bấm qua `find`, `read_page`, `javascript_tool`; không đoán tọa độ từ ảnh.
- **Không chụp bước trung gian.** Chỉ chụp khi người dùng muốn xem, cần kiểm tra hình/video, hoặc lỗi không đọc được qua DOM. Chụp thì `scale: 0.5`.
- **Poll, đừng sleep:** vòng chờ JS ngắn (≤ 30s mỗi lần gọi, tránh timeout CDP 45s), trả về trạng thái.
- **Gom bước:** một `javascript_tool` làm nhiều việc liền nhau thay vì nhiều lần gọi.

## 3. Google Flow

- Thao tác tốn credit (gửi prompt, Approve, tải) chỉ làm khi người dùng đồng ý; không bao giờ chọn "Always approve".
- Tải video: chuột phải tile → Download → chọn chất lượng (720p "Original size"). File về `%USERPROFILE%\Downloads`.
- Nối clip:
```powershell
ffmpeg -y -f concat -safe 0 -i list.txt -c:v copy -c:a aac -b:a 192k output.mp4
```
