import { useState, type FormEvent } from 'react';
import { AGENT_LABELS, AGENTS, CARD_MODES, type AgentId, type Card, type CardMode, type Effort } from '@localkan/protocol';
import { api } from '../api.ts';
import { useAgentModels } from '../hooks.ts';
import { MODE_LABELS, MODE_PROMPT } from '../modes.ts';
import { readLastAgent, readLastEffort, readLastModel, saveLastChoice } from '../models.ts';
import { deriveTitle } from '../text.ts';
import { Dialog } from './Dialog.tsx';
import { ImageAttachments, imagesFromClipboard, acceptImages } from './ImageAttachments.tsx';
import { EffortSelect, ModelSelect } from './ModelSelect.tsx';
import { ParentSelect } from './ParentSelect.tsx';
import type { ToastApi } from './Toasts.tsx';
import { appendPhrase, VoiceButton } from './VoiceButton.tsx';

export function NewCardDialog({
  projectId,
  deviceId,
  cards,
  initialMode = 'act',
  onClose,
  toasts,
}: {
  projectId: string;
  /** Machine the board runs on: its agents' model lists. */
  deviceId: string;
  cards: Card[];
  initialMode?: CardMode;
  onClose: () => void;
  toasts: ToastApi;
}) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [interim, setInterim] = useState('');
  const models = useAgentModels(deviceId);
  const [agent, setAgent] = useState<AgentId>(readLastAgent);
  const [model, setModel] = useState<string | null>(() => readLastModel(agent, models));
  const [effort, setEffort] = useState<Effort | null>(readLastEffort);
  const [mode, setMode] = useState<CardMode>(initialMode);
  const [images, setImages] = useState<File[]>([]);
  const [parentCardId, setParentCardId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // The title is optional: without one, the first sentence of the description is used.
    const finalTitle = title.trim() || deriveTitle(prompt);
    if (!finalTitle) {
      toasts.error('Hãy nhập mô tả.');
      return;
    }
    setBusy(true);
    try {
      const card = await api.createCard(projectId, { title: finalTitle, prompt, agent, model, effort, mode, parentCardId });
      saveLastChoice(agent, model, effort);
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
    <Dialog title={initialMode === 'plan' ? 'Lập kế hoạch' : 'Thẻ mới'} onClose={onClose}>
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
        <div className="field">
          <div className="field-head">
            <span>{MODE_PROMPT[mode].label}</span>
            <VoiceButton
              onFinal={(t) => setPrompt((p) => appendPhrase(p, t))}
              onInterim={setInterim}
              onError={toasts.error}
            />
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={MODE_PROMPT[mode].placeholder}
            rows={7}
            autoFocus
          />
          {interim && <p className="interim">{interim}</p>}
        </div>
        <label>
          <span>
            Tiêu đề <span className="muted small">· không bắt buộc</span>
          </span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bỏ trống thì lấy câu đầu của mô tả" />
        </label>
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
        <div className="row wrap pickers">
          <select
            value={agent}
            onChange={(e) => {
              const a = e.target.value as AgentId;
              setAgent(a);
              setModel(readLastModel(a, models));
            }}
            aria-label="Agent"
          >
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {AGENT_LABELS[a]}
              </option>
            ))}
          </select>
          <ModelSelect agent={agent} models={models} value={model} onChange={setModel} />
          <EffortSelect value={effort} onChange={setEffort} />
          <select value={mode} onChange={(e) => setMode(e.target.value as CardMode)} aria-label="Chế độ">
            {CARD_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
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
