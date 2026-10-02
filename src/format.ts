// Pure, vscode-free formatting helpers shared by the sidebar tree (tree.ts) and
// the floating webview panel (panel.ts). Keeping these rules in one place means a
// session renders identically in both surfaces. No vscode import: only discovery
// types and plain string work live here.
import { SessionRow, Status, SubActivity, fmtAge } from "./discovery";
import type { ComposerRow } from "./cursor";

export type StatusKind = "attention" | "question" | "working" | "unread" | "done" | "idle";

export interface SessionFlags {
  status: SessionRow["status"];
  unread: boolean;
  attention: boolean;
  /** Tail is a still-open AskUserQuestion/ExitPlanMode gate — reads as "needs
   *  answer", distinct from a permission `attention` and from plain `waiting`.
   *  Optional so remote/synthetic flag objects can omit it (treated as false). */
  pendingQuestion?: boolean;
}

/** Single source of truth for a session's visual status bucket. The tree derives
 *  its icon separately (it distinguishes orchestrating vs plain working), but the
 *  human phrase and the panel's status dot both key off this. */
export function statusKind(f: SessionFlags): StatusKind {
  if (f.attention) return "attention";
  // A pending question outranks working/waiting: the session is blocked on the
  // user and must read as "needs answer" whether or not it has been seen yet.
  if (f.pendingQuestion === true) return "question";
  if (f.status === "working") return "working";
  if (f.status === "waiting") return f.unread ? "unread" : "done";
  return "idle";
}

/** Human status phrase used by tree hovers, project one-liners and the panel. */
export function statusPhrase(f: SessionFlags): string {
  switch (statusKind(f)) {
    case "attention":
      return "needs approval";
    case "question":
      return "needs answer";
    case "working":
      return "working";
    case "unread":
      return "done, unread";
    case "done":
      return "done";
    case "idle":
      return "idle";
  }
}

/** Status bucket for a terminal (Cursor/Codex) row, which has no approval/question
 *  concept: unread → "unread", else working → "working", else "done". Pure. */
export function terminalStatusKind(working: boolean, unread: boolean): StatusKind {
  if (unread) return "unread";
  if (working) return "working";
  return "done";
}

export type AgentFamily = "claude" | "cursor" | "codex";
export const AGENT_FAMILIES: readonly AgentFamily[] = ["claude", "cursor", "codex"];
export const AGENT_FAMILY_LABELS: Record<AgentFamily, string> = {
  claude: "Claude",
  cursor: "Cursor",
  codex: "Codex",
};

/** Short, honest badge fragment naming the family filtering, or undefined when no
 *  family is hidden. */
export function agentFamilyBadge(hidden: readonly AgentFamily[]): string | undefined {
  const hiddenSet = AGENT_FAMILIES.filter((f) => hidden.includes(f));
  if (hiddenSet.length === 0) return undefined;
  const visible = AGENT_FAMILIES.filter((f) => !hiddenSet.includes(f));
  if (visible.length === 0) return "none shown";
  if (visible.length === 1) return `${visible[0]} only`;
  return `${hiddenSet.join("+")} hidden`;
}

/** A filter mode other than "all", or hidden agent family, is active (drives the filled toolbar icon). Pure. */
export function filterIsActive(mode: string, hidden: readonly AgentFamily[] = []): boolean {
  return mode !== "all" || hidden.length > 0;
}

/** The dim badge label shown next to the view title naming the active filter, or
 *  undefined for "all". Pure single source for the toolbar indicator text. */
export function filterBadgeLabel(mode: string, hidden: readonly AgentFamily[] = []): string | undefined {
  const time = (() => {
    switch (mode) {
      case "1h": return "last hour";
      case "24h": return "last 24h";
      case "attention": return "needs attention";
      default: return undefined;
    }
  })();
  const fam = agentFamilyBadge(hidden);
  if (time !== undefined && fam !== undefined) return `${time} · ${fam}`;
  return time ?? fam;
}

// ---- Fleet-heat sort ---------------------------------------------------------
// A project's "attention pressure": how loudly its sessions are asking for you.
// Deliberately explainable (opacity is this feature's stated risk) — a project's
// score is a plain weighted count of its needs-you rows plus a tiny recency
// nudge, nothing hidden:
//   attention / question  (blocked ON YOU) ..... 10   heaviest — you are the blocker
//   unread   (finished, not yet seen) ...........  4   medium
//   working  (running, may need you soon) .......  1   light
//   done / idle .................................  0   no pressure
// Plus a recency term in [0, HEAT_RECENCY_MAX): +HEAT_RECENCY_MAX at 0 min old,
// decaying linearly to 0 at HEAT_RECENCY_WINDOW_MIN minutes since the project's
// newest activity. Capped strictly below the smallest real weight (1) so it only
// ever breaks ties between equally-pressured projects — a single working row
// always outranks pure recency. MINUTE-granular by construction (the caller feeds
// whole minutes) so a sub-minute session cannot jitter the score every 3s quiet
// tick, which would churn the sort order and defeat the change-signature.
export const HEAT_WEIGHTS = { attention: 10, unread: 4, working: 1 } as const;
export const HEAT_RECENCY_MAX = 0.9;
export const HEAT_RECENCY_WINDOW_MIN = 60;

export interface HeatConstituents {
  /** statusKind of every session-like row (Claude/Cursor/Codex) in the project. */
  kinds: StatusKind[];
  /** Whole minutes since the project's newest activity. Floor of seconds/60 so the
   *  recency term is minute-granular and stable across sub-minute quiet ticks;
   *  null (no datable activity) contributes zero recency. */
  ageMin: number | null;
}

/** Pure attention-pressure score for one project (see block comment for weights).
 *  Higher floats higher in the "heat" sort. Equal scores keep the caller's order
 *  (the caller uses a stable sort), so ties are resolved by prior position. */
export function fleetHeatScore(c: HeatConstituents): number {
  let score = 0;
  for (const k of c.kinds) {
    if (k === "attention" || k === "question") score += HEAT_WEIGHTS.attention;
    else if (k === "unread") score += HEAT_WEIGHTS.unread;
    else if (k === "working") score += HEAT_WEIGHTS.working;
    // "done" and "idle" add nothing — a project with only those exerts no pressure.
  }
  if (c.ageMin !== null) {
    const recency = HEAT_RECENCY_MAX * (1 - c.ageMin / HEAT_RECENCY_WINDOW_MIN);
    if (recency > 0) score += recency;
  }
  return score;
}

// ---- Compact fleet density ---------------------------------------------------
// A view-density toggle for big fleets: "comfortable" is today's fully-expanded
// tree; "compact" collapses project rows by default and folds an at-a-glance
// pressure summary into each project's description, so 30 agents across many
// projects stop being a cognitive wall. Presentation only — the same rows, just
// folded — so both seams below are pure and shared by the tree and the panel.

export type Density = "comfortable" | "compact";

/** Whether a project row starts EXPANDED. An explicit collapse-all / expand-all
 *  override (true = all collapsed, false = all expanded) always wins; otherwise
 *  comfortable is always expanded and compact starts collapsed EXCEPT when the
 *  project has needs-you rows — the "which one needs me is never buried" covenant,
 *  so an attention/question row auto-expands its project. Pure predicate. */
export function projectExpanded(
  density: Density,
  override: boolean | undefined,
  needsYou: number
): boolean {
  if (override !== undefined) return !override;
  return density === "comfortable" || needsYou > 0;
}

/** Whether a LOCAL session row counts as needs-you (blocked-on-you) for the compact
 *  pressure count + auto-expand: an attention (permission) or pending-question row.
 *  Free-tier-dimmed rows are excluded — they're out of supervision everywhere
 *  (badge/alerts/triage), so the 🔔 count matches the badge and a license-gated row
 *  can never force a project to auto-expand. Pure. */
export function localNeedsYou(row: {
  attention: boolean;
  pendingQuestion?: boolean;
  dimmed?: boolean;
}): boolean {
  return row.dimmed !== true && (row.attention || row.pendingQuestion === true);
}

/** Whether a REMOTE session row counts as LIVE needs-you: attention on a non-stale
 *  host. Stale hosts are last-known, never live attention — excluded here just as
 *  they are from the compact remote working count and everywhere else stale rows are
 *  treated as not-live. Pure. */
export function remoteNeedsYou(row: { attention: boolean; stale: boolean }): boolean {
  return row.stale !== true && row.attention === true;
}

/** The webview toggle-set key a compact project/host/remote-project row's manual
 *  expand/collapse is stored under. The floating panel's expand state is viewer-side
 *  (persisted in the webview), and its default open-state depends on needs-you in
 *  compact mode — so the needs-you state is folded into the key: a needs-you
 *  onset/resolution flips the key, forgetting the now-stale toggle so the row follows
 *  the NEW default. That is what stops a manually-expanded quiet project from being
 *  collapsed shut the instant it comes to need you. Comfortable's default is always
 *  open, so the key stays stable (a manual collapse persists across needs-you
 *  changes). Pure; the panel.ts webview script mirrors this exactly. */
export function panelToggleKey(density: Density, needsYou: number, baseKey: string): string {
  return density === "compact" ? `${baseKey}|${needsYou > 0 ? "n" : "q"}` : baseKey;
}

/** Effective open-state of a panel row = the density default XOR whether the user has
 *  an explicit toggle recorded under this row's (needs-you-folded) key. Pure mirror of
 *  the panel.ts webview logic, so the onset-after-manual-toggle contract is unit-
 *  testable: force-open once per needs-you onset, manual toggle respected between
 *  onsets, quiet default (collapsed) restored on resolution. */
export function panelRowOpen(
  density: Density,
  needsYou: number,
  toggled: ReadonlySet<string>,
  baseKey: string
): boolean {
  const defaultOpen = density === "compact" ? needsYou > 0 : true;
  const key = panelToggleKey(density, needsYou, baseKey);
  return toggled.has(key) ? !defaultOpen : defaultOpen;
}

/** The counts a compact project description folds in — all already derived by the
 *  reload (no new I/O or classification). */
export interface PressureCounts {
  /** attention + pending-question rows (the blocked-on-you set). */
  needsYou: number;
  /** total session-like rows (Claude + Cursor + Codex). */
  total: number;
  working: number;
  unread: number;
  /** seconds since the project's newest activity, or null when undatable. */
  newestAgeSec: number | null;
}

