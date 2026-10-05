import * as vscode from "vscode";
import { existsSync } from "node:fs";
import {
  SessionRow,
  snapshot,
  ReuseHint,
  fmtAge,
  sessionHasDetails,
  withSubMinuteAgesMasked,
  sessionDetails,
  promptFallbackTitle,
  sessionBirthMs,
  projectSlug,
  AgentDetail,
  WorkflowDetail,
  TaskDetail,
  transcriptPath,
  TokenScanner,
  formatUsage,
  shortModel,
  shortTokens,
  worktreeInfo,
} from "./discovery";
import { ConfigHome } from "./homes";
import { CursorRow, ComposerRow } from "./cursor";
import { CodexRow } from "./codex";
import { editorFamilyRoots, LocationVerdict, pidHasOpen, sessionLocation } from "./procs";
import { sessionResourceUri, dimResourceUri, outsideResourceUri, PreviewDocs } from "./decorations";
import {
  glyphParts,
  outsideSentence,
  cliKindWord,
  ageBucket,
  previewDocPath,
  statusKind,
  fleetHeatScore,
  projectExpanded,
  compareProjectNames,
  projectDisplayName,
  normalizeDriveLetter,
  normalizePinKeys,
  RootFetchSignal,
  hiddenDescription,
  localNeedsYou,
  remoteNeedsYou,
  compactProjectDescription,
  planWorktreeGroups,
  externalModelFromLabel,
  type WorktreeLink,
  type Density,
  type Layout,
  type SessionColumnFields,
  sessionColumnsDescription,
  coloredIcon,
  preEscapeHtml,
  type StatusKind,
  type HeatConstituents,
  statusPhrase as statusPhraseOf,
  sessionVisual,
  workflowVisual,
  agentVisual,
  taskVisual,
  cursorVisual,
  composerVisual,
  composerDescription,
  panelComposerRow,
  lockedPanelSession,
  lockedPanelCursor,
  lockedPanelCodex,
  lockedPanelComposer,
  LOCKED_SESSION_LABEL,
  LOCKED_SESSION_ICON,
  codexProvenanceLabel,
  codexVisual,
  terminalStateVisual,
  terminalStatusKind,
  sanitizeReason,
  workingCaption,
  workingTrailing,
  doneCaption,
  sessionTimeFacts,
  quietHint,
  quietHoverText,
  fmtClock,
  BrandIcon,
  IconVisual,
  PanelModel,
  PanelProject,
  PanelSession,
  PanelChild,
  PanelCursor,
  PanelCodex,
  PanelComposer,
  HostSection,
  PanelRemoteProject,
  PanelRemoteSession,
  PanelRemoteChild,
  PanelInboxRow,
  tallyRemoteSessions,
  hostFactLines,
  partitionPinned,
  hideDecision,
  hideCaptureMtime,
  pruneHidden,
  prunePins,
  pruneToLive,
  HideRecord,
  SessionPropsView,
  CodexPropsView,
  CursorPropsView,
  ComposerPropsView,
  type AgentFamily,
  AGENT_FAMILIES,
} from "./format";
import {
  StoredHostSnapshot,
  BridgeSession,
  BridgeChild,
  hostDisplayLabel,
  SORT_MODES,
  FILTER_MODES,
} from "./bridgeSchema";
import { AlertRow, RemoteAlertRow } from "./alerts";
import { ReasonStore } from "./reasons";
import {
  buildTriageSet,
  buildInbox,
  INBOX_ID_PREFIX,
  type InboxRef,
  advanceTriageCursor,
  TriageTarget,
  FocusRef,
  resolveFocusRef,
} from "./triage";
import {
  CapabilityNote,
  CapabilityProbes,
  selectCapabilityNote,
  detectCollisions,
  collisionsBySession,
  collisionNoteText,
  collapseCollisionPath,
} from "./capability";
import {
  FreeSession,
  isOverFreeLimit,
  licenseState,
  selectFreeTierCoverage,
  type LicenseState,
} from "./license";

/** A short, non-identifying token for a string — used as the DOM/tree id of a
 *  free-tier locked placeholder so the underlying session id never reaches the
 *  renderer. Stable (same input → same token, for a stable tree id) but opaque
 *  (a one-way djb2 hash, not the raw id). Not a security primitive; just avoids
 *  echoing the real identifier into the tree item. */
function opaqueId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** A cyclable needs-you row: id (cursor state) + the tree node to reveal/open. */
export type TriageNode = SessionNode | CursorNode | CodexNode | RemoteSessionNode;

/** A lightweight reference row inside the "Needs you" inbox section. It wraps a
 *  REAL triage row so the inbox is a VIEW, not a move — the same node still renders
 *  in its project below. Its tree item is the underlying row's item with a distinct
 *  `inbox:`-prefixed id (never collides), and BOTH its click command and its
 *  context-menu actions operate on `target` (the real node), so a click records the
 *  real session's focus anchor and hide/read act on the real row. */
export class InboxRefNode {
  readonly kind = "inbox-ref";
  constructor(
    /** `inbox:`-prefixed reference id (distinct from the real row's `anchorId`). */
    readonly refId: string,
    /** The real triage id (e.g. "session:<id>") — the anchor the reference mirrors. */
    readonly anchorId: string,
    /** The real tree node the reference points at (click/menu/focus act on this). */
    readonly target: TriageNode
  ) {}
}

/** Live-node lookups by id (the provider's find* methods). */
export interface RowFinders {
  session(id: string): SessionNode | undefined;
  cursor(id: string): CursorNode | undefined;
  codex(id: string): CodexNode | undefined;
  composer(id: string): ComposerNode | undefined;
}

/** The live row a row command acts on. A tree command receives the node object
 *  VS Code rendered, which a refresh since may have replaced (an inline action
 *  clicked on a row rendered a tick earlier): it is looked up again by id so
 *  the command sees the current row, falling back to the object it got. An
 *  inbox reference acts on the row it mirrors; a table context object carries
 *  only an id. */
export function resolveRowArg(
  arg: unknown,
  find: RowFinders
): SessionNode | CursorNode | ComposerNode | CodexNode | RemoteSessionNode | undefined {
  if (arg === null || typeof arg !== "object") return undefined;
  const a = arg as {
    kind?: string;
    target?: unknown;
    row?: { meta?: { sessionId?: string }; chatId?: string; id?: string; conversationId?: string };
    sessionId?: unknown;
    chatId?: unknown;
    codexId?: unknown;
    conversationId?: unknown;
  };
  if (a.kind === "inbox-ref") return resolveRowArg(a.target, find);
  if (a.kind === "session") return (a.row?.meta?.sessionId !== undefined ? find.session(a.row.meta.sessionId) : undefined) ?? (arg as SessionNode);
  if (a.kind === "cursor") return (a.row?.chatId !== undefined ? find.cursor(a.row.chatId) : undefined) ?? (arg as CursorNode);
  if (a.kind === "codex") return (a.row?.id !== undefined ? find.codex(a.row.id) : undefined) ?? (arg as CodexNode);
  if (a.kind === "composer") return (a.row?.conversationId !== undefined ? find.composer(a.row.conversationId) : undefined) ?? (arg as ComposerNode);
  if (a.kind === "remote-session") return arg as RemoteSessionNode;
  if (a.kind !== undefined) return undefined;
  if (typeof a.sessionId === "string") return find.session(a.sessionId);
  if (typeof a.chatId === "string") return find.cursor(a.chatId);
  if (typeof a.codexId === "string") return find.codex(a.codexId);
  if (typeof a.conversationId === "string") return find.composer(a.conversationId);
  return undefined;
}

/** The collapsible "Needs you (N)" command-center section rendered FIRST at root
 *  (present only when N>0 and the inboxLane setting is on). Its children are
 *  urgency-ranked InboxRefNodes — exactly the buildTriageSet membership + order. */
export class InboxNode {
  readonly kind = "inbox";
  constructor(readonly refs: InboxRefNode[]) {}
}

export class ProjectNode {
  readonly kind = "project";
  constructor(
    readonly cwd: string,
    readonly sessions: SessionNode[],
    readonly cursors: CursorNode[] = [],
    readonly codexes: CodexNode[] = [],
    readonly composers: ComposerNode[] = []
  ) {}
  /** Set when this project directory is a linked git worktree: the branch it has
   *  checked out (e.g. "lane/cursor-open"). Rendered after the name and drives the
   *  worktree glyph; undefined for a normal project or a synthetic parent. */
  branch?: string;
  /** Worktree child projects grouped under this (main-repo) row, rendered as
   *  collapsible children after the sessions. Rebuilt every reload. */
  worktrees: ProjectNode[] = [];
  /** True when this is a synthetic main-repo parent with no sessions of its own —
   *  it exists only to host worktree children whose main checkout has no live
   *  sessions. Not present in the flat `projects` list (so it never counts toward
   *  license/collision/badge); auto-expanded so its worktrees are visible. */
  synthetic = false;
}

export class SessionNode {
  readonly kind = "session";
  /** Codex runs confidently linked to this session as their father (live /proc
   *  ancestor match). Folded UNDER this session's row in the tree. */
  readonly codexChildren: CodexNode[] = [];
  /** Headless cursor-agent (`agent -p`) runs confidently linked to this session as
   *  their father (live /proc ancestor match). Folded UNDER this session's row,
   *  after the codex children — the cursor mirror of codexChildren. */
  readonly cursorChildren: CursorNode[] = [];
  constructor(
    readonly row: SessionRow,
    readonly unread: boolean,
    readonly attention: boolean,
    /** Sanitized permission-request reason, present only on an attention row that
     *  captured one (a hook Notification `message`). Surfaced in the row
     *  description + hover; undefined for question rows (they carry questionText). */
    readonly reason?: string
  ) {}
  /** Free-tier: this row is BEYOND the free caps, so supervision features (alerts,
   *  badge/chip, triage, digest) skip it and it renders dimmed. Data is never
   *  withheld — the row still shows in full. Set once per reload after coverage. */
  dimmed = false;
}

export class CursorNode {
  readonly kind = "cursor";
  /** Finished-unread: the chat is at rest (idle) with activity newer than the
   *  viewer's last-seen mark — recent output not yet looked at. Always false for an
   *  external (headless) or orphaned row — those never draw attention. */
  constructor(
    readonly row: CursorRow,
    readonly unread: boolean = false
  ) {}
  /** Free-tier over-limit dim (see SessionNode.dimmed). */
  dimmed = false;
  /** Demoted external ENDED run: a machine/agent-driven headless `agent -p` run that
   *  has finished and was never in a window. Rendered dimmed, non-clickable, sorted
   *  last, excluded from unread/attention. The cursor mirror of CodexNode.demoted. */
  demoted = false;
  /** This run's cwd no longer exists on disk and its process is dead — an orphan of a
   *  pruned worktree. Grouped under the collapsed "Orphaned runs" bucket, never
   *  attention. Implies demoted styling (set together). */
  orphan = false;
}

export class ComposerNode {
  readonly kind = "composer";
  constructor(readonly row: ComposerRow, readonly unread = false) {}
  dimmed = false;
}

export class CodexNode {
  readonly kind = "codex";
  /** Finished-unread: the session finished its last turn (row.endedTurn) with
   *  activity newer than the viewer's last-seen mark — output not yet looked at. */
  constructor(
    readonly row: CodexRow,
    readonly unread: boolean = false
  ) {}
  /** Free-tier over-limit dim (see SessionNode.dimmed). */
  dimmed = false;
  /** Demoted external ENDED run: a machine/agent-driven `codex exec` (or subagent)
   *  that has finished and was never in a window. Rendered dimmed, non-clickable, and
   *  excluded from unread/attention. Set during assembly. */
  demoted = false;
  /** This run's cwd no longer exists on disk and its process is dead — an orphan of a
   *  pruned worktree. Grouped under the collapsed "Orphaned runs" bucket, never
   *  attention. Implies demoted styling (set together). Mirrors CursorNode.orphan. */
  orphan = false;
}

export class WorkflowNode {
  readonly kind = "workflow";
  constructor(readonly detail: WorkflowDetail) {}
}

export class AgentNode {
  readonly kind = "agent";
  /** parent === "workflow" nodes nest under a WorkflowNode; "session" nodes sit
   *  directly under the session. Only affects the tree-item id namespace. */
  constructor(
    readonly detail: AgentDetail,
    readonly parent: "session" | "workflow"
  ) {}
}

export class TaskNode {
  readonly kind = "task";
  constructor(readonly detail: TaskDetail) {}
}

// ---- Remote host nodes (cross-host bridge, plan §6) -------------------------
// Appended AFTER the self projects, one HostNode per non-self host. All rows are
// read-only: remote cwd/title/lastText are display-only, never fs-touched.

export class HostNode {
  readonly kind = "host";
  constructor(
    readonly snapshot: StoredHostSnapshot,
    /** ≤45s → false (live); ≤24h → true (dimmed, "last seen" suffix). */
    readonly stale: boolean,
    /** Seconds since receivedAt (local clock) — drives the freshness suffix. */
    readonly lastSeenSec: number,
    readonly projects: RemoteProjectNode[]
  ) {}
}

export class RemoteProjectNode {
  readonly kind = "remote-project";
  constructor(
    readonly hostId: string,
    readonly cwd: string,
    readonly sessions: RemoteSessionNode[]
  ) {}
}

export class RemoteSessionNode {
  readonly kind = "remote-session";
  constructor(
    readonly hostId: string,
    readonly session: BridgeSession,
    /** Effective age: publisher's ageSec + elapsed since receivedAt (so a stale
     *  host's rows age honestly rather than freezing at publish time). */
    readonly ageSec: number,
    /** Viewer-side unread (attention on a live host, not yet marked read). */
    readonly unread: boolean,
    readonly stale: boolean
  ) {}
}

export class RemoteChildNode {
  readonly kind = "remote-child";
  constructor(
    readonly id: string,
    readonly child: BridgeChild,
    readonly stale: boolean
  ) {}
}

/** A single dim, informational leaf at the very bottom of the tree, surfaced when
 *  a capability that matters is silently off (see src/capability.ts). Meta — never
 *  a session: it stays out of unreadCount/triage/alerts and its click opens the
 *  relevant fix (Install Hooks / Run Diagnostics). */
export class CapabilityNoteNode {
  readonly kind = "capability-note";
  constructor(readonly note: CapabilityNote) {}
}

/** A dim, informational leaf at the very bottom of the tree (below the capability
 *  note) that keeps hidden sessions from being silently lost: "N hidden". Meta —
 *  never a session (out of unreadCount/triage/alerts); its click opens the Show
 *  Hidden picker. Only shown in the "all" filter, and only when N>0. */
export class HiddenNoteNode {
  readonly kind = "hidden-note";
  constructor(readonly count: number) {}
}

/** A dim, informational leaf at the very bottom of the tree (lowest priority — below
 *  the capability + hidden notes), surfaced only on the FREE tier when the fleet is
 *  over the caps: "Free tier: supervising N of M sessions". Meta — never a session
 *  (out of unreadCount/triage/alerts); clicking enters a license key. */
export class LicenseNoteNode {
  readonly kind = "license-note";
  constructor(
    readonly covered: number,
    readonly total: number
  ) {}
}

/** A dim, informational leaf (lowest priority, below the capability + hidden notes)
 *  surfaced when ≥2 live local sessions have pending edits on the same file — the
 *  multi-agent collision the tree can't otherwise see. Observe-only: no command, no
 *  status change; it coexists with the other meta notes. */
export class CollisionNoteNode {
  readonly kind = "collision-note";
  constructor(readonly message: string) {}
}

/** A single collapsed root bucket collecting every ORPHANED run — a cursor or codex
 *  session whose cwd no longer exists on disk and whose process is dead (a run left
 *  behind by a pruned worktree). One GLOBAL bucket, not per-repo: a deleted
 *  linked-worktree cwd can no longer be resolved back to its main repo (its `.git`
 *  file is gone), so per-repo attribution is impossible. Meta — its rows are all
 *  demoted (dimmed, non-clickable) and never contribute to unread/attention/badge;
 *  each row keeps its normal hide/dismiss context action. */
export class OrphanNode {
  readonly kind = "orphan";
  constructor(
    readonly cursors: CursorNode[],
    readonly codexes: CodexNode[]
  ) {}
}

type Node =
  | InboxNode
  | InboxRefNode
  | ProjectNode
  | SessionNode
  | CursorNode
  | ComposerNode
  | CodexNode
  | OrphanNode
  | WorkflowNode
  | AgentNode
  | TaskNode
  | HostNode
  | RemoteProjectNode
  | RemoteSessionNode
  | RemoteChildNode
  | CapabilityNoteNode
  | HiddenNoteNode
  | LicenseNoteNode
  | CollisionNoteNode;

// ---- Row identity across refreshes -----------------------------------------
// VS Code's extension host maps each rendered row's handle (its TreeItem id) to the
// element object it was given. A full refresh (onDidChangeTreeData with no element)
// clears that map at once (ExtHostTreeView._addAllToClear) and it fills again only
// when the window asks for the rows (a round trip, slow over SSH); a click or an
// inline action in that gap resolves to nothing. An element refresh re-reads that
// one row in place (_refreshNode) and keeps every other row resolvable, but it only
// works on the SAME object the host already holds. So each row object lives as long
// as its row does, keyed by `rowKey`, and every reload updates it in place.

/** The stable identity of a row: what it shows, never where it sits. Two rows never
 *  share a key in one render (reload drops a repeat); a row's TreeItem id is derived
 *  from its key, so a handle can only ever name this row. */
export function rowKey(n: Node): string {
  switch (n.kind) {
    case "inbox":
      return "inbox";
    case "inbox-ref":
      return n.refId;
    case "project":
      return (n.synthetic ? "wtparent:" : "project:") + n.cwd;
    case "session":
      return "session:" + n.row.meta.sessionId;
    case "cursor":
      return "cursor:" + n.row.chatId;
    case "composer":
      return "composer:" + n.row.conversationId;
    case "codex":
      return "codex:" + n.row.id;
    case "orphan":
      return "orphan";
    case "host":
      return "host:" + n.snapshot.host.id;
    case "remote-project":
      return `remote-project:${n.hostId}:${n.cwd}`;
    case "remote-session":
      return `remote-session:${n.hostId}:${n.session.id}`;
    case "remote-child":
      return n.id;
    case "workflow":
      return "workflow:" + n.detail.path;
    case "agent":
      return `agent:${n.parent}:${n.detail.path}`;
    case "task":
      return `task:${n.detail.path}:${n.detail.id}`;
    case "capability-note":
    case "hidden-note":
    case "license-note":
    case "collision-note":
      return n.kind;
  }
}

/** The child lists a row keeps across reloads (the lazily built activity children of
 *  a session or remote session are rebuilt on every fetch and are not listed). */
const KEPT_CHILDREN: Partial<Record<Node["kind"], readonly string[]>> = {
  inbox: ["refs"],
  project: ["sessions", "cursors", "codexes", "composers", "worktrees"],
  session: ["codexChildren", "cursorChildren"],
  orphan: ["cursors", "codexes"],
  host: ["projects"],
  "remote-project": ["sessions"],
};

/** How long "Needs you" keeps a row that stopped needing you (see
 *  SessionsProvider.settleInbox), and how long any group keeps its old order after
 *  its rows last changed (holdOrder): five 3 s ticks. A session turning over
 *  every tick then re-fetches its group at most about once every 15 s instead of
 *  every tick; a row lingers, or sits out of order, for at most 15 s. */
export const SETTLE_MS = 15_000;

/** Rows that only group other rows: their own line summarises the rows under them
 *  (see SessionsProvider.groupOpen). */
const GROUP_KINDS: ReadonlySet<string> = new Set(["inbox", "project", "orphan", "host", "remote-project"]);

/** Rows whose open/folded state is tracked: groups, and sessions with activity rows. */
const FOLDABLE_KINDS: ReadonlySet<string> = new Set([...GROUP_KINDS, "session", "remote-session"]);

function keptChildren(n: Node): Node[] {
  const out: Node[] = [];
  for (const f of KEPT_CHILDREN[n.kind] ?? []) out.push(...((n as unknown as Record<string, Node[]>)[f] ?? []));
  return out;
}

/** What a row shows, as one comparable string: everything VS Code renders,
 *  hover text included, except the command's arguments (the row object itself).
 *  Build `item` under withSubMinuteAgesMasked: sub-minute ages ("45s") then
 *  compare equal, as the old whole-tree signature did, so a young row repaints at
 *  the minute rollover, not every 3 s, while a "1s" inside a message still counts.
 *
 *  The hover is compared rather than produced on demand (resolveTreeItem): the
 *  window resolves a row's hover once and keeps it until that row is refreshed
 *  (ResolvableTreeItem.resolved), so on-demand hovers would still go stale after
 *  the first look. Refreshing a row keeps it and every other row clickable; only
 *  rows under it are dropped for a round trip, and an open group's hover holds
 *  nothing that changes without its rows (see SessionsProvider.groupOpen). */
export function renderSignature(item: vscode.TreeItem): string {
  const cmd = item.command;
  const tip = item.tooltip;
  return JSON.stringify([
      typeof tip === "string" || tip === undefined ? tip ?? null : tip.value,
      item.label,
      item.description ?? null,
      item.iconPath ?? null,
      item.resourceUri?.toString() ?? null,
      item.contextValue ?? null,
      item.collapsibleState ?? null,
      cmd === undefined ? null : [cmd.command, cmd.title, cmd.tooltip ?? null],
      item.accessibilityInformation ?? null,
    ]);
}

/** How recent a row is, in coarse tiers: under 2 minutes, 10 minutes, an hour, a
 *  day, older. Recency sorts compare tiers and keep the previous order within one,
 *  so busy rows don't trade places on every write: a reorder re-fetches the whole
 *  group, and at the root the whole tree (see fireTreeChanges). A row that becomes
 *  active still moves up past every row in an older tier, within SETTLE_MS (see
 *  holdOrder). */
export function recencyTier(ageMs: number): number {
  if (!Number.isFinite(ageMs)) return 5;
  const min = Math.max(0, ageMs) / 60_000;
  return min < 2 ? 0 : min < 10 ? 1 : min < 60 ? 2 : min < 1440 ? 3 : 4;
}

/** One refreshed-tree event, counted for the refresh tests and Diagnostics. */
export interface TreeEventCounts {
  /** Full refreshes (every row cleared until the window fetches again). */
  full: number;
  /** Element refreshes fired, and how many rows they named. */
  partial: number;
  rows: number;
}

interface RenderedRow {
  node: Node;
  parent: string | undefined;
  id: string;
  sig: string;
  /** The children's ids, in order: a change re-fetches the group. */
  kids: string;
  /** The kept children's keys, in order (see holdOrder). */
  childKeys: string[];
}

/** The key holdOrder uses for the root's own list. */
const ROOT_KEY = "";

// The lists live in bridgeSchema so the remote legacy-state import accepts every mode.
export type SortMode = (typeof SORT_MODES)[number];
export type FilterMode = (typeof FILTER_MODES)[number];

export const FILTER_LABELS: Record<FilterMode, string> = {
  all: "All sessions",
  "1h": "Active in last hour",
  "24h": "Active in last 24 hours",
  attention: "Needs attention (working, unread, approval)",
};

const LAST_SEEN_PREFIX = "lastSeen.";
/** lastSeen.* read-marks accumulate one entry per session forever; drop any whose
 *  stored timestamp is older than this at activation so globalState stays bounded. */
const LAST_SEEN_TTL_MS = 60 * 24 * 3600 * 1000;
const BASELINE_KEY = "unreadBaseline";
/** First-ever-activation stamp for the 3-day free evaluation. Set ONCE and never
 *  moved, so the trial can't be reset by clearing/re-adding a key. */
export const TRIAL_START_KEY = "licenseTrialStart";

/** When this install first started while its trial origin was still unknown
 *  (a rename migration that failed). The trial clock runs from here meanwhile. */
export const FIRST_SEEN_KEY = "trialFirstSeenAt";
/** Starts in a row whose rename migration failed before a trial start was saved. */
export const MIGRATION_FAILURES_KEY = "renameMigrationFailures";

/** The trial origin to count from: the saved start, else the first start this
 *  install recorded while waiting for the former extension's state, else now
 *  (only before anything was ever saved, i.e. the first activation). */
export function trialOrigin(state: vscode.Memento, now: number): number {
  return state.get<number>(TRIAL_START_KEY) ?? state.get<number>(FIRST_SEEN_KEY) ?? now;
}

export interface TrialStartInput {
  saved?: number;
  firstSeen?: number;
  failures: number;
  migrationFailed: boolean;
  /** A trial-ended latch is set: the trial is known to have ended. */
  endedLatch: boolean;
  /** When this install last saw the trial running (trialSeenAt). */
  seenAt?: number;
  now: number;
  maxAttempts: number;
  trialMs: number;
}

export interface TrialStartDecision {
  /** Trial start to save now. */
  stamp?: number;
  /** First-seen time to save (the first failed start). */
  firstSeen?: number;
  /** Failed-migration count to save. */
  failures?: number;
  /** The trial origin is final for this activation. */
  settled: boolean;
}

/** Which trial start to save at activation. The former extension's state can hold
 *  an older (maybe ended) trial start; the migration copies only missing keys, so
 *  stamping one while that state is unread would block the older one for good.
 *  So while the migration fails nothing is stamped, for at most `maxAttempts`
 *  starts; the clock meanwhile runs from the first of them (trialOrigin). At the
 *  cap, or once the migration works, the start saved is never later than that
 *  first start, nor than the trial was last seen running, and when a latch says
 *  the trial already ended it is at least `trialMs` back. */
export function decideTrialStart(i: TrialStartInput): TrialStartDecision {
  // Failures are counted even with a start saved: the count also caps how long an
  // unreadable state database keeps being reported.
  if (i.saved !== undefined) return i.migrationFailed ? { failures: i.failures + 1, settled: true } : { settled: true };
  const earliest = (first: number): number => {
    let t = first;
    if (i.seenAt !== undefined && Number.isFinite(i.seenAt) && i.seenAt < t) t = i.seenAt;
    if (i.endedLatch) t = Math.min(t, i.now - i.trialMs);
    return t;
  };
  if (!i.migrationFailed) return { stamp: earliest(i.firstSeen ?? i.now), settled: true };
  const firstSeen = i.firstSeen ?? i.now;
  const failures = i.failures + 1;
  const out: TrialStartDecision = { failures, settled: false };
  if (i.firstSeen === undefined) out.firstSeen = firstSeen;
  if (failures >= i.maxAttempts) {
    out.stamp = earliest(firstSeen);
    out.settled = true;
  }
  return out;
}

// Keys whose save failed in this window (this extension host), each reported once.
const unsavedKeys = new Set<string>();
let reportFailedSave: (key: string, err: unknown) => void = () => undefined;

/** Who hears about a failed save (once per key per window): the extension logs
 *  it and, for state that matters across restarts, adds it to the startup notice. */
export function onFailedSave(report: (key: string, err: unknown) => void): void {
  reportFailedSave = report;
  unsavedKeys.clear(); // a new activation: report afresh
}

/** Keys that could not be saved in this window, for Diagnostics. Read marks are
 *  per session; they are folded into one entry so no session id is listed. */
export function unsavedSettingKeys(): string[] {
  return [...unsavedKeys];
}

function noteFailedSave(key: string, err: unknown): void {
  try {
    const shown = key.startsWith(LAST_SEEN_PREFIX) ? `${LAST_SEEN_PREFIX}*` : key;
    if (unsavedKeys.has(shown)) return;
    unsavedKeys.add(shown);
    reportFailedSave(shown, err);
  } catch {
    // reporting must never fail the caller
  }
}

/** Save one value without waiting. Never throws or rejects: a failed write
 *  (broken state storage) is reported once per key (onFailedSave) and dropped;
 *  the value is written again the next time it changes or on the next activation. */
export function saveQuietly(state: vscode.Memento, key: string, value: unknown): void {
  try {
    Promise.resolve(state.update(key, value)).catch((err: unknown) => noteFailedSave(key, err));
  } catch (err) {
    noteFailedSave(key, err);
  }
}
const SORT_KEY = "sortMode";
const FILTER_KEY = "filterMode";
const HIDDEN_TYPES_KEY = "hiddenAgentTypes";
/** globalState key for the bounded pinned-project set: cwd → last-observed
 *  activity ms (refreshed while the project is present, so an idle-but-alive pin
 *  survives and only a truly gone project ages past PINHIDE_TTL_MS). */
