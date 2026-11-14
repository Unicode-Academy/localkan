import { createContext, useContext, useEffect, useState } from 'react';
import { FALLBACK_MODELS, type AgentId, type AgentModel, type Device } from '@localkan/protocol';

export const NARROW = '(max-width: 760px)';

/** True on phone-sized screens. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(NARROW).matches);
  useEffect(() => {
    const m = matchMedia(NARROW);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

// Open modals, so nested ones (a dialog over the card panel) share one lock.
let locks = 0;
let saved: { y: number; css: string } | null = null;

function lock() {
  if (locks++ > 0) return;
  const body = document.body;
  saved = { y: window.scrollY, css: body.style.cssText };
  // iOS Safari keeps scrolling the page under `overflow: hidden`; pinning the body is the lock
  // it honours. The offset keeps the page where it was.
  Object.assign(body.style, { position: 'fixed', top: `-${saved.y}px`, left: '0', right: '0', overflow: 'hidden' });
}

function unlock() {
  if (--locks > 0 || !saved) return;
  const { y, css } = saved;
  saved = null;
  document.body.style.cssText = css;
  window.scrollTo(0, y);
}

/** Stop the page behind a modal from scrolling while `active`. */
export function useScrollLock(active = true) {
  useEffect(() => {
    if (!active) return;
    lock();
    return unlock;
  }, [active]);
}

/** Paired machines, for components that need what a bridge reported (agent models…). */
export const DevicesContext = createContext<Device[]>([]);

export type AgentModels = Partial<Record<AgentId, AgentModel[]>>;

/** Models each agent offers on the machine `deviceId` (Claude's aliases until it reports). */
export function useAgentModels(deviceId: string | null | undefined): AgentModels {
  const devices = useContext(DevicesContext);
  const reported = devices.find((d) => d.id === deviceId)?.info?.models;
  return { ...FALLBACK_MODELS, ...reported };
}
