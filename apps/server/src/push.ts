// Web Push notifications: "task done", "needs you", "failed".
//
// Browsers subscribe with the server's VAPID public key; the server keeps each subscription
// (endpoint + keys) and pushes an end-to-end encrypted payload through the browser vendor's
// push service (Google, Apple, Mozilla…), which cannot read it.
//
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY  fixed keys (optional; otherwise generated once and
//                                         kept in the `settings` collection)
//   VAPID_SUBJECT                         contact for push services (mailto: or https: URL)

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Collection, Db } from 'mongodb';
import webpush from 'web-push';
import {
  AGENT_LABELS,
  DEFAULT_NOTIFY_PREFS,
  type Card,
  type NotifyKind,
  type NotifyPrefs,
  type PushPayload,
  type PushSubscriptionJSON,
} from '@localkan/protocol';

interface SubscriptionDoc {
  _id: string; // sha256(endpoint)
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  prefs: NotifyPrefs;
  label: string;
  createdAt: Date;
  lastOkAt: Date | null;
  failures: number;
}

interface VapidDoc {
  _id: 'vapid';
  publicKey: string;
  privateKey: string;
  createdAt: Date;
}

export class PushError extends Error {}

const DAY = 24 * 60 * 60;

export class Push {
  readonly publicKey: string;
  private readonly subs: Collection<SubscriptionDoc>;
  private readonly vapid: { subject: string; publicKey: string; privateKey: string };
  private readonly allowInsecure: boolean;

  private constructor(db: Db, keys: { publicKey: string; privateKey: string }, subject: string, allowInsecure: boolean) {
    this.subs = db.collection('pushSubscriptions');
    this.publicKey = keys.publicKey;
    this.vapid = { subject, ...keys };
    this.allowInsecure = allowInsecure;
  }

  static async init(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<Push> {
    let keys: { publicKey: string; privateKey: string };
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
      keys = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
    } else {
      const settings = db.collection<VapidDoc>('settings');
      const found = await settings.findOne({ _id: 'vapid' });
      if (found) keys = { publicKey: found.publicKey, privateKey: found.privateKey };
      else {
        keys = webpush.generateVAPIDKeys();
        // Two servers starting at once: keep whichever pair was stored first.
        await settings.updateOne({ _id: 'vapid' }, { $setOnInsert: { ...keys, createdAt: new Date() } }, { upsert: true });
        const stored = await settings.findOne({ _id: 'vapid' });
        if (stored) keys = { publicKey: stored.publicKey, privateKey: stored.privateKey };
      }
    }
    const push = new Push(db, keys, env.VAPID_SUBJECT || 'mailto:localkan@example.com', env.PUSH_ALLOW_INSECURE_ENDPOINTS === '1');
    await push.subs.createIndex({ userId: 1 });
    return push;
  }