const PIN_KEY = "pinnedProjects";
/** globalState key for the bounded hidden-session set: sessionKey → HideRecord. */
const HIDE_KEY = "hiddenSessions";
/** Pins/hides whose reference activity is older than this are pruned so
 *  globalState stays bounded — "the session vanished >7d ago" (a woken session
 *  auto-unhides long before it reaches this via mtime advance). */
const PINHIDE_TTL_MS = 7 * 24 * 3600 * 1000;
/** Hard caps so a runaway never grows globalState without bound (newest kept). */
const MAX_PINS = 50;
const MAX_HIDDEN = 300;

// Staleness thresholds (plan §6), computed ONLY from receivedAt vs local Date.now.
const LIVE_MS = 45_000; // 3× the 15s heartbeat
const STALE_MS = 24 * 3600 * 1000;
/** Separator for the per-session lastSeen key `hostId∥sessionId` (plan §6). */
const SEEN_SEP = "∥";
/** Virtual-document scheme for a remote session's last-message preview (its text
 *  lives in-memory, not on disk — so it needs its own content provider). */
/** Sentinel cwd for the synthetic orphan-bucket PanelProject — never a real path, so
 *  it is never pinned, never a worktree, and never collides with a project cwd. */
const ORPHAN_BUCKET_CWD = "\0orphaned-runs";
const REMOTE_PREVIEW_SCHEME = "sessiondeck-remote";
const REMOTE_LAST_MSG_CMD = "sessionDeck.showRemoteLastMessage";
/** Live remote rows focus the session on its own host (owner-approved cross-host
 *  action); the handler in extension.ts degrades to the preview when the bridge
 *  can't relay the click. Stale rows keep the preview directly. */
const REMOTE_FOCUS_CMD = "sessionDeck.focusRemoteSession";

/** Keep only the `max` newest entries of a bounded persisted map, by a numeric
 *  weight (default: the value itself, for a `Record<string, number>`). Prevents
 *  unbounded globalState growth; the dropped entries are the least-recent. */
function capNewest<V>(
  records: Record<string, V>,
  max: number,
  weight: (v: V) => number = (v) => v as unknown as number
): Record<string, V> {
  const keys = Object.keys(records);
  if (keys.length <= max) return records;
  const kept = keys.sort((a, b) => weight(records[b]) - weight(records[a])).slice(0, max);
  const out: Record<string, V> = {};
  for (const k of kept) out[k] = records[k];
  return out;
}

/** Key-order-stable JSON of a flat record, so a write-on-diff guard compares by
 *  CONTENT not insertion order (a map rebuilt present-keys-then-absent could
 *  otherwise flip key order and trigger one spurious self-correcting write). */
function stableJson(record: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(record).sort()) sorted[k] = record[k];
  return JSON.stringify(sorted);
}

/** Readable fallback label for a hidden row whose session is no longer present
 *  (no live title available): the tool name + a short id. */
function hiddenKeyLabel(key: string): string {
  const sep = key.indexOf(":");
  const tool = sep === -1 ? key : key.slice(0, sep);
  const id = sep === -1 ? "" : key.slice(sep + 1);
  const short = id.length > 8 ? id.slice(0, 8) : id;
  return short === "" ? tool : `${tool} ${short}`;
}

/** A remote child counts as "running" for icon purposes when its status says so.
 *  Unknown/absent statuses read as done — never as live activity. */
function remoteChildRunning(status: string | undefined): boolean {
  return status === "running" || status === "working" || status === "in_progress";
}

/** Icon for a read-only remote activity-tree child, reusing the same visuals as
 *  local workflow/agent/task rows. */
function remoteChildVisual(c: BridgeChild, stale: boolean): IconVisual {
  // Stale hosts render last-known state only — never an animated "live" child.
  if (c.kind === "task") {
    const v = taskVisual(c.status ?? "");
    return stale ? { ...v, spin: false } : v;
  }
  const running = !stale && remoteChildRunning(c.status);
  return c.kind === "workflow" ? workflowVisual(running) : agentVisual(running);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Fleet-heat inputs for a project, built purely from flags the reload already
 *  derived (no new I/O): each session-like row contributes its statusKind, and the
 *  recency term is whole minutes since the project's newest activity. Cursor/Codex
 *  rows have no attention/question gate, so they map working→working, finished-
 *  unread→unread, otherwise idle. Minute-granular age keeps the score stable across
 *  sub-minute quiet ticks. */
function projectHeatConstituents(p: ProjectNode, now: number): HeatConstituents {
  const kinds: StatusKind[] = [];
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const s of p.sessions) {
    kinds.push(
      statusKind({
        status: s.row.status,
        unread: s.unread,
        attention: s.attention,
        pendingQuestion: s.row.pendingQuestion,
      })
    );
    if (s.row.mtimeMs > newestMs) newestMs = s.row.mtimeMs;
  }
  for (const c of p.cursors) {
    kinds.push(c.row.status === "working" ? "working" : c.unread ? "unread" : "idle");
    if (c.row.updatedMs > newestMs) newestMs = c.row.updatedMs;
  }
  for (const c of p.codexes) {
    kinds.push(c.row.status === "working" ? "working" : c.unread ? "unread" : "idle");
    if (c.row.updatedMs > newestMs) newestMs = c.row.updatedMs;
  }
  const ageMin =
    newestMs === Number.NEGATIVE_INFINITY ? null : Math.max(0, Math.floor((now - newestMs) / 60000));
  return { kinds, ageMin };
}

/** Flatten an IconVisual into the flat fields the panel model carries. */
function visual(v: IconVisual): { icon: string; iconColor?: string; spin: boolean; brand?: BrandIcon } {
  return { icon: v.icon, iconColor: v.color, spin: v.spin, brand: v.brand };
}

/** Render an IconVisual as a tree ThemeIcon (adding the ~spin modifier), so the
 *  sidebar and the webview panel draw the same icon from the same rule. */
function themeIcon(v: IconVisual): vscode.ThemeIcon {
  const id = v.spin ? `${v.icon}~spin` : v.icon;
  return v.color ? new vscode.ThemeIcon(id, new vscode.ThemeColor(v.color)) : new vscode.ThemeIcon(id);
}

/** Plain-text child tooltip (title, detail lines, then the source path). */
function childHover(title: string, path: string, lines: string[]): string {
  return [title, ...lines, path].join("\n");
}

