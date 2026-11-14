// Shared contract between the Localkan web UI, the cloud server and the local bridge.
//
// The Rust bridge (apps/bridge/core/src/protocol.rs) mirrors the wire types in this file.
// Keep the two in sync: any change to BridgeMethods, BridgeEvents or the shapes they use
// must be made on both sides.

/** Agent ids are Orca's: Orca launches each CLI (claude, agy, codex, grok) with its own flags. */
export const AGENTS = ['claude', 'antigravity', 'codex', 'grok'] as const;
export type AgentId = (typeof AGENTS)[number];

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  antigravity: 'Antigravity (agy)',
  codex: 'Codex',
  grok: 'Grok',
};

/** A model an agent CLI offers (as listed by the CLI on the bridge machine). */
export interface AgentModel {
  id: string;
  label: string;
  /** The CLI's own default. */
  default?: boolean;
}

/** Model ids travel into a shell command on the bridge: letters, digits and `.:/[]_-` only. */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/[\]-]{0,99}$/;

/** Claude Code takes family aliases that always point at the newest model; used until the
 *  bridge has reported its own lists. */
export const FALLBACK_MODELS: Partial<Record<AgentId, AgentModel[]>> = {
  claude: [
    { id: 'fable', label: 'Fable' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
  ],
};

/** Kanban columns. `needs_input` is the Human-in-the-loop column. */
export const CARD_STATUSES = ['todo', 'in_progress', 'needs_input', 'review', 'done'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const CARD_STATUS_LABELS: Record<CardStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  needs_input: 'Cần bạn xử lý',
  review: 'Review',
  done: 'Done',
};

/** What the agent behind a card is doing right now (as reported by the bridge). */
export type RunState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'stopped';

export type CardMode = 'act' | 'ask';

export interface WaitingInfo {
  /** `question`: the agent asked through Orca orchestration and expects a text answer.
   *  `prompt`: the agent's terminal is parked on an interactive prompt (permission, trust…).
   *  `setup`: a one-time step on the bridge machine is needed; retry the card afterwards.
   *  `login`: a page in the shared browser needs a sign-in; the human signs in remotely
   *  (Localkan types into the browser, the agent never sees the password), then replies. */
  kind: 'question' | 'prompt' | 'setup' | 'login';
  text: string;
  /** Orca message id to reply to (kind = question | login). */
  messageId?: string;
  /** Rendered terminal screen at the time the wait was detected (kind = prompt). */
  screen?: string[];
  /** Shared-browser tab that needs the sign-in (kind = login). */
  pageId?: string;
  /** Page the agent was trying to open (kind = login). */
  url?: string;
}

/** An image attached to a card (screenshots, mockups). Stored on the server and copied into
 *  the card's worktree by the bridge when the agent starts. */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export const ATTACHMENT_LIMITS = {
  maxFiles: 10,
  maxBytes: 10 * 1024 * 1024,
  mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
} as const;

/** A card's live preview: its dev server running in the worktree on the bridge machine,
 *  optionally reachable from anywhere through a password-protected ngrok link. */
export interface PreviewInfo {
  status: 'starting' | 'running' | 'error';
  /** Address on the bridge machine itself. */
  localUrl: string | null;
  /** Public link (ngrok), when remote access was requested. */
  url: string | null;
  username: string | null;
  password: string | null;
  command: string | null;
  /** Progress step while starting, or the error. */
  message: string | null;
  startedAt: string | null;
}

/** A screenshot of the running preview. Relayed to the browser, never stored by the server. */
/** A tab of the shared browser (Orca's built-in browser; one cookie jar for every agent). */
export interface BrowserTab {
  pageId: string;
  url: string;
  title: string;
  active: boolean;
  /** Worktree the tab belongs to (an agent's tab), or null for a shared tab. */
  worktreePath: string | null;
  /** Card whose worktree owns the tab, when it belongs to this board. */
  cardId: string | null;
  /** True when the tab belongs to this board's main folder. */
  main: boolean;
}

/** Screenshot of a browser tab. width/height are the page's CSS viewport size, which is
 *  the coordinate space of `tap`. */
export interface BrowserShot {
  pageId: string;
  dataUrl: string;
  width: number;
  height: number;
  url: string;
  title: string;
}

/** Remote control of the shared browser. `type` and `login` may carry secrets: they are
 *  relayed to the bridge and typed into the page, never stored or logged. */
export type BrowserAction =
  | { kind: 'tabs' }
  | { kind: 'open'; url: string }
  | { kind: 'shot'; pageId: string }
  | { kind: 'goto'; pageId: string; url: string }
  | { kind: 'tap'; pageId: string; x: number; y: number }
  | { kind: 'type'; pageId: string; text: string }
  | { kind: 'key'; pageId: string; key: string }
  | { kind: 'scroll'; pageId: string; dy: number }
  | { kind: 'back'; pageId: string }
  | { kind: 'reload'; pageId: string }
  | { kind: 'close'; pageId: string }
  | { kind: 'login'; pageId: string; username?: string; password?: string; otp?: string };

export interface BrowserResult {
  tabs?: BrowserTab[];
  shot?: BrowserShot | null;
  /** Human-readable note (e.g. what the quick sign-in filled). */
  message?: string;
}

export interface Screenshot {
  viewport: 'mobile' | 'desktop';
  width: number;
  height: number;
  url: string;
  dataUrl: string;
  takenAt: string;
}

export interface Card {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  agent: AgentId;
  /** Model passed to the agent CLI; null runs the CLI's default. */
  model: string | null;
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
  /** Open pull request of this task (flow `pr`), with its CI checks. */
  pr: PrInfo | null;
  /** Multi-repo board: each repo's branch, git flow, PR and whether it shipped. */
  repos: CardRepo[];
  /** Card this one continues from: its handoff note is passed on, and when its branch is not
   *  merged yet the new worktree starts from that branch. */
  parentCardId: string | null;
  preview: PreviewInfo | null;
  /** Start a preview (with a password-protected phone link) as soon as the agent reports done. */
  autoPreview: boolean;
  attachments: Attachment[];
  createdAt: string;
  updatedAt: string;
}

export type ProjectStatus = 'pending' | 'ready' | 'error';

export interface Project {
  id: string;
  name: string;
  deviceId: string;
  repoPath: string;
  baseRef: string | null;
  status: ProjectStatus;
  error: string | null;
  /** Preview of the project folder itself (the checked-out branch, usually main). */
  preview: PreviewInfo | null;
  /** How finished work reaches the repo (local merge, or GitHub pull requests). */
  git: GitSettings;
  /** Multi-repo board: the git repos inside the folder (empty for a single repo). */
  repos: ProjectRepo[];
  /** Multi-repo board: git settings per repo, by repo name. */
  repoGit: Record<string, GitSettings>;
  createdAt: string;
}

/** A git repo inside a multi-repo board's folder. */
export interface ProjectRepo {
  /** Folder name, e.g. `frontend`. */
  name: string;
  path: string;
}

/** One repo of a task on a multi-repo board. */
export interface CardRepo {
  name: string;
  branch: string;
  /** Branch it merges into. */
  base: string;
  flow: GitFlow;
  pr: PrInfo | null;
  /** Set once this repo's part is done: merged (PR or local), pushed, or skipped (no changes). */
  shipped: 'merged' | 'pushed' | 'local' | 'skipped' | null;
}

/** `pr`: each task gets a branch from origin, a GitHub pull request and CI; merging the PR on
 *  GitHub is what ships it. `push`: a branch from origin, merged into the base branch and pushed
 *  straight to origin (no PR; for repos without CI/CD). `local`: merge into the branch checked
 *  out in the project folder, nothing pushed. */
export type GitFlow = 'pr' | 'push' | 'local';
export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface GitSettings {
  flow: GitFlow;
  /** Branch new work starts from (fetched fresh from origin) and PRs target. Null: the branch
   *  checked out in the project folder. */
  baseBranch: string | null;
  /** Prefix for task branches, e.g. `feature/`. */
  branchPrefix: string;
  /** How Localkan merges a PR on GitHub. */
  mergeMethod: MergeMethod;
  /** Open a draft PR as soon as the agent finishes, so CI runs before your review. */
  autoDraftPr: boolean;
}

export const DEFAULT_GIT_SETTINGS: GitSettings = {
  flow: 'local',
  baseBranch: null,
  branchPrefix: 'feature/',
  mergeMethod: 'squash',
  autoDraftPr: true,
};

/** The project folder's git remote, as seen from the bridge machine. */
export interface RepoInfo {
  remoteUrl: string | null;
  github: boolean;
  /** Branch checked out in the project folder. */
  currentBranch: string | null;
  /** origin's default branch (origin/HEAD). */
  defaultBranch: string | null;
  /** Branches on origin (after a fetch). */
  remoteBranches: string[];
  /** GitHub CLI installed and logged in on the bridge machine. */
  ghReady: boolean;
  /** The repo has a CI/CD config (GitHub Actions, GitLab CI…). */
  ci: boolean;
}

/** CI checks of a pull request (GitHub checks and commit statuses). */
export interface PrChecks {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** Names of failing checks. */
  failing: string[];
}

/** A task's GitHub pull request, refreshed by the bridge while the task is in review. */
export interface PrInfo {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  /** Whether GitHub can merge it into its base without conflicts. */
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  base: string;
  checks: PrChecks;
  checkedAt: string;
}

export interface BridgeInfo {
  deviceName: string;
  version: string;
  orca: { reachable: boolean; version?: string; error?: string };
  agents: Partial<Record<AgentId, boolean>>;
  /** Models each installed agent offers (missing on older bridges). */
  models?: Partial<Record<AgentId, AgentModel[]>>;
}

export interface Device {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  info: BridgeInfo | null;
  createdAt: string;
}

export interface LogLine {
  seq: number;
  ts: string;
  source: 'agent' | 'system';
  text: string;
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number;
  deletions: number;
}

export interface DiffResult {
  baseRef: string;
  files: DiffFile[];
  /** Unified diff text. Relayed to the browser, never stored by the server. */
  patch: string;
}

export type HandoffStatus = 'in_review' | 'committed' | 'merged' | 'pr' | 'discarded';

export const HANDOFF_STATUS_LABELS: Record<HandoffStatus, string> = {
  in_review: 'đang review',
  committed: 'đã commit vào nhánh',
  merged: 'đã merge',
  pr: 'đã tạo PR',
  discarded: 'đã hủy',
};

/** A finished card's handoff note, kept as Markdown in the repo's git-ignored .localkan/ folder
 *  on the bridge machine (never stored by the server). */
export interface HandoffNote {
  cardId: string;
  title: string;
  agent: string;
  branch: string | null;
  status: HandoffStatus;
  updatedAt: string;
  content: string;
}

/** What the bridge found at a folder path on its machine. */
export interface FolderInfo {
  path: string;
  exists: boolean;
  isGitRepo: boolean;
  /** No entries other than OS metadata files such as .DS_Store. */
  isEmpty: boolean;
  /** Not a repo itself but holds git repos one level down (e.g. frontend/ and backend/):
   *  the board becomes a multi-repo board. */
  childRepos: string[];
}

export interface ReviewComment {
  path: string;
  line: number | null;
  text: string;
  /** The code the comment points at, so the agent sees what the reviewer saw. */
  snippet?: string;
}

/** `approve` / `reject` read the agent's screen and pick the matching option of the
 *  prompt it shows (e.g. "Yes, I trust this folder"), falling back to Enter / Esc. */
export type TerminalKey = 'approve' | 'reject' | 'enter' | 'esc' | 'up' | 'down' | 'tab' | 'interrupt';

/** `merge_push`: merge into the latest origin/<base> and push it (flow `push`, no PR).
 *  `merge_pr`: merge the task's pull request on GitHub (a CI/CD pipeline runs from there).
 *  `pr`: open (or mark ready) the pull request and leave the merge to you on GitHub.
 *  `merge`: merge into the branch checked out in the project folder (no push).
 *  `commit`: keep the work on its branch. `discard`: drop it (closes an open PR). */
/** `ship` (multi-repo boards): every repo its own way — merge its PR, merge and push, or merge
 *  locally — skipping repos without changes. */
export type FinishAction = 'ship' | 'merge_push' | 'merge_pr' | 'commit' | 'pr' | 'merge' | 'discard';

// ---------------------------------------------------------------------------
// Server <-> bridge wire protocol (JSON over WebSocket)
// ---------------------------------------------------------------------------

export interface BridgeMethods {
  /** Register a local git repo with Orca and prepare its coordinator. */
  'project.register': {
    params: { projectId: string; repoPath: string };
    result: {
      baseRef: string | null;
      displayName: string;
      repo: RepoInfo;
      /** Multi-repo board: the repos found in the folder. */
      repos?: { name: string; path: string; info: RepoInfo }[];
    };
  };
  /** Remote, branches and GitHub CLI state of a project folder (for the board's git settings). */
  'project.repo': {
    params: { projectId: string; repoPath: string };
    result: RepoInfo & { children?: { name: string; info: RepoInfo }[] };
  };
  /** The board's own skills (`.localkan/skills/<name>/SKILL.md` in the project folder). */
  'project.skills': {
    params: { projectId: string; repoPath: string };
    result: { dir: string; skills: { name: string; description: string }[] };
  };
  /** Fetch the task's pull request and CI checks now (also done periodically). */
  'card.pr.refresh': { params: { cardId: string }; result: { pr: PrInfo | null } };
  /** Bring the task branch up to date with origin/<base> (merge) and push. */
  'card.pr.sync': { params: { cardId: string }; result: { ok: boolean; conflict: boolean; message: string } };
  /** Create the card's worktree and dispatch the agent. Returns once accepted; progress
   *  arrives as `card.state` / `card.log` events. */
  'card.start': {
    params: {
      cardId: string;
      projectId: string;
      repoPath: string;
      title: string;
      prompt: string;
      agent: AgentId;
      /** null: the CLI's default model. */
      model: string | null;
      mode: CardMode;
      /** Images to copy into the worktree; the bridge downloads them from the server. */
      attachments: Pick<Attachment, 'id' | 'name' | 'mime'>[];
      /** The card this one continues from. */
      parent: { cardId: string; title: string; branch: string | null } | null;
      /** The board's git settings (base branch, branch prefix, PR flow). */
      git: GitSettings;
      /** Multi-repo board: settings per repo. */
      repoGit: Record<string, GitSettings>;
    };
    result: { accepted: true };
  };
  /** Open the native "choose folder" dialog on the bridge machine. `path` is null when the
   *  user cancels. */
  'fs.pickFolder': {
    params: { prompt?: string; startPath?: string };
    result: { path: string | null; info: FolderInfo | null };
  };
  /** Run the card's dev server (installing dependencies if needed) and, with `tunnel`, open a
   *  password-protected ngrok link to it. Progress arrives as `card.state` preview updates. */
  'card.preview.start': { params: { cardId: string; tunnel: boolean }; result: PreviewInfo };
  'card.preview.stop': { params: { cardId: string }; result: { ok: true } };
  /** Phone- and desktop-size screenshots of `path` on the running preview. */
  'card.screenshot': { params: { cardId: string; path?: string }; result: { shots: Screenshot[] } };
  /** Same as the card preview, for the project folder itself (its checked-out branch). */
  'project.preview.start': { params: { projectId: string; repoPath: string; tunnel: boolean }; result: PreviewInfo };
  'project.preview.stop': { params: { projectId: string }; result: { ok: true } };
  'project.screenshot': { params: { projectId: string; repoPath: string; path?: string }; result: { shots: Screenshot[] } };
  /** Remote control of the shared browser (tabs, screenshot, tap, type, sign-in). */
  'browser.action': { params: { projectId: string; repoPath: string; action: BrowserAction }; result: BrowserResult };
  /** Project memory (.localkan/memory.md in the repo, git-ignored). */
  'project.memory.get': { params: { projectId: string; repoPath: string }; result: { content: string; path: string } };
  'project.memory.set': { params: { projectId: string; repoPath: string; content: string }; result: { ok: true } };
  /** Handoff notes of the board's cards, newest first. */
  'project.handoffs': { params: { projectId: string; repoPath: string }; result: { handoffs: HandoffNote[] } };
  /** Describe a folder path on the bridge machine (exists / git repo / empty). */
  'fs.inspect': { params: { path: string }; result: FolderInfo };
  /** Answer a waiting card: a text reply to an Orca question, or raw input to the terminal. */
  'card.reply': {
    params: { cardId: string; messageId?: string; text?: string; keys?: TerminalKey[] };
    result: { ok: true };
  };
  /** Run the card's task again from the beginning in its worktree (fresh agent). */
  'card.retry': {
    params: BridgeMethods['card.start']['params'];
    result: { accepted: true };
  };
  /** Send follow-up work (e.g. review comments) to the same agent and worktree. */
  'card.followup': {
    params: { cardId: string; text: string };
    result: { accepted: true };
  };
  'card.diff': { params: { cardId: string }; result: DiffResult };
  'card.screen': { params: { cardId: string }; result: { lines: string[] } };
  'card.log': { params: { cardId: string; after?: number }; result: { lines: LogLine[] } };
  'card.finish': {
    params: { cardId: string; action: FinishAction; commitMessage: string; git: GitSettings; repoGit: Record<string, GitSettings> };
    /** `repos`: multi-repo task, the final state of each repo. */
    result: { prUrl?: string; message: string; repos?: CardRepo[] };
  };
  'card.stop': { params: { cardId: string }; result: { ok: true } };
  'card.focus': { params: { cardId: string }; result: { ok: true } };
}

export type BridgeMethod = keyof BridgeMethods;

export interface CardStatePatch {
  cardId: string;
  runState?: RunState;
  status?: CardStatus;
  branch?: string | null;
  worktreePath?: string | null;
  dispatchId?: string | null;
  waiting?: WaitingInfo | null;
  summary?: string | null;
  error?: string | null;
  preview?: PreviewInfo | null;
  pr?: PrInfo | null;
  repos?: CardRepo[];
  /** Set by the bridge when it sees the PR merged on GitHub (the task is then done). */
  prUrl?: string | null;
}

export interface BridgeEvents {
  hello: BridgeInfo;
  'card.state': CardStatePatch;
  'card.log': { cardId: string; lines: LogLine[] };
  /** Board preview progress/state (also re-sent after a reconnect). */
  'project.preview': { projectId: string; preview: PreviewInfo | null };
}

export type BridgeEventName = keyof BridgeEvents;

export type ServerToBridge = {
  [M in BridgeMethod]: { kind: 'req'; id: string; method: M; params: BridgeMethods[M]['params'] };
}[BridgeMethod];

export interface BridgeError {
  code: string;
  message: string;
}

export type BridgeToServer =
  | { kind: 'res'; id: string; ok: true; result: unknown }
  | { kind: 'res'; id: string; ok: false; error: BridgeError }
  | {
      [E in BridgeEventName]: { kind: 'event'; event: E; data: BridgeEvents[E] };
    }[BridgeEventName];

// ---------------------------------------------------------------------------
// Server -> browser push messages (JSON over WebSocket)
// ---------------------------------------------------------------------------

export type ServerToWeb =
  | { type: 'card.updated'; card: Card }
  | { type: 'card.deleted'; cardId: string; projectId: string }
  | { type: 'card.log'; cardId: string; lines: LogLine[] }
  | { type: 'device.updated'; device: Device }
  | { type: 'project.updated'; project: Project };

/** Push notification events. `done`: the agent finished (review); `input`: the card needs you
 *  (question, sign-in, confirmation); `failed`: the run failed. */
export type NotifyKind = 'done' | 'input' | 'failed';
export type NotifyPrefs = Record<NotifyKind, boolean>;
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { done: true, input: true, failed: true };

/** What the server pushes to a device (end-to-end encrypted by Web Push). */
export interface PushPayload {
  kind: NotifyKind | 'test';
  title: string;
  body: string;
  /** Where a tap opens, e.g. `/#card/<id>`. */
  url: string;
  /** Same tag replaces the previous notification of that card. */
  tag: string;
}

/** A browser's Web Push subscription (PushSubscription.toJSON()). */
export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Branch name the bridge uses for a card's worktree. */
export function cardBranchName(cardId: string): string {
  return `lk-${cardId.slice(0, 8)}`;
}
