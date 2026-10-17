// Codex CLI (`codex` / `codex exec`) session discovery. Codex writes one JSONL
// "rollout" file per session under ~/.codex/sessions/YYYY/MM/DD/:
//   rollout-<localTime>-<sessionId>.jsonl
// The FIRST line is a session_meta record carrying cwd, originator, source,
// cli_version and model_provider; subsequent lines are the transcript. The file's
// mtime advances on every event, so it is the activity signal (no db to read).
// Liveness comes from a process scan for those whose argv0 basename is "codex",
// matched to a session by cwd == session cwd (same shape as cursor.ts). The scan
// lives behind the procs.ts seam: on Linux it reads /proc, elsewhere it returns
// nothing and liveness falls back to the activity-window heuristic below.
// Pure Node module (no vscode import) so it is testable outside the IDE.
//
// Note: ~/.codex/session_index.jsonl exists but is a single stale row without a
// cwd — it does not index sessions usefully, so we walk the (bounded) tree.
import { openSync, readSync, closeSync, readdirSync, statSync, fstatSync, readFileSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { claudeAncestorPid, procCensus, pidAlive, pidCmdline, type LiveProc } from "./procs";
import { recordCodexHealth, pruneCodexHealth, recordCopilotHealth, pruneCopilotHealth } from "./canary";

export type CodexProvenance = "interactive" | "exec" | "subagent";

/** Classify a rollout's provenance from its head fields. Conservative: an unknown
 *  or empty `source` is treated as "interactive" (i.e. "ours" / actionable), so an
 *  ambiguous run is never wrongly demoted.
 *   - "subagent": a Codex subagent rollout (has subagentRole or parentId).
 *   - "exec":     a non-interactive `codex exec` run (source "exec" or originator
 *                 "codex_exec") — machine/agent-driven, not a user window.
 *   - "interactive": everything else (cli / vscode / other IDE / unknown) — a
 *                 session the user ran in their own window/terminal. */
export function classifyProvenance(m: {
  source: string;
  originator: string;
  subagentRole: string;
  parentId: string;
}): CodexProvenance {
  if (m.subagentRole !== "" || m.parentId !== "") return "subagent";
  if (m.source === "exec" || m.originator === "codex_exec") return "exec";
  return "interactive";
}

// ---- Launcher attribution (Goal B, part 2) ----------------------------------
// A `codex exec` run spawned by a Claude subagent's Bash currently attributes to its
// cwd project. To attribute it to the WRAPPER subagent that launched it, we match the
// rollout to a candidate launcher window by cwd + a start-time overlap: the rollout's
// session_meta `timestamp` (its birth) falls at or just after the launcher's Bash
// tool_use. IMPORTANT boundary: discovery.ts captures only tool NAMES, never tool
// INPUTS (see the `pendingEditPath` note), so this match keys on FILE METADATA a
// launcher window already exposes (its cwd and active time span) — never on scraping
// the `codex exec …` command line out of a Bash tool_use input. The rule is
// deliberately conservative: a unique launcher whose window brackets the rollout
// start wins; zero or ambiguous (≥2) candidates → no attribution (leave the run where
// the #39 provenance/fold machinery already puts it). Pure + unit-tested.

/** A candidate spawning launcher (a Claude subagent that shells out to codex). */
export interface LauncherWindow {
  /** Opaque launcher id (e.g. the subagent agentId) returned on a match. */
  id: string;
  /** The launcher's working directory (a subagent inherits its session's cwd). A run
   *  is only attributable when its rollout cwd matches (the subagent either ran codex
   *  in-place or `-C`'d into this dir — both share this cwd). */
  cwd: string;
  /** Earliest instant (ms) the launcher could have spawned the run — the start of its
   *  active window. */
  fromMs: number;
  /** Latest instant (ms) the launcher could have spawned the run — the end of its
   *  active window (typically last transcript write). */
  toMs: number;
}

/** How far AFTER a launcher's window end a rollout may still start and be considered
 *  spawned by it (a rollout is written moments after the `codex exec` fires). */
export const LAUNCH_GRACE_MS = 15_000;

/** Attribute a codex rollout to the unique launcher whose cwd matches and whose
 *  active window (widened by {@link LAUNCH_GRACE_MS}) brackets the rollout's start.
 *  Returns the launcher id, or undefined when there is no match OR the match is
 *  ambiguous (≥2 launchers bracket the same start) — the conservative "leave it where
 *  #39 put it" outcome. `startedMs` of 0 (unknown rollout birth) never matches. */
export function matchCodexLauncher(
  rollout: { cwd: string; startedMs: number },
  launchers: readonly LauncherWindow[]
): string | undefined {
  if (rollout.startedMs <= 0) return undefined;
  const hits = launchers.filter(
    (l) =>
      l.cwd === rollout.cwd &&
      rollout.startedMs >= l.fromMs &&
      rollout.startedMs <= l.toMs + LAUNCH_GRACE_MS
  );
  return hits.length === 1 ? hits[0].id : undefined;
}

/** Which CLI wrote the row. Copilot CLI sessions ride the codex lane (same node,
 *  panel and bridge shapes); only the label, icon, resume command, contextValue
 *  and bridge `tool` branch on it. */
export type CodexFamily = "codex" | "copilot";

export interface CodexRow {
  family: CodexFamily;
  /** The rollout's OWN thread id (`session_meta.payload.id`) — unique per rollout
   *  file. A Codex subagent rollout reuses the PARENT's `session_id` but carries a
   *  distinct `id`, so identity keys on `id`: keying on `session_id` collapses a
   *  parent and its subagent into one id and hard-crashes the tree (VS Code rejects
   *  a duplicate TreeItem id and renders nothing). */
  id: string;
  cwd: string;
  /** Short label: first user-message snippet, or "codex exec"/"codex" fallback. */
  name: string;
  /** "codex exec" (non-interactive) or "codex" (interactive/IDE). */
  kind: string;
  /** Parent session id for a subagent rollout (`parent_thread_id`), else "". Links a
   *  subagent back to the session that spawned it (both share the same `cwd`, so they
   *  attribute to the same project). */
  parentId: string;
  /** Subagent role when this rollout is a Codex subagent (`source.subagent`, e.g.
   *  "review"), else "" for a normal top-level session. */
  subagentRole: string;
  provenance: CodexProvenance;
  /** True when this run is NOT a user-run interactive session — i.e. provenance
   *  is "exec" or "subagent" (machine/agent-driven). Drives demotion + attention
   *  suppression. */
  external: boolean;
  /** True when a live `codex` process was matched to this rollout (pid set). A
   *  `codex exec` run with no live process has ENDED (it is non-interactive, so
   *  absence of a process means finished). */
  live: boolean;
  /** PID of the nearest live `claude` ancestor of this run's `codex` process,
   *  found by walking the /proc parent chain — the Claude Code session that spawned
   *  this run. Set ONLY for live runs with a confident ancestor match; undefined
   *  otherwise (ended runs, no ancestor, non-Linux). The tree folds a row with this
   *  set under the matching Claude session row. */
  parentClaudePid?: number;
  originator: string;
  modelProvider: string;
  /** Model id from the rollout's `turn_context` record (e.g. "gpt-5.5"); "" when the
   *  head carried no turn_context. session_meta itself has only the provider. */
  model: string;
  /** Seconds since last activity (rollout file mtime). */
  ageSec: number;
  /** Last-activity timestamp in ms (used for sorting). */
  updatedMs: number;
  /** Rollout START time in ms (session_meta `timestamp`); 0 when absent. The key a
   *  launcher time-window match uses to attribute an agent-spawned run to the wrapper
   *  subagent that launched it (see matchCodexLauncher). */
  startedMs: number;
  status: "working" | "idle";
  /** True when the session's last turn boundary in the rollout is `task_complete`
   *  — the turn finished and a final agent message was produced (it is at rest,
   *  not mid-turn). Drives the "finished-unread" signal. `false` when the tail is
   *  a still-open turn (`task_started` with no later `task_complete`) or when the
   *  tail is unparseable — so a running/ambiguous session is never marked unread. */
  endedTurn: boolean;
  /** The final agent message of the last completed turn (`task_complete`'s
   *  `last_agent_message`), captured in the same tail read `endedTurn` uses — the
   *  source for the finished-unread "done" caption. Undefined when the turn is still
   *  open or the payload carried no message. */
  lastAgentMessage?: string;
  /** Live `codex` pid when a running process matches this session's cwd. */
  pid?: number;
  /** Absolute path to the rollout .jsonl file backing this session. */
  rolloutPath: string;
  /** Codex CLI version from the rollout head (`session_meta.cli_version`); "" absent. */
  cliVersion: string;
  /** Copilot only: a live session whose last structural event is an unanswered
   *  `permission.requested` (it waits on the user's approval). */
  attention?: boolean;
  /** Copilot only: who drives the session, from workspace.yaml `client_name`
   *  (`github/cli` → "cli", `vscode-agent-host` → "vscode" (VS Code Copilot Chat),
   *  anything else → "other"). */
  surface?: "cli" | "vscode" | "other";
  /** Copilot only: "ask" when a top-level `subagent.selected` picked `vscode-ask`
   *  (a VS Code Ask chat), else "agent". */
  mode?: "agent" | "ask";
}

/** A session is shown when process-matched or active within this window. */
const RELEVANT_MS = 15 * 60_000;
/** Activity newer than this reads as "working". */
const WORKING_MS = 60_000;
/** Bytes read from the head of a rollout to parse meta + first user message.
 *  The session_meta line (with base_instructions) plus the developer message can
 *  be ~30KB, so 96KB comfortably reaches the first user_message event. */
const HEAD_BYTES = 96 * 1024;
/** Bytes read from the TAIL of a rollout to find the last turn boundary. The last
 *  `task_complete` (with its `last_agent_message`) is the final line and is well
 *  under this; the largest observed rollout lines are ~42KB, so 192KB comfortably
 *  captures the last complete record even when a long turn precedes it. */
const TAIL_BYTES = 192 * 1024;

function sessionsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

/** Live `codex` processes with their cwd. Now an adapter over the shared /proc
 *  census (procs.ts) — the census owns the single 30s TTL and this reads its codex
 *  bucket. Empty on non-Linux (and over a transient /proc failure), where liveness
 *  degrades to the mtime activity window, exactly as before. */
function liveProcs(): LiveProc[] {
  return procCensus().codex;
}

/** readdir entries that are all-digits (year/month/day shards), ascending. */
function numericEntries(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((e) => /^\d+$/.test(e)).sort();
}

/** The two most recent YYYY/MM/DD day directories (today + yesterday, tz-agnostic:
 *  newest dirs win regardless of UTC/local sharding). Bounds every later scan. */
function recentDayDirs(root: string): string[] {
  const days: Array<{ key: string; path: string }> = [];
  // newest 2 years is plenty; guards a huge multi-year tree
  for (const y of numericEntries(root).slice(-2)) {
    const yp = join(root, y);
    for (const m of numericEntries(yp)) {
      const mp = join(yp, m);
      for (const d of numericEntries(mp)) {
        days.push({ key: `${y}-${m}-${d}`, path: join(mp, d) });
      }
    }
  }
  days.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return days.slice(0, 2).map((d) => d.path);
}

interface CodexMeta {
  id: string;
  cwd: string;
  /** `parent_thread_id` — the spawning session's id for a subagent rollout, else "". */
  parentId: string;
  /** `source.subagent` role (e.g. "review") for a subagent rollout, else "". */
  subagentRole: string;
  originator: string;
  source: string;
  modelProvider: string;
  /** Model id from the head's `turn_context` record ("" when absent). */
  model: string;
  /** Codex CLI version from the head (`cli_version`), for the drift NOTE; "" absent. */
  cliVersion: string;
  /** Rollout START time in ms (the session_meta record's own `timestamp`), 0 when
   *  absent/unparseable. This is the datum a launcher time-window match keys on — the
   *  rollout begins moments after the `codex exec` that spawned it. */
  startedMs: number;
  snippet: string;
}

interface RolloutMeta {
  session_id?: unknown;
  /** The rollout's own unique thread id. Present since Codex started writing it; a
   *  subagent's `id` differs from its `session_id` (which mirrors the parent). */
  id?: unknown;
  /** Set on a subagent rollout to the spawning session's id. */
  parent_thread_id?: unknown;
  cwd?: unknown;
  originator?: unknown;
  source?: unknown;
  model_provider?: unknown;
  cli_version?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** First non-empty line of a user message, whitespace-collapsed and truncated. */
function snippetOf(message: string): string {
  const line = message.split("\n").find((l) => l.trim() !== "") ?? "";
  const clean = line.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

/** Read the head of a rollout file and parse the session_meta line plus the first
 *  user_message event. Never reads the whole file. Returns null when unparseable.
 *  Exported as the structural seam the format-canary fixture locks. */
export function parseHead(path: string): CodexMeta | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  let text: string;
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    text = buf.toString("utf8", 0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  const lines = text.split("\n");
  // Drop the last element: it is a partial line when the file exceeds HEAD_BYTES.
  if (lines.length > 1) lines.pop();

  let meta: CodexMeta | null = null;
  let snippet = "";
  let model = "";
  for (const line of lines) {
    if (line === "") continue;
    let obj: { type?: unknown; payload?: unknown; timestamp?: unknown };
    try {
      obj = JSON.parse(line) as { type?: unknown; payload?: unknown; timestamp?: unknown };
    } catch {
      continue;
    }
    const payload = obj.payload;
    if (meta === null && obj.type === "session_meta" && typeof payload === "object" && payload !== null) {
      const p = payload as RolloutMeta;
      // Identity is the rollout's OWN thread id (`id`), unique per file. A subagent
      // rollout carries the PARENT's `session_id` but a distinct `id`, so keying on
      // `id` is what stops parent+subagent from colliding into one tree node. Fall
      // back to `session_id` only for older rollouts predating the `id` field.
      const id = str(p.id) !== "" ? str(p.id) : str(p.session_id);
      const cwd = str(p.cwd);
      if (id === "" || cwd === "") return null;
      const src = p.source;
      const subagentRole =
        typeof src === "object" &&
        src !== null &&
        typeof (src as { subagent?: unknown }).subagent === "string"
          ? (src as { subagent: string }).subagent
          : "";
      meta = {
        id,
        cwd,
        parentId: str(p.parent_thread_id),
        subagentRole,
        originator: str(p.originator),
        source: str(p.source),
        modelProvider: str(p.model_provider),
        model: "",
        cliVersion: str(p.cli_version),
        startedMs: typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) || 0 : 0,
        snippet: "",
      };
    } else if (
      model === "" &&
      obj.type === "turn_context" &&
      typeof payload === "object" &&
      payload !== null
    ) {
      // The model rides turn_context, not session_meta (which has only the provider).
      model = str((payload as { model?: unknown }).model);
    } else if (
      snippet === "" &&
      obj.type === "event_msg" &&
      typeof payload === "object" &&
      payload !== null &&
      (payload as { type?: unknown }).type === "user_message"
    ) {
      snippet = snippetOf(str((payload as { message?: unknown }).message));
      if (meta !== null && model !== "") break; // have meta + snippet + model; stop early
    }
  }
  if (meta === null) return null;
  meta.snippet = snippet;
  meta.model = model;
  return meta;
}

// Parsed-meta cache keyed by file path, invalidated by mtime.
const metaCache = new Map<string, { mtimeMs: number; meta: CodexMeta | null }>();

function metaFor(path: string, mtimeMs: number): CodexMeta | null {
  const hit = metaCache.get(path);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.meta;
  const meta = parseHead(path);
  metaCache.set(path, { mtimeMs, meta });
  if (metaCache.size > 500) metaCache.clear();
  return meta;
}

/** Read the last TAIL_BYTES of a file as UTF-8 (whole file when smaller). Returns
 *  null when the file can't be opened/read. Never throws. */
function readTail(path: string, maxBytes: number = TAIL_BYTES): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, start);
    return buf.toString("utf8", 0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Whether a rollout's tail shows the session at rest after a completed turn.
 *  Scans the tail bottom-up for the last turn-boundary `event_msg`: `task_complete`
 *  ⇒ finished (true); `task_started` with no later completion ⇒ mid-turn (false).
 *  Trailing `token_count`/`response_item`/`agent_message` records are ignored — the
 *  turn boundary is authoritative. No boundary found (huge turn beyond the tail, or
 *  an unparseable tail) ⇒ false, so a running/ambiguous session is never "unread".
 *  Pure and side-effect-free for unit testing against captured fixtures. */
/** Scan the tail for the last turn boundary. `ended` is true when it is a
 *  `task_complete` (turn at rest, final agent message produced), false for a still-
 *  open `task_started` or when the tail is unparseable. When ended, `lastAgentMessage`
 *  carries the completion's `last_agent_message` (the finished-unread caption source),
 *  read in the SAME pass so no extra I/O is added. */
export function tailInfo(tailText: string): { ended: boolean; lastAgentMessage?: string } {
  const lines = tailText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    let obj: { type?: unknown; payload?: unknown };
    try {
      obj = JSON.parse(line) as { type?: unknown; payload?: unknown };
    } catch {
      continue; // a truncated first line of the tail window, or noise
    }
    if (obj.type !== "event_msg") continue;
    const p = obj.payload;
    if (typeof p !== "object" || p === null) continue;
    const pt = (p as { type?: unknown }).type;
    if (pt === "task_complete") {
      const m = (p as { last_agent_message?: unknown }).last_agent_message;
      return { ended: true, lastAgentMessage: typeof m === "string" ? m : undefined };
    }
    if (pt === "task_started") return { ended: false };
  }
  return { ended: false };
}

/** Back-compat boolean view of {@link tailInfo} (kept for existing callers/tests). */
export function endedTurn(tailText: string): boolean {
  return tailInfo(tailText).ended;
}

// endedTurn cache keyed by file path, invalidated by mtime (the tail is re-read
// only when the rollout actually grows, like the head-meta cache above).
const tailCache = new Map<string, { mtimeMs: number; ended: boolean; lastAgentMessage?: string }>();

function tailInfoFor(path: string, mtimeMs: number): { ended: boolean; lastAgentMessage?: string } {
  const hit = tailCache.get(path);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return { ended: hit.ended, lastAgentMessage: hit.lastAgentMessage };
  const tail = readTail(path);
  const info = tail !== null ? tailInfo(tail) : { ended: false };
  tailCache.set(path, { mtimeMs, ended: info.ended, lastAgentMessage: info.lastAgentMessage });
  if (tailCache.size > 500) tailCache.clear();
  return info;
}

interface Candidate {
  path: string;
  meta: CodexMeta;
  mtimeMs: number;
}

/** Scan the newest two day-dirs for rollout files, reading each one's cached head.
 *  `scanned` is every rollout path visited this tick (healthy or failed) — the live
 *  set the codex health map is pruned to, so a `failed` entry that leaves the window
 *  can't linger. */
function scanSessions(): { candidates: Candidate[]; scanned: Set<string> } {
  const out: Candidate[] = [];
  const scanned = new Set<string>();
  for (const dir of recentDayDirs(sessionsRoot())) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
      const path = join(dir, f);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      scanned.add(path);
      const meta = metaFor(path, mtimeMs);
      // Format-canary: a rollout whose head no longer parses into a session_meta
      // (required session_id + cwd) is the Codex drift signal — the exact failure
      // that would silently drop the session from the tree. Recorded off the
      // already-cached head read; scanSessions only visits the two most-recent
      // day-dirs, so every file here is inherently recent, and the ≥2-file alarm
      // threshold absorbs a lone half-written file.
      recordCodexHealth(path, meta !== null, meta?.cliVersion === "" ? undefined : meta?.cliVersion);
      if (meta === null) continue;
      out.push({ path, meta, mtimeMs });
    }
  }
  // Defense in depth: never surface two candidates with the same identity (`id`).
  // `id` is unique per rollout, but a resumed/re-written session could reuse one —
  // keep the freshest so the tree's id space stays collision-free and row counts
  // stay honest. (`scanned` still holds every visited path for health pruning.)
  const byId = new Map<string, Candidate>();
  for (const c of out) {
    const prev = byId.get(c.meta.id);
    if (prev === undefined || c.mtimeMs > prev.mtimeMs) byId.set(c.meta.id, c);
  }
  return { candidates: [...byId.values()], scanned };
}

