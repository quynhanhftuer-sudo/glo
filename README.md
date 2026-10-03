# Glow Base backend

## Chạy thử trên máy (5 phút)
1. Cài Node.js 22.13 trở lên (nodejs.org).
2. `npm install`
3. Sao chép `.env.example` thành `.env`, điền `ADMIN_EMAIL` và `ADMIN_PASSWORD` (từ 8 ký tự).
4. `npm start` → mở http://localhost:3000
5. Đăng nhập bằng `ADMIN_EMAIL` + `ADMIN_PASSWORD` → có quyền Admin (menu avatar → Quản trị). Không thể đăng ký tài khoản admin bằng form.

Đăng ký không cần mã xác minh email; mỗi Gmail chỉ tạo được một tài khoản (Gmail bỏ qua dấu chấm và chữ hoa/thường: `a.b@gmail.com` và `ab@gmail.com` là một).

## Đưa lên mạng
Frontend và backend chạy chung một server (`public/index.html`), nên không cần CORS. Dùng Render / Railway / Fly.io / VPS:
- Start command: `npm start`; đặt `NODE_ENV=production`, `TRUST_PROXY=1`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` trong phần Environment.
- **Bắt buộc gắn ổ đĩa bền vững** (Persistent Disk / Volume) và trỏ `DATA_DIR` vào đó, nếu không database và ảnh sẽ mất mỗi lần deploy.
- Phải dùng HTTPS (các nền tảng trên đều có sẵn).

## Đăng nhập & phiên
- Tải lại trang (F5) **không** bị đăng xuất. Trình duyệt giữ cookie 30 ngày, nhưng **server** quyết định hết phiên: **15 phút không thao tác** (chuột, bàn phím, cuộn, chạm) thì phải đăng nhập lại; còn thao tác thì phiên tự kéo dài. Đổi thời gian bằng `SESSION_IDLE_SEC` (mặc định 900 giây).
- Nếu vẫn bị đăng xuất mỗi lần tải lại, nguyên nhân gần như chắc chắn nằm ở hosting, không phải ở code: (1) chưa gắn ổ đĩa bền vững / chưa đặt `DATA_DIR` nên database (gồm cả phiên đăng nhập) bị xoá mỗi lần máy chủ khởi động lại — server sẽ in cảnh báo `[CẢNH BÁO]` khi chạy production mà thiếu `DATA_DIR`; (2) chạy `NODE_ENV=production` nhưng truy cập bằng `http://` (cookie `Secure` bị trình duyệt bỏ) — giao diện sẽ báo "trình duyệt không giữ được phiên".

## Dữ liệu lưu ở đâu
`DATA_DIR/glowbase.db` (SQLite): tài khoản (mật khẩu băm scrypt), phiên đăng nhập, hồ sơ MUA + trạng thái duyệt, **đánh giá**, **yêu thích** (theo tài khoản), **danh sách concept đã bị admin xoá**. `DATA_DIR/uploads/`: ảnh MUA và ảnh đính kèm đánh giá (ảnh không còn ai dùng sẽ tự bị xoá). Sao lưu = copy thư mục này.
Trình duyệt không còn lưu hồ sơ, đánh giá hay yêu thích; chỉ giữ hai mốc thời gian/cờ nhỏ (`gb_last_act`, `gb_was_in`) để biết khi nào hết phiên.

## Quy tắc nghiệp vụ đã chốt
- Tên đăng nhập = Gmail đã đăng ký: **không đổi được** (giao diện khoá ô, server từ chối `PUT /api/me` nếu gửi email/username khác). Chỉ đổi được tên hiển thị, ảnh đại diện, mật khẩu.
- Hồ sơ đã duyệt mà MUA sửa lại → chuyển ngay về "chờ duyệt" và **biến mất khỏi trang công khai** cho tới khi admin duyệt lại (id concept giữ nguyên nên yêu thích/đánh giá cũ không mất). Giao diện cảnh báo trước khi MUA bấm sửa.
- Admin xoá concept/artist: ghi lên server, xoá luôn đánh giá + yêu thích của concept đó; hồ sơ MUA hết concept chuyển sang "chưa được duyệt".

## API (đều dưới `/api`)
`GET /boot` · `POST /session/ping` · `GET /favorites` · `PUT|DELETE /favorites/:mid` · `POST /reviews` · `PUT|DELETE /reviews/:id` · `POST /admin/concepts/delete {ids:[…]}` — cùng các API đăng ký/đăng nhập/hồ sơ/duyệt đã có.

## Kiểm tra
`npm test` chạy các phép thử tự động (đăng ký, mã sai, phân quyền, XSS, ảnh giả, duyệt hồ sơ, sửa hồ sơ đã duyệt, yêu thích, đánh giá, xoá concept, hết phiên do không thao tác…).
