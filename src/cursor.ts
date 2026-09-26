// Cursor Agent CLI ("agent" / cursor-agent binary) session discovery. These are
// terminal-run coding agents (grok etc.) whose per-chat state lives under
// ~/.cursor/chats/<workspaceHash>/<chatId>/:
//   meta.json  — {schemaVersion, createdAtMs, updatedAtMs, hasConversation, cwd}
//   store.db   — SQLite; table `meta`, key '0' value is a HEX-encoded JSON string
//                {agentId, name, mode, ...} carrying the chat's name + mode.
//   store.db-wal — present/fresh while the agent is actively writing.
// Liveness comes from a process scan for those whose argv0 basename is
// "cursor-agent", matched to a chat by cwd == meta.cwd. The scan is behind the
// procs.ts seam (Linux /proc; empty elsewhere → mtime-window fallback). Chat
// names/modes are read from store.db via the shared async sqliteSelect helper.
// Pure Node module (no vscode import) so it is testable outside the IDE.
import { closeSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { claudeAncestorPid, procCensus, type LiveProc } from "./procs";
import { sqliteSelect } from "./sqliteRead";
import { recordCursorHealth, recordCursorSchema, pruneCursorHealth } from "./canary";
import { CURSOR_SPOOL } from "./hooks";

export interface CursorHookEvent {
  event: string;
  ts: number;
  src?: string;
  payload: Record<string, unknown> | null;
}

export const ROTATE_BYTES = 1024 * 1024;

export class CursorEventTail {
  private offset: number;
  private malformed = 0;

  constructor(private readonly path: string = CURSOR_SPOOL) {
    try { this.offset = statSync(path).size; } catch { this.offset = 0; }
  }

  get malformedCount(): number { return this.malformed; }

  readNew(): CursorHookEvent[] {
    try {
      const size = statSync(this.path).size;
      if (size < this.offset) this.offset = 0;
      if (size === this.offset) return [];
      const readStart = this.offset;
      const fd = openSync(this.path, "r");
      let buf: Buffer;
      try {
        buf = Buffer.alloc(size - readStart);
        readSync(fd, buf, 0, buf.length, readStart);
      } finally { closeSync(fd); }
      // Split on the LAST newline byte in the raw buffer (not the decoded string) so the
      // complete/torn boundary is byte-exact even if a multibyte char straddled the read
      // boundary. Everything through that newline is complete records; the rest is a torn
      // suffix held back until its own newline lands.
      const lastNl = buf.lastIndexOf(0x0a);
      const completeBytes = lastNl + 1; // 0 when there is no newline at all
      const complete = buf.subarray(0, completeBytes).toString("utf8");
      const events: CursorHookEvent[] = [];
      const torn = completeBytes < buf.length;
      for (const line of complete.split("\n")) {
        if (!line.startsWith("{")) continue; // blank/whitespace segments carry no event
        try {
          const value = JSON.parse(line) as unknown;
          if (value !== null && typeof value === "object" && !Array.isArray(value)) events.push(value as CursorHookEvent);
          else this.malformed++;
        } catch {
          this.malformed++;
        }
      }
      // Advance only through the last COMPLETE line; a torn suffix stays unread so the
      // record is reconstructed once its trailing newline lands.
      this.offset = readStart + completeBytes;
      // Only rotate on a clean boundary — never mid-record (that would strand a torn tail).
      if (!torn && size > ROTATE_BYTES) {
        try { renameSync(this.path, `${this.path}.1`); this.offset = 0; } catch { /* retry later */ }
      }
      return events;
    } catch { return []; }
  }
}

export interface ComposerTokens { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface ComposerRow {
  conversationId: string;
  cwd: string;
  name: string;
  mode: string;
  isBackground: boolean;
  status: "working" | "idle";
  unreadEligible: boolean;
  ageSec: number;
  updatedMs: number;
  caption?: string;
  tokens?: ComposerTokens;
}

/** Decide how precisely a composer click can be honored in the window that owns
 *  it. We switch to a SPECIFIC tab only when its id is among that window's
 *  currently-open composer tabs — this guards the unverified case where a hook
 *  `conversation_id` doesn't equal a Cursor `composerId` (see docs/CONTRACTS.md)
 *  and would otherwise select an empty/bogus composer. Otherwise we just reveal
 *  the agent pane. Pure (no vscode) so it is unit-testable. */
export function composerFocusPlan(
  openComposerIds: string[],
  composerId: string | undefined
): "tab" | "pane" {
  return composerId !== undefined && openComposerIds.includes(composerId) ? "tab" : "pane";
}

interface ComposerState extends Omit<ComposerRow, "status" | "unreadEligible" | "ageSec" | "updatedMs"> {
  lifecycle: "working" | "idle" | "closed";
  lastEventMs: number;
  everSubmit: boolean;
  seenStop: boolean;
}

const COMPOSER_WORKING_MS = 60_000;
const COMPOSER_RELEVANT_MS = 15 * 60_000;
const QUIET_MS = 2 * 60_000;
const EXPIRE_MS = 24 * 60 * 60_000;

function text(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === "string" ? payload[key] : "";
}

function tokens(payload: Record<string, unknown>): ComposerTokens | undefined {
  const keys = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const;
  if (!keys.some((key) => typeof payload[key] === "number")) return undefined;
  const number = (key: typeof keys[number]): number => typeof payload[key] === "number" ? payload[key] : 0;
  return { input: number(keys[0]), output: number(keys[1]), cacheRead: number(keys[2]), cacheWrite: number(keys[3]) };
}

function promptName(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 48);
}

export class ComposerTracker {
  private readonly states = new Map<string, ComposerState>();

  ingest(events: CursorHookEvent[]): void {
    for (const event of events) {
      const payload = event.payload;
      if (payload === null || typeof payload.conversation_id !== "string") continue;
      const id = payload.conversation_id;
      let state = this.states.get(id);
      const isNew = state === undefined;
      if (state === undefined) {
        state = { conversationId: id, cwd: "", name: "", mode: "", isBackground: false, lifecycle: "idle", lastEventMs: event.ts, everSubmit: false, seenStop: false };
        this.states.set(id, state);
      }
      // Concurrent probe processes can append out of timestamp order. An event OLDER than
      // the newest we've applied must not regress the lifecycle (e.g. a late thought
      // flipping a stopped session back to working) — track recency but skip its transition.
      const stale = !isNew && event.ts < state.lastEventMs;
      state.lastEventMs = Math.max(state.lastEventMs, event.ts);
      if (stale) continue;
      if (state.cwd === "" && Array.isArray(payload.workspace_roots) && payload.workspace_roots.length > 0 && payload.workspace_roots.every((value) => typeof value === "string")) {
        state.cwd = payload.workspace_roots[0];
      }
      switch (event.event) {
        case "sessionStart":
          state.mode = text(payload, "composer_mode"); state.isBackground = payload.is_background_agent === true;
          state.lifecycle = "idle"; state.caption = undefined; break;
        case "beforeSubmitPrompt":
          state.everSubmit = true; state.lifecycle = "working"; state.caption = "working";
          if (state.name === "" && typeof payload.prompt === "string") state.name = promptName(payload.prompt); break;
        case "afterAgentThought": state.lifecycle = "working"; state.caption = "thinking"; break;
        case "afterAgentResponse": state.lifecycle = "working"; state.caption = "responding"; state.tokens = tokens(payload) ?? state.tokens; break;
        case "afterFileEdit": {
          state.lifecycle = "working"; const path = text(payload, "file_path"); state.caption = path === "" ? "editing" : `editing ${basename(path)}`; break;
        }
        case "subagentStart": state.lifecycle = "working"; state.caption = "subagent"; break;
        case "subagentStop": state.lifecycle = "working"; state.caption = "subagent done"; break;
        case "stop": state.seenStop = true; state.lifecycle = "idle"; state.tokens = tokens(payload) ?? state.tokens; state.caption = undefined; break;
        case "sessionEnd": state.lifecycle = "closed"; break;
      }
    }
  }

  rows(now: number = Date.now()): ComposerRow[] {
    const rows: ComposerRow[] = [];
    for (const [id, state] of this.states) {
      const age = now - state.lastEventMs;
      if (state.lifecycle === "closed" || (state.lifecycle !== "working" && age > COMPOSER_RELEVANT_MS) || age > EXPIRE_MS) {
        this.states.delete(id); continue;
      }
      const working = state.lifecycle === "working" && !(state.mode === "ask" && age >= COMPOSER_WORKING_MS) && age < EXPIRE_MS;
      let caption = state.caption;
      if (working && age > QUIET_MS) caption = `${caption === undefined ? "" : `${caption} `}· quiet ${Math.round(age / 60_000)}m`;
      rows.push({ conversationId: id, cwd: state.cwd, name: state.name || "cursor composer", mode: state.mode, isBackground: state.isBackground,
        status: working ? "working" : "idle", unreadEligible: state.mode !== "ask", ageSec: age / 1000,
        updatedMs: state.lastEventMs, caption, tokens: state.tokens });
    }
    return rows.sort((a, b) => b.updatedMs - a.updatedMs);
  }

  size(): number { return this.states.size; }
}

export interface CursorRow {
  chatId: string;
  cwd: string;
  /** Chat name from store.db; "cursor agent" when empty/unavailable. */
  name: string;
  /** Chat mode (e.g. "search", "agent"); "" when unavailable. */
  mode: string;
  /** Seconds since last activity (max of updatedAtMs / wal / store mtime). */
  ageSec: number;
  /** Last-activity timestamp in ms (used for sorting). */
  updatedMs: number;
  status: "working" | "idle";
  /** Live cursor-agent pid when a running process matches this chat's cwd. */
  pid?: number;
  /** Absolute path to this chat's store.db (identity of the on-disk chat). */
  dbPath: string;
  /** True when this chat is a HEADLESS, machine-driven CLI run (`agent -p`, the
   *  grok-4.5 reviews an orchestrator spawns) rather than a user's interactive Cursor
   *  Agent. Set when a live matched process carries the headless flags, and then
   *  STICKY for the chat's life (see headlessSeen) so a finished headless run — which
   *  has no live process left — stays demoted instead of flipping to finished-unread
   *  with no window to open. Conservative like codex `external`: a chat never seen as
   *  a live headless process is treated as interactive ("ours") and is NOT demoted. */
  external: boolean;
  /** True when a live cursor-agent process was matched to this chat (pid set). A
   *  headless run with no live process has ENDED (mirrors CodexRow.live). */
  live: boolean;
  /** PID of the nearest live `claude` ancestor of a LIVE headless run's process,
   *  found by walking /proc — the Claude Code session that spawned it. Set only for a
   *  live headless run with a confident ancestor; undefined otherwise. The tree folds
   *  such a row under the matching Claude session's row (like folded codex runs). */
  parentClaudePid?: number;
}

/** A chat is shown when process-matched or active within this window. */
const RELEVANT_MS = 15 * 60_000;
/** Activity newer than this reads as "working". */
const WORKING_MS = 60_000;

function chatsRoot(): string {
  return join(homedir(), ".cursor", "chats");
}

/** Live cursor-agent processes with their cwd. Now an adapter over the shared
 *  /proc census (procs.ts) — the census owns the single 30s TTL and this reads its
 *  cursor-agent bucket. Empty on non-Linux (and over a transient /proc failure),
 *  where liveness degrades to the mtime activity window, exactly as before. */
function liveProcs(): LiveProc[] {
  return procCensus().cursorAgent;
}

/** mtime in ms, or 0 when the path is missing/unreadable. */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

interface ChatMeta {
  chatId: string;
  cwd: string;
  updatedMs: number;
  walMtime: number;
  storeMtime: number;
  dbPath: string;
}

/** Parsed meta.json fields, cached by chatId and invalidated by the file's mtime.
 *  meta.json's mtime advances whenever the chat updates (updatedAtMs changes), so
 *  this re-parses exactly when the content it reads can have changed and skips the
 *  readFile+JSON.parse on every other tick. */
const chatMetaCache = new Map<string, { mtimeMs: number; cwd: string; updatedMs: number }>();

/** Scan every chat's tiny meta.json (mtime-cached parse) + store.db/wal mtimes. */
function scanChats(): ChatMeta[] {
  const root = chatsRoot();
  const out: ChatMeta[] = [];
  let workspaces: string[];
  try {
    workspaces = readdirSync(root);
  } catch {
    return out;
  }
  for (const ws of workspaces) {
    const wsDir = join(root, ws);
    let chats: string[];
    try {
      chats = readdirSync(wsDir);
    } catch {
      continue;
    }
    for (const chatId of chats) {
      const dir = join(wsDir, chatId);
      const metaMtime = mtimeOf(join(dir, "meta.json"));
      if (metaMtime === 0) continue; // no meta.json (or unreadable)
      let parsed: { cwd: string; updatedMs: number } | undefined;
      const hit = chatMetaCache.get(chatId);
      if (hit !== undefined && hit.mtimeMs === metaMtime) {
        parsed = { cwd: hit.cwd, updatedMs: hit.updatedMs };
      } else {
        let meta: { updatedAtMs?: number; createdAtMs?: number; cwd?: string; schemaVersion?: number };
        try {
          meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as typeof meta;
        } catch {
          continue;
        }
        if (meta.cwd === undefined || meta.cwd === "") continue;
        // Format-canary: the Cursor chat schema version lives in meta.json (store.db
        // carries none). Captured for the drift NOTE only.
        if (typeof meta.schemaVersion === "number") recordCursorSchema(meta.schemaVersion);
        parsed = { cwd: meta.cwd, updatedMs: meta.updatedAtMs ?? meta.createdAtMs ?? 0 };
        chatMetaCache.set(chatId, { mtimeMs: metaMtime, ...parsed });
        if (chatMetaCache.size > 500) chatMetaCache.clear();
      }
      out.push({
        chatId,
        cwd: parsed.cwd,
        updatedMs: parsed.updatedMs,
        walMtime: mtimeOf(join(dir, "store.db-wal")),
        storeMtime: mtimeOf(join(dir, "store.db")),
        dbPath: join(dir, "store.db"),
      });
    }
  }
  return out;
}

// store.db carries the chat's {name, mode} in table `meta`, key '0', as a HEX-
// encoded JSON string. Read via the shared async sqliteSelect helper (WAL-safe,
// never throws, null == unavailable). Two changes vs the old sync python path:
//  - keyed by chatId with a long TTL (not store.db mtime): an ACTIVE agent bumps
//    store.db every tick, which used to invalidate the name every 3s and re-spawn
//    a blocking python3. Names rarely change after creation, so a time TTL means a
//    busy chat is read once, not once per tick.
//  - filled OFF the 3s tick path (fire-and-forget): cursorSessions() reads whatever
//    is cached and never blocks; a miss schedules an async refresh whose result the
//    next tick picks up. Degrades like the old pythonMissing path: no name != no row.
const NAME_TTL_MS = 10 * 60_000;
const nameCache = new Map<string, { fetchedAt: number; name: string; mode: string }>();
/** chatIds whose async read is in progress, so overlapping ticks don't stack reads. */
const nameInFlight = new Set<string>();

/** Decode the store.db meta value (hex-encoded JSON, or occasionally raw JSON)
 *  into {name, mode}. Mirrors the old python unhexlify/decode fallback. Exported as
 *  the structural seam the format-canary fixture locks. */
export function decodeMetaValue(value: string): { name: string; mode: string } | null {
  let json = value.trim();
  if (!json.startsWith("{")) {
    try {
      json = Buffer.from(value, "hex").toString("utf8");
    } catch {
      return null;
    }
  }
  try {
    const j = JSON.parse(json) as { name?: unknown; mode?: unknown };
    return {
      name: typeof j.name === "string" ? j.name : "",
      mode: typeof j.mode === "string" ? j.mode : "",
    };
  } catch {
    return null;
  }
}

/** Fire-and-forget: read names/modes for cache-missing chats via sqliteSelect and
 *  update nameCache. Never awaited by the tick — the next refresh reads the result.
 *  A null sqliteSelect (helper unavailable / db busy) leaves the entry unset so the
 *  chat keeps its "cursor agent" fallback and is retried later (no name != no row). */
function scheduleNameFill(chats: ChatMeta[]): void {
  const now = Date.now();
  const misses = chats.filter((c) => {
    if (nameInFlight.has(c.chatId)) return false;
    const hit = nameCache.get(c.chatId);
    return hit === undefined || now - hit.fetchedAt > NAME_TTL_MS;
  });
  if (misses.length === 0) return;
  for (const c of misses) nameInFlight.add(c.chatId);
  void (async (): Promise<void> => {
    try {
      for (const c of misses) {
        const rows = await sqliteSelect(c.dbPath, "SELECT value FROM meta WHERE key='0'");
        if (rows === null) {
          // No engine (neither node:sqlite nor python3) or a failed read: latch a
          // negative entry so the TTL paces retries — without it an engine-less
          // host would re-spawn a failing read for every chat on every 3s tick.
          // NOT a format-canary drift signal (can't attribute a null read to drift).
          nameCache.set(c.chatId, { fetchedAt: Date.now(), name: "", mode: "" });
          continue;
        }
        const cell = rows[0]?.[0];
        const decoded = cell !== undefined ? decodeMetaValue(cell) : null;
        // Format-canary: the query succeeded (engine present) but meta['0'] was
        // absent or would not decode → the Cursor store drift signal.
        recordCursorHealth(c.chatId, decoded !== null, c.dbPath);
        nameCache.set(c.chatId, {
          fetchedAt: Date.now(),
          name: decoded?.name ?? "",
          mode: decoded?.mode ?? "",
        });
      }
      if (nameCache.size > 500) nameCache.clear();
    } finally {
      for (const c of misses) nameInFlight.delete(c.chatId);
    }
  })();
}

// Chats confidently seen as a LIVE headless (`agent -p`) process at least once. The
// store.db meta of a headless run is byte-identical to an interactive one (both are
// name "New Agent"/mode "search" — verified on real specimens), so there is NO cheap
// persistent on-disk marker; the process argv is the only signal. This set makes the
// live verdict STICKY so a finished headless run — whose process is gone — stays
// demoted rather than flipping to finished-unread. Pruned to the chats that still
// exist on disk each tick; bounded like the other cursor caches.
const headlessSeen = new Set<string>();

/** All currently-relevant Cursor Agent CLI chats: process-matched, or with
 *  activity in the last 15 minutes. Newest activity first. `windowMs` overrides
 *  the relevance window (tests only; production uses the default). */
export function cursorSessions(windowMs: number = RELEVANT_MS): CursorRow[] {
  const now = Date.now();
  const chats = scanChats();
  if (chats.length === 0) {
    headlessSeen.clear();
    return [];
  }

  // Assign each live cursor-agent pid to the newest chat sharing its cwd.
  const procs = liveProcs();
  const procByChat = new Map<string, LiveProc>();
  if (procs.length > 0) {
    const byCwd = new Map<string, ChatMeta[]>();
    for (const c of chats) {
      const list = byCwd.get(c.cwd) ?? [];
      list.push(c);
      byCwd.set(c.cwd, list);
    }
    for (const list of byCwd.values()) {
      list.sort((a, b) => Math.max(b.updatedMs, b.walMtime) - Math.max(a.updatedMs, a.walMtime));
    }
    for (const p of procs) {
      const list = byCwd.get(p.cwd);
      if (list === undefined) continue;
      // give this pid the newest chat in its cwd not already claimed
      const target = list.find((c) => !procByChat.has(c.chatId));
      if (target !== undefined) procByChat.set(target.chatId, p);
    }
  }

  const relevant = chats.filter((c) => {
    if (procByChat.has(c.chatId)) return true;
    const last = Math.max(c.updatedMs, c.walMtime);
    return last > 0 && now - last < windowMs;
  });
  // Prune the sticky headless set to chats that still exist on disk (bounded), so a
  // deleted chat can't linger as external forever.
  const onDisk = new Set(chats.map((c) => c.chatId));
  for (const id of [...headlessSeen]) if (!onDisk.has(id)) headlessSeen.delete(id);
  if (headlessSeen.size > 500) headlessSeen.clear();
  if (relevant.length === 0) return [];

  // Kick off (never await) name reads for cache-missing chats; this tick renders
  // with whatever is already cached, the next tick picks up the fresh names.
  scheduleNameFill(relevant);
  // Keep the format-canary health map bounded to the currently-relevant chats.
  pruneCursorHealth(new Set(relevant.map((c) => c.chatId)));

  const claudePids = new Set<number>(procCensus().claude.map((p) => p.pid));

  const rows: CursorRow[] = relevant.map((c) => {
    const proc = procByChat.get(c.chatId);
    const pid = proc?.pid;
    const live = pid !== undefined;
    // A live matched process that carries the print flags is a confident headless run
    // — remember it so an ended run (no process) stays demoted.
    if (proc?.headless === true) headlessSeen.add(c.chatId);
    const external = headlessSeen.has(c.chatId);
    // Fold only a LIVE headless run under its father Claude session (identical gating
    // to codex: interactive/ended runs keep their project placement). Ancestry is
    // meaningful only while the process exists.
    const parentClaudePid =
      external && live && proc?.headless === true && claudePids.size > 0
        ? claudeAncestorPid(pid, claudePids)
        : undefined;
    const lastMs = Math.max(c.updatedMs, c.walMtime, c.storeMtime);
    const ageSec = (now - lastMs) / 1000;
    const walFresh = c.walMtime > 0 && now - c.walMtime < WORKING_MS;
    const status: CursorRow["status"] =
      ageSec * 1000 < WORKING_MS || (pid !== undefined && walFresh) ? "working" : "idle";
    const cached = nameCache.get(c.chatId);
    const name = cached?.name !== undefined && cached.name !== "" ? cached.name : "cursor agent";
    return {
      chatId: c.chatId,
      cwd: c.cwd,
      name,
      mode: cached?.mode ?? "",
      ageSec,
      updatedMs: lastMs,
      status,
      pid,
      dbPath: c.dbPath,
      external,
      live,
      parentClaudePid,
    };
  });
  rows.sort((a, b) => b.updatedMs - a.updatedMs);
  return rows;
}