function kindOf(meta: CodexMeta): string {
  return meta.source === "exec" || meta.originator === "codex_exec" ? "codex exec" : "codex";
}

/** All currently-relevant Codex CLI sessions: process-matched, or with activity in
 *  the last 15 minutes. Newest activity first. `windowMs` overrides the relevance
 *  window (tests only; production uses the default). */
export function codexSessions(windowMs: number = RELEVANT_MS): CodexRow[] {
  const now = Date.now();
  const { candidates: sessions, scanned } = scanSessions();
  // Keep the format-canary health map bounded to rollouts scanned this tick, so a
  // stale `failed` entry can't latch `driftSuspected` after its file leaves the window.
  pruneCodexHealth(scanned);
  if (sessions.length === 0) return [];

  // Assign each live `codex` pid to the newest session sharing its cwd.
  const procs = liveProcs();
  const pidById = new Map<string, number>();
  if (procs.length > 0) {
    const byCwd = new Map<string, Candidate[]>();
    for (const c of sessions) {
      const list = byCwd.get(c.meta.cwd) ?? [];
      list.push(c);
      byCwd.set(c.meta.cwd, list);
    }
    for (const list of byCwd.values()) list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const p of procs) {
      const list = byCwd.get(p.cwd);
      if (list === undefined) continue;
      const target = list.find((c) => !pidById.has(c.meta.id));
      if (target !== undefined) pidById.set(target.meta.id, p.pid);
    }
  }
  const claudePids = new Set<number>(procCensus().claude.map((c) => c.pid));

  const relevant = sessions.filter(
    (c) => pidById.has(c.meta.id) || (c.mtimeMs > 0 && now - c.mtimeMs < windowMs)
  );
  if (relevant.length === 0) return [];

  const rows: CodexRow[] = relevant.map((c) => {
    const ageSec = (now - c.mtimeMs) / 1000;
    const kind = kindOf(c.meta);
    const name = c.meta.snippet !== "" ? c.meta.snippet : kind;
    const info = tailInfoFor(c.path, c.mtimeMs);
    const provenance = classifyProvenance(c.meta);
    const pid = pidById.get(c.meta.id);
    const live = pid !== undefined;
    const external = provenance !== "interactive";
    // Fold only machine-driven runs. An interactive (user-run) codex session that
    // happens to sit in a Claude-owned process tree is the user's own window — never
    // nest it under a session. Gating on `external` keeps folding to exec/subagent.
    const parentClaudePid =
      external && pid !== undefined && claudePids.size > 0
        ? claudeAncestorPid(pid, claudePids)
        : undefined;
    return {
      family: "codex",
      id: c.meta.id,
      cwd: c.meta.cwd,
      name,
      kind,
      parentId: c.meta.parentId,
      subagentRole: c.meta.subagentRole,
      provenance,
      external,
      live,
      parentClaudePid,
      originator: c.meta.originator,
      modelProvider: c.meta.modelProvider,
      model: c.meta.model,
      ageSec,
      updatedMs: c.mtimeMs,
      startedMs: c.meta.startedMs,
      status: ageSec * 1000 < WORKING_MS ? "working" : "idle",
      endedTurn: info.ended,
      lastAgentMessage: info.lastAgentMessage,
      pid,
      rolloutPath: c.path,
      cliVersion: c.meta.cliVersion,
    };
  });
  rows.sort((a, b) => b.updatedMs - a.updatedMs);
  return rows;
}

