import { useCallback, useState, type ClipboardEvent } from 'react';
import { api } from '../api.ts';
import { acceptImages, ImageAttachments, imagesFromClipboard } from './ImageAttachments.tsx';

/** Images picked for one message to the agent (a request, an answer), not uploaded yet. */
export interface ImageDraft {
  files: File[];
  add: (files: File[]) => void;
  remove: (index: number) => void;
  clear: () => void;
  /** For the message's text box: a pasted screenshot becomes an image of the message. */
  onPaste: (e: ClipboardEvent) => void;
  /** Upload to the card; the ids to send with the message. */
  upload: (cardId: string) => Promise<string[]>;
}

export function useImageDraft(onError: (message: string) => void): ImageDraft {
  const [files, setFiles] = useState<File[]>([]);
  const add = useCallback(
    (picked: File[]) => {
      const { ok, error } = acceptImages(picked, files.length);
      if (error) onError(error);
      if (ok.length) setFiles((prev) => [...prev, ...ok]);
    },
    [files.length, onError],
  );
  return {
    files,
    add,
    remove: (i) => setFiles((prev) => prev.filter((_, j) => j !== i)),
    clear: () => setFiles([]),
    onPaste: (e) => {
      const images = imagesFromClipboard(e);
      if (images.length) {
        e.preventDefault();
        add(images);
      }
    },
    upload: async (cardId) => (files.length ? ((await api.uploadAttachments(cardId, files)).added ?? []) : []),
  };
}

/** Thumbnails of a message's images and a small "add image" button (or drop / paste). */
export function DraftImages({ draft, onError, disabled = false }: { draft: ImageDraft; onError: (m: string) => void; disabled?: boolean }) {
  return (
    <ImageAttachments pending={draft.files} onAdd={draft.add} onRemovePending={draft.remove} onError={onError} disabled={disabled} compact />
  );
}