/** The at-a-glance pressure summary shown as a collapsed project's description in
 *  compact mode: needs-you first (🔔N, only when >0), then the total row count,
 *  the working (↻N) and unread (●N) counts when non-zero, and the newest age. So a
 *  folded project still says how loudly it wants you without being opened. Pure;
 *  shared by the sidebar tree and the floating panel so both read identically. */
export function compactProjectDescription(c: PressureCounts): string {
  const parts: string[] = [];
  if (c.needsYou > 0) parts.push(`🔔${c.needsYou}`);
  parts.push(String(c.total));
  if (c.working > 0) parts.push(`↻${c.working}`);
  if (c.unread > 0) parts.push(`●${c.unread}`);
  if (c.newestAgeSec !== null && Number.isFinite(c.newestAgeSec)) parts.push(fmtAge(c.newestAgeSec));
  return parts.join(" · ");
}

// ---- Git worktree grouping (Goal A) -----------------------------------------
// A project directory can be a *linked git worktree* of another checkout on this
// machine (its `.git` is a FILE pointing at <mainRoot>/.git/worktrees/<name>).
// discovery.ts resolves that link cheaply (one cached readFile); this pure planner
// takes the flat, already-sorted project cwds plus a worktree lookup and produces
// the TOP-LEVEL topology: each real (non-worktree) project stays a top row, each
// worktree nests under its main repo's row, and a main repo with no sessions of its
// own but live worktrees is synthesized as a parent so its worktrees are never
// orphaned. Order-preserving: a parent is emitted at the position it (or its first
// worktree child) first appears, exactly once. Vscode-free so it unit-tests.

/** The resolved worktree link for a project directory. */
export interface WorktreeLink {
  /** Absolute path to the MAIN working tree this worktree belongs to. */
  mainRoot: string;
  /** Branch name (or short detached SHA) the worktree has checked out. */
  branch: string;
}

/** One top-level row in the worktree-grouped tree. */
export interface WorktreeGroup {
  /** cwd of this top row — a real project's cwd, or a synthetic main-repo cwd. */
  cwd: string;
  /** True when NO real project exists at `cwd`: a synthetic main-repo parent whose
   *  only reason to exist is to host worktree children. */
  synthetic: boolean;
  /** Worktree child cwds nested under this row, in the input order. */
  worktrees: string[];
  /** Branch for each worktree child (parallel array to `worktrees`). */
  branches: string[];
}

/** Plan the worktree-grouped top level from the flat, pre-sorted project cwd list.
 *  `lookup(cwd)` returns a {@link WorktreeLink} when that dir is a linked worktree,
 *  else undefined (a normal checkout / non-repo). Pure and order-preserving. */
export function planWorktreeGroups(
  projectCwds: string[],
  lookup: (cwd: string) => WorktreeLink | undefined
): WorktreeGroup[] {
  const links = projectCwds.map((cwd) => lookup(cwd));
  // Real (non-worktree) projects that can serve as parents, by cwd.
  const realCwds = new Set<string>();
  projectCwds.forEach((cwd, i) => {
    if (links[i] === undefined) realCwds.add(cwd);
  });
  const out: WorktreeGroup[] = [];
  const byCwd = new Map<string, WorktreeGroup>();
  const emit = (cwd: string, synthetic: boolean): WorktreeGroup => {
    let g = byCwd.get(cwd);
    if (g === undefined) {
      g = { cwd, synthetic, worktrees: [], branches: [] };
      byCwd.set(cwd, g);
      out.push(g);
    }
    return g;
  };
  projectCwds.forEach((cwd, i) => {
    const link = links[i];
    if (link === undefined) {
      emit(cwd, false); // real project → its own top row (at its sorted position)
      return;
    }
    // Worktree: attach under its main repo (real parent if present, else synthetic).
    const parent = emit(link.mainRoot, !realCwds.has(link.mainRoot));
    parent.worktrees.push(cwd);
    parent.branches.push(link.branch);
  });
  return out;
}

// ---- External-model attribution for wrapper subagents (Goal B) --------------
// The orchestration convention on this machine labels a Claude subagent that only
// drives an external CLI with a model prefix: "gpt-5.5: …", "gpt-5.6-sol: …",
// "grok-4.5: …", "codex: …". Surfacing that prefix as the row's EFFECTIVE model is
// cheap and reliable — the wrapper is still a Claude agent, so callers render it as
// a distinct badge (never overwriting the honest "this is a Claude subagent" frame).

/** The external model id a wrapper-subagent label declares (e.g. "gpt-5.5",
 *  "grok-4.5", "gpt-5.6-sol", "codex"), lower-cased, or undefined when the label is
 *  a normal Claude subagent. Matches only the leading `"<id>:"` prefix so a mention
 *  of a model deeper in the description never false-positives. Pure + tested. */
export function externalModelFromLabel(label: string): string | undefined {
  const m = /^\s*(gpt-[\w.-]+|grok-[\w.-]+|codex)\s*:/i.exec(label);
  return m !== null ? m[1].toLowerCase() : undefined;
}

// ---- Column layout (sessionDeck.layout) ----------------------------------
// A view-layout toggle orthogonal to density: "list" is today's inline description
// flow (age + glyphs + a trailing glance); "columns" renders the session row's core
// facts — time, status, model, tokens — as strictly-ORDERED, consistently-delimited
// slots so they line up semantically down the list. The native TreeView can't do
// true proportional columns (no tab stops), so the tree gets ordered slots (every
// slot present, `—` when empty) and the webview panel (panel.ts) gets a real CSS
// grid with headers. Both read from the same pure builders here.

export type Layout = "list" | "columns";

/** Sort: Name order for project rows. Rows show the folder's last path segment, so
 *  that is what sorts (case-insensitively), with the full path only as a tiebreak.
 *  Sorting on the full cwd put worktrees in another parent folder out of visible
 *  order. Handles `/` and `\\` separators (remote hosts may be Windows). */
export function compareProjectNames(aCwd: string, bCwd: string): number {
  const name = (cwd: string): string => cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? cwd;
  const byName = name(aCwd).localeCompare(name(bCwd), undefined, { sensitivity: "base" });
  return byName !== 0 ? byName : aCwd.localeCompare(bCwd);
}

/** Which surface Collapse All / Expand All act on. Decided by the layout setting
 *  (which also decides which view is shown), never by a webview's `visible` flag:
 *  after a columns → list switch the hidden table can still report visible, and the
 *  command then collapsed the invisible table while the list tree stayed open. */
export function collapseTarget(layout: Layout): "table" | "tree" {
  return layout === "columns" ? "table" : "tree";
}

/** Placeholder for an empty column cell, so every row shows the same number of
 *  slots in the same order and the eye can still track a column even without pixel
 *  alignment. */
export const COL_EMPTY = "—";

/** Ordered header labels for the session columns, in slot order. The panel grid
 *  renders these as a header row; the tree has no header (VS Code TreeView can't),
 *  so the fixed order is what carries the "which field is this" meaning there. */
export const SESSION_COLUMN_HEADERS = ["Session", "Time", "Status", "Model", "Tokens"] as const;

/** The already-resolved cell values for one session row in "columns" layout. Time
 *  carries the age plus any dim glyphs (⚙N ❯) the list mode also shows, so the
 *  glyphs aren't lost when columns take over the description; status is the human
 *  phrase; model/tokens come from the token scanner (undefined until resolved / when
 *  unwired). */
export interface SessionColumnFields {
  time: string;
  status: string;
  model?: string;
  tokens?: string;
}

/** The four data cells (time, status, model, tokens) for a session row, each slot
 *  always present (`—` when empty) and in a fixed order. The panel grid places one
 *  cell per column; the tree joins them (below). The session title is the row label
 *  itself, so it is NOT a cell here (it is the 1st header only). Pure. */
export function sessionColumnCells(f: SessionColumnFields): [string, string, string, string] {
  return [f.time, f.status, f.model ?? COL_EMPTY, f.tokens ?? COL_EMPTY];
}

/** The tree's "columns"-layout `TreeItem.description`: the four ordered cells joined
 *  by " · ". Not pixel-aligned (proportional font), but strictly ordered and fully
 *  slotted so the same field sits in the same position on every row. Pure; shared by
 *  the sidebar tree so its column mode matches the panel grid's column order. */
export function sessionColumnsDescription(f: SessionColumnFields): string {
  return sessionColumnCells(f).join(" · ");
}

/** The "doing now" caption that trails a WORKING session row: a dim one-line hint
 *  of what the session is actually doing, so a working row says more than "spinner
 *  + age + ⚙N". Source priority: (1) the in-progress task's activeForm
 *  (`currentTask`) — human phrasing, slow-moving; (2) else the name of the pending
 *  tool it is running (Bash/Edit/Task/…). Returns undefined on any non-working row
 *  and when neither source exists, so callers append it only when present. The text
 *  is cleaned + truncated (~40) through sanitizeReason — the same treatment the
 *  blocked-reason glance uses — and never carries tool input/arguments. Pure seam,
 *  shared by the sidebar tree and the floating panel so both render identically. */
export function workingCaption(
  kind: StatusKind,
  currentTask: string | undefined,
  pendingToolName: string | undefined
): string | undefined {
  if (kind !== "working") return undefined;
  const source = currentTask !== undefined && currentTask !== "" ? currentTask : pendingToolName;
  if (source === undefined || source === "") return undefined;
  const caption = sanitizeReason(source, 40);
  return caption === "" ? undefined : caption;
}

/** The "done" caption that trails a FINISHED-UNREAD row: a sanitized one-line
 *  snippet of the session's final message, so a finished-unread row (● + age) says
 *  WHAT it finished, mirroring the working row's "doing now" caption. Gated on
 *  `finishedUnread` — only the unread bucket gets it; done-read and idle rows are
 *  settled, so the extra text there would be noise (and a blocked row already shows
 *  its reason/question glance). Empty/whitespace tail → undefined, so an empty final
 *  message never leaves a dangling separator. Text runs through sanitizeReason (the
 *  same 48-char clean+truncate the reason glance uses). Pure seam, shared by the
 *  sidebar tree and the floating panel so both render identically; the caller owns
 *  the finished-unread test (StatusKind === "unread" for Claude sessions, the raw
 *  unread flag for Codex rows). */
export function doneCaption(finishedUnread: boolean, lastText: string | undefined): string | undefined {
  if (!finishedUnread || lastText === undefined) return undefined;
  const caption = sanitizeReason(lastText, 48);
  return caption === "" ? undefined : caption;
}

