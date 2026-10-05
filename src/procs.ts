// The single cross-platform seam for process introspection. Everything the
// discovery/cursor/codex/injector modules used to do by reading /proc directly
// funnels through here, so the rest of the codebase never touches a platform-
// specific path. Pure Node builtins (no vscode import) so it stays testable.
//
// Design contract for every helper: LINUX behaves exactly as the old inline
// /proc reads did (that is the shipping user base — it must not regress).
// Elsewhere (native macOS, native Windows) introspection that /proc alone can
// answer returns `undefined`/`[]` meaning UNKNOWN — callers MUST degrade, never
// exclude a session just because a value is unknown. The one thing that works
// everywhere is liveness: pidAlive falls back to a signal-0 probe off /proc.
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

const isLinux = process.platform === "linux";

/** One running process matched by argv0 basename, with its working directory. */
export interface LiveProc {
  pid: number;
  cwd: string;
  /** Set ONLY on the cursor-agent bucket: true when the process is a HEADLESS,
   *  machine-driven print run (`agent -p` / `--print` / `--output-format …`, e.g. the
   *  grok-4.5 CLI reviews an orchestrator spawns) rather than a user's interactive
   *  Cursor Agent TUI. Undefined for the codex bucket (which has its own provenance
   *  signal on disk). The cursor provenance classifier reads this to demote headless
   *  runs exactly as codex demotes `source:"exec"` rollouts. */
  headless?: boolean;
}

/** What process introspection this platform supports (read-only probe for the
 *  Setup Doctor). `procfs` true = full /proc reads (liveness, config-home
 *  auto-detect, terminal matching); false = signal-0 liveness only. */
export function procIntrospection(): { platform: NodeJS.Platform; procfs: boolean } {
  return { platform: process.platform, procfs: isLinux && existsSync("/proc") };
}

