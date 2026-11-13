# ĐỀ ÁN SẢN PHẨM: LOCALKAN

**Nền tảng Quản trị Dự án Localkan & Điều phối Đa AI Agent (Local-First SaaS)**

---

## 1. TỔNG QUAN DỰ ÁN (EXECUTIVE SUMMARY)

### 1.1. Bối cảnh & Vấn đề (Problem Statement)

Trong kỷ nguyên lập trình với AI hiện nay, các lập trình viên và đội ngũ phát triển phần mềm thường điều khiển các AI Coding Agent (như Claude Code, AGY, Codex, Cursor CLI...) thông qua giao diện dòng lệnh (Terminal) hoặc cửa sổ Chat truyền thống. Phương pháp này bộc lộ nhiều hạn chế nghiêm trọng khi quy mô dự án mở rộng:

- **Dễ trôi thông tin & mất ngữ cảnh:** Khó theo dõi tiến độ khi chạy nhiều tác vụ cùng lúc.
- **Xung đột mã nguồn:** Các Agent làm việc chung trên một thư mục dễ ghi đè code của nhau.
- **Khó quản lý tiến độ nhóm:** Project Manager (PM) hoặc Tech Lead không thể nắm bắt trạng thái công việc của AI một cách trực quan như các công cụ quản lý dự án truyền thống (Trello, Jira).
- **Nỗi lo rò rỉ dữ liệu (Privacy Concerns):** Các giải pháp AI quản lý dự án trên Cloud yêu cầu đẩy mã nguồn lên máy chủ bên thứ ba, vi phạm quy định bảo mật (NDA) của doanh nghiệp.

### 1.2. Giải pháp (Solution)

Xây dựng một **nền tảng SaaS quản lý dự án theo mô hình Kanban (tương tự Trello)** kết nối trực tiếp với **bộ lõi điều phối Orca IDE (Headless Runtime)** chạy ngầm trên máy cá nhân của người dùng.

- Mỗi thẻ công việc (Task Card) trên bảng Kanban tương ứng với một không gian làm việc cô lập (**Git Worktree**) dưới máy khách, được giao cho một AI Agent chuyên biệt tự động thực thi.
- Áp dụng kiến trúc **Local-First & Zero-Knowledge Source Code**: Toàn bộ mã nguồn, API Key và lịch sử thực thi nằm gọn tại máy cá nhân của khách hàng; Server Cloud chỉ đóng vai trò bảng điều khiển trực quan và trạm trung chuyển tín hiệu.

---

## 2. KIẾN TRÚC HỆ THỐNG & LUỒNG VẬN HÀNH (SYSTEM ARCHITECTURE)

Hệ thống được thiết kế theo mô hình **Hybrid Cloud - Local Bridge (3 Lớp)** nhằm tối ưu chi phí vận hành máy chủ và đảm bảo bảo mật tuyệt đối:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CLOUD SAAS (WEB / MOBILE)                        │
│  [ Giao diện Kanban UI ]  ◄───(WebSockets / REST)───►  [ Main Backend ] │
│  (Quản lý Task, Diff Viewer, Ask/Act Toggle)          (Metadata & Auth) │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ (Encrypted WebSocket / Message Queue)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  MÁY TÍNH CÁ NHÂN KHÁCH HÀNG (LOCALHOST)                │
│                                                                         │
│  [ Local Desktop Bridge (Tauri / Rust) ] ◄──► [ Embedded SQLite DB ]    │
│          │                                    (Lịch sử chat, Memory)    │
│          ▼ (Quản lý tiến trình PTY / CLI)                               │
│  [ Embedded Orca Headless Engine ]                                      │
│          ├──► Worktree #101 ──► [ Claude Code CLI ]                     │
│          ├──► Worktree #102 ──► [ AGY CLI ]                             │
│          └──► Worktree #103 ──► [ Codex / Cursor CLI ]                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.1. Thành phần cốt lõi

1. **Cloud SaaS (Frontend & Main Backend):**
   - Cung cấp giao diện bảng Kanban, quản lý tài khoản, phân quyền team và thanh toán gói cước.
   - Chỉ lưu trữ dữ liệu quản lý vô hại (Metadata): Tên bảng, tiêu đề thẻ, trạng thái cột, thông tin tài khoản. Tuyệt đối không lưu mã nguồn.