// ---- Quiet-too-long hint (staleness split, cycle 17) ------------------------
// A working row driven by a pending tool_use reads "working" for up to 1800s of
// transcript silence — so genuinely-wedged work (a hung tool, or a permission
// prompt no hook surfaced) can read as progressing for nearly half an hour. But
// how long silence is *legitimate* depends entirely on the tool. Evidence (this
// machine, 84,197 real tool_use→tool_result completions):
//
//   QUICK tools (Read/Edit/Write/Grep/…): n=35,968, max gap 194.7s, ZERO exceed
//     300s (0/35,968). A quick tool still pending after 5 min has no legitimate
//     precedent — it is almost certainly wedged.
//   PATIENT tools (Bash/Task/Agent/WebFetch/…): n=48,256, p99.9=582s; Bash
//     background runs reach *hours*, Agent runs 20+ min. Only 34/48,256 (0.07%)
//     exceed 900s. These legitimately run long, so they keep the long window.
//
// So the hint is per-class: a working row that has been silent past its class
// threshold gains a dim "quiet Xm" suffix (hover: "may be stalled"). It is an
// OBSERVE-ONLY glance — the row keeps spinning, the status never changes, no alert
// fires. A late hint on a genuinely-slow tool is harmless; believing dead work is
// alive is the failure we are guarding against.

/** Quick tools whose legitimate tool_use→tool_result gap is proven short (0 of
 *  35,968 real completions exceed 300s). An explicit allowlist: anything NOT here
 *  — Bash, Task/Agent, WebFetch/WebSearch, Skill, unknown/MCP tools — is treated
 *  as PATIENT (the long threshold), so an unfamiliar or deliberately long-running
 *  tool is never flagged early. */
const QUICK_TOOLS = new Set<string>([
  "Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Grep", "Glob", "LS",
  "TodoWrite", "ToolSearch", "StructuredOutput", "TaskUpdate", "TaskGet",
  "TaskCreate", "TaskList", "SendUserFile", "EnterPlanMode", "EnterWorktree",
  "ExitWorktree", "TaskStop", "ScheduleWakeup",
]);

/** Silence past which a QUICK-tool working row reads as quiet-too-long. 5 min —
 *  0/35,968 real quick completions ever reached it (observed max 194.7s). */
export const QUIET_QUICK_SEC = 300;
/** Silence past which a PATIENT-tool working row reads as quiet-too-long. 15 min —
 *  34/48,256 (0.07%) real patient completions exceed it, all long Bash/Agent runs;
 *  the status flips to "waiting" at 1800s regardless, so the hint window is narrow. */
export const QUIET_PATIENT_SEC = 900;

/** Per-class silence threshold (seconds) for the quiet-too-long hint. */
export function quietThresholdSec(pendingToolName: string): number {
  return QUICK_TOOLS.has(pendingToolName) ? QUIET_QUICK_SEC : QUIET_PATIENT_SEC;
}

/** The dim "quiet Xm" hint for a WORKING row whose pending tool_use has gone silent
 *  longer than its per-class expectation — an observe-only "may be stalled" glance
 *  (never a reclassification, never an alert). Returns undefined unless the row is
 *  working, is driven by a pending tool_use (pendingToolName is set ⟺ the transcript
 *  tail is an unresolved assistant tool_use — the only working state with a long
 *  silent window; thinking/text/tool_result/prompt tails settle in ≤300s) and its
 *  age exceeds quietThresholdSec. MINUTE-GRANULAR by construction (`Math.floor`), so
 *  it changes at most once per minute — safe to fold into a change-signature without
 *  reintroducing per-tick churn on quiet ticks. */
export function quietHint(
  kind: StatusKind,
  pendingToolName: string | undefined,
  ageSec: number | null
): string | undefined {
  if (kind !== "working" || pendingToolName === undefined || pendingToolName === "") return undefined;
  if (ageSec === null || ageSec <= quietThresholdSec(pendingToolName)) return undefined;
  const mins = Math.floor(ageSec / 60);
  return mins >= 1 ? `quiet ${mins}m` : undefined;
}

/** The hover explanation for a quiet-too-long working row: "no output for Xm — may
 *  be stalled", or undefined when the quiet hint does not apply. Same gate as
 *  quietHint (so the row suffix and the hover appear together), phrased for a
 *  tooltip. */
export function quietHoverText(
  kind: StatusKind,
  pendingToolName: string | undefined,
  ageSec: number | null
): string | undefined {
  const hint = quietHint(kind, pendingToolName, ageSec);
  if (hint === undefined || ageSec === null) return undefined;
  const mins = Math.floor(ageSec / 60);
  return `no output for ${mins}m — may be stalled`;
}

/** The full trailing clause for a WORKING row: the "doing now" caption plus, when
 *  the row has gone silent past its per-class expectation, the dim "quiet Xm" hint,
 *  joined with " · ". Undefined when neither applies. Shared by the sidebar tree and
 *  the floating panel so the two surfaces render identically. */