// ---- GitHub Copilot CLI (`copilot`) ------------------------------------------
// Copilot CLI writes one directory per session under
//   $COPILOT_HOME (default ~/.copilot)/session-state/<uuid>/
// holding `events.jsonl` (append-only event log), `workspace.yaml` (flat scalars:
// cwd, name, …) and, while a process has the session open, `inuse.<pid>.lock`
// (content = pid of the native `copilot` binary; a clean exit removes it, a
// SIGKILL leaves it stale, so the pid must be checked). Copilot rows ride the
// codex lane: `copilotSessions()` returns `CodexRow`s with `family: "copilot"`.
// See docs/CONTRACTS.md "GitHub Copilot CLI sessions".

/** Events that decide status, title and turn boundaries. Everything else
 *  (`model.*` side-calls, usage records, `session.info`, `system.message`,
 *  `hook.*`, `subagent.*`, unknown types) is skipped for status. A top-level
 *  `subagent.selected`/`deselected` (no envelope `agentId`) is a mode switch and
 *  is read for `mode` only; lines WITH `agentId` are subagent traffic. */
const COPILOT_STRUCTURAL = new Set([
  "session.start",
  "session.resume",
  "user.message",
  "assistant.turn_start",
  "assistant.message",
  "tool.execution_start",
  "tool.execution_complete",
  "permission.requested",
  "permission.completed",
  "assistant.turn_end",
  "session.shutdown",
]);
/** Newest session dirs read per scan (by events.jsonl mtime). */
const COPILOT_MAX_DIRS = 50;
/** Wider tail windows tried, in order, when the default window holds no
 *  structural event at all (one huge non-structural line, e.g. a big
 *  system.message or tool output, filled it). Bounded. */
