import { useEffect, useRef, useState } from 'react';

// Minimal typing for the Web Speech API (not in TypeScript's DOM lib).
interface SpeechResultList {
  length: number;
  [i: number]: { isFinal: boolean; 0: { transcript: string } };
}
interface SpeechEvent {
  resultIndex: number;
  results: SpeechResultList;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const LANG_KEY = 'localkan.voiceLang';
const LANGS = [
  { code: 'vi-VN', label: 'VI' },
  { code: 'en-US', label: 'EN' },
];

function savedLang(): string {
  try {
    return localStorage.getItem(LANG_KEY) ?? 'vi-VN';
  } catch {
    return 'vi-VN';
  }
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Trình duyệt chưa được phép dùng micro. Hãy cho phép micro cho trang này rồi thử lại.',
  'service-not-allowed': 'Trình duyệt chặn dịch vụ nhận giọng nói cho trang này.',
  'audio-capture': 'Không tìm thấy micro.',
  network: 'Nhận giọng nói cần kết nối mạng (trình duyệt gửi âm thanh lên dịch vụ nhận dạng của nó).',
};

/**
 * Dictation into a text field. Final phrases are passed to `onFinal`; the phrase being spoken
 * is shown live through `onInterim`.
 */
export function VoiceButton({
  onFinal,
  onInterim,
  onError,
  big = false,
}: {
  onFinal: (text: string) => void;
  onInterim: (text: string) => void;
  onError: (message: string) => void;
  /** Large round mic with a caption (phone layout). */
  big?: boolean;
}) {
  const Ctor = recognitionCtor();
  const [listening, setListening] = useState(false);
  const [lang, setLang] = useState(savedLang);
  const rec = useRef<Recognition | null>(null);
  // Keep the latest callbacks without restarting recognition.
  const cb = useRef({ onFinal, onInterim, onError });
  cb.current = { onFinal, onInterim, onError };

  useEffect(() => () => rec.current?.stop(), []);

  const start = () => {
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) cb.current.onFinal(res[0].transcript.trim());
        else interim += res[0].transcript;
      }
      cb.current.onInterim(interim.trim());
    };
    r.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') cb.current.onError(ERRORS[e.error] ?? `Lỗi nhận giọng nói: ${e.error}`);
    };
    r.onend = () => {
      setListening(false);
      cb.current.onInterim('');
      rec.current = null;
    };
    rec.current = r;
    r.start();
    setListening(true);
  };

  const stop = () => rec.current?.stop();

  const changeLang = (code: string) => {
    setLang(code);
    try {
      localStorage.setItem(LANG_KEY, code);
    } catch {
      /* storage unavailable */
    }
  };

  if (!Ctor) {
    return (
      <span className="muted small" title="Dùng Chrome, Edge hoặc Safari để nhập bằng giọng nói">
        🎤 Trình duyệt này chưa hỗ trợ giọng nói
      </span>
    );
  }

  const langSelect = (
    <select
      className="voice-lang"
      value={lang}
      onChange={(e) => changeLang(e.target.value)}
      disabled={listening}
      aria-label="Ngôn ngữ giọng nói"
    >
      {LANGS.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );

  if (big) {
    return (
      <div className="voice-big">
        <button
          type="button"
          className={`voice-mic${listening ? ' recording' : ''}`}
          onClick={listening ? stop : start}
          aria-pressed={listening}
          aria-label={listening ? 'Dừng nghe' : 'Nói yêu cầu'}
        >
          {listening ? '■' : '🎤'}
        </button>
        <div className="voice-caption">
          <span>{listening ? 'Đang nghe… bấm lần nữa để dừng' : 'Bấm để nói, tự chuyển thành chữ'}</span>
          {langSelect}
        </div>
      </div>
    );
  }

  return (
    <div className="voice">
      <button
        type="button"
        className={`btn small ${listening ? 'recording' : ''}`}
        onClick={listening ? stop : start}
        aria-pressed={listening}
        title={listening ? 'Bấm để dừng' : 'Nói để điền mô tả'}
      >
        {listening ? '■ Đang nghe…' : '🎤 Nói'}
      </button>
      {langSelect}
    </div>
  );
}

/** Append a dictated phrase to existing text with sensible spacing. */
export function appendPhrase(text: string, phrase: string): string {
  if (!phrase) return text;
  if (!text) return phrase;
  return /\s$/.test(text) ? text + phrase : `${text} ${phrase}`;
}
