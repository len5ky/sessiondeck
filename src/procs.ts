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
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

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
