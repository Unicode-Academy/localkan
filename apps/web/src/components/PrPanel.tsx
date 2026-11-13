import { useEffect, useState } from 'react';
import type { Card, PrInfo, Project } from '@localkan/protocol';
import { api } from '../api.ts';
import type { ToastApi } from './Toasts.tsx';

/** One-line CI verdict of a PR, for tags and headers. */
export function ciSummary(pr: PrInfo): { label: string; tone: 'ok' | 'danger' | 'info' | 'muted' } {
  const c = pr.checks;
  if (c.total === 0) return { label: 'chưa có CI', tone: 'muted' };
  if (c.failed > 0) return { label: `✗ CI lỗi ${c.failed}/${c.total}`, tone: 'danger' };
  if (c.pending > 0) return { label: `⏳ CI ${c.passed}/${c.total}`, tone: 'info' };
  return { label: `✓ CI ${c.passed}/${c.total}`, tone: 'ok' };
}

/** The task's GitHub pull request: link, draft state, CI checks and conflicts. */
export function PrPanel({ card, project, toasts }: { card: Card; project: Project; toasts: ToastApi }) {
  const pr = card.pr;
  const [busy, setBusy] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const base = pr?.base || project.git.baseBranch || project.baseRef || 'main';

  const refresh = async (quiet = false) => {
    if (!quiet) setBusy('refresh');
    try {
      await api.prRefresh(card.id);
    } catch (err) {
      if (!quiet) toasts.error((err as Error).message);
    } finally {
      if (!quiet) setBusy(null);
    }
  };

  // While CI is running, look again every 20 s (the bridge also checks every minute).
  const pending = !!pr && pr.state === 'open' && pr.checks.pending > 0;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => refresh(true), 20_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, card.id]);

  const sync = async () => {
    setBusy('sync');
    try {
      const r = await api.prSync(card.id);
      setConflict(r.conflict);
      (r.ok ? toasts.info : toasts.error)(r.message);
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const askAgent = async () => {
    setBusy('agent');
    try {
      await api.followup(
        card.id,
        `Nhánh của việc này đang xung đột với origin/${base}. Chạy \`git fetch origin ${base} && git merge origin/${base}\`, giải quyết hết xung đột (giữ đúng ý của cả hai bên), rồi chạy lại build và test. Không cần commit; Localkan sẽ commit và đẩy lên PR.`,
        [],
      );
      setConflict(false);
      toasts.info('Đã nhờ agent xử lý xung đột.');
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!pr) {
    return (
      <section className="pr-panel">
        <div className="pr-head">
          <strong>Pull Request</strong>
          <button className="btn ghost small" disabled={!!busy} onClick={() => refresh()} title="Kiểm tra lại trên GitHub">
            ↻
          </button>
        </div>
        <p className="muted small">
          {card.runState === 'running' || card.status === 'in_progress'
            ? 'PR sẽ được mở khi agent làm xong.'
            : project.git.autoDraftPr
              ? 'Chưa có PR. Localkan mở PR nháp ngay sau khi agent xong; nếu chưa thấy, xem log của việc.'
              : `Chưa có PR. Bấm Merge PR để đẩy nhánh lên, mở PR vào ${base} và merge.`}
        </p>
      </section>
    );
  }

  const ci = ciSummary(pr);
  return (
    <section className="pr-panel">
      <div className="pr-head">
        <a href={pr.url} target="_blank" rel="noreferrer" className="pr-link">
          PR #{pr.number}
        </a>
        {pr.draft && <span className="tag">Nháp</span>}
        {pr.state !== 'open' && <span className="tag">{pr.state === 'merged' ? 'Đã merge' : 'Đã đóng'}</span>}
        <span className="muted small">→ {pr.base}</span>
        <span className={`pr-ci ${ci.tone}`}>{ci.label}</span>
        <div className="spacer" />
        <button className="btn ghost small" disabled={!!busy} onClick={() => refresh()} title="Kiểm tra lại trên GitHub">
          {busy === 'refresh' ? '…' : '↻'}
        </button>
      </div>
      {pr.checks.failing.length > 0 && (
        <p className="small error-text">
          Kiểm tra lỗi: {pr.checks.failing.join(', ')}.{' '}
          <a href={`${pr.url}/checks`} target="_blank" rel="noreferrer">
            Xem trên GitHub
          </a>
        </p>
      )}
      {pr.state === 'open' && (pr.mergeable === 'conflicting' || conflict) && (
        <div className="notice small">
          Nhánh đang xung đột với <code>{pr.base}</code>.
          <div className="row wrap" style={{ marginTop: 6 }}>
            {!conflict && (
              <button className="btn small" disabled={!!busy} onClick={sync}>
                {busy === 'sync' ? 'Đang cập nhật…' : `Cập nhật theo ${pr.base}`}
              </button>
            )}
            <button className="btn small" disabled={!!busy} onClick={askAgent}>
              Nhờ agent xử lý xung đột
            </button>
          </div>
        </div>
      )}
      {pr.state === 'open' && pr.mergeable !== 'conflicting' && !conflict && (
        <button className="btn ghost small pr-sync" disabled={!!busy} onClick={sync} title={`Merge origin/${pr.base} mới nhất vào nhánh này`}>
          {busy === 'sync' ? 'Đang cập nhật…' : `Cập nhật theo ${pr.base}`}
        </button>
      )}
    </section>
  );
}

const FLOW_LABEL: Record<string, string> = { pr: 'PR', push: 'merge rồi push', local: 'merge cục bộ' };
const SHIPPED_LABEL: Record<string, string> = {
  merged: '✓ đã merge',
  pushed: '✓ đã merge và push',
  local: '✓ đã merge trên máy',
  skipped: 'không có thay đổi',
};

/** Multi-repo task: each repo's branch, how it ships, its PR and CI, and what is done. */
export function ReposPanel({ card, toasts }: { card: Card; toasts: ToastApi }) {
  const [busy, setBusy] = useState<string | null>(null);
  const prs = card.repos.filter((r) => r.pr && r.pr.state === 'open');
  const conflicting = prs.some((r) => r.pr!.mergeable === 'conflicting');

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="pr-panel">
      <div className="pr-head">
        <strong>{card.repos.length} repo</strong>
        <div className="spacer" />
        {card.status !== 'done' && (
          <>
            <button className="btn ghost small" disabled={!!busy} onClick={() => act('refresh', () => api.prRefresh(card.id))} title="Kiểm tra PR trên GitHub">
              {busy === 'refresh' ? '…' : '↻'}
            </button>
            <button
              className="btn ghost small"
              disabled={!!busy}
              title="Merge nhánh gốc mới nhất trên origin vào nhánh việc của từng repo"
              onClick={() =>
                act('sync', async () => {
                  const r = await api.prSync(card.id);
                  (r.ok ? toasts.info : toasts.error)(r.message);
                })
              }
            >
              {busy === 'sync' ? 'Đang cập nhật…' : 'Cập nhật theo nhánh gốc'}
            </button>
          </>
        )}
      </div>
      <ul className="repo-list">
        {card.repos.map((r) => {
          const ci = r.pr ? ciSummary(r.pr) : null;
          return (
            <li key={r.name}>
              <div className="repo-line">
                <code className="repo-name">{r.name}/</code>
                <span className="muted small">
                  {r.branch} → {r.base} · {FLOW_LABEL[r.flow] ?? r.flow}
                </span>
              </div>
              <div className="repo-line">
                {r.pr && (
                  <a href={r.pr.url} target="_blank" rel="noreferrer" className="pr-link small">
                    PR #{r.pr.number}
                    {r.pr.draft && r.pr.state === 'open' ? ' (nháp)' : ''}
                  </a>
                )}
                {r.pr && r.pr.state === 'open' && ci && <span className={`pr-ci ${ci.tone}`}>{ci.label}</span>}
                {r.pr && r.pr.state === 'open' && r.pr.mergeable === 'conflicting' && <span className="pr-ci danger">xung đột</span>}
                {r.shipped && <span className={`pr-ci ${r.shipped === 'skipped' ? 'muted' : 'ok'}`}>{SHIPPED_LABEL[r.shipped]}</span>}
                {!r.pr && !r.shipped && r.flow === 'pr' && <span className="muted small">chưa có PR</span>}
              </div>
              {r.pr && r.pr.state === 'open' && r.pr.checks.failing.length > 0 && (
                <p className="small error-text">Kiểm tra lỗi: {r.pr.checks.failing.join(', ')}</p>
              )}
            </li>
          );
        })}
      </ul>
      {conflicting && (
        <div className="row wrap">
          <button
            className="btn small"
            disabled={!!busy}
            onClick={() =>
              act('agent', () =>
                api.followup(
                  card.id,
                  `Một số repo đang xung đột với nhánh gốc trên origin (${prs.filter((r) => r.pr!.mergeable === 'conflicting').map((r) => `${r.name}/ với origin/${r.base}`).join(', ')}). Trong từng repo đó, chạy \`git fetch origin <nhánh gốc> && git merge origin/<nhánh gốc>\`, giải quyết hết xung đột, rồi chạy lại build và test. Không cần commit.`,
                  [],
                ),
              )
            }
          >
            Nhờ agent xử lý xung đột
          </button>
        </div>
      )}
    </section>
  );
}

/** What "Hoàn tất" will do on a multi-repo task, one line per repo. */
export function shipPlan(card: Card): string {
  return card.repos
    .filter((r) => !r.shipped)
    .map((r) => {
      const how = r.flow === 'pr' ? `merge PR${r.pr ? ` #${r.pr.number}` : ''} vào ${r.base}` : r.flow === 'push' ? `merge rồi push vào ${r.base}` : `merge vào ${r.base} trên máy`;
      return `• ${r.name}: ${how} (nếu có thay đổi)`;
    })
    .join('\n');
}
