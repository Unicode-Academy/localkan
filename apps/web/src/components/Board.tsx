import { useState, type DragEvent } from 'react';
import { CirclePause, CornerDownRight, Eye, Image, KeyRound } from 'lucide-react';
import {
  type Card,
  CARD_STATUS_LABELS,
  CARD_STATUSES,
  type CardStatus,
  type Device,
  type Project,
} from '@localkan/protocol';
import { api } from '../api.ts';
import { useAgentModels, type AgentModels } from '../hooks.ts';
import { agentText } from '../models.ts';
import { NewCardDialog } from './NewCardDialog.tsx';
import { RunBadge } from './RunBadge.tsx';
import type { ToastApi } from './Toasts.tsx';
import { CiLabel, ciSummary } from './PrPanel.tsx';

const COLUMN_HINTS: Record<CardStatus, string> = {
  todo: 'Kéo sang In Progress để giao cho agent',
  in_progress: 'Agent đang làm trong worktree riêng',
  needs_input: 'Agent đang chờ bạn trả lời hoặc duyệt',
  review: 'Xem diff, nhận xét hoặc hoàn tất',
  done: 'Đã commit, tạo PR, merge hoặc hủy',
};

export function Board({
  project,
  device,
  cards,
  onOpen,
  onRetryProject,
  toasts,
}: {
  project: Project;
  device: Device | null;
  cards: Card[];
  onOpen: (id: string) => void;
  onRetryProject: () => void;
  toasts: ToastApi;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<CardStatus | null>(null);
  const [creating, setCreating] = useState(false);
  const models = useAgentModels(project.deviceId);

  const byStatus = (s: CardStatus) => cards.filter((c) => c.status === s).sort((a, b) => a.position - b.position);

  const onDrop = async (e: DragEvent, target: CardStatus) => {
    e.preventDefault();
    setOverCol(null);
    const id = e.dataTransfer.getData('text/card-id') || dragId;
    setDragId(null);
    const card = cards.find((c) => c.id === id);
    if (!card || card.status === target) return;
    try {
      if (card.status === 'todo' && target === 'in_progress') {
        await api.start(card.id);
      } else if (target === 'done' && card.status === 'review') {
        onOpen(card.id); // finishing needs a choice (commit / PR / merge / discard)
        toasts.info('Chọn cách hoàn tất trong bảng chi tiết của thẻ.');
      } else {
        toasts.info('Thẻ chuyển cột theo trạng thái của agent. Mở thẻ để thao tác.');
      }
    } catch (err) {
      toasts.error((err as Error).message);
    }
  };

  return (
    <div className="board-wrap">
      {project.status !== 'ready' && (
        <div className={`banner ${project.status === 'error' ? 'error' : ''}`}>
          {project.status === 'pending' ? 'Đang đăng ký repo với Orca…' : `Chưa đăng ký được repo: ${project.error}`}
          {project.status === 'error' && (
            <button className="btn small" onClick={onRetryProject}>
              Thử lại
            </button>
          )}
        </div>
      )}
      {device && !device.online && (
        <div className="banner">
          Máy <strong>{device.name}</strong> đang offline. Mở Localkan Bridge trên máy đó để agent chạy được.
        </div>
      )}
      <div className="board">
        {CARD_STATUSES.map((status) => {
          const list = byStatus(status);
          return (
            <section
              key={status}
              className={`column col-${status} ${overCol === status ? 'drop' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOverCol(status);
              }}
              onDragLeave={() => setOverCol((s) => (s === status ? null : s))}
              onDrop={(e) => onDrop(e, status)}
            >
              <header className="column-head">
                <h3>{CARD_STATUS_LABELS[status]}</h3>
                <span className="count">{list.length}</span>
              </header>
              <p className="column-hint">{COLUMN_HINTS[status]}</p>
              <div className="column-body">
                {list.map((c) => (
                  <CardTile
                    key={c.id}
                    card={c}
                    models={models}
                    parentTitle={c.parentCardId ? cards.find((x) => x.id === c.parentCardId)?.title ?? null : null}
                    onOpen={() => onOpen(c.id)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/card-id', c.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragId(c.id);
                    }}
                  />
                ))}
                {status === 'todo' && (
                  <button className="btn ghost add-card" onClick={() => setCreating(true)}>
                    + Thêm thẻ
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {creating && <NewCardDialog projectId={project.id} deviceId={project.deviceId} cards={cards} onClose={() => setCreating(false)} toasts={toasts} />}
    </div>
  );
}

function CardTile({
  card,
  models,
  parentTitle,
  onOpen,
  onDragStart,
}: {
  card: Card;
  models: AgentModels;
  parentTitle: string | null;
  onOpen: () => void;
  onDragStart: (e: DragEvent) => void;
}) {
  return (
    <article
      className={`tile ${card.waiting ? 'waiting' : ''}`}
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
      tabIndex={0}
    >
      <div className="tile-title">{card.title}</div>
      {parentTitle && <div className="tile-parent"><CornerDownRight /> tiếp từ: {parentTitle}</div>}
      {card.waiting && (
        <div className="tile-waiting">
          {card.waiting.kind === 'login' ? (
            <>
              <KeyRound /> Cần đăng nhập ·{' '}
            </>
          ) : (
            <>
              <CirclePause />{' '}
            </>
          )}
          {card.waiting.text.split('\n')[0].slice(0, 90)}
        </div>
      )}
      {card.error && <div className="tile-error">{card.error.slice(0, 120)}</div>}
      <div className="tile-meta">
        <span className={`agent agent-${card.agent}`} title={agentText(card, models)}>
          {agentText(card, models)}
        </span>
        {card.mode === 'ask' && <span className="tag">Hỏi</span>}
        {card.repos.length > 0 && (
          <span className="tag" title={card.repos.map((r) => r.name).join(', ')}>
            {card.repos.length} repo
          </span>
        )}
        {card.pr && card.pr.state === 'open' && (
          <span className={`tag pr-ci ${ciSummary(card.pr).tone}`} title={`PR #${card.pr.number}${card.pr.draft ? ' (nháp)' : ''}`}>
            PR #{card.pr.number} <CiLabel pr={card.pr} short />
          </span>
        )}
        {card.attachments.length > 0 && <span className="tag" title="Ảnh đính kèm">
            <Image /> {card.attachments.length}
          </span>}
        {card.preview?.status === 'running' && (
          <span className="tag preview-tag" title={card.preview.url ? 'Đang xem trước, có link từ xa' : 'Đang xem trước trên máy'}>
            <Eye /> {card.preview.url ? 'link' : 'local'}
          </span>
        )}
        <div className="spacer" />
        <RunBadge state={card.runState} />
      </div>
    </article>
  );
}
