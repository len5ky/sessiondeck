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
import { openSync, readSync, closeSync, readdirSync, statSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { claudeAncestorPid, procCensus, type LiveProc } from "./procs";
import { recordCodexHealth, pruneCodexHealth } from "./canary";

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

export interface CodexRow {
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
function readTail(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
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