  /** Add or update this browser's subscription (a browser re-subscribing keeps one record). */
  async subscribe(userId: string, sub: PushSubscriptionJSON, prefs: Partial<NotifyPrefs> | undefined, label: string) {
    this.checkEndpoint(sub?.endpoint);
    if (!sub.keys?.p256dh || !sub.keys?.auth) throw new PushError('Đăng ký thông báo thiếu khóa.');
    const _id = idOf(sub.endpoint);
    const existing = await this.subs.findOne({ _id });
    const merged: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS, ...(existing?.userId === userId ? existing.prefs : {}), ...cleanPrefs(prefs) };
    await this.subs.updateOne(
      { _id },
      {
        $set: { userId, endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, prefs: merged, label: label.slice(0, 80), failures: 0 },
        $setOnInsert: { createdAt: new Date(), lastOkAt: null },
      },
      { upsert: true },
    );
    return merged;
  }

  async prefsOf(userId: string, endpoint: string): Promise<NotifyPrefs | null> {
    const doc = await this.subs.findOne({ _id: idOf(endpoint), userId });
    return doc ? { ...DEFAULT_NOTIFY_PREFS, ...doc.prefs } : null;
  }

  async unsubscribe(userId: string, endpoint: string) {
    await this.subs.deleteOne({ _id: idOf(endpoint), userId });
  }

  async count(userId: string) {
    return this.subs.countDocuments({ userId });
  }

  /** Push to every device of the user that wants this kind of event. */
  async notify(userId: string, kind: NotifyKind, payload: PushPayload) {
    const subs = await this.subs.find({ userId, [`prefs.${kind}`]: { $ne: false } }).toArray();
    await Promise.all(subs.map((s) => this.send(s, payload)));
  }

  /** A test notification to one device. Throws with the push service's answer on failure. */
  async test(userId: string, endpoint: string) {
    const sub = await this.subs.findOne({ _id: idOf(endpoint), userId });
    if (!sub) throw new PushError('Thiết bị này chưa bật thông báo.');
    const ok = await this.send(sub, {
      kind: 'test',
      title: 'Localkan',
      body: 'Thông báo đã hoạt động trên thiết bị này.',
      url: '/',
      tag: 'localkan-test',
    });
    if (!ok) throw new PushError('Dịch vụ push từ chối thông báo thử. Hãy tắt rồi bật lại thông báo trên thiết bị này.');
  }

  private async send(sub: SubscriptionDoc, payload: PushPayload): Promise<boolean> {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), {
        vapidDetails: this.vapid,
        TTL: payload.kind === 'test' ? 600 : DAY,
        urgency: payload.kind === 'input' ? 'high' : 'normal',
        topic: topicOf(payload.tag),
      });
      await this.subs.updateOne({ _id: sub._id }, { $set: { lastOkAt: new Date(), failures: 0 } });
      return true;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // The browser dropped this subscription (uninstalled, permission revoked…).
        await this.subs.deleteOne({ _id: sub._id });
      } else {
        const doc = await this.subs.findOneAndUpdate({ _id: sub._id }, { $inc: { failures: 1 } }, { returnDocument: 'after' });
        if (doc && doc.failures >= 10) await this.subs.deleteOne({ _id: sub._id });
        console.error(`push failed (${status ?? 'network'}): ${(err as Error).message.slice(0, 200)}`);
      }
      return false;
    }
  }

  /** Subscriptions point the server at a URL it will POST to: accept only real push services. */
  private checkEndpoint(endpoint: string | undefined) {
    let url: URL;
    try {
      url = new URL(String(endpoint));
    } catch {
      throw new PushError('Đăng ký thông báo không hợp lệ.');
    }
    if (this.allowInsecure) return;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || isIP(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
      throw new PushError('Địa chỉ dịch vụ push không hợp lệ.');
    }
  }
}

/** What happened to a card, from a bridge update. */
export type CardEventName = 'agent_done' | 'agent_failed' | 'input' | 'ci_failed' | 'ci_passed' | 'pr_merged';

const EVENT_KIND: Record<CardEventName, NotifyKind> = {
  agent_done: 'done',
  agent_failed: 'failed',
  input: 'input',
  ci_failed: 'failed',
  ci_passed: 'done',
  pr_merged: 'done',
};

export function eventKind(e: CardEventName): NotifyKind {
  return EVENT_KIND[e];
}

/** The notification-worthy change between two versions of a card, or null. */
export function cardEvent(before: Card, after: Card): CardEventName | null {
  if (after.status === 'done' && before.status !== 'done' && after.prUrl) return 'pr_merged'; // merged on GitHub
  if (after.status === 'review' && before.status !== 'review') {
    if (after.runState === 'succeeded') return 'agent_done';
    if (after.runState === 'failed') return 'agent_failed';
    return null; // stopped by you
  }
  if (after.status === 'needs_input' && before.status !== 'needs_input' && after.waiting) return 'input';
  // CI over every open PR of the task (one for a repo, several on a multi-repo board).
  const a = ciTotals(after);
  const b = ciTotals(before);
  if (a && after.status === 'review') {
    if (a.failed > 0 && (!b || b.failed === 0)) return 'ci_failed';
    const done = a.total > 0 && a.pending === 0 && a.failed === 0;
    const wasDone = b && b.total > 0 && b.pending === 0 && b.failed === 0;
    if (done && b && !wasDone) return 'ci_passed';
  }
  return null;
}

