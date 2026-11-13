import { useState, type FormEvent } from 'react';
import { AGENT_LABELS, AGENTS, type AgentId, type Card, type CardMode } from '@localkan/protocol';
import { api } from '../api.ts';
import { Dialog } from './Dialog.tsx';
import { ImageAttachments, imagesFromClipboard, acceptImages } from './ImageAttachments.tsx';
import { ParentSelect } from './ParentSelect.tsx';
import type { ToastApi } from './Toasts.tsx';
import { appendPhrase, VoiceButton } from './VoiceButton.tsx';

export function NewCardDialog({
  projectId,
  cards,
  onClose,
  toasts,
}: {
  projectId: string;
  cards: Card[];
  onClose: () => void;
  toasts: ToastApi;
}) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [interim, setInterim] = useState('');
  const [agent, setAgent] = useState<AgentId>('claude');
  const [mode, setMode] = useState<CardMode>('act');
  const [images, setImages] = useState<File[]>([]);
  const [parentCardId, setParentCardId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const finalTitle = title.trim() || prompt.trim().split('\n')[0].slice(0, 80);
    if (!finalTitle) {
      toasts.error('Hãy nhập tiêu đề hoặc mô tả.');
      return;
    }
    setBusy(true);
    try {
      const card = await api.createCard(projectId, { title: finalTitle, prompt, agent, mode, parentCardId });
      if (images.length) {
        try {
          await api.uploadAttachments(card.id, images);
        } catch (err) {
          toasts.error(`Đã tạo thẻ nhưng chưa tải được ảnh: ${(err as Error).message}`);
        }
      }
      onClose();
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Thẻ mới" onClose={onClose}>
      <form
        className="form"
        onSubmit={submit}
        onPaste={(e) => {
          const pasted = imagesFromClipboard(e);
          if (!pasted.length) return;
          e.preventDefault();
          const { ok, error } = acceptImages(pasted, images.length);
          if (ok.length) setImages((prev) => [...prev, ...ok]);
          if (error) toasts.error(error);
        }}
      >
        <label>
          Tiêu đề
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ví dụ: Thêm trang đăng nhập" autoFocus />
        </label>
        <div className="field">
          <div className="field-head">
            <span>Mô tả cho agent</span>
            <VoiceButton
              onFinal={(t) => setPrompt((p) => appendPhrase(p, t))}
              onInterim={setInterim}
              onError={toasts.error}
            />
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Làm gì, ở đâu, ràng buộc nào, kiểm tra thế nào là xong… Có thể bấm 🎤 Nói để đọc."
            rows={7}
          />
          {interim && <p className="interim">{interim}</p>}
        </div>
        <div className="field">
          <span className="field-label">Ảnh minh họa</span>
          <ImageAttachments
            pending={images}
            onAdd={(files) => setImages((prev) => [...prev, ...files])}
            onRemovePending={(i) => setImages((prev) => prev.filter((_, j) => j !== i))}
            onError={toasts.error}
          />
        </div>
        <ParentSelect cards={cards} value={parentCardId} onChange={setParentCardId} />
        <div className="row">
          <select value={agent} onChange={(e) => setAgent(e.target.value as AgentId)} aria-label="Agent">
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {AGENT_LABELS[a]}
              </option>
            ))}
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value as CardMode)} aria-label="Chế độ">
            <option value="act">Làm (sửa code)</option>
            <option value="ask">Hỏi (chỉ đọc)</option>
          </select>
        </div>
        <div className="row">
          <button className="btn primary" disabled={busy}>
            {busy ? 'Đang tạo…' : images.length ? `Thêm thẻ (${images.length} ảnh)` : 'Thêm thẻ'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Hủy
          </button>
        </div>
      </form>
    </Dialog>
  );
}
