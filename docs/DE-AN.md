# ĐỀ ÁN SẢN PHẨM: PROOFGATE (tên tạm)

**Cổng kiểm soát đóng góp có dùng AI cho dự án mã nguồn mở và cho đội ngũ nhận code từ bên ngoài**

Phiên bản 2, ngày 12/11/2026. Bản này thay cho đề án Localkan (bản cũ lưu ở [DE-AN-v1.md](DE-AN-v1.md)).

> **Trạng thái:** đây là giả thuyết, chưa được kiểm chứng với khách hàng thật. Số liệu thị trường trong đề án lấy từ nguồn thứ cấp (báo chí, blog, khảo sát tự báo cáo) và chỉ nên coi là gần đúng. Mục 8 là kế hoạch kiểm chứng, nên làm trước khi đầu tư lớn.

---

## 0. VÌ SAO ĐỔI HƯỚNG

| Tiêu chí | Bản 1: Localkan | Bản 2: Proofgate |
| :-- | :-- | :-- |
| **Sản phẩm** | Bảng Kanban trên cloud điều khiển nhiều agent chạy trên máy dev (bọc Orca) | Bộ kiểm tra chính sách AI cho từng Pull Request từ người ngoài |
| **Người dùng đầu tiên** | Dev cá nhân, team dev | Người duy trì (maintainer) dự án mã nguồn mở |
| **Người trả tiền** | Dev và team (theo số người dùng) | Công ty đứng sau các dự án OSS lớn, rồi đến các công ty nhận code từ nhà thầu/agency |
| **Kênh tiếp cận** | Chưa rõ | Cộng đồng OSS, đúng thế mạnh của team |
| **Lợi thế** | Bảo mật local-first, tiết kiệm token | Trung lập giữa các agent và nền tảng, chuẩn hóa chính sách, cộng đồng |

**Lý do chính:**

1. **Lớp điều phối agent đã quá đông và đang thành miễn phí.** Đã có Orca (MIT, khoảng 122k sao, chính là engine bản 1 định dùng), Emdash (YC), Vibe Kanban (đã đóng gói trả phí từ 4/2026), Claude Squad, Conductor. Riêng OpenAI Symphony (4/2026, Apache 2.0) giao mỗi ticket trên bảng Linear cho một agent chạy trong không gian riêng, gần như đúng ý tưởng cốt lõi của bản 1, và được phát miễn phí.
2. **Bản 1 có mâu thuẫn nội tại.**
   - Cam kết "zero-knowledge" mâu thuẫn với việc gửi diff, log và terminal lên web.
   - "Bộ máy tiết kiệm token" không áp dụng được khi chỉ bọc CLI của người khác.
   - Đọc output PTY rất dễ vỡ.
   - Dùng OAuth của gói thuê bao cá nhân có rủi ro vi phạm điều khoản của nhà cung cấp.
3. **Team mạnh về cộng đồng dev và mã nguồn mở**, chứ không mạnh về bán hàng cho agency hay doanh nghiệp. Vì vậy cần một sản phẩm mà dev và maintainer tự tìm đến và tự cài.
4. **Lớp ghi nhận và lớp chính sách cục bộ cũng đã đông** (chi tiết ở mục 4.1):
   - Ghi nhận AI đã viết gì: chuẩn Agent Trace, git-ai, và Entire (do cựu CEO GitHub lập, vòng seed 60 triệu USD).
   - Chặn agent ngay trên máy dev: Endor Labs và ít nhất 6 dự án mã nguồn mở nhỏ.

   Khoảng trống còn lại là **kiểm tra ở ranh giới giữa hai bên**: khi code từ người ngoài đi vào repo của mình.

---

## 1. TỔNG QUAN

### 1.1. Bối cảnh & vấn đề

- **Agent đang tạo ra một phần lớn PR.** Theo số liệu GitHub được trích dẫn lại, đến năm 2026 agent khởi tạo hơn 40% số PR trên GitHub.
- **Maintainer bị quá tải.** Trong khảo sát của Linux Foundation Research (10/2026), maintainer ước tính khoảng 25% PR gửi đến là sản phẩm AI kém chất lượng. Ở các dự án lớn, con số này là 31%. Nỗi lo lớn nhất của họ là kiệt sức.
- **Các dự án phản ứng một cách thô bạo.**
  - tldraw tự động đóng mọi PR từ bên ngoài.
  - Ghostty chỉ nhận đóng góp có AI cho các issue đã được duyệt trước.
  - curl dừng chương trình bug bounty.
  - Theo báo chí, đội Codex chuyển sang chỉ nhận người được mời.
  - Maintainer của Godot công khai nói việc này "kiệt quệ".
