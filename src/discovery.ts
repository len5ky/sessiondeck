import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ConfigHome } from "./homes";
import { pidAlive, pidStartTime, procHost, tableStartDisagrees } from "./procs";
import { recordClaudeHealth, pruneClaudeHealth } from "./canary";
// format.ts imports from this module too; the cycle is safe because
// normalizeDriveLetter is only called inside snapshot(), never at load time.
import { normalizeDriveLetter } from "./format";

export interface SessionMeta {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  procStart?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
}

export type Status = "working" | "waiting" | "idle";

export interface SubActivity {
  /** Direct subagents with fresh transcript writes. */
  agents: number;
  /** Workflow runs with fresh activity. */
  workflows: number;
  /** Running agents inside those workflows (journal started-without-result). */
  workflowAgents: number;
  /** Descriptions of active direct subagents, for tooltips. */
  agentLabels: string[];
  /** activeForm of the session's in-progress task, if any. */
  currentTask?: string;
  /** Newest mtime seen across subagent/workflow files. */
  newestMs: number;
}

export interface SessionRow {
  meta: SessionMeta;
  status: Status;
  /** Seconds since last activity on any chain (main, subagent, workflow); null when no transcript exists yet. */
  ageSec: number | null;
  mtimeMs: number;
  /** Last write to the main transcript only (used to expire attention flags). */
  mainMtimeMs: number;
  lastText: string;
  /** Last ai-title record folded from the transcript tail: Claude's exact, full
   *  editor/sidebar session name. */
  aiTitle?: string;
  activity: SubActivity;
  /** The transcript tail is a still-open AskUserQuestion/ExitPlanMode tool_use —
   *  the session is blocked ON THE USER (a question/plan awaiting an answer), so
   *  it reads as "needs answer" rather than working, whatever the age. */
  pendingQuestion: boolean;
  /** The pending question's prompt(s), pre-truncated, for the hover only; undefined
   *  for ExitPlanMode or when the tail carries no readable question text. */
  questionText?: string;
  /** Name of the pending tool_use at the transcript tail (Bash/Edit/Task/…), capped
   *  40 chars — the fallback source for a working row's "doing now" caption when no
   *  in-progress task is known. Undefined unless the tail is a pending assistant
   *  tool_use. Only the tool NAME is ever captured, never its input/arguments. */
  pendingToolName?: string;
  /** Normalized absolute PATH of a pending edit-tool call at the tail (one of
   *  Edit/Write/MultiEdit/NotebookEdit), for the same-path collision warning;
   *  undefined otherwise. This is the sole datum sourced from a tool's INPUT — the
   *  path field only, resolved against the session cwd. Local rows only (remote
   *  snapshots never carry it — schema untouched). */
  pendingEditPath?: string;
  /** Config home this session was discovered in. */
  homeDir: string;
  homeLabel: string;
  /** Model/mode/token bundle folded over the transcript tail window; undefined on
   *  the no-transcript branch. The display layer combines it with a lazy pre-window
   *  scan (usage.ts) for the full-file total. LOCAL rows only — remote snapshots
   *  never carry it (bridgeSchema frozen; token display is local-only v1). */
  usage?: UsageFold;
  /** inode of the main transcript (for the token scanner's rewrite detection);
   *  undefined on the no-transcript branch. */
  mainIno?: number;
}

/** One subagent transcript (standalone, or nested under a workflow). */
export interface AgentDetail {
  /** agentId (from the agent-<id>.jsonl filename). */
  id: string;
  label: string;
  /** Absolute path to the agent-*.jsonl transcript (opened on click). */
  path: string;
  running: boolean;
  ageSec: number;
  mtimeMs: number;
}

/** One workflow run under a session's subagents/workflows/. */
export interface WorkflowDetail {
  /** wf_* directory name. */
  id: string;
  label: string;
  /** Absolute path to journal.jsonl (opened on click). */
  path: string;
  running: boolean;
  /** started-without-result agents per the journal. */
  runningAgents: number;
  ageSec: number;
  mtimeMs: number;
  agents: AgentDetail[];
}

/** One entry from <home>/tasks/<sessionId>/<num>.json. */
export interface TaskDetail {
  /** Task id string ("8"), as stored. */
  id: string;
  /** Numeric task id used for ordering. */
  num: number;
  subject: string;
  status: string;
  description?: string;
  path: string;
  /** Seconds since the task file was last written (used by age filters). */
  ageSec: number;
}

export interface SessionDetails {
  workflows: WorkflowDetail[];
  agents: AgentDetail[];
  tasks: TaskDetail[];
}

/** Drop the oldest half of a Map once it exceeds `max`, preserving the hot
 *  working set (Map keys iterate in insertion order) instead of dumping it all
 *  with clear() — a full clear caused a re-parse storm on the very next tick as
 *  every still-live entry missed at once. */
function capMap<K, V>(m: Map<K, V>, max: number): void {
  if (m.size <= max) return;
  const drop = m.size >> 1;
  let i = 0;
  for (const k of m.keys()) {
    m.delete(k);
    if (++i >= drop) break;
  }
}

// ---- Git worktree detection (Goal A) ----------------------------------------
// A linked git worktree's `.git` is a FILE (not a dir) whose one line is
//   gitdir: <mainRoot>/.git/worktrees/<name>
// From that we resolve the MAIN checkout (<mainRoot>) and read the worktree's
// branch from <gitdir>/HEAD ("ref: refs/heads/<branch>" or a detached SHA). Two
// tiny caches keep this to at most one readFile per project dir per change:
//   • the `.git`-file → link resolution, keyed by the `.git` file's mtime (the file
//     is immutable for the life of a worktree, so this is read exactly once);
//   • the branch, keyed by HEAD's mtime, so a branch switch (which rewrites HEAD but
//     not `.git`) is still picked up, while a stat is all the steady state costs.
// No git subprocess is ever spawned. Everything fails soft to "not a worktree".

/** Resolved worktree link for a project directory. */
export interface WorktreeLink {
  /** Absolute path to the MAIN working tree this worktree belongs to. */
  mainRoot: string;
  /** Branch name (or short detached SHA) the worktree has checked out. */
  branch: string;
}

const WORKTREES_SEG = "/.git/worktrees/";

// cwd -> resolved link (or null = confirmed not a linked worktree), keyed by `.git` mtime.
const wtLinkCache = new Map<string, { mtimeMs: number; link: { gitdir: string; mainRoot: string } | null }>();
// gitdir -> branch, keyed by HEAD mtime.
const wtBranchCache = new Map<string, { mtimeMs: number; branch: string }>();

/** Parse a `.git` FILE's `gitdir:` line into { gitdir, mainRoot }, or null when it
 *  isn't a linked-worktree pointer. Exported for the backslash regression test. */
export function parseGitdirLink(dotGitPath: string): { gitdir: string; mainRoot: string } | null {
  let text: string;
  try {
    text = readFileSync(dotGitPath, "utf8");
  } catch {
    return null;
  }
  return parseGitdirLine(text);
}

/** The pure line-parser behind {@link parseGitdirLink} (takes the `.git` file's text
 *  directly). Separator-agnostic: git writes the pointer with the host's NATIVE
 *  separator (backslashes on Windows), so the `/.git/worktrees/` segment is located
 *  on a forward-slash-normalized COPY while `mainRoot` is sliced from the ORIGINAL — a
 *  1:1 char replace preserves indices, so the returned paths keep native separators
 *  (and the tests' path.join expectations hold on both OSes). */
export function parseGitdirLine(text: string): { gitdir: string; mainRoot: string } | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (m === null) return null;
  const gitdir = m[1];
  const idx = gitdir.replace(/\\/g, "/").indexOf(WORKTREES_SEG);
  if (idx < 0) return null; // a submodule .git file (…/modules/…) or unexpected shape
  return { gitdir, mainRoot: gitdir.slice(0, idx) };
}

/** Read a worktree's checked-out branch from <gitdir>/HEAD, cached by HEAD mtime.
 *  "ref: refs/heads/<b>" → <b>; a detached HEAD → the short SHA; unreadable → "". */
function worktreeBranch(gitdir: string): string {
  const headPath = join(gitdir, "HEAD");
  let mtimeMs: number;
  try {
    mtimeMs = statSync(headPath).mtimeMs;
  } catch {
    return "";
  }
  const hit = wtBranchCache.get(gitdir);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.branch;
  let branch = "";
  try {
    const head = readFileSync(headPath, "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    branch = ref !== null ? ref[1] : head.slice(0, 8); // detached → short SHA
  } catch {
    branch = "";
  }
  wtBranchCache.set(gitdir, { mtimeMs, branch });
  capMap(wtBranchCache, 500);
  return branch;
}

/** Resolve whether `cwd` is a linked git worktree, and if so its main repo root and
 *  branch. Cheap and cached (see the module note); undefined for a normal checkout,
 *  a non-repo, or any read error. */
export function worktreeInfo(cwd: string): WorktreeLink | undefined {
  const dotGit = join(cwd, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return undefined;
  }
  // A primary working tree has a `.git` DIRECTORY; only a linked worktree (or a
  // submodule) uses a `.git` FILE. Directories and missing entries are never worktrees.
  if (!st.isFile()) return undefined;
  let cached = wtLinkCache.get(cwd);
  if (cached === undefined || cached.mtimeMs !== st.mtimeMs) {
    cached = { mtimeMs: st.mtimeMs, link: parseGitdirLink(dotGit) };
    wtLinkCache.set(cwd, cached);
    capMap(wtLinkCache, 500);
  }
  if (cached.link === null) return undefined;
  // mainRoot becomes a project group key, so it gets the same drive-letter form as
  // the session cwds it is matched against.
  return { mainRoot: normalizeDriveLetter(cached.link.mainRoot), branch: worktreeBranch(cached.link.gitdir) };
}

function liveSessions(homeDir: string): SessionMeta[] {
  const dir = join(homeDir, "sessions");
  const out: SessionMeta[] = [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    // registry files are named <pid>.json and are never cleaned up on exit.
    // pidAlive works on every platform, so skip dead pids before paying for a
    // read+parse AND opportunistically unlink the stale file so this dir self-
    // heals instead of growing without bound (finding 2). Best-effort: a failed
    // unlink (perms/race) just leaves the file for the next tick.
    const pidFromName = Number(f.slice(0, -5));
    if (Number.isFinite(pidFromName) && !pidAlive(pidFromName)) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        // best-effort cleanup; ignore
      }
      continue;
    }
    let meta: SessionMeta;
    try {
      meta = JSON.parse(readFileSync(join(dir, f), "utf8")) as SessionMeta;
    } catch {
      continue;
    }
    // Tolerate registry shapes not yet seen on macOS/Windows: the file name is the
    // pid, and a session without an id or cwd can't be shown.
    if (typeof meta.pid !== "number" || !Number.isFinite(meta.pid)) {
      if (!Number.isFinite(pidFromName)) continue;
      meta.pid = pidFromName;
    }
    if (typeof meta.sessionId !== "string" || typeof meta.cwd !== "string") continue;
    if (meta.procStart !== undefined && typeof meta.procStart !== "string") meta.procStart = String(meta.procStart);
    const start = procHost() === "linux" ? pidStartTime(meta.pid) : undefined;
    // On Linux a live pid always has a start time; its absence means the process
    // died between the pidAlive check and this read — pre-refactor that skipped
    // the row, so preserve that exactly. Elsewhere start time is never available
    // (undefined is normal) and must NOT exclude an otherwise-live session.
    if (start === undefined) {
      if (procHost() === "linux") continue;
      // macOS / Windows: the same reuse guard against the process table, once
      // the pid's row is cached (a miss queues it for a later scan).
      if (tableStartDisagrees(meta.pid, meta.procStart, typeof meta.startedAt === "number" ? meta.startedAt : undefined)) continue;
    } else if (meta.procStart !== undefined && String(start) !== meta.procStart) {
      continue; // pid reused
    }
    out.push(meta);
  }
  return out;
}

/** pid and procStart of every live registry entry in a home (for Diagnostics'
 *  start-time check; no reuse guard, which is what it measures). procStart is
 *  undefined when the entry has none, so Diagnostics can count it. */
export function registryStartEntries(homeDir: string): { pid: number; procStart: string | undefined }[] {
  const out: { pid: number; procStart: string | undefined }[] = [];
  let files: string[];
  try {
    files = readdirSync(join(homeDir, "sessions"));
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const pid = Number(f.slice(0, -5));
    if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(homeDir, "sessions", f), "utf8")) as { procStart?: unknown };
      const start = typeof raw.procStart === "string" || typeof raw.procStart === "number" ? String(raw.procStart) : undefined;
      out.push({ pid, procStart: start !== undefined && start.trim() !== "" ? start : undefined });
    } catch {
      // unreadable: not counted
    }
  }
  return out;
}

/** The live `status` Claude Code writes into a session's registry file: "busy"
 *  (mid-turn), "waiting" (mid-turn, on a permission or question), "idle", or
 *  "shell" (between turns with a background task running). Read fresh, for the
 *  move confirmation; undefined when the file or field is missing. */
export function registryStatus(homeDir: string, pid: number): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(homeDir, "sessions", `${pid}.json`), "utf8")) as { status?: unknown };
    return typeof raw.status === "string" ? raw.status : undefined;
  } catch {
    return undefined;
  }
}

/** The `projects/<slug>/` directory name Claude Code derives from a session cwd
 *  (every non-alphanumeric run collapsed to `-`). Exposed so the session hover can
 *  surface the on-disk slug without re-deriving the same substitution inline. */
