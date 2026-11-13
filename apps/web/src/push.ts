// Web Push on this device: register the service worker, subscribe with the server's VAPID key,
// and keep the server's copy of the subscription in sync.

import type { NotifyPrefs, PushSubscriptionJSON } from '@localkan/protocol';
import { api } from './api.ts';

export type PushSupport =
  | { ok: true }
  | { ok: false; reason: 'insecure' | 'ios-browser' | 'unsupported' };

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; a Mac with a touch screen is an iPad.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && !/Android/.test(ua) && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
  // iOS only offers Web Push to web apps opened from the home screen.
  if (isIOS() && !isStandalone()) return { ok: false, reason: 'ios-browser' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, reason: 'unsupported' };
  }
  return { ok: true };
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    /* push simply stays unavailable */
  });
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
  return navigator.serviceWorker.ready.then(() => reg);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport().ok !== true) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

function toJSON(sub: PushSubscription): PushSubscriptionJSON {
  const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  return { endpoint: j.endpoint ?? sub.endpoint, keys: { p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '' } };
}

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** A short name for this device, shown nowhere sensitive (kept with the subscription). */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Linux';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Trình duyệt';
  return `${os} · ${browser}${isStandalone() ? ' (app)' : ''}`;
}

/** Ask permission (must run from a tap), subscribe, and register with the server. */
export async function enablePush(prefs?: Partial<NotifyPrefs>): Promise<{ sub: PushSubscription; prefs: NotifyPrefs }> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Thông báo đang bị chặn cho trang này. Mở cài đặt trang của trình duyệt (hoặc Cài đặt → Thông báo trên iPhone) để cho phép.'
        : 'Bạn chưa cho phép thông báo.',
    );
  }
  const { publicKey } = await api.pushConfig();
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  const key = base64UrlToBytes(publicKey);
  // A subscription made with another server key cannot receive our pushes: replace it.
  const existingKey = sub?.options.applicationServerKey;
  if (sub && existingKey && !sameBytes(new Uint8Array(existingKey), key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const r = await api.pushSubscribe(toJSON(sub), prefs, deviceLabel());
  return { sub, prefs: r.prefs };
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.pushDelete(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

export async function savePrefs(prefs: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
  const sub = await currentSubscription();
  if (!sub) throw new Error('Thiết bị này chưa bật thông báo.');
  return (await api.pushSubscribe(toJSON(sub), prefs, deviceLabel())).prefs;
}

/** On app start: if this device is subscribed, make sure the server still has it. */
export async function syncPush(): Promise<void> {
  try {
    if (Notification.permission !== 'granted') return;
    const sub = await currentSubscription();
    if (sub) await api.pushSubscribe(toJSON(sub), undefined, deviceLabel());
  } catch {
    /* best effort */
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
