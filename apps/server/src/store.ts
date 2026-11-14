// MongoDB metadata store for the cloud layer. By design it holds only management data:
// accounts, devices, boards and card metadata. Source code, diffs, terminal output, agent logs,
// project memory and handoff notes are relayed between the bridge and the browser but never
// written here. Card images are files under DATA_DIR/attachments (only their metadata is here).

import { type Collection, type Db, MongoClient } from 'mongodb';
import type {
  AgentId,
  Attachment,
  BridgeInfo,
  Card,
  CardMode,
  CardStatus,
  Device,
  PreviewInfo,
  Project,
  ProjectStatus,
  RunState,
  WaitingInfo,
  CardRepo,
  GitSettings,
  PrInfo,
  ProjectRepo,
} from '@localkan/protocol';
import { DEFAULT_GIT_SETTINGS } from '@localkan/protocol';

// -- documents ----------------------------------------------------------------

interface UserDoc {
  _id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

interface SessionDoc {
  _id: string; // sha256(token)
  userId: string;
  expiresAt: Date;
}

interface PairingCodeDoc {
  _id: string; // the code
  userId: string;
  expiresAt: Date;
}

interface DeviceDoc {
  _id: string;
  userId: string;
  name: string;
  tokenHash: string;
  info: BridgeInfo | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

interface ProjectDoc {
  _id: string;
  userId: string;
  deviceId: string;
  name: string;
  repoPath: string;
  baseRef: string | null;
  status: ProjectStatus;
  error: string | null;
  preview?: PreviewInfo | null;
  git?: Partial<GitSettings>;
  repos?: ProjectRepo[];
  repoGit?: Record<string, Partial<GitSettings>>;
  createdAt: Date;
}

interface CardDoc {
  _id: string;
  projectId: string;
  title: string;
  prompt: string;
  agent: AgentId;
  model?: string | null;
  mode: CardMode;
  status: CardStatus;
  position: number;
  runState: RunState;
  branch: string | null;
  worktreePath: string | null;
  dispatchId: string | null;
  waiting: WaitingInfo | null;
  summary: string | null;
  error: string | null;
  prUrl: string | null;
  parentCardId: string | null;
  preview: PreviewInfo | null;
  autoPreview?: boolean;
  pr?: PrInfo | null;
  repos?: CardRepo[];
  attachments: Attachment[];
  createdAt: Date;
  updatedAt: Date;
}

/** Fields of a card that callers may change. */
export type CardPatch = Partial<Omit<Card, 'id' | 'projectId' | 'attachments' | 'createdAt' | 'updatedAt'>>;

export interface CardOwner {
  card: Card;
  userId: string;
  deviceId: string;
  repoPath: string;
}

// -- mapping ------------------------------------------------------------------

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export function toDevice(d: DeviceDoc, online: boolean): Device {
  return {
    id: d._id,
    name: d.name,
    online,
    lastSeenAt: iso(d.lastSeenAt),
    info: d.info ?? null,
    createdAt: iso(d.createdAt)!,
  };
}

export function toProject(p: ProjectDoc): Project {
  return {
    id: p._id,
    name: p.name,
    deviceId: p.deviceId,
    repoPath: p.repoPath,
    baseRef: p.baseRef ?? null,
    status: p.status,
    error: p.error ?? null,
    preview: p.preview ?? null,
    git: { ...DEFAULT_GIT_SETTINGS, ...(p.git ?? {}) },
    repos: p.repos ?? [],
    repoGit: Object.fromEntries(
      (p.repos ?? []).map((r) => [r.name, { ...DEFAULT_GIT_SETTINGS, ...(p.git ?? {}), ...(p.repoGit?.[r.name] ?? {}) }]),
    ),
    createdAt: iso(p.createdAt)!,
  };
}

export function toCard(c: CardDoc): Card {
  return {
    id: c._id,
    projectId: c.projectId,
    title: c.title,
    prompt: c.prompt,
    agent: c.agent,
    model: c.model ?? null,
    mode: c.mode,
    status: c.status,
    position: c.position,
    runState: c.runState,
    branch: c.branch ?? null,
    worktreePath: c.worktreePath ?? null,
    dispatchId: c.dispatchId ?? null,
    waiting: c.waiting ?? null,
    summary: c.summary ?? null,
    error: c.error ?? null,
    prUrl: c.prUrl ?? null,
    parentCardId: c.parentCardId ?? null,
    preview: c.preview ?? null,
    autoPreview: c.autoPreview ?? false,
    pr: c.pr ?? null,
    repos: c.repos ?? [],
    attachments: c.attachments ?? [],
    createdAt: iso(c.createdAt)!,
    updatedAt: iso(c.updatedAt)!,
  };
}

// -- store --------------------------------------------------------------------

export class Store {
  readonly client: MongoClient;
  readonly db: Db;
  readonly users: Collection<UserDoc>;
  readonly sessions: Collection<SessionDoc>;
  readonly pairingCodes: Collection<PairingCodeDoc>;
  readonly devices: Collection<DeviceDoc>;
  readonly projects: Collection<ProjectDoc>;
  readonly cards: Collection<CardDoc>;
  /** Card ownership never changes, and bridge events check it on every log batch. */
  private readonly owners = new Map<string, { userId: string; deviceId: string; projectId: string }>();