export function projectSlug(meta: SessionMeta): string {
  return meta.cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptPath(meta: SessionMeta, homeDir: string): string {
  return join(homeDir, "projects", projectSlug(meta), `${meta.sessionId}.jsonl`);
}

interface TranscriptEntry {
  type?: string;
  aiTitle?: string;
  // Marks machinery records (the `<local-command-caveat>` envelope Claude Code
  // injects around slash-command output) — never a real user prompt, so skipped
  // by the prompt-title fallback.
  isMeta?: boolean;
  // Record-format version Claude Code stamps on user/assistant records (absent on
  // queue-operation/summary records). Read only for the format-canary version
  // NOTE — never affects classification.
  version?: string;
  // Permission mode for the turn — rides USER records (values: default/acceptEdits/
  // plan/bypassPermissions/auto). Captured last-seen for the session mode display.
  // Absent on subagent transcripts (they inherit the parent's mode).
  permissionMode?: string;
  message?: {
    role?: string;
    // Assistant message id — the dedup key for usage accounting. The SAME usage
    // object is repeated on every streamed-block record of one message, so tokens
    // are counted once per id (records of a message are contiguous). Absent on user
    // records.
    id?: string;
    // Model that produced this assistant turn ("claude-fable-5", "gpt-5.6-sol"; the
    // sentinel "<synthetic>" is a client-injected turn, not a real model).
    model?: string;
    // Per-call token usage (input_tokens/output_tokens/cache_read_input_tokens/
    // cache_creation_input_tokens); summed once per message id.
    usage?: unknown;
    // The API stop reason of the assistant turn, present on every assistant
    // record since CC 2.1.119 (verified across 159k records / 4009 transcripts,
    // 2.1.119–2.1.215: zero absent). It is the primary done/working signal —
    // a text/thinking tail is otherwise ambiguous (final answer vs mid-turn
    // narration between tool calls). `null` marks a streamed intermediate block
    // (more records follow this turn); "end_turn"/"stop_sequence"/"refusal" mark
    // the final block of a finished turn. undefined = key absent (old format).
    stop_reason?: string | null;
    // `name`/`input` ride on type:"tool_use" content items — used to spot a pending
    // AskUserQuestion/ExitPlanMode gate at the tail (parseTail only).
    content?: string | Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
  };
}

/** Direct tools that block the turn ON THE USER: a still-open tool_use of either
 *  is not "working" — nothing advances until the user answers/approves. */
const QUESTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** First question prompt(s) from an AskUserQuestion tool_use input, joined and
 *  truncated for a hover; undefined for ExitPlanMode (no questions) or bad shape.
 *  Purely defensive — a garbled input degrades to undefined, never throws. */
function questionText(name: string, input: unknown): string | undefined {
  if (name !== "AskUserQuestion" || typeof input !== "object" || input === null) return undefined;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return undefined;
  const parts: string[] = [];
  for (const q of questions) {
    if (typeof q === "object" && q !== null) {
      const text = (q as { question?: unknown }).question;
      if (typeof text === "string" && text !== "") parts.push(text);
    }
  }
  if (parts.length === 0) return undefined;
  const joined = parts.join(" · ");
  return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined;
}

/** Prefix of the marker Claude Code writes as a user record when the user aborts
 *  the turn (Esc): "[Request interrupted by user]" and the tool-phase variant
 *  "[Request interrupted by user for tool use]". */
const INTERRUPT_PREFIX = "[Request interrupted by user";

/** True when a user record is an abort marker. Evidence (this machine, 4026
 *  transcripts): all 171 real interrupts are user records carrying a text block
 *  whose text is exactly one of the two marker strings. Matching a TEXT BLOCK
 *  (not the raw record) is deliberate — the corpus also holds assistant messages
 *  discussing the marker, Bash tool_use commands grepping it, and tool_result
 *  outputs quoting prior-session data, none of which are interrupts. */
function isInterruptContent(
  content: string | Array<{ type?: string; text?: string }> | undefined
): boolean {
  if (typeof content === "string") return content.trimStart().startsWith(INTERRUPT_PREFIX);
  if (Array.isArray(content)) {
    return content.some(
      (c) => c.type === "text" && typeof c.text === "string" && c.text.trimStart().startsWith(INTERRUPT_PREFIX)
    );
  }
  return false;
}

/** Name of the pending tool call in an assistant content array — the tool that is
 *  running / blocking the turn — capped at 40 chars; undefined when the array has
 *  no tool_use block. Generic over every tool (Bash/Edit/Task/…), unlike
 *  questionFrom which only recognizes the AskUserQuestion/ExitPlanMode gate. Only
 *  the tool NAME is read; its input is never touched, so a caption built from this
 *  can't leak arguments. When several tool_use blocks ride one record (parallel
 *  calls) the last one wins. */
function pendingToolNameFrom(content: Array<{ type?: string; name?: string }>): string | undefined {
  let name: string | undefined;
  for (const c of content) {
    if (c.type === "tool_use" && typeof c.name === "string" && c.name !== "") name = c.name;
  }
  return name !== undefined && name.length > 40 ? name.slice(0, 40) : name;
}

/** The four edit tools whose tool_use input carries a file PATH we read for the
 *  same-path collision warning. This is the ONLY place a tool INPUT (not just its
 *  name) is consulted, and even here only the single path-bearing field is touched
 *  — never old_string/new_string/content/edits or any other input key. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The pending edit's target PATH — the raw `file_path` (Edit/Write/MultiEdit) or
 *  `notebook_path` (NotebookEdit) — when the LAST tool_use in the array is one of
 *  the four edit tools; undefined otherwise. Mirrors pendingToolNameFrom (last
 *  tool_use wins), so it always reflects the SAME tool the caption names. ONLY the
 *  path field is read: no other input key is dereferenced, so nothing else can be
 *  captured or leak. Odd-shape input (missing/non-string field, array, __unparsed…)
 *  degrades to undefined, never throws. Capped defensively so a pathological path
 *  can't bloat state. */
function pendingEditPathFrom(
  content: Array<{ type?: string; name?: string; input?: unknown }>
): string | undefined {
  let path: string | undefined;
  for (const c of content) {
    if (c.type !== "tool_use") continue;
    if (typeof c.name !== "string" || !EDIT_TOOLS.has(c.name)) {
      path = undefined; // a non-edit tool_use is the pending one → no edit path
      continue;
    }
    const input = c.input;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      path = undefined;
      continue;
    }
    const rec = input as { file_path?: unknown; notebook_path?: unknown };
    const field = c.name === "NotebookEdit" ? rec.notebook_path : rec.file_path;
    path = typeof field === "string" && field !== "" ? field.slice(0, 1024) : undefined;
  }
  return path;
}

/** Resolve a raw edit path to a normalized absolute path for collision matching:
 *  relative paths resolve against the session `cwd`, separators fold to `/`, and
 *  `.`/empty segments are dropped. "realpath-lite" — purely lexical, no fs call, so
 *  it adds zero I/O to the tail parse. Because symlinks are NOT resolved, a path
 *  that still contains a `..` segment after the cwd-join is UNMATCHABLE: it returns
 *  undefined rather than collapsing the `..` lexically, so `/repo/link/../a.ts` can
 *  never be mistaken for `/repo/a.ts` (that collapse is only sound when `link` is a
 *  real directory, which we can't know without a realpath call). Evidence: 99.7% of
 *  edit paths are already absolute and `..`-free, so the loss is nil. Pure and
 *  exported for tests. */
export function normalizeEditPath(raw: string, cwd: string): string | undefined {
  let p = raw.replace(/\\/g, "/");
  const drive = /^([A-Za-z]:)\//.exec(p)?.[1];
  const isAbs = p.startsWith("/") || drive !== undefined;
  if (!isAbs) {
    const base = cwd.replace(/\\/g, "/");
    p = (base.endsWith("/") ? base : base + "/") + p;
  }
  const d2 = /^([A-Za-z]:)\//.exec(p)?.[1];
  const body = d2 !== undefined ? p.slice(d2.length + 1) : p;
  const stack: string[] = [];
  for (const seg of body.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return undefined; // symlink-unsafe → unmatchable
    stack.push(seg);
  }
  const prefix = d2 !== undefined ? `${d2}/` : "/";
  return prefix + stack.join("/");
}

/** When an assistant content array ends the turn on a question/plan tool_use,
 *  return that tool's name + a short prompt string; undefined otherwise. */
function questionFrom(
  content: Array<{ type?: string; name?: string; input?: unknown }>
): { name: string; text?: string } | undefined {
  for (const c of content) {
    if (c.type === "tool_use" && typeof c.name === "string" && QUESTION_TOOLS.has(c.name)) {
      return { name: c.name, text: questionText(c.name, c.input) };
    }
  }
  return undefined;
}

/** Last `bytes` of a file, or "" when the file is missing/unreadable (a transcript
 *  can be deleted between an existsSync and this read — swallow it so classify()
 *  and agentLastKind never throw out of snapshot()). */
/** Test-only: bytes read + read calls through readTail, for the perf bench to
 *  quantify the active-writer re-read cost. Not referenced by shipped code. */
export const __tailIO = { bytes: 0, reads: 0 };

function readTail(path: string, bytes: number): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    const len = Math.min(bytes, size);
    __tailIO.bytes += len;
    __tailIO.reads += 1;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // fd already invalid; ignore
      }
    }
  }
}

/** First `bytes` of a file, or "" when missing/unreadable — the head-read
 *  counterpart of readTail, used once per session for the prompt-title fallback.
 *  Never throws (a transcript can vanish between ticks). */
function readHead(path: string, bytes: number): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // fd already invalid; ignore
      }
    }
  }
}

// Tags that mark a user record as machinery rather than a typed prompt: slash-
// command wrappers and the local-command stdout/caveat envelopes Claude Code
// injects. Verified present across real transcript heads (evidence-first).
const NON_PROMPT_TAGS = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-caveat>",
];

/** Raw text of a user record's content — the string form, or the first text block
 *  of the array form. undefined when the record carries no text (tool_result-only,
 *  image-only, or a malformed shape). */
function userRecordText(rec: TranscriptEntry): string | undefined {
  const c = rec.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const block = c.find((b) => b?.type === "text");
    if (block !== undefined && typeof block.text === "string") return block.text;
  }
  return undefined;
}

/** First usable user PROMPT line from a transcript HEAD, or undefined when the head
 *  yields nothing usable. Pure and vscode-free: the caller sanitizes/truncates
 *  (reuse sanitizeReason) — this only locates the raw line. Skips the machinery that
 *  precedes/surrounds a real first prompt (queue-operation/attachment/assistant
 *  records via the type gate; isMeta caveat records; slash-command wrappers and
 *  local-command envelopes; tool_result-only user records; interrupt markers),
 *  matching the record shapes observed across real transcripts. Exported for tests. */
export function firstUserPromptLine(head: string): string | undefined {
  for (const raw of head.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let rec: TranscriptEntry;
    try {
      rec = JSON.parse(trimmed) as TranscriptEntry;
    } catch {
      break; // truncated final line of the head window — no complete records follow
    }
    if (rec.type !== "user" || rec.isMeta === true) continue;
    const text = userRecordText(rec);
    if (text === undefined) continue; // tool_result / image-only user record
    if (NON_PROMPT_TAGS.some((t) => text.includes(t))) continue;
    if (text.includes("[Request interrupted by user]")) continue;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t !== "") return t;
    }
  }
  return undefined;
}

/** Wall-clock ms of a transcript's FIRST record that carries a usable `timestamp` —
 *  the session's TRUE birth. It survives `claude --resume`: a resume spawns a new pid
 *  (rewriting the registry `startedAt`/`procStart` to the resume's process start) but
 *  APPENDS to the same transcript, so record 1's timestamp still marks the original
 *  session. The first record is written at session creation and sits at offset 0, so a
 *  single head read finds it; records lacking a timestamp (e.g. a `summary` preamble
 *  line) are skipped. Returns undefined for an empty head or one with no timestamped
 *  record. Stops at a truncated final line rather than throwing. Exported for tests. */