function openPrs(card: Card) {
  return [card.pr, ...(card.repos ?? []).map((r) => r.pr)].filter((p): p is NonNullable<typeof p> => !!p && p.state === 'open');
}

function ciTotals(card: Card) {
  const prs = openPrs(card);
  if (!prs.length) return null;
  return prs.reduce(
    (t, p) => ({
      total: t.total + p.checks.total,
      failed: t.failed + p.checks.failed,
      pending: t.pending + p.checks.pending,
      passed: t.passed + p.checks.passed,
      failing: [...t.failing, ...p.checks.failing],
    }),
    { total: 0, failed: 0, pending: 0, passed: 0, failing: [] as string[] },
  );
}

export function cardPayload(event: CardEventName, card: Card, projectName: string): PushPayload {
  const kind = eventKind(event);
  const where = `${projectName} · ${AGENT_LABELS[card.agent]}`;
  const base = { kind, url: `/#card/${card.id}`, tag: `card-${card.id}` };
  const pr = card.pr ?? openPrs(card)[0] ?? null;
  const ci = ciTotals(card);
  if (event === 'pr_merged') {
    return { ...base, title: `⑂ Đã merge PR: ${card.title}`, body: clip(card.summary ? `${projectName} — ${card.summary}` : projectName) };
  }
  if (event === 'ci_failed' && pr) {
    return {
      ...base,
      title: `⚠ CI lỗi: ${card.title}`,
      body: clip(`${projectName} · PR #${pr.number} — ${ci?.failing.join(', ') || `${ci?.failed ?? pr.checks.failed} kiểm tra lỗi`}`),
    };
  }
  if (event === 'ci_passed' && pr) {
    return {
      ...base,
      title: `✓ CI đã qua: ${card.title}`,
      body: clip(`${projectName} · PR #${pr.number} — ${ci?.passed ?? pr.checks.passed}/${ci?.total ?? pr.checks.total} kiểm tra qua, sẵn sàng merge.`),
    };
  }
  if (kind === 'done') {
    return {
      ...base,
      title: `${card.mode === 'ask' ? '✓ Có câu trả lời' : '✓ Xong, chờ review'}: ${card.title}`,
      body: clip(card.summary ? `${where} — ${card.summary}` : where),
    };
  }
  if (kind === 'failed') {
    return { ...base, title: `⚠ Lỗi: ${card.title}`, body: clip(card.error ? `${where} — ${card.error}` : where) };
  }
  const w = card.waiting;
  const head =
    w?.kind === 'login' ? '🔑 Cần đăng nhập' : w?.kind === 'question' ? '❓ Agent hỏi' : w?.kind === 'setup' ? '⚙ Cần thiết lập' : '⏸ Cần xác nhận';
  return { ...base, title: `${head}: ${card.title}`, body: clip(w?.text ? `${where} — ${w.text}` : where) };
}

function clip(s: string, n = 180) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function idOf(endpoint: string) {
  return createHash('sha256').update(String(endpoint)).digest('hex');
}

/** Web Push topics are at most 32 URL-safe characters. */
function topicOf(tag: string) {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}

function cleanPrefs(p: Partial<NotifyPrefs> | undefined): Partial<NotifyPrefs> {
  const out: Partial<NotifyPrefs> = {};
  for (const k of ['done', 'input', 'failed'] as const) if (typeof p?.[k] === 'boolean') out[k] = p[k];
  return out;
}