const COPILOT_TAIL_RETRY_BYTES = [1024 * 1024, 4 * 1024 * 1024];

/** A top-level mode switch: `subagent.selected` of `vscode-ask` = Ask chat,
 *  `subagent.deselected` (or another selection) = back to agent. */
function modeSwitch(e: CopilotEvent): "agent" | "ask" | undefined {
  if (e.sub) return undefined;
  if (e.type === "subagent.selected") return str(e.data.agentName) === "vscode-ask" ? "ask" : "agent";
  if (e.type === "subagent.deselected") return "agent";
  return undefined;
}

/** `workspace.yaml` `client_name` → the surface that drives the session. */
export function copilotSurface(clientName: string): "cli" | "vscode" | "other" {
  if (clientName === "github/cli") return "cli";
  if (clientName === "vscode-agent-host") return "vscode";
  return "other";
}

/** `$COPILOT_HOME/session-state`, defaulting to `~/.copilot/session-state`. */
export function copilotRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const base = env.COPILOT_HOME !== undefined && env.COPILOT_HOME !== "" ? env.COPILOT_HOME : join(home, ".copilot");
  return join(base, "session-state");
}

function yamlScalar(raw: string): string | null {
  const v = raw.trim();
  if (v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith("'")) return null;
    const inner = v.slice(1, -1);
    // A lone quote inside a single-quoted scalar is malformed; '' is the escape.
    if (inner.replace(/''/g, "").includes("'")) return null;
    return inner.replace(/''/g, "'");
  }
  if (v.startsWith('"')) {
    try {
      const out = JSON.parse(v) as unknown;
      return typeof out === "string" ? out : null;
    } catch {
      return null;
    }
  }
  return v;
}