export function firstRecordTimestampMs(head: string): number | undefined {
  for (const raw of head.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let rec: { timestamp?: unknown };
    try {
      rec = JSON.parse(trimmed) as { timestamp?: unknown };
    } catch {
      break; // truncated final line of the head window — no complete records follow
    }
    if (typeof rec.timestamp === "string") {
      const ms = Date.parse(rec.timestamp);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return undefined;
}

interface PromptTitleEntry {
  /** Derived title, or "" when the head yielded nothing usable (negative cache). */
  title: string;
  /** Session birth (first-record timestamp, ms) from the SAME head read; undefined
   *  until a timestamped record is seen. Once found it is stable for the session's
   *  life (the first record never changes), so a positive birth is never re-read. */
  birthMs?: number;
  /** Main-transcript mtime at the read — a negative entry is retried only when the
   *  transcript has since grown, so a first prompt written after our initial read is
   *  still picked up without re-reading the head every tick. */
  mtimeMs: number;
  /** Wall-clock (ms) of the last head read — bounds negative re-reads to at most
   *  once per NEGATIVE_RETRY_MS, so an active title-less session whose first real
   *  prompt sits beyond the 32KiB head can't trigger a 32KiB read on every poll. */
  checkedMs: number;
}
// Bounded cache keyed by sessionId (pruned like the other discovery caches). A found
// title is stable and cached for the session's life; a negative is re-read only when
// the transcript grows AND the retry window has elapsed. Sized like the other
// session-scoped caches.
const promptTitleCache = new Map<string, PromptTitleEntry>();
const PROMPT_HEAD_BYTES = 32 * 1024;
// Negative-cache backoff: a title-less session re-reads its 32KiB head at most this
// often, even as the transcript keeps growing on every ~3s poll tick.
const NEGATIVE_RETRY_MS = 30_000;

/** Prompt-derived FALLBACK title for a session — the first user prompt line from the
 *  transcript head. A FOUND title is read once and cached for the session's life; a
 *  NEGATIVE (no usable prompt yet) re-reads the 32KiB head at most once per
 *  NEGATIVE_RETRY_MS while the transcript grows, never on every tick. Returns the RAW
 *  line (caller sanitizes/truncates) or undefined when the head yields nothing usable,
 *  so the caller keeps its plain stub. Never throws. `mtimeMs` is the main-transcript
 *  mtime; `nowMs` is injectable for tests (defaults to the wall clock). */
/** ONE head read that populates BOTH the prompt title and the birth timestamp into a
 *  single shared cache entry, so a session that needs both pays a single 32KiB read.
 *  A previously-found title or birth is carried forward (they are stable for life), so
 *  a negative-title re-read never drops a birth already captured. */
function ensureHeadEntry(
  meta: SessionMeta,
  homeDir: string,
  mtimeMs: number,
  nowMs: number
): PromptTitleEntry {
  const prev = promptTitleCache.get(meta.sessionId);
  const head = readHead(transcriptPath(meta, homeDir), PROMPT_HEAD_BYTES);
  const line = firstUserPromptLine(head);
  const entry: PromptTitleEntry = {
    title: line ?? prev?.title ?? "",
    birthMs: firstRecordTimestampMs(head) ?? prev?.birthMs,
    mtimeMs,
    checkedMs: nowMs,
  };
  promptTitleCache.set(meta.sessionId, entry);
  capMap(promptTitleCache, 500);
  return entry;
}

export function promptFallbackTitle(
  meta: SessionMeta,
  homeDir: string,
  mtimeMs: number,
  nowMs: number = Date.now()
): string | undefined {
  const hit = promptTitleCache.get(meta.sessionId);
  if (hit !== undefined) {
    if (hit.title !== "") return hit.title; // positive: stable for the session's life
    // Negative: skip the re-read unless the transcript grew AND we're past the
    // backoff window since the last read — bounds cost for active title-less rows.
    if (hit.mtimeMs === mtimeMs || nowMs - hit.checkedMs < NEGATIVE_RETRY_MS) {
      return undefined;
    }
  }
  const title = ensureHeadEntry(meta, homeDir, mtimeMs, nowMs).title;
  return title === "" ? undefined : title;
}

/** Session birth (first-record timestamp, ms) for the hover — the TRUE start that
 *  survives `claude --resume` (unlike the registry `startedAt`, which a resume
 *  rewrites to the new process's start). Read once from the transcript head and cached
 *  for the session's life; it shares the head read with promptFallbackTitle (same
 *  cache entry), so a session that shows both title and birth pays a single read, and
 *  a titled session (whose title never triggers a read) pays exactly one read total.
 *  Returns undefined when the transcript is missing/empty or carries no timestamped
 *  record. `nowMs` is injectable for tests. */
export function sessionBirthMs(
  meta: SessionMeta,
  homeDir: string,
  mtimeMs: number,
  nowMs: number = Date.now()
): number | undefined {
  const hit = promptTitleCache.get(meta.sessionId);
  if (hit !== undefined) {
    if (hit.birthMs !== undefined) return hit.birthMs; // positive: stable for life
    // Not yet found (empty/timestamp-less head): bound re-reads exactly like the
    // negative-title path — never a head read per tick for an active session.
    if (hit.mtimeMs === mtimeMs || nowMs - hit.checkedMs < NEGATIVE_RETRY_MS) {
      return undefined;
    }
  }
  return ensureHeadEntry(meta, homeDir, mtimeMs, nowMs).birthMs;
}

interface Classified {
  status: Status;
  lastText: string;
  aiTitle?: string;
  /** last entry kind, used to re-derive status when only mtime changes */
  lastKind: string;
  /** stop_reason of the LAST assistant record (the tail's turn-boundary signal).
   *  string = a value like "end_turn"; null = a streamed intermediate block;
   *  undefined = last record was a user record, or the key was absent. */
  lastStop: string | null | undefined;
  /** tail is a still-open AskUserQuestion/ExitPlanMode tool_use (blocked on user) */
  pendingQuestion: boolean;
  /** pending question's prompt text, truncated, for the hover (undefined otherwise) */
  questionText?: string;
  /** name of the pending tool_use at the tail (Bash/Edit/…), capped 40; undefined
   *  unless the last record is a pending assistant tool_use */
  pendingToolName?: string;
  /** RAW target path of a pending EDIT tool at the tail (Edit/Write/MultiEdit →
   *  file_path, NotebookEdit → notebook_path), for the same-path collision warning.
   *  Undefined unless the last tool_use is one of those four. Unnormalized here (the
   *  cwd isn't known at parse time); classify() resolves+normalizes it. The ONLY
   *  tool-INPUT field this classifier ever reads. */
  pendingEditPath?: string;
  /** Format-canary parse-health: at least one line in the tail parsed as JSON with
   *  a string `type` (the required discriminator the whole classifier keys off).
   *  false ⟺ the tail had content but nothing recognizable — the drift signal. */
  recognized: boolean;
  /** Highest transcript `version` seen in the tail, for the ceiling NOTE. */
  version?: string;
  /** Model/mode/token bundle folded over the tail window — combined with a lazy
   *  pre-window scan for the full-file total display (usage.ts). */
  usage: UsageFold;
  /** The tail read itself ERRORED this tick (open/read failed, file vanished mid-read)
   *  — so `recognized` reflects nothing read, not a real parse. Callers must NOT record
   *  parse-health from a read-errored tick, or a transient IO blip would latch a false
   *  `failed`. Never true on a quiet-tick cache hit or a successful (re)read. */
  readError: boolean;
}

const TAIL_BYTES = 64 * 1024;

/** Running parser state for a transcript tail — enough to (a) derive the same
 *  Classified a full 64 KB read would, and (b) fold newly appended records onto it
 *  without re-reading/re-parsing the whole window each tick. Every field mirrors a
 *  parseTail local; `size`/`lastTextPos` are the extra bookkeeping incremental
 *  folding needs. */
interface TailState {
  /** absolute byte offset consumed up to — the end of the last COMPLETE line seen */
  size: number;
  mtimeMs: number;
  /** statSync inode of the file this state was built from. A rename-in replacement
   *  (a NEW file swapped to the same path) keeps the path but changes the inode, so
   *  an inode mismatch forces a full re-read instead of folding the "appended" tail
   *  of a different file onto stale state — belt-and-suspenders over same-size /
   *  same-mtime coincidences that size+mtime alone can't catch. */
  ino: number;
  lastKind: string;
  lastText: string;
  aiTitle: string | undefined;
  /** absolute byte offset of the record that set lastText; -1 when none seen */
  lastTextPos: number;
  // stop_reason of the last assistant record; undefined after a user record so a
  // user tail never carries an earlier assistant's turn-boundary signal.
  lastStop: string | null | undefined;
  // Only meaningful when the LAST record is a pending assistant tool_use — reset on
  // every other record kind so an earlier question that has since been answered
  // (a following user:tool_result) never lingers here.
  pending: { name: string; text?: string } | undefined;
  // Pending tool name for the "doing now" caption; reset alongside `pending` so a
  // resolved tool call (a following text/user record) never lingers as a caption.
  pendingToolName: string | undefined;
  // Raw target path of a pending edit-tool call (see Classified.pendingEditPath);
  // reset alongside `pendingToolName` so a resolved edit never lingers.
  pendingEditPath: string | undefined;
  // Format-canary: sticky "saw ≥1 typed JSON record" flag and the highest record
  // `version` observed. Both are monotonic within a session (a recognized record
  // stays recognized), so the incremental-fold and full-read paths agree wherever
  // the tail carries any recognizable record — the only case the equivalence test
  // exercises. They feed only the drift NOTE, never classification.
  recognized: boolean;
  version: string | undefined;
  // ---- Usage accounting (folded for free as records pass; zero new I/O) --------
  // usage summed over the records folded onto THIS state — i.e. over [usageBase,
  // size). The full-file total is this plus a one-time background scan of
  // [0, usageBase) (see usage.ts combineUsage). Deduped by message id: the same
  // usage object repeats on every streamed block of a message, so it is added only
  // on the FIRST record bearing a new id.
  usage: Usage;
  /** window base this state was built from — the offset `usage` accumulates from.
   *  0 ⇒ the whole file is in the window and `usage` is the exact full-file total. */
  usageBase: number;
  /** bounded recent-message-id dedup guard (usage repeats across a message's streamed
   *  blocks; the ring also catches any non-adjacent repetition). */
  recent: RecentIds;
  /** id + usage of the FIRST message counted in this window — lets the display
   *  combiner drop a message straddling usageBase (counted by the pre-window scan
   *  too). undefined until a message is counted. */
  firstMsgId: string | undefined;
  firstMsgUsage: Usage;
  /** last-seen real model in the window (undefined if none seen). */
  model: string | undefined;
  /** last-seen permissionMode in the window (undefined if none seen). */
  permissionMode: string | undefined;
  /** The last read that produced this state ERRORED (IO failure / file vanished),
   *  so nothing was actually parsed this tick. Set by fullTail on a failed read and
   *  cleared on any successful (full or append) read. Feeds Classified.readError so
   *  the health recorder can skip a read-errored tick. */
  readError: boolean;
}

function emptyState(mtimeMs: number, size: number, ino = 0): TailState {
  return { size, mtimeMs, ino, lastKind: "", lastText: "", aiTitle: undefined, lastTextPos: -1, lastStop: undefined, pending: undefined, pendingToolName: undefined, pendingEditPath: undefined, recognized: false, version: undefined, usage: zeroUsage(), usageBase: size, recent: emptyRecentIds(), firstMsgId: undefined, firstMsgUsage: zeroUsage(), model: undefined, permissionMode: undefined, readError: false };
}

/** Fold ONE JSONL record onto `st` in place. Byte-for-byte the same per-record
 *  logic parseTail used to run inline; `offset` is the record's absolute byte
 *  position, kept only to guard lastText against the 64 KB window sliding. */
function foldRecord(st: TailState, line: string, offset: number): void {
  let e: TranscriptEntry;
  try {
    e = JSON.parse(line) as TranscriptEntry;
  } catch {
    return;
  }
  if (e.type === "ai-title" && typeof e.aiTitle === "string" && e.aiTitle !== "") st.aiTitle = e.aiTitle;
  // Format-canary (drift NOTE only): a line that parses as JSON with a string
  // `type` is a recognizable record; capture the record version when present.
  if (typeof e.type === "string") st.recognized = true;
  if (typeof e.version === "string" && e.version !== "") st.version = e.version;
  // Permission mode rides user records (last-seen wins); capture off any record
  // that carries it so a mid-session mode change is reflected.
  if (typeof e.permissionMode === "string" && e.permissionMode !== "") st.permissionMode = e.permissionMode;
  const content = e.message?.content;
  // Usage + model accounting (assistant records only). Model is last-seen; usage is
  // summed ONCE per message id (repeated across a message's streamed-block records).
  if (e.type === "assistant" && e.message !== undefined) {
    if (isRealModel(e.message.model)) st.model = e.message.model;
    const mid = e.message.id;
    if (typeof mid === "string" && noteMsgId(st.recent, mid)) {
      const u = usageFromRaw(e.message.usage);
      if (u !== undefined) {
        addUsage(st.usage, u);
        if (st.firstMsgId === undefined) {
          st.firstMsgId = mid;
          st.firstMsgUsage = u;
        }
      }
    }
  }
  if (e.type === "assistant" && Array.isArray(content)) {
    const kinds = content.map((c) => c.type ?? "?");
    if (kinds.includes("tool_use")) {
      st.lastKind = "assistant:tool_use";
      st.pending = questionFrom(content);
      st.pendingToolName = pendingToolNameFrom(content);
      st.pendingEditPath = pendingEditPathFrom(content);
    } else {
      st.lastKind = `assistant:${kinds[kinds.length - 1]}`;
      st.pending = undefined;
      st.pendingToolName = undefined;
      st.pendingEditPath = undefined;
    }
    st.lastStop = e.message?.stop_reason;
    const text = content.find((c) => c.type === "text")?.text;
    if (text !== undefined) {
      st.lastText = text;
      st.lastTextPos = offset;
    }
  } else if (e.type === "user") {
    // An abort marker is neither a fresh prompt nor a tool_result — the user
    // stopped the turn, so nothing is running and nothing is blocked on them.
    st.lastKind = isInterruptContent(content)
      ? "user:interrupt"
      : Array.isArray(content)
        ? "user:tool_result"
        : "user:prompt";
    st.lastStop = undefined;
    st.pending = undefined;
    st.pendingToolName = undefined;
    st.pendingEditPath = undefined;
  }
}

/** Fold every COMPLETE line in `buf` (which begins at absolute file offset `base`)
 *  onto `st`, working at the BYTE level so multibyte content can't skew the offsets.
 *  Lines not starting with '{' (a leading partial from a mid-record window start, or
 *  a blank) are skipped — identical to the old readTail().split("\n").filter. Returns
 *  the absolute offset just past the last complete line; a partial trailing line (no
 *  '\n' yet) is left unconsumed so the next grow re-reads it once terminated. */
function foldBuf(st: TailState, buf: Buffer, base: number): number {
  let consumedEnd = base;
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    if (buf[pos] === 0x7b /* '{' */) foldRecord(st, buf.toString("utf8", pos, nl), base + pos);
    pos = nl + 1;
    consumedEnd = base + pos;
  }
  return consumedEnd;
}

/** Read bytes [start, end) into a Buffer, or undefined on any error (the file can
 *  vanish mid-read — swallowed so classify() never throws out of snapshot()). */
function readRange(path: string, start: number, end: number): Buffer | undefined {
  const len = end - start;
  if (len <= 0) return Buffer.alloc(0);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    __tailIO.bytes += read;
    __tailIO.reads += 1;
    return read === len ? buf : buf.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // fd already invalid; ignore
      }
    }
  }
}

/** Full parse of a transcript's last 64 KB into a fresh TailState — the cold read,
 *  and the fallback whenever incremental folding can't guarantee equivalence. */
// Claude Code 2.1.28x writes a `prompt_snapshot` attachment (~100 KB: the whole
// system prompt and tool list) after a turn, which can push the reply out of the
// 64 KB tail. A tail with no conversation record at all is read further back,
// up to this much, so the last reply (and the turn's state) is still found.
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

