import { useMemo, type ReactNode } from 'react';
import { CircleDollarSign, Monitor } from 'lucide-react';
import {
  CARD_STATUSES,
  CARD_STATUS_LABELS,
  FALLBACK_MODELS,
  formatTokens,
  formatUsd,
  summarizeUsage,
  type Card,
  type CardStatus,
  type Device,
  type Project,
} from '@localkan/protocol';
import type { AgentModels } from '../hooks.ts';
import { badge, bucket, byUrgency, timeAgo } from '../mobile/status.ts';
import { agentText } from '../models.ts';
import { formatReport, plainText } from '../text.ts';
import { CONTEXT_WARN } from './UsageView.tsx';

/** Every board on one screen: what needs you, what the agents are doing right now, and how
 *  each board stands. Cards open in place; a board opens its Kanban. */
export function Dashboard({
  projects,
  devices,
  cards,
  activity,
  onOpenCard,
  onOpenBoard,
}: {
  projects: Project[];
  devices: Device[];
  /** Cards of every board. */
  cards: Card[];
  /** The latest step of each working card's agent. */
  activity: Record<string, string>;
  onOpenCard: (card: Card) => void;
  onOpenBoard: (projectId: string) => void;
}) {
  const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Bảng';
  const modelsOf = (projectId: string): AgentModels => {
    const deviceId = projects.find((p) => p.id === projectId)?.deviceId;
    return { ...FALLBACK_MODELS, ...devices.find((d) => d.id === deviceId)?.info?.models };
  };

  const you = useMemo(
    () => cards.filter((c) => bucket(c) === 'you' || bucket(c) === 'failed').sort(byUrgency(projectIds)),
    [cards, projectIds],
  );
  const running = useMemo(() => cards.filter((c) => bucket(c) === 'running').sort((a, b) => a.statusAt.localeCompare(b.statusAt)), [cards]);
  const today = new Date().toDateString();
  const doneToday = cards.filter((c) => c.status === 'done' && new Date(c.statusAt).toDateString() === today).length;
  const cost = useMemo(() => summarizeUsage(cards.map((c) => c.usage)), [cards]);
  const online = devices.filter((d) => d.online).length;
  const count = (b: ReturnType<typeof bucket>) => cards.filter((c) => bucket(c) === b).length;

  return (
    <div className="dash">
      <div className="dash-stats">
        <Stat tone="warn" value={count('you')} label="Cần bạn" />
        <Stat tone="info" value={running.length} label="Đang chạy" />
        <Stat tone="danger" value={count('failed')} label="Lỗi / đã dừng" />
        <Stat tone="muted" value={count('todo')} label="Chờ giao (To Do)" />
        <Stat tone="ok" value={doneToday} label="Xong hôm nay" />
        <Stat
          tone="muted"
          value={cost.tokens ? formatUsd(cost.usd) : '—'}
          label="Chi phí AI (ước tính)"
          icon={<CircleDollarSign aria-hidden />}
          title={cost.tokens ? `${formatTokens(cost.tokens)} token, theo giá API` : 'Chưa đo'}
        />
        <Stat
          tone={devices.length && online === devices.length ? 'ok' : 'danger'}
          value={`${online}/${devices.length}`}
          label="Máy online"
          icon={<Monitor aria-hidden />}
          title={devices.map((d) => `${d.name}: ${d.online ? 'online' : 'offline'}`).join('\n')}
        />
      </div>

      <div className="dash-main">
        <section className="dash-col tone-warn" aria-label="Cần bạn xử lý">
          <header className="dash-col-head">
            <strong>Cần bạn xử lý</strong>
            <span className="count">{you.length}</span>
          </header>
          <div className="dash-list">
            {you.length === 0 && <p className="muted small dash-empty">Không có việc nào chờ bạn.</p>}
            {you.map((c) => (
              <CardItem key={c.id} card={c} board={name(c.projectId)} onOpen={onOpenCard}>
                <p className="dash-detail">{waitingText(c)}</p>
                <p className="dash-foot muted small">
                  {agentText(c, modelsOf(c.projectId))} · {timeAgo(c.statusAt)}
                </p>
              </CardItem>
            ))}
          </div>
        </section>

        <section className="dash-col tone-info" aria-label="Đang chạy">
          <header className="dash-col-head">
            <strong>Đang chạy</strong>
            <span className="count">{running.length}</span>
          </header>
          <div className="dash-list">
            {running.length === 0 && <p className="muted small dash-empty">Không có agent nào đang chạy.</p>}
            {running.map((c) => {
              const s = summarizeUsage([c.usage]);
              const ctx = c.usage?.contextTokens;
              return (
                <CardItem key={c.id} card={c} board={name(c.projectId)} onOpen={onOpenCard}>
                  <p className="dash-activity" title={activity[c.id]}>
                    {activity[c.id] ?? (c.runState === 'starting' ? 'Đang khởi động agent…' : 'Đang làm…')}
                  </p>
                  <p className="dash-foot muted small">
                    {agentText(c, modelsOf(c.projectId))} · chạy từ {timeAgo(c.statusAt)}
                    {s.tokens > 0 && <> · {formatUsd(s.usd)}</>}
                    {ctx ? <span className={ctx > CONTEXT_WARN ? 'warn-text' : undefined}> · ctx {formatTokens(ctx)}</span> : null}
                  </p>
                </CardItem>
              );
            })}
          </div>
        </section>

        <section className="dash-col dash-boards" aria-label="Các bảng">
          <header className="dash-col-head">
            <strong>Các bảng</strong>
            <span className="count">{projects.length}</span>
          </header>
          <div className="dash-list">
            {projects.length === 0 && <p className="muted small dash-empty">Chưa có bảng nào.</p>}
            {projects.map((p) => (
              <BoardTile
                key={p.id}
                project={p}
                device={devices.find((d) => d.id === p.deviceId) ?? null}
                cards={cards.filter((c) => c.projectId === p.id)}
                onOpen={() => onOpenBoard(p.id)}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({
  tone,
  value,
  label,
  icon,
  title,
}: {
  tone: 'warn' | 'info' | 'danger' | 'ok' | 'muted';
  value: number | string;
  label: string;
  icon?: ReactNode;
  title?: string;
}) {
  return (
    <div className={`dash-stat tone-${tone}`} title={title}>
      <strong>
        {icon}
        {value}
      </strong>
      <span>{label}</span>
    </div>
  );
}

function CardItem({ card, board, onOpen, children }: { card: Card; board: string; onOpen: (c: Card) => void; children: ReactNode }) {
  const b = badge(card);
  return (
    <button className="dash-item" onClick={() => onOpen(card)}>
      <span className="dash-item-top">
        <span className="dash-board">{board}</span>
        <span className={`m-badge ${b.tone}`}>
          <b.Icon aria-hidden /> {b.label}
        </span>
      </span>
      <span className="dash-title">{card.title}</span>
      {children}
    </button>
  );
}

/** What the card waits on, in one line: the question, the report, or the error. */
function waitingText(c: Card): string {
  if (c.status === 'needs_input' && c.waiting) return plainText(c.waiting.text).slice(0, 220);
  if (c.error) return c.error.split('\n')[0].slice(0, 220);
  if (c.summary) return plainText(formatReport(c.summary)).slice(0, 220);
  return c.runState === 'stopped' ? 'Agent đã dừng.' : 'Chờ bạn xem kết quả.';
}

const STATUS_SHORT: Record<CardStatus, string> = {
  todo: 'To Do',
  in_progress: 'đang chạy',
  needs_input: 'cần bạn',
  review: 'review',
  done: 'xong',
};

function BoardTile({ project, device, cards, onOpen }: { project: Project; device: Device | null; cards: Card[]; onOpen: () => void }) {
  const counts = CARD_STATUSES.map((s) => [s, cards.filter((c) => c.status === s).length] as const);
  const total = cards.length;
  const cost = summarizeUsage(cards.map((c) => c.usage));
  const last = cards.reduce<string | null>((m, c) => (!m || c.updatedAt > m ? c.updatedAt : m), null);
  return (
    <button className="dash-board-tile" onClick={onOpen} title={`Mở bảng ${project.name}`}>
      <span className="dash-board-head">
        <strong>{project.name}</strong>
        <span className="muted small dash-device">
          <span className={`dot ${device?.online ? 'ok' : 'off'}`} aria-hidden /> {device?.name ?? 'Chưa có máy'}
        </span>
      </span>
      <span className="dash-bar" aria-hidden>
        {total === 0 ? (
          <span className="dash-bar-empty" />
        ) : (
          counts.filter(([, n]) => n > 0).map(([s, n]) => <span key={s} className={`seg s-${s}`} style={{ flexGrow: n }} />)
        )}
      </span>
      <span className="dash-counts small">
        {total === 0
          ? 'Chưa có thẻ'
          : counts
              .filter(([, n]) => n > 0)
              .map(([s, n]) => (
                <span key={s} className={`c-${s}`} title={CARD_STATUS_LABELS[s]}>
                  {n} {STATUS_SHORT[s]}
                </span>
              ))}
      </span>
      <span className="muted small">
        {cost.tokens > 0 ? `${formatUsd(cost.usd)} chi phí AI` : 'Chưa đo chi phí'}
        {last && ` · hoạt động ${timeAgo(last)}`}
      </span>
    </button>
  );
}
