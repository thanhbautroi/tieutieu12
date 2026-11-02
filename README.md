# Game lớp học ảo pixel — Trung tâm ngoại ngữ Tiểu Tiểu

Game web nhiều người chơi cho lớp học tiếng Trung: học sinh và giáo viên vào chung một
phòng học pixel, di chuyển, trò chuyện và chơi các trò chơi học từ vựng do giáo viên dẫn dắt.
Bản kế hoạch đầy đủ nằm ở thư mục cha: `../files/ke-hoach-game-lop-hoc-pixel/`.

## Trạng thái

- **Giai đoạn 0 — khung project: XONG.** Server real-time chạy được, client vào được phòng,
  nhiều máy thấy nhau di chuyển và chat theo thời gian thực.
  Kiểm chứng: mô phỏng 3 máy cùng vào phòng K35 — tất cả kiểm tra đều đạt (xem `server/test/simulate.js`).
- **Đăng nhập, đăng ký và tạo nhân vật: đang triển khai.** Tài khoản học sinh được tạo công khai;
  quyền giáo viên và quản trị không thể tự chọn khi đăng ký. Tài khoản quản trị đầu tiên được
  khởi tạo bằng mã dùng một lần; sau đó quản trị có thể cấp quyền giáo viên hoặc tạo tài khoản
  giáo viên trực tiếp trong bảng quản lý ở phòng học. Mật khẩu được đặt khi tạo và không thể tự
  chọn quyền giáo viên từ màn hình đăng ký.
- Sau khi đăng ký hoặc đăng nhập vào tài khoản chưa có nhân vật, người chơi được chuyển tới màn
  hình tạo nhân vật; biệt danh và ngoại hình được lưu trong MongoDB trước khi vào phòng K35.
- Đăng nhập vào tài khoản đã có nhân vật sẽ mở bản đồ khuôn viên; chọn Lớp học để vào phòng
  real-time. Cửa hàng khuôn viên bán vật phẩm trang trí; nhà và trang trại vẫn là điểm đến xem trước.
- Menu người chơi có hồ sơ cấp độ/EXP/Xu và rương vật phẩm riêng; dữ liệu nằm trên tài khoản
  trong MongoDB. Tài khoản mới bắt đầu ở cấp 1, 0 EXP, 0 Xu và rương trống. Vật phẩm mua ở cửa
  hàng được lưu vào rương; trò chơi đố từ vựng thưởng EXP/Xu.
- Hồ sơ được đọc qua `GET /api/auth/account`; mỗi tài liệu tài khoản lưu `gameStats`
  (`level`, `exp`, `xu`) và mảng `inventory` riêng (`itemId`, `name`, `category`, `quantity`).
- Trong lớp K35, giáo viên/quản trị có thể nhập file câu hỏi `.xlsx` hoặc `.csv` trong Menu → Trò
  chơi rồi khởi động trò chơi đố từ vựng trắc nghiệm. Học sinh chọn A/B/C/D bằng cách gửi chữ cái
  đó trong khung chat; các đáp án vẫn hiển thị phía trên. Mỗi học sinh có một lượt cho mỗi câu; người
  trả lời đúng đầu tiên nhận 10 EXP và 10 Xu. Cứ đủ 100 EXP thì lên một cấp; giáo viên chuyển câu
  tiếp theo hoặc kết thúc trò chơi. Bộ câu hỏi mẫu có thể tải ngay trong menu. Ghép thẻ từ vựng
  vẫn đang phát triển.
- Cửa hàng có các danh mục quần áo, phụ kiện, cánh và pet. Giá hiện tại từ 35 đến 300 Xu; mỗi món
  chỉ mua một lần trên mỗi tài khoản. Vật phẩm hiện được lưu trong rương, còn mặc/trang bị lên nhân
  vật sẽ triển khai ở bước tiếp theo; cánh và pet chỉ mang tính trang trí, không tăng chỉ số.
- Giai đoạn thử nghiệm chỉ mở **1 server duy nhất tên K35** (20-28 người/phòng).

## Cấu trúc

```
project/
  client/     Giao diện game (HTML/CSS/JS + canvas pixel)
  server/     Server real-time Node.js + Socket.io
  .env.example  Mẫu biến môi trường
```

Khi chạy local, client tĩnh được server Node phục vụ chung một cổng và trạng thái phòng nằm
trong bộ nhớ. Bản deploy Vercel dùng adapter WebSocket cùng trạng thái game chia sẻ qua MongoDB.

## Cách chạy thử

Tạo file `.env` ở thư mục gốc từ `.env.example`, rồi điền chuỗi kết nối MongoDB Atlas
đầy đủ. Server yêu cầu MongoDB để lưu tài khoản và phiên đăng nhập; không có chế độ lưu
tài khoản tạm trong bộ nhớ.

```powershell
Copy-Item .env.example .env
```

Lấy hostname và URI từ Atlas > Connect > Drivers. Mật khẩu có ký tự đặc biệt cần URL-encode
trong URI. Chỉ giữ URI trong `.env` cục bộ; nếu thông tin đăng nhập từng bị lộ, hãy đổi mật
khẩu database trước khi kết nối.

```bash
npm install
npm start
# Mở http://localhost:3001 trên trình duyệt (mở nhiều tab/cửa sổ để giả lập nhiều người chơi)
```

Mật khẩu tài khoản được băm trước khi lưu. Cookie phiên đăng nhập là `HttpOnly`, `SameSite=Strict`;
chạy production qua HTTPS để cookie được bật thuộc tính `Secure`.

### Tạo quản trị viên đầu tiên