2. **Local Desktop Bridge (Đóng gói Tauri/Rust):**
   - Ứng dụng siêu nhẹ (~5–10MB) chạy ngầm dưới thanh tác vụ (System Tray) trên Windows, macOS và Linux.
   - Nhúng sẵn bộ lõi thực thi ngầm của Orca (`Headless Binary`) bên trong bộ cài đặt giúp người dùng cài đặt **1-Click** mà không cần tự cấu hình Orca hay Node.js phức tạp.
   - Sử dụng giả lập Terminal (`PTY`) để điều phối các CLI Agent có sẵn trên máy khách (`claude`, `agy`, `codex`...) và bắt các luồng log theo thời gian thực.
3. **Embedded Local Database (SQLite):**
   - Lưu trữ toàn bộ lịch sử trò chuyện, đoạn mã thay đổi (`git diff`) và trí nhớ dự án (`PROJECT_RULES.md`) ngay tại ổ cứng máy khách.

### 2.2. Luồng vận hành tiêu chuẩn (Workflow)

| Trạng thái Kanban     | Hành động trên Frontend                            | Cơ chế xử lý bên dưới (Local Bridge & Orca Engine)                                                                                       |
| :-------------------- | :------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| **To Do**             | Tạo thẻ Task, gán nhãn và chọn AI Agent phụ trách. | Lưu Metadata lên Cloud. Chưa tiêu tốn tài nguyên máy khách.                                                                              |
| **In Progress**       | Kéo thả thẻ sang cột _In Progress_.                | Bridge gọi `orca worktree create --name task-id --agent <cli>`, tạo nhánh Git riêng biệt và kích hoạt Agent tự động viết code.           |
| **Human-in-the-loop** | Thẻ hiện cảnh báo cần xác nhận từ con người.       | Agent dừng lại hỏi quyền (`[Y/n]`). Bridge dịch thành nút bấm **Approve / Reject** trên Web để người dùng tương tác 1 chạm.              |
| **Review**            | Agent hoàn thành và đẩy thẻ sang _Review_.         | Bridge trích xuất `git diff` gửi lên Web hiển thị trực quan. Người dùng có thể comment trực tiếp trên từng dòng code để yêu cầu sửa lại. |
| **Done**              | Người dùng duyệt code và kéo thẻ sang _Done_.      | Tự động tạo Pull Request (nếu cấu hình) và gọi `orca worktree rm` để dọn dẹp ổ cứng.                                                     |

---

## 3. DANH SÁCH TÍNH NĂNG CHI TIẾT (FEATURE SPECIFICATIONS)

### 3.1. Nhóm tính năng Quản trị Kanban & Tương tác Ngữ cảnh (Cloud UI)

- **Bảng Kanban Đa Nhiệm (Smart Kanban Board):** Kéo thả thẻ kích hoạt AI tự động; hỗ trợ chạy song song nhiều Agent trên các tác vụ độc lập mà không xung đột code.
- **Tách biệt Chế độ Hỏi & Làm (Ask Mode vs. Act Mode):**
  - _Ask Mode (`/ask`):_ Cho phép đặt câu hỏi tìm hiểu codebase hoặc nhờ AI tư vấn giải pháp ở chế độ chỉ đọc (Read-only), không làm thay đổi file hay trạng thái thẻ. Hỗ trợ chuyển đổi câu trả lời thành các thẻ Task mới chỉ với 1 cú nhấp chuột.
  - _Act Mode (`/do`):_ Ra lệnh cho Agent trực tiếp sửa code và chạy lệnh kiểm thử.
- **Giao tiếp gắn liền ngữ cảnh (Contextual Communication):**
  - _Inline Code Review Comments:_ Bôi đen đoạn code trong tab Diff Viewer để để lại nhận xét; hệ thống tự đóng gói vị trí dòng code kèm yêu cầu gửi lại cho Agent sửa.
  - _Interactive Action Cards:_ Chuyển hóa các câu hỏi dòng lệnh khô khan thành nút bấm lựa chọn trực quan trên mặt thẻ.
  - _Escape Hatch Terminal:_ Mở cửa sổ terminal trực tiếp (`xterm.js`) kết nối thẳng vào phiên làm việc của Orca khi lập trình viên muốn tự tay can thiệp sâu.
- **Live Stream Log & Thanh tiến độ:** Hiển thị tiến trình AI gõ code theo thời gian thực và tự động phân tích log để cập nhật phần trăm hoàn thành.

