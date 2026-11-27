import { useEffect, useMemo, useState } from 'react';
import { HANDOFF_STATUS_LABELS, type Card, type HandoffNote, type HandoffStatus, type LogLine, type Project } from '@localkan/protocol';
import { api } from '../api.ts';
import { exchange, EXCHANGE_LABELS } from '../exchange.ts';
import { clockLabel, formatReport, listChoices } from '../text.ts';
import { Markdown } from './Markdown.tsx';


/** What finishing the card did ("Đã merge … vào main"). */
export function Outcome({ card }: { card: Card }) {
  if (card.status !== 'done' || !card.outcome || card.outcome === card.summary) return null;
  return (
    <p className="outcome">
      <span className="muted">Kết quả:</span> {card.outcome}
    </p>
  );
}

/**
 * Everything said on the card, to read back once it is done: the agent's reports and questions,
 * your answers and requests (each round when the card was reopened), a question card's answer,
 * and the handoff note the agent wrote.
 */
export function ExchangeView({ card, project, log }: { card: Card; project: Project; log: LogLine[] }) {
  const items = useMemo(() => exchange(log), [log]);
  // undefined while loading; null when the agent wrote none.
  const [note, setNote] = useState<HandoffNote | null | undefined>(undefined);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [showNote, setShowNote] = useState(true);
  useEffect(() => {
    let live = true;
    setNoteError(null);
    api.handoffs(project.id).then(
      (r) => live && setNote(r.handoffs.find((n) => n.cardId === card.id) ?? null),
      (e: Error) => {
        if (!live) return;
        setNote(null);
        setNoteError(e.message);
      },
    );
    return () => {
      live = false;
    };
    // A finished round rewrites the note.
  }, [project.id, card.id, card.status, card.reopens]);

  return (
    <div className="exchange-view">
      {card.mode === 'ask' && card.answerText && (
        <section className="answer">
          <div className="summary-head">Câu trả lời</div>
          <Markdown text={card.answerText} />
        </section>
      )}

      <section>
        <div className="summary-head">Trao đổi với agent</div>
        {items.length === 0 ? (
          <p className="muted small">
            {log.length === 0 ? 'Đang tải…' : 'Chưa có báo cáo, câu hỏi hay yêu cầu nào trên thẻ này.'}
          </p>
        ) : (
          <ol className="exchange">
            {items.map((it) => (
              <li key={it.seq} className={`ex-item ex-${it.who} ex-${it.kind}${it.partial ? ' partial' : ''}`}>
                <div className="ex-head">
                  <span className="ex-label">{EXCHANGE_LABELS[it.kind]}</span>
                  <span className="muted small">{clockLabel(it.ts)}</span>
                </div>
                <Markdown
                  text={it.kind === 'report' ? formatReport(it.text) : it.kind === 'ask' ? listChoices(it.text) : it.text}
                  className="ex-text"
                />
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="handoff">
        <button className="handoff-head" onClick={() => setShowNote((v) => !v)} aria-expanded={showNote}>
          <strong>Ghi chú bàn giao</strong>
          {note && <span className={`tag status-${note.status}`}>{HANDOFF_STATUS_LABELS[note.status as HandoffStatus] ?? note.status}</span>}
          {note && <span className="muted small">{clockLabel(note.updatedAt)}</span>}
        </button>
        {showNote &&
          (note === undefined ? (
            <p className="muted small">Đang tải…</p>
          ) : noteError ? (
            <p className="muted small">Không đọc được ghi chú bàn giao (máy chạy bridge cần đang bật): {noteError}</p>
          ) : note === null ? (
            <p className="muted small">Agent chưa viết ghi chú bàn giao cho thẻ này.</p>
          ) : (
            <Markdown text={note.content} className="prompt" />
          ))}
      </section>
    </div>
  );
}
