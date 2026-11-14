# Localkan

Bảng Kanban điều phối nhiều AI coding agent. Mỗi thẻ việc chạy trong một git worktree riêng trên máy của bạn, thông qua runtime headless của [Orca](https://github.com/stablyai/orca).

Kiến trúc 3 lớp theo [đề án gốc](docs/DE-AN-v1.md):

```
Web UI (React)  ⇄  Server (Node: API + WebSocket hub, MongoDB metadata)  ⇄  Bridge (Rust/Tauri trên máy bạn)  ⇄  Orca runtime  ⇄  claude / agy / codex / grok
```

| Thư mục | Vai trò |
| :-- | :-- |
| `packages/protocol` | Kiểu dữ liệu và giao thức dùng chung (TypeScript). Bản Rust nằm ở `apps/bridge/core/src/protocol.rs`; khi đổi giao thức phải sửa cả hai nơi. |
| `apps/server` | Lớp "cloud": tài khoản, ghép nối máy, bảng, thẻ; chuyển lệnh giữa trình duyệt và bridge. Chỉ lưu metadata, trong MongoDB. |
| `apps/web` | Giao diện Kanban: kéo thẻ để giao việc, xem log trực tiếp, trả lời agent, xem diff, nhận xét theo dòng, hoàn tất. |
| `apps/bridge/core` | Lõi bridge (Rust): kết nối server, điều khiển Orca CLI, git, lưu log cục bộ, che giấu secret. Kèm bản headless `lk-bridge`. |
| `apps/bridge/src-tauri` + `ui` | App desktop Tauri chạy ở khay hệ thống, có cửa sổ ghép nối và trạng thái. |
| `tools/mock-agent.mjs` | Agent giả lập để thử toàn bộ luồng mà không tốn tiền AI. |

## Luồng hoạt động

| Cột | Bạn làm | Bên dưới |
| :-- | :-- | :-- |
| **To Do** | Tạo thẻ, chọn agent (Claude Code / agy / Codex / Grok) và chế độ (Làm / Hỏi). | Chỉ lưu metadata trên server. |
| **In Progress** | Kéo thẻ sang, hoặc bấm "Giao cho agent". | Bridge: `orca worktree create` → `orca orchestration worker-start --agent …`. Log được đọc từ màn hình terminal của agent, lọc nhiễu, che secret rồi đẩy lên web. |
| **Cần bạn xử lý** | Trả lời câu hỏi, hoặc bấm Đồng ý / Từ chối / phím. | Có hai loại: agent hỏi qua `orca orchestration ask` (bạn trả lời bằng chữ), hoặc terminal đang chờ xác nhận (ví dụ "trust this folder?"). Với loại thứ hai, bridge gửi phím rồi tự giao lại việc. |
| **Review** | Xem diff, bấm vào dòng để nhận xét, "Yêu cầu sửa". | Agent gửi `worker_done` → thẻ tự sang Review. "Yêu cầu sửa" giao tiếp việc cho chính terminal agent cũ trong cùng worktree. |
| **Done** | Chọn: Commit vào nhánh / Tạo PR / Merge vào nhánh gốc / Hủy. | Commit, `git push` + `gh pr create`, `git merge --no-ff`, hoặc xóa nhánh; sau đó dọn worktree bằng `orca worktree rm`. |

## Ngữ cảnh giữa các thẻ

Mỗi thẻ chạy một phiên agent mới. Ngữ cảnh được chuyển giữa các thẻ qua các file Markdown trong thư mục `.localkan/` của repo gốc, trên máy chạy bridge. Thư mục này được thêm vào `.git/info/exclude` nên không bị commit, và server không lưu gì.

| File | Nội dung | Ai viết |
| :-- | :-- | :-- |
| `.localkan/memory.md` | Bộ nhớ dự án: quy ước, công nghệ, quyết định đã chốt | Bạn, qua nút **🧠 Bộ nhớ** trên web hoặc sửa bằng editor |
| `.localkan/handoffs/<thẻ>.md` | Ghi chú bàn giao của từng thẻ, kèm trạng thái (đang review / đã commit / đã merge / đã tạo PR / đã hủy) | Agent, qua file `.localkan/handoff.md` trong worktree; nếu agent không viết thì bridge dùng phần tóm tắt |

Khi giao việc, nhiệm vụ gửi cho agent có thêm:
- toàn bộ bộ nhớ dự án;
- ghi chú đầy đủ của thẻ được chọn ở **"Làm tiếp từ thẻ…"**;
- tóm tắt của tối đa 8 thẻ gần nhất (bỏ qua thẻ đã hủy).

Khi chọn "Làm tiếp từ thẻ…" mà nhánh của thẻ đó chưa merge, worktree mới sẽ bắt đầu từ nhánh đó và diff chỉ hiện phần việc mới. Muốn chia sẻ ghi chú qua git thì bỏ các dòng `.localkan/...` trong `.git/info/exclude` rồi commit.

## Skill cho agent

| Loại | Đặt ở đâu | Ghi chú |
| :-- | :-- | :-- |
| **Toàn cục** | Claude Code: `~/.claude/skills/<tên>/SKILL.md` · agy: `~/.gemini/antigravity-cli/skills/<tên>/SKILL.md` · Codex: `~/.codex/skills/` · Grok: `~/.grok/skills/` (Grok đọc cả `~/.claude/skills/`) | Áp dụng cho mọi việc, vì agent chạy trên máy bạn. |
| **Trong repo** | Claude Code: `.claude/skills/` · agy, Codex: `.agents/skills/` · Grok: cả hai | Phải commit, và push nếu bảng dùng PR hoặc Merge rồi push, vì worktree được tạo từ nhánh gốc trên origin. |
| **Của bảng** | `<thư mục dự án>/.localkan/skills/<tên>/SKILL.md` | Không cần commit; git bỏ qua. Bảng nhiều repo đặt ở thư mục cha. |

Mỗi khi giao việc (và khi chạy lại hoặc gửi yêu cầu sửa), Localkan liên kết **skill của bảng** vào thư mục việc ở cả `.claude/skills/` lẫn `.agents/skills/`, để cả bốn agent cùng dùng được: Claude Code đọc `.claude/skills/`, agy và Codex đọc `.agents/skills/`, Grok đọc cả hai.
- Skill sẵn có của repo trong một trong hai thư mục cũng được liên kết sang thư mục kia.
- Với bảng nhiều repo, skill của từng repo con được đưa lên thư mục việc, nên agent thấy ngay từ đầu. Trùng tên thì thêm tiền tố tên repo, ví dụ `backend-review`.
- Các liên kết được git bỏ qua, nên không lọt vào diff, commit hay PR.
- Danh sách skill của bảng xem ở **🧠 Bộ nhớ → Skill**.

Mỗi `SKILL.md` cần phần đầu có `name` và `description`; agent dựa vào `description` để biết khi nào dùng skill.

## Agent

| Agent | Lệnh | Bridge chạy thế nào |
| :-- | :-- | :-- |
| **Claude Code** | `claude` | Mở sẵn agent trong terminal, đợi sẵn sàng rồi mới gửi việc. |
| **Antigravity (agy)** | `agy` | Orca mở agent và gửi việc luôn. |
| **Codex** | `codex` | Orca mở agent và gửi việc luôn. |
| **Grok** | `grok` | Như Claude Code: mở sẵn rồi mới gửi, vì Grok bỏ mất chữ gõ vào khi đang khởi động. |

- Agent chạy với cờ mặc định của Orca để không hỏi quyền từng lệnh: Codex `--dangerously-bypass-approvals-and-sandbox`, Grok `--permission-mode bypassPermissions`.
- Bridge tìm lệnh trong PATH, `~/.local/bin`, `~/.codex/bin`, `~/.grok/bin` và Homebrew. Agent nào tìm thấy được đánh ✓ trong hộp thoại máy chạy bridge (nút máy trên thanh trên cùng).
- Hạn mức của agent tính theo tài khoản của bạn. Grok hiện phần còn lại ở thanh trạng thái ("Weekly limit left"); hết hạn mức thì agent không làm tiếp được, xem tab Terminal của thẻ rồi dừng việc.

## Git: Pull Request, Merge rồi push, hoặc merge cục bộ

Mỗi bảng chọn một cách đưa việc đã duyệt vào repo, ở nút **⑂** trên thanh trên cùng (trên điện thoại: menu ☰ → ⑂):

| Cách | Hợp với | Khi bạn duyệt |
| :-- | :-- | :-- |
| **Pull Request** | Repo GitHub đã có CI/CD | Merge PR trên GitHub; pipeline chạy từ đó |
| **Merge rồi push** | Repo có remote nhưng chưa có CI/CD (dự án mới) | Merge vào nhánh gốc mới nhất trên origin và push thẳng lên, không mở PR |
| **Merge cục bộ** | Repo chưa có remote | Merge vào nhánh đang mở trong thư mục dự án, không push |

Bảng mới tự chọn theo repo: có remote GitHub, có CI (`.github/workflows`, `.gitlab-ci.yml`…) và có `gh` đã đăng nhập thì chọn Pull Request; có remote mà chưa có CI thì chọn Merge rồi push; chưa có remote thì chọn merge cục bộ. Nhánh gốc là nhánh đang mở trong thư mục dự án. Các bảng có từ trước giữ merge cục bộ cho tới khi bạn đổi. Khi dự án mới có thêm CI/CD, chỉ cần vào ⑂ đổi sang Pull Request.

**Merge rồi push:** việc vẫn chạy trên nhánh riêng `feature/…` lấy từ `origin/<nhánh gốc>` mới nhất. Khi bạn bấm **⑂ Merge & push**, Localkan:
1. Lấy `origin/<nhánh gốc>` mới nhất.
2. Tạo commit merge `Merge <nhánh>: <tiêu đề>` ngay trong worktree của việc, nên không đụng thư mục dự án.
3. Push nhánh gốc lên origin (chỉ fast-forward, không bao giờ ghi đè).
4. Dọn worktree và nhánh, rồi cập nhật nhánh gốc trong thư mục dự án nếu nó đang mở và sạch.

Nếu xung đột, hoặc origin vừa có commit mới, Localkan không push gì, đưa worktree về nguyên trạng và báo cách xử lý (nhờ agent merge rồi duyệt lại).

**Luồng Pull Request** (khớp với quy trình nhánh → PR → merge → pipeline tự deploy). Nếu repo không có CI, PR vẫn chạy bình thường và phần CI hiện "chưa có CI":

| Bước | Localkan làm gì |
| :-- | :-- |
| Giao việc | `git fetch`, tạo worktree từ `origin/<nhánh gốc>` mới nhất, trên nhánh `feature/<tên-việc>-<mã>` (tiền tố đổi được). Thư mục dự án chính không bị đụng tới. |
| Agent xong | Commit, push nhánh, mở **PR nháp** vào nhánh gốc (mô tả gồm tóm tắt và ghi chú bàn giao) để CI chạy trong lúc bạn review. Tắt được bằng "Mở PR nháp ngay khi agent xong". |
| Review | Màn review hiện PR, trạng thái **CI** (qua / lỗi / đang chạy, tên kiểm tra lỗi) và xung đột với nhánh gốc. Localkan hỏi GitHub mỗi phút, và mỗi 20 giây khi đang mở màn review lúc CI chạy. |
| Yêu cầu sửa | Agent sửa trong cùng worktree; Localkan commit (`Cập nhật theo review: …`) và đẩy vào cùng PR, CI chạy lại. |
| Xung đột | **Cập nhật theo `<nhánh gốc>`** merge `origin/<nhánh gốc>` vào nhánh việc và đẩy lên. Nếu xung đột thì hủy merge (worktree giữ nguyên) và gợi ý **Nhờ agent xử lý xung đột**. |
| **Merge PR** | Chuyển PR khỏi nháp, merge trên GitHub (squash / merge commit / rebase theo cài đặt), xóa nhánh trên GitHub và trên máy, rồi cập nhật nhánh gốc trong thư mục dự án nếu nó đang mở và sạch. Pipeline của repo deploy từ đó. |
| Merge trên github.com | Nếu bạn tự merge PR trên GitHub, Localkan nhận ra trong khoảng một phút, dọn worktree và nhánh, rồi chuyển việc sang Xong. |
| Hủy | Đóng PR, xóa nhánh trên GitHub và trên máy. |

Trong "Cách khác…" vẫn có: chỉ mở PR (bạn tự merge trên GitHub), commit giữ nhánh, merge cục bộ. Nếu repo bật branch protection (bắt buộc CI qua hoặc cần người duyệt), GitHub có thể từ chối merge; Localkan báo lại đúng lý do GitHub đưa ra.

Thông báo đẩy có thêm: **CI lỗi**, **CI đã qua** (sẵn sàng merge), và **PR đã được merge trên GitHub**.

Yêu cầu: repo có remote `origin` trên GitHub, máy chạy bridge push được (SSH hoặc HTTPS như khi bạn tự push), và GitHub CLI đã đăng nhập (`gh auth login`).

## Bảng nhiều repo (thư mục chứa frontend/, backend/…)

Nếu dự án là một thư mục **không phải** git repo nhưng chứa nhiều repo riêng ở cấp ngay dưới (ví dụ `shop/frontend` và `shop/backend`, mỗi thư mục một repo), hãy chọn chính thư mục cha khi tạo bảng. Localkan nhận ra đây là **bảng nhiều repo** và không bắt `git init` thư mục cha. Thư mục của bạn giữ nguyên.

- **Mỗi việc có một thư mục riêng, cùng cấu trúc với thư mục cha:** `<việc>/frontend` và `<việc>/backend`. Mỗi thư mục con là worktree của repo tương ứng, cùng một nhánh `feature/…`, lấy từ nhánh gốc mới nhất của repo đó. Agent chạy ở thư mục việc nên sửa được nhiều repo cùng lúc, giống như khi bạn cho agent vào thư mục cha.
- **Mỗi repo có cài đặt git riêng** trong ⑂: Pull Request, Merge rồi push, hoặc merge cục bộ, cùng nhánh gốc và tiền tố riêng. Repo mới tự chọn theo remote và CI của nó.
- **Review:**
  - Diff gộp các repo, đường dẫn có tiền tố `frontend/…`, `backend/…`.
  - Khối "N repo" hiện nhánh, cách hoàn tất, PR, CI và xung đột của từng repo.
  - Repo luồng PR tự mở PR nháp khi agent xong.
- **⑂ Hoàn tất N repo:** xử lý lần lượt từng repo có thay đổi theo cách của nó. Repo kiểu backend/api/server được xử lý trước, vì frontend thường phụ thuộc API của backend. Repo không có thay đổi được bỏ qua.
  - Nếu một repo lỗi (xung đột, GitHub từ chối merge), Localkan dừng lại ngay và báo repo nào lỗi, repo nào đã xong.
  - Bấm Hoàn tất lại sau khi sửa: các repo đã xong được bỏ qua.
- **Hủy:** đóng các PR, xóa worktree và nhánh ở mọi repo.
- **Merge thẳng trên github.com:** Localkan tự dọn repo đó. Khi không còn repo nào dở dang, việc chuyển sang Xong.
- **Bộ nhớ dự án và ghi chú bàn giao** nằm ở `.localkan/` của thư mục cha, dùng chung cho mọi repo.
- **Xem trước:** chạy repo có script `dev` hoặc `start`, ưu tiên tên kiểu frontend/web/client/app.

Về kỹ thuật: Orca chỉ quản lý git repo, nên mỗi bảng nhiều repo có thêm một repo trống, riêng tư, nằm trong thư mục dữ liệu của bridge (`workspaces/`), chỉ để Orca quản lý thư mục việc và terminal của agent. Repo này không bao giờ được push.

## Xem trước và chụp màn hình (kể cả khi đi ra ngoài)

Tab **Xem trước** trong thẻ, khi thẻ đã giao việc và chưa hoàn tất:

- **▶ Chạy xem trước:**
  - Bridge chạy dev server của dự án ngay trong worktree của thẻ, theo script `dev`/`start` trong `package.json`, trên một cổng trống. Bridge tự chọn `npm`/`pnpm`/`yarn`/`bun` theo lockfile.
  - Nếu thiếu `node_modules`, bridge tự cài, và bước cài này **không tạo hay sửa lockfile**, nên diff của thẻ chỉ có phần việc của agent.
- **Link từ xa (ngrok):**
  - Nếu bật, bridge mở một tunnel ngrok có **mật khẩu ngẫu nhiên** (tài khoản `localkan`). Thẻ hiện link và mã QR để quét bằng điện thoại.
  - Lần đầu mở link, gói ngrok miễn phí hiện một trang cảnh báo; bấm "Visit Site" rồi nhập tài khoản và mật khẩu.
  - Mọi thẻ dùng chung một tiến trình ngrok, vì gói miễn phí chỉ cho một tiến trình.
- **📸 Chụp:** Chrome headless trên máy chạy bridge chụp đường dẫn bạn nhập, ở khổ điện thoại (390×844) và máy tính (1440×900). Ảnh chỉ được chuyển tiếp lên web, không lưu trên server.
- Khi hoàn tất thẻ, xem trước tự dừng. Dev server và ngrok bị sót lại sau khi bridge tắt đột ngột sẽ được dọn ở lần khởi động sau.

Nút **👁 Xem trước main** trên thanh trên cùng làm y như vậy nhưng cho **chính thư mục dự án** (nhánh đang checkout, thường là `main`), tức kết quả sau khi các thẻ đã merge. Không cần tạo thẻ nào. Nút có chấm xanh khi đang chạy. Nếu dev server có hot reload thì merge thêm thẻ là trang tự cập nhật, không cần chạy lại. Xóa bảng thì xem trước của bảng và của các thẻ trong bảng cũng tắt theo.

Yêu cầu: `ngrok` đã cài và đăng nhập (`brew install ngrok`, rồi `ngrok config add-authtoken <token>`) và Google Chrome (hoặc Chromium/Edge/Brave) để chụp màn hình.

## Giao diện điện thoại

Trên màn hình hẹp (điện thoại), web tự chuyển sang giao diện gọn, gồm 3 màn hình:

- **Tổng quan:** việc của **mọi bảng** trong một danh sách, việc cần bạn nằm trên cùng.
  - Ba ô đếm: Cần bạn, Đang chạy, Lỗi. Bấm vào ô hoặc các nút lọc để chỉ xem từng loại.
  - Mỗi việc có nút xử lý ngay tại chỗ:
    - Việc chờ review: **Xem trước** và **Review**.
    - Agent hỏi kèm lựa chọn: bấm thẳng vào lựa chọn. Câu hỏi không kèm lựa chọn: trả lời luôn trong ô.
    - Việc cần đăng nhập hoặc cần xác nhận: mở ra để xử lý.
    - Việc bị lỗi: **Xem log** và **Chạy lại**.
    - Việc chưa giao: **Giao việc**.
- **Việc mới:** chọn bảng, chọn agent, rồi nói hoặc gõ yêu cầu (nút micro lớn) và đính kèm ảnh.
  - Có sẵn vài **mẫu nhanh**.
  - Hai công tắc: **Tự chạy xem trước** (link điện thoại sẵn sàng ngay khi agent xong) và **Chỉ hỏi, không sửa code**.
  - Nút gửi tạo việc và giao luôn cho agent.
- **Màn việc:** nội dung đổi theo trạng thái.
  - Đang chờ review:
    - Ảnh chụp trang ở khổ điện thoại, nút **Mở và thử trên điện thoại** kèm tài khoản và mật khẩu của link.
    - Báo cáo của agent, danh sách file thay đổi, diff chi tiết khi cần.
    - Ba nút: **Yêu cầu sửa** (nói hoặc gõ), **Merge**, **Hủy và xóa nhánh**. Cách khác (commit, PR) nằm ở link bên dưới.
  - Đang chạy: log trực tiếp và nút **Dừng**.
  - Đang chờ bạn: câu hỏi, hộp xác nhận hoặc màn đăng nhập từ xa.
  - Nút ⋯ mở lại khung chi tiết đầy đủ (terminal, nhiệm vụ…).

Các màn nằm trong địa chỉ trang (`#new`, `#card/<id>`), nên cử chỉ quay lại của điện thoại hoạt động đúng. Menu ☰ có trình duyệt dùng chung, xem trước `main` của từng bảng, và nút chuyển sang dạng bảng Kanban. Ở dạng bảng trên điện thoại, nút 📱 đưa bạn về giao diện gọn.

## Thông báo khi việc xong

Localkan gửi **thông báo đẩy (Web Push)** tới điện thoại và máy tính của bạn, kể cả khi không mở trang:

| Loại | Khi nào | Ví dụ |
| :-- | :-- | :-- |
| Việc xong | Agent báo xong, việc chuyển sang chờ review | ✓ Xong, chờ review: Thêm thanh toán Stripe |
| Cần bạn xử lý | Agent hỏi, cần đăng nhập, hoặc cần bạn xác nhận | ❓ Agent hỏi: Làm trang bảng giá |
| Việc bị lỗi | Agent báo thất bại hoặc không chạy được | ⚠ Lỗi: Gửi SMS xác nhận |

Bấm vào thông báo để mở đúng việc đó: trên điện thoại là màn việc, trên máy tính là khung chi tiết của thẻ. Dừng agent bằng tay không tạo thông báo.

**Bật thông báo:** bấm nút chuông (🔔/🔕) ở màn Tổng quan trên điện thoại, hoặc trên thanh trên cùng ở máy tính, rồi chọn "Bật thông báo trên thiết bị này". Mỗi thiết bị bật riêng và chọn riêng loại muốn nhận. Nút "Gửi thử" kiểm tra ngay.

- **Cần HTTPS.** Trình duyệt chỉ cho Web Push trên trang HTTPS (hoặc `localhost`). Trên server, đặt Localkan sau nginx có SSL (xem phần Docker).
- **iPhone/iPad (iOS 16.4 trở lên):** mở trang bằng Safari → nút Chia sẻ → **Thêm vào Màn hình chính**, mở Localkan từ biểu tượng đó rồi mới bật thông báo. iOS không cho trang web thường nhận thông báo.
- **Riêng tư:** nội dung thông báo (tên việc, một đoạn tóm tắt hoặc câu hỏi ngắn) được mã hóa đầu cuối. Dịch vụ push của Google, Apple hay Mozilla chỉ chuyển tiếp, không đọc được.
- Server tự tạo khóa VAPID lần đầu chạy và lưu trong MongoDB (collection `settings`), nên đăng ký vẫn còn sau khi khởi động lại hoặc build lại container. Muốn cố định khóa thì đặt `VAPID_PUBLIC_KEY` và `VAPID_PRIVATE_KEY`. Nên đặt `VAPID_SUBJECT` (ví dụ `mailto:ban@ten-mien.com`) để dịch vụ push có địa chỉ liên hệ.

## Trình duyệt dùng chung và đăng nhập từ xa

Agent dùng **trình duyệt có sẵn của Orca** (chạy ngầm trên máy chạy bridge) để mở và kiểm tra trang web, qua các lệnh `orca tab create`, `orca snapshot`, `orca click`, `orca screenshot`… Mọi tab dùng chung một bộ cookie, nên **đăng nhập một lần là mọi agent và mọi thẻ đều dùng được**, và phiên vẫn còn ở các lần chạy sau. Quy tắc gửi kèm mỗi nhiệm vụ yêu cầu agent dùng trình duyệt này, thay vì tự mở Playwright hay Chrome headless (những trình duyệt đó không có sẵn phiên đăng nhập).

**Agent không bao giờ tự nhập mật khẩu.** Gặp trang cần đăng nhập, agent hỏi bằng `orca orchestration ask` với câu hỏi bắt đầu bằng `[LOGIN]`, rồi đứng chờ. Khi đó:

1. Thẻ chuyển sang cột "Cần bạn xử lý", có nhãn **🔑 Cần đăng nhập**.
2. Mở thẻ ra, bạn thấy ảnh chụp đúng tab agent đang mở, kèm form **Đăng nhập nhanh** (tài khoản, mật khẩu, mã xác minh).
   - Localkan tự tìm các ô trên trang, gõ vào rồi bấm Enter.
   - Trang hỏi email trước rồi mới hỏi mật khẩu, hoặc trang có thêm bước nhập mã xác minh, cũng được xử lý.
3. Với trang lạ, bạn **chạm thẳng lên ảnh** để bấm, gõ chữ vào ô đang chọn (bật "Ẩn" khi gõ mật khẩu), dùng các phím Enter/Tab/Esc, cuộn trang, quay lại hoặc mở địa chỉ khác.
4. Xem ảnh thấy đã vào được thì bấm **✓ Đã đăng nhập, cho agent làm tiếp**. Agent tải lại trang và làm tiếp. Nếu không đăng nhập được, dùng "Trả lời khác" để nhắn agent, ví dụ bỏ qua phần cần đăng nhập.

Nút **🌐 Trình duyệt** trên thanh trên cùng mở cùng giao diện đó cho cả bảng. Nó giúp bạn **đăng nhập sẵn** các trang hay dùng trước khi giao việc, xem các tab agent đang mở, và đóng tab thừa.

**Mật khẩu đi đâu:** từ trình duyệt của bạn → server (chỉ chuyển tiếp: không lưu, không ghi log) → bridge → gõ thẳng vào trang qua lệnh `orca type`. Bridge không ghi các lệnh này vào log, kể cả ở mức debug, và che mật khẩu nếu lệnh báo lỗi. Agent không nhìn thấy mật khẩu: nó đang đứng chờ câu trả lời trong lúc bạn đăng nhập. Web xóa ô mật khẩu ngay sau khi gửi.

Lưu ý:
- Lệnh `orca type` nhận mật khẩu qua tham số dòng lệnh, nên trong khoảng chưa tới một giây nó có thể hiện trong danh sách tiến trình của máy bạn.
- Một số trang (Google, vài trang đăng nhập một lần SSO, trang có captcha) có thể chặn trình duyệt nhúng. Khi đó hãy đăng nhập bằng thao tác chạm và gõ; nếu vẫn bị chặn thì nhờ agent bỏ qua phần đó.
- Với app của chính bạn chạy ở localhost, cách gọn nhất là ghi tài khoản test vào **🧠 Bộ nhớ** dự án. Quy tắc cho phép agent tự dùng tài khoản test ghi ở đó.
- Quy tắc mới chỉ áp dụng cho các lần giao việc từ bây giờ; agent đang chạy dở vẫn theo quy tắc cũ.

## Yêu cầu

- macOS (đã thử trên macOS 27, Apple Silicon). Linux có thể chạy bản headless; Windows chưa thử.
- Node 24 trở lên (server chạy thẳng TypeScript bằng type stripping của Node) và pnpm.
- Rust (để build bridge): `brew install rustup && rustup-init -y`.
- Orca.app (đã thử với 1.4.201). Bridge tự tìm CLI ở `/Applications/Orca.app/Contents/Resources/bin/orca`, hoặc lấy từ biến `ORCA_BIN`.
- Ít nhất một agent CLI đã đăng nhập: `claude`, `agy`, `codex` hoặc `grok` (chạy lệnh đó một lần trong terminal để đăng nhập).
- `gh` đã đăng nhập, nếu muốn dùng "Tạo PR".
- Git đã có `user.name` và `user.email`.

Lưu ý: rustup của Homebrew là keg-only. Thêm dòng sau vào `~/.zshrc` để có `cargo` trong terminal:

```bash
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
```

## Chạy bản phát triển

```bash
pnpm install
```

Tạo `apps/server/.env` từ `apps/server/.env.example` và điền `DATABASE_URL`, là chuỗi kết nối MongoDB (Atlas hoặc MongoDB chạy trên máy). Server tự tạo các collection và index khi khởi động.

Terminal 1, server (mặc định `http://127.0.0.1:8787`):

```bash
pnpm dev:server
```

Terminal 2, giao diện web (`http://localhost:5173`, tự proxy `/api` (gồm cả WebSocket `/api/ws`) sang server):

```bash
pnpm dev:web
```

Mở web, tạo tài khoản đầu tiên, vào **Máy chạy bridge → Tạo mã ghép nối**.

Terminal 3, bridge. Dùng một trong hai cách:

```bash
cd apps/bridge && pnpm tauri dev
```

```bash
cd apps/bridge && cargo run -p localkan-bridge-core --bin lk-bridge -- pair --server http://127.0.0.1:8787 --code ABCD-EFGH
```

```bash
cd apps/bridge && cargo run -p localkan-bridge-core --bin lk-bridge -- run
```

Cách đầu là app desktop: nhập mã trong cửa sổ, sau đó app nằm ở khay hệ thống. Cách sau là bản headless.

Sau đó trên web: **+ Bảng mới** → chọn máy → nhập đường dẫn repo git trên máy đó → thêm thẻ → kéo sang In Progress.

### Chạy kiểu "sản phẩm" trên một máy

```bash
pnpm build:web && pnpm start:server
```

Server sẽ phục vụ luôn giao diện đã build ở `http://127.0.0.1:8787`.

```bash
cd apps/bridge && pnpm tauri build
```

Lệnh này tạo `Localkan Bridge.app` và file `.dmg` trong `apps/bridge/target/release/bundle/`. Bản build chưa ký số, nên macOS sẽ hỏi khi mở lần đầu.

### Thử không tốn tiền AI

```bash
cd apps/bridge && LOCALKAN_MOCK_AGENT_CMD="node $PWD/../../tools/mock-agent.mjs" cargo run -p localkan-bridge-core --bin lk-bridge -- run
```

Khi đặt biến này, mọi thẻ chạy agent giả lập thay vì agent thật:
- Bình thường, agent giả lập thêm một dòng vào `MOCK_CHANGES.md` rồi báo xong.
- Nếu mô tả thẻ có chữ `FAIL`, nó báo thất bại.
- Nếu mô tả thẻ có `LOGIN: <url>`, nó mở trang đó trong trình duyệt dùng chung, hỏi `[LOGIN]`, rồi ghi lại nội dung trang sau khi bạn đăng nhập.

## Chạy bằng Docker (backend + frontend)

Hai container, mỗi container mở một cổng. nginx trên server của bạn lo SSL và chuyển tiếp:

| Đường dẫn | Container | Cổng mặc định (chỉ nghe `127.0.0.1`) |
| :-- | :-- | :-- |
| `https://domain/` | **frontend** (`localkan-web`): giao diện web đã build, phục vụ tĩnh bằng nginx | `8080` |
| `https://domain/api/` | **backend** (`localkan-server`): API, WebSocket cho trình duyệt (`/api/ws`) và cho bridge (`/api/bridge`) | `8787` |

Mọi thứ của backend đều nằm dưới `/api`, nên nginx chỉ cần hai khối `location`. File mẫu đầy đủ: [`deploy/nginx/localkan.conf.example`](deploy/nginx/localkan.conf.example) (đã thử bằng `nginx -t` và chạy thử trọn luồng). File chỉ có HTTP; SSL do certbot thêm vào bằng lệnh `sudo certbot --nginx -d domain`. Ba điểm cần giữ khi tự viết cấu hình:

- **Giữ tiền tố `/api`:** `proxy_pass http://127.0.0.1:8787;`, không có dấu `/` ở cuối.
- **Bật WebSocket cho `/api/`:** `Upgrade`/`Connection` và `proxy_read_timeout` dài (mẫu để 1 giờ). Một số lệnh chờ bridge tới vài phút, như chạy xem trước hay chụp màn hình.
- **Gửi `X-Forwarded-Proto $scheme`** để cookie đăng nhập tự gắn cờ `Secure`, và đặt **`client_max_body_size 110m`** để tải được ảnh đính kèm (tối đa 10 ảnh × 10 MB).

Chạy trên server:

```bash
cp docker.env.example .env
```

```bash
docker compose up -d --build
```

- **Cấu hình backend:** đọc từ `apps/server/.env`, cùng file với lúc phát triển (`DATABASE_URL` bắt buộc, các biến VAPID tùy chọn). Container tự đặt `HOST=0.0.0.0`, `PORT=8787`, `DATA_DIR=/data`. Ảnh đính kèm nằm trong volume `server-data`.
- **Cổng và địa chỉ:** `FRONTEND_PORT`, `BACKEND_PORT` trong `.env`. `BIND_ADDRESS=127.0.0.1` (mặc định) nghĩa là chỉ nginx trên cùng máy truy cập được; đổi thành `0.0.0.0` nếu nginx chạy ở máy khác.
- **MongoDB trong Docker thay vì Atlas:** chạy `docker compose --profile mongo up -d --build` và đặt `DATABASE_URL=mongodb://mongo:27017/localkan` trong `apps/server/.env`.
- **Ghép nối bridge:** trong app bridge, nhập địa chỉ server là `https://domain` (không kèm `/api`), rồi nhập mã ghép nối như bình thường. Bridge tự dùng `wss://domain/api/bridge`.
- **Cập nhật:** `docker compose up -d --build`. Xem log bằng `docker compose logs -f backend`.
- Bridge chạy trên máy bạn, không nằm trong Docker, vì nó cần Orca, git và các agent.

## Biến môi trường

| Biến | Thành phần | Ý nghĩa |
| :-- | :-- | :-- |
| `DATABASE_URL` | server | Chuỗi kết nối MongoDB (bắt buộc). |
| `DATABASE_NAME` | server | Dùng database khác với database trong `DATABASE_URL` (tùy chọn, ví dụ để chạy thử). |
| `PORT`, `HOST` | server | Mặc định `8787`, `127.0.0.1`. Đặt `HOST=0.0.0.0` để máy khác truy cập. |
| `DATA_DIR` | server | Nơi lưu file ảnh đính kèm của thẻ (mặc định `apps/server/.data/attachments`). |
| `WEB_DIST` | server | Thư mục web đã build (mặc định `apps/web/dist`). |
| `SECURE_COOKIES=1` | server | Luôn gắn cờ `Secure` cho cookie. Không cần đặt nếu proxy phía trước gửi `X-Forwarded-Proto: https` (như file nginx mẫu). |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | server | Khóa Web Push cố định (tùy chọn; mặc định tự tạo và lưu trong MongoDB). |
| `VAPID_SUBJECT` | server | Địa chỉ liên hệ cho dịch vụ push, dạng `mailto:` hoặc `https:`. |
| `BIND_ADDRESS`, `FRONTEND_PORT`, `BACKEND_PORT` | Docker | Địa chỉ và cổng mở ra máy chủ cho hai container (xem `docker.env.example`). |
| `ORCA_BIN` | bridge | Đường dẫn tới orca CLI. |
| `LOCALKAN_BRIDGE_HOME` | bridge | Thư mục config/DB/log của bridge (mặc định `~/Library/Application Support/dev.localkan.bridge`). |
| `LOCALKAN_TOKEN_STORE=file` | bridge | Lưu token thiết bị vào file 0600 thay vì Keychain. |
| `LOCALKAN_LOG=debug` | bridge | Log chi tiết, bao gồm từng lệnh orca. |
| `LOCALKAN_MOCK_AGENT_CMD` | bridge | Chạy agent giả lập (chỉ dùng để thử). |

## Chuyển dữ liệu từ bản SQLite cũ

Các bản đầu dùng SQLite (`apps/server/.data/localkan.db`). Lệnh sau chép dữ liệu đó sang MongoDB trong `DATABASE_URL`:

```bash
pnpm --filter @localkan/server migrate:sqlite
```

Lệnh này giữ nguyên ID, phiên đăng nhập và token của bridge (nên không phải ghép nối lại), và chạy lại nhiều lần vẫn an toàn. File SQLite không bị sửa.

## Dữ liệu đi đâu

- **Server lưu (MongoDB):** tài khoản (mật khẩu băm bằng scrypt), máy đã ghép nối (chỉ lưu hash của token), bảng (tên, đường dẫn repo), thẻ (tiêu đề, mô tả, trạng thái, tóm tắt của agent).
- **Server chỉ chuyển tiếp, không lưu:** log agent, diff, màn hình terminal, ảnh chụp trình duyệt, và những gì bạn gõ vào trình duyệt dùng chung (kể cả mật khẩu). Bridge che các chuỗi trông giống secret trước khi gửi: `API_KEY=…`, token `sk-…`, `ghp_…`, khóa AWS, Bearer, private key; riêng log và màn hình còn che thêm IP nội bộ.
- **Chỉ ở trên máy bạn:** mã nguồn, worktree, toàn bộ log (`bridge.db`), token thiết bị (Keychain).

## Giới hạn hiện tại

- **Claude Code mở hộp hỏi khi khởi động**, và mặc định của các hộp này là "No, exit":
  - Hỏi tin cậy repo, một lần cho mỗi repo. Với git worktree, Claude chỉ nhận quyền tin cậy của **chính repo gốc**; tin cậy thư mục cha không có tác dụng.
  - Hỏi xác nhận "Bypass Permissions mode", một lần, nếu Orca đang mở Claude với `--dangerously-skip-permissions`.

  Vì vậy bridge mở Claude trước, đưa mọi hộp hỏi lên cột "Cần bạn xử lý", và chỉ giao việc khi Claude đã sẵn sàng. Bridge không tự chấp nhận hộp hỏi nào thay bạn.
- **`orca serve` mở cổng 6768 trên mọi giao diện mạng** (`0.0.0.0`). Bridge chạy nó với `--no-pairing`, nhưng nếu bạn ở mạng không tin cậy, hãy mở Orca.app trước; bridge sẽ dùng runtime của app thay vì tự chạy serve.
- **Log lấy từ màn hình đã render**, đọc mỗi 2 giây. Dòng cuộn qua quá nhanh giữa hai lần đọc có thể bị sót; muốn xem đầy đủ thì dùng tab Terminal hoặc "Mở trong Orca".
- **Mỗi lệnh gọi orca CLI tốn khoảng 0,3 giây** (khởi động Electron ở chế độ Node). Ổn với vài thẻ chạy song song; nhiều hơn thì nên chuyển sang gọi thẳng WebSocket RPC của Orca.
- **Chưa làm:** bộ máy tiết kiệm token, E2EE backup, Ask→tạo thẻ, app mobile gốc (hiện là web app cài lên màn hình chính), SSO, gói cước. Server chưa có rate limit; khi đưa ra Internet, hãy đặt sau reverse proxy có HTTPS (ví dụ nginx theo file mẫu).
- **Lần đầu chạy `orca serve`, Orca tự cài lệnh `orca` vào `/usr/local/bin`** (đây là hành vi của Orca).

## Kiểm thử

```bash
pnpm -r typecheck
```

```bash
cd apps/bridge && cargo test -p localkan-bridge-core
```
# localkan