### 3.2. Nhóm tính năng Đồng bộ & Tối ưu hóa Token (AI Efficiency Engine)

- **Đồng bộ trí nhớ có chọn lọc (Selective Context Sync):**
  - _Handoff Summary:_ Khi Agent hoàn thành Task A, tự động sinh bản tóm tắt ngắn (100–200 chữ) về các thay đổi cốt lõi để truyền làm ngữ cảnh đầu vào cho Task B có liên kết phụ thuộc.
  - _Shared Rules (`PROJECT_RULES.md`):_ Lưu các quy tắc lập trình của dự án thành file markdown trong thư mục gốc, giúp đồng bộ tự động qua Git cho toàn bộ thành viên trong team.
- **Bộ máy tiết kiệm Token (Giảm 50–70% chi phí API):**
  - _Context Pruning & Auto-Summarizer:_ Tự động dùng model giá rẻ (Haiku / GPT-4o-mini) nén các tin nhắn hội thoại cũ thành bản tóm tắt ngắn, chỉ giữ nguyên vẹn 5 lượt trao đổi gần nhất.
  - _Diff-Only Injection:_ Chỉ gửi đoạn mã thay đổi (`git diff`) kèm 10 dòng xung quanh thay vì bắt AI đọc lại toàn bộ file mã nguồn.
  - _Prompt Caching Optimization:_ Cố định cấu trúc hướng dẫn hệ thống ở đầu Prompt để tận dụng cơ chế giảm giá 90% token lặp lại của các nhà cung cấp AI.

### 3.3. Nhóm tính năng Đóng gói & Kết nối AI (Local Bridge)

- **Zero-Config Agent Discovery:** Tự động quét hệ thống để nhận diện các CLI Agent đã cài sẵn (`claude`, `agy`, `codex`, `cursor`) và kế thừa sẵn phiên đăng nhập (OAuth/API Key) của người dùng. Hỗ trợ cài đặt nhanh 1-Click nếu máy chưa có.
- **Mô hình kết nối AI linh hoạt:**
  - _BYOK (Bring Your Own Key/Subscription):_ Tiêm trực tiếp API Key từ két sắt hệ điều hành (Keychain/Credential Manager) vào biến môi trường của Orca.
  - _Local LLM Support:_ Hỗ trợ kết nối Ollama chạy model nội bộ cho các doanh nghiệp yêu cầu cách ly mạng hoàn toàn.

---

## 4. CHIẾN LƯỢC BẢO MẬT & LỢI THẾ CẠNH TRANH (MOAT & ANTI-LEAK)

### 4.1. Chống rò rỉ dữ liệu khách hàng (Privacy-First Moat)

- **Kiến trúc Zero-Knowledge Source Code:** Cam kết mã nguồn không bao giờ đi qua máy chủ của nền tảng.
- **Tự động che giấu thông tin nhạy cảm (Local Secret Redaction):** Bộ lọc Regex chạy ngầm tại Local Bridge tự động phát hiện và làm mờ (`***REDACTED***`) các chuỗi chứa `API_KEY`, `TOKEN`, `PASSWORD`, IP nội bộ trước khi bắn luồng log lên giao diện Web.
- **Tùy chọn Sao lưu Mã hóa Đầu cuối (E2EE Cloud Sync):** Nếu khách hàng muốn xem lịch sử chat trên điện thoại khi tắt máy tính, dữ liệu được mã hóa bằng thuật toán **AES-256** ngay tại máy khách với mật khẩu riêng (Passphrase) của họ trước khi lưu lên Cloud.

### 4.2. Chống sao chép công nghệ (IP Protection)

- **Đóng gói nhị phân (Binary Bundling) & White-labeling:** Biên dịch lõi kết nối bằng ngôn ngữ **Rust (Tauri)** để chống dịch ngược mã nguồn; nhúng trực tiếp bản chạy ngầm của Orca (giấy phép MIT) dưới tên tiến trình nội bộ của sản phẩm.
- **Tầng phiên dịch Prompt độc quyền:** Xây dựng thuật toán phân rã Task và tự động định tuyến Agent (Smart Model Routing) trên Backend Cloud để tạo ra chất lượng đầu ra vượt trội so với việc gọi CLI thô.

---

## 5. PHÂN TÍCH THỊ TRƯỜNG & ĐỊNH VỊ THƯƠNG HIỆU

### 5.1. Bối cảnh cạnh tranh