  private constructor(client: MongoClient, dbName?: string) {
    this.client = client;
    this.db = client.db(dbName);
    this.users = this.db.collection('users');
    this.sessions = this.db.collection('sessions');
    this.pairingCodes = this.db.collection('pairingCodes');
    this.devices = this.db.collection('devices');
    this.projects = this.db.collection('projects');
    this.cards = this.db.collection('cards');
  }

  /** Connect and make sure indexes exist. `dbName` overrides the database in the URL. */
  static async connect(url: string, dbName?: string): Promise<Store> {
    const client = new MongoClient(url, { serverSelectionTimeoutMS: 15_000, appName: 'localkan-server' });
    await client.connect();
    const store = new Store(client, dbName);
    await store.ensureIndexes();
    return store;
  }

  async close() {
    await this.client.close();
  }

  private async ensureIndexes() {
    await Promise.all([
      this.users.createIndex({ email: 1 }, { unique: true }),
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.sessions.createIndex({ userId: 1 }),
      this.pairingCodes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.devices.createIndex({ tokenHash: 1 }, { unique: true }),
      this.devices.createIndex({ userId: 1, createdAt: 1 }),
      this.projects.createIndex({ userId: 1, createdAt: 1 }),
      this.cards.createIndex({ projectId: 1, status: 1, position: 1 }),
      this.cards.createIndex({ parentCardId: 1 }),
      this.cards.createIndex({ 'attachments.id': 1 }),
    ]);
  }

  // users & sessions ------------------------------------------------------------

  countUsers() {
    return this.users.countDocuments({}, { limit: 1 });
  }

  async createUser(id: string, email: string, passwordHash: string) {
    await this.users.insertOne({ _id: id, email, passwordHash, createdAt: new Date() });
  }

  findUserByEmail(email: string) {
    return this.users.findOne({ email });
  }

  findUser(id: string) {
    return this.users.findOne({ _id: id }, { projection: { email: 1 } });
  }

  async createSession(tokenHash: string, userId: string, expiresAt: Date) {
    await this.sessions.insertOne({ _id: tokenHash, userId, expiresAt });
  }

  /** The user of a live session (the TTL index removes expired ones lazily, so check too). */
  async sessionUser(tokenHash: string): Promise<string | null> {
    const s = await this.sessions.findOne({ _id: tokenHash, expiresAt: { $gt: new Date() } });
    return s?.userId ?? null;
  }

  async deleteSession(tokenHash: string) {
    await this.sessions.deleteOne({ _id: tokenHash });
  }

  // pairing & devices -----------------------------------------------------------

  async createPairingCode(code: string, userId: string, expiresAt: Date) {
    await this.pairingCodes.insertOne({ _id: code, userId, expiresAt });
  }

  /** Consume a valid pairing code; returns its user. */
  async takePairingCode(code: string): Promise<string | null> {
    const doc = await this.pairingCodes.findOneAndDelete({ _id: code, expiresAt: { $gt: new Date() } });
    return doc?.userId ?? null;
  }

