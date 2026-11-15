import { useEffect, useRef, useState } from 'react';
import { CircleUserRound, LogOut } from 'lucide-react';

/** The signed-in account in the top bar: its email and "Đăng xuất" in a small menu. */
export function AccountMenu({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className="account" ref={ref}>
      <button
        className="btn ghost"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Tài khoản"
        title={email}
      >
        <CircleUserRound />
      </button>
      {open && (
        <div className="account-menu" role="menu">
          <div className="account-email muted small">{email}</div>
          <button className="btn ghost account-item" role="menuitem" onClick={onLogout}>
            <LogOut /> Đăng xuất
          </button>
        </div>
      )}
    </div>
  );
}