/** Is the process still alive? Works on every platform.
 *  - Linux: the presence of /proc/<pid> (identical to the old existsSync gate).
 *  - Elsewhere: a signal-0 probe. ESRCH => gone; EPERM => alive but not ours;
 *    any other error is treated as gone. */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (isLinux) return existsSync(`/proc/${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Kernel start-time (jiffies since boot, field 22 of /proc/<pid>/stat) used to
 *  detect pid reuse. Linux only; `undefined` everywhere else (and on any read
 *  error) — callers treat undefined as "reuse-check unavailable", not "dead". */
export function pidStartTime(pid: number): number | undefined {
  if (!isLinux) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // fields 1-2 are "pid (comm)"; comm may contain spaces and parens, so split
    // only after the final ")". starttime is field 22 => index 19 of the tail.
    const raw = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** The process's argv as a string array (splitting /proc/<pid>/cmdline on NUL,
 *  trailing empty dropped). Linux only; `undefined` elsewhere / on error. */
export function pidCmdline(pid: number): string[] | undefined {
  if (!isLinux) return undefined;
  try {
    const parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return parts;
  } catch {
    return undefined;
  }
}

/** Parent pid (field 4 of /proc/<pid>/stat). Linux only; `undefined` elsewhere /
 *  on error — ancestry-based features degrade to a no-op when it is undefined. */
export function pidPpid(pid: number): number | undefined {
  if (!isLinux) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isFinite(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/** Working directory of a process (readlink /proc/<pid>/cwd). Linux only. */
function pidCwd(pid: number): string | undefined {
  if (!isLinux) return undefined;
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

/** argv0 basename of a process (first NUL-separated cmdline token), or undefined
 *  when the read fails or the process has an empty cmdline (kernel threads).
 *  Identical to what homes/cursor/codex each derived inline before the census. */
function argv0Basename(pid: number): string | undefined {
  if (!isLinux) return undefined;
  try {
    const argv0 = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? "";
    return basename(argv0);
  } catch {
    return undefined;
  }
}

/** Raw environ blob (NUL-separated key=value) of a process, or undefined when the
 *  read fails (EACCES for other users' procs, or the proc exited mid-scan). Only
 *  read for claude-classified pids — homes.ts parses it for config-home detect. */
function pidEnviron(pid: number): string | undefined {
  if (!isLinux) return undefined;
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8");
  } catch {
    return undefined;
  }
}

// ---- unified /proc census --------------------------------------------------
// Three consumers used to sweep /proc independently on their own 30s TTLs —
// homes.ts (claude → config homes), cursor.ts (cursor-agent liveness), codex.ts
// (codex liveness) — each readdir("/proc") + a cmdline read per pid. The census
// does ONE pass: enumerate /proc once, read each pid's cmdline once, classify by
// argv0 basename, and take only the per-class follow-up read (environ for claude,
// cwd for cursor-agent/codex). One shared 30s TTL feeds all three adapters.

/** A claude process plus its raw environ blob (config-home detection input). */
export interface ClaudeProc {
  pid: number;
  environ: string;
}

/** One /proc pass, bucketed by argv0 basename. `listed` is false only when /proc
 *  itself could not be enumerated (non-Linux, or a transient readdir failure) — in
 *  that case every bucket is empty and each adapter degrades exactly as its old
 *  independent scanner did (homes keeps its last-good set; cursor/codex show []). */
export interface ProcCensus {
  listed: boolean;
  claude: ClaudeProc[];
  cursorAgent: LiveProc[];
  codex: LiveProc[];
}

/** The per-pid reads the classifier needs, injectable so the bucketing/attach
 *  logic is unit-testable without a real /proc. `listPids` returns null to signal
 *  "could not enumerate" (distinct from an empty process table). */
export interface CensusReaders {
  listPids: () => number[] | null;
  argv0Basename: (pid: number) => string | undefined;
  readEnviron: (pid: number) => string | undefined;
  readCwd: (pid: number) => string | undefined;
  /** Full argv of a process (see pidCmdline). Read only for cursor-agent-family pids
   *  — the flags there (`-p`/`--print`/`--output-format`) are the sole cheap signal
   *  that separates a headless machine run from a user's interactive TUI. */
  readCmdline: (pid: number) => string[] | undefined;
}

/** cursor-agent print/headless flags. Both `~/.local/bin/agent` and
 *  `~/.local/bin/cursor-agent` symlink the SAME binary, so the invoked basename does
 *  NOT distinguish headless from interactive — only these flags do. Verified on a
 *  live run: `agent -p --mode ask --model … --output-format text`. */
const HEADLESS_FLAGS = new Set(["-p", "--print", "--output-format"]);

/** Pure classifier: one pass over the pid list, bucketing by argv0 basename and
 *  attaching the single per-class follow-up read. Deterministic given its readers
 *  — the unit-test seam. Per-pid reads are guarded exactly as the old scanners:
 *  a missing argv0/environ/cwd drops that pid from its bucket (never the whole
 *  scan). This preserves each consumer's byte-identical liveness/home results. */
export function classifyProcs(readers: CensusReaders): ProcCensus {
  const pids = readers.listPids();
  if (pids === null) return { listed: false, claude: [], cursorAgent: [], codex: [] };
  const claude: ClaudeProc[] = [];
  const cursorAgent: LiveProc[] = [];
  const codex: LiveProc[] = [];
  for (const pid of pids) {
    const name = readers.argv0Basename(pid);
    if (name === undefined) continue;
    if (name === "claude") {
      const environ = readers.readEnviron(pid);
      if (environ === undefined) continue; // EACCES / exited → drop, as scanProcHomes did
      claude.push({ pid, environ });
    } else if (name === "cursor-agent" || name === "agent") {
      // The cursor-agent binary is reachable under two symlinked basenames
      // (`cursor-agent` and `agent`); a headless `agent -p` run therefore presents
      // argv0 basename `agent`, which the old `=== "cursor-agent"` gate missed
      // entirely (those runs never got a live pid → they aged out via the mtime
      // window and, worse, flipped to finished-unread with no window to open). Read
      // the full argv to (a) confirm the cursor-agent binary for the generic `agent`
      // basename — guarding an unrelated tool literally named `agent` — and (b)
      // detect the print/headless flags.
      const argv = readers.readCmdline(pid);
      // The generic `agent` basename MUST be confirmed as the cursor-agent binary
      // (its argv references the cursor-agent install path) — without that proof it
      // could be an unrelated tool named `agent`, so drop it. The `cursor-agent`
      // basename is self-evident: a missing cmdline there is non-fatal (keep it, as
      // before, with headless unknown → false) so liveness never regresses.
      if (name === "agent" && (argv === undefined || !argv.some((a) => a.includes("cursor-agent")))) continue;
      const cwd = readers.readCwd(pid);
      if (cwd === undefined) continue;
      cursorAgent.push({ pid, cwd, headless: argv !== undefined && argv.some((a) => HEADLESS_FLAGS.has(a)) });
    } else if (name === "codex") {
      const cwd = readers.readCwd(pid);
      if (cwd === undefined) continue;
      codex.push({ pid, cwd });
    }
  }
  return { listed: true, claude, cursorAgent, codex };
}

/** Real readers over /proc. `listPids` returns null on non-Linux (no cheap builtin
 *  enumeration) and on a readdir failure — callers degrade to their mtime windows. */
const realReaders: CensusReaders = {
  listPids: (): number[] | null => {
    if (!isLinux) return null;
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return null;
    }
    const out: number[] = [];
    for (const e of entries) if (/^\d+$/.test(e)) out.push(Number(e));
    return out;
  },
  argv0Basename,
  readEnviron: pidEnviron,
  readCwd: pidCwd,
  readCmdline: pidCmdline,
};

/** Walk the /proc parent chain from `startPid` up to `maxHops`, returning the first
 *  ancestor pid that is in `claudePids` (a live Claude Code process) — the session
 *  that spawned this run. Returns undefined when no claude ancestor is found, the
 *  chain ends (ppid 0/1/undefined), or /proc is unavailable (non-Linux → pidPpid
 *  returns undefined immediately). Bounded and cycle-safe. Shared by the codex and
 *  cursor provenance folders (both fold a machine-driven run under its father Claude
 *  session's row when a confident live ancestor is found). */
export function claudeAncestorPid(
  startPid: number,
  claudePids: Set<number>,
  maxHops = 12
): number | undefined {
  let pid: number | undefined = startPid;
  const seen = new Set<number>();
  for (let i = 0; i < maxHops && pid !== undefined && pid > 0 && !seen.has(pid); i++) {
    seen.add(pid);
    const parent = pidPpid(pid);
    if (parent === undefined || parent <= 1) return undefined;
    if (claudePids.has(parent)) return parent;
    pid = parent;
  }
  return undefined;
}

/** Match the three old scanners' shared 30s TTL — the set of running CLIs turns
 *  over slowly and reading every /proc entry each 3s tick is wasteful. */
const CENSUS_TTL_MS = 30_000;
let censusCache: ProcCensus | null = null;
let censusAt = 0;

/** The single /proc census, cached for {@link CENSUS_TTL_MS}. All three adapters
 *  (homes/cursor/codex) read this instead of sweeping /proc themselves.
 *
 *  Arming rule: cache a SUCCESSFUL enumeration, and also a non-Linux result (its
 *  emptiness is permanent, so there is nothing to retry). A *transient* Linux
 *  readdir failure (`listed:false` on Linux) is left un-armed so the next tick
 *  retries instead of latching an empty set for 30s — this is exactly the
 *  null-retry semantics homes.ts's scanProcHomes had, now shared by all three. */
export function procCensus(): ProcCensus {
  const now = Date.now();
  if (censusCache !== null && censusAt !== 0 && now - censusAt < CENSUS_TTL_MS) return censusCache;
  const c = classifyProcs(realReaders);
  if (c.listed || !isLinux) {
    censusCache = c;
    censusAt = now;
  }
  return c;
}

/** Age of the cached census in seconds (one shared probe), or undefined before the
 *  first census runs. Surfaced on the Setup Doctor's process-introspection line. */
export function procCensusAgeSec(): number | undefined {
  if (censusAt === 0) return undefined;
  return (Date.now() - censusAt) / 1000;
}

/** Test-only: drop the census cache so a test starts from a cold TTL. */
export function __resetCensusCache(): void {
  censusCache = null;
  censusAt = 0;
}

// ---- where a session process lives -------------------------------------------
// Sorts a live session into "editor" (an integrated terminal or extension of THIS
// editor family), "tmux", or "outside" (any other terminal, an app, a service), by
// walking its parent chain. "unknown" whenever the answer can't be proven — a
// process table that couldn't be read, a chain that breaks before its root, or a
// pid whose start time no longer matches — and an unknown row is never marked or
// moved.
//
// The chain comes from one process-table abstraction with three backends:
//  - Linux: /proc, read synchronously per pid (cheap, as before).
//  - macOS: one `ps` call for the whole table (pid, ppid, lstart, executable path).
//  - Windows: one `Get-CimInstance Win32_Process` query through powershell.exe.
// The macOS and Windows queries are spawned, so they are batched, never overlap,
// run only for pids not seen before, and a failed or slow query leaves the pid
// "unknown" (ProcTableService below).

/** One ancestor in a parent chain, nearest first. */
export interface ProcInfo {
  pid: number;
  /** Process name: kernel comm on Linux ("tmux: server"), the executable's base
   *  name without ".exe" on macOS and Windows. */
  comm: string;
  /** argv on Linux; elsewhere [executable path] (plus full argv when known). */
  argv: string[];
}

export type SessionLocation = "editor" | "tmux" | "outside" | "unknown";

/** How the session was started, for the move warning: by an app through the Agent
 *  SDK (entrypoint sdk-*), or by another agent (a claude/codex ancestor). */
export type SessionOwner = "sdk" | "agent" | undefined;

export interface LocationVerdict {
  location: SessionLocation;
  owner?: SessionOwner;
  /** For "outside": where it runs, in words ("a WSL shell", "an SSH session",
   *  "Windows Terminal"), from the nearest ancestor that is not a shell. */
  where?: string;
}

/** Base name of a program path, either separator, without a Windows ".exe". */
export function progName(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/\.exe$/i, "");
}

// Shells and launch wrappers sit between a session and the thing that hosts it;
// skip them when naming where the session runs. Interpreters (node, python) are
// not skipped: they name the program they run instead. Lower case, no ".exe".
const WRAPPERS = new Set([
  "bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "login", "sudo", "su",
  "env", "nohup", "script", "setsid", "timeout", "xargs", "direnv",
  "pwsh", "powershell", "cmd", "conhost", "openconsole", "wsl", "wslhost",
]);

// A login shell shows as "-zsh"; Windows names as "cmd.exe".
const isWrapper = (p: ProcInfo): boolean =>
  WRAPPERS.has(p.comm.toLowerCase().replace(/^-/, "")) ||
  WRAPPERS.has(progName(p.argv[0] ?? "").toLowerCase().replace(/^-/, ""));

/** Is this host WSL? (Only then is an init/Relay ancestor "a WSL shell".) */
function onWsl(): boolean {
  if (!isLinux) return false;
  if (process.env.WSL_DISTRO_NAME !== undefined) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** What a non-shell ancestor is, in words: an editor's terminal host, the script
 *  an interpreter runs, or the program's own name. */
function describeProc(p: ProcInfo): string {
  if (p.argv.some((a) => a === "--type=ptyHost")) {
    const server = /\/(\.[^/]*server[^/]*)\//.exec(p.argv.join(" ").replace(/\\/g, "/"))?.[1];
    return server !== undefined ? `a terminal of another editor (${server})` : "a terminal of another editor";
  }
  const exe = progName(p.argv[0] ?? "").toLowerCase();
  if (INTERPRETERS.has(exe) || INTERPRETERS.has(p.comm.toLowerCase())) {
    const script = p.argv.slice(1).find((a) => !a.startsWith("-"));
    if (script !== undefined) return script.replace(/\\/g, "/").split("/").pop() ?? script;
  }
  return p.comm !== "" ? p.comm : progName(p.argv[0] ?? "");
}

/** Process-tree roots and session hosts that are never the app that runs a session. */
function isSystemRoot(p: ProcInfo): boolean {
  const lower = p.comm.toLowerCase();
  return (
    lower === "init" || lower === "systemd" || lower === "launchd" || lower === "services" || lower === "svchost" ||
    lower.startsWith("sshd") || lower.startsWith("tmux") || lower === "screen" || p.comm.startsWith("Relay(") || p.comm === "SessionLeader"
  );
}

/** Name the host of an outside session from its chain (nearest first). Only what
 *  is known: WSL only on WSL, otherwise the parent program's name. */
export function whereLabel(chain: readonly ProcInfo[], owner: SessionOwner, wsl = onWsl()): string {
  if (owner === "agent") {
    const agent = chain.find(isAgentProc);
    if (agent !== undefined) return `another ${progName(agent.comm).toLowerCase() === "codex" ? "Codex" : "Claude Code"} session`;
  }
  if (owner === "sdk") {
    // The app is the nearest ancestor that is neither a shell nor the system
    // (a shell is not an app: "an app (bash)" said nothing true).
    const app = chain.find((p) => !isWrapper(p) && !isSystemRoot(p));
    return app !== undefined ? `an app (${describeProc(app)})` : "another program";
  }
  for (const p of chain) {
    if (isWrapper(p)) continue;
    const name = p.comm;
    const lower = name.toLowerCase();
    if (lower.startsWith("sshd")) return "an SSH session";
    if (wsl && (lower === "init" || name.startsWith("Relay(") || name === "SessionLeader")) return "a WSL shell";
    if (lower === "screen") return "screen";
    if (lower === "windowsterminal") return "Windows Terminal";
    if (lower === "systemd" || lower === "launchd" || lower === "services" || lower === "svchost") {
      return "a background service";
    }
    return describeProc(p);
  }
  return "a terminal";
}

const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3"]);

/** Is the session driven by a program rather than a person at a terminal? The
 *  Agent SDK runs the CLI with `--output-format stream-json`, `claude -p` prints
 *  one answer for a script; an sdk-* entrypoint says so directly. The entrypoint
 *  alone is not enough: an app may set CLAUDE_CODE_ENTRYPOINT to anything (Agent
 *  Workbench sets "claude-vscode"). */
export function programDriven(entrypoint: string | undefined, argv: readonly string[] | undefined): boolean {
  if (entrypoint?.startsWith("sdk") === true) return true;
  if (argv === undefined) return false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--print") return true;
    if (a === "--output-format=stream-json" || (a === "--output-format" && argv[i + 1] === "stream-json")) return true;
  }
  return false;
}

// Roots too broad to stand for one editor install (an extension host run by a
// system interpreter would otherwise make every process "the editor").
const BROAD_ROOTS = new Set(["", "/", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin", "/bin", "/opt", "/applications", "c:", "c:/windows", "c:/windows/system32", "c:/program files"]);

function installRoot(path: string): string | undefined {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p === "") return undefined;
  // Remote server: <home>/.cursor-server/bin/<hash>, …/.vscode-server/cli/servers/…:
  // every window of the family, any build, lives under the server dir.
  const server = /^(.*\/\.[^/]*server[^/]*)(\/|$)/.exec(p);
  if (server !== null) return server[1];
  // macOS: the outermost app bundle (/Applications/Cursor.app); helpers are nested
  // bundles inside it.
  const bundle = /^(.*?\.app)(\/|$)/i.exec(p);
  if (bundle !== null) return bundle[1];
  // Desktop appRoot: <install>/resources/app → <install>.
  const desktop = /^(.*)\/resources\/app$/i.exec(p);
  if (desktop !== null) return desktop[1];
  // An executable: its directory (C:/Users/u/AppData/Local/Programs/cursor).
  if (/\.exe$/i.test(p) || !/\.[^/]*$/.test(p.split("/").pop() ?? "")) {
    const dir = p.slice(0, p.lastIndexOf("/"));
    return BROAD_ROOTS.has(dir.toLowerCase()) ? undefined : dir;
  }
  return BROAD_ROOTS.has(p.toLowerCase()) ? undefined : p;
}

/** Install roots of the running editor family, from vscode.env.appRoot and the
 *  extension host's own executable (process.execPath): the remote server dir
 *  (~/.cursor-server), the macOS app bundle (/Applications/Cursor.app), or the
 *  install directory (/usr/share/code, …\Programs\cursor). A process whose
 *  executable lives under one of them is this editor: its terminal host, its
 *  extension host, or another window of the same editor. */
export function editorFamilyRoots(...paths: string[]): string[] {
  const out: string[] = [];
  const add = (path: string): void => {
    const root = installRoot(path);
    if (root !== undefined && !BROAD_ROOTS.has(root.toLowerCase()) && !out.includes(root)) out.push(root);
  };
  for (const path of paths) {
    add(path);
    // The OS reports a process's resolved executable path (CIM ExecutablePath,
    // /proc exe targets): an editor reached through a junction or symlink is
    // matched by its resolved install root too.
    const real = resolvedPath(path);
    if (real !== undefined && real !== path) add(real);
  }
  return out;
}

function resolvedPath(path: string): string | undefined {
  if (path === "") return undefined;
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

export function underRoot(path: string | undefined, roots: readonly string[]): boolean {
  if (path === undefined || path === "") return false;
  const p = path.replace(/\\/g, "/");
  return roots.some((r) => {
    // Windows paths compare case-insensitively.
    const ci = /^[a-z]:\//i.test(r);
    const a = ci ? p.toLowerCase() : p;
    const b = ci ? r.toLowerCase() : r;
    return a === b || a.startsWith(`${b}/`);
  });
}

// tmux is the one case that needs a program name: a tmux server is not part of
// the editor install, and it is not "outside" either. (No tmux on native Windows.)
function isTmuxServer(p: ProcInfo): boolean {
  return p.comm.startsWith("tmux") || progName(p.argv[0] ?? "").startsWith("tmux");
}

function isAgentProc(p: ProcInfo): boolean {
  const b = progName(p.argv[0] ?? "").toLowerCase();
  const c = progName(p.comm).toLowerCase();
  return b === "claude" || b === "codex" || c === "claude" || c === "codex";
}

/** Pure classifier over a parent chain (nearest ancestor first, the session's own
 *  process excluded). `chain` undefined, or `complete` false (the walk broke before
 *  its root), means unknown. The nearest decisive ancestor wins: a tmux server
 *  started from an editor terminal daemonizes, so a pane's chain meets tmux, never
 *  the editor. */
export function classifyLocation(input: {
  chain: ProcInfo[] | undefined;
  complete: boolean;
  entrypoint?: string;
  /** The session process's own argv (for the program-driven check). */
  argv?: readonly string[];
  familyRoots: readonly string[];
  /** Shell pids of this window's integrated terminals. */
  editorPids?: ReadonlySet<number>;
}): LocationVerdict {
  const { chain, complete, entrypoint, argv, familyRoots, editorPids } = input;
  // Ancestry decides, never the entrypoint alone: the Claude extension's own
  // sessions sit under this editor's extension host, and an app that sets
  // CLAUDE_CODE_ENTRYPOINT=claude-vscode (Agent Workbench does) does not.
  if (chain === undefined || !complete || familyRoots.length === 0) return { location: "unknown" };
  // Run by an app (Agent SDK, `claude -p`, the Claude desktop app): that is the
  // owner, even when the app's own executable is called "claude" (the desktop app
  // is claude.exe on Windows). Otherwise a claude/codex ancestor makes it agent-run.
  const desktop = entrypoint === "claude-desktop";
  let owner: SessionOwner = desktop || programDriven(entrypoint, argv) ? "sdk" : undefined;
  for (const p of chain) {
    if (editorPids?.has(p.pid) === true) return { location: "editor" };
    if (isTmuxServer(p)) return { location: "tmux" };
    if (underRoot(p.argv[0], familyRoots) || underRoot(p.argv[1], familyRoots)) return { location: "editor" };
    if (owner === undefined && isAgentProc(p)) owner = "agent";
  }
  const where = desktop ? "the Claude desktop app" : whereLabel(chain, owner);
  return owner === undefined ? { location: "outside", where } : { location: "outside", owner, where };
}

// ---- Linux backend (/proc) ---------------------------------------------------

/** /proc process state letter (field 3 of stat): "Z" = zombie. Linux only. */
export function pidState(pid: number): string | undefined {
  if (!isLinux) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return undefined;
  }
}

/** Is THIS process (pid + start time) still running? A zombie has exited (only its
 *  parent hasn't reaped it yet), and a different start time means the pid now
 *  belongs to someone else. `start` undefined skips the reuse check. Linux. */
export function procRunning(pid: number, start: number | undefined): boolean {
  if (!pidAlive(pid)) return false;
  if (pidState(pid) === "Z") return false;
  if (start !== undefined && pidStartTime(pid) !== start) return false;
  return true;
}

function pidComm(pid: number): string | undefined {
  if (!isLinux) return undefined;
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Parent chain of `pid` (nearest first, `pid` itself excluded). `complete` is true
 *  only when the walk reached init or a pid without a parent. Linux only. */
export function procAncestry(pid: number): { chain: ProcInfo[]; complete: boolean } | undefined {
  if (!isLinux) return undefined;
  const chain: ProcInfo[] = [];
  const seen = new Set<number>([pid]);
  let cur = pidPpid(pid);
  for (let hops = 0; hops < 64; hops++) {
    if (cur === undefined) return { chain, complete: false };
    if (cur <= 1 || seen.has(cur)) return { chain, complete: cur <= 1 };
    seen.add(cur);
    const comm = pidComm(cur);
    const argv = pidCmdline(cur);
    if (comm === undefined || argv === undefined) return { chain, complete: false };
    chain.push({ pid: cur, comm, argv });
    cur = pidPpid(cur);
  }
  return { chain, complete: false };
}

// ---- macOS and Windows backends (one spawned query per batch) ---------------

/** One row of a process table. `start` is comparable within one backend (Linux
 *  jiffies; macOS and Windows: wall-clock ms) and identifies the process together
 *  with its pid. `token` is the backend's raw start value (macOS: the lstart text,
 *  the same text Claude Code stores as procStart there). */
export interface ProcEntry {
  pid: number;
  ppid: number;
  start: number;
  token?: string;
  /** Full executable path; "" when the OS won't say (Windows access-denied rows). */
  exe: string;
  /** Image name ("Code Helper", "cmd.exe"). */
  name: string;
  argv?: string[];
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** `ps -o lstart` in the C locale and UTC ("Sat Oct  3 12:00:00 2026") → epoch ms. */
export function lstartToMs(text: string): number | undefined {
  const m = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(text.trim());
  if (m === null) return undefined;
  const month = MONTHS[m[1]];
  if (month === undefined) return undefined;
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

// pid, ppid, then lstart (always 24 chars in the C locale), then the executable
// path, which may contain spaces ("/Applications/Visual Studio Code.app/…").
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}) (.*)$/;

/** Parse `LC_ALL=C TZ=UTC ps -axww -o pid=,ppid=,lstart=,comm=`. Lines that don't
 *  parse (a localized date, a truncated line) are skipped; undefined when nothing
 *  parsed at all, which the caller treats as a failed query. */
export function parsePsTable(out: string): Map<number, ProcEntry> | undefined {
  const table = new Map<number, ProcEntry>();
  for (const line of out.split("\n")) {
    const m = PS_LINE.exec(line.replace(/\r$/, ""));
    if (m === null) continue;
    const start = lstartToMs(m[3]);
    if (start === undefined) continue;
    const exe = m[4].trim();
    table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), start, token: m[3], exe, name: progName(exe) });
  }
  return table.size > 0 ? table : undefined;
}

/** Parse `ps -ww -o pid=,args= -p …` into argv per pid (split on spaces: enough
 *  for the flag checks it feeds; an argument with spaces is split too). */
export function parsePsArgs(out: string): Map<number, string[]> {
  const argv = new Map<number, string[]>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+) (.*)$/.exec(line.replace(/\r$/, ""));
    if (m !== null) argv.set(Number(m[1]), m[2].trim().split(/\s+/));
  }
  return argv;
}

/** Split a Windows command line into argv (quotes group, backslash-quote escapes). */
export function splitWindowsCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === '"') {
      cur += '"';
      i++;
      any = true;
    } else if (c === '"') {
      quoted = !quoted;
      any = true;
    } else if (!quoted && (c === " " || c === "\t")) {
      if (any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += c;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}

const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;

/** FILETIME (100 ns ticks since 1601, as a decimal string) → epoch ms. */
export function filetimeToMs(ft: string): number | undefined {
  if (!/^\d{1,20}$/.test(ft)) return undefined;
  const ms = Number(BigInt(ft) / 10_000n) - FILETIME_EPOCH_OFFSET_MS;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** Parse the Win32_Process JSON from {@link winTableScript}: `p` pid, `pp` parent
 *  pid, `t` creation time (FILETIME string; the number would lose precision in
 *  JSON), `x` executable path (null when access is denied), `n` image name, `c`
 *  command line (only for the pids asked for). Rows without a creation time
 *  (System Idle Process) are dropped. Undefined on malformed output. */
export function parseCimTable(json: string): Map<number, ProcEntry> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json.replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
  const rows = Array.isArray(raw) ? raw : raw !== null && typeof raw === "object" ? [raw] : [];
  const table = new Map<number, ProcEntry>();
  for (const r of rows as Record<string, unknown>[]) {
    if (r === null || typeof r !== "object") continue;
    const pid = r.p;
    const ppid = r.pp;
    if (typeof pid !== "number" || typeof ppid !== "number" || typeof r.t !== "string") continue;
    const start = filetimeToMs(r.t);
    if (start === undefined) continue;
    const exe = typeof r.x === "string" ? r.x : "";
    const name = typeof r.n === "string" ? r.n : progName(exe);
    const entry: ProcEntry = { pid, ppid, start, token: r.t, exe, name };
    if (typeof r.c === "string" && r.c !== "") entry.argv = splitWindowsCommandLine(r.c);
    table.set(pid, entry);
  }
  return table.size > 0 ? table : undefined;
}

/** Windows system processes a session's ancestry may pass through, unreadable to
 *  a normal user (no ExecutablePath), as recorded on a real machine. */
const WINDOWS_ROOT_IMAGES = new Set([
  "system",
  "registry",
  "secure system",
  "smss.exe",
  "csrss.exe",
  "wininit.exe",
  "winlogon.exe",
  "services.exe",
  "lsass.exe",
  "svchost.exe",
  "dwm.exe",
  "fontdrvhost.exe",
  "sihost.exe",
  "userinit.exe",
]);

/** Walk a process table from `pid` (excluded) to its root. A parent counts only if
 *  it started no later than its child: on Windows a parent pid may name a dead
 *  process whose pid was reused. The walk ends at pid 0/1, a parent no longer in
 *  the table, or a reused parent pid — all legitimate roots on macOS and Windows. */
export function ancestryFromTable(
  table: ReadonlyMap<number, ProcEntry>,
  pid: number
): { self: ProcEntry; chain: ProcInfo[]; complete: boolean } | undefined {
  const self = table.get(pid);
  if (self === undefined) return undefined;
  const chain: ProcInfo[] = [];
  const seen = new Set<number>([pid]);
  let cur = self;
  for (let hops = 0; hops < 64; hops++) {
    const ppid = cur.ppid;
    if (ppid <= 0 || seen.has(ppid)) return { self, chain, complete: true };
    const parent = table.get(ppid);
    if (parent === undefined || parent.start > cur.start) return { self, chain, complete: true };
    seen.add(ppid);
    const exe = parent.exe !== "" ? parent.exe : parent.name;
    chain.push({ pid: parent.pid, comm: progName(exe), argv: parent.argv ?? [exe] });
    if (ppid === 1) return { self, chain, complete: true };
    // No executable path (access denied): Windows' own service and session
    // processes root every chain and are never an editor. Anything else may be
    // one (an elevated editor), so the walk can't decide: incomplete, "unknown".
    if (parent.exe === "") return { self, chain, complete: WINDOWS_ROOT_IMAGES.has(parent.name.toLowerCase()) };
    cur = parent;
  }
  return { self, chain, complete: false };
}

/** Runs a command and resolves its stdout, or undefined on any failure: spawn
 *  error, non-zero exit, timeout. Injectable for tests. */
export type QueryRunner = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string | undefined>;

export const runQuery: QueryRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
        (err, stdout) => resolve(err === null ? stdout : undefined)
      );
    } catch {
      resolve(undefined);
    }
  });

const PS_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: "C", TZ: "UTC" });
const PS_TIMEOUT_MS = 5_000;
// PowerShell's cold start alone can take seconds on a busy machine.
const PWSH_TIMEOUT_MS = 20_000;

/** The PowerShell for one Windows table read. Only integers are interpolated. */
export function winTableScript(wantArgv: readonly number[]): string {
  const want = wantArgv.filter((n) => Number.isInteger(n) && n > 0).join(",");
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    `$want = @(${want})`,
    "Get-CimInstance -ClassName Win32_Process | ForEach-Object {",
    "  $c = $null; if ($want -contains [int]$_.ProcessId) { $c = $_.CommandLine }",
    "  $t = $null; if ($_.CreationDate) { $t = [string]$_.CreationDate.ToFileTimeUtc() }",
    "  [pscustomobject]@{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; t = $t; x = $_.ExecutablePath; n = $_.Name; c = $c }",
    "} | ConvertTo-Json -Compress",
  ].join("\n");
}

/** Windows PowerShell by absolute path under %SystemRoot% (never a PATH lookup,
 *  which a folder earlier on PATH could shadow). Falls back to C:\Windows when
 *  SystemRoot is missing or not an absolute local path. */
export function powershellExe(env: NodeJS.ProcessEnv = process.env): string {
  return `${systemRoot(env)}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** %SystemRoot% when it is an absolute drive path, else C:\Windows. */
export function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "";
  return /^[A-Za-z]:\\[^"<>|?*\0]*$/.test(raw) ? raw.replace(/\\+$/, "") : "C:\\Windows";
}

const POWERSHELL = (): string => powershellExe();

/** powershell.exe argv for a script: no profile, no prompts, policy bypassed for
 *  this one command, the script passed encoded (no shell quoting involved). */
export function powershellArgs(script: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

export type TableBackend = "ps" | "cim";

/** Read the whole table once (plus argv for `wantArgv`). Undefined on failure. */
export async function readTable(
  backend: TableBackend,
  wantArgv: readonly number[],
  run: QueryRunner = runQuery
): Promise<Map<number, ProcEntry> | undefined> {
  if (backend === "cim") {
    const out = await run(POWERSHELL(), powershellArgs(winTableScript(wantArgv)), { timeoutMs: PWSH_TIMEOUT_MS });
    return out === undefined ? undefined : parseCimTable(out);
  }
  const out = await run("ps", ["-axww", "-o", "pid=,ppid=,lstart=,comm="], { env: PS_ENV(), timeoutMs: PS_TIMEOUT_MS });
  const table = out === undefined ? undefined : parsePsTable(out);
  if (table === undefined) return undefined;
  const pids = wantArgv.filter((n) => table.has(n));
  if (pids.length > 0) {
    const args = await run("ps", ["-ww", "-o", "pid=,args=", "-p", pids.join(",")], { env: PS_ENV(), timeoutMs: PS_TIMEOUT_MS });
    if (args !== undefined) {
      for (const [pid, argv] of parsePsArgs(args)) {
        const e = table.get(pid);
        if (e !== undefined) e.argv = argv;
      }
    }
  }
  return table;
}

/** A fresh read of one process's start, from the same source as the table (for
 *  the identity check right before a signal). Undefined when gone or unreadable. */
export async function readStart(backend: TableBackend, pid: number, run: QueryRunner = runQuery): Promise<number | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (backend === "cim") {
    const script = [
      "$ProgressPreference = 'SilentlyContinue'",
      `$p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${pid}"`,
      "if ($p -and $p.CreationDate) { [string]$p.CreationDate.ToFileTimeUtc() }",
    ].join("\n");
    const out = await run(POWERSHELL(), powershellArgs(script), { timeoutMs: PWSH_TIMEOUT_MS });
    return out === undefined ? undefined : filetimeToMs(out.trim());
  }
  const out = await run("ps", ["-o", "lstart=", "-p", String(pid)], { env: PS_ENV(), timeoutMs: PS_TIMEOUT_MS });
  return out === undefined ? undefined : lstartToMs(out.trim());
}

// ---- Windows: stop a session's process tree ----------------------------------

/** What a Windows stop will end, leaf first, or why it ends nothing. */
export type WindowsStopPlan = { kill: { pid: number; token: string }[] } | { refuse: string };

/** Plan the stop of `target` and its descendants from one Win32_Process table.
 *  A row is a child of its recorded parent only when that parent was not created
 *  after it: Windows keeps a dead parent's pid in the child's row, and a reused
 *  pid would otherwise adopt every orphan of the old process. Rows without a
 *  creation time never got this far (parseCimTable drops them); rows without an
 *  executable path (access denied) are planned by pid and start like the rest.
 *  Refused, ending nothing, when the tree reaches a protected pid (this extension
 *  host), one of its ancestors (the editor), one of the target's own ancestors,
 *  or a process installed under the editor's install roots. */
export function planWindowsStop(
  table: ReadonlyMap<number, ProcEntry>,
  target: number,
  guard: { protectedPids: readonly number[]; familyRoots?: readonly string[] }
): WindowsStopPlan {
  const root = table.get(target);
  if (root === undefined || root.token === undefined) return { refuse: "it is no longer running" };
  const children = new Map<number, ProcEntry[]>();
  for (const e of table.values()) {
    if (e.pid === e.ppid || e.pid <= 0) continue;
    const parent = table.get(e.ppid);
    if (parent === undefined || parent.start > e.start) continue;
    const list = children.get(parent.pid);
    if (list === undefined) children.set(parent.pid, [e]);
    else list.push(e);
  }
  const fenced = new Map<number, string>();
  for (const pid of guard.protectedPids) {
    if (!fenced.has(pid)) fenced.set(pid, "this editor");
    for (const a of ancestryFromTable(table, pid)?.chain ?? []) if (!fenced.has(a.pid)) fenced.set(a.pid, "this editor");
  }
  for (const a of ancestryFromTable(table, target)?.chain ?? []) if (!fenced.has(a.pid)) fenced.set(a.pid, "the process that started it");
  const order: ProcEntry[] = [];
  const seen = new Set<number>();
  const queue: ProcEntry[] = [root];
  while (queue.length > 0) {
    const e = queue.shift()!;
    if (seen.has(e.pid)) continue; // a cycle of stale parent pids
    seen.add(e.pid);
    const why = fenced.get(e.pid);
    if (why !== undefined) return { refuse: `its process tree includes ${why} (pid ${e.pid})` };
    if (e.pid !== target && guard.familyRoots !== undefined && underRoot(e.exe, guard.familyRoots)) {
      return { refuse: `its process tree includes an editor process (${e.name}, pid ${e.pid})` };
    }
    if (e.token === undefined) return { refuse: `SessionDeck could not read the start time of pid ${e.pid} in its tree` };
    order.push(e);
    for (const c of children.get(e.pid) ?? []) queue.push(c);
    if (order.length > 512) return { refuse: "its process tree is too large to stop safely" };
  }
  // Breadth-first puts every child after its parent: reversed, leaves go first.
  return { kill: order.reverse().map((e) => ({ pid: e.pid, token: e.token! })) };
}

/** The PowerShell behind a Windows stop, one process for the whole exchange:
 *  open a handle on the target (Windows can't reuse a pid while a handle is
 *  open), print its creation time and the Win32_Process table, read the plan
 *  ("pid:filetime,…", leaf first) from stdin, then for each entry re-check the
 *  creation time at microsecond resolution (the CIM table's own resolution)
 *  under a handle, end it, and print per-pid results. An empty plan ends
 *  nothing. Only the integer pid is interpolated. */
export function winStopScript(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("bad pid");
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "function Send($o) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress -Depth 4)); [Console]::Out.Flush() }",
    // Not "Ft": that is the built-in alias of Format-Table, and aliases win.
    "function Get-StartFt($proc) { [string]$proc.StartTime.ToFileTimeUtc() }",
    "function Get-Micro($ft) { [decimal]::Floor([decimal]$ft / 10) }",
    "try {",
    `  $target = [Diagnostics.Process]::GetProcessById(${pid})`,
    "  $null = $target.Handle",
    "  $tt = Get-StartFt $target",
    "} catch { Send @{ e = 'open'; m = [string]$_.Exception.Message }; exit 0 }",
    "$rows = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {",
    "  $t = $null; if ($_.CreationDate) { $t = [string]$_.CreationDate.ToFileTimeUtc() }",
    "  [pscustomobject]@{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; t = $t; x = $_.ExecutablePath; n = $_.Name }",
    "})",
    "Send @{ t = $tt; rows = $rows }",
    "$line = [Console]::In.ReadLine()",
    "if ([string]::IsNullOrWhiteSpace($line)) { exit 0 }",
    "$out = @()",
    "foreach ($pair in $line.Trim().Split(',')) {",
    "  $kv = $pair.Split(':'); $kp = [int]$kv[0]; $kt = $kv[1]; $q = $null; $r = 'gone'",
    "  try {",
    `    if ($kp -eq ${pid}) { $q = $target } else { $q = [Diagnostics.Process]::GetProcessById($kp); $null = $q.Handle }`,
    "    if ($q.HasExited) { $r = 'gone' }",
    "    elseif ((Get-Micro (Get-StartFt $q)) -ne (Get-Micro $kt)) { $r = 'changed' }",
    "    else { $q.Kill(); if ($q.WaitForExit(2000)) { $r = 'stopped' } else { $r = 'running' } }",
    "  } catch [System.ArgumentException] { $r = 'gone' }",
    "  catch { if ($q -ne $null -and $q.HasExited) { $r = 'stopped' } else { $r = 'denied' } }",
    "  $out += [pscustomobject]@{ p = $kp; r = $r }",
    "}",
    "Send @{ results = $out }",
  ].join("\n");
}