function fullTail(path: string, size: number, mtimeMs: number, ino = 0): TailState {
  for (let window = TAIL_BYTES; ; window *= 4) {
    const base = Math.max(0, size - window);
    const st = emptyState(mtimeMs, base, ino);
    const buf = readRange(path, base, size);
    if (buf !== undefined) st.size = foldBuf(st, buf, base);
    else st.readError = true; // open/read failed — nothing parsed; don't let it read as drift
    if (st.readError || st.lastKind !== "" || base === 0 || window >= MAX_TAIL_BYTES) return st;
  }
}

function toClassified(st: TailState): Classified {
  return {
    status: "idle",
    lastText: st.lastText,
    aiTitle: st.aiTitle,
    lastKind: st.lastKind,
    lastStop: st.lastStop,
    pendingQuestion: st.pending !== undefined,
    questionText: st.pending?.text,
    pendingToolName: st.pendingToolName,
    pendingEditPath: st.pendingEditPath,
    recognized: st.recognized,
    version: st.version,
    usage: {
      total: st.usage,
      base: st.usageBase,
      firstMsgId: st.firstMsgId,
      firstMsgUsage: st.firstMsgUsage,
      model: st.model,
      mode: st.permissionMode,
    },
    readError: st.readError,
  };
}

// Per-session tail parser state, pruned in snapshot() alongside the other caches.
const tailStates = new Map<string, TailState>();

/** Classify a transcript tail, reusing cached state across ticks. Quiet tick (mtime
 *  unchanged) → pure cache hit. Append (file only grew) → fold ONLY the new bytes
 *  onto the cached state instead of re-reading + re-parsing the whole 64 KB window
 *  — the busy-host win. Shrink / truncate / same-size-rewrite / inode change → full
 *  re-read.
 *
 *  Equivalence with parseTail: an append-fold produces the same Classified a full
 *  read would, with two carve-outs —
 *   (1) the record that set lastText scrolls out of the last-64 KB window with no
 *       newer text after it: caught by the lastTextPos guard, which falls back to a
 *       full read to keep the preview identical.
 *   (2) a SINGLE record larger than 64 KB: the incremental path folded it whole as
 *       it arrived, so it carries the complete record; a cold parseTail only sees
 *       the last 64 KB and drops the record's leading bytes (its window misses it).
 *       Here the two paths legitimately DIVERGE — and incremental is the MORE-correct
 *       side (it has the full record). The 300-append equivalence suite uses normal
 *       sub-64 KB records, so the two agree there; this note documents the one shape
 *       where "byte-identical to parseTail" is intentionally not the invariant.
 *  (Transcripts are append-only, so folding just the tail is sound.) The inode guard
 *  wraps BOTH the quiet-tick hit and the append fold: a rename-in replacement changes
 *  the inode even when size/mtime look like an ordinary append, so any inode mismatch
 *  drops the cached state and re-reads from scratch. */
// Last ai-title seen per session, sticky across cold re-reads. The incremental fold
// already persists a title once caught, but a full re-read (truncate/rewrite/inode
// change, or a window-slide fallthrough) starts from an empty state and only sees the
// last 64 KB — a title emitted earlier in the current turn (e.g. before a big tool
// dump) would blank out. This cache re-supplies the last-known title on those paths so
// it never regresses to a fallback mid-session. (Residual: the very first parse after
// an extension RELOAD is a cold read with an empty cache, so a session whose last
// ai-title sits >64 KB before EOF shows the memento/prompt fallback until its next
// turn writes a fresh ai-title near EOF — a self-healing degradation, never worse than
// the pre-ai-title behavior.) Pruned to live sessions in snapshot().
const aiTitleCache = new Map<string, string>();

/** Reconcile a freshly classified tail with the sticky ai-title cache: cache a present
 *  title, else re-supply the last-known one. Applied on every classifyTail return. */
function withStickyAiTitle(sessionId: string, cls: Classified): Classified {
  if (cls.aiTitle !== undefined && cls.aiTitle !== "") {
    aiTitleCache.set(sessionId, cls.aiTitle);
    capMap(aiTitleCache, 2000);
  } else {
    const hit = aiTitleCache.get(sessionId);
    if (hit !== undefined) cls.aiTitle = hit;
  }
  return cls;
}

export function classifyTail(sessionId: string, path: string, size: number, mtimeMs: number, ino = 0): Classified {
  const st = tailStates.get(sessionId);
  if (st !== undefined && st.ino === ino) {
    if (st.mtimeMs === mtimeMs) return withStickyAiTitle(sessionId, toClassified(st)); // quiet-tick hit
    if (size > st.size) {
      const buf = readRange(path, st.size, size); // just the appended bytes
      if (buf !== undefined) {
        st.size = foldBuf(st, buf, st.size);
        st.mtimeMs = mtimeMs;
        st.readError = false; // this read succeeded — clear any prior errored flag
        const windowStart = size - TAIL_BYTES;
        if (st.lastTextPos < 0 || st.lastTextPos >= windowStart) return withStickyAiTitle(sessionId, toClassified(st));
        // else: lastText scrolled out of the window → fall through to a full re-read
      }
    }
  }
  // inode mismatch, shrink/rewrite, or a window-slide fallthrough → full re-read.
  const fresh = fullTail(path, size, mtimeMs, ino);
  tailStates.set(sessionId, fresh);
  return withStickyAiTitle(sessionId, toClassified(fresh));
}

/** Full stateless parse of a transcript's last 64 KB. Exported for tests and used
 *  wherever a one-shot classification (no cross-tick cache) is wanted. */
export function parseTail(path: string): Classified {
  let size: number;
  let mtimeMs: number;
  let ino = 0;
  try {
    const s = statSync(path);
    size = s.size;
    mtimeMs = s.mtimeMs;
    ino = s.ino;
  } catch {
    return toClassified(emptyState(0, 0));
  }
  return toClassified(fullTail(path, size, mtimeMs, ino));
}

/** stop_reason values that mark the END of an assistant turn — the final block of
 *  a completed answer. Evidence (159k assistant records, CC 2.1.119–2.1.215):
 *  these NEVER appear on a mid-turn record, so a text/thinking tail carrying one
 *  is genuinely done regardless of block type. */
function stopEndsTurn(stop: string | null | undefined): boolean {
  return stop === "end_turn" || stop === "stop_sequence" || stop === "refusal";
}

/** stop_reason values that mark a STREAMED INTERMEDIATE block — more records
 *  follow in the same turn. `null` is the streamed-block marker (99%+ of null
 *  text/thinking records are followed by a further assistant record); "tool_use"
 *  rides the precursor text/thinking blocks of a message that ends in a tool call.
 *  Both mean the model is mid-generation, so the tail reads working within the
 *  same short window a thinking tail uses. */
function stopMidTurn(stop: string | null | undefined): boolean {
  return stop === null || stop === "tool_use";
}

export function statusFrom(
  lastKind: string,
  ageSec: number,
  pendingQuestion: boolean,
  lastStop: string | null | undefined
): Status {
  // A still-open AskUserQuestion/ExitPlanMode is blocked ON THE USER: it never ages
  // into "working" like an ordinary pending tool_use — nothing advances until the
  // user answers — so it is waiting regardless of the 1800s window below.
  if (pendingQuestion) return "waiting";
  // An explicit interrupt marker ("[Request interrupted by user…]") means the user
  // aborted the turn: nothing is running and nothing is blocked on them. It settles
  // to idle immediately — not "working" for 300s like the user:tool_result tail it
  // would otherwise read as, and not "waiting" (which would count it as unread).
  if (lastKind === "user:interrupt") return "idle";
  // a turn cannot end on tool activity: a pending tool_use means the tool is
  // still running (or blocked on a permission prompt) even when writes go quiet
  if (lastKind === "assistant:tool_use") return ageSec < 1800 ? "working" : "waiting";
  if (lastKind === "user:tool_result") return ageSec < 300 ? "working" : "waiting";
  if (lastKind.startsWith("assistant")) {
    // A turn can never END on a thinking block — the model always emits text or a
    // tool_use after thinking. So a thinking tail is mid-generation regardless of
    // the message-level stop_reason that rides its streamed sub-record (observed:
    // 206 `end_turn` thinking records are each followed by a text record). Handle
    // it first so that signal can't mark a thinking tail done.
    if (lastKind === "assistant:thinking") return ageSec < 300 ? "working" : "waiting";
    // On a TEXT tail, stop_reason is the primary turn-boundary signal — it
    // disambiguates a final answer (done) from mid-turn narration between tool
    // calls (working), which the block type alone cannot. Present on every CC
    // record since 2.1.119 (verified: `end_turn` on a text tail is never mid-turn);
    // degrades to the legacy "text tail ⇒ waiting" when the field is absent.
    if (stopEndsTurn(lastStop)) return "waiting"; // turn finished → done
    if (stopMidTurn(lastStop)) return ageSec < 300 ? "working" : "waiting"; // mid-stream
    return "waiting";
  }
  if (lastKind === "user:prompt" && ageSec < 120) return "working";
  return "idle";
}

// Transcripts are only written at message boundaries; a long tool call or
// extended-thinking block can go 2-3 min without a write while genuinely working.
const AGENT_ACTIVE_MS = 180_000;
// A subagent whose tail is a pending tool_use/unanswered tool_result can stay quiet
// through a long tool phase. Keep it eligible for the parent-PID-backed status
// override for 30m, then let crashed/abandoned work age out.
const AGENT_PENDING_ACTIVE_MS = 1_800_000;
const metaLabelCache = new Map<string, string>();
const metaDescCache = new Map<string, string>();
const journalCache = new Map<string, { mtimeMs: number; running: Set<string> }>();
interface AgentTail {
  kind: string;
  /** stop_reason of the last assistant record (see Classified.lastStop). */
  stop: string | null | undefined;
}
const agentKindCache = new Map<string, { mtimeMs: number; info: AgentTail }>();

/** Last transcript entry kind + stop_reason for a subagent file, cached by mtime;
 *  kind "" when unreadable. Mirrors parseTail's classification. */
function agentLastInfo(path: string, mtimeMs: number): AgentTail {
  const hit = agentKindCache.get(path);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.info;
  let kind = "";
  let stop: string | null | undefined;
  try {
    const lines = readTail(path, 64 * 1024)
      .split("\n")
      .filter((l) => l.startsWith("{"));
    for (const line of lines) {
      let e: TranscriptEntry;
      try {
        e = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue;
      }
      const content = e.message?.content;
      if (e.type === "assistant" && Array.isArray(content)) {
        const kinds = content.map((c) => c.type ?? "?");
        kind = kinds.includes("tool_use") ? "assistant:tool_use" : `assistant:${kinds[kinds.length - 1]}`;
        stop = e.message?.stop_reason;
      } else if (e.type === "user") {
        kind = isInterruptContent(content)
          ? "user:interrupt"
          : Array.isArray(content)
            ? "user:tool_result"
            : "user:prompt";
        stop = undefined;
      }
    }
  } catch {
    return { kind: "", stop: undefined };
  }
  const info: AgentTail = { kind, stop };
  agentKindCache.set(path, { mtimeMs, info });
  capMap(agentKindCache, 500);
  return info;
}

/** A recently-written subagent transcript is only *working* if its last entry is
 *  pending (an assistant tool_use, or a user tool_result the agent hasn't replied
 *  to yet). A terminal assistant message means it delivered its final result, so
 *  the file being fresh just reflects that last write — not ongoing work. An
 *  unreadable/empty tail counts as not-active so a half-created file doesn't flash. */
export function agentActive(path: string, mtimeMs: number): boolean {
  const { kind, stop } = agentLastInfo(path, mtimeMs);
  if (kind === "") return false;
  // the user aborted this subagent's turn → it is not doing work
  if (kind === "user:interrupt") return false;
  // a pending tool_use means a tool is still running → active
  if (kind === "assistant:tool_use") return true;
  if (kind.startsWith("assistant")) {
    // a turn can never end on a thinking block → mid-generation (handled first so
    // an end_turn riding a streamed thinking sub-record can't mark it done).
    if (kind === "assistant:thinking") return true;
    // stop_reason disambiguates a delivered final result (done) from mid-turn
    // narration (still working) on a TEXT tail — the same signal the session
    // classifier uses. Degrades to "text tail ⇒ done" when the field is absent.
    if (stopEndsTurn(stop)) return false; // final result delivered
    if (stopMidTurn(stop)) return true; // mid-generation
    return false; // text tail, no stop_reason → treat as delivered (legacy)
  }
  // user:tool_result / user:prompt tail — the agent hasn't replied yet → active
  return true;
}

function agentLabel(metaPath: string): string {
  const hit = metaLabelCache.get(metaPath);
  if (hit !== undefined) return hit;
  let label = "agent";
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as { description?: string; agentType?: string };
    label = parsed.description ?? parsed.agentType ?? "agent";
  } catch {
    // meta file missing; keep generic label
  }
  metaLabelCache.set(metaPath, label);
  capMap(metaLabelCache, 1000);
  return label;
}

/** Set of agentIds the workflow journal shows started-without-result, cached by
 *  mtime. Empty on any read error. */
function journalRunningSet(journalPath: string): Set<string> {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(journalPath).mtimeMs;
  } catch {
    return new Set();
  }
  const hit = journalCache.get(journalPath);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.running;
  const running = new Set<string>();
  try {
    for (const line of readFileSync(journalPath, "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const e = JSON.parse(line) as { type?: string; agentId?: string; key?: string };
        const id = e.agentId ?? e.key;
        if (id === undefined) continue;
        if (e.type === "started") running.add(id);
        else if (e.type === "result") running.delete(id);
      } catch {
        continue;
      }
    }
  } catch {
    return new Set();
  }
  journalCache.set(journalPath, { mtimeMs, running });
  capMap(journalCache, 1000);
  return running;
}

/** started-without-result agents according to the workflow journal. */
function journalRunning(journalPath: string): number {
  return journalRunningSet(journalPath).size;
}