1. Tạm đặt `ADMIN_BOOTSTRAP_TOKEN` thành một chuỗi ngẫu nhiên dài trong `.env`, rồi khởi động server.
2. Gửi `POST /api/auth/bootstrap-admin` với JSON gồm `bootstrapToken`, `username`, `password`.
   Mật khẩu cần dài ít nhất 10 ký tự; tên đăng nhập gồm 3-20 chữ cái, chữ số hoặc `_`.
3. Sau khi tạo quản trị viên, xóa `ADMIN_BOOTSTRAP_TOKEN` khỏi `.env` và khởi động lại server.
   Quản trị viên đăng nhập bình thường; các tài khoản đăng ký công khai chỉ có quyền học sinh.
4. Dùng `GET /api/auth/admin/users` để xem tài khoản; dùng
   `PATCH /api/auth/admin/users/:id/role` với `{ "role": "teacher" }` để cấp quyền giáo viên.

Nếu quên mật khẩu quản trị, mở terminal tại thư mục `server` và chạy
`npm run reset-admin-password`. Nếu đã có quản trị viên, công cụ yêu cầu nhập lại tên tài khoản
để xác nhận và nhận mật khẩu mới không hiển thị trên màn hình; mọi phiên đăng nhập cũ sẽ bị thu
hồi. Nếu chưa có quản trị viên, công cụ hướng dẫn tạo tài khoản quản trị đầu tiên. Chỉ chạy trực
tiếp trong terminal trên máy có quyền truy cập file `.env`; không cung cấp thao tác này qua API
công khai.

Không chia sẻ file `.env`, chuỗi kết nối MongoDB hay mã khởi tạo quản trị viên.

File Excel/CSV cần có các cột: `Câu hỏi`, `Đáp án A`, `Đáp án B`, `Đáp án C`, `Đáp án D`,
`Đáp án đúng` (giá trị A/B/C/D), và `Giải thích` (không bắt buộc). Mỗi file tối đa 100 câu, 2 MB.
Chỉ gửi câu hỏi/đáp án tới lớp khi giáo viên bấm Khởi động; đáp án đúng không được gửi cho học sinh.

Giao dịch cửa hàng được máy chủ kiểm tra giá, số dư Xu và quyền sở hữu trong một lần cập nhật
MongoDB; không tin giá gửi từ trình duyệt.

Kiểm tra mô phỏng tự động (cần server đang chạy ở terminal khác). Lệnh này tạo ba tài khoản
thử nghiệm và nhân vật tương ứng trong database:

```bash
npm run test:simulate
```

Đặt lại mật khẩu quản trị bằng `npm run reset-admin-password` tại thư mục gốc.

## Biến môi trường

Sao chép `.env.example` thành `.env`:

| Biến | Ý nghĩa |
|---|---|
| `PORT` | Cổng server real-time (mặc định 3001) |
| `MONGODB_URI` | Chuỗi kết nối MongoDB Atlas đầy đủ; bắt buộc để server khởi động. |
| `DB_NAME` | Tên database (mặc định `tieu_tieu`). |
| `ADMIN_BOOTSTRAP_TOKEN` | Mã dùng một lần để tạo quản trị viên đầu tiên; xóa sau khi dùng. |
| `TRUST_PROXY` | Đặt `1` chỉ khi server đứng sau đúng một reverse proxy đáng tin cậy; mặc định `0`. |

## Deploy lên Vercel

Dự án dùng Vercel Functions cho HTTP API và Socket.IO WebSocket. Khi Vercel tạo nhiều
function instance, MongoDB Atlas chia sẻ trạng thái game; MongoDB change streams đồng bộ
broadcast giữa các instance. MongoDB Atlas phải dùng replica set (Atlas đáp ứng yêu cầu này).

1. Import repository GitHub vào Vercel, giữ thư mục gốc của dự án làm Root Directory.
2. Thêm `MONGODB_URI` trong Project Settings → Environment Variables bằng cách sao chép
   giá trị từ `.env` cục bộ trực tiếp vào Vercel; không đưa giá trị đó vào mã nguồn hoặc chat.
   Có thể đặt thêm `DB_NAME` và `ADMIN_BOOTSTRAP_TOKEN` nếu cần.
3. Deploy. Vercel phục vụ trang tĩnh từ `client/`, HTTP API từ `api/http.js` và kết nối
   WebSocket tại `/api/socket-io`.
4. Kiểm tra `/health`, đăng nhập và vào lớp. Nếu URI MongoDB bị giới hạn IP trong Atlas,
   cấu hình kết nối mạng cho môi trường deploy một cách an toàn; không mở rộng quyền truy cập
   database hơn mức cần thiết.

Socket.IO trên Vercel dùng WebSocket trực tiếp và tự gửi kiểm tra khi hết thời gian câu hỏi.
Trạng thái phòng game nằm trong collection `room_game_states`, còn broadcast liên tiến trình
được đồng bộ qua collection `socket_io_adapter_events`. Phần thưởng dùng giao dịch MongoDB
với mã chống cấp trùng khi function thử lại.

## Lộ trình

1. ✅ Giai đoạn 0: khung project + kiểm chứng nhiều máy vào chung phòng K35.
2. Giai đoạn 1: tài khoản đăng ký/đăng nhập, phân quyền học sinh/giáo viên (mã mời cho giáo viên),
   tạo nhân vật, lớp học + chat. ← cần `MONGODB_URI` từ thành.
3. Giai đoạn 2: game **Cướp Bàn Ghế Hán Tự** + kho câu hỏi (import Excel / link quiz, có bước duyệt).
4. Giai đoạn 3: các game còn lại (Nối Từ, Tìm Hán Tự, Nhập Vai mua bán).
5. Giai đoạn 4: cửa hàng, túi đồ, mở rộng bản đồ, nhân rộng ra các lớp khác của trung tâm.