export interface WindowsStopResult {
  /** Nothing was stopped, and why (refused, or the target could not be held). */
  refused?: string;
  /** Per-pid outcome: stopped, gone (already), changed (pid reused), denied, or
   *  running (ended but still there after 2 s). `name`: its image name. */
  results: { pid: number; result: string; name?: string }[];
}

/** Spawns the stop script; injectable for tests. */
export type StopSpawner = (cmd: string, args: string[]) => {
  lines: AsyncIterator<string>;
  write(line: string): void;
  kill(): void;
};

const spawnStop: StopSpawner = (cmd, args) => {
  const child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  child.on("error", () => undefined);
  child.stdin.on("error", () => undefined);
  const rl = createInterface({ input: child.stdout });
  return {
    lines: rl[Symbol.asyncIterator](),
    write: (line) => void child.stdin.write(`${line}\n`),
    kill: () => {
      rl.close();
      child.stdin.end();
      if (child.exitCode === null) child.kill();
    },
  };
};

/** How long a Windows stop may take in all (PowerShell start, table, kills). */
export const WINDOWS_STOP_TIMEOUT_MS = 20_000;

/** Stop a Windows session process and its descendants (see planWindowsStop and
 *  winStopScript). `expectStart` is the verified start (epoch ms); a target
 *  whose creation time differs is not touched. */
