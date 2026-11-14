import { useEffect, useState } from 'react';
import { SendHorizontal, X } from 'lucide-react';
import { AGENT_LABELS, AGENTS, type AgentId, type Card, type Project } from '@localkan/protocol';
import { api } from '../api.ts';
import { ImageAttachments } from '../components/ImageAttachments.tsx';
import { ModelSelect } from '../components/ModelSelect.tsx';
import { ParentSelect } from '../components/ParentSelect.tsx';
import type { ToastApi } from '../components/Toasts.tsx';
import { appendPhrase, VoiceButton } from '../components/VoiceButton.tsx';
import { useAgentModels } from '../hooks.ts';
import { agentText, readLastAgent, readLastModel, saveLastChoice } from '../models.ts';

const TEMPLATES: { label: string; text: string }[] = [
  {
    label: 'Sửa lỗi theo ảnh chụp',
    text: 'Sửa lỗi trong ảnh đính kèm. Tìm nguyên nhân, sửa, rồi mở trang trong trình duyệt để kiểm tra lại.',
  },
  {
    label: 'Viết test cho thay đổi gần đây',
    text: 'Viết test cho các thay đổi gần đây (xem git log và ghi chú bàn giao). Chạy test và sửa cho tới khi tất cả đều qua.',
  },
  { label: 'Cập nhật nội dung chữ', text: 'Cập nhật nội dung chữ: ' },
  {
    label: 'Nâng cấp dependencies',
    text: 'Nâng cấp dependencies lên bản mới nhất còn tương thích, chạy build và test, ghi lại những gì đã đổi.',
  },
];