export function workingTrailing(
  kind: StatusKind,
  currentTask: string | undefined,
  pendingToolName: string | undefined,
  ageSec: number | null
): string | undefined {
  const caption = workingCaption(kind, currentTask, pendingToolName);
  const quiet = quietHint(kind, pendingToolName, ageSec);
  const parts = [caption, quiet].filter((p): p is string => p !== undefined && p !== "");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Live-agent count shown as ⚙N: direct + workflow agents, falling back to the
 *  workflow count when a workflow is fresh but hasn't reported running agents. */
export function liveAgentCount(act: SubActivity): number {
  let n = act.agents + act.workflowAgents;
  if (n === 0 && act.workflows > 0) n = act.workflows;
  return n;
}

/** Dim glyph parts that trail the age in a session row: ⚙N (live agents),
 *  ❯ (terminal session). Age itself is added by the caller. */
export function glyphParts(row: SessionRow, terminal: boolean): string[] {
  const parts: string[] = [];
  const live = liveAgentCount(row.activity);
  if (live > 0) parts.push(`⚙${live}`);
  if (terminal) parts.push("❯");
  return parts;
}

// ---- Icon visuals: single source of truth for the codicon + color a row shows,
// used by both the sidebar tree (as ThemeIcon) and the webview panel (as a
// codicon-font glyph), so the two surfaces are pixel-faithful. `icon` is the
// codicon/ThemeIcon id (no ~spin suffix); `spin` requests the sync animation.

/** Vendor sessions render a hand-drawn brand mark (an SVG from media/) instead of
 *  a codicon: file Uris in the tree, inline SVG in the webview panel. */
export type BrandIcon = "cursor" | "codex";

export interface IconVisual {
  icon: string;
  /** VS Code theme-color name (e.g. "charts.green"); undefined = default foreground. */
  color?: string;
  spin: boolean;
  /** When set, render the brand SVG (cursor/codex) rather than the `icon` codicon. */
  brand?: BrandIcon;
}

/** Session status icon, matching tree.ts: bell (attention), spinning sync
 *  (working — purple while orchestrating, else green), bell-dot (unread),
 *  check (done), circle-outline (idle). */
export function sessionVisual(kind: StatusKind, orchestrating: boolean): IconVisual {
  switch (kind) {
    case "attention":
      return { icon: "bell", color: "charts.red", spin: false };
    case "question":
      // Blocked on the user: a discussion glyph in a warning-orange, never spinning
      // — reads as "needs your answer", distinct from working (green) and idle.
      return { icon: "comment-discussion", color: "charts.yellow", spin: false };
    case "working":
      return { icon: "sync", color: orchestrating ? "charts.purple" : "charts.green", spin: true };
    case "unread":
      return { icon: "bell-dot", color: "charts.yellow", spin: false };
    case "done":
      return { icon: "check", color: "charts.blue", spin: false };
    case "idle":
      return { icon: "circle-outline", spin: false };
  }
}

/** Workflow icon: rocket (purple) while running, else a plain gear. */
export function workflowVisual(running: boolean): IconVisual {
  return running ? { icon: "rocket", color: "charts.purple", spin: false } : { icon: "gear", spin: false };
}

/** Subagent icon: spinning sync (green) while running, else check (blue). */
export function agentVisual(running: boolean): IconVisual {
  return running
    ? { icon: "sync", color: "charts.green", spin: true }
    : { icon: "check", color: "charts.blue", spin: false };
}

/** Cursor Agent CLI session icon: the Cursor brand mark, spinning while working. */
export function cursorVisual(working: boolean): IconVisual {
  return { icon: "sparkle", spin: working, brand: "cursor" };
}

/** Cursor GUI Composer session icon, distinct from the terminal Cursor brand. */
export function composerVisual(working: boolean): IconVisual {
  return working
    ? { icon: "sync", color: "charts.green", spin: true }
    : { icon: "comment-discussion", spin: false };
}

/** Compact Cursor GUI Composer row description. */
export function composerDescription(row: ComposerRow): string {
  const parts = [row.mode || "composer"];
  if (row.isBackground) parts.push("bg");
  parts.push(row.caption || row.status, fmtAge(row.ageSec));
  return parts.join(" · ");
}

/** Codex CLI session icon: the Codex/OpenAI brand mark, spinning while working. */
export function codexVisual(working: boolean): IconVisual {
  return { icon: "sparkle", spin: working, brand: "codex" };
}

/** The colored status glyph a terminal (Cursor/Codex) session's HOVER leads with —
 *  distinct from the inline row icon (a spinning brand mark): finished-unread →
 *  bell-dot (yellow), working → sync (green), else check (blue). These rows carry no
 *  approval/question concept, so it is a plain 3-way. Pure; shared by both hovers. */
export function terminalStateVisual(status: string, unread: boolean): { icon: string; color: string } {
  if (unread) return { icon: "bell-dot", color: "charts.yellow" };
  if (status === "working") return { icon: "sync", color: "charts.green" };
  return { icon: "check", color: "charts.blue" };
}

/** Task icon: check (completed), play (in progress), circle-outline otherwise. */
export function taskVisual(status: string): IconVisual {
  if (status === "completed") return { icon: "check", color: "charts.blue", spin: false };
  if (status === "in_progress") return { icon: "play", color: "charts.green", spin: false };
  return { icon: "circle-outline", spin: false };
}

// ---- Hover markdown helpers (supportHtml tooltips) --------------------------
// The tree renders its tooltips as MarkdownString(…, supportThemeIcons) with
// supportHtml=true. That unlocks two things stock markdown can't do: a theme-
// COLORED codicon (a `<span style="color:var(--vscode-…)">` wrapping a `$(icon)`
// — the ONLY style the VS Code markdown sanitizer keeps is `color`/`background-
// color` as a hex or a `--vscode-*` var, and the only class it keeps is
// `codicon codicon-*`), and real `<hr>` section rules. Everything below is pure
// string work so tree.ts and the tests share exactly one implementation.

/** A theme-colored codicon fragment for a supportHtml hover: wraps `$(icon)` in a
 *  span tinted with the SAME VS Code theme-color the row's icon uses (e.g.
 *  "charts.green" → `var(--vscode-charts-green)`), so the hover's status glyph and
 *  the tree row's icon read as one. `color` undefined ⇒ a plain default-foreground
 *  `$(icon)` (no span). The mapping only ever emits a `--vscode-<name>` var and a
 *  known codicon id — both inside the sanitizer's allowlist — so a hostile theme
 *  name can't appear here (callers pass IconVisual.color, an own-side literal). */
export function coloredIcon(icon: string, color?: string): string {
  if (color === undefined) return `$(${icon})`;
  const cssVar = `var(--vscode-${color.replace(/\./g, "-")})`;
  return `<span style="color:${cssVar};">$(${icon})</span>`;
}

/** Pre-escape untrusted text for insertion into a supportHtml MarkdownString via
 *  `appendText`. appendText already markdown-escapes (blocking `![](url)` image and
 *  `[](url)` link injection) and escapes `>`, but under supportHtml it leaves `&`
 *  and `<` live — the two chars that could still open an HTML tag or entity. Escaping
 *  just those two (in order: `&` first) closes the gap: no tag can form, no entity is
 *  ambiguous, and appendText handles the rest. Pure; unit-tested. Callers do
 *  `md.appendText(preEscapeHtml(value))` for every disk-/hook-/transcript-derived
 *  value (title, reason, question, model, paths, last-message preview). */
export function preEscapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

// ---- Serialized model posted to the floating webview panel ------------------
// Plain JSON only (crosses the extension-host → webview boundary); no vscode
// types, no functions.

/** One expandable activity-tree child (workflow / subagent / task) under a
 *  session; workflows carry their own nested agents. */
export interface PanelChild {
  kind: "workflow" | "agent" | "task";
  label: string;
  /** Dim inline description (age · state), matching the tree row. */
  description: string;
  icon: string;
  iconColor?: string;
  spin: boolean;
  hover: string;
  children?: PanelChild[];
  /** External model id a wrapper-subagent label declares (e.g. "gpt-5.5",
   *  "grok-4.5") — surfaced as an honest badge on the Claude subagent row. Undefined
   *  for a normal subagent. See externalModelFromLabel. */
  extModel?: string;
}

export interface PanelSession {
  sessionId: string;
  /** Free-tier LOCKED placeholder: this session is beyond the free-tier cap, so it
   *  renders as "Not available in free version" with NO title/details/children/
   *  controls and is excluded from all supervision. When set, every other field
   *  carries only safe placeholder values (empty id, no hover/children) — nothing
   *  about the real session is sent to the webview. See lockedPanelSession. */
  locked?: boolean;
  title: string;
  statusKind: StatusKind;
  statusPhrase: string;
  unread: boolean;
  attention: boolean;
  /** Dim inline description: age plus glyph parts (⚙N ❯), matching the tree. Shown
   *  in "list" layout; in "columns" layout the panel grid reads `columns` instead. */
  description: string;
  /** The four ordered column cells (time · status · model · tokens) for the "columns"
   *  layout grid. Always populated (cheap), read by the panel only when layout is
   *  "columns"; the sidebar tree builds the same cells for its own description. */
  columns: SessionColumnFields;
  /** Session status icon (codicon id + color + spin). */
  icon: string;
  iconColor?: string;
  spin: boolean;
  terminal: boolean;
  homeLabel: string;
  /** VS Code theme color name for the account badge (e.g. "charts.purple"); only
   *  set for multi-home, non-primary accounts. */
  homeColor?: string;
  /** Activity-tree children (present only when the setting is on and the session
   *  has any); the webview shows a twistie when non-empty. */
  children: PanelChild[];
  /** Codex runs confidently folded under this session as their father (live /proc
   *  ancestor match), mirroring the tree's SessionNode.codexChildren. Rendered nested
   *  under the session row; empty for a session with no folded runs. */
  codexChildren: PanelCodex[];
  /** Headless cursor-agent (`agent -p`) runs confidently folded under this session as
   *  their father (live /proc ancestor match), mirroring SessionNode.cursorChildren.
   *  Rendered nested after the codex children; empty when none. */
  cursorChildren: PanelCursor[];
  /** Verbose per-session detail shown as the row's native tooltip. */
  hover: string;
  /** Free-tier over-limit: this row is beyond the caps, so it renders dimmed and is
   *  excluded from supervision (badge/alerts/triage) — data still shown in full. */
  freeTier?: boolean;
  // ---- Publisher-only raw fields (cross-host bridge, plan §9). These carry the
  // unformatted status/age/last-message straight from the source row so the
  // snapshot builder (src/bridge.ts) never has to reverse-parse a rendered
  // string. NEVER read by any rendering path — tree.ts/panel.ts ignore them.
  /** Underlying session status (before the visual bucket collapses it). */
  rawStatus?: Status;
  /** Unformatted age in seconds (0 when unknown). */
  rawAgeSec?: number;
  /** Raw last assistant-message text ("" when none), pre-cap. */
  rawLastText?: string;
  /** True when `title` is the prompt-derived fallback (first user-prompt line) —
   *  i.e. user-authored conversation content, not a real editor title or the
   *  plain stub. The snapshot builder (src/bridge.ts) gates this out of cross-host
   *  publishing when publishLastText is off, so a first prompt never rides the
   *  always-published title field off-machine against the "titles only" contract. */
  titleIsPrompt?: boolean;
  /** The non-prompt stub the row would have shown WITHOUT the prompt fallback
   *  (meta.name ?? id-slice) — set only when titleIsPrompt is true, so the gated
   *  snapshot can restore exactly the pre-feature title. */
  titleStub?: string;
}

/** The title a cross-host snapshot should publish for a Claude session (pure, so it
 *  is unit-tested directly). A prompt-derived title is user-authored conversation
 *  content — the same sensitivity class as lastText — so it is published only when
 *  `includeLastText` (the publishLastText setting) is on. When gated, the non-prompt
 *  stub the row would have shown pre-feature is restored, honoring the setting's
 *  "titles only = safe minimum" contract: a first prompt never rides the
 *  always-published title field off-machine. */
export function publishableTitle(s: PanelSession, includeLastText: boolean): string {
  return s.titleIsPrompt === true && !includeLastText
    ? s.titleStub ?? s.sessionId.slice(0, 8)
    : s.title;
}

/** Whether a session should publish `attention: true` to other hosts. A free-tier
 *  over-limit row publishes IN FULL (title/status/lastText — visibility is never
 *  gated), but its attention is STRIPPED here so a second window on another host
 *  can't alert on a session this host has excluded from supervision — consistent
 *  with local enforcement, and closing the cross-host bypass. `s.attention` already
 *  folds in pendingQuestion-derived waiting-attention, so this covers both. */
export function publishableAttention(s: PanelSession): boolean {
  return s.attention === true && s.freeTier !== true;
}

/** The provenance label for a folded codex CHILD row: the subagent role when this run
 *  is a Codex subagent (e.g. "review"), else its kind ("codex exec"/"codex"). An empty
 *  role collapses to kind. Pure; shown dim on nested child rows so a folded run reads
 *  as a child of its father session. */
export function codexProvenanceLabel(subagentRole: string, kind: string): string {
  return subagentRole !== "" ? subagentRole : kind;
}

// ---- Free-tier LOCKED placeholder rows ---------------------------------------
// A session beyond the free-tier cap is NOT rendered — it is replaced, in every
// surface, by an identical locked placeholder. These pure builders are the single
// source for that placeholder so no real session field can leak: the returned model
// carries the fixed label, a lock glyph, `locked: true`, and empty/placeholder
// values for every other field (no id nav handle, no hover, no children, no
// metrics). The renderers draw a lock row with one quiet "unlock" affordance and
// nothing else; the bridge skips locked rows entirely (never published cross-host).

/** The exact wording shown in place of a locked session (tasteful, not shouty). */
export const LOCKED_SESSION_LABEL = "Not available in free version";
/** Codicon id for the lock glyph on a locked placeholder row. */
export const LOCKED_SESSION_ICON = "lock";

const LOCKED_COMMON = {
  locked: true as const,
  freeTier: true as const,
  title: LOCKED_SESSION_LABEL,
  statusKind: "idle" as StatusKind,
  columns: { time: "", status: "", model: undefined, tokens: undefined } as SessionColumnFields,
  description: "",
  icon: LOCKED_SESSION_ICON,
  spin: false,
  unread: false,
  hover: "",
};

/** A locked-placeholder Claude session row: no sessionId (no nav handle), no
 *  status phrase, no children/codexChildren, no raw publisher fields. Pure. */
export function lockedPanelSession(): PanelSession {
  return {
    ...LOCKED_COMMON,
    sessionId: "",
    statusPhrase: "",
    attention: false,
    terminal: false,
    homeLabel: "",
    children: [],
    codexChildren: [],
    cursorChildren: [],
  };
}

/** A locked-placeholder Cursor row (no chatId nav handle). Pure. */
export function lockedPanelCursor(): PanelCursor {
  return { ...LOCKED_COMMON, chatId: "" };
}

/** A locked-placeholder Codex row (no id nav handle). Pure. */
export function lockedPanelCodex(): PanelCodex {
  return { ...LOCKED_COMMON, id: "" };
}

/** A locked-placeholder Composer row (no conversationId nav handle). Pure. */
export function lockedPanelComposer(): PanelComposer {
  return { ...LOCKED_COMMON, conversationId: "" };
}

/** Build the panel-model row for one Cursor GUI Composer session — the single pure
 *  source both the floating panel and the sidebar table read, so a composer renders
 *  identically in both (and matches the sidebar tree's composerItem). Activity-only:
 *  status buckets via terminalStatusKind(working, unread) (working / unread / done),
 *  never attention/question; `dimmed` is the free-tier over-limit flag. Pure + tested. */
export function panelComposerRow(row: ComposerRow, unread: boolean, dimmed: boolean): PanelComposer {
  const working = row.status === "working";
  const v = composerVisual(working);
  const kind = terminalStatusKind(working, unread);
  const status = kind === "working" ? "working" : kind === "unread" ? "done, unread" : "done";
  const hoverLines: string[] = [
    `${row.name} — Composer (${row.status})`,
    `mode: ${row.mode || "unknown"} · background: ${row.isBackground ? "yes" : "no"}`,
  ];
  if (row.caption) hoverLines.push(row.caption);
  if (row.tokens)
    hoverLines.push(
      `tokens: input ${row.tokens.input} · output ${row.tokens.output} · cache read ${row.tokens.cacheRead} · cache write ${row.tokens.cacheWrite}`
    );
  hoverLines.push(`conversation ${row.conversationId}`, row.cwd);
  return {
    conversationId: row.conversationId,
    title: row.name,
    statusKind: kind,
    columns: { time: fmtAge(row.ageSec), status, model: undefined, tokens: undefined },
    description: `${unread ? "● " : ""}${composerDescription(row)}`,
    icon: v.icon,
    iconColor: v.color,
    spin: v.spin,
    unread,
    hover: hoverLines.join("\n"),
    freeTier: dimmed,
  };
}

/** One Cursor Agent CLI session under a project (rendered after Claude
 *  sessions). Carries finished-unread (viewer-side), but no approval/question
 *  attention concept — just status, age, mode and unread. */
export interface PanelCursor {
  chatId: string;
  /** Free-tier LOCKED placeholder (see PanelSession.locked). */
  locked?: boolean;
  title: string;
  statusKind: StatusKind;
  columns: SessionColumnFields;
  /** Dim inline description: age plus the ❯ terminal glyph (● prefix when unread). */
  description: string;
  icon: string;
  iconColor?: string;
  spin: boolean;
  /** Finished-unread: recent output not yet looked at (also baked into description). */
  unread: boolean;
  /** Brand mark to render inline (always "cursor" here). */
  brand?: BrandIcon;
  hover: string;
  /** Free-tier over-limit dim (see PanelSession.freeTier). */
  freeTier?: boolean;
  /** Demoted external ENDED headless run OR an orphan (CursorNode.demoted): render
   *  dimmed and NON-clickable — no window to focus. Mirrors PanelCodex.demoted. */
  demoted?: boolean;
  /** Publisher-only raw age in seconds for the bridge (plan §9); not rendered. */
  rawAgeSec?: number;
}

/** One Codex CLI session under a project (rendered after Cursor sessions). Like
 *  Cursor rows: terminal-run; carries finished-unread but no approval/question
 *  attention — just status, age, kind and unread. */
export interface PanelCodex {
  id: string;
  /** Free-tier LOCKED placeholder (see PanelSession.locked). */
  locked?: boolean;
  title: string;
  statusKind: StatusKind;
  columns: SessionColumnFields;
  /** Dim inline description: age plus the ❯ terminal glyph (● prefix when unread). */
  description: string;
  icon: string;
  iconColor?: string;
  spin: boolean;
  /** Finished-unread: recent output not yet looked at (also baked into description). */
  unread: boolean;
  /** Brand mark to render inline (always "codex" here). */
  brand?: BrandIcon;
  hover: string;
  /** Free-tier over-limit dim (see PanelSession.freeTier). */
  freeTier?: boolean;
  /** Demoted external ENDED codex run (CodexNode.demoted): render dimmed, sorted last
   *  (already ordered so by the tree), and NON-clickable — no nav handle. Semantics
   *  match the tree exactly. */
  demoted?: boolean;
  /** Provenance label for a FOLDED codex child (subagentRole when a subagent, else
   *  kind e.g. "codex exec"): shown dim on a nested child row so it reads as a child,
   *  not a peer. Renderers surface it only on nested child rows. */
  provenance?: string;
  /** Publisher-only raw age in seconds for the bridge (plan §9); not rendered. */
  rawAgeSec?: number;
}

/** One Cursor GUI Composer session under a project (rendered AFTER Codex sessions).
 *  Activity-only: it NEVER alerts or badges — its `unread` is a row affordance only,
 *  and it has no approval/question concept. Its icon is a codicon (composerVisual),
 *  NOT a brand mark, so there is no `brand` field. */
export interface PanelComposer {
  conversationId: string;
  /** Free-tier LOCKED placeholder (see PanelSession.locked). */
  locked?: boolean;
  title: string;
  statusKind: StatusKind;
  columns: SessionColumnFields;
  /** Dim inline description: mode · [bg ·] caption/status · age, with a leading "● "
   *  when unread. */
  description: string;
  icon: string;
  iconColor?: string;
  spin: boolean;
  /** Finished-unread affordance (also baked into description); never contributes to
   *  attention/badges. */
  unread: boolean;
  hover: string;
  /** Free-tier over-limit dim (see PanelSession.freeTier). */
  freeTier?: boolean;
}

export interface PanelProject {
  name: string;
  cwd: string;
  /** Dim inline counts (e.g. "3 · ↻1 · ●2 · 4m"), matching the tree header; in
   *  compact mode this is the pressure summary (leading 🔔N when >0). */
  description: string;
  /** When this project directory is a linked git worktree: the branch it has checked
   *  out (e.g. "lane/cursor-open"). The TREE nests worktrees under their main repo;
   *  the webview table (minimal, per the table-rework seam) renders a flat
   *  "↳ <branch> · worktree of <mainRepoName>" caption instead. Undefined for a
   *  normal project. */
  branch?: string;
  /** basename of this worktree's main repo directory, for the flat table caption.
   *  Set only when `branch` is set. */
  worktreeOf?: string;
  /** Whether this project is pinned (globalState). Drives the table view's native
   *  context menu (Pin ↔ Unpin), mirroring the sidebar tree's project-pinned /
   *  project-unpinned contextValue. Absent = unpinned (the floating panel ignores
   *  it, so its rendering is unchanged). */
  pinned?: boolean;
  /** attention + pending-question rows — drives the panel's compact auto-expand
   *  (a project that needs you opens even when compact collapses everything else). */
  needsYou: number;
  sessions: PanelSession[];
  /** Cursor Agent CLI sessions in this project (may be empty). */
  cursors: PanelCursor[];
  /** Codex CLI sessions in this project (may be empty). */
  codexes: PanelCodex[];
  /** Cursor GUI Composer sessions in this project (rendered after Codex; may be empty). */
  composers: PanelComposer[];
}

// ---- Remote host sections (cross-host bridge, plan §6) ----------------------
// A host section mirrors a HostNode in the tree: read-only session rows grouped
// by cwd under a host header. Every string here originates from a remote host and
// is display-only — panel.ts routes all of them through esc() (plan §8.1).

/** One read-only activity-tree child under a remote session (workflow/agent/task).
 *  No nesting (the bridge flattens children to one level, plan §4). */
export interface PanelRemoteChild {
  kind: "workflow" | "agent" | "task";
  label: string;
  description: string;
  icon: string;
  iconColor?: string;
  spin: boolean;
  hover: string;
}

/** One read-only remote session row (icon + status + title + age); mirrors what
 *  the tree renders. No unread/attention/homeLabel actions — read-only v1. */
export interface PanelRemoteSession {
  id: string;
  title: string;
  statusKind: StatusKind;
  columns: SessionColumnFields;
  /** Dim inline description: age plus glyphs (⚙N, ❯ for cursor/codex tools). */
  description: string;
  icon: string;
  iconColor?: string;
  spin: boolean;
  /** Brand mark to render inline (cursor/codex sessions); undefined for Claude. */
  brand?: BrandIcon;
  hover: string;
  /** Activity-tree children (present only when the setting is on). */
  children: PanelRemoteChild[];
}

/** One cwd group inside a host section. */
export interface PanelRemoteProject {
  name: string;
  cwd: string;
  description: string;
  /** attention rows on this remote project — drives the panel's compact auto-expand
   *  (the needs-you-never-buried covenant extends to remote projects). */
  needsYou: number;
  sessions: PanelRemoteSession[];
}

/** One remote host section appended after the self content in the panel; mirrors
 *  a HostNode in the tree (display label + freshness + project groups). */
export interface HostSection {
  hostId: string;
  /** Resolved display label (hostDisplayLabel), display-only. */
  label: string;
  /** Dim header suffix — session count, plus "· last seen Xm ago" when stale. */
  description: string;
  /** True when the host is stale (≤24h but not live): dim the whole section. */
  stale: boolean;
  /** Sum of attention rows across this host's projects — drives the panel's compact
   *  host auto-expand (a host with a needs-you session opens even when compact). */
  needsYou: number;
  projects: PanelRemoteProject[];
}

// ---- Remote host fact block (hover legibility, pure seams) ------------------
// A compact, plain-text fact block for a remote host's hover, so a host row reads
// as more than "label · last seen Xm". Both builders are pure and vscode-free so
// they unit-test directly; the caller (tree.ts hostItem) owns escaping — every
// value here is an enum/number/own-side version string, never remote free text.

/** Session-status tally shown in a remote host's fact block. */
export interface HostSessionCounts {
  working: number;
  needsYou: number;
  idle: number;
}

/** Bucket a remote host's sessions into working / needs-you / idle for the fact
 *  block. needs-you (an attention/pending-question row) wins over working — it is
 *  the actionable one. A stale host's rows are last-known, so a "working" status
 *  still tallies as working here (the liveness line already says it's not live). */
export function tallyRemoteSessions(
  sessions: readonly { status: string; attention?: boolean }[]
): HostSessionCounts {
  const counts: HostSessionCounts = { working: 0, needsYou: 0, idle: 0 };
  for (const s of sessions) {
    if (s.attention === true) counts.needsYou++;
    else if (s.status === "working") counts.working++;
    else counts.idle++;
  }
  return counts;
}

export interface HostFacts {
  /** Validated platform enum ("wsl"|"linux"|"darwin"|"win32"). */
  platform: string;
  counts: HostSessionCounts;
  /** Seconds since the snapshot was received on the LOCAL clock. */
  lastSeenSec: number;
  /** True = stale (window closed?), false = live. Hosts >24h are already hidden
   *  upstream, so the tri-state the hover ever renders is just live/stale. */
  stale: boolean;
  /** Companion version from the bridge hello handshake, present ONLY when it skews
   *  from ours (reuse the existing bridge getter — no new probe). */
  skewVersion?: string;
}

/** Compact fact block for a remote host hover (pure; unit-tested directly). Returns
 *  dim plain-text lines the caller escapes + joins: (1) liveness tri-state, (2)
 *  platform + session tally, (3) snapshot age ("received 12s ago"), (4) a version-
 *  skew note when the handshake exposed one, and — for a stale host — the one-line
 *  hint to resume live updates. Zero-count buckets are dropped; a host with no
 *  sessions falls back to "0 sessions". */
export function hostFactLines(f: HostFacts): string[] {
  const lines: string[] = [];
  // (1) Explicit tri-state liveness — "stale (window closed?)" names the usual cause.
  lines.push(f.stale ? "stale (window closed?)" : "live");
  // (2) Platform + session tally by status on one line.
  const tally: string[] = [];
  if (f.counts.working > 0) tally.push(`${f.counts.working} working`);
  if (f.counts.needsYou > 0) tally.push(`${f.counts.needsYou} needs you`);
  if (f.counts.idle > 0) tally.push(`${f.counts.idle} idle`);
  const total = f.counts.working + f.counts.needsYou + f.counts.idle;
  const sessionsPart =
    tally.length > 0 ? tally.join(" · ") : `${total} session${total === 1 ? "" : "s"}`;
  lines.push(`${f.platform} · ${sessionsPart}`);
  // (3) Snapshot age (local clock — the only trusted liveness input).
  lines.push(`received ${fmtAge(f.lastSeenSec)} ago`);
  // (version skew) surfaced only when the getter reports a mismatch.
  if (f.skewVersion !== undefined) lines.push(`companion ${f.skewVersion} (version differs)`);
  // (stale hint) how to get back to live.
  if (f.stale) lines.push("reopen a window to this host to resume live updates");
  return lines;
}

/** One needs-you INBOX reference row in the floating panel — the panel mirror of a
 *  tree InboxRefNode. Carries the underlying row's display fields plus a navigation
 *  handle so a click routes to the SAME open command as the real row. Local kinds
 *  carry exactly one handle; remote rows carry none (panel remote rows are read-only,
 *  matching the host sections). */
export interface PanelInboxRow {
  /** Stable key: the `inbox:`-prefixed reference id (never collides with real rows). */
  key: string;
  kind: "session" | "cursor" | "codex" | "remote";
  title: string;
  statusKind: StatusKind;
  columns: SessionColumnFields;
  description: string;
  icon: string;
  iconColor?: string;
  spin: boolean;
  /** Brand mark (cursor/codex rows); undefined otherwise. */
  brand?: BrandIcon;
  hover: string;
  /** Exactly one of these is set for a local row (routes the click); remote → none. */
  sessionId?: string;
  chatId?: string;
  codexId?: string;
  /** Account label + theme color for the multi-home badge (session rows only, and
   *  only when more than one account is present) — mirrors the real session row. */
  homeLabel?: string;
  homeColor?: string;
}

// ---- Table view native context menus (webview/context) ---------------------
// The sidebar table view is a webview, so it uses VS Code's NATIVE per-element
// context menus (data-vscode-context + contributes.menus."webview/context")
// rather than a hand-rolled menu. Each row stamps a `webviewSection` (below) via
// data-vscode-context, and package.json contributes the matching menu items —
// the SAME commands the sidebar tree's view/item/context menu carries, so a
// right-click in the table reproduces the tree's per-node menu exactly. The
// invoked command receives the data-vscode-context object (with the row's id /
// cwd), which the command handlers resolve to a real node. This map is the single
// source of truth the package.json block is checked against (drift guard test);
// keeping labels in package.json (static) means no untrusted text is ever rendered
// as a menu, closing the XSS surface a custom menu would open.

/** The table webview's view id — the `webviewId` when-key for its context menus. */
export const TABLE_WEBVIEW_ID = "sessionDeck.table";

/** webviewSection → the ordered command ids its native context menu contributes,
 *  mirroring the sidebar tree's per-node view/item/context menu (see package.json
 *  view/item/context for `sessionDeck.sessions`). Pure data; unit-tested against
 *  the package.json `webview/context` block. */
export const TABLE_CONTEXT_MENU: Readonly<Record<string, readonly string[]>> = {
  // Projects mirror the tree's project-pinned / project-unpinned contextValue.
  "project-unpinned": ["sessionDeck.pinProject", "sessionDeck.openProject"],
  "project-pinned": ["sessionDeck.unpinProject", "sessionDeck.openProject"],
  // Claude session rows: hide + show-last-message + properties.
  session: [
    "sessionDeck.hideSession",
    "sessionDeck.showLastMessage",
    "sessionDeck.sessionProperties",
  ],
  // Cursor / Codex / Composer rows: hide + properties (no last-message),
  // exactly as the tree gates them (viewItem == cursor|codex|composerSession).
  cursor: ["sessionDeck.hideSession", "sessionDeck.sessionProperties"],
  codex: ["sessionDeck.hideSession", "sessionDeck.sessionProperties"],
  composer: ["sessionDeck.hideSession", "sessionDeck.sessionProperties"],
} as const;

export interface PanelModel {
  multiHome: boolean;
  /** Whether the activity-tree setting is on (drives session twisties + toggle). */
  activityTree: boolean;
  /** View density: "compact" collapses project rows by default (auto-expanding the
   *  ones that need you) and shows the pressure summary; "comfortable" is the
   *  fully-expanded default. */
  density: Density;
  /** View layout: "columns" renders session rows as an aligned CSS grid (time ·
   *  status · model · tokens) under a header row; "list" is the inline description
   *  flow. Orthogonal to density. */
  layout: Layout;
  /** The needs-you inbox section, rendered FIRST (above projects) when the inboxLane
   *  setting is on and something needs you; absent/empty otherwise. A VIEW of the
   *  rows below — never counted separately. */
  inbox?: PanelInboxRow[];
  projects: PanelProject[];
  /** Remote host sections appended after self content; absent/empty for the
   *  single-host case (panel renders byte-identically then). */
  hosts?: HostSection[];
  /** Dim footer text mirroring the sidebar's degraded-capability note (e.g.
   *  "Approval alerts off — Install Hooks"); absent when the fleet is healthy. The
   *  panel shows it as read-only text — the fix is actioned from the sidebar row. */
  capabilityNote?: string;
  /** Dim footer text mirroring the sidebar's same-path collision note (e.g.
   *  "2 sessions editing the same file"); absent when nothing collides. Observe-only,
   *  read-only — the row glyphs/hovers carry the detail. */
  collisionNote?: string;
}

/** Re-export so panel.ts can format ages consistently without reaching into
 *  discovery directly. */
export { fmtAge };

/** Absolute clock label for a hover timestamp: time-of-day when the instant falls on
 *  the same calendar day as `now` (a fresh session's start reads compactly, e.g.
 *  "5:10:49 AM"), else date + time so a session born days ago (a resumed one) is
 *  unambiguously old rather than a bare misleading time. Locale-formatted; `now` is
 *  injectable for tests. */
export function fmtClock(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const n = new Date(now);
  const sameDay =
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
}

/** A session's current process must start more than this after its transcript birth
 *  before the hover calls it out as a separate "process started" — a fresh single-run
 *  session writes record 1 within seconds of spawning, a `--resume` reopens a
 *  transcript minutes-to-days old. */
export const RESUME_GAP_MS = 5 * 60_000;

/** The unambiguous time labels a session hover shows, shared by the sidebar tree and
 *  the webview panel so the two stay in parity. `started` is the TRUE session birth
 *  (transcript first record) when known, else the registry `startedAt`. `process` is
 *  set only when the current pid started meaningfully after birth — i.e. a resume/
 *  restart rewrote `startedAt`, so the row's "started" and the live process differ and
 *  BOTH matter. Callers render `started` as "session started …" and, when present,
 *  `process` as "process started …". */
export function sessionTimeFacts(
  birthMs: number | undefined,
  startedAt: number,
  now: number = Date.now()
): { started: string; process?: string } {
  if (birthMs === undefined) return { started: fmtClock(startedAt, now) };
  const process = startedAt - birthMs > RESUME_GAP_MS ? fmtClock(startedAt, now) : undefined;
  return { started: fmtClock(birthMs, now), process };
}

/** Age key for change-detection signatures (tree dirty-check + panel skip). It is
 *  byte-identical to the *displayed* fmtAge at ≥1m — where fmtAge already only
 *  changes at most once per minute — but collapses every sub-minute age to a
 *  single "<1m" bucket. Sub-minute ages render as "Ns" and so tick every 3s poll;
 *  left in a signature they force a repaint / re-post on every quiet tick for any
 *  session younger than a minute. Bucketing defers that repaint to the next real
 *  change or the minute rollover: ages shown may lag up to one bucket, but the
 *  status/structure fields compared alongside this never do. Pure seam. */
export function ageBucket(sec: number | null): string {
  if (sec === null) return "new";
  if (sec < 60) return "<1m";
  return fmtAge(sec);
}

/** Normalize sub-minute age tokens ("3s", "45s") inside a rendered string so a
 *  serialized-model comparison ignores per-tick age drift the same way ageBucket
 *  does for the tree. Only the "Ns" form churns every tick; "Nm"/"Nh"/"Nd" change
 *  at most once per their unit and must still trigger a re-post, so they are left
 *  intact. Comparison-only — the real strings are still what gets rendered.
 *
 *  Intentional over-match: this runs on EVERY string leaf of the panel skip-key,
 *  not just age labels, so any content that happens to be expressed *solely* as a
 *  `\d+s` token change (e.g. a status caption that only differed by a seconds
 *  count) collapses to `#s` and defers its repaint by one tick. That window is
 *  bounded — statuses/structure are compared as their own fields alongside this,
 *  so a real state change still re-posts immediately; only a change expressible
 *  as nothing but a sub-minute-seconds delta can be masked, and only until the
 *  next real change or the minute rollover. The churn it prevents (a re-post
 *  every 3s for any sub-minute session) is worth that bounded lag. */
export function stripSubMinuteAge(s: string): string {
  return s.replace(/\b\d+s\b/g, "#s");
}

/** Sanitize a hook-supplied "why is this blocked" reason for display on a tree
 *  row, in a hover, or in a toast. The input is untrusted text (a Notification
 *  event's `message`), so this: strips ASCII/Unicode control chars (incl. the
 *  newlines that would break a single-line row/toast), collapses all remaining
 *  whitespace runs to single spaces, trims, and truncates to `max` with an
 *  ellipsis. It does NOT markdown-escape — callers that render into a
 *  MarkdownString must still use `appendText` (never `appendMarkdown`) so the
 *  cleaned text can't inject markdown/images; plain-string sinks (row
 *  `description`, `showWarningMessage`) need no further escaping. Idempotent, so
 *  re-truncating an already-sanitized reason for a narrower sink is safe. */
export function sanitizeReason(s: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export interface SessionPropChild {
  label: string;
  state: string;
  path: string;
}

export interface SessionPropWorkflow extends SessionPropChild {
  agents: SessionPropChild[];
}

export interface SessionPropsView {
  title: string;
  status: string;
  why: string;
  host: string;
  surface: string;
  pid: number;
  model?: string;
  mode?: string;
  tokens?: string;
  started: string;
  processStarted?: string;
  lastActivity: string;
  cwd: string;
  projectPath: string;
  transcriptPath: string;
  sessionId: string;
  agents: SessionPropChild[];
  workflows: SessionPropWorkflow[];
  tasks: SessionPropChild[];
}

function markdownText(value: string): string {
  return value.replace(/([\\`*_{}[\]()<>#+.!|~-])/g, "\\$1");
}

function codeSpan(value: string): string {
  const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

/** Assemble the read-only session-properties document from already-resolved values. */
export function sessionPropertiesMarkdown(v: SessionPropsView): string {
  const facts = [
    `- **Host:** ${markdownText(v.host)}`,
    `- **Surface:** ${markdownText(v.surface)}`,
    `- **PID:** ${v.pid}`,
    ...(v.model !== undefined ? [`- **Model:** ${markdownText(v.model)}`] : []),
    ...(v.mode !== undefined ? [`- **Mode:** ${markdownText(v.mode)}`] : []),
    ...(v.tokens !== undefined ? [`- **Tokens:** ${markdownText(v.tokens)}`] : []),
    `- **Started:** ${markdownText(v.started)}`,
    ...(v.processStarted !== undefined
      ? [`- **Process started:** ${markdownText(v.processStarted)}`]
      : []),
    `- **Last activity:** ${markdownText(v.lastActivity)}`,
  ];
  const childLine = (child: SessionPropChild, indent = ""): string =>
    `${indent}- **${markdownText(child.label)}** — ${markdownText(child.state)} — ${codeSpan(child.path)}`;
  const section = (heading: string, children: SessionPropChild[]): string[] => [
    `## ${heading} (${children.length})`,
    "",
    ...(children.length === 0 ? ["_None._"] : children.map((child) => childLine(child))),
  ];
  const workflows = [
    `## Workflows (${v.workflows.length})`,
    "",
    ...(v.workflows.length === 0
      ? ["_None._"]
      : v.workflows.flatMap((workflow) => [
          childLine(workflow),
          ...workflow.agents.map((agent) => childLine(agent, "  ")),
        ])),
  ];

  return [
    `# ${markdownText(v.title)}`,
    "",
    `**Status:** ${markdownText(v.status)} — ${markdownText(v.why)}`,
    "",
    "## Session facts",
    "",
    ...facts,
    "",
    "## Paths",
    "",
    `- **CWD:** ${codeSpan(v.cwd)}`,
    `- **Project:** ${codeSpan(v.projectPath)}`,
    `- **Transcript:** ${codeSpan(v.transcriptPath)}`,
    `- **Session ID:** ${codeSpan(v.sessionId)}`,
    "",
    ...section("Sub-agents", v.agents),
    "",
    ...workflows,
    "",
    ...section("Tasks", v.tasks),
    "",
  ].join("\n");
}

export interface CodexPropsView {
  title: string;
  status: string;
  why: string;
  surface: string;
  kind: string;
  provenance: string;
  demoted: boolean;
  external: boolean;
  live: boolean;
  model?: string;
  modelProvider?: string;
  originator?: string;
  cliVersion?: string;
  pid?: number;
  parentClaudePid?: number;
  started?: string;
  lastActivity: string;
  cwd: string;
  threadId: string;
  parentId?: string;
  subagentRole?: string;
  rolloutPath: string;
}

export function codexPropertiesMarkdown(v: CodexPropsView): string {
  const facts = [
    `- **Surface:** ${markdownText(v.surface)}`,
    `- **Kind:** ${markdownText(v.kind)}`,
    `- **Provenance:** ${markdownText(`${v.provenance}${v.demoted ? " (demoted)" : ""}`)}`,
    `- **External:** ${v.external ? "yes" : "no"}`,
    `- **Live:** ${v.live ? "yes" : "no"}`,
    ...(v.model !== undefined ? [`- **Model:** ${markdownText(v.model)}`] : []),
    ...(v.modelProvider !== undefined ? [`- **Model provider:** ${markdownText(v.modelProvider)}`] : []),
    ...(v.originator !== undefined ? [`- **Originator:** ${markdownText(v.originator)}`] : []),
    ...(v.cliVersion !== undefined ? [`- **CLI version:** ${markdownText(v.cliVersion)}`] : []),
    ...(v.pid !== undefined ? [`- **PID:** ${v.pid}`] : []),
    ...(v.parentClaudePid !== undefined ? [`- **Parent Claude PID:** ${v.parentClaudePid}`] : []),
    ...(v.started !== undefined ? [`- **Started:** ${markdownText(v.started)}`] : []),
    `- **Last activity:** ${markdownText(v.lastActivity)}`,
  ];

  return [
    `# ${markdownText(v.title)}`,
    "",
    `**Status:** ${markdownText(v.status)} — ${markdownText(v.why)}`,
    "",
    "## Session facts",
    "",
    ...facts,
    "",
    "## Paths",
    "",
    `- **CWD:** ${codeSpan(v.cwd)}`,
    `- **Thread id:** ${codeSpan(v.threadId)}`,
    ...(v.parentId !== undefined ? [`- **Parent session:** ${codeSpan(v.parentId)}`] : []),
    ...(v.subagentRole !== undefined ? [`- **Subagent role:** ${markdownText(v.subagentRole)}`] : []),
    `- **Rollout:** ${codeSpan(v.rolloutPath)}`,
    "",
  ].join("\n");
}

export interface CursorPropsView {
  title: string;
  status: string;
  why: string;
  surface: string;
  mode?: string;
  /** Headless machine-driven `agent -p` run (never draws attention). */
  external: boolean;
  /** Ended external run OR orphan — dimmed, non-clickable. */
  demoted: boolean;
  /** cwd deleted + process dead (a pruned worktree). */
  orphan: boolean;
  live: boolean;
  pid?: number;
  /** Father Claude session PID for a live folded headless run. */
  parentClaudePid?: number;
  lastActivity: string;
  cwd: string;
  chatId: string;
  dbPath: string;
}

export function cursorPropertiesMarkdown(v: CursorPropsView): string {
  const facts = [
    `- **Surface:** ${markdownText(v.surface)}`,
    ...(v.mode !== undefined ? [`- **Mode:** ${markdownText(v.mode)}`] : []),
    `- **Provenance:** ${v.orphan ? "orphaned (folder deleted)" : v.external ? `headless CLI run${v.demoted ? " (demoted)" : ""}` : "interactive"}`,
    `- **External:** ${v.external ? "yes" : "no"}`,
    `- **Live:** ${v.live ? "yes" : "no"}`,
    ...(v.pid !== undefined ? [`- **PID:** ${v.pid}`] : []),
    ...(v.parentClaudePid !== undefined ? [`- **Parent Claude PID:** ${v.parentClaudePid}`] : []),
    `- **Last activity:** ${markdownText(v.lastActivity)}`,
  ];

  return [
    `# ${markdownText(v.title)}`,
    "",
    `**Status:** ${markdownText(v.status)} — ${markdownText(v.why)}`,
    "",
    "## Session facts",
    "",
    ...facts,
    "",
    "## Paths",
    "",
    `- **CWD:** ${codeSpan(v.cwd)}`,
    `- **Chat id:** ${codeSpan(v.chatId)}`,
    `- **Store DB:** ${codeSpan(v.dbPath)}`,
    "",
  ].join("\n");
}

export interface ComposerPropsView {
  title: string;
  status: string;
  why: string;
  surface: string;
  mode?: string;
  background: boolean;
  signal?: string;
  tokens?: string;
  lastActivity: string;
  cwd: string;
  conversationId: string;
}

export function composerPropertiesMarkdown(v: ComposerPropsView): string {
  const facts = [
    `- **Surface:** ${markdownText(v.surface)}`,
    ...(v.mode !== undefined ? [`- **Mode:** ${markdownText(v.mode)}`] : []),
    `- **Background:** ${v.background ? "yes" : "no"}`,
    ...(v.signal !== undefined ? [`- **Last signal:** ${markdownText(v.signal)}`] : []),
    ...(v.tokens !== undefined ? [`- **Tokens:** ${markdownText(v.tokens)}`] : []),
    `- **Last activity:** ${markdownText(v.lastActivity)}`,
  ];

  return [
    `# ${markdownText(v.title)}`,
    "",
    `**Status:** ${markdownText(v.status)} — ${markdownText(v.why)}`,
    "",
    "## Session facts",
    "",
    ...facts,
    "",
    "## Paths",
    "",
    v.cwd === "" ? "- **CWD:** _unknown_" : `- **CWD:** ${codeSpan(v.cwd)}`,
    `- **Conversation id:** ${codeSpan(v.conversationId)}`,
    "",
  ].join("\n");
}

// ---- Pin & Hide pure seams --------------------------------------------------
// The composition/predicate cores behind "Pin Project" and "Hide Session".
// tree.ts owns the vscode.Memento persistence and the concrete nodes; these
// stay pure so the ordering, auto-unhide and prune rules unit-test under bun.

/** A persisted hide record: the session's activity mtime observed at hide time
 *  (drives auto-unhide) and the wall-clock instant it was hidden (informational). */
export interface HideRecord {
  /** The row's activity mtime (ms) captured when the session was hidden. New
   *  activity is detected by the current mtime advancing past this value. */
  mtime: number;
  /** Wall-clock ms when the session was hidden (for the "Show Hidden" age hint). */
  hideAt: number;
}

/** Show Hidden picker description: how long ago the row was HIDDEN (from the
 *  record's hideAt), never the session's last-activity age, which said "hidden
 *  2h ago" for a session hidden seconds earlier. A record without a usable
 *  hideAt just says "hidden". */
export function hiddenDescription(rec: Partial<HideRecord>, nowMs: number): string {
  if (typeof rec.hideAt !== "number" || !Number.isFinite(rec.hideAt)) return "hidden";
  return `hidden ${fmtAge(Math.max(0, (nowMs - rec.hideAt) / 1000))} ago`;
}

/** Stable partition that floats pinned items above the rest WITHOUT disturbing
 *  the order the caller already established (heat/activity/name) within either
 *  group. Relies on a stable sort: a single pass keying pinned→0, rest→1 keeps
 *  equal-key items in their incoming order, so the pinned block keeps the active
 *  sort among themselves and so does the tail. Pure; used for the project rows. */
export function partitionPinned<T>(items: readonly T[], isPinned: (item: T) => boolean): T[] {
  return [...items].sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)));
}

/** The per-row hide decision, shared by every LOCAL surface so a hidden session
 *  vanishes from tree, unread count, panel, alerts and triage together (they all
 *  sit downstream of the tree's filtered project list):
 *   - "visible": no record — render normally;
 *   - "hidden": a live record whose activity has NOT advanced past hide-time —
 *     drop the row and never count it toward unread/alerts/triage;
 *   - "unhide": a record whose activity advanced past hide-time — render the row
 *     AND clear the record (auto-unhide). Pure. */
export function hideDecision(
  record: HideRecord | undefined,
  currentMtime: number
): "visible" | "hidden" | "unhide" {
  if (record === undefined) return "visible";
  return shouldUnhide(record.mtime, currentMtime) ? "unhide" : "hidden";
}

/** Auto-unhide predicate: a hidden session earns its way back the moment it
 *  produces NEW activity, i.e. its current mtime advances past the mtime captured
 *  when it was hidden. Equal (a quiet tick, no new writes) stays hidden. This is
 *  the whole point of hiding — silence it while it's noise, resurface it when it
 *  matters again. Pure. */
export function shouldUnhide(hiddenMtime: number, currentMtime: number): boolean {
  return currentMtime > hiddenMtime;
}

/** The activity mtime to persist when a row is hidden. The rendered tree node
 *  can carry a STALE mtime (the session may have written between the last repaint
 *  and the click), so the caller reads the current on-disk mtime and passes both;
 *  we keep the larger. This closes the render→click race: only activity strictly
 *  after the hide instant can auto-unhide (a write that landed just before the
 *  click is folded into the hide baseline, not treated as "new"). Pure. */
export function hideCaptureMtime(nodeMtime: number, freshMtime: number): number {
  return Math.max(nodeMtime, freshMtime);
}

/** Prune stale hide records so globalState stays bounded — but never before the
 *  record has actually been hidden for the full window. A record is dropped once
 *  BOTH its captured activity mtime AND its hide instant are older than the cutoff
 *  (now - TTL), i.e. `max(mtime, hideAt) < cutoff`. Flooring on hideAt guarantees
 *  a row hidden today with an already-old mtime (a long-idle session you just
 *  silenced, then deleted) still survives ≥7d from the hide action, honoring the
 *  "nothing is silently lost" contract for the picker. Returns a new map; pure. */
export function pruneHidden(
  records: Readonly<Record<string, HideRecord>>,
  cutoffMs: number
): Record<string, HideRecord> {
  const kept: Record<string, HideRecord> = {};
  for (const [key, rec] of Object.entries(records)) {
    if (Math.max(rec.mtime, rec.hideAt) >= cutoffMs) kept[key] = rec;
  }
  return kept;
}

/** Sweep a carry-over Map/Set in place, dropping every entry whose key is no longer
 *  in the `live` set — the same prune discovery.snapshot() runs on its own caches, but
 *  for the tree's event-fed maps (attentionMap, the remote-preview token
 *  index) that are otherwise only ever cleared by a specific event and would leak an
 *  entry forever when a session vanishes without it. `onDrop` fires per removed key so
 *  a lockstep sibling (e.g. the ReasonStore) is pruned alongside. Returns the drop
 *  count; mutates `entries`. Deleting the current key mid-iteration is well-defined for
 *  Map/Set, so no snapshot copy is needed (mirrors the discovery prune loop). */
export function pruneToLive(
  entries: { keys(): IterableIterator<string>; delete(key: string): boolean },
  live: ReadonlySet<string>,
  onDrop?: (key: string) => void
): number {
  let dropped = 0;
  for (const key of entries.keys()) {
    if (!live.has(key)) {
      entries.delete(key);
      onDrop?.(key);
      dropped++;
    }
  }
  return dropped;
}

/** Prune stale pins the same way: a pinned cwd whose last observed activity is
 *  older than the cutoff (its project has produced nothing for the window) is
 *  forgotten. `lastActivity` is refreshed by the reload while the project is
 *  present, so an alive-but-idle pin survives and only a truly gone project ages
 *  out. Returns a new map; pure. */
export function prunePins(
  records: Readonly<Record<string, number>>,
  cutoffMs: number
): Record<string, number> {
  const kept: Record<string, number> = {};
  for (const [cwd, lastActivity] of Object.entries(records)) {
    if (lastActivity >= cutoffMs) kept[cwd] = lastActivity;
  }
  return kept;
}

// ---- refresh-tick consumer-freshness gate -----------------------------------
// buildPanelModel() (tree.ts) is the single most expensive derived object per tick
// AND it feeds two every-string JSON.stringify serializations downstream — the panel
// skip-key (stableModelKey, built on stripSubMinuteAge above) and the bridge snapshot
// key (bridge.ts stableKey). On a QUIET tick with cross-host publishing on or the
// panel open, that whole chain ran every 3s even though the panel's own re-post skip
// and the bridge's re-publish skip would discard the result. This pure seam lets each
// consumer declare whether it actually needs a fresh model this tick; a tick no
// consumer needs skips the build entirely. It is anchored to the SAME tree
// change-signature that fires the sidebar tree's onDidChangeTreeData (built from the
// ageBucket-folded fields above) — so the panel and the published snapshot inherit
// exactly the sidebar tree's freshness. The two bridge-only concerns the signature
// does not fold — published age drift and the receiver's liveness clock — are handled
// by the 15s heartbeat need, never by rebuilding every tick. Lives here beside its
// sibling seams (ageBucket = the signature's age fold, stripSubMinuteAge = the panel
// skip-key's) and stays pure/vscode-free so it is unit-tested directly.

export interface FreshnessNeed {
  /** The tree change-signature differs from the one the last built model carried.
   *  Attention flips, status/structure changes, agent-count moves all change it
   *  (it is the sidebar tree's own repaint signature), so they always rebuild. */
  signatureChanged: boolean;
  /** The floating panel is open this tick (a consumer of the model). */
  panelOpen: boolean;
  /** The panel opened on THIS tick (a false→true transition). An open must deliver
   *  a current model immediately even if the signature happens to be unchanged. */
  panelJustOpened: boolean;
  /** Cross-host publishing is live this tick: cross-host enabled AND the companion
   *  bridge is available AND this host has an identity. */
  bridgePublishing: boolean;
  /** The bridge's 15s heartbeat is due (or nothing has been published yet). When
   *  due, publish() republishes even an UNCHANGED snapshot to refresh the receiver's
   *  liveness clock — so a fresh model must be built even on a quiet tick. Preserving
   *  this is what keeps peers inside their live window; it must never be dropped. */
  heartbeatDue: boolean;
}

export interface BuildDecision {
  /** Run buildPanelModel() this tick. False = quiet-tick skip (the whole point). */
  build: boolean;
  /** Publish the snapshot to peers this tick. True only when the bridge actually
   *  needed fresh data (a signature change or a due heartbeat) — so every publish
   *  is either a real change or the heartbeat, never a redundant unchanged re-post. */
  publish: boolean;
}

/** Decide whether the per-tick panel model must be built, and whether the bridge
 *  should publish from it. Pure: same inputs → same decision, no clock, no I/O.
 *
 *  build   = a consumer needs a fresh model: the open panel on a real change (or its
 *            own open), OR the bridge on a real change or a due heartbeat.
 *  publish = the bridge specifically needed it (change or heartbeat) — a panel-only
 *            build (e.g. the panel just opened on an otherwise-quiet tick) does not
 *            trigger a publish.
 *
 *  TREE-PARITY CONTRACT (the intended, reviewed behavior — not a bug). Gating on the
 *  tree change-signature moves the panel and the published snapshot from
 *  strictly-fresher-than-the-tree to EXACTLY tree parity: a state change repaints the
 *  panel / republishes iff it would repaint the sidebar tree row. Two purely-cosmetic
 *  fields are folded into the signature only coarsely, so both the sidebar row AND
 *  (now) the panel/snapshot defer them identically until the next real change, minute
 *  rollover, or 15s heartbeat:
 *    1. the same-file collision glyph ("⚠ same file …") — not folded, so an appearing
 *       or vanishing collision waits for the next signature move, exactly as the tree
 *       row already does; and
 *    2. a remote session's running-child count ("⚙N") — the signature folds remote
 *       children by COUNT, not per-child running state, so a remote child flipping
 *       running→done at constant count defers, exactly as the tree row already does.
 *  Neither carries attention / status / liveness (those DO move the signature and
 *  always rebuild), and cross-host peers are additionally heartbeat-bounded (≤15s + 1
 *  tick, ≪ the 45s live window). Deferring these two to tree parity is the stated
 *  trade — the sidebar tree has always shown them this way.
 *
 *  The tree-parity premise only STRENGTHENS as the signature grows richer. The
 *  needs-you inbox lane (tree.ts) added the ranked triage-id list to the signature,
 *  so an inbox reorder now moves it — which means the panel model's own `inbox`
 *  section (built from the same buildTriageSet, and every inbox row's content from
 *  per-session fields the signature already folds) rebuilds the instant its membership
 *  OR intra-tier order changes. That reorder term makes the gate MORE complete, not
 *  less: a busier signature simply skips fewer quiet ticks, never a needed one. */
export function decidePanelBuild(need: FreshnessNeed): BuildDecision {
  const panelNeeds = need.panelOpen && (need.signatureChanged || need.panelJustOpened);
  const bridgeNeeds = need.bridgePublishing && (need.signatureChanged || need.heartbeatDue);
  return { build: panelNeeds || bridgeNeeds, publish: bridgeNeeds };
}