/** The `description` field of an agent .meta.json, cached forever; undefined when
 *  absent (workflow subagents only carry an agentType, so this stays undefined
 *  and callers fall back to the shortened id). */
function agentDesc(metaPath: string): string | undefined {
  const hit = metaDescCache.get(metaPath);
  if (hit !== undefined) return hit === "" ? undefined : hit;
  let desc = "";
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as { description?: string };
    desc = parsed.description ?? "";
  } catch {
    // meta file missing/unreadable
  }
  metaDescCache.set(metaPath, desc);
  capMap(metaDescCache, 1000);
  return desc === "" ? undefined : desc;
}

/** wf_abcdef01-... -> abcdef01; a401feef3833a921f -> a401feef. */
function shortId(id: string): string {
  return id.replace(/^wf_/, "").slice(0, 8);
}

const AGENT_RE = /^agent-(.+)\.jsonl$/;

function currentTask(sessionId: string, homeDir: string): string | undefined {
  const dir = join(homeDir, "tasks", sessionId);
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
          status?: string;
          activeForm?: string;
          subject?: string;
        };
        if (t.status === "in_progress") return t.activeForm ?? t.subject;
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// ---- Sub-activity inventory (dirty-set reuse) -------------------------------
// subActivity used to do BOTH the I/O (readdir + stat every agent/workflow file)
// AND the now-dependent freshness derivation on every call. The dirty-set reuse
// path (snapshot) must recompute the freshness of an UNCHANGED session without
// re-doing the I/O, so the two halves are split: buildSubInv does the disk walk
// once (on a full/dirty classify) into a SubInv snapshot of raw mtimes + the
// cached per-child parse results; deriveSubActivity turns a SubInv into the same
// SubActivity a fresh call would, given `now`. Reuse ticks call ONLY the pure
// derive over the cached inventory — no readdir, no stat, no re-parse.
interface AgentInvItem {
  mtimeMs: number;
  /** agentActive(path, mtime), cached by path+mtime. Freshness is applied by each
   *  consumer: 180s for glyphs, 30m for the parent-PID-backed status override. */
  active: boolean;
  /** agentLabel(meta.json) — captured only when fresh+active (the only case it is
   *  emitted); "" otherwise. */
  label: string;
}
interface WfInvItem {
  /** newest mtime across the workflow dir's entries (the freshness clock). */
  newestMs: number;
  /** journalRunning(journal) — read only for workflows fresh at build time. */
  running: number;
}
export interface SubInv {
  agents: AgentInvItem[];
  workflows: WfInvItem[];
  /** max mtime across ALL agent files and ALL workflow-dir entries (fresh or not)
   *  — the session's activity clock. Frozen at build time; unchanged files can't
   *  advance it, so reuse ticks read it straight back. */
  newestMs: number;
  currentTask?: string;
}

/** Walk a session's subagents/workflows/tasks into a SubInv (the disk half of the
 *  old subActivity). Labels and workflow journals are consulted only for fresh
 *  children; agentActive is cached by mtime and retained for the longer status gate. */
function buildSubInv(meta: SessionMeta, homeDir: string, now: number): SubInv {
  const inv: SubInv = { agents: [], workflows: [], newestMs: 0 };
  const base = join(homeDir, "projects", meta.cwd.replace(/[^a-zA-Z0-9]/g, "-"), meta.sessionId, "subagents");

  let names: string[] = [];
  try {
    names = readdirSync(base);
  } catch {
    // no subagents dir: session never spawned agents
  }
  for (const n of names) {
    if (!n.startsWith("agent-") || !n.endsWith(".jsonl")) continue;
    try {
      const p = join(base, n);
      const mtimeMs = statSync(p).mtimeMs;
      if (mtimeMs > inv.newestMs) inv.newestMs = mtimeMs;
      const active = agentActive(p, mtimeMs);
      const label = now - mtimeMs < AGENT_ACTIVE_MS && active
        ? agentLabel(join(base, n.replace(/\.jsonl$/, ".meta.json")))
        : "";
      inv.agents.push({ mtimeMs, active, label });
    } catch {
      continue;
    }
  }

  try {
    const wfBase = join(base, "workflows");
    for (const wf of readdirSync(wfBase)) {
      if (!wf.startsWith("wf_")) continue;
      const dir = join(wfBase, wf);
      let newest = 0;
      try {
        for (const e of readdirSync(dir)) {
          const mtimeMs = statSync(join(dir, e)).mtimeMs;
          if (mtimeMs > newest) newest = mtimeMs;
          if (mtimeMs > inv.newestMs) inv.newestMs = mtimeMs;
        }
      } catch {
        continue;
      }
      // A workflow is only *working* when its journal still has agents that started
      // without a result AND the dir was written recently. The mtime gate is
      // essential: journals of crashed/abandoned runs keep an unbalanced
      // started-without-result forever, so freshness is what keeps those stale runs
      // from showing as perpetually working. journalRunning is read only for a fresh
      // workflow (the old && gate) — a stale one is excluded by freshness regardless.
      const running = now - newest < AGENT_ACTIVE_MS ? journalRunning(join(dir, "journal.jsonl")) : 0;
      inv.workflows.push({ newestMs: newest, running });
    }
  } catch {
    // no workflows dir
  }

  inv.currentTask = currentTask(meta.sessionId, homeDir);
  return inv;
}

/** The now-dependent half of the old subActivity: turn a SubInv into a SubActivity.
 *  Pure — no I/O — so a reuse tick recomputes an unchanged session's activity (and
 *  the child-freshness that ages out on a quiet tick) straight from the cached
 *  inventory. deriveSubActivity(buildSubInv(m, h, now), now) === the old
 *  subActivity(m, h) computed at `now`. Exported for the freshness-rederivation
 *  unit test. */
export function deriveSubActivity(inv: SubInv, now: number): SubActivity {
  const act: SubActivity = {
    agents: 0,
    workflows: 0,
    workflowAgents: 0,
    agentLabels: [],
    newestMs: inv.newestMs,
    currentTask: inv.currentTask,
  };
  for (const a of inv.agents) {
    if (now - a.mtimeMs < AGENT_ACTIVE_MS && a.active) {
      act.agents++;
      act.agentLabels.push(a.label);
    }
  }
  for (const w of inv.workflows) {
    if (now - w.newestMs < AGENT_ACTIVE_MS && w.running > 0) {
      act.workflows++;
      act.workflowAgents += w.running;
    }
  }
  return act;
}

/** Pure seam for the parent-PID-backed pending-subagent status override. */
export function pendingSubagentKeepsWorking(inv: SubInv, now: number, parentAlive: boolean): boolean {
  return parentAlive && inv.agents.some(
    (a) => a.active && now - a.mtimeMs < AGENT_PENDING_ACTIVE_MS
  );
}

/** Absolute path to a session's subagents/ directory. */
function subagentsDir(meta: SessionMeta, homeDir: string): string {
  return join(homeDir, "projects", meta.cwd.replace(/[^a-zA-Z0-9]/g, "-"), meta.sessionId, "subagents");
}

/** True when a session has any subagent, workflow or task on disk — the cheap
 *  gate that decides whether its tree row is expandable. Only called when the
 *  activityTree setting is on, so it adds no work to the default path. */
export function sessionHasDetails(meta: SessionMeta, homeDir: string): boolean {
  const base = subagentsDir(meta, homeDir);
  try {
    for (const n of readdirSync(base)) {
      if (AGENT_RE.test(n)) return true;
      if (n === "workflows") {
        try {
          for (const wf of readdirSync(join(base, "workflows"))) if (wf.startsWith("wf_")) return true;
        } catch {
          // no workflows dir
        }
      }
    }
  } catch {
    // no subagents dir
  }
  try {
    for (const f of readdirSync(join(homeDir, "tasks", meta.sessionId))) if (f.endsWith(".json")) return true;
  } catch {
    // no tasks dir
  }
  return false;
}

// ---- Activity-detail inventory cache (fix 3) --------------------------------
// sessionDetails walks a session's subagents/workflows dirs (readdir + a statSync
// per file) on every panel/tree build. That directory inventory only changes when
// a subagent/workflow file is written — which is exactly what bumps a session's
// activity.newestMs (see subActivity: every agent + wf-dir entry mtime feeds it).
// So we cache the *walked inventory* (paths, mtimes, labels) keyed by newestMs and,
// on a cache hit, skip the whole walk. The now-dependent fields (running, ageSec)
// are ALWAYS recomputed from the cached mtimes, so a child that goes quiet still
// ages out of "running" — no stale-children regression. Tasks are NOT covered by
// newestMs (a task's in-place status edit changes neither newestMs nor the dir
// mtime) and are cheap, so they are always read fresh below.
interface AgentInv {
  id: string;
  label: string;
  path: string;
  mtimeMs: number;
}
interface WorkflowInv {
  id: string;
  journalPath: string;
  mtimeMs: number;
  agents: AgentInv[];
}
interface DetailInventory {
  agents: AgentInv[];
  workflows: WorkflowInv[];
}
const detailInventoryCache = new Map<string, { newestMs: number; inv: DetailInventory }>();

/** Test-only instrumentation: counts full inventory walks so the perf bench can
 *  prove the newestMs cache turns quiet-tick re-walks into hits. One integer bump
 *  per walk — never read by the extension. */
export const __detailWalks = { count: 0 };

/** Walk one dir's agent-*.jsonl files into inventory rows (path + mtime + label),
 *  newest first. No now-dependent derivation — that happens per call. */
