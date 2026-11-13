// One-off migration: copy the old SQLite metadata DB into MongoDB.
//
//   pnpm --filter @localkan/server migrate:sqlite [path/to/localkan.db]
//
// IDs, password hashes, session and device token hashes are kept, so existing logins and
// paired bridges keep working. Safe to run more than once (documents are upserted by _id).
// Card images stay where they are (DATA_DIR/attachments); only their metadata moves.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.ts';

type Row = Record<string, unknown>;

const file = resolve(process.argv[2] ?? resolve(process.env.DATA_DIR ?? '.data', 'localkan.db'));
if (!existsSync(file)) {
  console.error(`Không thấy file SQLite: ${file}`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Thiếu DATABASE_URL.');
  process.exit(1);
}

const sqlite = new DatabaseSync(file, { readOnly: true });
const all = (sql: string) => sqlite.prepare(sql).all() as Row[];
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const date = (v: unknown) => (v ? new Date(String(v)) : null);
const json = <T>(v: unknown): T | null => (v ? (JSON.parse(String(v)) as T) : null);
const hasTable = (name: string) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const cardCols = new Set((all('PRAGMA table_info(cards)') as Row[]).map((c) => String(c.name)));

const store = await Store.connect(process.env.DATABASE_URL, process.env.DATABASE_NAME || undefined);
console.log(`SQLite: ${file}\nMongoDB: database "${store.db.databaseName}"\n`);

const counts: Record<string, number> = {};
const upsert = async <T extends { _id: string }>(name: string, col: { replaceOne: Function }, docs: T[]) => {
  for (const d of docs) await col.replaceOne({ _id: d._id }, d, { upsert: true });
  counts[name] = docs.length;
};

try {
  // Users: refuse to clobber a different account that already uses the same email.
  const users = all('SELECT * FROM users');
  for (const u of users) {
    const clash = await store.users.findOne({ email: String(u.email), _id: { $ne: String(u.id) } });
    if (clash) {
      throw new Error(
        `MongoDB đã có một tài khoản khác dùng email ${String(u.email)}. Xóa tài khoản đó (hoặc collection users) rồi chạy lại.`,
      );
    }
  }
  await upsert(
    'users',
    store.users,
    users.map((u) => ({ _id: String(u.id), email: String(u.email), passwordHash: String(u.password_hash), createdAt: date(u.created_at)! })),
  );

  const now = new Date();
  await upsert(
    'sessions (còn hạn)',
    store.sessions,
    all('SELECT * FROM sessions')
      .map((s) => ({ _id: String(s.token_hash), userId: String(s.user_id), expiresAt: date(s.expires_at)! }))
      .filter((s) => s.expiresAt > now),
  );

  await upsert(
    'devices',
    store.devices,
    all('SELECT * FROM devices').map((d) => ({
      _id: String(d.id),
      userId: String(d.user_id),
      name: String(d.name),
      tokenHash: String(d.token_hash),
      info: json(d.info_json),
      lastSeenAt: date(d.last_seen_at),
      createdAt: date(d.created_at)!,
    })),
  );

  await upsert(
    'projects',
    store.projects,
    all('SELECT * FROM projects').map((p) => ({
      _id: String(p.id),
      userId: String(p.user_id),
      deviceId: String(p.device_id),
      name: String(p.name),
      repoPath: String(p.repo_path),
      baseRef: str(p.base_ref),
      status: String(p.status) as 'pending' | 'ready' | 'error',
      error: str(p.error),
      preview: null,
      createdAt: date(p.created_at)!,
    })),
  );

  const attachmentsByCard = new Map<string, { id: string; name: string; mime: string; size: number }[]>();
  if (hasTable('attachments')) {
    for (const a of all('SELECT * FROM attachments ORDER BY card_id, position')) {
      const list = attachmentsByCard.get(String(a.card_id)) ?? [];
      list.push({ id: String(a.id), name: String(a.name), mime: String(a.mime), size: Number(a.size) });
      attachmentsByCard.set(String(a.card_id), list);
    }
  }
  await upsert(
    'cards',
    store.cards,
    all('SELECT * FROM cards').map((c) => ({
      _id: String(c.id),
      projectId: String(c.project_id),
      title: String(c.title),
      prompt: String(c.prompt),
      agent: String(c.agent) as 'claude' | 'antigravity',
      mode: String(c.mode) as 'act' | 'ask',
      status: String(c.status) as 'todo' | 'in_progress' | 'needs_input' | 'review' | 'done',
      position: Number(c.position),
      runState: String(c.run_state) as 'idle',
      branch: str(c.branch),
      worktreePath: str(c.worktree_path),
      dispatchId: str(c.dispatch_id),
      waiting: json(c.waiting_json),
      summary: str(c.summary),
      error: str(c.error),
      prUrl: str(c.pr_url),
      parentCardId: cardCols.has('parent_card_id') ? str(c.parent_card_id) : null,
      preview: null,
      attachments: attachmentsByCard.get(String(c.id)) ?? [],
      createdAt: date(c.created_at)!,
      updatedAt: date(c.updated_at)!,
    })),
  );
  counts['ảnh (metadata, trong cards)'] = [...attachmentsByCard.values()].reduce((n, l) => n + l.length, 0);

  console.log('Đã chuyển:');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
  console.log('\nFile SQLite không bị thay đổi. Có thể giữ lại làm bản sao lưu.');
} catch (err) {
  console.error(`Lỗi: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  sqlite.close();
  await store.close();
}
