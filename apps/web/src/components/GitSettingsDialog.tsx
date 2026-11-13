import { useEffect, useState } from 'react';
import type { GitSettings, MergeMethod, Project, RepoInfo } from '@localkan/protocol';
import { api } from '../api.ts';
import { Dialog } from './Dialog.tsx';
import type { ToastApi } from './Toasts.tsx';

const METHODS: { id: MergeMethod; label: string; hint: string }[] = [
  { id: 'squash', label: 'Squash', hint: 'Gộp thành một commit trên nhánh gốc (gọn lịch sử)' },
  { id: 'merge', label: 'Merge commit', hint: 'Giữ nguyên các commit, thêm một commit merge' },
  { id: 'rebase', label: 'Rebase', hint: 'Đặt các commit lên đầu nhánh gốc' },
];

/** How a board's finished work reaches the repo: GitHub pull requests or a local merge. */
export function GitSettingsDialog({ project, onClose, toasts }: { project: Project; onClose: () => void; toasts: ToastApi }) {
  const [git, setGit] = useState<GitSettings>(project.git);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .projectRepo(project.id)
      .then(setRepo, (e) => toasts.error(e.message))
      .finally(() => setLoading(false));
  }, [project.id, toasts]);

  const set = <K extends keyof GitSettings>(k: K, v: GitSettings[K]) => setGit((g) => ({ ...g, [k]: v }));
  const base = git.baseBranch ?? repo?.currentBranch ?? '';
  const branches = [...new Set([...(repo?.remoteBranches ?? []), ...(git.baseBranch ? [git.baseBranch] : [])])].sort((a, b) =>
    a === 'main' || a === 'develop' ? -1 : b === 'main' || b === 'develop' ? 1 : a.localeCompare(b),
  );
  const prBlocked = git.flow === 'pr' && repo && (!repo.github || !repo.ghReady);
  const pushBlocked = git.flow === 'push' && repo && !repo.remoteUrl;

  const save = async () => {
    setSaving(true);
    try {
      await api.saveGit(project.id, { ...git, branchPrefix: git.branchPrefix.trim() });
      toasts.info('Đã lưu cài đặt git của bảng.');
      onClose();
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={`Git · ${project.name}`} onClose={onClose}>
      <div className="form">
        <div className="git-repo muted small">
          {loading
            ? 'Đang đọc repo trên máy chạy bridge…'
            : repo?.remoteUrl
              ? `origin: ${repo.remoteUrl}${repo.github ? '' : ' (không phải GitHub)'} · ${repo.ci ? 'có CI/CD' : 'chưa có CI/CD'}`
              : 'Repo chưa có remote origin.'}
          {repo && repo.github && !repo.ghReady && (
            <div className="notice">
              GitHub CLI chưa sẵn sàng trên máy chạy bridge. Chạy <code>brew install gh</code> rồi <code>gh auth login</code>.
            </div>
          )}
        </div>

        <fieldset className="git-flow">
          <legend>Khi duyệt xong một việc</legend>
          <label className="radio">
            <input type="radio" name="flow" checked={git.flow === 'pr'} onChange={() => set('flow', 'pr')} />
            <span>
              <strong>Pull Request trên GitHub</strong>
              <span className="muted small">
                {' '}
                — mỗi việc một nhánh lấy từ origin, PR nháp để CI chạy, bấm Merge PR là merge trên GitHub (CI/CD của repo
                chạy từ đó). Hợp với repo đã có CI/CD.
              </span>
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="flow" checked={git.flow === 'push'} onChange={() => set('flow', 'push')} />
            <span>
              <strong>Merge rồi push</strong>
              <span className="muted small">
                {' '}
                — mỗi việc một nhánh lấy từ origin; khi duyệt, merge vào nhánh gốc mới nhất và push thẳng lên remote, không mở PR.
                Hợp với dự án mới chưa có CI/CD.
              </span>
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="flow" checked={git.flow === 'local'} onChange={() => set('flow', 'local')} />
            <span>
              <strong>Merge cục bộ</strong>
              <span className="muted small"> — merge vào nhánh đang mở trong thư mục dự án, không push. Hợp với dự án không có remote/CI.</span>
            </span>
          </label>
        </fieldset>
        {prBlocked && <p className="error-text small">Repo này chưa dùng được luồng PR (cần remote GitHub và GitHub CLI đã đăng nhập).</p>}
        {pushBlocked && <p className="error-text small">Repo này chưa có remote origin để push.</p>}

        {git.flow !== 'local' && (
          <>
            <label>
              {git.flow === 'pr' ? 'Nhánh gốc (việc mới lấy từ đây, PR merge vào đây)' : 'Nhánh gốc (việc mới lấy từ đây, merge và push vào đây)'}
              <select value={base} onChange={(e) => set('baseBranch', e.target.value || null)}>
                {!branches.includes(base) && base && <option value={base}>{base}</option>}
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                    {b === repo?.defaultBranch ? ' (mặc định trên GitHub)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tiền tố tên nhánh
              <input value={git.branchPrefix} onChange={(e) => set('branchPrefix', e.target.value)} placeholder="feature/" />
              <span className="muted small hint">
                Ví dụ: <code>{(git.branchPrefix || '') + 'them-thanh-toan-stripe-3f2a'}</code>
              </span>
            </label>
          </>
        )}
        {git.flow === 'pr' && (
          <>
            <label>
              Cách merge PR
              <select value={git.mergeMethod} onChange={(e) => set('mergeMethod', e.target.value as MergeMethod)}>
                {METHODS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {m.hint}
                  </option>
                ))}
              </select>
            </label>
            <label className="m-toggle">
              <span>
                Mở PR nháp ngay khi agent xong
                <small>Đẩy nhánh lên GitHub để CI chạy trong lúc bạn review. Tắt thì chỉ đẩy khi bạn bấm Merge PR.</small>
              </span>
              <input type="checkbox" role="switch" checked={git.autoDraftPr} onChange={(e) => set('autoDraftPr', e.target.checked)} />
            </label>
          </>
        )}

        <p className="muted small">Áp dụng cho các việc giao từ bây giờ; việc đang làm giữ cách cũ.</p>
        <div className="row">
          <button className="btn primary" disabled={saving || loading} onClick={save}>
            Lưu
          </button>
          <button className="btn ghost" onClick={onClose}>
            Hủy
          </button>
        </div>
      </div>
    </Dialog>
  );
}
