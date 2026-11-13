import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';

export function AuthScreen({ needsSetup, onDone }: { needsSetup: boolean; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (needsSetup) await api.setup(email, password);
      else await api.login(email, password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand big">
          <span className="brand-mark" aria-hidden>
            ▦
          </span>
          Localkan
        </div>
        <p className="muted">
          {needsSetup
            ? 'Tạo tài khoản đầu tiên cho máy chủ này.'
            : 'Đăng nhập để mở bảng điều phối agent.'}
        </p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Mật khẩu
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={needsSetup ? 8 : undefined}
            required
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary" disabled={busy}>
          {needsSetup ? 'Tạo tài khoản' : 'Đăng nhập'}
        </button>
      </form>
    </div>
  );
}