/** Flat `key: value` reader for `workspace.yaml` (every key Copilot writes is a
 *  scalar). Handles plain, single-quoted (`''` escape) and double-quoted scalars,
 *  quoted scalars folded over indented continuation lines, and `|`/`>` blocks.
 *  Unknown keys are kept, the caller picks what it needs. null when nothing parses
 *  or a quoted scalar is malformed (the canary's parse-health datum). */
export function readWorkspaceYaml(text: string): Record<string, string> | null {
  const out = Object.create(null) as Record<string, string>;
  const lines = text.split(/\r?\n/);
  let keys = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (m === null) continue;
    let raw = m[2] ?? "";
    const block = /^[|>][-+]?$/.test(raw.trim()) ? raw.trim()[0] : undefined;
    const quoted = raw.startsWith("'") || raw.startsWith('"');
    if (block !== undefined || quoted) {
      const more: string[] = [];
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
      if (block !== undefined) {
        out[m[1]] = more.join(block === "|" ? "\n" : " ");
        keys++;
        continue;
      }
      if (more.length > 0) raw = [raw, ...more].join(" ");
    }
    const v = yamlScalar(raw);
    if (v === null) return null;
    out[m[1]] = v;
    keys++;
  }
  return keys > 0 ? out : null;
}

interface CopilotEvent {
  type: string;
  data: Record<string, unknown>;
  /** Envelope `agentId`: the line belongs to an inline subagent. */
  sub: boolean;
}