- **Công cụ của GitHub mới chỉ là công tắc bật/tắt.** Năm 2026 GitHub thêm các tùy chọn tắt hẳn PR, chỉ nhận PR từ collaborator, và giới hạn số PR đang mở của người ngoài. Tính năng "chặn PR theo tiêu chí" được nói là sắp có. Chưa thấy tính năng nào cho việc khai báo hay kiểm chứng AI.
- **Chính sách đang viết bằng văn xuôi và thực thi bằng tay.** Các dự án viết `AI_CONTRIBUTING.md` hoặc CONTRIBUTING với các yêu cầu như:
  - khai báo có dùng AI,
  - issue phải được duyệt trước,
  - có bằng chứng test,
  - diff nhỏ,
  - mỗi người ngoài chỉ mở một PR có AI tại một thời điểm.

  Maintainer vẫn phải tự đọc từng PR để kiểm tra những điều này.
- **Doanh nghiệp gặp đúng vấn đề này với nhà thầu.** Hợp đồng thuê ngoài năm 2026 bắt đầu đòi nhà cung cấp khai báo công cụ AI, nơi lưu dữ liệu và việc dùng nhà thầu phụ (theo khuyến nghị của Morgan Lewis, Mondaq). Nhưng bên thuê không có cách kiểm chứng.

**Vấn đề cốt lõi:** chính sách AI đang nằm trong văn bản. Bằng chứng về việc dùng AI lại nằm rải rác ở các công cụ ghi nhận (Agent Trace, git-ai, Entire). Chưa có công cụ trung lập nào đối chiếu bằng chứng với chính sách ngay tại PR.

### 1.2. Giải pháp

Một **bộ máy chính sách đóng góp** mã nguồn mở và trung lập, gồm ba phần:

1. **File chính sách đọc được bằng máy** (ví dụ `.github/ai-policy.yml`). Đây là chính sách AI của dự án viết dưới dạng code, kèm bộ mẫu sẵn theo các phong cách phổ biến.
2. **Bộ kiểm tra PR** dạng GitHub Action (tự chạy trong CI của repo) và GitHub App (bản host sẵn). Sau đó mở rộng sang GitLab và Forgejo/Codeberg. Với mỗi PR, nó:
   - đọc phần khai báo AI (template của PR, commit trailer),
   - đọc bằng chứng nếu có (Agent Trace, git-ai notes, Entire checkpoints),
   - kiểm tra người gửi có thuộc danh sách tin cậy không (tương thích Vouch),
   - kiểm tra các quy tắc: issue đã duyệt, kích thước diff, có test, hạn mức PR đang mở.

   Kết quả trả về là một status check, nhãn, và một bình luận lịch sự nói rõ còn thiếu gì.
3. **CLI cho người đóng góp** (không bắt buộc). Nó tự sinh phần khai báo AI từ hook của agent mà người đó dùng, và cho kiểm tra trước khi mở PR. Đây là vòng lan truyền: người đóng góp cài một lần, dùng được ở mọi dự án có Proofgate.

**Nguyên tắc thiết kế:**

- **Kiểm tra quy tắc và bằng chứng, không đoán AI qua văn phong.** Bộ phát hiện AI theo văn phong không đáng tin và dễ buộc tội oan người đóng góp.
- **Mặc định không tự đóng PR.** Mặc định chỉ yêu cầu bổ sung thông tin. Maintainer luôn có quyền bỏ qua kết quả.
- **Chất lượng quan trọng hơn nguồn gốc.** Chính sách có thể cho phép dùng AI, miễn là khai báo và đạt chuẩn.

---

## 2. KIẾN TRÚC & LUỒNG VẬN HÀNH

