import { Fragment, useMemo, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import type { DiffResult, ReviewComment } from '@localkan/protocol';

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
  newLine: number | null;
  oldLine: number | null;
}

interface FilePatch {
  path: string;
  lines: DiffLine[];
}

/** Split a unified diff into per-file line lists with line numbers. */
function parsePatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/ b\/(.+)$/);
      cur = { path: m ? m[1] : raw.slice(11), lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('+++ ') || raw.startsWith('--- ') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ')) {
      if (raw.startsWith('+++ b/')) cur.path = raw.slice(6);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      cur.lines.push({ kind: 'hunk', text: raw, newLine: null, oldLine: null });
    } else if (raw.startsWith('+')) {
      cur.lines.push({ kind: 'add', text: raw.slice(1), newLine: newNo++, oldLine: null });
    } else if (raw.startsWith('-')) {
      cur.lines.push({ kind: 'del', text: raw.slice(1), newLine: null, oldLine: oldNo++ });
    } else if (raw.startsWith(' ')) {
      cur.lines.push({ kind: 'ctx', text: raw.slice(1), newLine: newNo++, oldLine: oldNo++ });
    }
  }
  return files;
}

export function DiffView({
  diff,
  comments,
  onAddComment,
  onRemoveComment,
}: {
  diff: DiffResult;
  comments: ReviewComment[];
  onAddComment: (c: ReviewComment) => void;
  onRemoveComment: (i: number) => void;
}) {
  const files = useMemo(() => parsePatch(diff.patch), [diff.patch]);
  const [draftAt, setDraftAt] = useState<{ path: string; idx: number } | null>(null);
  const [draft, setDraft] = useState('');

  if (!diff.files.length) return <p className="muted">Chưa có thay đổi nào so với {diff.baseRef}.</p>;

  const save = (file: FilePatch, idx: number) => {
    const line = file.lines[idx];
    if (!draft.trim()) return;
    const snippet = file.lines
      .slice(Math.max(0, idx - 2), idx + 3)
      .filter((l) => l.kind !== 'hunk')
      .map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text)
      .join('\n');
    onAddComment({ path: file.path, line: line.newLine ?? line.oldLine, text: draft.trim(), snippet });
    setDraft('');
    setDraftAt(null);
  };

  return (
    <div className="diff">
      <ul className="diff-files">
        {diff.files.map((f) => (
          <li key={f.path}>
            <span className={`fstatus fs-${f.status}`}>{f.status}</span>
            <code>{f.path}</code>
            <span className="add-n">+{f.additions}</span>
            <span className="del-n">−{f.deletions}</span>
          </li>
        ))}
      </ul>
      {files.map((file) => (
        <div className="diff-file" key={file.path}>
          <div className="diff-file-head">{file.path}</div>
          <table className="diff-table">
            <colgroup>
              <col className="ln-col" />
              <col className="ln-col" />
              <col />
            </colgroup>
            <tbody>
              {file.lines.map((l, idx) => {
                const lineComments = comments
                  .map((c, ci) => ({ c, ci }))
                  .filter(({ c }) => c.path === file.path && l.kind !== 'hunk' && c.line === (l.newLine ?? l.oldLine));
                return (
                  <Fragment key={idx}>
                    <tr
                      className={`dl dl-${l.kind}`}
                      onClick={() => l.kind !== 'hunk' && setDraftAt({ path: file.path, idx })}
                      title={l.kind !== 'hunk' ? 'Bấm để nhận xét dòng này' : undefined}
                    >
                      <td className="ln">{l.oldLine ?? ''}</td>
                      <td className="ln">{l.newLine ?? ''}</td>
                      <td className="code">
                        <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : l.kind === 'hunk' ? '' : ' '}</span>
                        {l.text}
                      </td>
                    </tr>
                    {lineComments.map(({ c, ci }) => (
                      <tr key={`c${ci}`} className="dl-comment">
                        <td colSpan={2} />
                        <td>
                          <div className="comment">
                            <MessageSquare /> {c.text}
                            <button className="btn ghost small" onClick={() => onRemoveComment(ci)}>
                              Xóa
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {draftAt?.path === file.path && draftAt.idx === idx && (
                      <tr className="dl-comment">
                        <td colSpan={2} />
                        <td>
                          <div className="comment-form">
                            <textarea
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              placeholder="Yêu cầu agent sửa gì ở đây?"
                              rows={2}
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(file, idx);
                                if (e.key === 'Escape') setDraftAt(null);
                              }}
                            />
                            <div className="row">
                              <button className="btn primary small" onClick={() => save(file, idx)}>
                                Thêm nhận xét
                              </button>
                              <button className="btn ghost small" onClick={() => setDraftAt(null)}>
                                Hủy
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