function walkAgentsInv(dir: string): AgentInv[] {
  const out: AgentInv[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const m = AGENT_RE.exec(n);
    if (m === null) continue;
    const id = m[1];
    const path = join(dir, n);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    out.push({ id, label: agentDesc(join(dir, `agent-${id}.meta.json`)) ?? shortId(id), path, mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** The expensive part of sessionDetails: readdir + per-file stat over the session's
 *  subagents/ and each workflow dir. Cached by newestMs so repeated ticks reuse it. */
function walkDetailInventory(base: string): DetailInventory {
  __detailWalks.count++;
  const agents = walkAgentsInv(base);
  const workflows: WorkflowInv[] = [];
  const wfBase = join(base, "workflows");
  let wfNames: string[] = [];
  try {
    wfNames = readdirSync(wfBase);
  } catch {
    // no workflows dir
  }
  for (const wf of wfNames) {
    if (!wf.startsWith("wf_")) continue;
    const dir = join(wfBase, wf);
    const wfAgents = walkAgentsInv(dir);
    let mtimeMs = 0;
    try {
      for (const e of readdirSync(dir)) {
        const m = statSync(join(dir, e)).mtimeMs;
        if (m > mtimeMs) mtimeMs = m;
      }
    } catch {
      continue;
    }
    workflows.push({ id: wf, journalPath: join(dir, "journal.jsonl"), mtimeMs, agents: wfAgents });
  }
  workflows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { agents, workflows };
}

/** Derive an AgentDetail (running + ageSec are `now`-dependent) from an inventory
 *  row. `runningIds` decides running from journal membership (workflow case);
 *  otherwise it comes from the transcript tail (agentActive, itself mtime-cached
 *  so this is O(1) on an unchanged file). */
function deriveAgent(a: AgentInv, now: number, runningIds?: Set<string>): AgentDetail {
  const fresh = now - a.mtimeMs < AGENT_ACTIVE_MS;
  const running =
    runningIds !== undefined ? fresh && runningIds.has(a.id) : fresh && agentActive(a.path, a.mtimeMs);
  return { id: a.id, label: a.label, path: a.path, running, ageSec: (now - a.mtimeMs) / 1000, mtimeMs: a.mtimeMs };
}

/** Drop cached detail inventories for sessions that are no longer live (called
 *  from snapshot() where the live-id set is known). */
export function pruneDetailCache(liveIds: Set<string>): void {
  for (const id of detailInventoryCache.keys()) if (!liveIds.has(id)) detailInventoryCache.delete(id);
}

/** Lazy, on-expand detail for a session's tree children: its workflows (newest
 *  first, each with its nested agents), standalone subagents (newest first) and
 *  tasks (task-number order). Pure Node; heavy parses ride the same mtime caches
 *  the pollers use, so repeated expands are cheap. Missing dirs yield empty arrays.
 *  Pass `newestMs` (the row's activity.newestMs) to reuse the cached directory
 *  inventory when nothing under subagents/ has changed. */
export function sessionDetails(meta: SessionMeta, homeDir: string, newestMs?: number): SessionDetails {
  const now = Date.now();
  const base = subagentsDir(meta, homeDir);

  let inv: DetailInventory;
  const cached = newestMs !== undefined ? detailInventoryCache.get(meta.sessionId) : undefined;
  if (cached !== undefined && cached.newestMs === newestMs) {
    inv = cached.inv;
  } else {
    inv = walkDetailInventory(base);
    if (newestMs !== undefined) {
      detailInventoryCache.set(meta.sessionId, { newestMs, inv });
      capMap(detailInventoryCache, 1000);
    }
  }

  const agents = inv.agents.map((a) => deriveAgent(a, now));

  const workflows: WorkflowDetail[] = inv.workflows.map((w) => {
    const runningIds = journalRunningSet(w.journalPath);
    const fresh = now - w.mtimeMs < AGENT_ACTIVE_MS;
    return {
      id: w.id,
      label: shortId(w.id),
      path: w.journalPath,
      running: fresh && runningIds.size > 0,
      runningAgents: fresh ? runningIds.size : 0,
      ageSec: (now - w.mtimeMs) / 1000,
      mtimeMs: w.mtimeMs,
      agents: w.agents.map((a) => deriveAgent(a, now, runningIds)),
    };
  });

  const tasks: TaskDetail[] = [];
  const tasksDir = join(homeDir, "tasks", meta.sessionId);
  let taskFiles: string[] = [];
  try {
    taskFiles = readdirSync(tasksDir);
  } catch {
    // no tasks dir
  }
  for (const f of taskFiles) {
    if (!f.endsWith(".json")) continue;
    const path = join(tasksDir, f);
    try {
      const t = JSON.parse(readFileSync(path, "utf8")) as {
        id?: string;
        subject?: string;
        activeForm?: string;
        status?: string;
        description?: string;
      };
      const id = t.id ?? f.replace(/\.json$/, "");
      const num = Number.parseInt(id, 10);
      let ageSec = 0;
      try {
        ageSec = (now - statSync(path).mtimeMs) / 1000;
      } catch {
        // stat raced with a delete; treat as fresh
      }
      tasks.push({
        id,
        num: Number.isFinite(num) ? num : 0,
        subject: t.subject ?? t.activeForm ?? id,
        status: t.status ?? "pending",
        description: t.description,
        path,
        ageSec,
      });
    } catch {
      continue;
    }
  }
  tasks.sort((a, b) => a.num - b.num);

  return { workflows, agents, tasks };
}

// ---- Dirty-set reuse cache --------------------------------------------------
// The last full/dirty classification of every live session, keyed by sessionId.
// A QUIET tick (no dirty sessions, no registry change) rebuilds each row straight
// from its cached entry with only the now-dependent fields recomputed — no
// readdir, no stat, no transcript re-read. Populated by classifyFull, consumed by
// buildRow, pruned to the live set in snapshot() alongside the other caches. Its
// insertion order mirrors liveSessions() readdir order (Map.set on an existing key
// keeps position), so the reuse path's per-project row order — and the stable-sort
// tie-break on equal mtimeMs — matches a full pass exactly.
interface ReuseEntry {
  meta: SessionMeta;
  home: ConfigHome;
  /** false = the "no transcript yet" branch (stat failed / not written). */
  hasTranscript: boolean;
  /** main-transcript mtime; meta.startedAt when no transcript. Stable while the
   *  session is not dirty (a transcript write marks it dirty → full reclassify). */
  mainMtimeMs: number;
  /** cached tail classification; undefined on the no-transcript branch. */
  cls?: Classified;
  /** main-transcript inode; undefined on the no-transcript branch. */
  mainIno?: number;
  subInv: SubInv;
}
const reuseCache = new Map<string, ReuseEntry>();

/** Build a SessionRow from a cached entry at `now`, recomputing ONLY the fields
 *  that move without a disk write: ageSec, status (age thresholds + the
 *  orchestrating→working override), and the child-freshness inside activity. Shared
 *  by classifyFull (right after it refreshes the entry) and the reuse path, so the
 *  two produce byte-identical rows by construction. */
function buildRow(e: ReuseEntry, now: number): SessionRow {
  const activity = deriveSubActivity(e.subInv, now);
  if (!e.hasTranscript || e.cls === undefined) {
    return {
      meta: e.meta,
      status: "idle",
      ageSec: null,
      mtimeMs: e.mainMtimeMs,
      mainMtimeMs: e.mainMtimeMs,
      lastText: "",
      activity,
      pendingQuestion: false,
      homeDir: e.home.dir,
      homeLabel: e.home.label,
    };
  }
  const cls = e.cls;
  const mainAgeSec = (now - e.mainMtimeMs) / 1000;
  let status = statusFrom(cls.lastKind, mainAgeSec, cls.pendingQuestion, cls.lastStop);
  // Both subactivity overrides below are blocked when the main tail is blocked ON or
  // ABORTED BY the user: a pending question is waiting on the user (statusFrom returns
  // "waiting"), and an explicit interrupt settled the turn to idle (nothing is running
  // — the aborted turn's subagents were torn down with it). Neither may be resurrected
  // to "working" by a leftover fresh/pending child.
  const userSettled = cls.pendingQuestion || cls.lastKind === "user:interrupt";
  // A pending question / interrupt wins over the orchestrating→working override below.
  if (!userSettled && (activity.agents > 0 || activity.workflows > 0)) status = "working";
  // Parent-PID ground truth: a live session whose own tail looks finished but which
  // still has a PENDING subagent (a long tool phase gone quiet past the 180s glyph
  // window, or a background wave) is not done. Bounded by AGENT_PENDING_ACTIVE_MS so a
  // crashed/abandoned subagent can't pin it working forever, and by pidAlive so a dead
  // session settles immediately.
  if (status !== "working" && !userSettled && pendingSubagentKeepsWorking(e.subInv, now, pidAlive(e.meta.pid))) {
    status = "working";
  }
  const mtimeMs = Math.max(e.mainMtimeMs, activity.newestMs);
  const ageSec = (now - mtimeMs) / 1000;
  return {
    meta: e.meta,
    status,
    ageSec,
    mtimeMs,
    mainMtimeMs: e.mainMtimeMs,
    lastText: cls.lastText,
    aiTitle: cls.aiTitle,
    activity,
    pendingQuestion: cls.pendingQuestion,
    questionText: cls.questionText,
    pendingToolName: cls.pendingToolName,
    // Normalize the raw pending edit path (if any) against the session cwd —
    // purely lexical, no fs call, so it adds no I/O to the tail parse. A path that
    // still contains a `..` after the cwd-join is left UNMATCHABLE (undefined): we
    // don't resolve symlinks, so `/repo/link/../a.ts` must never be treated as the
    // same file as `/repo/a.ts`. Evidence: 99.7% of edit paths are already absolute
    // and `..`-free, so the loss is nil and the symlink false-positive class is gone.
    pendingEditPath:
      cls.pendingEditPath !== undefined
        ? normalizeEditPath(cls.pendingEditPath, e.meta.cwd)
        : undefined,
    homeDir: e.home.dir,
    homeLabel: e.home.label,
    usage: cls.usage,
    mainIno: e.mainIno,
  };
}

/** Full classification: walk the session's activity + transcript tail, record its
 *  parse health, refresh its reuse-cache entry, and return the derived row. This is
 *  the always-correct path; the reuse path only substitutes for it on sessions that
 *  provably did not change since their last full pass. */
function classifyFull(meta: SessionMeta, home: ConfigHome, now: number): SessionRow {
  const subInv = buildSubInv(meta, home.dir, now);
  const path = transcriptPath(meta, home.dir);
  // A single guarded stat collapses "no transcript yet" and "transcript raced
  // with a delete" into one branch, so neither existsSync nor statSync can throw
  // out of snapshot() -> reload() -> refresh().
  let mainMtimeMs: number | undefined;
  let mainSize = 0;
  let mainIno = 0;
  try {
    const s = statSync(path);
    mainMtimeMs = s.mtimeMs;
    mainSize = s.size;
    mainIno = s.ino;
  } catch {
    mainMtimeMs = undefined;
  }
  if (mainMtimeMs === undefined) {
    const entry: ReuseEntry = {
      meta,
      home,
      hasTranscript: false,
      mainMtimeMs: meta.startedAt,
      subInv,
    };
    reuseCache.set(meta.sessionId, entry);
    capMap(reuseCache, 2000);
    return buildRow(entry, now);
  }

  const cls = classifyTail(meta.sessionId, path, mainSize, mainMtimeMs, mainIno);
  // Format-canary: a pid-alive session whose transcript has content but parsed to
  // zero recognizable records is the Claude drift signal. An empty transcript (no
  // content yet) is healthy — there is nothing to misparse. A read that ERRORED this
  // tick (readError) parsed nothing at all — recording it as `failed` would latch a
  // false drift on a transient IO blip, so skip health entirely for that tick.
  if (!cls.readError) recordClaudeHealth(meta.sessionId, mainSize === 0 || cls.recognized, cls.version, path);

  const entry: ReuseEntry = {
    meta,
    home,
    hasTranscript: true,
    mainMtimeMs,
    mainIno,
    cls,
    subInv,
  };
  reuseCache.set(meta.sessionId, entry);
  capMap(reuseCache, 2000);
  return buildRow(entry, now);
}

/** Classify a single session, always fresh. Kept for callers/tests that want a
 *  one-shot classification independent of the reuse cache. */
export function classify(meta: SessionMeta, home: ConfigHome): SessionRow {
  return classifyFull(meta, home, Date.now());
}

/** Dirty-set hint for an incremental snapshot() tick (see snapshot). Omitted →
 *  a full pass (every session reclassified, registry rescanned). */
export interface ReuseHint {
  /** sessionIds a watch/hook event flagged as changed since the last pass — force
   *  a full reclassify of exactly these. */
  dirty: Set<string>;
  /** the sessions/ registry changed (a session started/ended) → rescan the
   *  registry so the live set is re-derived; existing unchanged rows still reuse. */
  registryChanged: boolean;
  /** periodic reconciliation: reclassify everything and rescan the registry — the
   *  safety net that heals any missed watch event (bounded lag ≤ one interval). */
  forceFull: boolean;
}

/** Live (meta, home) pairs for a reuse tick, taken from the cache and swept for
 *  dead pids so the tree self-heals as sessions exit — without the per-tick
 *  readdir + registry re-read a full liveSessions() pass costs. New sessions
 *  (new registry files) re-enter via a registryChanged/forceFull rescan.
 *
 *  Pid-reuse note: this sweep applies ONLY the cheap `pidAlive` gate, not the
 *  `pidStartTime`/`procStart` reuse guard liveSessions() runs. So if a session's
 *  pid dies and is immediately reused by an unrelated process, its ghost row can
 *  survive at most one reconcile interval (≤30s) — the periodic forceFull rescan
 *  goes back through liveSessions() and its reuse guard drops it (on macOS and
 *  Windows once the process table has the pid's row). Same
 *  self-healing, low-probability class as a missed watch event. */
function cachedLive(): { meta: SessionMeta; home: ConfigHome }[] {
  const out: { meta: SessionMeta; home: ConfigHome }[] = [];
  for (const e of reuseCache.values()) if (pidAlive(e.meta.pid)) out.push({ meta: e.meta, home: e.home });
  return out;
}

/** True when two registry metas are field-for-field equal. On a registryChanged
 *  rescan a session's registry file can be rewritten in place (pid/cwd/startedAt/
 *  name change) under the SAME sessionId; the fresh meta must then reclassify
 *  rather than reuse a row still carrying the stale meta. */
function sameMeta(a: SessionMeta, b: SessionMeta): boolean {
  return (
    a.pid === b.pid &&
    a.cwd === b.cwd &&
    a.startedAt === b.startedAt &&
    a.procStart === b.procStart &&
    a.kind === b.kind &&
    a.entrypoint === b.entrypoint &&
    a.name === b.name
  );
}

/** Which of two live registrations of one sessionId wins: the newest start, with pid
 *  as a deterministic tie-break (readdir order is not stable across ticks). */
function newerRegistration(a: SessionMeta, b: SessionMeta): boolean {
  return a.startedAt !== b.startedAt ? a.startedAt > b.startedAt : a.pid > b.pid;
}

export function snapshot(homes: ConfigHome[], hint?: ReuseHint): Map<string, SessionRow[]> {
  const now = Date.now();
  const byProject = new Map<string, SessionRow[]>();
  const liveIds = new Set<string>();

  // A full pass (no hint, forceFull, a registry change, or a cold cache) re-reads
  // the registry; a quiet/dirty tick reuses the cached live set and only sweeps
  // dead pids. `forceFull`/`reclassifyAll` also decide, per session, whether to
  // re-walk the disk (classifyFull) or rebuild from cache (buildRow).
  const reclassifyAll = hint === undefined || hint.forceFull;
  const rescan = reclassifyAll || hint.registryChanged || reuseCache.size === 0;
  const dirty = hint?.dirty;

  const found: { meta: SessionMeta; home: ConfigHome }[] = [];
  if (rescan) {
    for (const home of homes) for (const meta of liveSessions(home.dir)) found.push({ meta, home });
  } else {
    found.push(...cachedLive());
  }
  // One row per sessionId. A session can hold two live registrations — resumed in a
  // second terminal, or re-registered after its cwd moved — and liveSessions() reads
  // the id from each registry file's CONTENT (the name is only a pid), so both
  // surface, under two cwds. Rows sharing a sessionId then collide on the tree's item
  // id (`<sessionId>#g<n>`, and `remote-session:<host>:<id>` once published): VS Code
  // rejects the repeat with "Element with id … is already registered" and the whole
  // view stops rendering. Newest registration wins — that's the cwd the session runs
  // in now — with pid breaking the tie so the survivor doesn't flip on readdir order.
  // reuseCache is keyed by sessionId and already collapsed these, so this also makes
  // a rescan tick agree with a cached tick on the row count.
  const bySession = new Map<string, { meta: SessionMeta; home: ConfigHome }>();
  for (const e of found) {
    const prev = bySession.get(e.meta.sessionId);
    if (prev === undefined || newerRegistration(e.meta, prev.meta)) bySession.set(e.meta.sessionId, e);
  }
  const live = [...bySession.values()];

  for (const { meta, home } of live) {
    liveIds.add(meta.sessionId);
    const cached = reuseCache.get(meta.sessionId);
    // On a rescan the `meta` is a FRESH registry read; if its content changed for an
    // existing sessionId, reclassify so the row stops carrying the stale meta (a
    // reuse would keep cached.meta). Off a rescan, meta IS cached.meta (identical), so
    // this never trips.
    const metaChanged = cached !== undefined && !sameMeta(cached.meta, meta);
    const row =
      reclassifyAll || cached === undefined || metaChanged || (dirty !== undefined && dirty.has(meta.sessionId))
        ? classifyFull(meta, home, now)
        : buildRow(cached, now);
    // Grouped by the drive-normalised cwd (`s:\` and `S:\` are one folder); the row
    // keeps its raw meta.cwd, which is what actions hand to the editor and the CLI.
    const key = normalizeDriveLetter(meta.cwd);
    const list = byProject.get(key) ?? [];
    list.push(row);
    byProject.set(key, list);
  }

  // most recent activity first inside each project
  for (const list of byProject.values()) list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // drop cache entries for sessions that ended
  for (const id of tailStates.keys()) if (!liveIds.has(id)) tailStates.delete(id);
  for (const id of aiTitleCache.keys()) if (!liveIds.has(id)) aiTitleCache.delete(id);
  for (const id of reuseCache.keys()) if (!liveIds.has(id)) reuseCache.delete(id);
  pruneDetailCache(liveIds);
  pruneClaudeHealth(liveIds);
  return byProject;
}

/** One live project transcript dir + the sessionIds it hosts + its newest activity.
 *  extension.ts watches each dir non-recursively: a write to `<dir>/<sessionId>.jsonl`
 *  names the session to mark dirty; a null filename (rare, non-Linux) marks every
 *  session in that dir. */
export interface ProjectWatchTarget {
  dir: string;
  sids: string[];
  /** newest mtime across this dir's live sessions — hottest projects first, so a
   *  soft watcher cap keeps fs.watch on the dirs most likely to write next and
   *  leaves cold ones to the periodic reconcile. */
  newestMs: number;
}

/** Live project watch targets from the reuse cache (in-memory, no scan), sorted
 *  most-recently-active first. Reflects the last snapshot's live set — a brand-new
 *  session's dir is added on the next reconcile. */
export function liveProjectMap(): ProjectWatchTarget[] {
  const byDir = new Map<string, ProjectWatchTarget>();
  for (const e of reuseCache.values()) {
    const dir = join(e.home.dir, "projects", e.meta.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    const newest = Math.max(e.mainMtimeMs, e.subInv.newestMs);
    const t = byDir.get(dir);
    if (t === undefined) byDir.set(dir, { dir, sids: [e.meta.sessionId], newestMs: newest });
    else {
      t.sids.push(e.meta.sessionId);
      if (newest > t.newestMs) t.newestMs = newest;
    }
  }
  return [...byDir.values()].sort((a, b) => b.newestMs - a.newestMs);
}

/** A dir the extension watches under the shared inotify budget. Three families, one
 *  hottest-first ranking (so adding the session-scoped families re-spends the inotify
 *  budget, never grows it):
 *   • PROJECT — a `projects/<slug>/` dir whose `<sid>.jsonl` writes are the
 *     status/question signal (one target covers every session in the project).
 *   • SUBAGENT — a WORKING session's `subagents/` dir. Its DIRECT children are
 *     `agent-<id>.jsonl`, so a non-recursive watch fires on a direct-agent SPAWN and
 *     on every ongoing direct-agent APPEND — making ⚙N (direct agents) live ≤1 tick.
 *   • WORKFLOWS — a WORKING session's `subagents/workflows/` dir. Its DIRECT children
 *     are the `wf_*` run dirs, so a non-recursive watch fires when a NEW workflow run
 *     APPEARS (live ≤1 tick) but NOT on the journal/nested-agent appends deep inside a
 *     `wf_*` run dir — those stay reconcile-bound (the honest limit of a one-level watch).
 *  Both session-scoped families name their owning session directly and mark it dirty. */
export type WatchTarget =
  | { kind: "project"; dir: string; sids: string[]; newestMs: number }
  | { kind: "subagent"; dir: string; sid: string; newestMs: number }
  | { kind: "workflows"; dir: string; sid: string; newestMs: number };

/** Merged, hottest-first watch targets for the shared inotify budget: one PROJECT
 *  target per live project dir; for each WORKING session, a SUBAGENT target iff it has
 *  DIRECT agents, and a WORKFLOWS target iff it has workflow runs. A session with
 *  neither (or one that isn't working) has no live ⚙N to keep fresh, so it gets no
 *  session-scoped watcher. The gate keys on DIRECT agents vs workflows separately so a
 *  workflow-only session gets the `subagents/workflows/` watcher (which can fire for
 *  it) rather than a `subagents/` watcher (which never would). UNCAPPED — the caller
 *  slices to its soft cap; the coldest targets past the cap ride the reconcile.
 *
 *  Ranking invariant: a project's heat is the MAX over its sessions' heat, and every
 *  session-scoped target's heat is that one session's heat, so a project (status)
 *  watcher always ranks ≥ its OWN sessions' ⚙N watchers. Cap pressure can therefore
 *  never drop a project's status watcher in favour of that same project's ⚙N watcher.
 *  ACROSS projects a hot orchestrator's ⚙N target CAN outrank a colder project's
 *  target and evict it — intended: the cold project's next status flip isn't imminent
 *  and the ~30s reconcile heals it, while the hot orchestrator's ⚙N moves every few
 *  seconds. Pure read of the reuse cache — no scan. */
export function hotWatchTargets(now: number = Date.now()): WatchTarget[] {
  const targets: WatchTarget[] = liveProjectMap().map((t) => ({ kind: "project", ...t }));
  for (const e of reuseCache.values()) {
    // Only a WORKING session carries a ⚙N worth a watcher. buildRow re-derives status
    // (and child-freshness) at `now` — the same status the tree renders — so the gate
    // matches exactly the rows where ⚙N shows.
    if (e.subInv.agents.length === 0 && e.subInv.workflows.length === 0) continue;
    if (buildRow(e, now).status !== "working") continue;
    const base = subagentsDir(e.meta, e.home.dir); // one path helper, no inlined slug
    // Session heat: the same expression for both families and for liveProjectMap, so
    // the ranking invariant above holds by construction.
    const heat = Math.max(e.mainMtimeMs, e.subInv.newestMs);
    // Direct agents (agent-<id>.jsonl at subagents/) → the subagents/ watcher fires on
    // spawn AND on every ongoing append.
    if (e.subInv.agents.length > 0) targets.push({ kind: "subagent", dir: base, sid: e.meta.sessionId, newestMs: heat });
    // Workflow runs (wf_* dirs at subagents/workflows/) → the workflows/ watcher fires
    // when a new run appears; deeper journal appends stay reconcile-bound.
    if (e.subInv.workflows.length > 0)
      targets.push({ kind: "workflows", dir: join(base, "workflows"), sid: e.meta.sessionId, newestMs: heat });
  }
  return targets.sort((a, b) => b.newestMs - a.newestMs);
}

/** The session ids a hot-dir watch event should mark dirty. A SUBAGENT or WORKFLOWS
 *  target names its owning session directly (its children are `agent-<id>.jsonl` /
 *  `wf_*` dirs, so the filename can't). A PROJECT target reads the session from the
 *  `<sid>.jsonl` filename; a null filename (non-Linux) or a non-transcript child
 *  conservatively marks every session the dir hosts (the reconcile heals anything
 *  still stale). Pure — the extension watch callback feeds the result into the dirty
 *  set. */
export function watchEventDirty(t: WatchTarget, filename: string | null): string[] {
  if (t.kind !== "project") return [t.sid];
  if (typeof filename === "string" && filename.endsWith(".jsonl")) return [filename.slice(0, -".jsonl".length)];
  return t.sids;
}

/** Test-only: clear the dirty-set reuse cache so a suite starts from a cold pass. */
export function __resetReuseCache(): void {
  reuseCache.clear();
}

let subMinuteMasked = 0;

/** Run `fn` with every sub-minute age fmtAge renders ("45s") replaced by one
 *  placeholder, so text built for comparison ignores the per-tick drift of a young
 *  row's age while still seeing everything else, including any "1s" inside a
 *  message (the tree's row comparison, SessionsProvider.fireTreeChanges). */
export function withSubMinuteAgesMasked<T>(fn: () => T): T {
  subMinuteMasked++;
  try {
    return fn();
  } finally {
    subMinuteMasked--;
  }
}

export function fmtAge(sec: number | null): string {
  if (sec === null) return "new";
  if (sec < 60) return subMinuteMasked > 0 ? "<1m" : `${Math.round(sec)}s`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)}m`;
  if (sec < 48 * 3600) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

// =============================================================================
// Per-session / per-subagent MODEL · MODE · TOKEN accounting.
// -----------------------------------------------------------------------------
// Lives here (not a new module — the src/*.ts freeze) because it extends the fold
// path that already runs in this file. Field shapes (verified against real
// transcripts on this machine, 2026-07):
//   • assistant record `message.model`     — "claude-fable-5", "gpt-5.6-sol" …
//     ("<synthetic>" marks a client-injected turn and is NOT a real model → skipped)
//   • assistant record `message.usage`      — { input_tokens, output_tokens,
//     cache_creation_input_tokens, cache_read_input_tokens }. The SAME usage object
//     is repeated on every streamed-block record of ONE message, so it must be
//     counted ONCE PER `message.id` (records of a message are contiguous, and the
//     usage is byte-identical across them — verified) — a per-record sum would
//     multiply a turn's tokens by its block count.
//   • top-level `permissionMode`            — rides user records (values seen:
//     default / acceptEdits / plan / bypassPermissions / auto); captured last-seen.
// Subagent transcripts carry model + usage but NO permissionMode (they inherit the
// parent's mode, which is never written to their file).

export interface Usage {
  /** raw input_tokens (non-cached prompt tokens billed at full rate) */
  input: number;
  output: number;
  /** cache_read_input_tokens (prompt tokens served from the cache) */
  cacheRead: number;
  /** cache_creation_input_tokens (prompt tokens written to the cache) */
  cacheCreate: number;
}

export function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

export function addUsage(dst: Usage, src: Usage): void {
  dst.input += src.input;
  dst.output += src.output;
  dst.cacheRead += src.cacheRead;
  dst.cacheCreate += src.cacheCreate;
}

/** Sum of two usages into a fresh object (does not mutate its inputs). */
export function sumUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreate: a.cacheCreate + b.cacheCreate,
  };
}

/** Extract a Usage from a raw `message.usage` object, or undefined when the shape
 *  carries none of the four token fields. Never throws on odd shapes. */
export function usageFromRaw(raw: unknown): Usage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = num(r.input_tokens);
  const output = num(r.output_tokens);
  const cacheRead = num(r.cache_read_input_tokens);
  const cacheCreate = num(r.cache_creation_input_tokens);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheCreate === 0) return undefined;
  return { input, output, cacheRead, cacheCreate };
}

/** A model string that is not a real model (client-injected turns). */
const SYNTHETIC_MODEL = "<synthetic>";

/** True when `model` is a countable real model (not synthetic / empty). */
export function isRealModel(model: unknown): model is string {
  return typeof model === "string" && model !== "" && model !== SYNTHETIC_MODEL;
}

/** Shorten a model id for a compact caption: strip a Bedrock-style vendor prefix
 *  ("us.anthropic.") and the leading "claude-", and drop a trailing 8-digit date
 *  stamp. "claude-fable-5" → "fable-5"; "claude-haiku-4-5-20251001" → "haiku-4-5";
 *  "gpt-5.6-sol" is left as-is (no claude prefix). */
export function shortModel(model: string): string {
  let m = model.replace(/^[a-z]+(\.[a-z]+)+\./i, ""); // us.anthropic. / bedrock. …
  m = m.replace(/^claude-/, "");
  m = m.replace(/-\d{8}$/, ""); // trailing date stamp
  return m === "" ? model : m;
}

/** Compact a token count: 980 → "980", 8_321 → "8.3k", 45_000 → "45k",
 *  1_200_000 → "1.2M". Sub-1000 is exact; k/M use one decimal below 100 of the
 *  unit and round to a whole otherwise so the string stays short. */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    const s = k < 100 ? trim1(k) : String(Math.round(k));
    // Guard the k→M carry: 999_999 rounds to 1000k, which must read "1M" not "1000k".
    if (s !== "1000") return s + "k";
  }
  const mm = n / 1_000_000;
  return (mm < 100 ? trim1(mm) : String(Math.round(mm))) + "M";
}

/** One-decimal, trailing ".0" stripped: 8.3 → "8.3", 45.0 → "45". */
function trim1(x: number): string {
  const s = x.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** The "N in / M out (P% cached)" body for a session/subagent hover. `in` is the
 *  full input side (raw + cache-read + cache-create), so "1.2M in (98% cached)"
 *  reads as "1.2M input tokens, 98% served from cache". The cached-% suffix shows
 *  ONLY when cache reads DOMINATE the input side (> raw + cache-create), matching
 *  the compact-only-when-meaningful rule. */
export function formatUsage(u: Usage): string {
  const inTotal = u.input + u.cacheRead + u.cacheCreate;
  const base = `${compactTokens(inTotal)} in / ${compactTokens(u.output)} out`;
  if (u.cacheRead > u.input + u.cacheCreate && inTotal > 0) {
    const pct = Math.round((u.cacheRead / inTotal) * 100);
    return `${base} (${pct}% cached)`;
  }
  return base;
}

/** Ultra-compact token clause for an activity-tree row description: total tokens
 *  (input side + output) as "<N> tok" — e.g. "1.2M tok". */
export function shortTokens(u: Usage): string {
  return `${compactTokens(u.input + u.cacheRead + u.cacheCreate + u.output)} tok`;
}

// ---- Streaming usage accumulator (shared by the fold path and the scanner) -----

/** Cap on the recent-message-id dedup memory. Usage is repeated across a message's
 *  contiguous streamed blocks, so in practice a 1-deep guard suffices; this bounded
 *  ring hardens against ANY non-adjacent repetition (a record re-emitted after an
 *  interleaving message) without unbounded growth or a per-record allocation. 512
 *  covers hundreds of turns of look-back — far beyond any observed streaming span. */
const RECENT_ID_CAP = 512;

/** A bounded recent-id membership set with FIFO eviction — the dedup guard shared by
 *  the scanner (UsageAcc) and the fold path (TailState). Allocation-light: one Set +
 *  one array, mutated in place; nothing allocated per already-seen record. */
export interface RecentIds {
  set: Set<string>;
  ring: string[];
}

export function emptyRecentIds(): RecentIds {
  return { set: new Set(), ring: [] };
}

/** Record `id` as seen; returns true when it is NEW (caller should count it), false
 *  when it was already within the recent window (a duplicate → skip). Evicts the
 *  oldest id once the ring exceeds RECENT_ID_CAP. */
export function noteMsgId(r: RecentIds, id: string): boolean {
  if (r.set.has(id)) return false;
  r.set.add(id);
  r.ring.push(id);
  if (r.ring.length > RECENT_ID_CAP) {
    const old = r.ring.shift();
    if (old !== undefined) r.set.delete(old);
  }
  return true;
}

/** Running usage/model/mode state, deduped by a bounded recent-id ring. Used by the
 *  background full-file scanner (the fold path mirrors the same logic against
 *  TailState, which it must because it also tracks firstMsgId/firstMsgUsage). */
export interface UsageAcc {
  total: Usage;
  /** id of the last assistant message counted (the straddle-dedup key returned as
   *  PreWindow.lastMsgId). */
  lastMsgId?: string;
  /** bounded dedup guard against non-adjacent message-id repetition. */
  recent: RecentIds;
  model?: string;
  mode?: string;
}

export function emptyUsageAcc(): UsageAcc {
  return { total: zeroUsage(), recent: emptyRecentIds() };
}

/** Minimal record shape the accumulator reads. */
interface UsageRecord {
  type?: string;
  permissionMode?: unknown;
  message?: { id?: unknown; model?: unknown; usage?: unknown } | undefined;
}

/** Fold ONE parsed transcript record into `acc`: capture a new permissionMode /
 *  model, and add its message's usage exactly once per message id (guarded by the
 *  bounded recent-id ring). Returns the usage added THIS call (zeroUsage when nothing
 *  counted). This is the SCANNER's per-record path; the incremental fold in foldRecord
 *  inlines the same logic against TailState (it also needs firstMsgId/firstMsgUsage). */
export function foldUsageRecord(acc: UsageAcc, e: UsageRecord): Usage {
  if (typeof e.permissionMode === "string" && e.permissionMode !== "") acc.mode = e.permissionMode;
  if (e.type !== "assistant") return zeroUsage();
  const m = e.message;
  if (m === undefined || m === null) return zeroUsage();
  if (isRealModel(m.model)) acc.model = m.model;
  const mid = m.id;
  if (typeof mid !== "string" || !noteMsgId(acc.recent, mid)) return zeroUsage();
  acc.lastMsgId = mid;
  const u = usageFromRaw(m.usage);
  if (u === undefined) return zeroUsage();
  addUsage(acc.total, u);
  return u;
}

/** Fold one raw JSONL line into `acc` (parse + foldUsageRecord), swallowing parse
 *  errors. Shared by the sync and streamed scans. */
function foldUsageLine(acc: UsageAcc, line: string): void {
  let e: UsageRecord;
  try {
    e = JSON.parse(line) as UsageRecord;
  } catch {
    return;
  }
  foldUsageRecord(acc, e);
}

/** Scan a byte range [start, end) of a transcript into a UsageAcc, deduping by
 *  message id. SYNCHRONOUS whole-range read — used for small ranges (tests, and the
 *  in-range ground truth). The background scanner uses the CHUNKED, yielding
 *  `scanUsageRangeStreamed` below so a huge transcript never stalls the loop or
 *  balloons RSS. Never throws — a vanished/unreadable file yields an empty acc. */
export function scanUsageRange(path: string, start: number, end: number): UsageAcc {
  const acc = emptyUsageAcc();
  let text: string;
  try {
    if (end <= start) return acc;
    const buf = readFileSync(path);
    text = buf.toString("utf8", start, Math.min(end, buf.length));
  } catch {
    return acc;
  }
  for (const line of text.split("\n")) {
    if (line.charCodeAt(0) !== 0x7b /* '{' */) continue;
    foldUsageLine(acc, line);
  }
  return acc;
}

/** Chunk size for the streamed scan — read/fold/yield in ~4 MB slices so RSS stays
 *  chunk-bounded (never the whole file) and the event loop is released between
 *  slices instead of stalling for the full read+parse. */
const USAGE_SCAN_CHUNK = 4 * 1024 * 1024;

/** Yield to the event loop (macrotask), so a multi-chunk scan interleaves with ticks
 *  instead of monopolizing the loop. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Streamed, yielding counterpart of scanUsageRange for LARGE transcripts: reads
 *  [start, end) in ~4 MB chunks, folding complete JSONL lines as they arrive and
 *  awaiting a macrotask between chunks. Line splitting is byte-level (`\n` = 0x0a is
 *  a single byte, never part of a multibyte sequence), and the trailing partial line
 *  is carried as BYTES across the chunk boundary so a split multibyte char can't be
 *  mis-decoded. RSS is bounded by one chunk + the small carry + the acc. Never throws
 *  — an unreadable/vanished file yields whatever was folded so far. */
export async function scanUsageRangeStreamed(
  path: string,
  start: number,
  end: number,
  chunkSize: number = USAGE_SCAN_CHUNK
): Promise<UsageAcc> {
  const acc = emptyUsageAcc();
  if (end <= start) return acc;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return acc;
  }
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let pos = start;
    let carry = Buffer.alloc(0); // bytes of the incomplete final line from the last chunk
    while (pos < end) {
      const want = Math.min(chunkSize, end - pos);
      let n: number;
      try {
        n = readSync(fd, buf, 0, want, pos);
      } catch {
        break;
      }
      if (n <= 0) break;
      pos += n;
      const chunk = buf.subarray(0, n);
      const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      let lineStart = 0;
      for (;;) {
        const nl = combined.indexOf(0x0a, lineStart);
        if (nl === -1) break;
        if (combined[lineStart] === 0x7b /* '{' */) foldUsageLine(acc, combined.toString("utf8", lineStart, nl));
        lineStart = nl + 1;
      }
      // Carry the trailing partial line as a COPY (buf is reused on the next read).
      carry = lineStart < combined.length ? Buffer.from(combined.subarray(lineStart)) : Buffer.alloc(0);
      await yieldToLoop();
    }
    // A final line with no trailing newline (whole-file scans usually end in \n, so
    // this is rare, but stay correct).
    if (carry.length > 0 && carry[0] === 0x7b) foldUsageLine(acc, carry.toString("utf8"));
  } finally {
    try {
      closeSync(fd);
    } catch {
      // fd already invalid; ignore
    }
  }
  return acc;
}

// ---- Fold-side bundle (built on the tail, combined for display) ---------------

/** Usage/model/mode accumulated over a transcript's TAIL WINDOW ([base, size)) by
 *  the incremental fold — enough for the display combiner to assemble the full-file
 *  total from the background pre-window scan. */
export interface UsageFold {
  /** usage summed over the window, deduped by message id */
  total: Usage;
  /** absolute byte offset the window started at; 0 ⇒ the whole file is in the
   *  window and `total` is already the exact full-file total (no scan needed). */
  base: number;
  /** id + usage of the FIRST message counted in the window, so the combiner can
   *  drop a message that straddles `base` (counted by BOTH the pre-window scan and
   *  the window fold). undefined when the window counted no message. */
  firstMsgId?: string;
  firstMsgUsage: Usage;
  /** last-seen model / permissionMode in the window (more recent than the
   *  pre-window scan's, so preferred). */
  model?: string;
  mode?: string;
}

/** Pre-window scan result for [0, base). */
export interface PreWindow {
  usage: Usage;
  /** id of the last message counted before `base` — matched against the window's
   *  firstMsgId to drop a boundary-straddling message. */
  lastMsgId?: string;
  model?: string;
  mode?: string;
}

/** The assembled, display-ready total for a session. `ready` is false while the
 *  pre-window scan is still pending (show "…", never a fake number). */
export interface UsageTotal {
  ready: boolean;
  usage: Usage;
  model?: string;
  mode?: string;
}

/** Combine a fold bundle with its (possibly-pending) pre-window scan into the
 *  full-file total. When `base === 0` the fold IS the full total (exact, no scan).
 *  Otherwise the pre-window usage is added and a message straddling `base` — one
 *  the scan's last message and the window's first message share by id — is
 *  subtracted once so it isn't counted twice. */
export function combineUsage(fold: UsageFold, pre: PreWindow | undefined): UsageTotal {
  if (fold.base === 0) {
    return { ready: true, usage: fold.total, model: fold.model, mode: fold.mode };
  }
  if (pre === undefined) {
    return { ready: false, usage: fold.total, model: fold.model, mode: fold.mode };
  }
  const usage = sumUsage(pre.usage, fold.total);
  if (fold.firstMsgId !== undefined && fold.firstMsgId === pre.lastMsgId) {
    usage.input -= fold.firstMsgUsage.input;
    usage.output -= fold.firstMsgUsage.output;
    usage.cacheRead -= fold.firstMsgUsage.cacheRead;
    usage.cacheCreate -= fold.firstMsgUsage.cacheCreate;
  }
  return {
    ready: true,
    usage,
    model: fold.model ?? pre.model,
    mode: fold.mode ?? pre.mode,
  };
}

// ---- Background scanner (off-tick, bounded to one file at a time) --------------

interface PreEntry {
  base: number;
  ino: number;
  pre?: PreWindow; // undefined while the scan is queued/in-flight
}
interface AgentUsageEntry {
  size: number;
  result?: { usage: Usage; model?: string }; // undefined while queued/in-flight
}
/** A queued scan job, tagged with its owning sessionId (pre-window scans) so a
 *  vanished session's still-queued scan can be dropped before it runs. Agent scans
 *  carry no sessionId (keyed by path, bounded by the agent-cache cap). */
interface ScanJob {
  sessionId?: string;
  run: () => Promise<void>;
}

/** Owns the lazy, off-tick file scans that back the token totals. One scan runs at a
 *  time (a serial queue drained via setImmediate) and each scan is itself CHUNKED and
 *  YIELDING (scanUsageRangeStreamed), so a busy fleet never fans out into a read storm,
 *  a single huge transcript never stalls the loop, and RSS stays chunk-bounded — and
 *  nothing ever runs on the poll tick. Every completed scan fires `onDone`, which the
 *  provider wires to a tree refresh so the resolved number replaces the "…" placeholder
 *  on the next render. */
export class TokenScanner {
  private readonly preCache = new Map<string, PreEntry>();
  private readonly agentCache = new Map<string, AgentUsageEntry>();
  private queue: ScanJob[] = [];
  private draining = false;

  constructor(private readonly onDone: () => void = () => undefined) {}

  /** Full-file total for a session, assembling the cached/queued pre-window scan with
   *  the fold bundle carried on the row. Enqueues the pre-window scan on first sight of
   *  a (base, ino) pair; returns `ready:false` until it lands. */
  sessionTotal(sessionId: string, path: string, fold: UsageFold, ino: number): UsageTotal {
    if (fold.base === 0) return combineUsage(fold, undefined); // exact, no scan
    const hit = this.preCache.get(sessionId);
    if (hit !== undefined && hit.base === fold.base && hit.ino === ino) {
      return combineUsage(fold, hit.pre); // ready when hit.pre defined, else "…"
    }
    // New session, or the window base / inode moved (an append slid the window, or a
    // rewrite) → (re)scan [0, base).
    const entry: PreEntry = { base: fold.base, ino };
    this.preCache.set(sessionId, entry);
    this.enqueue({
      sessionId,
      run: async () => {
        const acc = await scanUsageRangeStreamed(path, 0, fold.base);
        // Store only if this entry is still current (a later append may have superseded
        // it with a new base) — checked by identity.
        if (this.preCache.get(sessionId) === entry) {
          entry.pre = { usage: acc.total, lastMsgId: acc.lastMsgId, model: acc.model, mode: acc.mode };
        }
      },
    });
    return combineUsage(fold, undefined);
  }

  /** Full-file model + tokens for a SUBAGENT transcript, resolved LAZILY: the first
   *  render enqueues a whole-file scan; the cached result serves until the file's size
   *  changes (append/rewrite → rescan). Returns undefined ("…") until the scan lands.
   *  Subagent transcripts carry no permissionMode. */
  agentTotal(path: string): { usage: Usage; model?: string } | undefined {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return undefined;
    }
    const hit = this.agentCache.get(path);
    if (hit !== undefined && hit.size === size) return hit.result;
    const entry: AgentUsageEntry = { size };
    this.agentCache.set(path, entry);
    this.enqueue({
      run: async () => {
        const acc = await scanUsageRangeStreamed(path, 0, size);
        if (this.agentCache.get(path) === entry) entry.result = { usage: acc.total, model: acc.model };
      },
    });
    return undefined;
  }

  /** Drop cached AND still-queued pre-window scans for sessions no longer live (called
   *  from the provider's reload prune) — so a vanished session's big scan never runs.
   *  Agent entries are keyed by path and bounded by their own cap. */
  prune(liveSessionIds: Set<string>): void {
    for (const id of this.preCache.keys()) if (!liveSessionIds.has(id)) this.preCache.delete(id);
    // Purge queued session scans whose session has ended (identity-tagged jobs).
    this.queue = this.queue.filter((j) => j.sessionId === undefined || liveSessionIds.has(j.sessionId));
    if (this.agentCache.size > 2000) {
      const drop = this.agentCache.size >> 1;
      let i = 0;
      for (const k of this.agentCache.keys()) {
        this.agentCache.delete(k);
        if (++i >= drop) break;
      }
    }
  }

  private enqueue(job: ScanJob): void {
    this.queue.push(job);
    if (!this.draining) {
      this.draining = true;
      setImmediate(() => void this.drain());
    }
  }

  /** Run ONE queued scan (itself chunked+yielding), fire onDone, then yield and
   *  schedule the next — one file at a time, never blocking a tick. */
  private async drain(): Promise<void> {
    const job = this.queue.shift();
    if (job === undefined) {
      this.draining = false;
      return;
    }
    try {
      await job.run();
    } catch {
      // a scan never throws (the streamed scan swallows IO), but stay defensive
    }
    this.onDone();
    setImmediate(() => void this.drain());
  }

  /** Test-only: run all currently-queued scans to completion (awaits the async jobs,
   *  bypasses the setImmediate scheduling). Any jobs enqueued DURING the flush are
   *  also drained. */
  async __flush(): Promise<void> {
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (job !== undefined) {
        await job.run();
        this.onDone();
      }
    }
    this.draining = false;
  }
}