  async createDevice(id: string, userId: string, name: string, tokenHash: string) {
    await this.devices.insertOne({ _id: id, userId, name, tokenHash, info: null, lastSeenAt: null, createdAt: new Date() });
  }

  async deviceForTokenHash(tokenHash: string): Promise<{ id: string; userId: string } | null> {
    const d = await this.devices.findOne({ tokenHash }, { projection: { userId: 1 } });
    return d ? { id: d._id, userId: d.userId } : null;
  }

  listDevices(userId: string) {
    return this.devices.find({ userId }).sort({ createdAt: 1 }).toArray();
  }

  getDevice(id: string) {
    return this.devices.findOne({ _id: id });
  }

  async ownsDevice(userId: string, id: string) {
    return (await this.devices.countDocuments({ _id: id, userId }, { limit: 1 })) > 0;
  }

  /**
   * Boards bound to a device that no longer exists (removed, then the same computer paired
   * again under a new id) move to `deviceId`. Returns the ids of the boards that moved.
   */
  async adoptOrphanProjects(userId: string, deviceId: string): Promise<string[]> {
    const devices = (await this.devices.find({ userId }, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
    if (!devices.includes(deviceId)) return [];
    const orphans = await this.projects.find({ userId, deviceId: { $nin: devices } }, { projection: { _id: 1 } }).toArray();
    if (!orphans.length) return [];
    const ids = orphans.map((p) => p._id);
    await this.projects.updateMany({ _id: { $in: ids }, userId, deviceId: { $nin: devices } }, { $set: { deviceId } });
    // The card ownership cache remembers the old device: forget the moved boards' cards.
    for (const [cardId, owner] of this.owners) if (ids.includes(owner.projectId)) this.owners.delete(cardId);
    return ids;
  }

  async deleteDevice(userId: string, id: string) {
    return (await this.devices.deleteOne({ _id: id, userId })).deletedCount > 0;
  }

  async setDeviceInfo(id: string, info: BridgeInfo) {
    await this.devices.updateOne({ _id: id }, { $set: { info, lastSeenAt: new Date() } });
  }

  async touchDevice(id: string) {
    await this.devices.updateOne({ _id: id }, { $set: { lastSeenAt: new Date() } });
  }

  // projects ----------------------------------------------------------------------

  async listProjects(userId: string) {
    return (await this.projects.find({ userId }).sort({ createdAt: 1 }).toArray()).map(toProject);
  }

  async getProject(id: string, userId?: string): Promise<Project | null> {
    const p = await this.projects.findOne(userId ? { _id: id, userId } : { _id: id });
    return p ? toProject(p) : null;
  }

  async createProject(p: { id: string; userId: string; deviceId: string; name: string; repoPath: string }) {
    await this.projects.insertOne({
      _id: p.id,
      userId: p.userId,
      deviceId: p.deviceId,
      name: p.name,
      repoPath: p.repoPath,
      baseRef: null,
      status: 'pending',
      error: null,
      preview: null,
      createdAt: new Date(),
    });
  }

  async updateProject(
    id: string,
    patch: Partial<Pick<ProjectDoc, 'status' | 'baseRef' | 'error' | 'preview' | 'git' | 'repos' | 'repoGit'>>,
  ) {
    await this.projects.updateOne({ _id: id }, { $set: patch });
  }

  /** Saved per-repo git settings of a multi-repo board. */
  async savedRepoGit(id: string): Promise<Record<string, Partial<GitSettings>>> {
    return (await this.projects.findOne({ _id: id }, { projection: { repoGit: 1 } }))?.repoGit ?? {};
  }

  /** Whether the board's git settings were ever chosen (boards from before keep `local`). */
  async hasGitSettings(id: string) {
    return !!(await this.projects.findOne({ _id: id, git: { $exists: true } }, { projection: { _id: 1 } }));
  }

  /** Delete a board and its cards; returns the deleted card ids (to remove their files). */
  async deleteProject(id: string): Promise<string[]> {
    const cardIds = (await this.cards.find({ projectId: id }, { projection: { _id: 1 } }).toArray()).map((c) => c._id);
    await this.cards.deleteMany({ projectId: id });
    await this.projects.deleteOne({ _id: id });
    for (const c of cardIds) this.owners.delete(c);
    return cardIds;
  }

  // cards ------------------------------------------------------------------------

  async listCards(projectId: string) {
    return (await this.cards.find({ projectId }).sort({ position: 1 }).toArray()).map(toCard);
  }

  async getCard(id: string): Promise<Card | null> {
    const c = await this.cards.findOne({ _id: id });
    return c ? toCard(c) : null;
  }

  /** Card plus the ownership facts needed for authorization checks. */
  async getCardWithOwner(id: string): Promise<CardOwner | null> {
    const c = await this.cards.findOne({ _id: id });
    if (!c) return null;
    const p = await this.projects.findOne({ _id: c.projectId }, { projection: { userId: 1, deviceId: 1, repoPath: 1 } });
    if (!p) return null;
    this.owners.set(id, { userId: p.userId, deviceId: p.deviceId, projectId: c.projectId });
    return { card: toCard(c), userId: p.userId, deviceId: p.deviceId, repoPath: p.repoPath };
  }

  /** Cached owner lookup for hot paths (bridge log events). */
  async cardOwner(id: string): Promise<{ userId: string; deviceId: string } | null> {
    const hit = this.owners.get(id);
    if (hit) return hit;
    const owned = await this.getCardWithOwner(id);
    return owned ? { userId: owned.userId, deviceId: owned.deviceId } : null;
  }

  async maxTodoPosition(projectId: string): Promise<number> {
    const top = await this.cards.find({ projectId, status: 'todo' }).sort({ position: -1 }).limit(1).toArray();
    return top[0]?.position ?? 0;
  }

  async createCard(c: {
    id: string;
    projectId: string;
    title: string;
    prompt: string;
    agent: AgentId;
    model: string | null;
    mode: CardMode;
    position: number;
    parentCardId: string | null;
    autoPreview?: boolean;
  }) {
    const now = new Date();
    await this.cards.insertOne({
      _id: c.id,
      projectId: c.projectId,
      title: c.title,
      prompt: c.prompt,
      agent: c.agent,
      model: c.model,
      mode: c.mode,
      status: 'todo',
      position: c.position,
      runState: 'idle',
      branch: null,
      worktreePath: null,
      dispatchId: null,
      waiting: null,
      summary: null,
      error: null,
      prUrl: null,
      parentCardId: c.parentCardId,
      preview: null,
      autoPreview: c.autoPreview ?? false,
      attachments: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Apply a partial update and return the updated card. */
  async updateCard(id: string, patch: CardPatch): Promise<Card | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v;
    const doc = await this.cards.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
    return doc ? toCard(doc) : null;
  }

  async deleteCard(id: string) {
    await this.cards.deleteOne({ _id: id });
    await this.cards.updateMany({ parentCardId: id }, { $set: { parentCardId: null } });
    this.owners.delete(id);
  }

  /** Minimal facts about a card (used for parent references). */
  cardBrief(id: string) {
    return this.cards.findOne({ _id: id }, { projection: { projectId: 1, title: 1, branch: 1 } });
  }

  // attachments (embedded in their card) -------------------------------------------

  async addAttachments(cardId: string, items: Attachment[]): Promise<Card | null> {
    const doc = await this.cards.findOneAndUpdate(
      { _id: cardId },
      { $push: { attachments: { $each: items } }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return doc ? toCard(doc) : null;
  }

  async removeAttachment(cardId: string, attachmentId: string): Promise<Card | null> {
    const doc = await this.cards.findOneAndUpdate(
      { _id: cardId },
      { $pull: { attachments: { id: attachmentId } }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return doc ? toCard(doc) : null;
  }

  /** An attachment with its card and owners. */
  async findAttachment(
    id: string,
  ): Promise<{ attachment: Attachment; cardId: string; userId: string; deviceId: string } | null> {
    const c = await this.cards.findOne({ 'attachments.id': id }, { projection: { projectId: 1, attachments: 1 } });
    const attachment = c?.attachments.find((a) => a.id === id);
    if (!c || !attachment) return null;
    const p = await this.projects.findOne({ _id: c.projectId }, { projection: { userId: 1, deviceId: 1 } });
    return p ? { attachment, cardId: c._id, userId: p.userId, deviceId: p.deviceId } : null;
  }
}