```
┌──────────────────────────── MÁY NGƯỜI ĐÓNG GÓP (tùy chọn) ───────────────────────────┐
│  Agent (Claude Code / Codex / agy / Cursor) ──hook──► proofgate CLI                  │
│                                                     ├─ sinh phần khai báo AI         │
│  Công cụ ghi nhận có sẵn (Agent Trace / git-ai /    ├─ kiểm tra trước khi mở PR      │
│  Entire) ──────────────────────────────────────────►└─ đính kèm bằng chứng vào PR    │
└──────────────────────────────────────────┬───────────────────────────────────────────┘
                                           │  git push + mở Pull Request
                                           ▼
┌──────────────────────────────── FORGE (GitHub, sau đó GitLab/Forgejo) ───────────────┐
│  Pull Request ──sự kiện──► Proofgate checker                                         │
│                              ├─ đọc .github/ai-policy.yml                            │
│                              ├─ đọc khai báo + bằng chứng + danh sách tin cậy        │
│                              └─ trả: status check, nhãn, bình luận                   │
│  Chạy dạng GitHub Action (miễn phí, trong CI của repo) hoặc GitHub App (bản host)    │
└──────────────────────────────────────────┬───────────────────────────────────────────┘
                                           │  chỉ kết quả kiểm tra (bản trả phí)
                                           ▼
┌──────────────────────────────── PROOFGATE CLOUD (trả phí) ───────────────────────────┐
│  Dashboard tổ chức · Phân phối chính sách cho nhiều repo · Xuất bằng chứng audit     │
│  SSO/SAML · Báo cáo theo nhà thầu/vendor · Bản tự host cho doanh nghiệp              │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1. Ví dụ file chính sách (minh họa, định dạng chưa chốt)

```yaml
# .github/ai-policy.yml
version: 0
ai_use: allowed_with_disclosure     # forbidden | allowed_with_disclosure | allowed
disclosure:
  required: [tools, extent]          # công cụ nào, AI tham gia ở mức nào
  evidence: [agent-trace, git-ai, entire]   # loại bằng chứng chấp nhận (không bắt buộc)
outside_contributors:
  linked_issue: approved             # chỉ nhận PR cho issue đã được duyệt
  max_open_ai_prs: 1
  max_changed_lines: 400
  require_tests: true
trust:
  vouch: auto                        # đọc danh sách Vouch nếu repo có