export class SessionsProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node[] | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  /** Row objects by rowKey, kept across reloads (see "Row identity across refreshes"). */
  private rowCache = new Map<string, Node>();
  /** Each row as the last reload rendered it, by rowKey. */
  private rendered = new Map<string, RenderedRow>();
  /** The root rows' ids from the last reload, in order. */
  private renderedRootIds = "";
  /** The root rows, built by reload (getChildren(root) only hands them out). */
  private rootChildren: Node[] = [];
  /** Each row's position in its group at the last reload, the tie-break that keeps
   *  same-minute rows in place. */
  private lastOrder = new Map<string, number>();
  /** The next reload redraws the whole tree (first render, or a view setting changed). */
  private fullRefreshDue = true;
  /** Groups the view folded (true) or opened (false), by rowKey (see groupOpen). */
  private readonly folded = new Map<string, boolean>();
  /** Tree events fired so far (tests and Diagnostics). */
  readonly treeEvents: TreeEventCounts = { full: 0, partial: 0, rows: 0 };
  /** sessionHasDetails per session, re-read only when the session's activity moves,
   *  so rendering a row for comparison costs no directory reads. */
  private readonly detailsMemo = new Map<string, { at: string; has: boolean }>();

  private projects: ProjectNode[] = [];
  /** The worktree-GROUPED top level rendered at the tree root: real projects plus
   *  synthetic main-repo parents, with worktree projects nested (never at the root).
   *  Derived from `projects` every reload; `projects` itself stays FLAT (worktrees
   *  included, synthetics excluded) so all counting/collision/license/panel paths are
   *  unchanged. Only getChildren(root)/getParent read this. */
  private topProjects: ProjectNode[] = [];
  /** Remote hosts rendered after the self projects; empty for single-host users
   *  so the self view stays byte-for-byte unchanged (plan §6 / §10). */
  private hostNodes: HostNode[] = [];
  /** The one collapsed root bucket of orphaned runs (cwd deleted + process dead),
   *  or undefined when none. Rebuilt every reload; kept OUT of `projects` so it never
   *  counts toward badge/license/collision. Only getChildren(root)/getParent read it. */
  private orphanNode: OrphanNode | undefined;
  /** Per-reload memo of cwd existence (see dirExists), cleared at the top of the
   *  cursor/codex pass so each unique cwd is stat'd at most once per reload. */
  private readonly cwdExists = new Map<string, boolean>();
  private signature = "";

  /** The change-signature from the last reload(): every status / structure field
   *  the views show. (The sidebar tree no longer fires on it; it compares row by
   *  row, see fireTreeChanges.) refresh() reads it to gate the per-tick
   *  panel/publish build: it skips buildPanelModel() on a tick
   *  whose signature matches the one the last-built model carried, so the panel and
   *  the published snapshot inherit the sidebar tree's freshness rather than being
   *  rebuilt every quiet tick. Empty until the first reload. */
  get changeSignature(): string {
    return this.signature;
  }

  // ---- Cross-host injection seams (assigned by extension.ts after construction,
  // same pattern as cursorSessions/remoteTitles). Safe no-op defaults keep the
  // single-host path identical when the bridge is absent.
  /** Non-self host snapshots, already filtered to receivedAt within 24h and
   *  sorted by display label (double-guarded here). */
  remoteHosts: () => StoredHostSnapshot[] = () => [];
  /** This host's stable id; undefined = degraded (no host.json yet) → lastSeen
   *  keying falls back to bare session ids. */
  selfHostId: () => string | undefined = () => undefined;
  /** Background model/mode/token scanner (assigned by extension.ts). Undefined =
   *  the feature is off / unwired, so hovers render exactly as before (no
   *  model·mode·tokens line, no per-agent token clause) — keeping every test that
   *  doesn't opt in byte-for-byte unchanged. */
  tokenScanner: TokenScanner | undefined;
  /** Live capability probes (assigned by extension.ts), read once per reload to
   *  select the degraded-capability note. Reuses existing probes only — no new
   *  scanning. The safe default is a healthy fleet, so the single-host path (and
   *  every test that doesn't wire this) shows no note. */
  capabilityInput: () => Omit<CapabilityProbes, "hasSessions" | "filterAll"> = () => ({
    hooksInstalled: true,
    hookScriptStale: false,
    platformSupportsHooks: true,
    crossHostEnabled: false,
    bridgeAvailable: true,
    bridgePromptDismissed: false,
    hookDrift: false,
    driftHarness: undefined,
  });
  /** Publisher version skew from the bridge hello handshake (companion version +
   *  whether it differs from ours). Surfaced read-only in a host hover ONLY when
   *  skewed — reuses the existing bridge getter, adds no probe. Safe default: no
   *  skew, so the single-host path (and every test that doesn't wire this) shows
   *  nothing. */
  publisherSkew: () => { version: string | undefined; skew: boolean } = () => ({
    version: undefined,
    skew: false,
  });
  /** The degraded-capability note for the current reload, or undefined when the
   *  fleet is healthy (or the tree is empty / filtered). Rendered as a leaf at the
   *  bottom of the tree and mirrored in the panel footer. */
  private capabilityNote: CapabilityNote | undefined;
  /** Per-session same-path collision info for the current reload (sessionId → the
   *  colliding path + the other sessions' display labels), empty when none. Feeds
   *  the row glyph + hover. Rebuilt every reload. */
  private collisions: Map<string, { path: string; otherLabels: string[] }> = new Map();
  /** The lowest-priority collision note line for the current reload, or undefined
   *  when no live local sessions collide. Rendered as the very last leaf. */
  private collisionNote: string | undefined;

  // ---- License / free-tier gating (see src/license.ts) ----------------------
  /** The raw license key (injected by extension.ts from sessionDeck.licenseKey;
   *  validated OFFLINE — never sent anywhere). Safe default: unlicensed. */
  licenseKey: () => string = () => "";
  /** Licensing state resolved on the last reload (for the status bar + doctor). */
  currentLicenseState: LicenseState = "free";
  /** True when state is "free" AND the fleet is over a free-tier cap (the trigger
   *  for dimming, the status-bar key item and the daily reminder). */
  freeTierOverLimit = false;
  /** Covered / total top-level local rows on the last reload (for the note + doctor). */
  licenseCovered = 0;
  licenseTotal = 0;
  /** The free-tier note for the current reload (covered/total), or undefined when
   *  licensed / in trial / within limits. Rendered as the lowest-priority leaf. */
  private licenseNote: { covered: number; total: number } | undefined;

  /** Hidden-session records for the current reload, loaded once at the top of
   *  reload() from globalState so the per-row hide check is a plain map lookup. */
  private hidden: Readonly<Record<string, HideRecord>> = {};
  /** Hidden rows that matched a PRESENT session this reload (key → title/age),
   *  for the Show-Hidden picker and the "N hidden" note. Rebuilt every reload. */
  private hiddenPresent = new Map<string, { title: string; ageSec: number }>();
  /** Hidden keys that earned auto-unhide this reload (their activity advanced past
   *  the hide-time mtime); flushed to globalState at the end of reload(). */
  private pendingUnhide = new Set<string>();

  /** Command + content-provider disposables owned by this provider (registered in
   *  the constructor, since remote last-message preview can't reuse extension.ts's
   *  on-disk preview path). */
  private disposables: vscode.Disposable[] = [];
  private readonly remotePreviewEmitter = new vscode.EventEmitter<vscode.Uri>();
  /** Homes from the last refresh; internal reloads (sort/filter/markRead) reuse them. */
  private homes: ConfigHome[] = [];
  /** True when the snapshot spans more than one config home: only then do we
   *  surface which account each session belongs to. */
  private multiHome = false;
  /** Install roots of this editor family (a process under one = "in the editor"). */
  private readonly familyRoots = editorFamilyRoots(vscode.env.appRoot ?? "", process.execPath);
  /** Shell pids of this window's integrated terminals (kept by the extension),
   *  plus this extension host: a session it runs is in the editor whatever its
   *  install path looks like. */
  private terminalPids: ReadonlySet<number> = new Set([process.pid]);

  setTerminalPids(pids: ReadonlySet<number>): void {
    this.terminalPids = new Set([...pids, process.pid]);
  }
  unreadCount = 0;
  /** Last needs-you row the keyboard triage cursor visited (in-memory, session-
   *  scoped). The set is recomputed every step; this is the only state kept. */
  private lastTriageId: string | undefined;
  /** The last session focused via any open/triage/click path — the anchor
   *  `returnToFocus` re-resolves. Held by ref (id only, never a node reference,
   *  since reload() rebuilds every node), so the command re-resolves the CURRENT
   *  node and degrades to a status-bar note when the session is gone. In-memory,
   *  session-scoped; the single setter is noteFocus (below). */
  private focusAnchor: FocusRef | undefined;
  /** sessionId -> event ts of a pending permission request (fed by hook events). */
  readonly attentionMap = new Map<string, number>();
  /** sessionId -> sanitized reason of the current permission request (the hook
   *  Notification `message`, e.g. "Claude needs your permission to use Bash").
   *  Set/cleared in lockstep with attentionMap so a row can surface WHAT it asks. */
  readonly reasons = new ReasonStore();
  /** Bumped by collapse/expand-all and density flips: new tree-item ids force VS
   *  Code to apply the collapsibleState we provide instead of its remembered one. */
  private generation = 0;
  /** Collapse/expand-all override: true = force all collapsed, false = force all
   *  expanded, undefined = follow the density default. A density flip clears it so
   *  the compact/comfortable default takes over. */
  private collapseOverride: boolean | undefined = undefined;

  /** Signature of the label set from the last reload; only a change fires
   *  onHomeLabels, so the decoration provider isn't repainted every 3s. */
  private homeLabelsSig = "";

  constructor(
    private readonly state: vscode.Memento,
    /** Extension root Uri, used to resolve brand-icon SVGs under media/. */
    private readonly extensionUri: vscode.Uri,
    private readonly titleFor: (sessionId: string) => string | undefined = () => undefined,
    private readonly onHomeLabels: (labels: string[]) => void = () => undefined,
    private readonly activityTree: () => boolean = () => false,
    /** Cursor Agent CLI sessions to interleave; returns [] when the setting is off. */
    private readonly cursorSessions: () => CursorRow[] = () => [],
    /** Codex CLI sessions to interleave; returns [] when the setting is off. */
    private readonly codexSessions: () => CodexRow[] = () => [],
    private readonly composerSessions: () => ComposerRow[] = () => [],
    /** View density (sessionDeck.density). "compact" collapses project rows by
     *  default and shows the pressure summary; safe default is today's rendering. */
    private readonly density: () => Density = () => "comfortable",
    /** View layout (sessionDeck.layout). "columns" renders session rows as aligned
     *  time·status·model·tokens columns (a real grid in the panel, ordered slots in the
     *  tree); "list" is today's inline description flow. */
    private readonly layout: () => Layout = () => "list",
    /** Whether the needs-you inbox lane (sessionDeck.inboxLane) is on. When true
     *  (default) a "Needs you (N)" section renders first at root; off = exactly
     *  today's rendering (no inbox nodes anywhere). */
    private readonly inboxLane: () => boolean = () => true
  ) {
    // sessions finished before install shouldn't all light up as unread
    if (state.get<number>(BASELINE_KEY) === undefined) {
      saveQuietly(state, BASELINE_KEY, Date.now());
    }
    this.pruneLastSeen();

    // Remote session rows preview their in-memory lastText through a virtual
    // document (the on-disk preview path in extension.ts only knows self rows).
    // One at a time, and undone if a later one throws: the caller never gets this
    // object to dispose, so nothing registered here may outlive a failed build.
    try {
      this.disposables.push(
        vscode.commands.registerCommand(REMOTE_LAST_MSG_CMD, (arg: RemoteSessionNode | InboxRefNode) => {
          // An inbox reference row unwraps to the real remote session (view semantics).
          const node = arg.kind === "inbox-ref" ? arg.target : arg;
          if (node.kind === "remote-session") this.showRemotePreview(node);
        })
      );
      this.disposables.push(
        PreviewDocs.register(REMOTE_PREVIEW_SCHEME, (uri) => this.remotePreviewContent(uri), this.remotePreviewEmitter.event)
      );
    } catch (err) {
      this.dispose();
      throw err;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.remotePreviewEmitter.dispose();
  }

  /** One cheap activation-time pass over globalState: drop lastSeen.* read-marks
   *  whose stored timestamp (session mtime, ms) is older than the TTL, so the map
   *  can't grow unbounded across the lifetime of the install. */
  private pruneLastSeen(): void {
    const cutoff = Date.now() - LAST_SEEN_TTL_MS;
    for (const key of this.state.keys()) {
      if (!key.startsWith(LAST_SEEN_PREFIX)) continue;
      const ts = this.state.get<number>(key);
      if (typeof ts === "number" && ts < cutoff) saveQuietly(this.state, key, undefined);
    }
  }

  setAllCollapsed(collapsed: boolean): void {
    this.collapseOverride = collapsed;
    this.generation++;
    this.signature = "";
    this.fullRefreshDue = true;
    this.reload();
  }

  /** Density (sessionDeck.density) flipped: clear any collapse/expand-all
   *  override so the new density default takes over, then repaint ONCE — the new
   *  collapsibleState only applies when the item id changes, so bump the generation
   *  (project/host ids carry it). Quiet ticks after this stay quiet: the compact
   *  descriptions ride the same minute-granular fields the signature already folds. */
  refreshDensity(): void {
    this.collapseOverride = undefined;
    this.generation++;
    this.signature = "";
    this.fullRefreshDue = true;
    this.reload();
  }

  /** Needs-you rows in a local project: attention (permission) + pending-question
   *  sessions — the blocked-on-you set, reusing flags the reload already derived.
   *  Free-tier-dimmed rows are excluded (they're out of supervision everywhere —
   *  badge/alerts/triage), so the 🔔 count matches the badge and a license-gated
   *  row can never force a project to auto-expand. */
  private projectNeedsYou(p: ProjectNode): number {
    return p.sessions.filter((s) =>
      localNeedsYou({ attention: s.attention, pendingQuestion: s.row.pendingQuestion, dimmed: s.dimmed })
    ).length;
  }

  /** Needs-you rows on a remote project: attention sessions on a LIVE host (already
   *  present in the bridge snapshot — no schema change). Stale hosts are excluded —
   *  their rows are last-known, never live attention, consistent with the compact
   *  remote working count and everywhere else stale rows are treated as not-live. */
  private remoteProjectNeedsYou(p: RemoteProjectNode): number {
    return p.sessions.filter((s) =>
      remoteNeedsYou({ attention: s.session.attention === true, stale: s.stale })
    ).length;
  }

  /** A group that comes to need you opens, even if it was folded: the "needs-you
   *  is never buried" covenant. The group's id stays the same (an id change is a
   *  redraw of the whole level, and at the root of the whole tree), so the opening
   *  goes through the view instead: extension.ts sets this to TreeView.reveal
   *  with expand. Once per onset; between onsets the user's own fold holds, and a
   *  resolved group keeps whatever state it has. */
  expandRow: (node: Node) => void = () => undefined;
  /** Is this the row object the tree holds now (not one gone since)? */
  isCurrent(node: Node): boolean {
    return this.rowCache.get(rowKey(node)) === node;
  }
  /** Groups whose needs-you opening was requested at the last reload, by rowKey. */
  private wantsOpen = new Set<string>();

  /** Ask the view to open each group that just came to need you (see expandRow). */
  private openNeedsYouGroups(): void {
    const density = this.density();
    const now = new Set<string>();
    const wants = (needsYou: number): boolean =>
      projectExpanded(density, this.collapseOverride, needsYou) && !projectExpanded(density, this.collapseOverride, 0);
    for (const p of this.projects) {
      if (p.synthetic) continue;
      if (wants(this.projectNeedsYou(p) + p.worktrees.reduce((n, w) => n + this.projectNeedsYou(w), 0))) now.add(rowKey(p));
    }
    for (const h of this.hostNodes) {
      let hostNeeds = 0;
      for (const rp of h.projects) {
        const n = this.remoteProjectNeedsYou(rp);
        hostNeeds += n;
        if (wants(n)) now.add(rowKey(rp));
      }
      if (wants(hostNeeds)) now.add(rowKey(h));
    }
    for (const key of now) {
      const node = this.rowCache.get(key);
      if (!this.wantsOpen.has(key) && node !== undefined) this.expandRow(node);
    }
    this.wantsOpen = now;
  }

  /** Layout (sessionDeck.layout) flipped between "list" and "columns": every
   *  session row's description changes (inline flow ↔ ordered column cells) and the
   *  panel grid switches on/off. Descriptions re-apply on any reload, so clearing the
   *  signature (which now folds layout) is enough to force the repaint once; quiet
   *  ticks after stay quiet (layout only changes on the config toggle). */
  refreshLayout(): void {
    // No generation bump: new ids would reapply every group's default open state
    // and undo the user's folds. The stale replay after Column View is prevented
    // by sending only whole-tree refreshes while the view is hidden (setViewVisible).
    this.signature = "";
    this.fullRefreshDue = true;
    this.reload();
  }

  /** Is the Sessions tree on screen? Column View hides it (its `when` clause) and
   *  shows the table instead. A hidden tree view queues every element refresh it
   *  is sent and replays them, stale rows and all, after the root fetch when it
   *  shows again; with the row-level refresh that drew a second, stale list over
   *  the live one after Column View was switched off. So while hidden only whole-
   *  tree refreshes are sent (each one resets that queue), and showing again
   *  sends one more. */
  private viewVisible = true;
  setViewVisible(visible: boolean): void {
    if (visible === this.viewVisible) return;
    this.viewVisible = visible;
    if (!visible) return;
    this.treeEvents.full++;
    this.groupChangedAt.set(ROOT_KEY, Date.now());
    this.emitter.fire(undefined);
  }

  /** Signals each root fetch, so a toast about a state change can wait until the
   *  tree shows it (see RootFetchSignal). */
  readonly rootFetch = new RootFetchSignal();

  forceReload(): void {
    this.signature = "";
    this.fullRefreshDue = true;
    this.reload();
  }

  /** Toggling activityTree changes session rows between leaf and expandable, which
   *  VS Code only re-applies when the item id changes — so bump the generation
   *  (session ids carry it) and force a repaint. */
  refreshActivityTree(): void {
    this.generation++;
    this.signature = "";
    this.fullRefreshDue = true;
    this.reload();
  }

  get sortMode(): SortMode {
    return this.state.get<SortMode>(SORT_KEY) ?? "activity";
  }

  get filterMode(): FilterMode {
    return this.state.get<FilterMode>(FILTER_KEY) ?? "all";
  }

  /** Persisted set of hidden agent families. Read canonicalized so old or corrupt
   *  state cannot inject invalid families, and all-hidden falls back to show all. */
  get hiddenAgentTypes(): AgentFamily[] {
    const raw = this.state.get<unknown>(HIDDEN_TYPES_KEY);
    const arr = Array.isArray(raw) ? raw : [];
    const hidden = AGENT_FAMILIES.filter((f) => arr.includes(f));
    return hidden.length >= AGENT_FAMILIES.length ? [] : hidden;
  }

  isTypeVisible(f: AgentFamily): boolean {
    return !this.hiddenAgentTypes.includes(f);
  }

  async setSortMode(mode: SortMode): Promise<void> {
    await this.state.update(SORT_KEY, mode);
    this.signature = "";
    this.fullRefreshDue = true;
    this.reload();
  }

  async setFilterMode(mode: FilterMode): Promise<void> {
    await this.state.update(FILTER_KEY, mode);
    this.signature = "";
    this.fullRefreshDue = true;
    this.reload();
  }

  async setHiddenAgentTypes(hidden: readonly AgentFamily[]): Promise<void> {
    const clean = AGENT_FAMILIES.filter((f) => hidden.includes(f));
    const next = clean.length >= AGENT_FAMILIES.length ? [] : clean;
    await this.state.update(HIDDEN_TYPES_KEY, next);
    this.signature = "";
    this.fullRefreshDue = true;
    this.reload();
  }

  // ---- Pin projects ---------------------------------------------------------

  /** The pin map as stored (cwd → last-observed activity ms). Older builds stored
   *  a Windows cwd with whatever drive-letter case it was seen with. */
  private storedPins(): Record<string, number> {
    return this.state.get<Record<string, number>>(PIN_KEY) ?? {};
  }

  /** The pin map keyed the way project groups are (drive letter upper-cased), so a
   *  pin stored as `s:\work` still matches the `S:\work` group. Two stored spellings
   *  of one folder merge, keeping the newer time. The next pin write stores this form. */
  private pins(): Record<string, number> {
    return normalizePinKeys(this.storedPins());
  }

  isPinned(cwd: string): boolean {
    return this.pins()[normalizeDriveLetter(cwd)] !== undefined;
  }

  async pinProject(cwd: string): Promise<void> {
    const pins = this.pins();
    pins[normalizeDriveLetter(cwd)] = Date.now();
    await this.state.update(PIN_KEY, capNewest(pins, MAX_PINS));
    this.signature = "";
    this.reload();
  }

  async unpinProject(cwd: string): Promise<void> {
    const pins = this.pins();
    const key = normalizeDriveLetter(cwd);
    if (pins[key] === undefined) return;
    delete pins[key];
    await this.state.update(PIN_KEY, pins);
    this.signature = "";
    this.reload();
  }

  // ---- Hide sessions --------------------------------------------------------

  /** The persisted hidden-session map. */
  private hiddenMap(): Record<string, HideRecord> {
    return this.state.get<Record<string, HideRecord>>(HIDE_KEY) ?? {};
  }

  /** Stable per-session key + its activity mtime, for a hideable LOCAL row.
   *  Remote rows have no SessionNode/CursorNode/CodexNode, so they can't reach
   *  here — hide is LOCAL-only by construction. */
  private hideTarget(
    node: SessionNode | CursorNode | ComposerNode | CodexNode
  ): { key: string; mtime: number } {
    if (node.kind === "session") return { key: "session:" + node.row.meta.sessionId, mtime: node.row.mtimeMs };
    if (node.kind === "cursor") return { key: "cursor:" + node.row.chatId, mtime: node.row.updatedMs };
    if (node.kind === "composer") return { key: "composer:" + node.row.conversationId, mtime: node.row.updatedMs };
    return { key: "codex:" + node.row.id, mtime: node.row.updatedMs };
  }

  /** The current on-disk activity mtime for a hideable row, read FRESH at command
   *  time. The rendered node passed by the context menu can be stale (the session
   *  may have written since the last repaint), so we re-read the source; falling
   *  back to the node's own mtime when the row isn't in the fresh read (e.g. it
   *  just vanished). Cheap: snapshot() is mtime-cached, so unchanged files are hits. */
  private freshMtimeFor(node: SessionNode | CursorNode | ComposerNode | CodexNode): number {
    if (node.kind === "session") {
      const id = node.row.meta.sessionId;
      for (const rows of snapshot(this.homes).values()) {
        for (const r of rows) if (r.meta.sessionId === id) return r.mtimeMs;
      }
      return node.row.mtimeMs;
    }
    if (node.kind === "cursor") {
      return this.cursorSessions().find((c) => c.chatId === node.row.chatId)?.updatedMs ?? node.row.updatedMs;
    }
    if (node.kind === "composer") return this.composerSessions().find((c) => c.conversationId === node.row.conversationId)?.updatedMs ?? node.row.updatedMs;
    return this.codexSessions().find((c) => c.id === node.row.id)?.updatedMs ?? node.row.updatedMs;
  }

  async hideSession(node: SessionNode | CursorNode | ComposerNode | CodexNode): Promise<void> {
    const { key, mtime: nodeMtime } = this.hideTarget(node);
    // Capture the current activity mtime (not the possibly-stale node's) so a write
    // that landed between render and click can't auto-unhide the row next tick.
    const mtime = hideCaptureMtime(nodeMtime, this.freshMtimeFor(node));
    const records = { ...this.hiddenMap() };
    records[key] = { mtime, hideAt: Date.now() };
    await this.state.update(HIDE_KEY, capNewest(records, MAX_HIDDEN, (r) => r.hideAt));
    this.signature = "";
    this.reload();
  }

  /** Dismiss (hide) EVERY run currently in the orphan bucket in one action — the
   *  bucket header's "Dismiss all". Reuses the same hide machinery as a single-row
   *  hide (they share the HIDE_KEY store), keyed by each row's cursor:/codex: id and
   *  its current activity mtime so a re-created chat with the same id would auto-unhide
   *  on fresh activity. A no-op when the bucket is empty. */
  async hideOrphans(): Promise<void> {
    if (this.orphanNode === undefined) return;
    const records = { ...this.hiddenMap() };
    const now = Date.now();
    for (const c of this.orphanNode.cursors) records["cursor:" + c.row.chatId] = { mtime: c.row.updatedMs, hideAt: now };
    for (const x of this.orphanNode.codexes) records["codex:" + x.row.id] = { mtime: x.row.updatedMs, hideAt: now };
    await this.state.update(HIDE_KEY, capNewest(records, MAX_HIDDEN, (r) => r.hideAt));
    this.signature = "";
    this.reload();
  }

  async unhide(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const records = { ...this.hiddenMap() };
    for (const k of keys) delete records[k];
    await this.state.update(HIDE_KEY, records);
    this.signature = "";
    this.reload();
  }

  async unhideAll(): Promise<void> {
    await this.state.update(HIDE_KEY, {});
    this.signature = "";
    this.reload();
  }

  /** Currently-hidden rows for the Show-Hidden picker: real title when the session
   *  is still present this reload, else a key-derived label, plus how long ago it
   *  was hidden. Sorted by label. */
  hiddenList(): { key: string; label: string; description: string }[] {
    const records = this.hiddenMap();
    const now = Date.now();
    return Object.entries(records)
      .map(([key, rec]) => {
        const present = this.hiddenPresent.get(key);
        return {
          key,
          label: present?.title ?? hiddenKeyLabel(key),
          description: hiddenDescription(rec, now),
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Number of hidden rows that matched a present session this reload — the count
   *  shown in the "N hidden" note (0 when nothing hidden is currently present). */
  get hiddenPresentCount(): number {
    return this.hiddenPresent.size;
  }

  /** True while a hidden row's activity has NOT advanced past its hide-time mtime;
   *  a woken row (new activity) is auto-unhidden (recorded for the end-of-reload
   *  flush) and returns false. Tracks present-hidden rows for the picker/note. */
  private isHiddenNow(key: string, currentMtime: number, title: () => string, ageSec: number): boolean {
    const decision = hideDecision(this.hidden[key], currentMtime);
    if (decision === "visible") return false;
    if (decision === "unhide") {
      this.pendingUnhide.add(key);
      return false;
    }
    this.hiddenPresent.set(key, { title: title(), ageSec });
    return true;
  }

  /** Refresh present pins' vanish-clock to their newest activity, keep present
   *  pins unconditionally, and prune absent pins past the TTL. Writes back only on
   *  a real diff, so a pinned project at rest never writes on a quiet tick. */
  private reconcilePins(projects: readonly ProjectNode[]): void {
    const current = this.pins();
    if (Object.keys(current).length === 0) return;
    const present = new Map(projects.map((p) => [p.cwd, p]));
    const next: Record<string, number> = {};
    const absent: Record<string, number> = {};
    for (const [cwd, last] of Object.entries(current)) {
      const p = present.get(cwd);
      if (p === undefined) {
        absent[cwd] = last;
        continue;
      }
      next[cwd] = Math.max(
        last,
        ...p.sessions.map((s) => s.row.mtimeMs),
        ...p.cursors.map((c) => c.row.updatedMs),
        ...p.codexes.map((c) => c.row.updatedMs)
      );
    }
    Object.assign(next, prunePins(absent, Date.now() - PINHIDE_TTL_MS));
    // Compared with the map as STORED, so pins kept under an old drive-letter case
    // are rewritten once in the normalised form.
    if (stableJson(next) !== stableJson(this.storedPins())) saveQuietly(this.state, PIN_KEY, next);
  }

  /** Apply the auto-unhides earned this pass and prune vanished-and-stale hidden
   *  rows (present-hidden rows are kept — they're deliberately silenced), writing
   *  back only on a real diff so quiet ticks stay quiet. */
  private flushHidden(): void {
    let base: Record<string, HideRecord> = { ...this.hidden };
    for (const k of this.pendingUnhide) delete base[k];
    const kept: Record<string, HideRecord> = {};
    const vanished: Record<string, HideRecord> = {};
    for (const [k, rec] of Object.entries(base)) {
      if (this.hiddenPresent.has(k)) kept[k] = rec;
      else vanished[k] = rec;
    }
    Object.assign(kept, pruneHidden(vanished, Date.now() - PINHIDE_TTL_MS));
    if (stableJson(kept) !== stableJson(this.hidden)) saveQuietly(this.state, HIDE_KEY, kept);
  }

  private passesFilter(node: SessionNode): boolean {
    if (!this.isTypeVisible("claude")) return false;
    switch (this.filterMode) {
      case "all":
        return true;
      case "1h":
        return node.row.ageSec !== null && node.row.ageSec < 3600;
      case "24h":
        return node.row.ageSec !== null && node.row.ageSec < 86400;
      case "attention":
        return node.row.status === "working" || node.unread || node.attention;
    }
  }

  /** Cursor rows carry finished-unread (but no approval/question state), so the
   *  "attention" filter keeps working OR unread ones; age filters apply to their
   *  last activity. */
  private passesCursorNode(node: CursorNode): boolean {
    if (!this.isTypeVisible("cursor")) return false;
    switch (this.filterMode) {
      case "all":
        return true;
      case "1h":
        return node.row.ageSec < 3600;
      case "24h":
        return node.row.ageSec < 86400;
      case "attention":
        return node.row.status === "working" || node.unread;
    }
  }

  private passesComposerNode(node: ComposerNode): boolean {
    if (!this.isTypeVisible("cursor")) return false;
    switch (this.filterMode) {
      case "all": return true;
      case "1h": return node.row.ageSec < 3600;
      case "24h": return node.row.ageSec < 86400;
      case "attention": return node.row.status === "working" || node.unread;
    }
  }

  /** Codex rows filter exactly like Cursor rows (age windows; working OR unread
   *  under "attention"). */
  private passesCodexNode(node: CodexNode): boolean {
    if (!this.isTypeVisible("codex")) return false;
    switch (this.filterMode) {
      case "all":
        return true;
      case "1h":
        return node.row.ageSec < 3600;
      case "24h":
        return node.row.ageSec < 86400;
      case "attention":
        return node.row.status === "working" || node.unread;
    }
  }

  /** Age window (seconds) the active filter imposes on finished activity-tree
   *  children, or undefined when there is none (all / attention). */
  private childAgeWindow(): number | undefined {
    if (this.filterMode === "1h") return 3600;
    if (this.filterMode === "24h") return 86400;
    return undefined;
  }

  /** A finished workflow/agent child is hidden when it predates the active age
   *  window; running children always show. Under "attention", finished children
   *  are hidden entirely (nothing to attend to). */
  private childVisible(running: boolean, ageSec: number): boolean {
    if (running) return true;
    if (this.filterMode === "all") return true;
    if (this.filterMode === "attention") return false;
    const w = this.childAgeWindow();
    return w === undefined || ageSec < w;
  }

  /** Task visibility: pending/in_progress always show; other statuses follow the
   *  same age/attention rules as finished children. */
  private taskVisible(status: string, ageSec: number): boolean {
    if (status === "in_progress" || status === "pending") return true;
    if (this.filterMode === "all") return true;
    if (this.filterMode === "attention") return false;
    const w = this.childAgeWindow();
    return w === undefined || ageSec < w;
  }

  /** globalState key a SELF session's read-mark lives under. New format is
   *  `lastSeen.<hostId>∥<sessionId>`; in degraded mode (no selfHostId) it falls
   *  back to the old bare `lastSeen.<sessionId>` key. */
  private selfSeenKey(sessionId: string): string {
    const hid = this.selfHostId();
    return LAST_SEEN_PREFIX + (hid !== undefined ? hid + SEEN_SEP + sessionId : sessionId);
  }

  private lastSeen(sessionId: string): number {
    const hid = this.selfHostId();
    if (hid !== undefined) {
      const v = this.state.get<number>(LAST_SEEN_PREFIX + hid + SEEN_SEP + sessionId);
      if (v !== undefined) return v;
      // Migration: existing read state was stored under the old bare-sessionId
      // key — honor it so a host-id upgrade doesn't relight everything as unread.
      const old = this.state.get<number>(LAST_SEEN_PREFIX + sessionId);
      if (old !== undefined) return old;
    } else {
      const v = this.state.get<number>(LAST_SEEN_PREFIX + sessionId);
      if (v !== undefined) return v;
    }
    return this.state.get<number>(BASELINE_KEY) ?? 0;
  }

  /** globalState key a REMOTE session's read-mark lives under. */
  private remoteSeenKey(hostId: string, sessionId: string): string {
    return LAST_SEEN_PREFIX + hostId + SEEN_SEP + sessionId;
  }

  /** A remote attention session is unread until its last-activity instant (local
   *  clock: receivedAt − ageSec) has been marked read. Stable across heartbeats:
   *  a stuck approval's ageSec grows in lockstep with receivedAt, so the instant
   *  it references does not advance once marked. */
  private remoteUnread(snap: StoredHostSnapshot, s: BridgeSession): boolean {
    const lastActivityMs = snap.receivedAt - s.ageSec * 1000;
    const seen =
      this.state.get<number>(this.remoteSeenKey(snap.host.id, s.id)) ??
      this.state.get<number>(BASELINE_KEY) ??
      0;
    return lastActivityMs > seen;
  }

  /** Does a run's cwd still exist on disk? Cheap existsSync, memoized per reload (the
   *  map is cleared at the top of every pass) so an orphan check never restat's a cwd
   *  already seen this tick — no stat storm on a busy fleet. A run whose folder is
   *  gone AND whose process is dead is an orphan (see the cursor/codex loops). */
  private dirExists(cwd: string): boolean {
    const hit = this.cwdExists.get(cwd);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
      ok = existsSync(cwd);
    } catch {
      ok = false;
    }
    this.cwdExists.set(cwd, ok);
    return ok;
  }

  reload(homes: ConfigHome[] = this.homes, hint?: ReuseHint): void {
    this.homes = homes;
    // Hidden-session state for this pass: loaded once so the per-row check is a map
    // lookup. hiddenPresent (present-hidden rows) and pendingUnhide (rows whose
    // activity advanced past hide-time) are rebuilt every reload and flushed below.
    this.hidden = this.hiddenMap();
    this.hiddenPresent = new Map();
    this.pendingUnhide = new Set();
    // `hint` is passed ONLY by the 3s/fs-driven poll tick (extension.refresh): a
    // quiet tick reuses the cached snapshot, a dirty tick reclassifies just the
    // flagged sessions. Internal reloads (filter/sort/markRead/pin/hide) pass no
    // hint → a full pass, which is always correct and cheap enough for a one-off UI
    // action; it also refreshes the reuse cache the next poll tick builds on.
    const byProject = snapshot(homes, hint);
    const labels = new Set<string>();
    // Live/known local session ids for the end-of-reload carryover sweep. Collected
    // from the raw snapshot (before hide/filter), so a hidden-but-live session keeps
    // its pending-attention entry; only ids no longer on disk are pruned.
    const liveSessionIds = new Set<string>();
    for (const rows of byProject.values()) for (const r of rows) {
      labels.add(r.homeLabel);
      liveSessionIds.add(r.meta.sessionId);
    }
    this.multiHome = labels.size > 1;
    const labelSig = [...labels].join("\u0000");
    if (labelSig !== this.homeLabelsSig) {
      this.homeLabelsSig = labelSig;
      this.onHomeLabels([...labels]);
    }
    let unread = 0;
    // Per-reload cwd-existence memo (see dirExists): every unique cwd is stat'd at
    // most once per pass, so orphan detection adds no stat storm on a busy fleet.
    this.cwdExists.clear();
    // Orphaned cursor/codex runs (cwd deleted + process dead) collect here, out of any
    // project, and are shown under one collapsed global bucket. Never attention.
    const orphanCursors: CursorNode[] = [];
    const orphanCodexes: CodexNode[] = [];
    // Cursor Agent CLI sessions, grouped by cwd (empty when the setting is off).
    // Finished-unread: an idle chat whose last activity postdates the read-mark.
    const cursorByProject = new Map<string, CursorNode[]>();
    for (const row of this.cursorSessions()) {
      // Orphan: a dead run whose worktree was pruned — its cwd no longer exists.
      const orphan = !row.live && !this.dirExists(row.cwd);
      // Finished-unread ONLY for an interactive, in-place run: an external (headless
      // `agent -p`) run has no window to open, and an orphan's folder is gone — neither
      // may ever draw attention (the GOAL-A fix + orphan rule). This is the sole lever
      // that keeps machine/orphan cursor rows out of unread/badge/toast/triage.
      const isUnread =
        !row.external &&
        !orphan &&
        row.status === "idle" &&
        row.updatedMs > this.lastSeen("cursor:" + row.chatId);
      const node = new CursorNode(row, isUnread);
      // Demote an ENDED external run (dimmed, sorted last, non-clickable); an orphan is
      // always demoted regardless of provenance.
      node.orphan = orphan;
      node.demoted = orphan || (row.external && !row.live);
      // Hidden rows drop before the filter AND the unread count — a hidden session
      // is gone from tree, panel, badge, alerts and triage alike.
      if (this.isHiddenNow("cursor:" + row.chatId, row.updatedMs, () => row.name, row.ageSec)) continue;
      // The family-visibility + attention/age filter applies to orphans too (an orphan
      // never needs attention, so it drops under the "attention" filter; a hidden
      // cursor family hides its orphans; age filters bound it) — gate BEFORE bucketing.
      if (!this.passesCursorNode(node)) continue;
      if (orphan) {
        orphanCursors.push(node);
        continue;
      }
      if (isUnread) unread++;
      const key = normalizeDriveLetter(row.cwd);
      const list = cursorByProject.get(key) ?? [];
      list.push(node);
      cursorByProject.set(key, list);
    }
    const composerByProject = new Map<string, ComposerNode[]>();
    for (const row of this.composerSessions()) {
      const isUnread = row.unreadEligible && row.status === "idle" && row.updatedMs > this.lastSeen("composer:" + row.conversationId);
      const node = new ComposerNode(row, isUnread);
      if (this.isHiddenNow("composer:" + row.conversationId, row.updatedMs, () => row.name, row.ageSec)) continue;
      if (!this.passesComposerNode(node)) continue;
      // Composer unread is a row affordance only: no approval signal exists, so it
      // never contributes to the attention badge/status chip.
      const key = normalizeDriveLetter(row.cwd);
      const list = composerByProject.get(key) ?? [];
      list.push(node);
      composerByProject.set(key, list);
    }
    // Codex CLI sessions, grouped by cwd (empty when the setting is off).
    // Finished-unread: a session whose last turn completed (endedTurn) after the
    // read-mark — evidence-backed "produced a final message, not yet seen".
    const codexByProject = new Map<string, CodexNode[]>();
    for (const row of this.codexSessions()) {
      const orphan = !row.live && !this.dirExists(row.cwd);
      const isUnread =
        !orphan &&
        row.provenance === "interactive" &&
        row.endedTurn &&
        row.updatedMs > this.lastSeen("codex:" + row.id);
      const node = new CodexNode(row, isUnread);
      node.orphan = orphan;
      node.demoted = orphan || (row.external && !row.live);
      if (this.isHiddenNow("codex:" + row.id, row.updatedMs, () => row.name, row.ageSec)) continue;
      // Family + filter gate applies to orphans too (see the cursor loop) — gate first.
      if (!this.passesCodexNode(node)) continue;
      if (orphan) {
        orphanCodexes.push(node);
        continue;
      }
      if (isUnread) unread++;
      const key = normalizeDriveLetter(row.cwd);
      const list = codexByProject.get(key) ?? [];
      list.push(node);
      codexByProject.set(key, list);
    }
    // Recency sorts compare tiers and keep the last order within one (see
    // recencyTier), so two busy rows don't trade places every tick.
    const sortNow = Date.now();
    const rank = (n: Node): number => this.lastOrder.get(rowKey(n)) ?? -1;
    const byRecency = <T extends Node>(ms: (n: T) => number) => (a: T, b: T): number =>
      recencyTier(sortNow - ms(a)) - recencyTier(sortNow - ms(b)) || rank(a) - rank(b) || ms(b) - ms(a);
    // Union of cwds with Claude, Cursor and/or Codex sessions.
    const cwds = new Set<string>([...byProject.keys(), ...cursorByProject.keys(), ...codexByProject.keys(), ...composerByProject.keys()]);
    let projects: ProjectNode[] = [...cwds]
      .map((cwd) => {
        const nodes = (byProject.get(cwd) ?? [])
          .map((row) => {
            const sid = row.meta.sessionId;
            const attentionTs = this.attentionMap.get(sid);
            // main transcript advancing past the event means the tool was approved
            let attention = attentionTs !== undefined;
            if (attentionTs !== undefined && row.mainMtimeMs > attentionTs + 2000) {
              this.attentionMap.delete(sid);
              this.reasons.delete(sid); // reason lives and dies with the attention flag
              attention = false;
            }
            // Only an attention row carries a reason; a captured message may be absent.
            const reason = attention ? this.reasons.get(sid) : undefined;
            const isUnread = row.status === "waiting" && row.mtimeMs > this.lastSeen(sid);
            return new SessionNode(row, isUnread, attention, reason);
          })
          // Hidden rows drop before the filter AND the unread count, so a hidden
          // session vanishes from tree, panel, badge, alerts and triage together.
          .filter(
            (n) =>
              !this.isHiddenNow(
                "session:" + n.row.meta.sessionId,
                n.row.mtimeMs,
                () => this.titleWithFallback(n.row, n.row.meta.sessionId.slice(0, 8)),
                n.row.ageSec ?? 0
              ) && this.passesFilter(n)
          );
        for (const n of nodes) if (n.unread || n.attention) unread++;
        // attention first, then most recent activity (rows arrive mtime-sorted)
        if (this.sortMode === "name") {
          nodes.sort((a, b) => (a.row.meta.name ?? "").localeCompare(b.row.meta.name ?? ""));
        } else {
          const recent = byRecency<SessionNode>((n) => n.row.mtimeMs);
          nodes.sort((a, b) => Number(b.attention) - Number(a.attention) || recent(a, b));
        }
        const cursors = [...(cursorByProject.get(cwd) ?? [])];
        if (this.sortMode === "name") {
          cursors.sort((a, b) => a.row.name.localeCompare(b.row.name));
        } else {
          cursors.sort(byRecency<CursorNode>((n) => n.row.updatedMs));
        }
        const codexes = [...(codexByProject.get(cwd) ?? [])];
        if (this.sortMode === "name") {
          codexes.sort(
            (a, b) =>
              Number(a.demoted) - Number(b.demoted) || a.row.name.localeCompare(b.row.name)
          );
        } else {
          const recent = byRecency<CodexNode>((n) => n.row.updatedMs);
          codexes.sort((a, b) => Number(a.demoted) - Number(b.demoted) || recent(a, b));
        }
        const composers = [...(composerByProject.get(cwd) ?? [])];
        composers.sort(this.sortMode === "name" ? (a, b) => a.row.name.localeCompare(b.row.name) : byRecency<ComposerNode>((n) => n.row.updatedMs));
        return new ProjectNode(cwd, nodes, cursors, codexes, composers);
      })
      .filter((p) => p.sessions.length > 0 || p.cursors.length > 0 || p.codexes.length > 0 || p.composers.length > 0);

    // Fold codex runs confidently linked (live /proc ancestor) to a Claude session:
    // move them UNDER that session's row, out of their project's flat codex list. The
    // link is pid-based, so a run may move to the father's project even if its own cwd
    // differed. Ended/unlinked runs keep today's project-level placement (conservative).
    const sessionByPid = new Map<number, SessionNode>();
    for (const p of projects) {
      for (const s of p.sessions) {
        if (s.row.meta.pid > 0 && !sessionByPid.has(s.row.meta.pid)) {
          sessionByPid.set(s.row.meta.pid, s);
        }
      }
    }
    if (sessionByPid.size > 0) {
      for (const p of projects) {
        const keep: CodexNode[] = [];
        for (const cn of p.codexes) {
          const father =
            cn.row.parentClaudePid !== undefined
              ? sessionByPid.get(cn.row.parentClaudePid)
              : undefined;
          if (father !== undefined) father.codexChildren.push(cn);
          else keep.push(cn);
        }
        p.codexes.length = 0;
        p.codexes.push(...keep);
        // Same fold for headless cursor runs: a LIVE `agent -p` run with a confident
        // Claude ancestor moves under the father session's row. Ended/interactive runs
        // keep their project placement (parentClaudePid is undefined for them).
        const keepCursors: CursorNode[] = [];
        for (const cn of p.cursors) {
          const father =
            cn.row.parentClaudePid !== undefined
              ? sessionByPid.get(cn.row.parentClaudePid)
              : undefined;
          if (father !== undefined) father.cursorChildren.push(cn);
          else keepCursors.push(cn);
        }
        p.cursors.length = 0;
        p.cursors.push(...keepCursors);
      }
      for (const s of sessionByPid.values()) {
        s.codexChildren.sort(byRecency<CodexNode>((n) => n.row.updatedMs));
        s.cursorChildren.sort(byRecency<CursorNode>((n) => n.row.updatedMs));
      }
    }
    // The one global orphan bucket (cursor + codex runs whose folder was deleted).
    // Newest first within each kind; rebuilt every reload, undefined when empty.
    orphanCursors.sort(byRecency<CursorNode>((n) => n.row.updatedMs));
    orphanCodexes.sort(byRecency<CodexNode>((n) => n.row.updatedMs));
    this.orphanNode =
      orphanCursors.length > 0 || orphanCodexes.length > 0
        ? new OrphanNode(orphanCursors, orphanCodexes)
        : undefined;
    // A project can be emptied by folding its only codex rows elsewhere — drop empties.
    const foldedProjects = projects.filter(
      (p) => p.sessions.length > 0 || p.cursors.length > 0 || p.codexes.length > 0
    );
    projects = foldedProjects;

    if (this.sortMode === "name") {
      projects.sort((a, b) => compareProjectNames(a.cwd, b.cwd));
    } else {
      const newest = (p: ProjectNode): number =>
        Math.max(
          ...p.sessions.map((s) => s.row.mtimeMs),
          ...p.cursors.map((c) => c.row.updatedMs),
          ...p.codexes.map((c) => c.row.updatedMs),
          Number.NEGATIVE_INFINITY
        );
      // Base order for both "activity" and "heat": most-recent activity first.
      projects.sort(byRecency<ProjectNode>(newest));
      if (this.sortMode === "heat") {
        // Layer attention-pressure on top: highest heat floats up, and because
        // Array.sort is stable, equal scores keep the recency order established
        // above. Scores are minute-granular (projectHeatConstituents), so a quiet
        // 3s tick can't reorder projects and the change-signature stays identical.
        const heatNow = Date.now();
        const heat = (p: ProjectNode): number => fleetHeatScore(projectHeatConstituents(p, heatNow));
        projects.sort((a, b) => heat(b) - heat(a));
      }
    }

    // Pinned projects float above ALL sort modes. partitionPinned is a stable
    // pass, so the pinned block keeps the active sort (name/activity/heat) among
    // themselves and so does the unpinned tail. Pin membership is user-driven and
    // stable across quiet ticks, so this never churns the change-signature.
    const pinned = this.pins();
    if (Object.keys(pinned).length > 0) {
      projects.splice(0, projects.length, ...partitionPinned(projects, (p) => pinned[p.cwd] !== undefined));
    }
    // Pin bookkeeping: refresh each present pin's last-activity, prune pins whose
    // project has been gone > TTL, and persist ONLY on a real change (never a quiet
    // tick — a pinned project at rest re-derives the same timestamp).
    this.reconcilePins(projects);
    // Flush hidden state: apply auto-unhides earned this pass + prune vanished
    // rows, persisting only when the map actually changed (again, never a quiet
    // tick — nothing advances past hide-time and nothing crosses the TTL).
    this.flushHidden();

    // ---- License / free-tier enforcement (light, never destructive) ---------
    // Resolve the licensing state (OFFLINE — no network), then, when FREE and over
    // the caps, dim the rows beyond the caps and exclude them from unread/badge.
    // Remote hosts never count toward the caps (v1), so this runs on local projects
    // only, before the remote loop. Subagents/workflow children never count.
    const licenseNow = Date.now();
    const trialStart = trialOrigin(this.state, licenseNow);
    const lstate = licenseState(this.licenseKey(), licenseNow, trialStart);
    this.currentLicenseState = lstate;
    const free = lstate === "free";

    // Total top-level local sessions (Claude + Cursor + Codex + Composer; children
    // and remote hosts never count). The free tier covers the first FREE_MAX_SESSIONS
    // of these; the trigger is simply "more sessions than the free tier covers".
    let total = 0;
    for (const p of projects)
      total += p.sessions.length + p.cursors.length + p.codexes.length + p.composers.length;
    const overLimit = isOverFreeLimit(total);
    this.freeTierOverLimit = free && overLimit;

    // Default: nothing locked, everything covered.
    let covered = total;
    this.licenseNote = undefined;

    if (free && overLimit) {
      // Rank all top-level sessions ACTIVE-first (the sessions you're interacting with
      // hold the free slots), then by recency. A Claude row is active while working,
      // blocked on a question, or on an approval prompt; Cursor/Codex/Composer while
      // working.
      const freeSessions: FreeSession[] = [];
      for (const p of projects) {
        for (const s of p.sessions)
          freeSessions.push({
            key: "session:" + s.row.meta.sessionId,
            active: s.row.status === "working" || s.row.pendingQuestion === true || s.attention,
            recencyMs: s.row.mtimeMs,
          });
        for (const c of p.cursors)
          freeSessions.push({ key: "cursor:" + c.row.chatId, active: c.row.status === "working", recencyMs: c.row.updatedMs });
        for (const x of p.codexes)
          freeSessions.push({ key: "codex:" + x.row.id, active: x.row.status === "working", recencyMs: x.row.updatedMs });
        for (const m of p.composers)
          freeSessions.push({ key: "composer:" + m.row.conversationId, active: m.row.status === "working", recencyMs: m.row.updatedMs });
      }
      const coverage = selectFreeTierCoverage(freeSessions);
      covered = coverage.coveredRows;
      // Mark locked nodes and roll back the unread they contributed (a locked row is
      // excluded from unread/badge/chip; alerts + triage skip it via node.dimmed).
      for (const p of projects) {
        for (const s of p.sessions) {
          if (coverage.dimmed.has("session:" + s.row.meta.sessionId)) {
            s.dimmed = true;
            if (s.unread || s.attention) unread--;
          }
        }
        for (const c of p.cursors) {
          if (coverage.dimmed.has("cursor:" + c.row.chatId)) {
            c.dimmed = true;
            if (c.unread) unread--;
          }
        }
        for (const x of p.codexes) {
          if (coverage.dimmed.has("codex:" + x.row.id)) {
            x.dimmed = true;
            if (x.unread) unread--;
          }
        }
        for (const m of p.composers) {
          if (coverage.dimmed.has("composer:" + m.row.conversationId)) {
            m.dimmed = true;
            if (m.unread) unread--;
          }
        }
      }
      // The bottom-of-tree note only when sessions are actually locked.
      if (coverage.dimmed.size > 0) this.licenseNote = { covered, total };
    }
    this.licenseCovered = covered;
    this.licenseTotal = total;

    // Same-path collision detection (observe-only). Run HERE — after the hidden
    // filter and after free-tier locking — so the input is the VISIBLE, NON-LOCKED
    // local session set. A free-tier-LOCKED session shows no data at all (it renders
    // as a placeholder), so it must not appear in ANY collision metadata: it neither
    // gets a glyph nor leaks its path/title into a covered peer's hover, and never
    // inflates the summary note. Hidden rows are absent from `projects` entirely, so a
    // hidden session likewise can never collide or leak.
    {
      const visibleNodes: SessionNode[] = [];
      for (const p of projects) for (const s of p.sessions) if (!s.dimmed) visibleNodes.push(s);
      const collisions = detectCollisions(
        visibleNodes.map((s) => ({ sessionId: s.row.meta.sessionId, pendingEditPath: s.row.pendingEditPath }))
      );
      const titleById = new Map<string, string>();
      for (const s of visibleNodes) {
        titleById.set(
          s.row.meta.sessionId,
          this.titleWithFallback(s.row, s.row.meta.name ?? s.row.meta.sessionId.slice(0, 8))
        );
      }
      this.collisions = new Map();
      for (const [id, info] of collisionsBySession(collisions)) {
        this.collisions.set(id, {
          path: info.path,
          otherLabels: info.others.map((o) => titleById.get(o) ?? o.slice(0, 8)),
        });
      }
      this.collisionNote = collisionNoteText(collisions);
    }

    // Remote hosts: one HostNode per non-self snapshot within the 24h window,
    // appended after the self projects. Staleness is derived only from receivedAt
    // vs the local clock (remote clocks are never trusted). Live-host attention
    // sessions feed the same unreadCount seam extension.ts already reads.
    const now = Date.now();
    const selfId = this.selfHostId();
    const hostNodes: HostNode[] = [];
    const remoteHosts = this.remoteHosts();
    // Live remote-session keys (hostId∥sessionId) across every known snapshot — the
    // ground-truth set the remotePreviewToken maps sweep against below. Built from all
    // remoteHosts (not just the rendered ones) so an open preview on a momentarily
    // skipped host keeps its token; only sessions gone from the snapshots are pruned.
    const liveRemoteKeys = new Set<string>();
    for (const snap of remoteHosts) for (const s of snap.sessions) liveRemoteKeys.add(snap.host.id + SEEN_SEP + s.id);
    for (const snap of remoteHosts) {
      if (selfId !== undefined && snap.host.id === selfId) continue; // never self
      const sinceMs = now - snap.receivedAt;
      if (sinceMs > STALE_MS) continue; // >24h → hidden (double-guard)
      const stale = sinceMs > LIVE_MS;
      const elapsedSec = Math.max(0, sinceMs / 1000);
      const byCwd = new Map<string, RemoteSessionNode[]>();
      const seenIds = new Set<string>();
      for (const s of snap.sessions) {
        if (!this.isTypeVisible(s.tool as AgentFamily)) continue;
        // Same-id guard, mirroring snapshot()'s: a peer on an older build can still
        // publish one session twice (two live registrations of it, under two cwds).
        // Both rows would take the id `remote-session:<host>:<id>`, and VS Code
        // rejects the repeat — "Element with id … is already registered" — killing
        // the whole view, so the repeat drops here rather than trusting every
        // publisher to be fixed. Dropping before the bump below also stops one
        // session counting twice toward unread.
        if (seenIds.has(s.id)) continue;
        seenIds.add(s.id);
        const rUnread = !stale && s.attention === true && this.remoteUnread(snap, s);
        if (rUnread) unread++;
        const node = new RemoteSessionNode(snap.host.id, s, s.ageSec + elapsedSec, rUnread, stale);
        // Grouped by the drive-normalised cwd; the session keeps its raw cwd, which
        // is what a focus or stop action carries back to its host.
        const key = normalizeDriveLetter(s.cwd);
        const list = byCwd.get(key) ?? [];
        list.push(node);
        byCwd.set(key, list);
      }
      const rprojects = [...byCwd.entries()]
        .map(([cwd, sessions]) => {
          if (this.sortMode === "name") {
            sessions.sort((a, b) => (a.session.title ?? a.session.id).localeCompare(b.session.title ?? b.session.id));
          } else {
            // most recently active first, by tier (as the local rows)
            sessions.sort(
              (a, b) => recencyTier(a.ageSec * 1000) - recencyTier(b.ageSec * 1000) || rank(a) - rank(b) || a.ageSec - b.ageSec
            );
          }
          return new RemoteProjectNode(snap.host.id, cwd, sessions);
        })
        .sort((a, b) =>
          this.sortMode === "name"
            ? compareProjectNames(a.cwd, b.cwd)
            : recencyTier(Math.min(...a.sessions.map((s) => s.ageSec)) * 1000) -
                recencyTier(Math.min(...b.sessions.map((s) => s.ageSec)) * 1000) ||
              rank(a) - rank(b) ||
              Math.min(...a.sessions.map((s) => s.ageSec)) - Math.min(...b.sessions.map((s) => s.ageSec))
        );
      hostNodes.push(new HostNode(snap, stale, Math.round(sinceMs / 1000), rprojects));
    }
    // Sort hosts by display label (remoteHosts() already does, double-guard).
    hostNodes.sort((a, b) => hostDisplayLabel(a.snapshot.host).localeCompare(hostDisplayLabel(b.snapshot.host)));
    this.hostNodes = hostNodes;

    // Degraded-capability note (meta): shown only over a non-empty tree, only in
    // the "all" filter, and never entering unread/triage/alerts. Selected from the
    // injected live probes (reused, never re-scanned); its kind rides the signature
    // below (it changes rarely, so it can't churn quiet ticks).
    this.capabilityNote = selectCapabilityNote({
      ...this.capabilityInput(),
      hasSessions: projects.length > 0,
      filterAll: this.filterMode === "all",
    });

    // ---- Git worktree grouping (Goal A) -------------------------------------
    // Nest each linked-worktree project under its main repo's row. `projects` stays
    // FLAT (every consumer above already ran over it); this only derives the grouped
    // top level and stamps `branch`/`worktrees` for rendering. worktreeInfo is cached
    // by the `.git`/HEAD mtimes, so a quiet tick is stats-only.
    const topProjects = this.groupWorktrees(projects);

    // Change-signature, which gates the panel/bridge rebuild (changeSignature): it
    // carries every status / structure field that must repaint immediately, but
    // ages ride ageBucket (not fmtAge) so a sub-minute session's per-tick "Ns"
    // drift can't force a rebuild every 3s. Sub-minute ages shown may lag a
    // bucket; statuses never do.
    const sig = JSON.stringify([
      this.sortMode,
      this.filterMode,
      this.hiddenAgentTypes,
      this.multiHome,
      // Worktree topology: which rows nest under which main repo, plus each
      // worktree's branch. Changes only when a worktree appears/vanishes or switches
      // branch (worktreeInfo is mtime-cached), so it repaints those moves without
      // churning a quiet tick. Synthetic parents ride here too (they carry no
      // sessions, so nothing else in the signature would otherwise reflect them).
      topProjects.map((p) => [
        p.cwd,
        p.synthetic,
        p.worktrees.map((w) => [w.cwd, w.branch ?? ""]),
      ]),
      // Density rides the signature so a flip repaints; it changes only on the
      // config toggle (never a quiet tick), so it can't churn. The compact
      // descriptions themselves ride the per-session status/age fields folded below.
      this.density(),
      // Layout rides the signature so a list↔columns flip repaints every session
      // description (and toggles the panel grid); like density it only moves on the
      // config toggle, never a quiet tick.
      this.layout(),
      // Capability-note presence/kind: changes rarely (install/remove hooks, bridge
      // coming/going), so it's a real repaint worth firing but never a quiet-tick
      // churn source.
      this.capabilityNote?.kind ?? "",
      // Needs-you inbox: presence + membership + ORDER, as the ranked triage-id list.
      // The other fields fold membership indirectly (attention/unread/status/age), but
      // NOT the intra-tier onset order — two same-tier rows in one age bucket can swap
      // by onset with no other field moving. Fold the explicit ranked order so a real
      // reorder repaints the inbox with zero lag. The id order is stable across
      // sub-bucket age drift (remote ages advance in lockstep, local onsets are fixed),
      // so a quiet 3s tick stays quiet — the bench quiet-fire counter holds at 1. Only
      // computed when the lane is on, so "off" is byte-for-byte today's signature.
      this.inboxLane() ? buildTriageSet(projects, hostNodes).map((t) => t.id).join(" ") : "",
      // Free-tier note + the exact set of dimmed rows. Both are stable across quiet
      // ticks (dimming is keyed on recency order + a rarely-crossed over-limit
      // boundary), so they never churn — but they repaint when a row enters/leaves
      // the excess set or the covered/total counts move.
      this.licenseNote !== undefined ? `${this.licenseNote.covered}/${this.licenseNote.total}` : "",
      projects
        .flatMap((p) => [
          ...p.sessions.filter((s) => s.dimmed).map((s) => "s:" + s.row.meta.sessionId),
          ...p.cursors.filter((c) => c.dimmed).map((c) => "c:" + c.row.chatId),
          ...p.codexes.filter((x) => x.dimmed).map((x) => "x:" + x.row.id),
        ])
        .sort()
        .join(" "),
      // Pinned cwds + hidden keys: user-driven and stable across quiet ticks, so
      // they never churn, but they DO repaint when another window pins/hides a row
      // whose position/glyph would otherwise look unchanged here. Keys only (pin
      // timestamps refresh silently), so a quiet-tick pin re-derive can't churn.
      Object.keys(this.pins()).sort().join(" "),
      Object.keys(this.hidden).sort().join(" "),
      this.hiddenPresent.size,
      ...hostNodes.map((h) => [
        h.snapshot.host.id,
        hostDisplayLabel(h.snapshot.host),
        h.stale,
        h.stale ? ageBucket(h.lastSeenSec) : "live",
        h.projects.map((p) => [
          p.cwd,
          p.sessions.map((s) => [
            s.session.id,
            s.session.title ?? "",
            s.session.status,
            ageBucket(s.ageSec),
            s.unread,
            (s.session.children ?? []).length,
          ]),
        ]),
      ]),
      ...projects.map((p) => [
        p.cwd,
        p.sessions.map((s) => [
          s.row.meta.sessionId,
          this.titleWithFallback(s.row, ""),
          s.row.status,
          s.row.pendingQuestion,
          s.unread,
          ageBucket(s.row.ageSec),
          s.row.activity.agents,
          s.row.activity.workflows,
          s.row.activity.workflowAgents,
          // currentTask feeds the hover independently of the caption (it renders
          // even on non-working rows and beyond the caption's 40-char clamp), so it
          // stays in the signature verbatim — stable across quiet ticks (moves only
          // on a task edit).
          s.row.activity.currentTask ?? "",
          // The "doing now" caption rides the signature as its RESOLVED value, not
          // the raw (currentTask, pendingToolName) pair. The caption PREFERS
          // currentTask, so a stable-task session in a fast tool loop (pendingToolName
          // flipping every call) would otherwise repaint for a caption that never
          // changed. Folding workingCaption(...) means only a change to the DISPLAYED
          // caption repaints; both sources are stable across quiet ticks, so no churn.
          // (pendingToolName still enters the signature via quietHint below.)
          workingCaption(
            statusKind({
              status: s.row.status,
              unread: s.unread,
              attention: s.attention,
              pendingQuestion: s.row.pendingQuestion,
            }),
            s.row.activity.currentTask,
            s.row.pendingToolName
          ) ?? "",
          // The quiet-too-long hint toggles the row description (adds "quiet Xm"),
          // so its onset is a real repaint worth firing. It is MINUTE-granular by
          // construction (Math.floor), so like the age bucket it changes at most
          // once per minute and never churns a quiet 3s tick.
          quietHint(
            statusKind({
              status: s.row.status,
              unread: s.unread,
              attention: s.attention,
              pendingQuestion: s.row.pendingQuestion,
            }),
            s.row.pendingToolName,
            s.row.ageSec
          ) ?? "",
          s.attention,
          // A changed blocked-reason is a real change (row description + hover
          // move); stable text is byte-identical across quiet ticks, so it can't
          // churn the signature. Question text likewise (now shown on the row too).
          s.reason ?? "",
          s.row.questionText ?? "",
          // The finished-unread "done" caption rides its RESOLVED value (like the
          // working caption), gated on the SAME `kind === "unread"` the render uses
          // (raw s.unread can be true on a blocked row, whose kind is attention/
          // question and which shows its reason glance instead). It is "" off the
          // unread bucket, and lastText only changes when the session WRITES — which
          // flips status through working and is captured by the `status` field above
          // — so an unread row at rest is byte-stable and this never churns.
          doneCaption(
            statusKind({
              status: s.row.status,
              unread: s.unread,
              attention: s.attention,
              pendingQuestion: s.row.pendingQuestion,
            }) === "unread",
            s.row.lastText
          ) ?? "",
          s.row.homeLabel,
          // The resolved model·mode·tokens hover line. Stable across quiet ticks
          // (fold usage only moves when the transcript WRITES — already a repaint via
          // `status`/age); repaints when a pending "…" total resolves to a number
          // (the scanner's onDone fires a refresh). "" when the feature is unwired.
          this.sessionUsageLine(s.row) ?? "",
          // Folded codex children ride the session's signature (they left p.codexes
          // below), so a folded run's name/status/age advance still repaints its
          // parent row. Includes name + demoted (the visible fields on a nested row).
          s.codexChildren.map((c) => [
            c.row.id,
            c.row.name,
            c.row.status,
            ageBucket(c.row.ageSec),
            c.row.pid ?? 0,
            c.demoted,
          ]),
          // Folded headless cursor children ride the father's signature too (they
          // left p.cursors), so a folded run's name/status/age advance repaints it.
          s.cursorChildren.map((c) => [
            c.row.chatId,
            c.row.name,
            c.row.status,
            ageBucket(c.row.ageSec),
            c.row.pid ?? 0,
            c.demoted,
          ]),
        ]),
        p.cursors.map((c) => [c.row.chatId, c.row.name, c.row.status, ageBucket(c.row.ageSec), c.row.pid ?? 0, c.unread, c.demoted]),
        // The codex "done" caption (last_agent_message) rides its resolved value: ""
        // off the unread bucket, stable while a finished row is at rest.
        p.codexes.map((c) => [c.row.id, c.row.name, c.row.status, ageBucket(c.row.ageSec), c.row.pid ?? 0, c.unread, doneCaption(c.unread, c.row.lastAgentMessage) ?? ""]),
        p.composers.map((c) => [c.row.conversationId, c.row.name, c.row.status, c.row.mode, c.row.isBackground, c.row.caption ?? "", ageBucket(c.row.ageSec), c.unread]),
      ]),
      // Orphan bucket: it lives OUTSIDE `projects`, so fold it explicitly or a run
      // entering/leaving/being dismissed from the bucket would never repaint.
      this.orphanNode !== undefined
        ? [
            this.orphanNode.cursors.map((c) => [c.row.chatId, c.row.name, ageBucket(c.row.ageSec)]),
            this.orphanNode.codexes.map((c) => [c.row.id, c.row.name, ageBucket(c.row.ageSec)]),
          ]
        : "",
    ]);
    // Carryover prune sweep: drop pre-parallel-phase map/set entries whose id is no
    // longer live, mirroring discovery.snapshot()'s prune of its own caches. These are
    // fed by hook events / preview clicks and otherwise only ever removed on a specific
    // event, so a session that vanishes without that event would leak an entry forever.
    pruneToLive(this.attentionMap, liveSessionIds, (id) => this.reasons.delete(id)); // reason dies with the attention flag
    this.tokenScanner?.prune(liveSessionIds); // drop pre-window scans for ended sessions
    // The reverse index is keyed by hostId∥sessionId directly; the forward map is keyed
    // by opaque token, so it's swept by reconstructing its ref's key.
    pruneToLive(this.remotePreviewTokenByKey, liveRemoteKeys);
    for (const [token, ref] of this.remotePreviewTokens)
      if (!liveRemoteKeys.has(ref.hostId + SEEN_SEP + ref.sessionId)) this.remotePreviewTokens.delete(token);

    pruneToLive(this.detailsMemo, liveSessionIds);

    this.unreadCount = unread;
    // The panel and the bridge snapshot gate on this (changeSignature); the tree no
    // longer does: it compares row by row (fireTreeChanges).
    this.signature = sig;
    this.keepRows(projects, topProjects);
    this.fireTreeChanges();
    this.openNeedsYouGroups();
  }

  /** The "Needs you" rows on screen and when that list last changed. */
  private inboxShown: { refIds: string[]; at: number } | undefined;
  /** Since when "Needs you" has been shown out of its urgency order (settleInbox). */
  private inboxReorderDueAt: number | undefined;
  /** Since when each row still shown in "Needs you" has stopped needing you. */
  private readonly inboxOutSince = new Map<string, number>();

  /** What "Needs you" shows this reload. A row entering it shows at once: that is
   *  the alert. A row that stops needing you stays until it has been out for
   *  SETTLE_MS, and a change of order waits until the list has been
   *  unchanged that long: every change of the list re-fetches the whole section
   *  and leaves its rows unclickable for a round trip, and a session that turns
   *  over every few seconds would otherwise do that on every tick. A row
   *  lingering after it stopped needing you is harmless: its own icon and text
   *  show its real state, and a click still opens it. A row whose session is gone
   *  leaves at once. */
  private settleInbox(desired: InboxRef<TriageNode>[], projects: ProjectNode[]): InboxRef<TriageNode>[] {
    const now = Date.now();
    const prev = this.inboxShown;
    const wanted = new Map(desired.map((r) => [r.refId, r]));
    const shownBefore = new Set(prev?.refIds ?? []);
    for (const id of [...this.inboxOutSince.keys()]) if (!shownBefore.has(id) || wanted.has(id)) this.inboxOutSince.delete(id);
    // Rows still shown that stopped needing you, with their current node, while
    // they are within the settle time and their session still exists.
    const lingering: InboxRef<TriageNode>[] = [];
    let leavingDue = false;
    for (const refId of prev?.refIds ?? []) {
      if (wanted.has(refId)) continue;
      const since = this.inboxOutSince.get(refId) ?? now;
      this.inboxOutSince.set(refId, since);
      const anchorId = refId.slice(INBOX_ID_PREFIX.length);
      const node = this.triageNodeById(anchorId, projects);
      if (node === undefined || now - since >= SETTLE_MS) {
        leavingDue = true;
        this.inboxOutSince.delete(refId);
      } else lingering.push({ refId, anchorId, node });
    }
    // Fresh order: by urgency, the lingering rows after the rows that need you.
    const rebuilt = [...desired, ...lingering];
    const asShown = (prev?.refIds ?? []).map((id) => wanted.get(id) ?? lingering.find((r) => r.refId === id)).filter((r): r is InboxRef<TriageNode> => r !== undefined);
    const entering = desired.some((r) => !shownBefore.has(r.refId));
    const sameOrder = rebuilt.length === asShown.length && rebuilt.every((r, k) => r.refId === asShown[k].refId);
    const settled = prev === undefined || now - prev.at >= SETTLE_MS;
    // When the shown order first stopped matching the order by urgency. An
    // arrival resets `prev.at` but not this, so rows that keep arriving less than
    // SETTLE_MS apart can't keep an earlier row out of its place.
    if (sameOrder) this.inboxReorderDueAt = undefined;
    else this.inboxReorderDueAt ??= now;
    const reorderDue = this.inboxReorderDueAt !== undefined && now - this.inboxReorderDueAt >= SETTLE_MS;
    // A row entering shows at once, but after the rows already shown: putting it
    // on top pushed every row down under the pointer, and an inline click landed
    // on the next row's Stop. It moves to its place by urgency once the list has
    // settled, within SETTLE_MS.
    const refs =
      prev === undefined || leavingDue || reorderDue
        ? rebuilt
        : entering
          ? [...asShown, ...desired.filter((r) => !shownBefore.has(r.refId))]
          : settled && !sameOrder
            ? rebuilt
            : asShown;
    if (refs === rebuilt) this.inboxReorderDueAt = undefined;
    const changed = prev === undefined || refs.length !== prev.refIds.length || refs.some((r, k) => r.refId !== prev.refIds[k]);
    this.inboxShown = { refIds: refs.map((r) => r.refId), at: changed || prev === undefined ? now : prev.at };
    return refs;
  }

  /** The current node for a triage id ("session:<id>", "remote:<host>:<id>", …). */
  private triageNodeById(id: string, projects: ProjectNode[]): TriageNode | undefined {
    for (const p of projects) {
      for (const s of p.sessions) if (`session:${s.row.meta.sessionId}` === id) return s;
      for (const c of p.cursors) if (`cursor:${c.row.chatId}` === id) return c;
      for (const x of p.codexes) if (`codex:${x.row.id}` === id) return x;
    }
    for (const h of this.hostNodes)
      for (const rp of h.projects) for (const s of rp.sessions) if (`remote:${s.hostId}:${s.session.id}` === id) return s;
    return undefined;
  }

  /** The root rows for this reload, from freshly built nodes, in display order. */
  private rootRows(topProjects: ProjectNode[], projects: ProjectNode[]): Node[] {
    const inbox: Node[] = [];
    if (this.inboxLane()) {
      const refs = this.settleInbox(buildInbox(buildTriageSet(projects, this.hostNodes), true), projects);
      if (refs.length > 0) inbox.push(new InboxNode(refs.map((r) => new InboxRefNode(r.refId, r.anchorId, r.node))));
    } else this.inboxShown = undefined;
    const all = this.filterMode === "all";
    return [
      // The needs-you inbox is the command center: first, above all project grouping.
      ...inbox,
      // topProjects is the worktree-grouped top level (worktree rows nest under their
      // main repo, synthetic parents included).
      ...topProjects,
      ...this.hostNodes,
      // The orphan bucket is a low-noise meta row after the projects and hosts.
      ...(this.orphanNode !== undefined ? [this.orphanNode] : []),
      // Then the meta notes, lowest priority last: capability, "N hidden" (only in
      // the "all" filter, so hidden rows are never silently lost), the free-tier
      // note, and the same-path collision note.
      ...(this.capabilityNote !== undefined ? [new CapabilityNoteNode(this.capabilityNote)] : []),
      ...(all && this.hiddenPresent.size > 0 ? [new HiddenNoteNode(this.hiddenPresent.size)] : []),
      ...(all && this.licenseNote !== undefined ? [new LicenseNoteNode(this.licenseNote.covered, this.licenseNote.total)] : []),
      ...(all && this.collisionNote !== undefined ? [new CollisionNoteNode(this.collisionNote)] : []),
    ];
  }

  /** Swap this reload's freshly built nodes for the row objects VS Code already
   *  holds: a row seen before keeps its object, updated in place with the new
   *  data, so the extension host's handle → element map stays valid across ticks.
   *  A second row with a key already taken in this render is dropped (two rows
   *  must never answer to one handle). */
  private keepRows(projects: ProjectNode[], topProjects: ProjectNode[]): void {
    const next = new Map<string, Node>();
    const keep = (fresh: Node): Node | undefined => {
      const key = rowKey(fresh);
      if (next.has(key)) return undefined;
      next.set(key, fresh);
      for (const field of KEPT_CHILDREN[fresh.kind] ?? []) {
        const list = (fresh as unknown as Record<string, Node[]>)[field];
        const kept = list.map(keep).filter((n): n is Node => n !== undefined);
        list.splice(0, list.length, ...kept);
      }
      const prev = this.rowCache.get(key);
      const row = prev !== undefined && prev.kind === fresh.kind ? Object.assign(prev, fresh) : fresh;
      next.set(key, row);
      return row;
    };
    this.rootChildren = this.rootRows(topProjects, projects)
      .map(keep)
      .filter((n): n is Node => n !== undefined);
    // An inbox reference points at the real row, which is kept further down.
    for (const n of next.values()) {
      if (n.kind !== "inbox-ref") continue;
      const target = next.get(rowKey(n.target));
      if (target !== undefined) (n as { target: Node }).target = target;
    }
    this.rowCache = next;
    for (const key of this.folded.keys()) if (!next.has(key)) this.folded.delete(key);
    for (const key of this.groupChangedAt.keys()) if (key !== ROOT_KEY && !next.has(key)) this.groupChangedAt.delete(key);
    for (const key of this.reorderSince.keys()) if (key !== ROOT_KEY && !next.has(key)) this.reorderSince.delete(key);
    // Ids are owned only by rows still on the list (a lazily built activity row
    // never holds one against another row, see uniqueItemId), so the map stays
    // the size of the tree between full redraws.
    for (const [id, owner] of this.idOwner) if (next.get(rowKey(owner)) !== owner) this.idOwner.delete(id);
    const kept = (p: ProjectNode): ProjectNode | undefined => {
      const n = next.get(rowKey(p));
      return n?.kind === "project" ? n : undefined;
    };
    this.projects = [...new Set(projects.map(kept).filter((p): p is ProjectNode => p !== undefined))];
    this.topProjects = this.rootChildren.filter((n): n is ProjectNode => n.kind === "project");
    this.hostNodes = this.rootChildren.filter((n): n is HostNode => n.kind === "host");
    this.orphanNode = this.rootChildren.find((n): n is OrphanNode => n.kind === "orphan");
  }

  /** The root rows' keys from the last reload, in order (see holdOrder). */
  private renderedRootKeys: string[] = [];
  /** When each group's rows (ROOT_KEY: the root's) last changed on screen. */
  private readonly groupChangedAt = new Map<string, number>();

  /** Keep a group's rows in their last order while its rows changed less than
   *  SETTLE_MS ago and the same rows are still there. A change of order alone
   *  re-fetches the group (at the root, the whole tree) and leaves its rows
   *  unclickable for a round trip, so rows that keep trading places (a session
   *  needing you, then not) would do that on every tick. The new order shows
   *  once the group has been unchanged that long, or with its next change of
   *  rows. Rows joining or leaving are never held. */
  private holdOrder(key: string, lists: Node[][], holdPending = true): void {
    const before = key === ROOT_KEY ? this.renderedRootKeys : this.rendered.get(key)?.childKeys;
    const now = lists.flat().map(rowKey);
    const pos = new Map((before ?? []).map((k, i) => [k, i]));
    if (before === undefined || before.length !== now.length || !now.every((k) => pos.has(k))) {
      this.reorderSince.delete(key);
      return;
    }
    if (now.every((k, i) => before[i] === k)) {
      this.reorderSince.delete(key);
      return;
    }
    // A change of order alone also waits SETTLE_MS from when it was first due,
    // even after a quiet spell: a row turning busy or needing you used to jump
    // to the top at once, at the moment the change drew the pointer, and an
    // inline click landed on another row. Its own line shows the change at once.
    const t = Date.now();
    const since = this.reorderSince.get(key) ?? t;
    this.reorderSince.set(key, since);
    const at = this.groupChangedAt.get(key);
    const changedLately = at !== undefined && t - at < SETTLE_MS;
    if (!changedLately && (!holdPending || t - since >= SETTLE_MS)) {
      this.reorderSince.delete(key);
      return;
    }
    for (const list of lists) list.sort((a, b) => (pos.get(rowKey(a)) ?? 0) - (pos.get(rowKey(b)) ?? 0));
  }
  /** Since when each group has wanted a new order it was not yet shown (holdOrder). */
  private readonly reorderSince = new Map<string, number>();

  /** The view folded or unfolded a row (TreeView.onDidCollapseElement /
   *  onDidExpandElement). The group's line switches between its two forms on
   *  the next tick (see groupOpen). */
  noteOpen(element: Node, open: boolean): void {
    if (!FOLDABLE_KINDS.has(element.kind)) return;
    this.folded.set(rowKey(element), !open);
  }

  /** Is this group open in the view? What the view did last (a fold or unfold, or
   *  a fetch of its rows) wins; until then, the state the row asks for. An open
   *  group's line leaves out its working/unread counts and its newest age: they
   *  change without its rows changing, and refreshing the line would make every
   *  row under it unclickable for a round trip, so they would go stale; the rows
   *  show them anyway. A folded group has no rows on screen to drop, so it shows
   *  the full summary and is refreshed whenever that changes. Guessing "open" for
   *  a folded group only shows less; it never shows something untrue. */
  private groupOpen(node: Node, requestedExpanded: boolean): boolean {
    const f = this.folded.get(rowKey(node));
    return f === undefined ? requestedExpanded : !f;
  }

  /** Tell VS Code which rows changed since the last reload, as narrowly as it can
   *  take it:
   *  - nothing visible changed: no event at all;
   *  - a row's own rendering changed: that row alone (the extension host re-reads
   *    it in place, every other row stays clickable). An open group's own line
   *    shows only facts that change with its rows (see groupOpen), so it changes
   *    together with them;
   *  - a group's children changed (added, removed, reordered, or re-keyed): that
   *    group (the host drops the group's children until the window fetches them
   *    again, so only that group's rows are briefly unclickable);
   *  - the root rows changed, or a view setting changed: the whole tree.
   *  Rows are compared through the same TreeItem VS Code is given, minus the hover,
   *  so a relative age that reads the same ("2m") is not a change. */
  private fireTreeChanges(): void {
    const now = new Map<string, RenderedRow>();
    const order = new Map<string, number>();
    const visit = (n: Node, parent: string | undefined, index: number): string => {
      const key = rowKey(n);
      order.set(key, index);
      const item = withSubMinuteAgesMasked(() => this.buildTreeItem(n));
      const id = item.id ?? key;
      // "Needs you" settles its own order (settleInbox); holding it here too
      // would double the wait.
      this.holdOrder(key, (KEPT_CHILDREN[n.kind] ?? []).map((f) => (n as unknown as Record<string, Node[]>)[f]), n.kind !== "inbox");
      const kept = keptChildren(n);
      const kids = kept.map((c, i) => visit(c, key, i)).join("\n") + "\n~" + this.activitySignature(n);
      now.set(key, { node: n, parent, id, sig: renderSignature(item), kids, childKeys: kept.map(rowKey) });
      return id;
    };
    this.holdOrder(ROOT_KEY, [this.rootChildren]);
    const rootIds = this.rootChildren.map((n, i) => visit(n, undefined, i)).join("\n");
    const rootKeys = this.rootChildren.map(rowKey);
    const prev = this.rendered;
    this.rendered = now;
    this.lastOrder = order;
    const full = this.fullRefreshDue || this.rootFetch.waiting || rootIds !== this.renderedRootIds;
    this.renderedRootIds = rootIds;
    this.renderedRootKeys = rootKeys;
    this.fullRefreshDue = false;
    if (full) {
      this.groupChangedAt.set(ROOT_KEY, Date.now());
      this.treeEvents.full++;
      this.emitter.fire(undefined);
      return;
    }
    const changed: string[] = [];
    if (!this.viewVisible) {
      // Hidden: never an element refresh (see setViewVisible).
      let any = false;
      for (const [key, r] of now) {
        const before = prev.get(key);
        if (before === undefined || before.kids !== r.kids || before.sig !== r.sig) any = true;
      }
      if (!any && prev.size === now.size) return;
      this.treeEvents.full++;
      this.emitter.fire(undefined);
      return;
    }
    for (const [key, r] of now) {
      const before = prev.get(key);
      // A new row has no element in VS Code yet: its group's children changed.
      if (before === undefined) continue;
      if (before.kids !== r.kids) this.groupChangedAt.set(key, Date.now());
      if (before.kids !== r.kids || before.sig !== r.sig) changed.push(key);
    }
    if (changed.length === 0) return;
    // A refreshed group re-fetches everything under it, so name only the topmost.
    const named = new Set(changed);
    const top = changed.filter((key) => {
      for (let p = now.get(key)?.parent; p !== undefined; p = now.get(p)?.parent) if (named.has(p)) return false;
      return true;
    });
    this.treeEvents.partial++;
    this.treeEvents.rows += top.length;
    this.emitter.fire(top.map((key) => now.get(key)!.node));
  }

  /** Build the worktree-grouped top level from the flat, already-sorted `projects`.
   *  Pure topology comes from planWorktreeGroups (format.ts); this stamps `branch` /
   *  `worktrees` onto the real nodes and synthesizes a bare main-repo parent when a
   *  worktree's main checkout has no sessions of its own. The flat `projects` array
   *  is never mutated except for these display-only fields, so every counting path
   *  above stays correct. */
  private groupWorktrees(projects: ProjectNode[]): ProjectNode[] {
    // Reset any prior grouping stamps (nodes are freshly built each reload, but be
    // defensive so a reused node can't carry a stale branch/child list).
    for (const p of projects) {
      p.branch = undefined;
      p.worktrees = [];
    }
    const lookup = (cwd: string): WorktreeLink | undefined => worktreeInfo(cwd);
    const plan = planWorktreeGroups(projects.map((p) => p.cwd), lookup);
    // Fast path: no worktrees present → the top level IS the flat list (identical
    // object order), so single-repo users pay only the cached stat sweep above.
    if (plan.every((g) => g.worktrees.length === 0)) return projects;
    const byCwd = new Map(projects.map((p) => [p.cwd, p]));
    const top: ProjectNode[] = [];
    for (const g of plan) {
      const parent = g.synthetic
        ? Object.assign(new ProjectNode(g.cwd, []), { synthetic: true })
        : byCwd.get(g.cwd);
      if (parent === undefined) continue; // unreachable (non-synthetic ⇒ real cwd)
      g.worktrees.forEach((wcwd, i) => {
        const wn = byCwd.get(wcwd);
        if (wn === undefined) return;
        wn.branch = g.branches[i];
        parent.worktrees.push(wn);
      });
      top.push(parent);
    }
    return top;
  }

  async markRead(node: SessionNode): Promise<void> {
    await this.state.update(this.selfSeenKey(node.row.meta.sessionId), node.row.mtimeMs);
    this.signature = ""; // force re-render on next reload
    this.reload();
  }

  /** Mark a Cursor Agent chat read up to its last activity (viewer-side state).
   *  Keyed `cursor:<chatId>` so it can never collide with a Claude session id. */
  async markCursorRead(node: CursorNode): Promise<void> {
    await this.state.update(this.selfSeenKey("cursor:" + node.row.chatId), node.row.updatedMs);
    this.signature = "";
    this.reload();
  }

  async markComposerRead(node: ComposerNode): Promise<void> {
    await this.state.update(this.selfSeenKey("composer:" + node.row.conversationId), node.row.updatedMs);
    this.signature = "";
    this.reload();
  }

  /** Mark a Codex session read up to its last activity. Keyed `codex:<id>`. */
  async markCodexRead(node: CodexNode): Promise<void> {
    await this.state.update(this.selfSeenKey("codex:" + node.row.id), node.row.updatedMs);
    this.signature = "";
    this.reload();
  }

  async markAllRead(): Promise<void> {
    for (const p of this.projects) {
      for (const s of p.sessions) {
        await this.state.update(this.selfSeenKey(s.row.meta.sessionId), s.row.mtimeMs);
      }
      for (const c of p.cursors) {
        await this.state.update(this.selfSeenKey("cursor:" + c.row.chatId), c.row.updatedMs);
      }
      for (const c of p.composers) {
        await this.state.update(this.selfSeenKey("composer:" + c.row.conversationId), c.row.updatedMs);
      }
      for (const c of p.codexes) {
        await this.state.update(this.selfSeenKey("codex:" + c.row.id), c.row.updatedMs);
      }
      // Folded codex runs left p.codexes for the session's children — mark them read
      // too so the self-seen mark advances uniformly across every codex row.
      for (const s of p.sessions) {
        for (const c of s.codexChildren) {
          await this.state.update(this.selfSeenKey("codex:" + c.row.id), c.row.updatedMs);
        }
      }
    }
    // Remote entries too (viewer-side state only): stamp each row's last-activity
    // instant so its attention no longer counts toward the badge.
    for (const h of this.hostNodes) {
      for (const p of h.projects) {
        for (const s of p.sessions) {
          const lastActivityMs = h.snapshot.receivedAt - s.session.ageSec * 1000;
          await this.state.update(this.remoteSeenKey(h.snapshot.host.id, s.session.id), lastActivityMs);
        }
      }
    }
    this.signature = "";
    this.reload();
  }

  /** Find a remote session by host + id for the last-message preview provider. */
  private findRemoteSession(
    hostId: string,
    sessionId: string
  ): { snap: StoredHostSnapshot; session: BridgeSession } | undefined {
    for (const snap of this.remoteHosts()) {
      if (snap.host.id !== hostId) continue;
      const session = snap.sessions.find((s) => s.id === sessionId);
      if (session !== undefined) return { snap, session };
    }
    return undefined;
  }

  /** token -> (hostId, sessionId) for a preview uri. A token (not the raw ids)
   *  rides in the query so an arbitrary session id can never affect the uri or be
   *  fs-interpreted; the readable name stays in the path for the tab title. */
  private readonly remotePreviewTokens = new Map<string, { hostId: string; sessionId: string }>();
  /** Reverse index `hostId∥sessionId` -> token so repeated clicks on the same
   *  remote session reuse one token: the map stays bounded by session count
   *  instead of growing per click. */
  private readonly remotePreviewTokenByKey = new Map<string, string>();
  private remotePreviewSeq = 0;

  /** Open a markdown preview of a remote session's in-memory lastText (the text is
   *  only ever rendered, never fs-touched — plan §8). */
  private async showRemotePreview(node: RemoteSessionNode): Promise<void> {
    const s = node.session;
    const name = s.title !== undefined && s.title.length > 0 ? s.title : s.id;
    const key = node.hostId + SEEN_SEP + s.id;
    let token = this.remotePreviewTokenByKey.get(key);
    if (token === undefined) {
      token = `t${this.remotePreviewSeq++}`;
      this.remotePreviewTokens.set(token, { hostId: node.hostId, sessionId: s.id });
      this.remotePreviewTokenByKey.set(key, token);
    }
    const uri = vscode.Uri.from({
      scheme: REMOTE_PREVIEW_SCHEME,
      // Uri.from takes the path as is: an encoded name showed as "%20" in the tab.
      path: previewDocPath(name, s.id.slice(0, 8)),
      query: token,
    });
    this.remotePreviewEmitter.fire(uri);
    await vscode.commands.executeCommand("markdown.showPreview", uri);
  }

  private remotePreviewContent(uri: vscode.Uri): string {
    const ref = this.remotePreviewTokens.get(uri.query);
    const found = ref !== undefined ? this.findRemoteSession(ref.hostId, ref.sessionId) : undefined;
    if (found === undefined) return "_Remote session is no longer available._";
    const { snap, session } = found;
    const header =
      `# ${session.title ?? session.id}\n\n` +
      `${hostDisplayLabel(snap.host)} · \`${session.cwd}\` · ${session.status}\n\n---\n\n`;
    return header + (session.lastText !== undefined && session.lastText !== "" ? session.lastText : "_No message text._");
  }

  /** Move the keyboard-triage cursor by dir (+1 next / −1 prev) over the CURRENT
   *  needs-you set (recomputed every call — state changes constantly) and return
   *  the row to reveal + open, or undefined when nothing needs you. Ordering and
   *  set membership come from the pure `buildTriageSet`; only the last-visited id
   *  is retained, falling back to the top/bottom when it has vanished. */
  triageAdvance(dir: 1 | -1): TriageTarget<TriageNode> | undefined {
    const set = buildTriageSet(this.projects, this.hostNodes);
    const idx = advanceTriageCursor(
      set.map((t) => t.id),
      this.lastTriageId,
      dir
    );
    if (idx === undefined) {
      this.lastTriageId = undefined;
      return undefined;
    }
    const target = set[idx];
    this.lastTriageId = target.id;
    return target;
  }

  /** Current needs-you ids in tree display order (same set + ids the keyboard
   *  triage cursor uses, so `needsYouIds().length === unreadCount`). Used by the
   *  focus-return digest to snapshot at defocus and diff at refocus. */
  needsYouIds(): string[] {
    return buildTriageSet(this.projects, this.hostNodes).map((t) => t.id);
  }

  // ---- Focus anchor (return-to-focus across re-sorts / triage) --------------

  /** The current focus anchor ref, or undefined (nothing focused yet). Read by
   *  the returnToFocus command in extension.ts. */
  get focusRef(): FocusRef | undefined {
    return this.focusAnchor;
  }

  /** Record the session just focused. The single setter every open/triage/click
   *  path funnels through; passing undefined restores/clears it, which is exactly
   *  triage's one-deep "back" (see extension.triageStep): after a triage jump
   *  replaced focus, the pre-jump ref is put back so returnToFocus returns the
   *  user to where they were, not to the triage target. NOT a history stack — a
   *  whole triage walk returns to the single pre-walk anchor (documented limit). */
  noteFocus(ref: FocusRef | undefined): void {
    this.focusAnchor = ref;
  }

  /** Re-resolve a focus ref to the CURRENT node by id (fresh lookup — never a
   *  stored node reference, which reload() would have replaced), or undefined when
   *  the session is gone. Reuses the existing per-kind find* methods + getParent
   *  chain, so the resolved node is directly revealable. */
  resolveFocus(ref: FocusRef): TriageNode | undefined {
    return resolveFocusRef<SessionNode, CursorNode, CodexNode, RemoteSessionNode>(ref, {
      session: (id) => this.findSession(id),
      cursor: (id) => this.findCursor(id),
      codex: (id) => this.findCodex(id),
      remote: (hostId, id) => this.findRemoteSessionNode(hostId, id),
    });
  }

  findSession(sessionId: string): SessionNode | undefined {
    for (const p of this.projects) {
      const hit = p.sessions.find((s) => s.row.meta.sessionId === sessionId);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /** Resolve the discovery state already known for a session into a pure document view. */
  sessionPropsView(node: SessionNode): SessionPropsView {
    const { row } = node;
    const fallback = row.meta.name ?? row.meta.sessionId.slice(0, 8);
    const kind = statusKind({
      status: row.status,
      unread: node.unread,
      attention: node.attention,
      pendingQuestion: row.pendingQuestion,
    });
    const why = node.attention
      ? `needs your approval${node.reason ? ` — ${sanitizeReason(node.reason)}` : ""}`
      : row.pendingQuestion
        ? "a question or plan is awaiting your answer"
        : row.status === "working"
          ? row.pendingToolName
            ? `a tool is running (${sanitizeReason(row.pendingToolName)})`
            : "actively working"
          : kind === "unread"
            ? "finished its last turn; output not yet seen"
            : row.status === "waiting"
              ? "finished, at rest"
              : "idle — no recent activity";
    const times = sessionTimeFacts(
      sessionBirthMs(row.meta, row.homeDir, row.mainMtimeMs),
      row.meta.startedAt
    );
    const details = sessionDetails(row.meta, row.homeDir, row.activity.newestMs);
    let model: string | undefined;
    let mode: string | undefined;
    let tokens: string | undefined;
    if (this.tokenScanner !== undefined && row.usage !== undefined && row.mainIno !== undefined) {
      const total = this.tokenScanner.sessionTotal(
        row.meta.sessionId,
        transcriptPath(row.meta, row.homeDir),
        row.usage,
        row.mainIno
      );
      model = total.model !== undefined ? shortModel(total.model) : undefined;
      if (total.ready) {
        mode = total.mode;
        tokens = formatUsage(total.usage);
      } else if (model !== undefined) {
        tokens = "…";
      }
    }
    const child = (a: AgentDetail) => ({
      label: sanitizeReason(a.label),
      state: a.running ? "running" : `idle · ${fmtAge(a.ageSec)} ago`,
      path: a.path,
    });

    return {
      title: sanitizeReason(this.titleWithFallback(row, fallback)),
      status: this.statusPhrase(node),
      why,
      host: row.homeLabel,
      surface: row.meta.entrypoint === "claude-vscode" ? "IDE" : "terminal",
      pid: row.meta.pid,
      model,
      mode,
      tokens,
      started: times.started,
      processStarted: times.process,
      lastActivity: `${fmtAge(row.ageSec)} ago`,
      cwd: row.meta.cwd,
      projectPath: `projects/${projectSlug(row.meta)}`,
      transcriptPath: transcriptPath(row.meta, row.homeDir),
      sessionId: row.meta.sessionId,
      agents: details.agents.map(child),
      workflows: details.workflows.map((workflow) => ({
        label: sanitizeReason(workflow.label),
        state: workflow.running
          ? `running · ${workflow.runningAgents} agent(s)`
          : `idle · ${fmtAge(workflow.ageSec)} ago`,
        path: workflow.path,
        agents: workflow.agents.map(child),
      })),
      tasks: details.tasks.map((task) => ({
        label: sanitizeReason(task.subject),
        state: task.status,
        path: task.path,
      })),
    };
  }

  /** Resolve a Codex row's already-known state into a pure document view. */
  codexPropsView(node: CodexNode): CodexPropsView {
    const { row } = node;
    const title = sanitizeReason(row.name || row.kind || row.id.slice(0, 8));
    const why = node.demoted
      ? "ended machine/agent run (demoted, non-interactive)"
      : row.status === "working"
        ? "actively working"
        : row.endedTurn
          ? "finished its last turn"
          : "idle — no recent activity";
    return {
      title,
      status: node.demoted ? "ended" : row.status,
      why,
      surface: "Codex CLI",
      kind: row.kind,
      provenance: row.provenance,
      demoted: node.demoted,
      external: row.external,
      live: row.live,
      model: row.model !== "" ? shortModel(row.model) : undefined,
      modelProvider: row.modelProvider !== "" ? row.modelProvider : undefined,
      originator: row.originator !== "" ? row.originator : undefined,
      cliVersion: row.cliVersion !== "" ? row.cliVersion : undefined,
      pid: row.pid,
      parentClaudePid: row.parentClaudePid,
      started: row.startedMs > 0 ? fmtClock(row.startedMs) : undefined,
      lastActivity: `${fmtAge(row.ageSec)} ago`,
      cwd: row.cwd,
      threadId: row.id,
      parentId: row.parentId !== "" ? row.parentId : undefined,
      subagentRole: row.subagentRole !== "" ? row.subagentRole : undefined,
      rolloutPath: row.rolloutPath,
    };
  }

  /** Resolve a Cursor Agent CLI row's already-known state into a pure document view. */
  cursorPropsView(node: CursorNode): CursorPropsView {
    const { row } = node;
    const why = node.orphan
      ? "orphaned — working folder deleted"
      : node.demoted
        ? "ended machine/agent run (demoted, non-interactive)"
        : row.status === "working"
          ? "actively working"
          : node.unread
            ? "finished; output not yet seen"
            : "idle — no recent activity";
    return {
      title: sanitizeReason(row.name || "cursor agent"),
      status: node.demoted ? "ended" : row.status,
      why,
      surface: "Cursor Agent CLI",
      mode: row.mode !== "" ? row.mode : undefined,
      external: row.external,
      demoted: node.demoted,
      orphan: node.orphan,
      live: row.live,
      pid: row.pid,
      parentClaudePid: row.parentClaudePid,
      lastActivity: `${fmtAge(row.ageSec)} ago`,
      cwd: row.cwd,
      chatId: row.chatId,
      dbPath: row.dbPath,
    };
  }

  /** Resolve a Cursor Composer row's already-known state into a pure document view. */
  composerPropsView(node: ComposerNode): ComposerPropsView {
    const { row } = node;
    const why = row.status === "working"
      ? "actively working"
      : node.unread
        ? "finished; output not yet seen"
        : "idle — no recent activity";
    return {
      title: sanitizeReason(row.name || "cursor composer"),
      status: row.status,
      why,
      surface: "Cursor Composer",
      mode: row.mode !== "" ? row.mode : undefined,
      background: row.isBackground,
      signal: row.caption !== undefined ? sanitizeReason(row.caption) : undefined,
      tokens: row.tokens !== undefined
        ? `in ${row.tokens.input} · out ${row.tokens.output} · cache r${row.tokens.cacheRead}/w${row.tokens.cacheWrite}`
        : undefined,
      lastActivity: `${fmtAge(row.ageSec)} ago`,
      cwd: row.cwd,
      conversationId: row.conversationId,
    };
  }

  findCursor(chatId: string): CursorNode | undefined {
    for (const p of this.projects) {
      const hit = p.cursors.find((c) => c.row.chatId === chatId);
      if (hit !== undefined) return hit;
      // Folded headless runs live under a session, not p.cursors — search there too
      // so id-based lookup (webview click, hide, focus restore) resolves a nested row.
      for (const s of p.sessions) {
        const child = s.cursorChildren.find((c) => c.row.chatId === chatId);
        if (child !== undefined) return child;
      }
    }
    // Orphaned runs live in the global bucket, outside every project — still addressable
    // so a table-view "hide" (dismiss) resolves them.
    return this.orphanNode?.cursors.find((c) => c.row.chatId === chatId);
  }

  findComposer(conversationId: string): ComposerNode | undefined {
    for (const p of this.projects) {
      const hit = p.composers.find((c) => c.row.conversationId === conversationId);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  findCodex(id: string): CodexNode | undefined {
    for (const p of this.projects) {
      const hit = p.codexes.find((c) => c.row.id === id);
      if (hit !== undefined) return hit;
      // Folded codex runs live under a session, not in p.codexes — search there too
      // so id-based lookup (focus restore, reveal) still resolves a nested row.
      for (const s of p.sessions) {
        const child = s.codexChildren.find((c) => c.row.id === id);
        if (child !== undefined) return child;
      }
    }
    // Orphaned runs live in the global bucket — still addressable for dismiss.
    return this.orphanNode?.codexes.find((c) => c.row.id === id);
  }

  /** Alert-detector input for LOCAL Claude sessions only (the in-window "needs
   *  you" toasts). Reuses the already-derived attention/pendingQuestion state and
   *  each blocking instance's onset ts, so alerts.ts never re-reads disk. */
  alertRows(): AlertRow[] {
    const rows: AlertRow[] = [];
    for (const p of this.projects) {
      for (const s of p.sessions) {
        if (s.dimmed) continue; // free-tier over-limit: no toast for excluded rows
        const sid = s.row.meta.sessionId;
        rows.push({
          sessionId: sid,
          label: this.titleWithFallback(s.row, s.row.meta.name ?? projectDisplayName(s.row.meta.cwd)),
          attention: s.attention,
          attentionTs: this.attentionMap.get(sid),
          reason: s.reason,
          pendingQuestion: s.row.pendingQuestion,
          questionTs: s.row.mainMtimeMs,
          questionText: s.row.questionText,
        });
      }
    }
    return rows;
  }

  /** Alert-detector input for LIVE remote sessions (cross-host "needs you" toasts).
   *  Emits one row per remote session currently known (every host within the 24h
   *  window, stale or live) so the tracker can keep an alerted session's mark alive
   *  through a stale flicker. The `live`/`attention` gate lives in
   *  `remoteCandidatesFrom`; the onset is the SAME heartbeat-stable last-activity
   *  instant the remote-unread predicate uses (`receivedAt − ageSec·1000`, from the
   *  publisher's original ageSec — not the node's elapsed-adjusted one). */
  remoteAlertRows(): RemoteAlertRow[] {
    const rows: RemoteAlertRow[] = [];
    for (const h of this.hostNodes) {
      for (const p of h.projects) {
        for (const node of p.sessions) {
          const s = node.session;
          rows.push({
            hostId: h.snapshot.host.id,
            sessionId: s.id,
            label: s.title !== undefined && s.title.length > 0 ? s.title : s.id.slice(0, 8),
            hostLabel: hostDisplayLabel(h.snapshot.host),
            live: !h.stale,
            attention: s.attention === true,
            onsetTs: h.snapshot.receivedAt - s.ageSec * 1000,
          });
        }
      }
    }
    return rows;
  }

  /** Resolve a live remote session row to its node, for the alert [Open] button —
   *  the same node a row click passes to `focusRemoteSession`. */
  findRemoteSessionNode(hostId: string, sessionId: string): RemoteSessionNode | undefined {
    for (const h of this.hostNodes) {
      for (const p of h.projects) {
        const hit = p.sessions.find((s) => s.hostId === hostId && s.session.id === sessionId);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  }

  /** Serialize the current tree into plain JSON for the floating webview panel.
   *  Reuses the same status/glyph/remote rules as the sidebar rows. `colorFor`
   *  maps an account label to a VS Code theme-color name for the account chip. */
  panelModel(colorFor: (label: string) => string | undefined): PanelModel {
    const activityTree = this.activityTree();
    const density = this.density();
    const compact = density === "compact";
    const projects: PanelProject[] = this.projects.map((p) => {
      const needsYou = this.projectNeedsYou(p);
      const total = p.sessions.length + p.cursors.length + p.codexes.length;
      // Free-tier LOCKED rows contribute NO activity metrics to the project header:
      // their working/unread state and age are hidden along with the row, so the
      // header counts and freshness are computed over covered (non-dimmed) rows only.
      const working =
        p.sessions.filter((s) => !s.dimmed && s.row.status === "working").length +
        p.cursors.filter((c) => !c.dimmed && c.row.status === "working").length +
        p.codexes.filter((c) => !c.dimmed && c.row.status === "working").length;
      const unread =
        p.sessions.filter((s) => !s.dimmed && s.unread).length +
        p.cursors.filter((c) => !c.dimmed && c.unread).length +
        p.codexes.filter((c) => !c.dimmed && c.unread).length;
      const newestAge = Math.min(
        ...p.sessions.filter((s) => !s.dimmed).map((s) => s.row.ageSec ?? Number.POSITIVE_INFINITY),
        ...p.cursors.filter((c) => !c.dimmed).map((c) => c.row.ageSec),
        ...p.codexes.filter((c) => !c.dimmed).map((c) => c.row.ageSec),
        Number.POSITIVE_INFINITY
      );
      let description: string;
      if (compact) {
        description = compactProjectDescription({
          needsYou,
          total,
          working,
          unread,
          newestAgeSec: Number.isFinite(newestAge) ? newestAge : null,
        });
      } else {
        const parts: string[] = [String(total)];
        if (working > 0) parts.push(`↻${working}`);
        if (unread > 0) parts.push(`●${unread}`);
        if (Number.isFinite(newestAge)) parts.push(fmtAge(newestAge));
        description = parts.join(" · ");
      }
      // Worktree fields for the flat webview table (minimal per the table-rework
      // seam): a "↳ <branch> · worktree of <mainRepoName>" caption. The TREE nests
      // these under their main repo; the panel/table stays flat for now.
      const wt = worktreeInfo(p.cwd);
      return {
        name: projectDisplayName(p.cwd),
        cwd: p.cwd,
        description,
        branch: wt?.branch,
        worktreeOf: wt !== undefined ? projectDisplayName(wt.mainRoot) : undefined,
        needsYou,
        pinned: this.isPinned(p.cwd),
        sessions: p.sessions.map((node) => this.panelSession(node, colorFor, activityTree)),
        cursors: p.cursors.map((node) => this.panelCursor(node)),
        codexes: p.codexes.map((node) => this.panelCodex(node)),
        composers: p.composers.map((node) => this.panelComposer(node)),
      };
    });
    // The orphan bucket surfaces in BOTH webviews as one synthetic, low-noise project
    // at the end — its rows are all demoted (dimmed, non-clickable), so the existing
    // project renderer shows them correctly with zero new webview code. Kept out of
    // needsYou/pin/worktree logic (a sentinel cwd is never pinned or a real worktree).
    if (this.orphanNode !== undefined) {
      const o = this.orphanNode;
      projects.push({
        name: "Orphaned runs (folder deleted)",
        cwd: ORPHAN_BUCKET_CWD,
        description: String(o.cursors.length + o.codexes.length),
        needsYou: 0,
        pinned: false,
        sessions: [],
        cursors: o.cursors.map((node) => this.panelCursor(node)),
        codexes: o.codexes.map((node) => this.panelCodex(node)),
        composers: [],
      });
    }
    // Remote host sections mirror the tree's HostNodes (plan §6); empty for
    // single-host users so the panel renders byte-identically then.
    const hosts: HostSection[] = this.hostNodes.map((h) => this.hostSection(h, activityTree, compact));
    return {
      multiHome: this.multiHome,
      activityTree,
      density,
      layout: this.layout(),
      inbox: this.panelInbox(colorFor),
      projects,
      hosts,
      capabilityNote: this.capabilityNote?.message,
      collisionNote: this.collisionNote,
    };
  }

  /** The needs-you inbox rows for the floating panel — the panel mirror of the tree
   *  inbox section (same triage membership + order). Each row reuses the underlying
   *  panel row's display fields and carries a navigation handle so a click routes to
   *  the SAME open command as the real row (local kinds only; remote rows stay
   *  read-only, as elsewhere in the panel). Empty when the lane is off or nothing
   *  needs you. Activity-tree children are never sourced here (flat command center). */
  private panelInbox(colorFor: (label: string) => string | undefined): PanelInboxRow[] {
    if (!this.inboxLane()) return [];
    return buildTriageSet(this.projects, this.hostNodes).map((t): PanelInboxRow => {
      const key = INBOX_ID_PREFIX + t.id;
      const node = t.node;
      if (node.kind === "session") {
        const p = this.panelSession(node, colorFor, false);
        return {
          key,
          kind: "session",
          title: p.title,
          statusKind: p.statusKind,
          columns: p.columns,
          description: p.description,
          icon: p.icon,
          iconColor: p.iconColor,
          spin: p.spin,
          hover: p.hover,
          sessionId: p.sessionId,
          ...(p.stoppable === true ? { stoppable: true as const } : {}),
          homeLabel: p.homeLabel,
          homeColor: p.homeColor,
          ...(p.outside === true ? { outside: true as const } : {}),
        };
      }
      if (node.kind === "cursor") {
        const p = this.panelCursor(node);
        return {
          key,
          kind: "cursor",
          title: p.title,
          statusKind: p.statusKind,
          columns: p.columns,
          description: p.description,
          icon: p.icon,
          iconColor: p.iconColor,
          spin: p.spin,
          brand: p.brand,
          hover: p.hover,
          chatId: p.chatId,
        };
      }
      if (node.kind === "codex") {
        const p = this.panelCodex(node);
        return {
          key,
          kind: "codex",
          title: p.title,
          statusKind: p.statusKind,
          columns: p.columns,
          description: p.description,
          icon: p.icon,
          iconColor: p.iconColor,
          spin: p.spin,
          brand: p.brand,
          hover: p.hover,
          ...(p.stoppable === true ? { stoppable: true as const } : {}),
          codexId: p.id,
          ...(p.outside === true ? { outside: true as const } : {}),
        };
      }
      const p = this.panelRemoteSession(node, false);
      return {
        key,
        kind: "remote",
        title: p.title,
        statusKind: p.statusKind,
        columns: p.columns,
        description: p.description,
        icon: p.icon,
        iconColor: p.iconColor,
        spin: p.spin,
        brand: p.brand,
        hover: p.hover,
      };
    });
  }

  /** Serialize one remote host into a panel section (read-only rows, all strings
   *  escaped by panel.ts at render). */
  private hostSection(node: HostNode, activityTree: boolean, compact: boolean): HostSection {
    const projects: PanelRemoteProject[] = node.projects.map((p) => {
      const needsYou = this.remoteProjectNeedsYou(p);
      const newestAge = Math.min(...p.sessions.map((s) => s.ageSec), Number.POSITIVE_INFINITY);
      let description: string;
      if (compact) {
        const working = p.sessions.filter((s) => !s.stale && s.session.status === "working").length;
        const unread = p.sessions.filter((s) => s.unread).length;
        description = compactProjectDescription({
          needsYou,
          total: p.sessions.length,
          working,
          unread,
          newestAgeSec: Number.isFinite(newestAge) ? newestAge : null,
        });
      } else {
        const parts: string[] = [String(p.sessions.length)];
        if (Number.isFinite(newestAge)) parts.push(fmtAge(newestAge));
        description = parts.join(" · ");
      }
      return {
        name: projectDisplayName(p.cwd),
        cwd: p.cwd,
        description,
        needsYou,
        sessions: p.sessions.map((s) => this.panelRemoteSession(s, activityTree)),
      };
    });
    const count = node.projects.reduce((n, p) => n + p.sessions.length, 0);
    const needsYou = projects.reduce((n, p) => n + p.needsYou, 0);
    const description = node.stale
      ? `${count} · last seen ${fmtAge(node.lastSeenSec)} ago`
      : String(count);
    return {
      hostId: node.snapshot.host.id,
      label: hostDisplayLabel(node.snapshot.host),
      description,
      stale: node.stale,
      needsYou,
      projects,
    };
  }

  private panelRemoteSession(node: RemoteSessionNode, activityTree: boolean): PanelRemoteSession {
    const s = node.session;
    const title = s.title !== undefined && s.title.length > 0 ? s.title : s.id.slice(0, 8);
    const v = this.remoteVisual(s, node.unread, node.stale);
    const running = (s.children ?? []).filter((c) => remoteChildRunning(c.status)).length;
    const parts: string[] = [fmtAge(node.ageSec)];
    if (running > 0) parts.push(`⚙${running}`);
    if (s.tool !== "claude") parts.push("❯");
    const children = activityTree ? (s.children ?? []).map((c) => this.panelRemoteChild(c, node.stale)) : [];
    const statusKind: StatusKind = s.attention === true
      ? "attention"
      : s.status === "working" && !node.stale
        ? "working"
        : "done";
    const status = statusKind === "attention" ? "needs approval" : statusKind === "working" ? "working" : "done";
    return {
      id: s.id,
      title,
      statusKind,
      columns: { time: fmtAge(node.ageSec), status, model: undefined, tokens: undefined },
      description: parts.join(" "),
      ...visual(v),
      hover: this.remoteHoverText(node),
      children,
      ...(s.outside === true && !node.stale ? { outside: true as const } : {}),
    };
  }

  private panelRemoteChild(c: BridgeChild, stale: boolean): PanelRemoteChild {
    const v = remoteChildVisual(c, stale);
    return {
      kind: c.kind,
      label: c.label,
      description: c.status ?? "",
      ...visual(v),
      hover: `${c.kind} · ${c.label}${c.status !== undefined ? ` · ${c.status}` : ""}`,
    };
  }

  /** Icon for a read-only remote session: Cursor/Codex brand marks, else the
   *  shared status icon (unknown/unrecognized statuses fall through to idle and
   *  never read as working — plan §6). A stale host is never drawn live: its rows
   *  never spin and a last-known "working" collapses to the idle bucket (the
   *  last-known status text still shows in the description/hover). */
  private remoteVisual(s: BridgeSession, unread: boolean, stale: boolean): IconVisual {
    if (s.tool === "cursor") return cursorVisual(!stale && s.status === "working");
    if (s.tool === "codex") return codexVisual(!stale && s.status === "working");
    const kind = statusKind({ status: s.status as SessionRow["status"], unread, attention: s.attention === true });
    const v = sessionVisual(stale && kind === "working" ? "idle" : kind, false);
    return stale ? { ...v, spin: false } : v;
  }

  /** Plain-text hover for a remote session row (tree tooltip + panel title). */
  private remoteHoverText(node: RemoteSessionNode): string {
    const s = node.session;
    const lines: string[] = [`${s.title ?? s.id} — ${s.status}`];
    lines.push(`${node.stale ? "last known" : "live"} · last activity ${fmtAge(node.ageSec)} ago`);
    if (s.lastText !== undefined && s.lastText !== "") {
      lines.push("—".repeat(3), s.lastText);
    }
    lines.push(s.cwd);
    return lines.join("\n");
  }

  private panelSession(
    node: SessionNode,
    colorFor: (label: string) => string | undefined,
    activityTree: boolean
  ): PanelSession {
    // Free-tier locked: emit ONLY the safe placeholder — no title/paths/metrics/
    // children/hover ever reach the webview (nor the bridge, which skips locked rows).
    if (node.dimmed) return lockedPanelSession();
    const { row } = node;
    const fallback = row.meta.name ?? row.meta.sessionId.slice(0, 8);
    const { title, isPrompt: titleIsPrompt } = this.titleWithFallbackTagged(row, fallback);
    const terminal = row.meta.entrypoint !== "claude-vscode";
    const flags = {
      status: row.status,
      unread: node.unread,
      attention: node.attention,
      pendingQuestion: row.pendingQuestion,
    };
    const orchestrating = row.activity.agents > 0 || row.activity.workflows > 0;
    const kind = statusKind(flags);
    const v = sessionVisual(kind, orchestrating);
    // "doing now" caption + quiet-too-long hint on a working row, or the "done"
    // caption on a finished-unread row — identical to the sidebar tree (shared
    // format.ts helpers). Mutually exclusive by status bucket.
    const trailing =
      workingTrailing(kind, row.activity.currentTask, row.pendingToolName, row.ageSec) ??
      doneCaption(kind === "unread", row.lastText);
    const collision = this.collisions.get(row.meta.sessionId);
    const outside = this.locationOf(row).location === "outside";
    const baseParts = [fmtAge(row.ageSec), ...glyphParts(row, terminal)];
    if (collision !== undefined) {
      baseParts.push(`⚠ same file (${sanitizeReason(collapseCollisionPath(collision.path), 56)})`);
    }
    const base = baseParts.join(" ");
    const description = trailing !== undefined ? `${base} · ${trailing}` : base;
    // Children are only sourced when the setting is on and the session has any —
    // the same lazy gate the tree uses, so no work is added to the default path.
    const children =
      activityTree && sessionHasDetails(row.meta, row.homeDir) ? this.panelChildren(node) : [];
    return {
      sessionId: row.meta.sessionId,
      title,
      statusKind: kind,
      statusPhrase: statusPhraseOf(flags),
      unread: node.unread,
      // A pending question carries attention to remote viewers too (the bridge
      // reads this field): status stays "waiting" via rawStatus, attention flags it
      // as needing an answer even though no local permission-hook fired.
      attention: node.attention || row.pendingQuestion,
      description,
      columns: this.sessionColumnFields(node),
      icon: v.icon,
      iconColor: v.color,
      spin: v.spin,
      stoppable: this.locationOf(row).location !== "unknown" ? true : undefined,
      terminal,
      outside: outside || undefined,
      homeLabel: row.homeLabel,
      homeColor: this.multiHome ? colorFor(row.homeLabel) : undefined,
      children,
      codexChildren: node.codexChildren.map((c) => this.panelCodex(c)),
      cursorChildren: node.cursorChildren.map((c) => this.panelCursor(c)),
      freeTier: node.dimmed,
      hover: this.panelHover(node, title, terminal),
      // Publisher-only raws for the bridge (plan §9): unformatted status/age/text,
      // so buildSnapshot never reverse-parses these rendered strings.
      rawStatus: row.status,
      rawAgeSec: row.ageSec ?? 0,
      rawLastText: row.lastText,
      // Prompt-fallback gate for the bridge: flag that title is user-prompt prose,
      // and carry the non-prompt stub so buildSnapshot can restore it when gated.
      titleIsPrompt,
      titleStub: titleIsPrompt ? fallback : undefined,
    };
  }

  /** Serialize a session's workflows/subagents/tasks (same source + order as the
   *  tree's lazy children) into the panel model. */
  private panelChildren(node: SessionNode): PanelChild[] {
    const { workflows, agents, tasks } = sessionDetails(
      node.row.meta,
      node.row.homeDir,
      node.row.activity.newestMs
    );
    const out: PanelChild[] = [];
    for (const w of workflows) {
      if (!this.childVisible(w.running, w.ageSec)) continue;
      const v = workflowVisual(w.running);
      const state = w.running ? `running · ${plural(w.runningAgents, "agent")}` : "done";
      out.push({
        kind: "workflow",
        label: `wf ${w.label}`,
        description: `${fmtAge(w.ageSec)} · ${state}`,
        ...visual(v),
        hover: childHover(`workflow ${w.id}`, w.path, [
          w.running ? `running · ${plural(w.runningAgents, "agent")}` : "done",
          `${plural(w.agents.length, "agent")} · last activity ${fmtAge(w.ageSec)} ago`,
        ]),
        children: w.agents.filter((a) => this.childVisible(a.running, a.ageSec)).map((a) => this.agentChild(a)),
      });
    }
    for (const a of agents) {
      if (!this.childVisible(a.running, a.ageSec)) continue;
      out.push(this.agentChild(a));
    }
    for (const t of tasks) {
      if (!this.taskVisible(t.status, t.ageSec)) continue;
      const v = taskVisual(t.status);
      let desc = "";
      if (t.status === "in_progress") desc = "active";
      else if (t.status !== "pending" && t.status !== "completed") desc = t.status;
      const lines = [`task ${t.id} · ${t.status.replace(/_/g, " ")}`];
      if (t.description !== undefined && t.description !== "") lines.push(t.description);
      out.push({
        kind: "task",
        label: t.subject,
        description: desc,
        ...visual(v),
        hover: childHover(t.subject, t.path, lines),
      });
    }
    return out;
  }

  private agentChild(a: AgentDetail): PanelChild {
    const v = agentVisual(a.running);
    const clause = this.agentUsageClause(a);
    // External-model attribution (Goal B): mirror the tree's agentItem badge so the
    // panel/table surface the wrapper's external CLI id honestly.
    const ext = externalModelFromLabel(a.label);
    return {
      kind: "agent",
      label: a.label,
      description: `${fmtAge(a.ageSec)} · ${a.running ? "running" : "done"}${clause !== undefined ? ` · ${clause}` : ""}`,
      ...visual(v),
      extModel: ext,
      hover: childHover(a.label, a.path, [
        a.running ? "running" : "done",
        `last activity ${fmtAge(a.ageSec)} ago`,
        ...(ext !== undefined ? [`external model: ${ext} (driven by this Claude subagent)`] : []),
        ...(clause !== undefined ? [clause] : []),
      ]),
    };
  }

  private panelCursor(node: CursorNode): PanelCursor {
    if (node.dimmed) return lockedPanelCursor();
    const { row } = node;
    const working = row.status === "working";
    const v = cursorVisual(working);
    const statusKind = terminalStatusKind(working, node.unread);
    const status = statusKind === "working" ? "working" : statusKind === "unread" ? "done, unread" : "done";
    return {
      chatId: row.chatId,
      title: row.name,
      statusKind,
      columns: { time: fmtAge(row.ageSec), status, model: undefined, tokens: undefined },
      description: `${node.unread ? "● " : ""}${fmtAge(row.ageSec)} ❯`,
      ...visual(v),
      unread: node.unread,
      hover: this.cursorHover(row),
      freeTier: node.dimmed,
      demoted: node.demoted,
      rawAgeSec: row.ageSec,
    };
  }

  private panelCodex(node: CodexNode): PanelCodex {
    if (node.dimmed) return lockedPanelCodex();
    const { row } = node;
    const working = row.status === "working";
    const v = codexVisual(working);
    const statusKind = terminalStatusKind(working, node.unread);
    const status = statusKind === "working" ? "working" : statusKind === "unread" ? "done, unread" : "done";
    const caption = doneCaption(node.unread, row.lastAgentMessage);
    const loc = node.demoted ? undefined : this.codexLocationOf(row);
    const outside = loc?.location === "outside";
    const hover = this.codexHover(row, outside);
    return {
      id: row.id,
      title: row.name,
      statusKind,
      stoppable: loc !== undefined && loc.location !== "unknown" ? true : undefined,
      columns: { time: fmtAge(row.ageSec), status, model: undefined, tokens: undefined },
      description: `${node.unread ? "● " : ""}${fmtAge(row.ageSec)} ❯${caption !== undefined ? ` · ${caption}` : ""}`,
      outside: outside || undefined,
      ...visual(v),
      unread: node.unread,
      hover: outside && loc !== undefined ? `${hover}\n${outsideSentence(loc)}` : hover,
      freeTier: node.dimmed,
      demoted: node.demoted,
      provenance: codexProvenanceLabel(row.subagentRole, row.kind),
      rawAgeSec: row.ageSec,
    };
  }

  private panelComposer(node: ComposerNode): PanelComposer {
    if (node.dimmed) return lockedPanelComposer();
    return panelComposerRow(node.row, node.unread, node.dimmed);
  }

  /** Plain-text hover for a Codex CLI session (name, kind, model provider, cwd,
   *  last activity, pid when live), shared by the tree tooltip and the panel row. */
  private codexHover(row: CodexRow, outside = false): string {
    const lines: string[] = [`${row.name} — ${row.kind} (${row.status})`];
    if (row.originator !== "") lines.push(`originator: ${row.originator}`);
    if (row.model !== "") lines.push(`model: ${shortModel(row.model)}`);
    if (row.modelProvider !== "") lines.push(`provider: ${row.modelProvider}`);
    lines.push(`${cliKindWord(outside)} · last activity ${fmtAge(row.ageSec)} ago`);
    if (row.startedMs > 0) lines.push(`started ${fmtClock(row.startedMs)}`);
    if (row.pid !== undefined) lines.push(`pid ${row.pid}`);
    lines.push(`session ${row.id}`);
    lines.push(row.cwd);
    return lines.join("\n");
  }

  /** Plain-text hover for a Cursor Agent CLI session (name, mode, cwd, last
   *  activity, pid when live), shared by the tree tooltip and the panel row. */
  private cursorHover(row: CursorRow): string {
    const lines: string[] = [`${row.name} — Cursor Agent (${row.status})`];
    if (row.mode !== "") lines.push(`mode: ${row.mode}`);
    lines.push(`terminal · last activity ${fmtAge(row.ageSec)} ago`);
    if (row.pid !== undefined) lines.push(`pid ${row.pid}`);
    lines.push(`chat ${row.chatId}`);
    lines.push(row.cwd);
    return lines.join("\n");
  }

  /** The compact "model · mode · tokens" line for a session hover, or undefined when
   *  the scanner is unwired or the row carries no fold bundle (no-transcript / remote).
   *  While the full-file total is still scanning it shows a single trailing "…" (never
   *  a fake number, and never a partial/stale mode — a mode change could sit before the
   *  window); the line is suppressed until there's something real to show. */
  private sessionUsageLine(row: SessionRow): string | undefined {
    const u = this.sessionUsage(row);
    const parts: string[] = [];
    if (u.model !== undefined) parts.push(u.model);
    if (u.mode !== undefined) parts.push(u.mode);
    if (u.tokens !== undefined) parts.push(u.tokens);
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }

  /** The resolved usage parts for a session, shared by the hover's "model · mode ·
   *  tokens" line and the columns-layout Model/Tokens cells. `tokens` is the single
   *  "…" placeholder while the whole-file scan is still in flight (only once a model
   *  is known — no partial number), the real formatted total once ready; `mode` is
   *  authoritative only when ready, so it is never shown mid-scan. Empty object when
   *  the scanner is unwired or the row carries no fold bundle (no-transcript/remote). */
  private sessionUsage(row: SessionRow): { model?: string; mode?: string; tokens?: string } {
    const scanner = this.tokenScanner;
    if (scanner === undefined || row.usage === undefined || row.mainIno === undefined) return {};
    const total = scanner.sessionTotal(
      row.meta.sessionId,
      transcriptPath(row.meta, row.homeDir),
      row.usage,
      row.mainIno
    );
    const model = total.model !== undefined ? shortModel(total.model) : undefined;
    if (total.ready) return { model, mode: total.mode, tokens: formatUsage(total.usage) };
    // Pending: "…" stands for "tokens still resolving" — only meaningful once a model
    // is known, and no partial mode (a mode change could sit before the scan window).
    return { model, tokens: model !== undefined ? "…" : undefined };
  }

  /** The four ordered column cells (time · status · model · tokens) for a session row
   *  in "columns" layout. Time carries the age plus the same dim glyphs (⚙N ❯) the
   *  list mode shows, so nothing is lost when columns take over the description; model
   *  and tokens come from the token scanner (undefined until resolved / when unwired).
   *  Shared by the sidebar tree's description and the panel grid so the two match. */
  private sessionColumnFields(node: SessionNode): SessionColumnFields {
    const { row } = node;
    const terminal = row.meta.entrypoint !== "claude-vscode";
    const time = [fmtAge(row.ageSec), ...glyphParts(row, terminal)].join(" ");
    const u = this.sessionUsage(row);
    return { time, status: this.statusPhrase(node), model: u.model, tokens: u.tokens };
  }

  /** The "· <model> · <N> tok" trailing clause for an activity-tree subagent row,
   *  resolved LAZILY (the first render enqueues a whole-file scan). "…" while the
   *  scan is in flight; undefined when the scanner is unwired. */
  private agentUsageClause(a: AgentDetail): string | undefined {
    const scanner = this.tokenScanner;
    if (scanner === undefined) return undefined;
    const r = scanner.agentTotal(a.path);
    if (r === undefined) return "…"; // scanning
    const parts: string[] = [];
    if (r.model !== undefined) parts.push(shortModel(r.model));
    parts.push(shortTokens(r.usage));
    return parts.join(" · ");
  }

  /** Plain-text equivalent of the tree's markdown session hover, for the webview
   *  row's native `title` tooltip. */
  private panelHover(node: SessionNode, title: string, terminal: boolean): string {
    const { row } = node;
    const act = row.activity;
    const lines: string[] = [`${title} — ${this.statusPhrase(node)}`];
    const loc = this.locationOf(row);
    const kind = loc.location === "outside" ? "outside" : terminal ? "terminal" : "IDE";
    lines.push(`${row.homeLabel} · ${kind} · last activity ${fmtAge(row.ageSec)} ago`);
    if (loc.location === "outside") lines.push(outsideSentence(loc));
    const times = sessionTimeFacts(
      sessionBirthMs(row.meta, row.homeDir, row.mainMtimeMs),
      row.meta.startedAt
    );
    lines.push(
      `pid ${row.meta.pid} · session started ${times.started}` +
        (times.process !== undefined ? ` · process started ${times.process}` : "")
    );
    lines.push(`projects/${projectSlug(row.meta)}`);
    lines.push(`session ${row.meta.sessionId}`);
    const usageLine = this.sessionUsageLine(row);
    if (usageLine !== undefined) lines.push(usageLine);
    if (act.agents > 0 || act.workflows > 0) {
      const bits: string[] = [];
      if (act.workflows > 0) {
        bits.push(`${plural(act.workflows, "workflow")} (${plural(act.workflowAgents, "agent")} running)`);
      }
      if (act.agents > 0) bits.push(`${plural(act.agents, "agent")} running`);
      lines.push(bits.join(", "));
    }
    for (const l of act.agentLabels) lines.push(`• ${l}`);
    if (act.currentTask !== undefined) lines.push(`▸ ${act.currentTask}`);
    const quietHover = quietHoverText(
      statusKind({
        status: row.status,
        unread: node.unread,
        attention: node.attention,
        pendingQuestion: row.pendingQuestion,
      }),
      row.pendingToolName,
      row.ageSec
    );
    if (quietHover !== undefined) lines.push(`⏱ ${quietHover}`);
    if (row.pendingQuestion && row.questionText !== undefined) lines.push(`? ${row.questionText}`);
    const collision = this.collisions.get(row.meta.sessionId);
    if (collision !== undefined) {
      lines.push(`⚠ same file as ${collision.otherLabels.join(", ")}`, collision.path);
    }
    if (row.lastText !== "") {
      const preview = row.lastText.length > 600 ? `${row.lastText.slice(0, 600)}…` : row.lastText;
      lines.push("—".repeat(3), preview);
    }
    return lines.join("\n");
  }

  getChildren(element?: Node): Node[] {
    // Remote HostNodes follow the self projects; when there are none this is the
    // same array of ProjectNodes as before (single-host view is unchanged). The
    // degraded-capability note, when present, is the very last leaf.
    if (element === undefined) {
      this.rootFetch.fetched();
      // Root of a full render: start a fresh TreeItem-id scope (see uniqueItemId).
      this.beginItemIdScope();
      // Built by reload (rootRows/keepRows), so the root rows are the same objects
      // every fetch until they change.
      return this.rootChildren;
    }
    if (FOLDABLE_KINDS.has(element.kind)) this.folded.set(rowKey(element), false);
    // Inbox reference rows are flat leaves (the always-visible command center).
    if (element.kind === "inbox") return element.refs;
    // Cursor then Codex sessions, then any nested worktree projects, render after the
    // Claude sessions within a project.
    if (element.kind === "project")
      return [...element.sessions, ...element.cursors, ...element.codexes, ...element.composers, ...element.worktrees];
    if (element.kind === "session")
      // A free-tier LOCKED session renders as a childless placeholder — its subagents,
      // workflows and folded codex/cursor children are hidden along with it (the item
      // is collapsibleState None, so this is defense-in-depth).
      return element.dimmed ? [] : [...this.sessionChildren(element), ...element.codexChildren, ...element.cursorChildren];
    // The one collapsed orphan bucket: its demoted cursor + codex rows.
    if (element.kind === "orphan") return [...element.cursors, ...element.codexes];
    if (element.kind === "workflow") {
      return element.detail.agents
        .filter((a) => this.childVisible(a.running, a.ageSec))
        .map((a) => new AgentNode(a, "workflow"));
    }
    if (element.kind === "host") return element.projects;
    if (element.kind === "remote-project") return element.sessions;
    if (element.kind === "remote-session") return this.remoteChildren(element);
    return [];
  }

  /** Parent lookup so `TreeView.reveal` can walk the ancestor chain (keyboard
   *  triage reveals the row it jumps to). Only the nodes triage ever reveals —
   *  sessions, cursor/codex rows, remote sessions — need a real parent; the rest
   *  return undefined (never revealed). Nodes carry no back-reference, so the
   *  parent is found by identity in the current tree. */
  getParent(element: Node): Node | undefined {
    switch (element.kind) {
      case "session":
        return this.projects.find((p) => p.sessions.includes(element));
      case "cursor": {
        // A folded headless run reveals up to its father session; an orphan up to the
        // orphan bucket; otherwise its project.
        for (const p of this.projects)
          for (const s of p.sessions)
            if (s.cursorChildren.includes(element)) return s;
        if (this.orphanNode?.cursors.includes(element) === true) return this.orphanNode;
        return this.projects.find((p) => p.cursors.includes(element));
      }
      case "composer":
        return this.projects.find((p) => p.composers.includes(element));
      case "codex": {
        for (const p of this.projects)
          for (const s of p.sessions)
            if (s.codexChildren.includes(element)) return s;
        if (this.orphanNode?.codexes.includes(element) === true) return this.orphanNode;
        return this.projects.find((p) => p.codexes.includes(element));
      }
      case "project":
        // A nested worktree project reveals up to its main-repo parent; a top-level
        // project has no parent. (Sessions/cursors above already resolve to a worktree
        // node directly, since `projects` stays flat.)
        return this.topProjects.find((p) => p.worktrees.includes(element));
      case "remote-project":
        return this.hostNodes.find((h) => h.projects.includes(element));
      case "remote-session":
        for (const h of this.hostNodes) {
          const rp = h.projects.find((p) => p.sessions.includes(element));
          if (rp !== undefined) return rp;
        }
        return undefined;
      default:
        return undefined;
    }
  }

  private remoteChildren(node: RemoteSessionNode): Node[] {
    if (!this.activityTree()) return [];
    return (node.session.children ?? []).map(
      (c, i) => new RemoteChildNode(`remote-child:${node.hostId}:${node.session.id}:${i}`, c, node.stale)
    );
  }

  /** The activity rows (subagents, workflows, tasks; a remote session's children)
   *  under a session the view has open, as one comparable string: they are built
   *  afresh on each fetch, so a change among them re-fetches that session's rows.
   *  Folded or never opened: "" (nothing on screen, and no reads for it). */
  private activitySignature(n: Node): string {
    if ((n.kind !== "session" && n.kind !== "remote-session") || this.folded.get(rowKey(n)) !== false) return "";
    const rows = n.kind === "session" ? (n.dimmed ? [] : this.sessionChildren(n)) : this.remoteChildren(n);
    return rows
      .map((c) => {
        const item = withSubMinuteAgesMasked(() => this.buildTreeItem(c));
        return `${item.id ?? ""} ${renderSignature(item)}`;
      })
      .join("\n");
  }

  /** Lazily derived on expand only (and, for a session open in the view, by
   *  activitySignature each tick: sessionDetails caches its directory walk). The active age
   *  filter applies to children too, so a 1h filter hides work that finished
   *  hours ago while keeping running items and pending/in-progress tasks. */
  private sessionChildren(node: SessionNode): Node[] {
    if (!this.activityTree()) return [];
    const { workflows, agents, tasks } = sessionDetails(
      node.row.meta,
      node.row.homeDir,
      node.row.activity.newestMs
    );
    return [
      ...workflows.filter((w) => this.childVisible(w.running, w.ageSec)).map((w) => new WorkflowNode(w)),
      ...agents.filter((a) => this.childVisible(a.running, a.ageSec)).map((a) => new AgentNode(a, "session")),
      ...tasks.filter((t) => this.taskVisible(t.status, t.ageSec)).map((t) => new TaskNode(t)),
    ];
  }

  getTreeItem(element: Node): vscode.TreeItem {
    const item = this.buildTreeItem(element);
    // Final backstop: a duplicate TreeItem id makes VS Code hard-throw ("Element
    // with id … is already registered") and render NOTHING — one collision blanks
    // the whole tree. Upstream ids are already unique (reload drops a repeated row
    // key), but uniquify here too so a future collision degrades to a suffixed row.
    item.id = this.uniqueItemId(element, item.id);
    return item;
  }

  /** Which row renders each id in the current render, so a collision is caught. The
   *  scope resets at each full render (getChildren(undefined)). */
  private idOwner = new Map<string, Node>();

  private beginItemIdScope(): void {
    this.idOwner = new Map();
  }

  /** The id VS Code gets for a row. A kept row (see keepRows) owns its id outright:
   *  its id comes from its rowKey, which no other kept row shares. A lazily built
   *  activity row re-fetched under a refreshed parent takes over the id of its own
   *  previous object. A genuine collision gets a suffix derived from the row's own
   *  key, never from render order, so a handle names the same row on every render:
   *  a click can resolve to nothing, never to a different row. */
  private uniqueItemId(element: Node, rawId: string | undefined): string | undefined {
    if (rawId === undefined) return rawId;
    const owner = this.idOwner.get(rawId);
    const ownerKept = owner !== undefined && owner !== element && this.rowCache.get(rowKey(owner)) === owner;
    if (!ownerKept) {
      this.idOwner.set(rawId, element);
      return rawId;
    }
    return `${rawId}~dup:${opaqueId(rowKey(element))}`;
  }

  private buildTreeItem(element: Node): vscode.TreeItem {
    switch (element.kind) {
      case "inbox":
        return this.inboxItem(element);
      case "inbox-ref":
        return this.inboxRefItem(element);
      case "project":
        return this.projectItem(element);
      case "session":
        return this.sessionItem(element);
      case "cursor":
        return this.cursorItem(element);
      case "composer":
        return this.composerItem(element);
      case "codex":
        return this.codexItem(element);
      case "orphan":
        return this.orphanItem(element);
      case "workflow":
        return this.workflowItem(element);
      case "agent":
        return this.agentItem(element);
      case "task":
        return this.taskItem(element);
      case "host":
        return this.hostItem(element);
      case "remote-project":
        return this.remoteProjectItem(element);
      case "remote-session":
        return this.remoteSessionItem(element);
      case "remote-child":
        return this.remoteChildItem(element);
      case "capability-note":
        return this.capabilityNoteItem(element);
      case "hidden-note":
        return this.hiddenNoteItem(element);
      case "license-note":
        return this.licenseNoteItem(element);
      case "collision-note":
        return this.collisionNoteItem(element);
    }
  }

  /** The dim free-tier leaf: "Free tier: supervising N of M sessions — Enter
   *  License". Reuses the capability-note style (muted `key` icon, quiet
   *  disabledForeground); clicking enters a license key. Meta — never a session. */
  private licenseNoteItem(node: LicenseNoteNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `Free tier: ${node.covered} of ${node.total} sessions active`,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `license-note#g${this.generation}`;
    item.contextValue = "license-note";
    item.iconPath = new vscode.ThemeIcon("key", new vscode.ThemeColor("disabledForeground"));
    item.tooltip =
      `The free tier keeps ${node.covered} session(s) fully active (working sessions first). ` +
      `The other ${node.total - node.covered} show as "${LOCKED_SESSION_LABEL}" — no details, ` +
      `children or controls, and out of alerts/badge/triage. A license unlocks all of them.`;
    item.command = { command: "sessionDeck.licenseMenu", title: "Unlock" };
    return item;
  }

  /** The dim, observe-only same-path collision leaf. contextValue keeps it out of
   *  every session/project menu; a `warning` codicon in the muted disabledForeground
   *  keeps it quiet. No command — it is purely informational (the row glyphs + hover
   *  carry the detail). */
  private collisionNoteItem(node: CollisionNoteNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
    item.id = `collision-note#g${this.generation}`;
    item.contextValue = "collision-note";
    item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("disabledForeground"));
    item.tooltip = node.message;
    return item;
  }

  /** The dim "N hidden" leaf. Reuses the capability-note style (muted icon, quiet
   *  disabledForeground) at the very bottom of the tree; clicking opens the Show
   *  Hidden picker. Meta — never a session, so it stays out of counts/triage. */
  private hiddenNoteItem(node: HiddenNoteNode): vscode.TreeItem {
    const item = new vscode.TreeItem(`${node.count} hidden`, vscode.TreeItemCollapsibleState.None);
    item.id = `hidden-note#g${this.generation}`;
    item.contextValue = "hidden-note";
    item.iconPath = new vscode.ThemeIcon("eye-closed", new vscode.ThemeColor("disabledForeground"));
    // Honest disclosure: hidden here also means hidden in what this machine
    // publishes to your other hosts (a hidden session stops counting everywhere).
    item.tooltip = `${node.count} session${node.count === 1 ? "" : "s"} hidden here — and removed from what this machine publishes to your other hosts. Select to review or unhide.`;
    item.command = { command: "sessionDeck.showHidden", title: "Show Hidden Sessions" };
    return item;
  }

  /** The collapsed "Orphaned runs (folder deleted)" bucket header. Collapsed by
   *  default (a low-noise archive of dead runs from pruned worktrees); its
   *  contextValue exposes a "Dismiss all" action. Meta — its rows never count toward
   *  attention/badge/triage. */
  private orphanItem(node: OrphanNode): vscode.TreeItem {
    const count = node.cursors.length + node.codexes.length;
    const item = new vscode.TreeItem(
      "Orphaned runs (folder deleted)",
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `orphan#g${this.generation}`;
    item.contextValue = "orphanBucket";
    item.description = String(count);
    item.iconPath = new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
    item.tooltip = `${count} run${count === 1 ? "" : "s"} whose working folder no longer exists on disk (a pruned worktree) and whose process has exited. They cannot be opened. Dismiss to hide them.`;
    return item;
  }

  /** The dim, informational capability-note leaf. contextValue "capability-note"
   *  keeps it out of every session/project menu; its click opens the relevant fix
   *  (Install Hooks / Run Diagnostics). An `info` codicon in the muted
   *  disabledForeground keeps it visually quiet. */
  private capabilityNoteItem(node: CapabilityNoteNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.note.message, vscode.TreeItemCollapsibleState.None);
    item.id = `capability-note:${node.note.kind}#g${this.generation}`;
    item.contextValue = "capability-note";
    item.iconPath = new vscode.ThemeIcon("info", new vscode.ThemeColor("disabledForeground"));
    item.tooltip = node.note.message;
    item.command = { command: node.note.command, title: node.note.message };
    return item;
  }

  private hostItem(node: HostNode): vscode.TreeItem {
    // The density default, never the needs-you state: opening a group that comes
    // to need you goes through the view (expandRow), and a collapsibleState that
    // followed needs-you would redraw the group, dropping its rows, each time it
    // changed.
    const expanded = projectExpanded(this.density(), this.collapseOverride, 0);
    const item = new vscode.TreeItem(
      hostDisplayLabel(node.snapshot.host),
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `host:${node.snapshot.host.id}#g${this.generation}`;
    item.contextValue = "host-remote";
    const count = node.projects.reduce((n, p) => n + p.sessions.length, 0);
    // Staleness lives in the (naturally dim) description; a stale host also mutes
    // its icon color — the dimming conventions this file already uses.
    if (node.stale) {
      // Liveness always shows and is never held back: going stale or coming back
      // redraws the host at once, even though that drops its rows for a round
      // trip. Open, without the "last seen" age, which would go stale (groupOpen).
      item.description = this.groupOpen(node, expanded) ? `${count} · offline` : `${count} · last seen ${fmtAge(node.lastSeenSec)} ago`;
      item.iconPath = new vscode.ThemeIcon("server-environment", new vscode.ThemeColor("disabledForeground"));
    } else {
      item.description = String(count);
      item.iconPath = new vscode.ThemeIcon("server-environment", new vscode.ThemeColor("charts.green"));
    }
    // Fact-block hover: liveness tri-state, platform + session tally, snapshot age,
    // an optional version-skew note, and (for a stale host) the resume hint. The
    // display label is remote-supplied free text (hostname/authorityHint/label), so
    // it goes through appendText — as do the fact lines — keeping the esc discipline
    // remote strings require; only the constant structural markers use appendMarkdown.
    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = true;
    const h = node.snapshot.host;
    // ── Header: a server glyph tinted green (live) / muted (stale) + the display
    //    label (remote free text → mdText).
    md.appendMarkdown(`${coloredIcon("server-environment", node.stale ? "disabledForeground" : "charts.green")} **`);
    this.mdText(md, hostDisplayLabel(h));
    md.appendMarkdown("**\n\n---\n\n");
    const skew = this.publisherSkew();
    const counts = tallyRemoteSessions(
      node.projects.flatMap((p) => p.sessions.map((s) => s.session))
    );
    const allFacts = hostFactLines({
      platform: h.platform,
      counts,
      lastSeenSec: node.lastSeenSec,
      stale: node.stale,
      skewVersion: skew.skew ? skew.version : undefined,
    });
    // Open: no status tally and no snapshot age, which change without the host's
    // rows changing (see groupOpen); the rows below show them.
    const facts = this.groupOpen(node, expanded)
      ? allFacts
          .filter((l) => !l.startsWith("received "))
          .map((l, i) => (i === 1 ? `${h.platform} · ${plural(count, "session")}` : l))
      : allFacts;
    // First fact line is the liveness tri-state — lead it with a colored dot; the
    // rest are own-side enums/numbers/version, all escaped via mdText under supportHtml.
    facts.forEach((line, i) => {
      if (i === 0) {
        md.appendMarkdown(`${coloredIcon("circle-filled", node.stale ? "charts.yellow" : "charts.green")} `);
      }
      this.mdText(md, line);
      md.appendMarkdown("\n\n");
    });
    item.tooltip = md;
    return item;
  }

  private remoteProjectItem(node: RemoteProjectNode): vscode.TreeItem {
    const needsYou = this.remoteProjectNeedsYou(node);
    // The density default, never the needs-you state: opening a group that comes
    // to need you goes through the view (expandRow), and a collapsibleState that
    // followed needs-you would redraw the group, dropping its rows, each time it
    // changed.
    const expanded = projectExpanded(this.density(), this.collapseOverride, 0);
    const item = new vscode.TreeItem(
      projectDisplayName(node.cwd),
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `remote-project:${node.hostId}:${node.cwd}#g${this.generation}`;
    item.contextValue = "remote-project";
    const newestAge = Math.min(...node.sessions.map((s) => s.ageSec), Number.POSITIVE_INFINITY);
    if (this.groupOpen(node, expanded)) {
      // Open: only what changes with its rows (see groupOpen).
      item.description = String(node.sessions.length);
    } else if (this.density() === "compact") {
      const working = node.sessions.filter((s) => !s.stale && s.session.status === "working").length;
      const unread = node.sessions.filter((s) => s.unread).length;
      item.description = compactProjectDescription({
        needsYou,
        total: node.sessions.length,
        working,
        unread,
        newestAgeSec: Number.isFinite(newestAge) ? newestAge : null,
      });
    } else {
      const parts: string[] = [String(node.sessions.length)];
      if (Number.isFinite(newestAge)) parts.push(fmtAge(newestAge));
      item.description = parts.join(" · ");
    }
    item.tooltip = node.cwd;
    return item;
  }

  private remoteSessionItem(node: RemoteSessionNode): vscode.TreeItem {
    const s = node.session;
    const title = s.title !== undefined && s.title.length > 0 ? s.title : s.id.slice(0, 8);
    const expandable = this.activityTree() && (s.children?.length ?? 0) > 0;
    const item = new vscode.TreeItem(
      title,
      expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.id = `remote-session:${node.hostId}:${s.id}#g${this.generation}`;
    // `remoteSession` (not `session-remote`): the showLastMessage menu matches
    // `viewItem =~ /^session/`, which `session-remote` would trip — this value
    // avoids every existing session/project menu so remote rows stay read-only.
    // "remoteSession-stop": its host says it can stop it (Stop Session, relayed).
    item.contextValue = s.stoppable === true && !node.stale && s.tool !== "cursor" ? "remoteSession-stop" : "remoteSession";
    const running = (s.children ?? []).filter((c) => remoteChildRunning(c.status)).length;
    const parts: string[] = [fmtAge(node.ageSec)];
    if (running > 0) parts.push(`⚙${running}`);
    if (s.tool !== "claude") parts.push("❯");
    // Outside: a small badge after the label (see OUTSIDE_GLYPH), not a word in it.
    if (s.outside === true && !node.stale) item.resourceUri = outsideResourceUri(`remote:${node.hostId}:${s.id}`);
    item.description = parts.join(" ");
    if (s.tool === "cursor") item.iconPath = this.brandIcon("cursor");
    else if (s.tool === "codex") item.iconPath = this.brandIcon("codex");
    else item.iconPath = themeIcon(this.remoteVisual(s, node.unread, node.stale));
    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = true;
    // Every remote value (title/status/lastText/cwd) is untrusted free text from a
    // peer host — routed through mdText so nothing can inject markdown/HTML under
    // supportHtml. Only the colored status glyph + structural markers are authored.
    const rStale = node.stale;
    const rIcon = s.attention === true ? "bell" : s.status === "working" ? "sync" : node.unread ? "bell-dot" : "check";
    const rColor = rStale
      ? "disabledForeground"
      : s.attention === true
        ? "charts.red"
        : s.status === "working"
          ? "charts.green"
          : node.unread
            ? "charts.yellow"
            : "charts.blue";
    md.appendMarkdown(`${coloredIcon(rIcon, rColor)} **`);
    this.mdText(md, title);
    md.appendMarkdown(`** — `);
    this.mdText(md, s.status);
    md.appendMarkdown(`\n\n---\n\n$(watch) ${rStale ? "last known" : "live"} · ${fmtAge(node.ageSec)} ago\n\n`);
    if (s.outside === true && !rStale) {
      // Stop only when that host says it can (an older host's window offers Move only).
      md.appendMarkdown(
        s.stoppable === true
          ? `$(link-external) Runs outside the editor on that host. Clicking it offers Move into Editor and Stop Session in the window attached to that host; Stop Session here asks that window to stop it.\n\n`
          : `$(link-external) Runs outside the editor on that host. Clicking it offers Move into Editor in the window attached to that host.\n\n`
      );
    }
    if (s.lastText !== undefined && s.lastText !== "") {
      md.appendMarkdown("---\n\n");
      this.mdText(md, s.lastText);
      md.appendMarkdown("\n\n");
    }
    md.appendMarkdown("$(folder) ");
    this.mdText(md, s.cwd);
    item.tooltip = md;
    // Live rows focus the session on its host; stale rows (window closed) have no
    // window to focus, so they keep the last-message preview. The focus handler
    // itself falls back to the preview when the bridge can't relay the click.
    item.command = node.stale
      ? { command: REMOTE_LAST_MSG_CMD, title: "Show Last Message", arguments: [node] }
      : { command: REMOTE_FOCUS_CMD, title: "Focus on Host", arguments: [node] };
    return item;
  }

  private remoteChildItem(node: RemoteChildNode): vscode.TreeItem {
    const c = node.child;
    const item = new vscode.TreeItem(c.label, vscode.TreeItemCollapsibleState.None);
    item.id = `${node.id}#g${this.generation}`;
    item.contextValue = "remote-child";
    item.description = c.status ?? "";
    item.iconPath = themeIcon(remoteChildVisual(c, node.stale));
    item.tooltip = `${c.kind} · ${c.label}${c.status !== undefined ? ` · ${c.status}` : ""}`;
    return item;
  }

  /** The "Needs you (N)" inbox header — the urgency-ranked command center at the
   *  top of the tree. Always-expanded in compact (its whole point); in comfortable
   *  it defaults open but honors collapse-all. The generation-bearing id re-applies
   *  the state on a density flip / collapse-all. Meta section — never a session, so
   *  it stays out of counts/alerts (its children are references to the real rows). */
  private inboxItem(node: InboxNode): vscode.TreeItem {
    const n = node.refs.length;
    // Compact: always expanded. Comfortable: expanded unless collapse-all forced it.
    const expanded = this.density() === "compact" ? true : this.collapseOverride !== true;
    const item = new vscode.TreeItem(
      `Needs you (${n})`,
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `inbox#g${this.generation}`;
    item.contextValue = "inbox";
    item.iconPath = new vscode.ThemeIcon("bell-dot", new vscode.ThemeColor("charts.red"));
    item.tooltip = new vscode.MarkdownString(
      `**Needs you** — ${plural(n, "session")} ranked by urgency (approvals & questions first, ` +
        `then finished-unread, then live remote). A view of the rows below, not a move.`
    );
    return item;
  }

  /** A single inbox reference row: the underlying row's tree item (same icon/title/
   *  caption/click), re-keyed with a distinct `inbox:`-prefixed id so it never
   *  collides with the real row below, and forced to a flat leaf (no activity-tree
   *  expansion in the command center). The click command + arguments come straight
   *  from the underlying builder, so they carry the REAL node — a click records the
   *  real session's focus anchor; the underlying contextValue is preserved so the
   *  same read/hide context-menu actions apply (they unwrap to the real node). */
  private inboxRefItem(node: InboxRefNode): vscode.TreeItem {
    const t = node.target;
    const item =
      t.kind === "session"
        ? this.sessionItem(t)
        : t.kind === "cursor"
          ? this.cursorItem(t)
          : t.kind === "codex"
            ? this.codexItem(t)
            : this.remoteSessionItem(t);
    item.id = `${node.refId}#g${this.generation}`;
    item.collapsibleState = vscode.TreeItemCollapsibleState.None;
    return item;
  }

  private projectItem(node: ProjectNode): vscode.TreeItem {
    // A synthetic main-repo parent has no sessions of its own — it exists only to host
    // worktree children, so it renders as a plain, always-expanded group ("N worktrees").
    if (node.synthetic) {
      const item = new vscode.TreeItem(projectDisplayName(node.cwd), vscode.TreeItemCollapsibleState.Expanded);
      item.id = `${node.cwd}#g${this.generation}#wtparent`;
      item.contextValue = "project-worktree-parent";
      item.description = plural(node.worktrees.length, "worktree");
      item.iconPath = new vscode.ThemeIcon("repo");
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(`$(repo) **`);
      this.mdText(md, projectDisplayName(node.cwd));
      md.appendMarkdown(`** — main repo · ${plural(node.worktrees.length, "worktree")}\n\n---\n\n$(folder) `);
      this.mdText(md, node.cwd);
      item.tooltip = md;
      return item;
    }
    const needsYou = this.projectNeedsYou(node);
    // A main-repo parent whose worktree comes to need you is opened by
    // openNeedsYouGroups, which counts the worktrees' needs-you too.
    // The density default, never the needs-you state: opening a group that comes
    // to need you goes through the view (expandRow), and a collapsibleState that
    // followed needs-you would redraw the group, dropping its rows, each time it
    // changed.
    const expanded = projectExpanded(this.density(), this.collapseOverride, 0);
    const item = new vscode.TreeItem(
      projectDisplayName(node.cwd),
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    // A stable id: a project that comes to need you is opened through the view
    // (expandRow), not by changing its id — the "needs-you is never buried" covenant.
    item.id = `${node.cwd}#g${this.generation}`;
    // contextValue gates the Pin/Unpin menu items; the two variants let the menu
    // show exactly one of them per row.
    const pinned = this.isPinned(node.cwd);
    item.contextValue = pinned ? "project-pinned" : "project-unpinned";
    const total = node.sessions.length + node.cursors.length + node.codexes.length;
    // Free-tier LOCKED rows contribute NO activity metrics to the project header
    // (their working/unread/age are hidden with the row); count covered rows only.
    const working =
      node.sessions.filter((s) => !s.dimmed && s.row.status === "working").length +
      node.cursors.filter((c) => !c.dimmed && c.row.status === "working").length +
      node.codexes.filter((c) => !c.dimmed && c.row.status === "working").length;
    const unread =
      node.sessions.filter((s) => !s.dimmed && s.unread).length +
      node.cursors.filter((c) => !c.dimmed && c.unread).length +
      node.codexes.filter((c) => !c.dimmed && c.unread).length;
    const newestAge = Math.min(
      ...node.sessions.filter((s) => !s.dimmed).map((s) => s.row.ageSec ?? Number.POSITIVE_INFINITY),
      ...node.cursors.filter((c) => !c.dimmed).map((c) => c.row.ageSec),
      ...node.codexes.filter((c) => !c.dimmed).map((c) => c.row.ageSec),
      Number.POSITIVE_INFINITY
    );
    const open = this.groupOpen(node, expanded);
    if (open) {
      // Open: only what changes with its rows (see groupOpen).
      item.description = pinned ? `📌 · ${total}` : String(total);
    } else if (this.density() === "compact") {
      // Pressure summary (🔔needs-you · count · ↻working · ●unread · age) so a
      // folded project still says how loudly it wants you. 📌 stays first for pins.
      const summary = compactProjectDescription({
        needsYou,
        total,
        working,
        unread,
        newestAgeSec: Number.isFinite(newestAge) ? newestAge : null,
      });
      item.description = pinned ? `📌 · ${summary}` : summary;
    } else {
      // 📌(pinned) · count · ↻working · ●unread · newest-age (glyphs; words in tooltip)
      const parts: string[] = [];
      if (pinned) parts.push("📌");
      parts.push(String(total));
      if (working > 0) parts.push(`↻${working}`);
      if (unread > 0) parts.push(`●${unread}`);
      if (Number.isFinite(newestAge)) parts.push(fmtAge(newestAge));
      item.description = parts.join(" · ");
    }
    // Worktree rows lead their description with the checked-out branch (⑂ <branch>)
    // so a nested lane reads as "vco-lane-q · lane/cursor-open" at a glance.
    if (node.branch !== undefined && node.branch !== "") {
      item.description = `⑂ ${node.branch} · ${item.description}`;
    }
    item.tooltip = this.projectTooltip(node, working, unread, open);
    // no icon on group rows: leaf children don't reserve chevron space, so any
    // parent icon would sit misaligned to the right of the session icons
    return item;
  }

  private projectTooltip(node: ProjectNode, working: number, unread: number, open = false): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = true;
    // ── Header: project name + a compact roll-up (N sessions · W working · U unread).
    md.appendMarkdown(`$(folder-active) **`);
    this.mdText(md, projectDisplayName(node.cwd));
    md.appendMarkdown(
      `** — ${plural(node.sessions.length + node.cursors.length + node.codexes.length, "session")}`
    );
    if (open) {
      // Open: the rows below say how each session is doing (see groupOpen).
      if (node.branch !== undefined && node.branch !== "") {
        md.appendMarkdown(`\n\n$(git-branch) worktree · branch `);
        this.mdText(md, node.branch);
      }
      md.appendMarkdown(`\n\n---\n\n$(folder) `);
      this.mdText(md, node.cwd);
      return md;
    }
    if (working > 0) md.appendMarkdown(` · ${working} working`);
    if (unread > 0) md.appendMarkdown(` · ${unread} unread`);
    if (node.branch !== undefined && node.branch !== "") {
      md.appendMarkdown(`\n\n$(git-branch) worktree · branch `);
      this.mdText(md, node.branch);
    }
    md.appendMarkdown("\n\n---\n\n");
    // ── One line per session-like row, each led by its colored status glyph so the
    //    project's mix is legible at a glance. Titles/names are free/derived → mdText.
    //    Free-tier LOCKED rows leak NOTHING here either: they are skipped and collapsed
    //    into a single generic "$(lock) N locked" line at the end.
    let lockedCount = 0;
    for (const s of node.sessions) {
      if (s.dimmed) { lockedCount++; continue; }
      const title = this.titleWithFallback(s.row, s.row.meta.name ?? s.row.meta.sessionId.slice(0, 8));
      md.appendMarkdown(`${coloredIcon(this.statusIcon(s), this.statusColor(s))} ${this.statusPhrase(s)} · `);
      this.mdText(md, title);
      md.appendMarkdown(` · ${fmtAge(s.row.ageSec)}`);
      if (this.multiHome) {
        md.appendMarkdown(` · `);
        this.mdText(md, s.row.homeLabel);
      }
      md.appendMarkdown(`\n\n`);
    }
    for (const c of node.cursors) {
      if (c.dimmed) { lockedCount++; continue; }
      md.appendMarkdown(`$(sparkle) cursor · `);
      this.mdText(md, c.row.name);
      md.appendMarkdown(` · ${fmtAge(c.row.ageSec)}\n\n`);
    }
    for (const c of node.codexes) {
      if (c.dimmed) { lockedCount++; continue; }
      md.appendMarkdown(`$(sparkle) `);
      this.mdText(md, c.row.kind);
      md.appendMarkdown(` · `);
      this.mdText(md, c.row.name);
      md.appendMarkdown(` · ${fmtAge(c.row.ageSec)}\n\n`);
    }
    for (const m of node.composers) if (m.dimmed) lockedCount++;
    if (lockedCount > 0) md.appendMarkdown(`$(lock) ${lockedCount} ${LOCKED_SESSION_LABEL}\n\n`);
    md.appendMarkdown(`---\n\n$(folder) `);
    this.mdText(md, node.cwd);
    return md;
  }

  /** Human status phrase shared by session hover line 1 and project one-liners. */
  private statusPhrase(node: SessionNode): string {
    return statusPhraseOf({
      status: node.row.status,
      unread: node.unread,
      attention: node.attention,
      pendingQuestion: node.row.pendingQuestion,
    });
  }

  /** Non-animated codicon name for tooltips (the tree row keeps its own icon,
   *  including the sync~spin animation, untouched). */
  private statusIcon(node: SessionNode): string {
    if (node.attention) return "bell";
    if (node.row.pendingQuestion) return "comment-discussion";
    if (node.row.status === "working") return "sync";
    if (node.unread) return "bell-dot";
    if (node.row.status === "waiting") return "check";
    return "circle-outline";
  }

  /** The VS Code theme-color name the row's status icon uses (undefined for idle =
   *  default foreground), so a hover's colored status glyph matches the row exactly.
   *  Mirrors sessionVisual — the single source of truth for the icon color. */
  private statusColor(node: SessionNode): string | undefined {
    const orchestrating = node.row.activity.agents > 0 || node.row.activity.workflows > 0;
    return sessionVisual(
      statusKind({
        status: node.row.status,
        unread: node.unread,
        attention: node.attention,
        pendingQuestion: node.row.pendingQuestion,
      }),
      orchestrating
    ).color;
  }

  /** Display title precedence: transcript ai-title (exact/full) → editor memento →
   *  first user-prompt line (sanitized, ≤48) → `stub`. Applied at the panelSession
   *  seam, it flows into cross-host snapshots with no extra wiring. */
  private titleWithFallback(row: SessionRow, stub: string): string {
    return this.titleWithFallbackTagged(row, stub).title;
  }

  /** titleWithFallback + a flag reporting whether the returned title is the
   *  prompt-derived fallback (vs a real title or the plain stub). The panelSession
   *  seam threads `isPrompt` into PanelSession.titleIsPrompt so the cross-host
   *  snapshot builder can keep user-authored prompt prose off the wire when
   *  publishLastText is off (privacy contract: "titles only" = the safe minimum). */
  private titleWithFallbackTagged(row: SessionRow, stub: string): { title: string; isPrompt: boolean } {
    const ai = row.aiTitle; // transcript tail's last ai-title: the exact, full tab/sidebar name
    if (ai !== undefined && ai !== "") return { title: ai, isPrompt: false };
    const real = this.titleFor(row.meta.sessionId);
    if (real !== undefined) return { title: real, isPrompt: false };
    const prompt = promptFallbackTitle(row.meta, row.homeDir, row.mainMtimeMs);
    if (prompt !== undefined) {
      const clean = sanitizeReason(prompt, 48);
      if (clean !== "") return { title: clean, isPrompt: true };
    }
    return { title: stub, isPrompt: false };
  }

  /** Append untrusted (disk / hook / transcript-derived) text to a supportHtml hover
   *  safely: `appendText` markdown-escapes it (blocking `![](url)`/`[](url)` injection
   *  and `>`), and `preEscapeHtml` neutralizes the `&`/`<` that appendText leaves live
   *  under supportHtml — so no HTML tag or entity can form. The single sink every
   *  hover routes free/derived values through (the format.ts sanitization covenant). */
  private mdText(md: vscode.MarkdownString, s: string): void {
    md.appendText(preEscapeHtml(s));
  }

  /** The free-tier LOCKED placeholder tree item, shared by every session kind. It
   *  reveals NOTHING about the real session: fixed label + lock glyph, a distinct
   *  contextValue ("lockedSession") whose only context-menu items are Enter License
   *  Key and Buy License (no session actions), no children (collapsibleState None), and a single quiet "unlock" command
   *  routing to the license menu — no jump/open. `uniqueId` seeds a stable DOM id
   *  (internal only; never rendered). */
  private lockedItem(uniqueId: string): vscode.TreeItem {
    const item = new vscode.TreeItem(LOCKED_SESSION_LABEL, vscode.TreeItemCollapsibleState.None);
    // The DOM id is stable + unique but OPAQUE: a hash of the underlying key, never the
    // raw session id — nothing identifying about the locked session reaches the tree.
    item.id = `locked:${opaqueId(uniqueId)}#g${this.generation}`;
    item.contextValue = "lockedSession";
    item.iconPath = new vscode.ThemeIcon(LOCKED_SESSION_ICON, new vscode.ThemeColor("disabledForeground"));
    item.tooltip =
      "Beyond the free tier's active sessions. A license unlocks and supervises all of your sessions.";
    item.command = { command: "sessionDeck.licenseMenu", title: "Unlock" };
    return item;
  }

  /** sessionHasDetails, read again only when the session's activity moved. */
  private hasDetails(row: SessionRow): boolean {
    const at = `${row.mtimeMs}|${row.activity.newestMs}`;
    const hit = this.detailsMemo.get(row.meta.sessionId);
    if (hit !== undefined && hit.at === at) return hit.has;
    const has = sessionHasDetails(row.meta, row.homeDir);
    this.detailsMemo.set(row.meta.sessionId, { at, has });
    return has;
  }

  private sessionItem(node: SessionNode): vscode.TreeItem {
    if (node.dimmed) return this.lockedItem("session:" + node.row.meta.sessionId);
    const { row } = node;
    const fallback = row.meta.name ?? row.meta.sessionId.slice(0, 8);
    // Expandable only when the setting is on AND there's something to show; the id
    // carries the generation so toggling the setting re-applies collapsibleState.
    const expandable =
      (this.activityTree() && this.hasDetails(row)) ||
      node.codexChildren.length > 0;
    const item = new vscode.TreeItem(
      this.titleWithFallback(row, fallback),
      expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.id = `${row.meta.sessionId}#g${this.generation}`;
    const loc = this.locationOf(row);
    const outside = loc.location === "outside";
    // Outside first: an app can claim the extension's entrypoint (see classifyLocation).
    item.contextValue = outside
      ? "session-outside"
      : (row.meta.entrypoint === "claude-vscode" ? "session" : "session-terminal") + (loc.location !== "unknown" ? "-stop" : "");

    const act = row.activity;
    const terminal = row.meta.entrypoint !== "claude-vscode";
    const kind = statusKind({
      status: row.status,
      unread: node.unread,
      attention: node.attention,
      pendingQuestion: row.pendingQuestion,
    });
    // glyph description: age ⚙<live agents> ❯(terminal). Everything else is in the hover.
    const descParts = [fmtAge(row.ageSec), ...glyphParts(row, terminal)];
    // Same-path collision glyph (observe-only): the row names the file as
    // parent/basename only; the full path + the other session(s) live in the hover.
    const collision = this.collisions.get(row.meta.sessionId);
    if (collision !== undefined) {
      descParts.push(`⚠ same file (${sanitizeReason(collapseCollisionPath(collision.path), 56)})`);
    }
    // A trailing glance clause after the glyphs. On a BLOCKED row it says WHAT is
    // wanted (permission reason on attention, question text on a pending question);
    // on a WORKING row it says what it is DOING ("doing now" caption); on a
    // FINISHED-UNREAD row it says what it FINISHED ("done" caption: a snippet of the
    // final message). The three are mutually exclusive by status bucket, so at most
    // one shows. sanitizeReason strips control chars/newlines (untrusted/hook-derived
    // text) and is safe in this plain sink.
    const blockedGlance =
      node.attention && node.reason !== undefined && node.reason !== ""
        ? node.reason
        : row.pendingQuestion && row.questionText !== undefined
          ? row.questionText
          : undefined;
    const trailing =
      blockedGlance !== undefined
        ? sanitizeReason(blockedGlance, 56)
        : workingTrailing(kind, act.currentTask, row.pendingToolName, row.ageSec) ??
          doneCaption(kind === "unread", row.lastText);
    // "columns" layout replaces the inline flow with strictly-ordered slots
    // (time · status · model · tokens) so the fields line up down the list; "list"
    // keeps today's glyphs + trailing-glance flow.
    item.description =
      this.layout() === "columns"
        ? sessionColumnsDescription(this.sessionColumnFields(node))
        : trailing !== undefined && trailing !== ""
          ? `${descParts.join(" ")} · ${trailing}`
          : descParts.join(" ");

    // account badge is a FileDecoration; only surface the resource (and thus the
    // badge) when more than one account is present, so single-account rows are
    // rendered exactly as before. (A free-tier-locked row never reaches here — it
    // early-returns as a placeholder above.)
    // An outside row adds its badge to the same URI (one resourceUri per row).
    if (this.multiHome) item.resourceUri = sessionResourceUri(row.homeLabel, row.meta.sessionId, outside);
    else if (outside) item.resourceUri = outsideResourceUri("session:" + row.meta.sessionId);

    const orchestrating = act.agents > 0 || act.workflows > 0;
    const vis = sessionVisual(kind, orchestrating);
    item.iconPath = themeIcon(vis);

    // Hover redesign (supportHtml): a colored status glyph matching the row icon, a
    // header rule, then grouped fact lines. supportHtml unlocks the theme-colored
    // codicons and <hr> rules; every disk/hook/transcript value still flows through
    // mdText (markdown-escape + &/< pre-escape), so the sanitization covenant holds.
    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = true;
    const title = this.titleWithFallback(row, fallback);
    // ── Header: status glyph (same theme color as the row icon) · title · phrase.
    md.appendMarkdown(`${coloredIcon(this.statusIcon(node), vis.color)} **`);
    this.mdText(md, title);
    md.appendMarkdown(`** — ${this.statusPhrase(node)}\n\n---\n\n`);
    // ── Identity & metrics group.
    const kindLabel = outside ? "$(link-external) outside" : terminal ? "$(terminal) terminal" : "$(window) IDE";
    md.appendMarkdown(`$(account) `);
    this.mdText(md, row.homeLabel);
    md.appendMarkdown(` · ${kindLabel} · $(watch) ${fmtAge(row.ageSec)} ago\n\n`);
    if (outside) {
      md.appendMarkdown(`$(link-external) `);
      this.mdText(md, outsideSentence(loc));
      md.appendMarkdown(`\n\n`);
    }
    const times = sessionTimeFacts(
      sessionBirthMs(row.meta, row.homeDir, row.mainMtimeMs),
      row.meta.startedAt
    );
    md.appendMarkdown(`$(clock) started ${times.started}`);
    if (times.process !== undefined) md.appendMarkdown(` · process ${times.process}`);
    md.appendMarkdown(` · pid ${row.meta.pid}\n\n`);
    const usageLine = this.sessionUsageLine(row);
    if (usageLine !== undefined) {
      md.appendMarkdown(`$(dashboard) `);
      this.mdText(md, usageLine);
      md.appendMarkdown(`\n\n`);
    }
    // Session identity (project slug + id): disk-derived → mdText.
    md.appendMarkdown(`$(folder) `);
    this.mdText(md, `projects/${projectSlug(row.meta)}`);
    md.appendMarkdown(`\n\n$(key) `);
    this.mdText(md, `session ${row.meta.sessionId}`);
    md.appendMarkdown(`\n\n`);
    // ── Activity & attention group (rule only when it has content).
    const quietHover = quietHoverText(kind, row.pendingToolName, row.ageSec);
    const hasAttention =
      (node.attention && node.reason !== undefined && node.reason !== "") ||
      (row.pendingQuestion && row.questionText !== undefined) ||
      collision !== undefined;
    const hasActivity =
      act.agents > 0 ||
      act.workflows > 0 ||
      act.agentLabels.length > 0 ||
      act.currentTask !== undefined ||
      quietHover !== undefined;
    if (hasActivity || hasAttention) md.appendMarkdown(`---\n\n`);
    if (act.agents > 0 || act.workflows > 0) {
      const bits: string[] = [];
      if (act.workflows > 0) {
        bits.push(`${plural(act.workflows, "workflow")} (${plural(act.workflowAgents, "agent")} running)`);
      }
      if (act.agents > 0) bits.push(`${plural(act.agents, "agent")} running`);
      md.appendMarkdown(`${coloredIcon("gear", "charts.purple")} ${bits.join(", ")}\n\n`);
    }
    if (act.agentLabels.length > 0) {
      for (const l of act.agentLabels) {
        md.appendMarkdown(`$(robot) `);
        this.mdText(md, l);
        md.appendMarkdown(`\n\n`);
      }
    }
    if (act.currentTask !== undefined) {
      // Transcript-derived free text → mdText.
      md.appendMarkdown(`$(target) **`);
      this.mdText(md, act.currentTask);
      md.appendMarkdown(`**\n\n`);
    }
    if (quietHover !== undefined) {
      md.appendMarkdown(`${coloredIcon("watch", "charts.yellow")} `);
      this.mdText(md, quietHover);
      md.appendMarkdown(`\n\n`);
    }
    if (node.attention && node.reason !== undefined && node.reason !== "") {
      // Hook-supplied text → mdText; the bell is tinted red (needs-approval).
      md.appendMarkdown(`${coloredIcon("bell", "charts.red")} `);
      this.mdText(md, node.reason);
      md.appendMarkdown(`\n\n`);
    }
    if (row.pendingQuestion && row.questionText !== undefined) {
      // Transcript-derived free text → mdText; discussion glyph tinted (needs-answer).
      md.appendMarkdown(`${coloredIcon("comment-discussion", "charts.yellow")} `);
      this.mdText(md, row.questionText);
      md.appendMarkdown(`\n\n`);
    }
    if (collision !== undefined) {
      // Observe-only collision hover: the other session label(s) and the FULL path.
      md.appendMarkdown(`${coloredIcon("warning", "charts.orange")} same file as `);
      this.mdText(md, collision.otherLabels.join(", "));
      md.appendMarkdown(`\n\n$(file) `);
      this.mdText(md, collision.path);
      md.appendMarkdown(`\n\n`);
    }
    if (row.lastText !== "") {
      const preview = row.lastText.length > 600 ? `${row.lastText.slice(0, 600)}…` : row.lastText;
      // The last-message preview is raw transcript text → mdText.
      md.appendMarkdown(`---\n\n`);
      this.mdText(md, preview);
    }
    item.tooltip = md;

    item.command = {
      command: "sessionDeck.openSession",
      title: "Show Last Message",
      arguments: [node],
    };
    return item;
  }

  /** {light,dark} SVG Uris for a brand mark under media/ (cursor/codex rows). The
   *  tree can't spin an SVG, so working-state shows via the description age; the
   *  webview panel animates the same mark. */
  private brandIcon(brand: BrandIcon): { light: vscode.Uri; dark: vscode.Uri } {
    const uri = (theme: string): vscode.Uri =>
      vscode.Uri.joinPath(this.extensionUri, "media", `${brand}-${theme}.svg`);
    return { light: uri("light"), dark: uri("dark") };
  }

  private cursorItem(node: CursorNode): vscode.TreeItem {
    if (node.dimmed) return this.lockedItem("cursor:" + node.row.chatId);
    const { row } = node;
    const item = new vscode.TreeItem(row.name, vscode.TreeItemCollapsibleState.None);
    item.id = `cursor:${row.chatId}#g${this.generation}`;
    // Orphan + demoted rows keep the normal "cursor" contextValue so they inherit the
    // existing hide (= dismiss) and Session Properties menu actions (#53) — the
    // GOAL-C dismiss reuses hideSession rather than a bespoke command.
    item.contextValue = "cursor";
    // age glyphs: ●(unread) + age + ❯ (Cursor sessions are always terminal-run).
    item.description = `${node.unread ? "● " : ""}${fmtAge(row.ageSec)} ❯`;
    item.iconPath = this.brandIcon("cursor");
    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = true;
    const cursorState = node.orphan
      ? "orphaned"
      : node.demoted
        ? "ended CLI run"
        : node.unread
          ? "finished · unread"
          : row.status;
    const vis = terminalStateVisual(row.status, node.unread);
    // ── Header: colored state glyph · name · Cursor Agent (state). Vendor-DB values
    //    (name/mode/cwd) are free text → mdText.
    md.appendMarkdown(`${coloredIcon(vis.icon, vis.color)} **`);
    this.mdText(md, row.name);
    md.appendMarkdown(`** — Cursor Agent (${cursorState})\n\n---\n\n`);
    if (row.mode !== "") {
      md.appendMarkdown(`$(settings-gear) mode: `);
      this.mdText(md, row.mode);
      md.appendMarkdown(`\n\n`);
    }
    md.appendMarkdown(`$(terminal) terminal · $(watch) ${fmtAge(row.ageSec)} ago`);
    if (row.pid !== undefined) md.appendMarkdown(` · pid ${row.pid}`);
    md.appendMarkdown(`\n\n$(key) `);
    this.mdText(md, `chat ${row.chatId}`);
    md.appendMarkdown(`\n\n$(folder) `);
    this.mdText(md, row.cwd);
    // Demoted (ended headless) or orphan rows: dim, and non-clickable — there is no
    // window to focus. Mirrors the codex demoted rendering exactly.
    if (node.demoted) {
      item.resourceUri = dimResourceUri("cursor:" + row.chatId);
      md.appendMarkdown(
        node.orphan
          ? `\n\n$(circle-slash) _(orphaned — working folder deleted)_`
          : `\n\n$(circle-slash) _(ended CLI run — not in a window)_`
      );
    }
    item.tooltip = md;
    if (!node.demoted) {
      item.command = {
        command: "sessionDeck.openCursor",
        title: "Focus Cursor Agent",
        arguments: [node],
      };
    }
    return item;
  }

  private composerItem(node: ComposerNode): vscode.TreeItem {
    if (node.dimmed) return this.lockedItem("composer:" + node.row.conversationId);
    const { row } = node;
    const item = new vscode.TreeItem(row.name, vscode.TreeItemCollapsibleState.None);
    item.id = `composer:${row.conversationId}#g${this.generation}`;
    item.contextValue = "composerSession";
    item.description = `${node.unread ? "● " : ""}${composerDescription(row)}`;
    const visual = composerVisual(row.status === "working");
    item.iconPath = new vscode.ThemeIcon(visual.spin ? `${visual.icon}~spin` : visual.icon, visual.color ? new vscode.ThemeColor(visual.color) : undefined);
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${row.status}** · mode: ${row.mode || "unknown"} · background: ${row.isBackground ? "yes" : "no"}`);
    if (row.caption) md.appendMarkdown(`\n\n${row.caption}`);
    if (row.tokens) md.appendMarkdown(`\n\nTokens: input ${row.tokens.input} · output ${row.tokens.output} · cache read ${row.tokens.cacheRead} · cache write ${row.tokens.cacheWrite}`);
    item.tooltip = md;
    item.command = { command: "sessionDeck.openComposer", title: "Show Composer Session Details", arguments: [node] };
    return item;
  }

  /** The row's display title (same as the tree label), for dialogs. */
  sessionTitle(row: SessionRow): string {
    return sanitizeReason(this.titleWithFallback(row, row.meta.name ?? row.meta.sessionId.slice(0, 8)), 80);
  }

  /** Where a Claude session's process runs (editor / tmux / outside / unknown). */
  locationOf(row: SessionRow): LocationVerdict {
    return sessionLocation(row.meta.pid, row.meta.procStart, row.meta.entrypoint, this.familyRoots, {
      editorPids: this.terminalPids,
      startedAt: row.meta.startedAt,
    });
  }

  /** Where a Codex session runs. Only a live, interactive, user-run session gets a
   *  verdict: exec runs and agent-spawned runs end on their own and are not moved. */
  codexLocationOf(row: CodexRow): LocationVerdict {
    if (!row.live || row.pid === undefined || row.external || row.kind !== "codex") return { location: "unknown" };
    if (row.parentClaudePid !== undefined) return { location: "unknown" };
    // The census pairs pid and rollout by folder; only a pid that holds this
    // rollout open is provably this session.
    if (!pidHasOpen(row.pid, row.rolloutPath)) return { location: "unknown" };
    return sessionLocation(row.pid, undefined, undefined, this.familyRoots, { editorPids: this.terminalPids });
  }

  private codexItem(node: CodexNode): vscode.TreeItem {
    if (node.dimmed) return this.lockedItem("codex:" + node.row.id);
    const { row } = node;
    const item = new vscode.TreeItem(row.name, vscode.TreeItemCollapsibleState.None);
    item.id = `codex:${row.id}#g${this.generation}`;
    // Orphan + demoted rows keep the normal "codex" contextValue so they inherit the
    // existing hide (= dismiss) and Session Properties menu actions (#53).
    // An outside interactive run gets "codex-outside" (menus match /^codex/), which
    // adds the move action.
    const loc = node.demoted ? { location: "unknown" as const } : this.codexLocationOf(row);
    const outside = loc.location === "outside";
    // A run whose place is known gets "codex-stop": Stop Session.
    item.contextValue = outside ? "codex-outside" : loc.location !== "unknown" ? "codex-stop" : "codex";
    // age glyphs: ●(unread) + age + ❯ (Codex sessions are always terminal-run). A
    // finished-unread row also says WHAT it finished (last_agent_message snippet).
    const codexCaption = doneCaption(node.unread, row.lastAgentMessage);
    if (outside) item.resourceUri = outsideResourceUri("codex:" + row.id);
    item.description = `${node.unread ? "● " : ""}${fmtAge(row.ageSec)} ❯${codexCaption !== undefined ? ` · ${codexCaption}` : ""}`;
    item.iconPath = this.brandIcon("codex");
    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = true;
    const codexState = node.orphan ? "orphaned" : node.unread ? "finished · unread" : row.status;
    const vis = terminalStateVisual(row.status, node.unread);
    // ── Header: colored state glyph · name · kind (state). Rollout-file values
    //    (name/kind/originator/model/provider/cwd/subagent) are free text → mdText.
    md.appendMarkdown(`${coloredIcon(vis.icon, vis.color)} **`);
    this.mdText(md, row.name);
    md.appendMarkdown(`** — `);
    this.mdText(md, row.kind);
    md.appendMarkdown(` (${codexState})\n\n---\n\n`);
    // A Codex subagent (e.g. a `review` helper) shares its parent's cwd/project;
    // surface the role + parent so it reads as a child of that session, not a peer.
    if (row.subagentRole !== "") {
      md.appendMarkdown(`$(git-branch) subagent: `);
      this.mdText(md, row.subagentRole);
      if (row.parentId !== "") {
        md.appendMarkdown(` of `);
        this.mdText(md, row.parentId);
      }
      md.appendMarkdown(`\n\n`);
    }
    if (row.originator !== "") {
      md.appendMarkdown(`$(person) originator: `);
      this.mdText(md, row.originator);
      md.appendMarkdown(`\n\n`);
    }
    if (row.model !== "" || row.modelProvider !== "") {
      md.appendMarkdown(`$(dashboard) `);
      const parts: string[] = [];
      if (row.model !== "") parts.push(shortModel(row.model));
      if (row.modelProvider !== "") parts.push(row.modelProvider);
      this.mdText(md, parts.join(" · "));
      md.appendMarkdown(`\n\n`);
    }
    // Outside: say so, not "terminal" (the next line says where it runs).
    md.appendMarkdown(`${outside ? "$(link-external)" : "$(terminal)"} ${cliKindWord(outside)} · $(watch) ${fmtAge(row.ageSec)} ago`);
    if (row.pid !== undefined) md.appendMarkdown(` · pid ${row.pid}`);
    if (outside) {
      md.appendMarkdown(`\n\n$(link-external) `);
      this.mdText(md, outsideSentence(loc));
    }
    md.appendMarkdown(`\n\n$(key) `);
    this.mdText(md, `session ${row.id}`);
    md.appendMarkdown(`\n\n$(folder) `);
    this.mdText(md, row.cwd);
    if (node.demoted) {
      item.resourceUri = dimResourceUri("codex:" + row.id);
      md.appendMarkdown(
        node.orphan
          ? `\n\n$(circle-slash) _(orphaned — working folder deleted)_`
          : `\n\n$(circle-slash) _(ended CLI run — not in a window)_`
      );
    }
    item.tooltip = md;
    if (!node.demoted) {
      item.command = {
        command: "sessionDeck.openCodex",
        title: "Focus Codex Session",
        arguments: [node],
      };
    }
    return item;
  }

  /** Open a file (workflow journal / agent transcript) in the editor on click. */
  private openFileCommand(path: string): vscode.Command {
    return { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(path)] };
  }

  private hover(title: string, path: string, lines: string[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${title}**\n\n`);
    for (const l of lines) md.appendMarkdown(`${l}\n\n`);
    md.appendMarkdown(`\`${path}\``);
    return md;
  }

  private workflowItem(node: WorkflowNode): vscode.TreeItem {
    const wf = node.detail;
    const item = new vscode.TreeItem(
      `wf ${wf.label}`,
      wf.agents.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.id = `${wf.path}#g${this.generation}`;
    item.contextValue = "activity-workflow";
    const state = wf.running ? `running · ${plural(wf.runningAgents, "agent")}` : "done";
    item.description = `${fmtAge(wf.ageSec)} · ${state}`;
    item.iconPath = themeIcon(workflowVisual(wf.running));
    item.tooltip = this.hover(`workflow ${wf.id}`, wf.path, [
      wf.running ? `$(sync) running · ${plural(wf.runningAgents, "agent")}` : "$(check) done",
      `${plural(wf.agents.length, "agent")} · last activity ${fmtAge(wf.ageSec)} ago`,
    ]);
    item.command = this.openFileCommand(wf.path);
    return item;
  }

  private agentItem(node: AgentNode): vscode.TreeItem {
    const a = node.detail;
    const item = new vscode.TreeItem(a.label, vscode.TreeItemCollapsibleState.None);
    item.id = `${a.path}#g${this.generation}`;
    item.contextValue = "activity-agent";
    const clause = this.agentUsageClause(a);
    // External-model attribution (Goal B): a wrapper subagent labelled "gpt-5.5: …",
    // "grok-4.5: …", "codex: …" only drives an external CLI, so surface that id as a
    // leading badge (⚙ <id>). It is still a Claude subagent — the tooltip says so and
    // the usage clause below keeps showing the wrapper's real Claude model/tokens.
    const ext = externalModelFromLabel(a.label);
    const badge = ext !== undefined ? `⚙ ${ext} · ` : "";
    item.description = `${badge}${fmtAge(a.ageSec)} · ${a.running ? "running" : "done"}${clause !== undefined ? ` · ${clause}` : ""}`;
    item.iconPath = themeIcon(agentVisual(a.running));
    item.tooltip = this.hover(a.label, a.path, [
      a.running ? "$(sync) running" : "$(check) done",
      `last activity ${fmtAge(a.ageSec)} ago`,
      ...(ext !== undefined ? [`$(server-process) external model: ${ext} (driven by this Claude subagent)`] : []),
      ...(clause !== undefined ? [clause] : []),
    ]);
    item.command = this.openFileCommand(a.path);
    return item;
  }

  private taskItem(node: TaskNode): vscode.TreeItem {
    const t = node.detail;
    const item = new vscode.TreeItem(t.subject, vscode.TreeItemCollapsibleState.None);
    item.id = `${t.path}#g${this.generation}`;
    item.contextValue = "activity-task";
    if (t.status === "in_progress") item.description = "active";
    else if (t.status !== "pending" && t.status !== "completed") item.description = t.status;
    item.iconPath = themeIcon(taskVisual(t.status));
    const lines = [`$(list-ordered) task ${t.id} · ${t.status.replace(/_/g, " ")}`];
    if (t.description !== undefined && t.description !== "") lines.push(t.description);
    item.tooltip = this.hover(t.subject, t.path, lines);
    return item;
  }
}

// ---- row clicks that survive a refresh ----------------------------------------
// Row clicks that survive a tree refresh.
//
// VS Code keeps a tree item's command arguments in the extension host under a
// per-render id ("sessionDeck.focusRemoteSession /36") and drops them the moment
// the provider fires a full refresh, before the window has fetched the new rows.
// A click on a row still on screen in that gap fails inside VS Code with "Actual
// command not found, wanted to execute …" and never reaches us. In a remote
// window the gap is a network round trip per refresh, and on a busy host the tree
// refreshes every few seconds, so clicks failed often.
//
// The fix: rows carry an argument-free command (nothing for VS Code to drop), and
// the handler finds the row through the view's selection, which VS Code sends
// before running a click's command and resolves by item id against the CURRENT
// render. The real command and arguments are kept here per element.

/** The slice of TreeView that revealWhenVisible uses. */
export interface RevealView<T> {
  readonly visible: boolean;
  reveal(element: T, options: { expand: boolean; select: boolean; focus: boolean }): Thenable<void>;
  onDidChangeVisibility(listener: (e: { visible: boolean }) => void): vscode.Disposable;
}

/** Open groups through `view.reveal(expand)`, but only while the view is visible:
 *  the editor's reveal opens the view first ($reveal → openView), so revealing
 *  while it is hidden would bring the Sessions view back over whatever the user
 *  is looking at. A request made while hidden, or a reveal that failed, waits and
 *  is replayed when the view next becomes visible; a row gone by then is dropped. */
export function revealWhenVisible<T>(
  view: RevealView<T>,
  stillThere: (element: T) => boolean
): { expand: (element: T) => void; dispose: () => void } {
  const pending = new Set<T>();
  const flush = (): void => {
    if (!view.visible) return;
    for (const el of [...pending]) {
      pending.delete(el);
      if (!stillThere(el)) continue;
      Promise.resolve(view.reveal(el, { expand: true, select: false, focus: false })).catch(() => pending.add(el));
    }
  };
  const sub = view.onDidChangeVisibility(() => flush());
  return {
    expand: (el) => {
      pending.add(el);
      flush();
    },
    dispose: () => sub.dispose(),
  };
}

export const ROW_CLICK_CMD = "sessionDeck.rowClick";

export class RowClickIndex<T extends object> {
  private byElement = new WeakMap<T, vscode.Command>();

  /** Swap an argument-bearing row command for the argument-free one, keeping the
   *  original for `commandFor`. Only `vscode.open` is left alone: VS Code passes an
   *  API command's arguments inline instead of caching them. */
  wrap(item: vscode.TreeItem, element: T): vscode.TreeItem {
    const cmd = item.command;
    if (cmd === undefined || cmd.arguments === undefined || cmd.arguments.length === 0) return item;
    if (cmd.command === "vscode.open") return item; // an API command: arguments travel inline
    this.byElement.set(element, cmd);
    item.command = { command: ROW_CLICK_CMD, title: cmd.title, tooltip: cmd.tooltip };
    return item;
  }

  commandFor(element: T | undefined): vscode.Command | undefined {
    return element === undefined ? undefined : this.byElement.get(element);
  }
}

/** The provider the view is given: the same rows, with click commands wrapped. */
export function clickSafeProvider<T extends object>(
  inner: vscode.TreeDataProvider<T>,
  index: RowClickIndex<T>
): vscode.TreeDataProvider<T> {
  const out: vscode.TreeDataProvider<T> = {
    onDidChangeTreeData: inner.onDidChangeTreeData,
    getChildren: (element?: T) => inner.getChildren(element),
    getTreeItem: (element: T) => {
      const item = inner.getTreeItem(element);
      if (typeof (item as Thenable<vscode.TreeItem>).then === "function") {
        return Promise.resolve(item).then((i) => index.wrap(i, element));
      }
      return index.wrap(item as vscode.TreeItem, element);
    },
  };
  if (inner.getParent !== undefined) {
    const getParent = inner.getParent.bind(inner);
    out.getParent = (element: T) => getParent(element);
  }
  return out;
}

/** What a click on the row should run, or the message to show when the row the
 *  user clicked is gone from the current render (it was redrawn mid-click). */
export function rowClickTarget<T extends object>(
  selection: readonly T[],
  index: RowClickIndex<T>
): { command: vscode.Command } | { message: string } {
  const cmd = selection.length === 1 ? index.commandFor(selection[0]) : undefined;
  if (cmd !== undefined) return { command: cmd };
  return { message: "SessionDeck: the list was redrawn as you clicked, so that click was lost. Click the row again." };
}