function copilotEvent(line: string): CopilotEvent | null {
  if (line.trim() === "") return null;
  let obj: { type?: unknown; data?: unknown; agentId?: unknown };
  try {
    obj = JSON.parse(line) as { type?: unknown; data?: unknown; agentId?: unknown };
  } catch {
    return null; // a cut first/last line of a byte window, or noise
  }
  if (typeof obj.type !== "string") return null;
  const data = typeof obj.data === "object" && obj.data !== null ? (obj.data as Record<string, unknown>) : {};
  return { type: obj.type, data, sub: typeof obj.agentId === "string" && obj.agentId !== "" };
}

/** Model: the latest of `session.start.data.selectedModel`,
 *  `session.model_change.data.newModel` and `session.auto_mode_resolved.data.chosenModel`
 *  in file order wins. An explicit switch after an Auto resolution shows the explicit
 *  model; a switch back to "auto" shows "auto" until the next resolution. Fed in one
 *  pass alongside the status scan; subagent lines and `model.*` side-calls never count. */
class CopilotModel {
  private latest = "";
  see(e: CopilotEvent): void {
    if (e.sub) return;
    const m =
      e.type === "session.start"
        ? str(e.data.selectedModel)
        : e.type === "session.model_change"
          ? str(e.data.newModel)
          : e.type === "session.auto_mode_resolved"
            ? str(e.data.chosenModel)
            : "";
    if (m !== "") this.latest = m;
  }
  get value(): string {
    return this.latest;
  }
}

export interface CopilotHead {
  /** `session.start.data.sessionId`. */
  sessionId: string;
  /** `session.start.data.context.cwd` ("" absent; workspace.yaml `cwd` wins). */
  cwd: string;
  /** `session.start.data.copilotVersion` ("" absent). */
  cliVersion: string;
  /** Model resolved from the head events ("" none). */
  model: string;
  /** `session.start.data.startTime` in ms (0 absent). */
  startedMs: number;
  /** First non-subagent `user.message` content, snippeted ("" none). */
  snippet: string;
  /** Last top-level mode switch in the head window, if any. */
  mode?: "agent" | "ask";
}

/** Parse the head of `events.jsonl` (the first {@link HEAD_BYTES}). The first line
 *  must be `session.start`; the ~24 KB `system.message` comes after the first
 *  `user.message`, so the window reaches it. null without a `session.start`. */
export function parseCopilotHead(text: string): CopilotHead | null {
  const lines = text.split("\n");
  if (lines.length > 1 && !text.endsWith("\n")) lines.pop(); // partial last line
  let head: CopilotHead | null = null;
  const model = new CopilotModel();
  for (const line of lines) {
    const e = copilotEvent(line);
    if (e === null) continue;
    model.see(e);
    const sw = modeSwitch(e);
    if (sw !== undefined && head !== null) head.mode = sw;
    if (head === null) {
      if (e.type !== "session.start" || e.sub) continue;
      const ctx = typeof e.data.context === "object" && e.data.context !== null ? (e.data.context as Record<string, unknown>) : {};
      const sessionId = str(e.data.sessionId);
      if (sessionId === "") return null;
      head = {
        sessionId,
        cwd: str(ctx.cwd),
        cliVersion: str(e.data.copilotVersion),
        model: "",
        startedMs: Date.parse(str(e.data.startTime)) || 0,
        snippet: "",
      };
    } else if (head.snippet === "" && e.type === "user.message" && !e.sub) {
      head.snippet = snippetOf(str(e.data.content));
    }
  }
  if (head === null) return null;
  head.model = model.value;
  return head;
}