export function NewTask({
  projects,
  cards,
  initialProjectId,
  toasts,
  onClose,
  onCreated,
}: {
  projects: Project[];
  cards: Card[];
  initialProjectId: string | null;
  toasts: ToastApi;
  onClose: () => void;
  onCreated: (card: Card) => void;
}) {
  const [projectId, setProjectId] = useState<string | null>(
    projects.some((p) => p.id === initialProjectId) ? initialProjectId : (projects[0]?.id ?? null),
  );
  // Opened before the boards loaded (e.g. reloading on this screen): pick one once they arrive.
  useEffect(() => {
    if (!projectId && projects.length)
      setProjectId(projects.some((p) => p.id === initialProjectId) ? initialProjectId : projects[0].id);
  }, [projects, projectId, initialProjectId]);
  const [agent, setAgent] = useState<AgentId>(readLastAgent);
  const deviceId = projects.find((p) => p.id === projectId)?.deviceId;
  const models = useAgentModels(deviceId);
  const [model, setModel] = useState<string | null>(() => readLastModel(agent, models));
  // Another board may run on another machine, with other models.
  useEffect(() => {
    setModel((m) => (m && models[agent]?.some((x) => x.id === m) ? m : readLastModel(agent, models)));
  }, [deviceId]);
  const [prompt, setPrompt] = useState('');
  const [interim, setInterim] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [autoPreview, setAutoPreview] = useState(true);
  const [askOnly, setAskOnly] = useState(false);
  const [parentCardId, setParentCardId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const boardCards = cards.filter((c) => c.projectId === projectId);

  const send = async () => {
    const text = prompt.trim();
    if (!project || !text) {
      toasts.error(project ? 'Hãy nói hoặc gõ yêu cầu.' : 'Hãy chọn bảng.');
      return;
    }
    setBusy(true);
    try {
      saveLastChoice(agent, model);
      const title = deriveTitle(text);
      const card = await api.createCard(project.id, {
        title,
        prompt: text,
        agent,
        model,
        mode: askOnly ? 'ask' : 'act',
        parentCardId,
        autoPreview: autoPreview && !askOnly,
      });
      if (images.length) {
        await api.uploadAttachments(card.id, images).catch((err) => toasts.error(`Chưa tải được ảnh: ${(err as Error).message}`));
      }
      if (project.status === 'ready') {
        await api.start(card.id);
        toasts.info(`Đã giao cho ${agentText({ agent, model }, models)}.`);
      } else {
        toasts.info('Đã tạo việc. Bảng chưa sẵn sàng nên việc nằm ở "Chưa giao".');
      }
      onCreated(card);
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-screen">
      <header className="m-bar">
        <button className="m-icon-btn" onClick={onClose} aria-label="Đóng">
          <X />
        </button>
        <h1>Việc mới</h1>
        <span className="m-icon-btn ghost" aria-hidden />
      </header>

      <div className="m-form">
        <section>
          <div className="m-label">Bảng</div>
          <div className="m-chips scroll">
            {projects.map((p) => (
              <button key={p.id} className={`m-chip${p.id === projectId ? ' on' : ''}`} onClick={() => setProjectId(p.id)}>
                {p.name}
              </button>
            ))}
          </div>
          {project && project.status !== 'ready' && (
            <p className="m-note warn">Bảng này chưa sẵn sàng ({project.status === 'error' ? project.error : 'đang chuẩn bị'}).</p>
          )}
        </section>

        <section>
          <div className="m-label">Agent</div>
          <div className="m-segment" role="radiogroup" aria-label="Agent">
            {AGENTS.map((a) => (
              <button
                key={a}
                role="radio"
                aria-checked={agent === a}
                className={agent === a ? 'on' : ''}
                onClick={() => {
                  setAgent(a);
                  setModel(readLastModel(a, models));
                }}
              >
                {AGENT_LABELS[a]}
              </button>
            ))}
          </div>
          <ModelSelect className="m-model" agent={agent} models={models} value={model} onChange={setModel} />
        </section>

        <section>
          <div className="m-label">Nói hoặc gõ yêu cầu</div>
          <textarea
            className="m-textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder="Ví dụ: Đổi nút “Đặt ngay” sang màu cam và gửi SMS xác nhận sau mỗi lần đặt."
          />
          {interim && <p className="interim">{interim}</p>}
          <VoiceButton big onFinal={(t) => setPrompt((p) => appendPhrase(p, t))} onInterim={setInterim} onError={toasts.error} />
          <ImageAttachments
            pending={images}
            onAdd={(files) => setImages((prev) => [...prev, ...files])}
            onRemovePending={(i) => setImages((prev) => prev.filter((_, j) => j !== i))}
            onError={toasts.error}
          />
        </section>

        <section>
          <div className="m-label">Mẫu nhanh</div>
          <div className="m-templates">
            {TEMPLATES.map((t) => (
              <button key={t.label} className="m-template" onClick={() => setPrompt((p) => (p.trim() ? `${p.trim()}\n${t.text}` : t.text))}>
                {t.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="m-label">Khi xong</div>
          <div className="m-toggles">
            <label className="m-toggle">
              <span>
                Tự chạy xem trước
                <small>Có link mở được trên điện thoại ngay khi agent xong</small>
              </span>
              <input type="checkbox" role="switch" checked={autoPreview && !askOnly} disabled={askOnly} onChange={(e) => setAutoPreview(e.target.checked)} />
            </label>
            <label className="m-toggle">
              <span>
                Chỉ hỏi, không sửa code
                <small>Agent trả lời câu hỏi về dự án, không đổi file nào</small>
              </span>
              <input type="checkbox" role="switch" checked={askOnly} onChange={(e) => setAskOnly(e.target.checked)} />
            </label>
          </div>
          {boardCards.some((c) => c.branch) && (
            <details className="m-more">
              <summary>Làm tiếp từ một việc trước</summary>
              <ParentSelect cards={boardCards} value={parentCardId} onChange={setParentCardId} />
            </details>
          )}
        </section>
      </div>

      <div className="m-bottom">
        <button className="m-cta" onClick={send} disabled={busy || !prompt.trim() || !project}>
          {busy ? (
            'Đang gửi…'
          ) : (
            <>
              <SendHorizontal aria-hidden /> Gửi cho {AGENT_LABELS[agent]}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/** A short card title from what was said: the first sentence, cut at a word boundary. */
export function deriveTitle(text: string, max = 70): string {
  const first = text.trim().split('\n')[0].trim();
  const sentence = first.split(/(?<=[.!?…])\s/)[0].replace(/[.!?…:]+$/, '').trim() || first;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, '')}…`;
}