on_fail: request_info                # request_info | label | close
```

### 2.2. Luồng vận hành tiêu chuẩn

| Bước | Điều xảy ra | Kết quả người dùng thấy |
| :-- | :-- | :-- |
| **1. Mở PR** | Forge gửi sự kiện tới checker | Status check "Proofgate" ở trạng thái đang chạy |
| **2. Kiểm tra tin cậy** | Người gửi là collaborator, được vouch, hay người mới? | Collaborator được áp quy tắc nhẹ hơn (tùy chính sách) |
| **3. Kiểm tra khai báo** | Có điền phần khai báo AI chưa? Có khớp bằng chứng đính kèm không? | Nếu thiếu: bình luận hướng dẫn cách khai báo, kèm link CLI |
| **4. Kiểm tra quy tắc** | Issue đã duyệt, kích thước diff, có test, hạn mức PR đang mở | Danh sách tiêu chí đạt/chưa đạt |
| **5. Kết luận** | Đạt, Cần bổ sung, hoặc Cần maintainer xem | Nhãn tương ứng; mặc định không tự đóng PR |
| **6. Maintainer quyết định** | Có thể bỏ qua kết quả bằng lệnh `/proofgate override` | Ghi log quyết định (bản trả phí: lưu vào audit) |

---

## 3. DANH SÁCH TÍNH NĂNG

### 3.1. Bản mã nguồn mở (Apache-2.0, miễn phí cho mọi repo public)

- **Đặc tả file chính sách** kèm bộ kiểm tra cú pháp (`proofgate policy lint`), cùng các mẫu sẵn:
  - "Cấm AI"
  - "Cho phép, bắt buộc khai báo"
  - "Chỉ nhận cho issue đã duyệt" (giống Ghostty)
  - "Chỉ collaborator"
- **GitHub Action:** chạy trong CI của repo. Code không rời khỏi GitHub.
- **CLI cho người đóng góp:**
  - `proofgate check` để kiểm tra trước khi mở PR.
  - Tự sinh phần khai báo từ hook của các agent. Claude Code, Codex CLI (hook ổn định từ v0.124, 4/2026), Antigravity CLI `agy` (file `.agents/hooks.json`) và Cursor đều đã có hook.
- **Bộ đọc bằng chứng** cho Agent Trace, git-ai notes, Entire checkpoints. Mỗi định dạng là một adapter riêng; cộng đồng có thể viết thêm.
- **Tương thích Vouch:** dùng danh sách tin cậy sẵn có thay vì tự làm hệ thống mới.
- **Bình luận thân thiện, đa ngôn ngữ:** giải thích vì sao và cách sửa, không buộc tội.

### 3.2. Bản trả phí (cho tổ chức)

- **Phân phối chính sách** cho hàng trăm repo, có kế thừa (chính sách chung của tổ chức, ghi đè ở từng repo).
- **Repo private có người đóng góp bên ngoài** (nhà thầu, agency): chính sách gắn với hợp đồng, quy định nhà cung cấp AI, model và vùng dữ liệu được phép. Có báo cáo theo từng vendor.
- **Dashboard:** tỷ lệ PR có AI, tỷ lệ phải bổ sung, thời gian maintainer tiết kiệm được, xu hướng theo người đóng góp hoặc vendor.
- **Xuất bằng chứng audit** (PDF/CSV/JSON) cho hợp đồng, SOC 2, ISO 27001.
- **Quản trị doanh nghiệp:** SSO/SAML, phân quyền, chính sách lưu trữ dữ liệu, bản tự host.

### 3.3. Những thứ sẽ KHÔNG làm

- Không làm bộ điều phối agent hay bảng Kanban. Lớp này đã có Orca, Symphony và nhiều sản phẩm khác.
- Không làm công cụ ghi nhận mới. Dùng Agent Trace, git-ai và Entire.
- Không làm bộ "phát hiện AI" theo văn phong.
- Không làm AI gateway hay bán token.

---

## 4. CẠNH TRANH, LỢI THẾ & GIỚI HẠN

### 4.1. Bối cảnh cạnh tranh

| Nhóm | Ví dụ | Quan hệ với Proofgate |
| :-- | :-- | :-- |
| Tính năng có sẵn của forge | GitHub: tắt PR, chỉ collaborator, giới hạn số PR đang mở; "chặn theo tiêu chí" sắp có | **Rủi ro lớn nhất.** Hiện chỉ là bật/tắt, chưa đọc chính sách hay bằng chứng AI |
| Kiểm soát *ai* được đóng góp | Vouch (Mitchell Hashimoto; khoảng 4.7k sao, khoảng 150 repo theo một nguồn) | Bổ sung cho nhau: Vouch lo "ai", Proofgate lo "cái gì và có đúng chính sách không" |
| Công cụ PR nhỏ lẻ | anti-slop (Action), commit-check (kiểm tra AI attribution trong CI), MergeShield, PullMinder (GitHub App) | Đối thủ trực tiếp nhưng còn nhỏ và rời rạc. Có thể hợp tác hoặc tương thích |
| Ghi nhận AI | Agent Trace (chuẩn mở), git-ai (có gói Teams), Entire (60 triệu USD vốn seed) | **Nguồn dữ liệu đầu vào**, không phải đối thủ. Rủi ro: họ có thể mở rộng sang kiểm tra chính sách |
| Chính sách trên máy dev | Endor Labs, ai-hooks, Clash, Chock, coding-ethos | Khác vị trí: họ quản agent trong tổ chức mình, Proofgate kiểm tra code từ người ngoài |
| Review chất lượng bằng AI | CodeRabbit, Copilot Code Review | Bổ sung: họ chấm chất lượng code, Proofgate kiểm tra chính sách và bằng chứng |

### 4.2. Lợi thế có thể xây dựng (không có sẵn từ đầu)

1. **Trung lập.** Không thuộc nhà cung cấp agent nào, không thuộc forge nào. GitHub khó làm tốt cho GitLab và Forgejo; Cursor khó làm công cụ đọc bằng chứng của Entire.
2. **Trở thành định dạng chuẩn.** Nếu file `ai-policy.yml` được nhiều dự án dùng, người theo sau phải tương thích với mình. Nên đưa đặc tả ra cộng đồng (TODO Group, OpenSSF) để tăng độ tin cậy.
3. **Hiệu ứng mạng lưới từ người đóng góp.** Người đóng góp cài CLI một lần là dùng được ở mọi dự án. Dự án càng nhiều thì càng có lý do để cài, và ngược lại.
4. **Thư viện mẫu và tích hợp.** Việc này nhàm chán, nhưng đối thủ phải mất nhiều tháng mới đuổi kịp.

Ở giai đoạn đầu, lợi thế thật sự chỉ là **tốc độ và sự gần gũi với cộng đồng maintainer**.

### 4.3. Giới hạn kỹ thuật (phải nói rõ với người dùng)

- **Khai báo là tự báo cáo.** Bằng chứng chỉ có khi người đóng góp dùng công cụ ghi nhận. Proofgate **không chứng minh được việc không dùng AI**, nên không được quảng cáo là "phát hiện AI".
- **Kết hợp nhiều lớp:** tin cậy (ai gửi), khai báo (họ nói gì), bằng chứng (công cụ ghi nhận gì), quy tắc (PR có đạt chuẩn không). Không lớp nào đủ một mình.
- **Với hợp đồng doanh nghiệp,** bằng chứng mạnh nhất còn phải kết hợp log từ phía nhà cung cấp AI (mỗi khách một API key riêng). Phần này để giai đoạn sau.

### 4.4. Cam kết về dữ liệu (thay cho "zero-knowledge" của bản 1)

- **Bản Action:** chạy hoàn toàn trong CI của repo. Proofgate không nhận gì.
- **Bản App host sẵn:** đọc metadata và diff của PR qua API với quyền tối thiểu. Không lưu code; chỉ lưu kết quả kiểm tra.
- **Bản tự host:** toàn bộ dữ liệu nằm trên hạ tầng của khách hàng.

---

## 5. THỊ TRƯỜNG & KHÁCH HÀNG

| Giai đoạn | Phân khúc | Vai trò | Lý do |
| :-- | :-- | :-- | :-- |
| 1 | Maintainer các dự án OSS cỡ vừa và lớn | **Người dùng, không trả tiền** | Đau nhất (31% PR kém chất lượng ở dự án lớn). Là nơi team có lợi thế tiếp cận |
| 1 | Công ty đứng sau các dự án OSS lớn (công ty devtools, hạ tầng, framework) | **Khách trả tiền đầu tiên** | Họ trả lương maintainer, nên thời gian maintainer là tiền. Có nhiều repo nên cần tính năng cấp tổ chức |
| 2 | Công ty nhận code từ nhà thầu, agency (repo private) | Khách trả tiền | Hợp đồng bắt đầu đòi khai báo AI nhưng chưa có cách kiểm chứng. Dùng cùng một engine |
| 3 | Bộ phận OSPO, bảo mật chuỗi cung ứng | Khách trả tiền | Muốn biết nguồn gốc AI của các thư viện phụ thuộc. Chỉ làm khi đã có dữ liệu |

**Chưa ước tính quy mô thị trường (TAM).** Ưu tiên kiểm chứng xem có người trả tiền hay không trước khi làm bài toán quy mô.

---

## 6. MÔ HÌNH KINH DOANH & BẢNG GIÁ (GIẢ THUYẾT)

Mô hình **open-core**, giống cách nhiều công cụ dev làm: miễn phí cho repo public, thu phí tổ chức và repo private.

| Gói | Giá (giả thuyết) | Dành cho | Bao gồm |
| :-- | :-- | :-- | :-- |
| **Open Source** | Miễn phí mãi mãi | Mọi repo public, cá nhân | Đặc tả, Action, CLI, adapter, mẫu chính sách |
| **Team** | $99–$299 / tổ chức / tháng (theo số repo private) | Công ty có dự án OSS, team nhận nhà thầu | App host sẵn, chính sách nhiều repo, dashboard, báo cáo vendor |
| **Enterprise** | Từ khoảng $15.000 / năm | Doanh nghiệp, ngành bị quản lý | SSO/SAML, audit export, tự host, hỗ trợ và SLA |

- **Giá chỉ là giả thuyết.** Không công bố trước khi có ít nhất 10 cuộc phỏng vấn với người có quyền chi tiền.
- **Biên lợi nhuận cao** vì việc kiểm tra dựa trên quy tắc, không tốn chi phí gọi model AI. Nếu sau này thêm tóm tắt bằng AI thì dùng key của khách (BYOK).
- **Bỏ** gói "Managed AI Gateway" và tính phí theo token của bản 1.

---

## 7. CHIẾN LƯỢC TIẾP CẬN (DỰA TRÊN THẾ MẠNH CỘNG ĐỒNG)

1. **Design partner trước, ra mắt sau.** Chọn 3–5 dự án mà team quen maintainer, cài thử và sửa theo phản hồi trong 4–6 tuần.
2. **Chuyển chính sách văn xuôi thành file chính sách giúp các dự án đã có AI policy.** Gửi PR cho họ chính là một kênh phân phối, và đóng góp có giá trị thật.
3. **Nội dung dựa trên dữ liệu.** Khi đã có số liệu từ các design partner (ẩn danh), viết bài phân tích PR có AI. Loại nội dung này dễ lên Hacker News.
4. **Vòng lan truyền qua người đóng góp.** Mỗi bình luận "cần bổ sung" đều kèm link hướng dẫn và CLI. Người đóng góp biết đến sản phẩm ngay tại PR của họ.
5. **Hội nghị và cộng đồng OSPO.** Các talk tại FOSDEM, các hội nghị ngôn ngữ (đã có talk về chống AI slop tại EuroPython 2026), nhóm TODO Group.
6. **Chuyển sang trả phí từ dưới lên.** Khi một công ty đã dùng bản miễn phí trên vài repo, họ sẽ cần tính năng cấp tổ chức. Đây là lúc bán, không cần đội sales sớm.

---

## 8. KẾ HOẠCH KIỂM CHỨNG & LỘ TRÌNH

| Giai đoạn | Thời gian | Việc làm | Tiêu chí tiếp tục / dừng |
| :-- | :-- | :-- | :-- |
| **0. Phỏng vấn** | Tuần 1–2 | Nói chuyện với 15 maintainer và 5 người có quyền chi tiền ở công ty có dự án OSS | Tiếp tục nếu ít nhất một nửa maintainer xác nhận đang tốn thời gian kiểm tra chính sách AI bằng tay |
| **1. MVP** | Tuần 3–6 | Đặc tả v0, GitHub Action, 3 mẫu chính sách; cài cho 3–5 design partner | Tiếp tục nếu ít nhất 3 dự án vẫn bật sau 30 ngày và tỷ lệ maintainer phải bỏ qua kết quả dưới 20% |
| **2. Mở rộng OSS** | Tháng 2–4 | GitHub App host sẵn, CLI cho người đóng góp, adapter Agent Trace và git-ai, tương thích Vouch; ra mắt công khai | Đo số repo đang bật (không đo số sao) và số người đóng góp cài CLI |
| **3. Thu phí** | Tháng 4–9 | Tính năng tổ chức, thí điểm repo private có nhà thầu | Mục tiêu tín hiệu: 3 tổ chức trả tiền. Nếu sau 3 tháng không công ty nào tự hỏi về tính năng tổ chức thì xem lại người trả tiền |

**Ngưỡng ở trên là đề xuất ban đầu**, có thể chỉnh sau giai đoạn 0. Điều quan trọng là đặt ngưỡng *trước* khi làm, để không tự thuyết phục mình sau.

**Câu hỏi phỏng vấn gợi ý:**

- *Cho maintainer:* Tuần trước bạn mất bao lâu xử lý PR có AI? Chính sách AI của dự án hiện viết ở đâu, kiểm tra thế nào? Lần gần nhất bạn đóng một PR vì AI là khi nào, vì sao?
- *Cho người chi tiền:* Công ty trả bao nhiêu giờ maintainer mỗi tháng? Có ai trong công ty phải báo cáo về việc dùng AI trong code (khách hàng, kiểm toán, pháp chế) không?

---

## 9. RỦI RO

| Rủi ro | Mức | Cách giảm thiểu |
| :-- | :-- | :-- |
| GitHub làm "chặn theo tiêu chí" bao trùm luôn việc này | Cao | Trung lập nhiều forge; đi sâu vào bằng chứng và chuẩn chính sách; chấp nhận rủi ro này như một phần của ngách bán thẳng cho dev |
| Maintainer dùng nhưng không ai trả tiền | Cao | Người trả tiền là công ty, không phải maintainer; kiểm chứng ngay ở giai đoạn 0 |
| Kết quả sai làm tổn thương cộng đồng (buộc tội oan) | Trung bình | Mặc định không tự đóng PR; giải thích rõ; maintainer có quyền bỏ qua; không đoán theo văn phong |
| Người đóng góp khai báo gian | Trung bình | Nói rõ đây là chính sách, không phải phát hiện; kết hợp với lớp tin cậy (Vouch) |
| Entire hoặc git-ai mở rộng sang kiểm tra chính sách | Trung bình | Tương thích với họ thay vì cạnh tranh trực diện; đi nhanh để thành định dạng chuẩn |
| Các công cụ nhỏ (MergeShield, anti-slop…) chiếm chỗ trước | Trung bình | Tương thích, mời hợp tác, tập trung vào đặc tả mở |
| Team kiệt sức vì duy trì OSS miễn phí | Trung bình | Giới hạn phạm vi bản miễn phí; thu phí sớm từ tổ chức |

---

## 10. TÊN THƯƠNG HIỆU

Tên "Localkan" không còn hợp vì sản phẩm không còn Kanban và không còn chạy cục bộ là chính. Một số gợi ý:

- **Proofgate:** proof (bằng chứng) + gate (cổng). Đang dùng làm tên tạm.
- **Provenant:** gợi nguồn gốc (provenance).
- **Waypass:** cổng cho phép đi qua, nhẹ nhàng, không mang ý buộc tội.

Trước khi chọn: kiểm tra nhãn hiệu, tên miền, tên org trên GitHub và gói trên npm/crates. Tránh các từ như "detector", "slop" hay "AI-free" trong tên, vì chúng tạo cảm giác buộc tội.

---

## 11. PHỤ LỤC: GIỮ LẠI GÌ TỪ BẢN 1

| Thành phần bản 1 | Bản 2 | Ghi chú |
| :-- | :-- | :-- |
| Bảng Kanban, điều phối agent, worktree | Bỏ | Lớp này đã thành miễn phí |
| Nhúng Orca headless, đọc output PTY | Bỏ | Dễ vỡ, trùng Orca |
| Chế độ Hỏi / Làm, terminal xterm | Bỏ | Thuộc lớp điều phối |
| `PROJECT_RULES.md` | Giữ ý tưởng | Thành `ai-policy.yml` đọc được bằng máy |
| BYOK, hỗ trợ Ollama | Giữ cho tính năng AI tùy chọn sau này | Không bán token |
| Che giấu thông tin nhạy cảm (secret redaction) | Giữ | Áp dụng khi hiển thị bằng chứng và log |
| Binary Rust | Giữ cho CLI | Lý do là cài đặt nhẹ và nhanh, không phải để chống dịch ngược (mã đã mở) |
| Gói Enterprise: SSO, audit log, tự host | Giữ | Là lõi của bản trả phí |

---

## NGUỒN THAM KHẢO

**Bối cảnh AI slop và phản ứng của maintainer**
- [Help Net Security: AI slop chồng chất nhất ở các dự án lớn (khảo sát Linux Foundation, 10/2026)](https://helpnetsecurity.com/2026/10/26/linux-foundation-open-source-ai-slop)
- [Let's Data Science: khảo sát Linux Foundation ước tính 25% PR là AI slop](https://letsdatascience.com/news/linux-foundation-survey-estimates-25-of-pull-requests-are-ai-47da3160)
- [Let's Data Science: agent khởi tạo hơn 40% PR trên GitHub](https://letsdatascience.com/blog/agents-start-40-percent-github-pull-requests-march-17)
- [InfoQ: AI làm ngập và khiến các dự án đóng cửa](https://infoq.com/news/2026/02/ai-floods-close-projects)
- [Codenote: chính sách đóng góp của curl, Ghostty, tldraw thay đổi thế nào](https://codenote.net/en/posts/oss-ai-slop-contribution-policy-shift/)
- [The Register: maintainer Godot vật lộn với AI slop](https://www.theregister.com/2026/02/18/godot_maintainers_struggle_with_draining/)
- [EuroPython 2026: Defending Open Source from AI Slop](https://ep2026.europython.eu/session/defending-open-source-from-ai-slop-a-maintainer-s-practical-guide/)

**Công cụ của GitHub và các công cụ hiện có**
- [The Register: GitHub cân nhắc "công tắc" tắt PR](https://www.theregister.com/2026/02/03/github_kill_switch_pull_requests_ai)
- [CodeRabbit: GitHub cho maintainer quyền điều tiết PR có AI](https://www.coderabbit.ai/blog/github-gives-maintainers-a-throttle-for-the-ai-pull-request)
- [Gigazine: GitHub giới hạn số PR đang mở](https://gigazine.net/gsc_news/en/20260618-github-limit-pull-request)
- [Crypto Briefing: các tùy chọn kiểm soát PR mới của GitHub](https://cryptobriefing.com/github-restricts-pull-requests-ai-slop/)
- [Simon Willison: Vouch](https://simonwillison.net/2026/Feb/7/vouch/)
- [Ryan Walker: phân tích Vouch](https://rywalker.com/research/vouch)
- [commit-check: thực thi chính sách AI attribution ở CI](https://dev.to/shenxianpeng/ai-attribution-governance-enforcing-ai-disclosure-policies-at-the-ci-level-492a)
- [MergeShield (GitHub App)](https://github.com/apps/mergeshield)

**Ghi nhận AI (nguồn bằng chứng)**
- [Agent Trace (Cursor)](https://github.com/cursor/agent-trace)
- [Thoughtworks Technology Radar: Agent Trace](https://www.thoughtworks.com/radar/platforms/agent-trace)
- [Git AI 1.0](https://usegitai.com/blog/introducing-git-ai)
- [Git AI: bảng giá](https://usegitai.com/pricing)
- [Entire: Hello Entire World](https://entire.io/blog/hello-entire-world)
- [Entire CLI](https://github.com/entireio/cli)
- [Creati.ai: Entire gọi vốn seed 60 triệu USD](https://creati.ai/ai-news/2026-02-14/entire-60-million-seed-funding-ai-code-infrastructure)
- [TODO Group: nguồn gốc kiểm chứng được cho đóng góp có AI](https://todogroup.org/blog/2026-07-14-verifiable-provenance-ai-assisted-contributions/)

**Hook của các agent và công cụ chính sách**
- [Codex CLI: hook chính thức ổn định từ v0.124](https://codex.danielvaughan.com/2026/04/23/codex-cli-hooks-graduate-stable-v0124-mcp-observation-inline-config/)
- [Antigravity CLI: hooks](https://antigravity.google/docs/hooks?tab=cli)
- [Hook của các agent đang hội tụ](https://codex.danielvaughan.com/2026/06/25/agent-hook-convergence-codex-cli-claude-code-gemini-cli-kiro-opencode-portable-governance/)
- [Endor Labs: agent governance](https://docs.endorlabs.com/agent-governance)
- [ai-hooks (npm)](https://libraries.io/npm/@premierstudio%2Fai-hooks)

**Lớp điều phối agent (lý do bỏ bản 1)**
- [OpenAI: Symphony](https://openai.com/index/open-source-codex-orchestration-symphony)
- [Emdash (Y Combinator)](https://www.ycombinator.com/companies/emdash)
- [OpenAlternative: các bộ điều phối agent](https://openalternative.co/blog/best-ai-coding-agent-orchestrators)

**Điều khoản AI trong hợp đồng thuê ngoài**
- [Morgan Lewis: đàm phán điều khoản AI](https://www.morganlewis.com/blogs/sourcingatmorganlewis/2026/04/negotiating-ai-provisions-in-commercial-and-technology-contracts-where-the-market-is-heading)
- [Mondaq: nhà cung cấp của bạn đang dùng AI, hợp đồng đã có điều khoản chưa?](https://www.mondaq.com/contracts-and-commercial-law/1819926/your-supplier-is-using-ai-is-it-in-your-contract)