export async function stopTreeWindows(
  pid: number,
  expectStart: number,
  guard: { protectedPids: readonly number[]; familyRoots?: readonly string[] },
  spawner: StopSpawner = spawnStop,
  timeoutMs = WINDOWS_STOP_TIMEOUT_MS
): Promise<WindowsStopResult> {
  let ch: ReturnType<StopSpawner>;
  try {
    ch = spawner(POWERSHELL(), powershellArgs(winStopScript(pid)));
  } catch {
    return { refused: "SessionDeck could not start PowerShell to stop it", results: [] };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const next = async (): Promise<Record<string, unknown> | undefined> => {
    const r = await Promise.race([ch.lines.next(), timeout]);
    if (r === undefined || r.done === true) return undefined;
    try {
      const v: unknown = JSON.parse(r.value.replace(/^\uFEFF/, ""));
      return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const head = await next();
    if (head === undefined) return { refused: "the stop did not answer in time", results: [] };
    if (head.e !== undefined || typeof head.t !== "string") {
      const m = typeof head.m === "string" && head.m.trim() !== "" ? ` (${head.m.trim().slice(0, 160)})` : typeof head.t !== "string" && head.e === undefined ? ` (unexpected answer: ${Object.keys(head).join(",").slice(0, 80)})` : "";
      return { refused: `it is no longer running, or SessionDeck may not stop it${m}`, results: [] };
    }
    if (filetimeToMs(head.t) !== expectStart) {
      ch.write("");
      return { refused: `pid ${pid} now belongs to a different process`, results: [] };
    }
    const table = parseCimTable(JSON.stringify(head.rows ?? []));
    const plan = table === undefined ? { refuse: "SessionDeck could not read the process table" } : planWindowsStop(table, pid, guard);
    if ("refuse" in plan) {
      ch.write("");
      return { refused: plan.refuse, results: [] };
    }
    ch.write(plan.kill.map((k) => `${k.pid}:${k.token}`).join(","));
    const tail = await next();
    const rows = Array.isArray(tail?.results) ? tail.results : tail?.results !== undefined ? [tail.results] : [];
    const results: { pid: number; result: string; name?: string }[] = [];
    for (const r of rows as Record<string, unknown>[]) {
      if (r !== null && typeof r === "object" && typeof r.p === "number" && typeof r.r === "string") {
        const name = table?.get(r.p)?.name;
        results.push(name !== undefined && name !== "" ? { pid: r.p, result: r.r, name } : { pid: r.p, result: r.r });
      }
    }
    return { results };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    ch.kill();
  }
}

export interface ResolvedProc {
  start: number;
  token?: string;
  chain: ProcInfo[];
  complete: boolean;
  argv?: string[];
  /** The process's own executable path ("" when the OS won't say). */
  exe?: string;
}

// After a failed query, wait this long before spawning another.
const RETRY_AFTER_MS = 60_000;
// A pid the table didn't contain (it exited) isn't asked for again for this long.
const MISSING_TTL_MS = 30_000;

/** The spawned-query process table: ancestry per pid is computed once and cached
 *  for the life of that process; only pids not seen before trigger a query; the
 *  queries are batched and never overlap; a failure leaves pids unresolved (the
 *  caller shows "unknown") and backs off before retrying. */
export class ProcTableService {
  private readonly resolved = new Map<number, ResolvedProc>();
  private readonly missing = new Map<number, number>();
  private readonly pending = new Set<number>();
  private inFlight: Promise<void> | undefined;
  private retryAt = 0;
  private readonly listeners = new Set<() => void>();
  /** Number of table queries started (for tests and diagnostics). */
  queries = 0;

  constructor(
    readonly backend: TableBackend,
    private readonly run: QueryRunner = runQuery,
    private readonly now: () => number = Date.now,
    private readonly alive: (pid: number) => boolean = pidAlive
  ) {}

  /** Called after a batch resolved new pids (the tree re-renders). */
  onUpdate(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Cached ancestry for a live pid, or undefined (then queued for the next batch). */
  peek(pid: number): ResolvedProc | undefined {
    const hit = this.resolved.get(pid);
    if (hit !== undefined) {
      if (this.alive(pid)) return hit;
      this.resolved.delete(pid);
      return undefined;
    }
    this.request(pid);
    return undefined;
  }

  /** Forget a pid (its start no longer matched): the next peek queries it again. */
  forget(pid: number): void {
    this.resolved.delete(pid);
  }

  /** Queue a pid and start a batch when none is running. */
  request(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0 || this.resolved.has(pid)) return;
    const gone = this.missing.get(pid);
    if (gone !== undefined && this.now() - gone < MISSING_TTL_MS) return;
    this.pending.add(pid);
    this.kick();
  }

  /** Resolve a pid now (queries if needed; waits for at most two batches). */
  async resolve(pid: number): Promise<ResolvedProc | undefined> {
    const hit = this.peek(pid);
    if (hit !== undefined) return hit;
    for (let i = 0; i < 2 && this.inFlight !== undefined; i++) {
      await this.inFlight;
      const r = this.resolved.get(pid);
      if (r !== undefined) return r;
      if (this.pending.has(pid)) this.kick();
    }
    return this.resolved.get(pid);
  }

  /** Wait for the running batch, if any (tests). */
  async settled(): Promise<void> {
    while (this.inFlight !== undefined) await this.inFlight;
  }

  private kick(): void {
    if (this.inFlight !== undefined || this.pending.size === 0 || this.now() < this.retryAt) return;
    const batch = [...this.pending];
    this.pending.clear();
    this.queries++;
    this.inFlight = this.runBatch(batch).finally(() => {
      this.inFlight = undefined;
      // Pids queued while this batch ran go in the next one.
      if (this.pending.size > 0) this.kick();
    });
  }

  private async runBatch(batch: number[]): Promise<void> {
    let table: Map<number, ProcEntry> | undefined;
    try {
      table = await readTable(this.backend, batch, this.run);
    } catch {
      table = undefined;
    }
    if (table === undefined) {
      // Failed or timed out: no guess. Back off, and keep the pids for the retry.
      this.retryAt = this.now() + RETRY_AFTER_MS;
      for (const pid of batch) this.pending.add(pid);
      return;
    }
    let changed = false;
    for (const pid of batch) {
      const a = ancestryFromTable(table, pid);
      if (a === undefined) {
        this.missing.set(pid, this.now());
        continue;
      }
      this.resolved.set(pid, {
        start: a.self.start,
        token: a.self.token,
        chain: a.chain,
        complete: a.complete,
        argv: a.self.argv,
        exe: a.self.exe,
      });
      changed = true;
    }
    if (this.resolved.size > 2000) this.resolved.clear();
    if (changed) for (const l of this.listeners) l();
  }
}

/** The platform this module serves, and its table service (macOS / Windows).
 *  Overridable for tests. */
const defaultTableService: ProcTableService | undefined =
  process.platform === "darwin" ? new ProcTableService("ps") : process.platform === "win32" ? new ProcTableService("cim") : undefined;
let hostPlatform: NodeJS.Platform = process.platform;
let tableService: ProcTableService | undefined = defaultTableService;

/** The macOS/Windows table service, or undefined on Linux (and other platforms). */
export function procTable(): ProcTableService | undefined {
  return tableService;
}

/** Test seam: pretend to run on `platform` with `service` as its table; with no
 *  arguments, back to the real platform and its real table. */
export function __setProcHost(platform: NodeJS.Platform = process.platform, service: ProcTableService | undefined = defaultTableService): void {
  hostPlatform = platform;
  tableService = service;
}

/** The platform the process table serves (the real one, or the test seam's). */
export function procHost(): NodeJS.Platform {
  return hostPlatform;
}

/** Can this platform tell where a session runs at all? */
export function locationSupported(): boolean {
  return hostPlatform === "linux" || tableService !== undefined;
}

// A process that started more than this after the session registered can't be
// the session's process: its pid was reused. (macOS lstart has 1 s resolution.)
const START_SLACK_MS = 5_000;

/** Where a live session process runs. `procStart` is the registry's start value:
 *  compared on Linux (/proc jiffies, verified) and macOS (Claude Code stores the
 *  same `LC_ALL=C TZ=UTC ps -o lstart` text), ignored on Windows, where the stored
 *  format is unverified. `startedAt` (registry, epoch ms) is the format-free reuse
 *  guard on macOS and Windows. Never blocks: on macOS/Windows an unseen pid is
 *  queued and reads "unknown" until its batch lands. */
export function sessionLocation(
  pid: number,
  procStart: string | number | undefined,
  entrypoint: string | undefined,
  familyRoots: readonly string[],
  ctx: { editorPids?: ReadonlySet<number>; startedAt?: number } = {}
): LocationVerdict {
  if (hostPlatform === "linux") {
    const start = pidStartTime(pid);
    if (start === undefined) return { location: "unknown" };
    if (procStart !== undefined && String(procStart) !== String(start)) return { location: "unknown" };
    const key = `${pid}:${start}`;
    let a = ancestryCache.get(key);
    if (a === undefined) {
      const fresh = procAncestry(pid);
      if (fresh === undefined || !fresh.complete) return { location: "unknown" }; // a race the next tick may win
      a = { chain: fresh.chain, complete: true, argv: pidCmdline(pid) };
      if (ancestryCache.size > 500) ancestryCache.clear();
      ancestryCache.set(key, a);
    }
    return classifyLocation({ chain: a.chain, complete: a.complete, entrypoint, argv: a.argv, familyRoots, editorPids: ctx.editorPids });
  }
  const svc = tableService;
  if (svc === undefined) return { location: "unknown" };
  const r = svc.peek(pid);
  if (r === undefined) return { location: "unknown" };
  if (typeof procStart === "string" && r.token !== undefined && registryStartAgrees(hostPlatform, procStart, r.token) === false) {
    svc.forget(pid);
    return { location: "unknown" };
  }
  if (ctx.startedAt !== undefined && ctx.startedAt > 0 && r.start > ctx.startedAt + START_SLACK_MS) {
    svc.forget(pid);
    return { location: "unknown" };
  }
  return classifyLocation({ chain: r.chain, complete: r.complete, entrypoint, argv: r.argv, familyRoots, editorPids: ctx.editorPids });
}

const ancestryCache = new Map<string, { chain: ProcInfo[]; complete: boolean; argv?: string[] }>();

/** Does the registry's procStart name the same process as our table's start
 *  token? macOS: Claude Code stores `LC_ALL=C TZ=UTC ps -o lstart=` text, our
 *  token is that same text. Windows: both are FILETIME (100 ns ticks); the CIM
 *  CreationDate carries microseconds only, so compare at microsecond resolution
 *  (observed: registry …113543, CIM …113540 for the same process). undefined when
 *  the value can't be compared (empty, or another platform). */
export function registryStartAgrees(platform: NodeJS.Platform, procStart: string, token: string): boolean | undefined {
  const p = procStart.trim();
  if (p === "") return undefined;
  if (platform === "darwin") return p === token.trim();
  if (platform === "win32") {
    if (!/^\d{1,20}$/.test(p) || !/^\d{1,20}$/.test(token)) return undefined;
    return BigInt(p) / 10n === BigInt(token) / 10n;
  }
  return undefined;
}

/** macOS / Windows: is the live process at `pid` provably not the one the
 *  registry entry was written for (the pid was reused after the session died
 *  without removing its file)? Two checks against the cached table row: the
 *  process started after the session registered (`startedAt`, format-free), or,
 *  on Windows, where the stored FILETIME was matched on a real machine, its
 *  procStart disagrees. On macOS a disagreeing procStart alone does not drop the
 *  row: that format is not yet confirmed on a real Mac (Diagnostics reports it),
 *  and a wrong guess would hide every session. False when it can't tell: Linux
 *  (the caller compares /proc), a row not cached yet (queued, so a later scan
 *  can), or nothing comparable. Never blocks. */
export function tableStartDisagrees(pid: number, procStart: string | undefined, startedAt?: number): boolean {
  if (hostPlatform === "linux") return false;
  const r = tableService?.peek(pid);
  if (r === undefined) return false;
  if (typeof startedAt === "number" && startedAt > 0 && r.start > startedAt + START_SLACK_MS) return true;
  if (hostPlatform !== "win32" || procStart === undefined || r.token === undefined) return false;
  return registryStartAgrees(hostPlatform, procStart, r.token) === false;
}

/** For Diagnostics: how many live registry entries' procStart match this OS's
 *  process table (Linux /proc jiffies, macOS lstart text, Windows FILETIME).
 *  `unchecked`: the pid's row could not be read or the value can't be compared.
 *  `noStart`: the entry records no start time at all. */
export async function procStartAgreement(
  entries: readonly { pid: number; procStart: string | undefined }[]
): Promise<{ matched: number; mismatched: number; unchecked: number; noStart: number }> {
  const out = { matched: 0, mismatched: 0, unchecked: 0, noStart: 0 };
  for (const e of entries.slice(0, 50)) {
    if (e.procStart === undefined) {
      out.noStart++;
      continue;
    }
    let agrees: boolean | undefined;
    if (hostPlatform === "linux") {
      const start = pidStartTime(e.pid);
      agrees = start === undefined ? undefined : String(start) === e.procStart.trim();
    } else {
      const token = (await tableService?.resolve(e.pid))?.token;
      agrees = token === undefined ? undefined : registryStartAgrees(hostPlatform, e.procStart, token);
    }
    if (agrees === true) out.matched++;
    else if (agrees === false) out.mismatched++;
    else out.unchecked++;
  }
  return out;
}

/** What it takes to start a process's program again: its start (to tie the
 *  facts to the verified process), executable path and argv. Linux: /proc;
 *  macOS / Windows: the process table (argv split on spaces on macOS). */
export async function processLaunchFacts(pid: number): Promise<{ start?: number; exe?: string; argv?: string[] } | undefined> {
  if (hostPlatform === "linux") {
    let exe: string | undefined;
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      exe = undefined;
    }
    return { start: pidStartTime(pid), exe, argv: pidCmdline(pid) };
  }
  const r = await tableService?.resolve(pid);
  return r === undefined ? undefined : { start: r.start, exe: r.exe, argv: r.argv };
}

/** Start time of a live pid from this platform's own table (Linux jiffies, else
 *  epoch ms), as recorded when its row was listed. Undefined when not known yet. */
export function processStartOf(pid: number): number | undefined {
  if (hostPlatform === "linux") return pidStartTime(pid);
  return tableService?.peek(pid)?.start;
}

/** A fresh read of a pid's start from the same source, right before a signal. */
export async function currentStartOf(pid: number): Promise<number | undefined> {
  if (hostPlatform === "linux") return pidStartTime(pid);
  if (tableService === undefined) return undefined;
  return readStart(tableService.backend, pid);
}

/** Parent chain of a pid on any supported platform (for terminal focus). */
export async function ancestryOfPid(pid: number): Promise<ProcInfo[] | undefined> {
  if (hostPlatform === "linux") return procAncestry(pid)?.chain;
  const r = await tableService?.resolve(pid);
  return r?.chain;
}

/** Is this process still running? Linux: pid + start + not a zombie. Elsewhere a
 *  cheap existence probe; identity is re-checked from the table before signals. */
export function processRunning(pid: number, start: number | undefined): boolean {
  if (hostPlatform === "linux") return procRunning(pid, start);
  return pidAlive(pid);
}

const openFileCache = new Map<string, boolean>();

/** Does process `pid` hold `path` open (a link in /proc/<pid>/fd)? A live Codex
 *  session keeps its rollout file open, which ties a pid to exactly one session
 *  where the cwd match can't (two sessions in one folder, or a resume from another
 *  folder). Cached per pid + start time; false off Linux or on any read error. */
export function pidHasOpen(pid: number, path: string, fresh = false): boolean {
  if (!isLinux) return false;
  const start = pidStartTime(pid);
  if (start === undefined) return false;
  const key = `${pid}:${start}:${path}`;
  const hit = openFileCache.get(key);
  // `fresh`: a process can close the file later; a decision to act re-reads.
  if (hit === true && !fresh) return true;
  if (fresh) openFileCache.delete(key);
  let found = false;
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`) === path) {
          found = true;
          break;
        }
      } catch {
        // fd closed mid-scan
      }
    }
  } catch {
    return false;
  }
  // Only a positive answer is stable for the life of the process.
  if (found) {
    if (openFileCache.size > 500) openFileCache.clear();
    openFileCache.set(key, true);
  }
  return found;
}

/** The live codex process holding `rolloutPath` open, if any (fresh /proc scan;
 *  used once after a move to confirm the resumed session started). Linux only. */
export function codexHolderPid(rolloutPath: string): number | undefined {
  const pids = realReaders.listPids();
  if (pids === null) return undefined;
  for (const pid of pids) {
    if (argv0Basename(pid) !== "codex") continue;
    if (pidHasOpen(pid, rolloutPath, true)) return pid;
  }
  return undefined;
}
