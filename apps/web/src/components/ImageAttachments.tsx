import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { ATTACHMENT_LIMITS, type Attachment } from '@localkan/protocol';
import { api } from '../api.ts';

const ACCEPT = ATTACHMENT_LIMITS.mimeTypes.join(',');

/** Check new files against the limits; returns the accepted files and any error message. */
export function acceptImages(files: File[], alreadyCount: number): { ok: File[]; error: string | null } {
  const ok: File[] = [];
  for (const f of files) {
    if (!(ATTACHMENT_LIMITS.mimeTypes as readonly string[]).includes(f.type)) {
      return { ok, error: `"${f.name}" không phải ảnh PNG, JPEG, WebP hoặc GIF.` };
    }
    if (f.size > ATTACHMENT_LIMITS.maxBytes) {
      return { ok, error: `"${f.name}" lớn hơn ${ATTACHMENT_LIMITS.maxBytes / 1024 / 1024} MB.` };
    }
    if (alreadyCount + ok.length >= ATTACHMENT_LIMITS.maxFiles) {
      return { ok, error: `Mỗi thẻ tối đa ${ATTACHMENT_LIMITS.maxFiles} ảnh.` };
    }
    ok.push(f);
  }
  return { ok, error: null };
}

/** Images pasted from the clipboard (screenshots) as named files. */
export function imagesFromClipboard(e: ClipboardEvent): File[] {
  const out: File[] = [];
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  for (const item of Array.from(e.clipboardData.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const f = item.getAsFile();
    if (!f) continue;
    const ext = f.type.split('/')[1] ?? 'png';
    out.push(new File([f], f.name && f.name !== 'image.png' ? f.name : `anh-dan-${stamp}-${out.length + 1}.${ext}`, { type: f.type }));
  }
  return out;
}

/**
 * Thumbnails for a card's images: `existing` ones already on the server and `pending` local
 * files not uploaded yet. Adding happens through the button, drag-and-drop, or paste.
 */
export function ImageAttachments({
  existing = [],
  pending = [],
  onAdd,
  onRemoveExisting,
  onRemovePending,
  onError,
  disabled = false,
}: {
  existing?: Attachment[];
  pending?: File[];
  onAdd?: (files: File[]) => void;
  onRemoveExisting?: (a: Attachment) => void;
  onRemovePending?: (index: number) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const previews = useMemo(() => pending.map((f) => URL.createObjectURL(f)), [pending]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const total = existing.length + pending.length;
  const add = (files: File[]) => {
    if (!onAdd || !files.length) return;
    const { ok, error } = acceptImages(files, total);
    if (ok.length) onAdd(ok);
    if (error) onError(error);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled) add(Array.from(e.dataTransfer.files));
  };

  return (
    <div
      className={`images ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        if (!onAdd || disabled) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {total > 0 && (
        <div className="thumbs">
          {existing.map((a) => (
            <figure key={a.id} className="thumb">
              <a href={api.attachmentUrl(a.id)} target="_blank" rel="noreferrer" title={a.name}>
                <img src={api.attachmentUrl(a.id)} alt={a.name} loading="lazy" />
              </a>
              {onRemoveExisting && !disabled && (
                <button type="button" className="thumb-x" onClick={() => onRemoveExisting(a)} aria-label={`Xóa ${a.name}`}>
                  <X />
                </button>
              )}
            </figure>
          ))}
          {pending.map((f, i) => (
            <figure key={`${f.name}-${i}`} className="thumb pending">
              <img src={previews[i]} alt={f.name} />
              {onRemovePending && !disabled && (
                <button type="button" className="thumb-x" onClick={() => onRemovePending(i)} aria-label={`Bỏ ${f.name}`}>
                  <X />
                </button>
              )}
            </figure>
          ))}
        </div>
      )}
      {onAdd && !disabled && total < ATTACHMENT_LIMITS.maxFiles && (
        <div className="images-add">
          <button type="button" className="btn ghost small" onClick={() => input.current?.click()}>
            <ImagePlus /> Thêm ảnh
          </button>
          <span className="muted small">
            <span className="pointer-only">hoặc kéo thả, hoặc dán (⌘V) ảnh chụp màn hình · </span>tối đa {ATTACHMENT_LIMITS.maxFiles} ảnh
          </span>
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              add(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>
      )}
    </div>
  );
}