export interface CopilotTail {
  /** Last structural non-subagent event type ("" none in the window). */
  last: string;
  /** The last structural event is `assistant.turn_end` or `session.shutdown`. */
  endedTurn: boolean;
  /** A turn is open: the last structural event is inside a turn (user prompt,
   *  assistant message, tool call, permission) with no later turn end/shutdown. */
  openTurn: boolean;
  /** A turn is open and some `permission.requested` in it has no matching
   *  `permission.completed` (by `requestId`). Only meaningful for a live session. */
  permissionPending: boolean;
  /** A `session.resume` is in the window. */
  resumed: boolean;
  /** Final non-empty assistant message of the last finished turn (done caption). */
  lastAgentMessage?: string;
  /** Model resolved from the tail ("" none in the window). */
  model: string;
  /** Last top-level mode switch in the window, if any. */
  mode?: "agent" | "ask";
}

/** Scan a tail window of `events.jsonl` (structural events only, subagent lines
 *  ignored). Pure; never throws. */
export function copilotTailInfo(text: string): CopilotTail {
  const model = new CopilotModel();
  let last = "";
  // Approvals still waiting: concurrent tool calls raise several requests and
  // answer them one by one, so one completion must not clear the others.
  const pending = new Set<string>();
  let resumed = false;
  let message: string | undefined;
  let mode: "agent" | "ask" | undefined;
  for (const line of text.split("\n")) {
    const e = copilotEvent(line);
    if (e === null) continue;
    model.see(e);
    mode = modeSwitch(e) ?? mode;
    if (e.sub || !COPILOT_STRUCTURAL.has(e.type)) continue;
    last = e.type;
    if (e.type === "session.resume") resumed = true;
    if (e.type === "user.message") message = undefined;
    if (e.type === "assistant.message") {
      const c = str(e.data.content);
      if (c.trim() !== "") message = c;
    }
    if (e.type === "permission.requested") pending.add(str(e.data.requestId));
    else if (e.type === "permission.completed") pending.delete(str(e.data.requestId));
    else if (e.type === "assistant.turn_end" || e.type === "session.shutdown" || e.type === "session.resume") pending.clear();
  }
  const endedTurn = last === "assistant.turn_end" || last === "session.shutdown";
  const openTurn = last !== "" && !endedTurn && last !== "session.start" && last !== "session.resume";
  return {
    last,
    endedTurn,
    openTurn,
    permissionPending: openTurn && pending.size > 0,
    resumed,
    lastAgentMessage: endedTurn ? message : undefined,
    model: model.value,
    ...(mode !== undefined ? { mode } : {}),
  };
}

/** Is `pid` a running Copilot process? Signal-0 liveness, plus (Linux) the
 *  cmdline must name `copilot`, so a stale lock whose pid was reused by an
 *  unrelated process does not read as live. */
export function copilotPidAlive(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  const argv = pidCmdline(pid);
  if (argv === undefined) return true; // non-Linux / unreadable: signal-0 decides
  // The lock names the native binary (`…/@github/copilot-<platform>/copilot`, or a
  // standalone `copilot`); a node-run loader carries the package path as argv[1].
  // VS Code's Copilot Chat locks with its agent host's `copilot-runtime`.
  const exe = basename(argv[0] ?? "");
  return exe === "copilot" || exe === "copilot-runtime" || /[\\/]@github[\\/]copilot[\\/]/.test(argv[1] ?? "");
}

/** Does the Copilot process `pid` hold this session (its `inuse.<pid>.lock`
 *  beside `eventsPath`)? A clean exit removes the lock. */
export function copilotHoldsLock(pid: number, eventsPath: string): boolean {
  return existsSync(join(dirname(eventsPath), `inuse.${pid}.lock`));
}

/** The live pid holding a session dir (`inuse.<pid>.lock`), or undefined when no
 *  lock exists or every lock's pid is dead (stale lock after a SIGKILL). */
export function copilotLockPid(dir: string, isAlive: (pid: number) => boolean = copilotPidAlive): number | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const f of entries) {
    const m = /^inuse\.(\d+)\.lock$/.exec(f);
    if (m === null) continue;
    const pid = Number(m[1]);
    if (Number.isSafeInteger(pid) && pid > 1 && isAlive(pid)) return pid;
  }
  return undefined;
}