Thị trường đã xuất hiện các sản phẩm tiên phong chứng minh nhu cầu thực tế như _AgentKan_, _Kanboard_, _Kandev_ hay tính năng _Linear Agent_. Tuy nhiên, sản phẩm của chúng ta sở hữu **3 lợi thế khác biệt độc tôn (USP)**:

1. **Khai thác trọn vẹn sức mạnh đa Agent của Orca:** Điều phối mượt mà nhiều CLI Agent khác nhau (Claude Code, AGY, Codex...) cùng trình duyệt kiểm thử nhúng trên một giao diện thống nhất.
2. **Bảo mật Local-First triệt để:** Giải quyết rào cản lớn nhất của doanh nghiệp khi sử dụng AI SaaS bằng việc giữ toàn bộ dữ liệu kỹ thuật và SQLite tại máy khách.
3. **Trải nghiệm Human-in-the-loop & Tối ưu Token vượt trội:** Loại bỏ sự bất tiện của Terminal đen trắng và trực tiếp tiết kiệm chi phí vận hành AI cho người dùng.

### 5.2. Đề xuất Tên thương hiệu & Tên miền

- **Nhóm Điều phối Hạm đội (Khuyên dùng):** **AgentDeck** (`agentdeck.dev`), **FleetBoard** (`fleetboard.ai`), **SwarmTask**.
- **Nhóm Trực diện Kanban & Code:** **KanCode** (`kancode.dev`), **TaskPilot**, **DevCard**.
- **Nhóm Nhấn mạnh Bảo mật Local-First:** **LocalKan**, **VaultBoard**.
  _(Lưu ý: Tránh sử dụng từ khóa "Trello" hoặc "Orca" trong tên thương hiệu chính thức để đảm bảo tính độc lập pháp lý và dễ dàng gọi vốn)._

---

## 6. MÔ HÌNH KINH DOANH & BẢNG GIÁ ĐỀ XUẤT (PRICING STRATEGY)

Sử dụng mô hình **Freemium kết hợp Thu phí theo chỗ ngồi (Per-Seat)** và **Tiện ích mở rộng (Add-ons)**. Nhờ không phải gánh chi phí Token AI của người dùng, biên lợi nhuận gộp ước tính đạt **85% – 95%**.

| Tiêu chí / Tính năng       | Gói Starter (Miễn phí)              | Gói Pro ($15 / tháng)                 | Gói Team ($29 / user / tháng)             | Gói Enterprise (Từ $99+ / tháng)       |
| :------------------------- | :---------------------------------- | :------------------------------------ | :---------------------------------------- | :------------------------------------- |
| **Đối tượng mục tiêu**     | Lập trình viên cá nhân trải nghiệm. | Freelancer, Solo Dev làm nhiều dự án. | Startup, Team Dev (3–50 người).           | Công ty lớn, Ngân hàng, Fintech.       |
| **Số lượng Bảng Kanban**   | Tối đa 2 bảng                       | Không giới hạn                        | Không giới hạn                            | Không giới hạn                         |
| **Agent chạy song song**   | Tối đa 2 Worktrees                  | Tối đa 10 Worktrees                   | Không giới hạn                            | Không giới hạn                         |
| **Lưu trữ & Đồng bộ**      | Local SQLite                        | Local SQLite + Git Sync               | Local SQLite + Git Sync + **E2EE Backup** | **Self-Hosted Server** (Hạ tầng riêng) |
| **Tối ưu hóa Token**       | Cơ bản (Diff-only)                  | **Đầy đủ** (Summarizer & Caching)     | **Đầy đủ** + Kho Prompt dùng chung        | Tùy chỉnh model nén nội bộ (Local LLM) |
| **Tự động hóa & Quản trị** | Orca Headless cơ bản                | Auto tạo Pull Request, UI Preview     | Phân quyền thành viên, Báo cáo AI         | SSO, Audit Logs, Cam kết SLA 99.9%     |

- **Chính sách thanh toán năm (Annual Billing):** Giảm 20% (Gói Pro còn **$12/tháng**, thu một lần **$144/năm**) để tối ưu dòng tiền.
- **Nguồn thu phụ trợ (Managed AI Gateway Add-on):** Bán kèm gói nạp tín dụng AI (Credit) thông qua Gateway trung gian (tính phí quản lý ~10–15%) cho các khách hàng không muốn tự đăng ký nhiều tài khoản API lẻ.