function readHeadText(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString("utf8", 0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

interface CopilotParsed {
  head: CopilotHead | null;
  yaml: Record<string, string> | null;
  yamlPresent: boolean;
  tail: CopilotTail;
}

const copilotCache = new Map<string, { key: string; parsed: CopilotParsed }>();

function copilotParsed(dir: string, events: string, mtimeMs: number, size: number): CopilotParsed {
  // workspace.yaml is rewritten on its own (a generated title lands after the
  // last event), so its mtime is part of the cache key.
  let yamlMtime = -1;
  try {
    yamlMtime = statSync(join(dir, "workspace.yaml")).mtimeMs;
  } catch {
    yamlMtime = -1;
  }
  const key = `${mtimeMs}:${size}:${yamlMtime}`;
  const hit = copilotCache.get(dir);
  if (hit !== undefined && hit.key === key) return hit.parsed;
  const headText = readHeadText(events);
  const head = headText === null ? null : parseCopilotHead(headText);
  let yamlText: string | null = null;
  try {
    yamlText = readFileSync(join(dir, "workspace.yaml"), "utf8");
  } catch {
    yamlText = null;
  }
  const yaml = yamlText === null ? null : readWorkspaceYaml(yamlText);
  let tail = copilotTailInfo(readTail(events) ?? "");
  let covered = TAIL_BYTES;
  for (const bytes of COPILOT_TAIL_RETRY_BYTES) {
    if (tail.last !== "" || size <= covered) break; // found one, or the window already held the whole file
    tail = copilotTailInfo(readTail(events, bytes) ?? "");
    covered = bytes;
  }
  // Still nothing structural in the widest window: one giant line fills the end
  // of the log. A turn end or shutdown would follow it as a short line, so the
  // turn is open.
  if (tail.last === "" && size > covered) tail = { ...tail, openTurn: true };
  const parsed: CopilotParsed = { head, yaml, yamlPresent: yamlText !== null, tail };
  copilotCache.set(dir, { key, parsed });
  if (copilotCache.size > 500) copilotCache.clear();
  return parsed;
}

export interface CopilotScanOptions {
  /** session-state directory (default {@link copilotRoot}). */
  root?: string;
  /** Clock in ms (tests). */
  now?: number;
  /** Pid liveness (tests). */
  isAlive?: (pid: number) => boolean;
  /** Live claude pids for the subagent fold (tests; default the /proc census). */
  claudePids?: Set<number>;
}

/** Copilot CLI sessions as codex-lane rows (`family: "copilot"`): a session dir
 *  is read when its `events.jsonl` changed within `windowMs` or a live process
 *  holds its lock; the newest {@link COPILOT_MAX_DIRS} dirs only. */
export function copilotSessions(windowMs: number = RELEVANT_MS, opts: CopilotScanOptions = {}): CodexRow[] {
  const root = opts.root ?? copilotRoot();
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? copilotPidAlive;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    pruneCopilotHealth(new Set());
    return [];
  }
  const dirs: Array<{ id: string; dir: string; events: string; mtimeMs: number; size: number }> = [];
  for (const id of names) {
    const dir = join(root, id);
    const events = join(dir, "events.jsonl");
    let mtimeMs: number;
    let size: number;
    try {
      const st = statSync(events);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      continue; // no events.jsonl: never a session we can show
    }
    dirs.push({ id, dir, events, mtimeMs, size });
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scanned = new Set<string>();
  const rows: CodexRow[] = [];
  let claudePids = opts.claudePids;
  for (const d of dirs.slice(0, COPILOT_MAX_DIRS)) {
    const pid = copilotLockPid(d.dir, isAlive);
    const live = pid !== undefined;
    if (!live && !(now - d.mtimeMs < windowMs)) continue;
    scanned.add(d.dir);
    const p = copilotParsed(d.dir, d.events, d.mtimeMs, d.size);
    // Parse health (canary): a session.start must lead the log, its sessionId
    // must name the dir, and a present workspace.yaml must parse.
    const healthy = p.head !== null && p.head.sessionId === d.id && (!p.yamlPresent || p.yaml !== null);
    recordCopilotHealth(d.dir, healthy, p.head !== null && p.head.cliVersion !== "" ? p.head.cliVersion : undefined);
    if (p.head === null || p.head.sessionId !== d.id) continue;
    const cwd = p.yaml?.cwd || p.head.cwd;
    if (cwd === "") continue;
    const surface = copilotSurface(yamlStr(p.yaml, "client_name"));
    const yamlName = p.yaml?.name ?? "";
    const name = yamlName.trim() !== "" ? snippetOf(yamlName) : p.head.snippet !== "" ? p.head.snippet : "copilot";
    const ageSec = Math.max(0, (now - d.mtimeMs) / 1000);
    // Mid-turn and live is working; a fresh write (< WORKING_MS) mid-turn counts too
    // (the codex rule), so a long tool call between two writes still reads working.
    const working = p.tail.openTurn && (live || ageSec * 1000 < WORKING_MS);
    if (pid !== undefined && claudePids === undefined) claudePids = new Set(procCensus().claude.map((c) => c.pid));
    const parentClaudePid = pid !== undefined && claudePids !== undefined && claudePids.size > 0 ? claudeAncestorPid(pid, claudePids) : undefined;
    rows.push({
      family: "copilot",
      id: d.id,
      cwd,
      name,
      kind: surface === "vscode" ? "Copilot (VS Code)" : surface === "cli" ? "Copilot CLI" : "Copilot",
      parentId: "",
      subagentRole: "",
      provenance: parentClaudePid !== undefined ? "subagent" : "interactive",
      external: false,
      live,
      parentClaudePid,
      originator: yamlStr(p.yaml, "client_name"),
      modelProvider: "github",
      model: p.tail.model || p.head.model,
      ageSec,
      updatedMs: d.mtimeMs,
      startedMs: p.head.startedMs,
      status: working ? "working" : "idle",
      endedTurn: p.tail.endedTurn,
      lastAgentMessage: p.tail.lastAgentMessage,
      pid,
      rolloutPath: d.events,
      cliVersion: p.head.cliVersion,
      attention: live && p.tail.permissionPending,
      surface,
      mode: p.tail.mode ?? p.head.mode ?? "agent",
    });
  }
  pruneCopilotHealth(scanned);
  rows.sort((a, b) => b.updatedMs - a.updatedMs);
  return rows;
}

function yamlStr(y: Record<string, string> | null, key: string): string {
  return y !== null && typeof y[key] === "string" ? y[key] : "";
}
