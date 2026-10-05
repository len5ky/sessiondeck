// Control plane: the only module that acts on another process. Three actions:
//  - focusLocalTerminal: reveal the integrated terminal hosting a session (by pid
//    ancestry), used by click-to-navigate.
//  - moveSession: bring a session that runs OUTSIDE the editor into it: confirm,
//    stop the outside process, wait for it to exit, then resume the same session
//    here (a Claude Code tab, or `claude --resume` / `codex resume` in a terminal).
//    It never resumes while the old process lives: two writers on one transcript
//    interleave, and the CLIs take no lock.
//  - stopSession: end a session's process after a modal confirmation, with the
//    same verified stop as the move (stopVerified) and no resume.
// The sequencing (moveFlow) and every decision (target, command, wording) are pure
// and injectable, so tests drive them with a virtual clock; the vscode wiring is
// the thin layer at the bottom.
import * as vscode from "vscode";
import { accessSync, constants as fsConstants, existsSync, linkSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir, hostname, uptime } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, win32 } from "node:path";
import {
  ancestryOfPid,
  codexHolderPid,
  pidAlive,
  currentStartOf,
  editorFamilyRoots,
  pidCmdline,
  pidHasOpen,
  stopTreeWindows,
  WINDOWS_STOP_TIMEOUT_MS,
  pidStartTime,
  processLaunchFacts,
  underRoot,
  processRunning,
  processStartOf,
  procHost,
  procTable,
  ProcInfo,
  registryStartAgrees,
  SessionOwner,
} from "./procs";

/** Focus (reveal) the integrated-terminal tab whose shell is the session pid or
 *  one of its ancestors, when that terminal lives in THIS window, in the panel or
 *  the editor area (a moved session's). Works wherever the process table does
 *  (Linux /proc, macOS ps, Windows CIM). Returns false when no local terminal
 *  matches, so the caller can relay or fall back. */
export async function focusLocalTerminal(
  sessionPid: number,
  terminals: readonly vscode.Terminal[] = vscode.window.terminals,
  ancestry: (pid: number) => Promise<ProcInfo[] | undefined> = ancestryOfPid
): Promise<boolean> {
  if (terminals.length === 0) return false;
  const chain = await ancestry(sessionPid);
  if (chain === undefined) return false;
  const pids = new Set<number>([sessionPid, ...chain.map((p) => p.pid)]);
  for (const terminal of terminals) {
    const shellPid = await terminal.processId;
    if (shellPid === undefined || !pids.has(shellPid)) continue;
    terminal.show();
    return true;
  }
  return false;
}

// ---- move: pure decisions ----------------------------------------------------

export const CLAUDE_EXTENSION_ID = "anthropic.claude-code";
/** Undocumented but stable command of anthropic.claude-code: (sessionId?, …). With
 *  a sessionId it reveals that session's tab, or opens one resuming it. */
export const CLAUDE_OPEN_COMMAND = "claude-vscode.editor.open";

export type MoveSetting = "auto" | "claudeTab" | "terminal";
export type MoveTarget = "claudeTab" | "terminal";
export type MoveTool = "claude" | "codex";

export function readMoveSetting(raw: unknown): MoveSetting {
  return raw === "claudeTab" || raw === "terminal" ? raw : "auto";
}

/** Where a moved session lands. A Claude tab needs the Claude Code extension and
 *  a Claude session; `auto` also wants the session in this window's folder and the
 *  default config home (the extension only lists sessions it can see). Codex and
 *  every other case resume in a terminal. */
export function chooseMoveTarget(input: {
  setting: MoveSetting;
  tool: MoveTool;
  claudeExtension: boolean;
  inThisWindow: boolean;
  defaultHome: boolean;
}): MoveTarget {
  if (input.tool !== "claude" || !input.claudeExtension) return "terminal";
  if (input.setting === "claudeTab") return "claudeTab";
  if (input.setting === "terminal") return "terminal";
  return input.inThisWindow && input.defaultHome ? "claudeTab" : "terminal";
}

// Ids go into a shell line, so they must be plain: Claude ids are UUIDs, Codex ids
// are UUID-like thread ids. Anything else is refused rather than quoted.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;

/** The shell line that resumes a session, or undefined for an unsafe id. */
export function resumeCommand(tool: MoveTool, id: string): string | undefined {
  if (!SAFE_ID.test(id)) return undefined;
  return tool === "claude" ? `claude --resume ${id}` : `codex resume ${id}`;
}

/** The arguments after the program that resume a session (id allow-listed). */
export function resumeArgs(tool: MoveTool, id: string): string[] {
  return tool === "claude" ? ["--resume", id] : ["resume", id];
}

/** The exact program that runs a CLI: an absolute executable, plus the leading
 *  arguments it needs (a runtime's options and script) before the CLI's own. */
export interface LaunchSpec {
  exe: string;
  args: string[];
}

/** Find `tool` on a PATH (`env.PATH`), as an absolute executable. Windows takes
 *  only a .exe (a .cmd shim can't be a terminal's own process). Undefined when
 *  not found. */
export function pathLaunch(
  tool: MoveTool,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isFile: (p: string) => boolean = (x) => executableFile(x, platform)
): LaunchSpec | undefined {
  const p = platform === "win32" ? win32 : posix;
  const raw = env.PATH ?? env.Path ?? "";
  for (const dir of raw.split(platform === "win32" ? ";" : ":")) {
    if (dir === "" || !p.isAbsolute(dir)) continue;
    const exe = p.join(dir, platform === "win32" ? `${tool}.exe` : tool);
    if (isFile(exe)) return { exe, args: [] };
  }
  return undefined;
}

/** The file the bare command name `tool` resolves to on PATH, as a shell would
 *  find it, or undefined. On Windows any PATHEXT extension counts (an npm
 *  install is `claude.cmd`). For the command shown to the user, not for launching. */
export function resolveOnPath(
  tool: MoveTool,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isFile: (p: string) => boolean = (x) => executableFile(x, platform)
): string | undefined {
  const p = platform === "win32" ? win32 : posix;
  const raw = env.PATH ?? env.Path ?? "";
  const exts = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "") : [""];
  for (const dir of raw.split(platform === "win32" ? ";" : ":")) {
    if (dir === "" || !p.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const f = p.join(dir, `${tool}${ext.toLowerCase()}`);
      if (isFile(f)) return f;
    }
  }
  return undefined;
}

/** Are two paths the same file once symlinks are resolved? false when either
 *  can't be resolved. */
export function sameFile(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const ra = realpathSync(a);
    const rb = realpathSync(b);
    return platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch {
    return false;
  }
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Are both paths versions inside one Claude Code native install, i.e. files in
 *  the same `…/claude/versions` directory? */
export function sameClaudeInstall(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === "win32" ? win32 : posix;
  const dir = p.dirname(a);
  if (!/[\\/]claude[\\/]versions$/i.test(dir)) return false;
  const other = p.dirname(b);
  return platform === "win32" ? dir.toLowerCase() === other.toLowerCase() : dir === other;
}

/** Runtimes a CLI may run under as a script (npm installs). */
const RUNTIMES = new Set(["node", "nodejs", "bun"]);

/** Runtime options carried over, only in their self-contained form: they tune
 *  memory or diagnostics output, load no code and take no separate value. Any
 *  other option (--require, --import, --loader, --inspect*, -e, -p, a flag with
 *  a separate value…) makes the capture fail: guessing could start the wrong
 *  program after the session was already stopped. */
const RUNTIME_OPTIONS = [
  /^--max-old-space-size=\d+$/,
  /^--max-semi-space-size=\d+$/,
  /^--stack-size=\d+$/,
  /^--no-warnings$/,
  /^--no-deprecation$/,
  /^--enable-source-maps$/,
];

/** Is `exe` the CLI's own native binary? Claude Code's native installer runs
 *  `…/claude/versions/<version>`; elsewhere it is `claude`. Codex's npm package
 *  runs a platform binary such as `codex-x86_64-unknown-linux-musl`. */
function isNativeCli(tool: MoveTool, exe: string, platform: NodeJS.Platform): boolean {
  const p = platform === "win32" ? win32 : posix;
  const name = p.basename(exe).toLowerCase().replace(/\.exe$/, "");
  if (tool === "claude") return name === "claude" || /[\\/]claude[\\/]versions[\\/][^\\/]+$/.test(exe);
  return /^codex(-[a-z0-9_]+)*$/.test(name);
}

/** Is `script` the CLI's npm entry point (Claude Code's cli.js, Codex's bin script)? */
function isCliEntry(tool: MoveTool, script: string): boolean {
  const n = script.replace(/\\/g, "/").toLowerCase();
  return tool === "claude" ? /\/@anthropic-ai\/claude-code\/cli\.m?js$/.test(n) : /\/@openai\/codex\/bin\/codex\.m?js$/.test(n);
}

/** Linux names a running program whose file was replaced or removed (a Claude
 *  Code self-update removes the old version) "<path> (deleted)". */
export function withoutDeleted(exe: string): string {
  return exe.endsWith(" (deleted)") ? exe.slice(0, -" (deleted)".length) : exe;
}

/** The script a runtime runs, resolved through symlinks (an npm-installed CLI
 *  is started through its bin symlink); the path itself when it can't be. */
function realScript(script: string): string {
  try {
    return realpathSync(script);
  } catch {
    return script;
  }
}

/** Is this process the Claude Code or Codex program? For the identity check
 *  only: the same recognition as launchFromProcess (native binary by name or
 *  versions path; under a runtime, only the allowed options, then the CLI's
 *  entry point), but the program file need not exist any more: a session keeps
 *  running after an update removed its binary. Never used to start anything. */
export function isCliProcess(
  tool: MoveTool,
  facts: { exe?: string; argv?: readonly string[] },
  platform: NodeJS.Platform = process.platform,
  real: (p: string) => string = realScript
): boolean {
  const p = platform === "win32" ? win32 : posix;
  const exe = facts.exe === undefined ? undefined : withoutDeleted(facts.exe);
  if (exe === undefined || exe === "" || !p.isAbsolute(exe)) return false;
  const name = p.basename(exe).toLowerCase().replace(/\.exe$/, "");
  if (!RUNTIMES.has(name)) return isNativeCli(tool, exe, platform);
  const rest = (facts.argv ?? []).slice(1);
  let i = 0;
  for (; i < rest.length && rest[i].startsWith("-"); i++) {
    if (!RUNTIME_OPTIONS.some((re) => re.test(rest[i]))) return false;
  }
  if (i >= rest.length) return false;
  const last = platform === "darwin" ? Math.min(rest.length - 1, i + 8) : i;
  for (let j = last; j >= i; j--) {
    const script = rest.slice(i, j + 1).join(" ");
    if (p.isAbsolute(script) && (isCliEntry(tool, script) || isCliEntry(tool, real(script)))) return true;
  }
  return false;
}

/** The exact program a running CLI process can be started again with, from its
 *  executable path and argv. Strict: a native binary must be the CLI itself;
 *  under a runtime, every option before the script must be on RUNTIME_OPTIONS
 *  and the script must be the CLI's own entry point, identified by what it is,
 *  not by its position. Paths must be absolute and exist. macOS argv comes from
 *  `ps` split on spaces, so there the longest re-joined path that is the entry
 *  point wins. Undefined when any of this fails (the caller falls back to PATH). */
export function launchFromProcess(
  tool: MoveTool,
  facts: { exe?: string; argv?: readonly string[] },
  platform: NodeJS.Platform = process.platform,
  isFile: (p: string) => boolean = fileExists,
  isExec: (p: string) => boolean = isFile
): LaunchSpec | undefined {
  const p = platform === "win32" ? win32 : posix;
  const exe = facts.exe;
  if (exe === undefined || exe === "" || !p.isAbsolute(exe) || !isExec(exe)) return undefined;
  const name = p.basename(exe).toLowerCase().replace(/\.exe$/, "");
  if (!RUNTIMES.has(name)) return isNativeCli(tool, exe, platform) ? { exe, args: [] } : undefined;
  const rest = (facts.argv ?? []).slice(1);
  const options: string[] = [];
  let i = 0;
  for (; i < rest.length && rest[i].startsWith("-"); i++) {
    if (!RUNTIME_OPTIONS.some((re) => re.test(rest[i]))) return undefined;
    options.push(rest[i]);
  }
  if (i >= rest.length) return undefined;
  const last = platform === "darwin" ? Math.min(rest.length - 1, i + 8) : i;
  for (let j = last; j >= i; j--) {
    const script = rest.slice(i, j + 1).join(" ");
    if (p.isAbsolute(script) && (isCliEntry(tool, script) || isCliEntry(tool, realScript(script))) && isFile(script)) return { exe, args: [...options, script] };
  }
  return undefined;
}

/** Options a resume does not restore by itself (Claude restores the model and
 *  permission mode; these it doesn't), as they appear on a command line. */
const NOT_CARRIED: Record<MoveTool, readonly string[]> = {
  claude: [
    "--add-dir", "--mcp-config", "--strict-mcp-config", "--settings", "--append-system-prompt", "--system-prompt",
    "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--plugin-dir", "--agents",
  ],
  codex: [
    "--profile", "-p", "--config", "-c", "--add-dir", "--sandbox", "-s", "--ask-for-approval", "-a",
    "--full-auto", "--dangerously-bypass-approvals-and-sandbox",
  ],
};

/** Which of NOT_CARRIED the old process was started with (in order, once each). */
export function droppedOptions(tool: MoveTool, argv: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const a of (argv ?? []).slice(1)) {
    const flag = a.startsWith("--") ? a.split("=")[0] : a;
    if (NOT_CARRIED[tool].includes(flag) && !out.includes(flag)) out.push(flag);
  }
  return out;
}

/** Capture, before anything is stopped, the program the session's process runs
 *  and the options it had that the resume won't carry, tied to the verified
 *  process by its start time. Empty when it can't be. */
export async function captureProcess(s: MoveSubject): Promise<{ launch?: LaunchSpec; dropped: string[] }> {
  if (s.start === undefined) return { dropped: [] };
  const facts = await processLaunchFacts(s.pid);
  if (facts === undefined || facts.start !== s.start) return { dropped: [] };
  const platform = procHost();
  return {
    launch: launchFromProcess(s.tool, facts, platform, fileExists, (x) => executableFile(x, platform)),
    dropped: droppedOptions(s.tool, facts.argv),
  };
}

export async function captureLaunch(s: MoveSubject): Promise<LaunchSpec | undefined> {
  return (await captureProcess(s)).launch;
}

/** A regular file this user may execute (X_OK; Windows has no execute bit). */
export function executableFile(p: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform !== "win32") accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The Codex home a rollout belongs to: <home>/sessions/YYYY/MM/DD/rollout-….jsonl. */
export function codexHomeOf(rolloutPath: string): string | undefined {
  const day = dirname(rolloutPath);
  const sessions = dirname(dirname(dirname(day)));
  return sessions.endsWith("/sessions") || sessions.endsWith("\\sessions") ? dirname(sessions) : undefined;
}

/** Do `a` and `b` name the same directory? Separators, trailing separators and
 *  `.`/`..` are normalised for the platform; Windows compares without case (its
 *  file system ignores case, and a drive letter may come either way). When the
 *  default home is reached through a symlink or junction, homes.ts hands over
 *  its realpath, so `b`'s realpath counts too. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === "win32" ? win32 : posix;
  const norm = (v: string): string => {
    const r = p.resolve(v);
    return platform === "win32" ? r.toLowerCase() : r;
  };
  const target = norm(a);
  if (target === norm(b)) return true;
  if (platform !== process.platform) return false;
  try {
    return target === norm(realpathSync(b));
  } catch {
    return false;
  }
}

/** Is `dir` the default Claude config home (no CLAUDE_CONFIG_DIR needed)? */
export function isDefaultClaudeHome(dir: string, home = homedir(), platform: NodeJS.Platform = process.platform): boolean {
  return samePath(dir, (platform === "win32" ? win32 : posix).join(home, ".claude"), platform);
}

/** Is `dir` the default Codex home (no CODEX_HOME needed)? */
export function isDefaultCodexHome(dir: string, home = homedir(), platform: NodeJS.Platform = process.platform): boolean {
  return samePath(dir, (platform === "win32" ? win32 : posix).join(home, ".codex"), platform);
}

/** Why the session lands where it does, when that isn't what the user would
 *  expect: a Claude tab asked for but impossible, or a terminal in a folder this
 *  window doesn't have open. Undefined when there is nothing to explain. */
export function moveTargetNote(input: {
  setting: MoveSetting;
  tool: MoveTool;
  claudeExtension: boolean;
  inThisWindow: boolean;
  cwd: string;
  target: MoveTarget;
}): string | undefined {
  if (input.target !== "terminal") return undefined;
  const parts: string[] = [];
  if (input.tool === "claude" && input.setting === "claudeTab" && !input.claudeExtension) {
    parts.push("The Claude Code extension isn't installed, so it opens in a terminal instead of a Claude tab.");
  }
  if (!input.inThisWindow) parts.push(`Its folder, ${input.cwd}, isn't open in this window, so the terminal opens in that folder.`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export interface MoveSubject {
  tool: MoveTool;
  /** Session / thread id passed to the resume command. */
  id: string;
  title: string;
  cwd: string;
  pid: number;
  /** Start time of the outside process as VERIFIED when the row was offered for a
   *  move (registry procStart == the live process's start). Undefined = could not
   *  be verified: the move is refused. Re-checked before every signal. */
  start: number | undefined;
  /** Mid-turn: stopping cuts the current turn off. */
  working: boolean;
  /** Between turns with a background task running (registry status "shell"). */
  background?: boolean;
  owner: SessionOwner;
  /** Short description of where it runs now ("a WSL shell", "tmux", "sshd"…). */
  where: string;
  /** Claude config home the session lives in (CLAUDE_CONFIG_DIR for the resume). */
  homeDir?: string;
  /** Codex home the rollout lives in (CODEX_HOME for the resume). */
  codexHome?: string;
  /** Codex rollout file the process must hold open. */
  rolloutPath?: string;
  /** The program that resumes it (see LaunchSpec); undefined = not found. */
  launch?: LaunchSpec;
  /** Where it lands and why, when that needs saying (moveTargetNote). */
  targetNote?: string;
  /** Options the old process had that the resume won't carry (droppedOptions). */
  droppedOptions?: string[];
  /** Runs in a Claude Code tab in the editor (Stop Session says what that means). */
  claudeTab?: boolean;
}

const TARGET_LABEL: Record<MoveTarget, string> = {
  claudeTab: "a Claude Code tab",
  terminal: "a terminal in this window",
};

/** The Windows line of a stop or move confirmation. Some programs the session
 *  started may survive (access denied); they are named after the stop. */
export const WINDOWS_STOP_NOTE =
  "Windows can't ask a terminal program to stop, so it and the programs it started are ended right away, without a chance to save. If any of those programs can't be ended, SessionDeck names them afterwards.";

/** The modal confirmation: message (the question) and detail (the consequences). */
export function moveConfirmText(s: MoveSubject, target: MoveTarget, forced = false): { message: string; detail: string } {
  const lines = [
    `It runs outside the editor, in ${s.where}, as pid ${s.pid}. SessionDeck will stop that process and resume the session in ${TARGET_LABEL[target]}.`,
  ];
  if (s.targetNote !== undefined) lines.push(s.targetNote);
  if (s.droppedOptions !== undefined && s.droppedOptions.length > 0) {
    lines.push(`These options are not carried over: ${s.droppedOptions.join(", ")}.`);
  }
  if (forced) {
    lines.push(WINDOWS_STOP_NOTE);
  }
  if (s.owner === "sdk") {
    lines.push(
      "Another app runs this session. That app may start it again the next time a message is sent there, and then two programs would write to the same session. Close or stop it in that app first."
    );
  }
  if (s.owner === "agent") {
    lines.push(
      "Another agent started this session and may start it again, and then two programs would write to the same session. Stop it there first."
    );
  }
  if (s.working) lines.push("It is in the middle of a turn. That turn will be cut off.");
  else if (s.background === true) lines.push("It has a background task running, which may be stopped too.");
  return { message: `Move "${s.title}" into the editor?`, detail: lines.join("\n\n") };
}

// ---- move: sequencing --------------------------------------------------------

export const STOP_WAIT_MS = 5_000;
export const KILL_WAIT_MS = 2_000;
/** How long to look for the resumed session before saying so. */
export const START_WAIT_MS = 20_000;
const POLL_MS = 100;
const START_POLL_MS = 500;

export interface MoveDeps {
  /** Modal confirmation; true to go ahead. `cancelDefault`: the safe choice
   *  (leave it running) is the default button, the one Enter presses. */
  confirm(message: string, detail: string, action: string, cancelDefault?: boolean): Promise<boolean>;
  /** Is the outside process still running? (Polled while waiting for it to exit.) */
  running(): boolean;
  /** Re-verify that the pid is still the session's process (registry entry, start
   *  time, namespace…). A string names what no longer matches. Called after the
   *  confirmation and before every signal. */
  identity(): Promise<string | undefined>;
  /** Send the stop and wait for the request itself to finish (on Windows the
   *  whole tree stop). Resolves a reason when the stop was refused or failed. */
  signal(sig: "SIGTERM" | "SIGKILL"): Promise<string | undefined>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Start the session in the target; throws on failure. */
  resume(): Promise<void>;
  /** Is the resumed session running: a process for it that started at or after
   *  `sinceMs` (the stop), so a leftover record can't count? */
  started(sinceMs: number): Promise<boolean>;
  error(message: string): void;
  /** A non-error note (the resume could not be confirmed). */
  notice(message: string): void;
  /** Plain information (a stale offer: nothing went wrong). */
  info?(message: string): void;
  /** Windows: processes the session started that the stop could not end. */
  leftover?(): LeftoverProc[];
  /** The resume's terminal has already closed: why ("…closed (exit code 1)"). */
  resumeEnded?(): string | undefined;
  /** The resumed CLI is running as its terminal's own process. */
  resumeAlive?(): boolean;
}

export interface LeftoverProc {
  pid: number;
  name: string;
}

/** The note naming processes the session started that are still running after
 *  the stop. The move goes on: the session process itself is gone. */
export function leftoverNotice(title: string, procs: readonly LeftoverProc[]): string {
  const shown = procs.slice(0, 5).map((p) => `${p.name} (pid ${p.pid})`);
  const more = procs.length > 5 ? `, and ${procs.length - 5} more` : "";
  const these = procs.length === 1 ? "This program it started is" : "These programs it started are";
  return `"${title}" was stopped. ${these} still running: ${shown.join(", ")}${more}. End them yourself if you don't need them.`;
}

export type MoveOutcome = "cancelled" | "gone" | "changed" | "resumed" | "unconfirmed" | "still-running" | "resume-failed";

/** The exact shell line that brings the session back by hand, with the home it
 *  lives in: POSIX sh/zsh form, or PowerShell (VS Code's default shell there) on
 *  Windows. The folder is named separately. The resume itself needs none of this:
 *  the terminal gets cwd and env as options and the command has no quotable
 *  characters (ids are allow-listed). */
export function recoveryCommand(
  s: MoveSubject,
  platform: NodeJS.Platform = process.platform,
  onPath: (tool: MoveTool) => string | undefined = (tool) => resolveOnPath(tool, process.env, platform),
  same: (a: string, b: string) => boolean = (a, b) => sameFile(a, b, platform),
  real: (p: string) => string = realOrSelf
): string | undefined {
  let cmd = resumeCommand(s.tool, s.id);
  if (cmd === undefined) return undefined;
  // The plain name when it resolves on PATH to the very program that ran the
  // session (its script, for a runtime-run install): a captured path such as
  // ~/.local/share/claude/versions/2.1.288 stops working once the CLI updates
  // itself, while ~/.local/bin/claude follows it. Otherwise the exact program
  // that ran it, by absolute path, since another `claude` on PATH might not be
  // the same CLI (and Windows editors' terminals often lack it). The launch
  // itself always uses the captured program.
  const found = s.launch !== undefined ? onPath(s.tool) : undefined;
  const ran = s.launch !== undefined ? (s.launch.args.length > 0 ? s.launch.args[s.launch.args.length - 1] : s.launch.exe) : undefined;
  // Two versions of one Claude install count as the same program: the CLI updated
  // itself since the session started, so `claude` now runs the newer version
  // beside the one captured (…/claude/versions/2.1.289 next to 2.1.288).
  const plain =
    found !== undefined &&
    ran !== undefined &&
    (same(found, ran) || (s.tool === "claude" && sameClaudeInstall(real(found), real(ran), platform)));
  if (s.launch !== undefined && !plain) {
    const tail = resumeArgs(s.tool, s.id).join(" ");
    cmd =
      platform === "win32"
        ? `& ${[s.launch.exe, ...s.launch.args].map(psQuote).join(" ")} ${tail}`
        : `${[s.launch.exe, ...s.launch.args].map(shellQuote).join(" ")} ${tail}`;
  }
  let env: [string, string] | undefined;
  if (s.tool === "claude" && s.homeDir !== undefined && !isDefaultClaudeHome(s.homeDir, homedir(), platform)) env = ["CLAUDE_CONFIG_DIR", s.homeDir];
  if (s.tool === "codex" && s.codexHome !== undefined && !isDefaultCodexHome(s.codexHome, homedir(), platform)) env = ["CODEX_HOME", s.codexHome];
  if (env === undefined) return cmd;
  if (platform === "win32") return `$env:${env[0]} = ${psQuote(env[1])}; ${cmd}`;
  return `${env[0]}=${shellQuote(env[1])} ${cmd}`;
}

function shellQuote(v: string): string {
  return /^[A-Za-z0-9_./~-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quoted string: a doubled quote escapes it, nothing else
 *  expands. PowerShell also ends a single-quoted string at the curly quotes
 *  U+2018 to U+201B, so those are doubled too. */
export function psQuote(v: string): string {
  return `'${v.replace(/['\u2018-\u201B]/g, (q) => q + q)}'`;
}

/** Wait up to `ms` for the process to exit; true once it has. */
async function waitExit(deps: Pick<MoveDeps, "running" | "now" | "sleep">, ms: number): Promise<boolean> {
  const until = deps.now() + ms;
  while (deps.running()) {
    if (deps.now() >= until) return false;
    await deps.sleep(POLL_MS);
  }
  return true;
}

/** The messages of a stop that did not end the process, worded for the action
 *  that asked for it (Move into Editor or Stop Session). */
export interface StopText {
  /** The identity no longer matches before any signal: nothing was stopped. */
  refused(problem: string): string;
  /** The identity no longer matches before the force step (SIGTERM was sent). */
  refusedAfterAsk(problem: string): string;
  /** The stop request was refused or failed and the process still runs. */
  signalFailed(why: string): string;
  /** The process survived the strongest stop there is. */
  wontStop(): string;
  /** The user declined the force stop; SIGTERM may still end it. */
  declinedForce(): string;
}

/** What the shared stop needs: MoveDeps without the resume. */
export type StopDeps = Pick<MoveDeps, "confirm" | "running" | "identity" | "signal" | "sleep" | "now" | "error" | "notice" | "leftover">;

/** The stop both Move into Editor and Stop Session use, after their own
 *  confirmation: re-verify the identity, SIGTERM (on Windows the tree stop),
 *  wait a bounded time, offer a force stop (identity re-checked before it), wait
 *  again. "stopped" once the process is seen gone (leftover children named);
 *  otherwise the reason was already shown with `text`. */
export async function stopVerified(
  s: Pick<MoveSubject, "title" | "pid">,
  deps: StopDeps,
  text: StopText,
  forced = false
): Promise<"stopped" | "changed" | "still-running"> {
  const checked = async (stopSent: boolean): Promise<boolean> => {
    const problem = await deps.identity();
    if (problem === undefined) return true;
    deps.error(stopSent ? text.refusedAfterAsk(problem) : text.refused(problem));
    return false;
  };
  if (!(await checked(false))) return "changed";
  // The stop is awaited: a late one can't end the session after "not stopped".
  const why = await deps.signal("SIGTERM");
  if (why !== undefined && deps.running()) {
    deps.error(text.signalFailed(why));
    return "still-running";
  }
  // Windows: the exit wait is at least as long as the stop's own timeout.
  if (!(await waitExit(deps, forced ? Math.max(STOP_WAIT_MS, WINDOWS_STOP_TIMEOUT_MS) : STOP_WAIT_MS))) {
    // Windows: the first stop already ended the process tree; nothing stronger exists.
    if (forced) {
      deps.error(text.wontStop());
      return "still-running";
    }
    const force = await deps.confirm(
      `"${s.title}" did not stop.`,
      `The process (pid ${s.pid}) is still running after ${STOP_WAIT_MS / 1000} seconds. Force it to stop? Anything it has not saved is lost.`,
      "Force Stop",
      true // destructive: Enter leaves it running
    );
    // The dialog may have sat open while the process finished exiting: whatever
    // was answered, a process that is gone now counts as stopped.
    if (deps.running()) {
      if (!force) {
        // It has had SIGTERM and may still exit a moment from now.
        deps.error(text.declinedForce());
        return "still-running";
      }
      if (!(await checked(true))) return "changed";
      await deps.signal("SIGKILL");
      if (!(await waitExit(deps, KILL_WAIT_MS))) {
        deps.error(text.wontStop());
        return "still-running";
      }
    }
  }
  const left = deps.leftover?.() ?? [];
  if (left.length > 0) deps.notice(leftoverNotice(s.title, left));
  return "stopped";
}

/** Confirm → verify → stop (SIGTERM, bounded wait, optional force) → resume →
 *  confirm it started. Resume runs only after the process is seen gone; a process
 *  that won't die is reported and left alone, never resumed alongside. A process
 *  already gone at confirmation is NOT resumed (a stale offer, a second window or
 *  a double click may already have moved it). The identity is re-verified before
 *  every signal. The user always ends with the session open or the exact command. */
export async function moveFlow(s: MoveSubject, target: MoveTarget, deps: MoveDeps, forced = false): Promise<MoveOutcome> {
  const text = moveConfirmText(s, target, forced);
  // A stale offer (the session already moved, stopped, or its pid now belongs
  // to something else) is answered before any confirmation is shown.
  // Information, short enough to read in a toast: nothing went wrong.
  const short = shortTitle(s.title);
  const alreadyGone = (): MoveOutcome => {
    (deps.info ?? deps.notice)(`"${short}" has already stopped or moved.`);
    return "gone";
  };
  if (!deps.running()) return alreadyGone();
  const before = await deps.identity();
  if (before !== undefined) {
    deps.error(`"${s.title}" was not moved: ${before}. Nothing was stopped.`);
    return "changed";
  }
  // App- or agent-owned: moving it may set up two writers later; mid-turn:
  // stopping cuts the turn off. In both, Enter must leave it running.
  if (!(await deps.confirm(text.message, text.detail, "Stop and Move", s.owner !== undefined || s.working))) return "cancelled";
  // Already stopped: a stale offer, another window or a double click may have
  // moved it already. Resuming now could start a second copy.
  if (!deps.running()) {
    return alreadyGone();
  }
  // From here a stop may have happened: every message that does not end with
  // the session open names the command that brings it back.
  const cmd = recoveryCommand(s);
  // The Windows line is PowerShell syntax: say so (cmd.exe can't run it).
  const run = cmd !== undefined ? `run \`${cmd}\`${process.platform === "win32" ? " in PowerShell" : ""} in ${s.cwd}` : "";
  const byHand = cmd !== undefined ? ` To continue it by hand, ${run}.` : "";
  // After a failed resume the captured program may be what failed: give the
  // plain command (the CLI found on PATH) instead of repeating it.
  const plain = s.launch !== undefined ? recoveryCommand({ ...s, launch: undefined }) : undefined;
  const afterFail =
    plain !== undefined
      ? ` To continue it by hand, run \`${plain}\`${process.platform === "win32" ? " in PowerShell" : ""} in ${s.cwd} (it uses the ${s.tool} found on your PATH).`
      : byHand;
  const ifLater = cmd !== undefined ? ` If it stops later, ${run} to continue it.` : "";
  const stopped = await stopVerified(
    s,
    deps,
    {
      refused: (problem) => `"${s.title}" was not moved: ${problem}. Nothing was stopped.`,
      refusedAfterAsk: (problem) => `"${s.title}" was asked to stop but was not force-stopped or moved: ${problem}.${ifLater}`,
      signalFailed: (why) => `"${s.title}" was not moved: ${why}.${ifLater}`,
      wontStop: () => `"${s.title}" (pid ${s.pid}) would not stop. It was not moved.${ifLater}`,
      declinedForce: () =>
        `"${s.title}" was not moved. It was asked to stop and may still exit.` + (cmd !== undefined ? ` If it does, reopen it: ${run}.` : ""),
    },
    forced
  );
  if (stopped !== "stopped") return stopped;
  const stoppedAt = deps.now();
  try {
    await deps.resume();
  } catch (err) {
    const why = err instanceof Error && err.message !== "" ? ` (${err.message})` : "";
    deps.error(`"${s.title}" was stopped but could not be resumed here${why}.${afterFail}`);
    return "resume-failed";
  }
  const until = deps.now() + START_WAIT_MS;
  while (!(await deps.started(stoppedAt))) {
    // The CLI ran as the terminal's own process and already exited: it failed.
    const ended = deps.resumeEnded?.();
    if (ended !== undefined) {
      deps.error(`"${s.title}" was stopped, but it did not start here: ${ended}.${afterFail}`);
      return "resume-failed";
    }
    if (deps.now() >= until) {
      // Still running in this window's terminal: started, even if its record
      // hasn't shown up yet. No warning.
      if (deps.resumeAlive?.() === true) return "resumed";
      // The tab or terminal may still be starting it: don't invite a second copy.
      const where = target === "claudeTab" ? "the Claude tab" : "the terminal";
      deps.notice(
        `"${s.title}" was stopped and SessionDeck has not seen it start here yet.` +
          (cmd !== undefined ? ` If ${where} did not open it, ${run}.` : "")
      );
      return "unconfirmed";
    }
    await deps.sleep(START_POLL_MS);
  }
  return "resumed";
}

// ---- stop session ------------------------------------------------------------
// Stop Session ends a session's process and does not resume it: the same stop as
// Move into Editor (stopVerified), behind its own confirmation, for a session
// running anywhere SessionDeck can place it (outside, in an editor terminal or
// tab, in tmux). The transcript stays; the session can be resumed later.

export type StopOutcome = "cancelled" | "gone" | "changed" | "stopped" | "still-running";

/** A title short enough for a toast or the status bar. */
export function shortTitle(title: string): string {
  return title.length > 40 ? `${title.slice(0, 39)}…` : title;
}

/** The modal confirmation for Stop Session. `s.where` is the whole place phrase
 *  ("outside the editor, in a WSL shell", "in a terminal in the editor"…). */
export function stopConfirmText(s: MoveSubject, forced = false): { message: string; detail: string } {
  const lines = [`It runs ${s.where}, as pid ${s.pid}. SessionDeck will stop that process. The conversation is kept, so you can resume it later.`];
  if (s.working) lines.push("It is in the middle of a turn. That turn will be cut off.");
  else if (s.background === true) lines.push("It is between turns, with a background task running, which may be stopped too.");
  else lines.push("It is between turns.");
  if (s.claudeTab === true) {
    lines.push("Its process runs under the Claude Code extension and ends there too. The tab stays open, and sending a message in it may start the session again.");
  }
  if (s.owner === "sdk") lines.push("Another app runs this session. That app may start it again the next time a message is sent there.");
  if (s.owner === "agent") lines.push("Another agent started this session and may start it again.");
  if (forced) lines.push(WINDOWS_STOP_NOTE);
  return { message: `Stop "${s.title}"?`, detail: lines.join("\n\n") };
}

export interface StopFlowDeps extends StopDeps {
  /** Plain information (a stale offer: nothing went wrong). */
  info(message: string): void;
  /** The one success note ("Stopped "hi"."), shown in the status bar. */
  done(message: string): void;
  /** Why it was not stopped, without the title (SessionDeck's own words only,
   *  never conversation text): what a stop asked from another host reports. */
  reason?(why: string): void;
}

/** Confirm → verify → stop, with no resume. A process already gone before or at
 *  the confirmation is reported as such; an identity that no longer matches is
 *  refused before any signal. Leaving it running is the default button in every
 *  variant, so Enter never stops a session. */
export async function stopFlow(s: MoveSubject, deps: StopFlowDeps, forced = false): Promise<StopOutcome> {
  const short = shortTitle(s.title);
  const alreadyGone = (): StopOutcome => {
    deps.info(`"${short}" has already stopped.`);
    return "gone";
  };
  const because = (why: string, message: string): string => {
    deps.reason?.(why);
    return message;
  };
  if (!deps.running()) return alreadyGone();
  const before = await deps.identity();
  if (before !== undefined) {
    deps.error(because(before, `"${s.title}" was not stopped: ${before}.`));
    return "changed";
  }
  const text = stopConfirmText(s, forced);
  if (!(await deps.confirm(text.message, text.detail, "Stop Session", true))) return "cancelled";
  if (!deps.running()) return alreadyGone();
  const r = await stopVerified(
    s,
    deps,
    {
      refused: (problem) => because(problem, `"${s.title}" was not stopped: ${problem}.`),
      refusedAfterAsk: (problem) => because(`it was asked to stop but was not force-stopped: ${problem}`, `"${s.title}" was asked to stop but was not force-stopped: ${problem}.`),
      signalFailed: (why) => because(why, `"${s.title}" was not stopped: ${why}.`),
      wontStop: () => because(`pid ${s.pid} would not stop`, `"${s.title}" (pid ${s.pid}) would not stop.`),
      declinedForce: () => because("it was asked to stop and may still exit", `"${s.title}" was asked to stop and may still exit.`),
    },
    forced
  );
  if (r !== "stopped") return r;
  deps.done(`Stopped "${short}".`);
  return "stopped";
}

// ---- move: one at a time per session ----------------------------------------

const movesInWindow = new Set<string>();
/** Fallback only: a claim whose holder can't be checked in the process table
 *  (an older release's claim, another pid namespace, a failed table read) is
 *  left over from a dead window once its time is this far from now, either way,
 *  so a backward clock step can't keep it live. */
export const MOVE_CLAIM_STALE_MS = 5 * 60_000;
/** A live move rewrites its claim this often, so an open dialog never makes it stale. */
export const MOVE_CLAIM_REFRESH_MS = 30_000;
/** Even with its holder alive, a claim not rewritten for this long (20 refreshes
 *  missed: the move ended but its release write keeps failing) is stale. Measured
 *  on the host's uptime, which a wall-clock change doesn't move, so a clock jump
 *  mid-move can't trip it. */
export const MOVE_CLAIM_UNREFRESHED_MS = 20 * MOVE_CLAIM_REFRESH_MS;
/** A failed release write is retried after this, doubling up to 60 times this. */
export const MOVE_CLAIM_RELEASE_RETRY_MS = 1_000;

/** Holder tokens of the claims this process holds right now. A claim naming this
 *  process with a token not in here is one whose release write failed: stale. */
const heldTokens = new Set<string>();

/** Is the process that wrote a claim still running? true/false when the process
 *  table can tell, undefined when it can't (then the age rule decides). */
export type ClaimHolderProbe = (pid: number, start: number, ns: string | undefined) => Promise<boolean | undefined>;

export interface ClaimOptions {
  now?: () => number;
  refreshMs?: number;
  /** The in-window guard (tests pass their own to act as another window). */
  windowSet?: Set<string>;
  /** Liveness of another claim's holder (tests fake it). */
  holderAlive?: ClaimHolderProbe;
  /** Which pid counts as this process (tests pass another to act as another process). */
  selfPid?: number;
  /** Host uptime in ms (tests fake it). */
  uptimeMs?: () => number;
  /** The write used for refreshes and the release (tests make it fail). */
  write?: (file: string, data: string) => void;
  /** First release retry delay. */
  releaseRetryMs?: number;
  /** How often the holder checks whether a refresh is due. */
  tickMs?: number;
}

const hostUptimeMs = (): number => Math.round(uptime() * 1000);

/** The process table's answer for a claim holder: Linux checks pid, start time and
 *  zombie state in /proc, and only within our own pid namespace; macOS and Windows
 *  probe the pid, then compare a fresh start-time read from ps / Win32_Process. */
export const claimHolderAlive: ClaimHolderProbe = async (pid, start, ns) => {
  if (procHost() === "linux") {
    const ours = linuxIdentitySources.ownPidNamespace();
    if (ns === undefined || ours === undefined || ns !== ours) return undefined;
    return processRunning(pid, start);
  }
  if (!pidAlive(pid)) return false;
  const cur = await currentStartOf(pid);
  return cur === undefined ? undefined : cur === start;
};

/** A failed read of this process's start time is tried again after this. */
const CLAIM_IDENTITY_RETRY_MS = 60_000;
let ownClaimIdentity: { value: Promise<string>; known: boolean; at: number } | undefined;
/** This process as a claim records it, after the token: "<start> <pid namespace>",
 *  "-" for a part the platform can't give. A table query on macOS and Windows,
 *  which the extension starts at activation so a move never waits on it. A read
 *  that found no start time is retried after CLAIM_IDENTITY_RETRY_MS (until then
 *  claims fall back to the age rule); a found one is kept. */
export function moveClaimIdentity(readStart: (pid: number) => Promise<number | undefined> = currentStartOf): Promise<string> {
  const cached = ownClaimIdentity;
  if (cached !== undefined && (cached.known || Date.now() - cached.at < CLAIM_IDENTITY_RETRY_MS)) return cached.value;
  const entry = { value: Promise.resolve(""), known: false, at: Date.now() };
  entry.value = (async () => {
    let start: number | undefined;
    try {
      start = await readStart(process.pid);
    } catch {
      start = undefined;
    }
    entry.known = start !== undefined;
    const ns = procHost() === "linux" ? linuxIdentitySources.ownPidNamespace() : undefined;
    return `${start ?? "-"} ${ns ?? "-"}`;
  })();
  ownClaimIdentity = entry;
  return entry.value;
}

/** Test seam: forget this process's cached claim identity. */
export function __resetMoveClaimIdentity(): void {
  ownClaimIdentity = undefined;
}

/** Does a claim's content hold the move? `<at> <pid>-<hex> [<start> <ns> <uptime>]`:
 *  - a released claim (at 0): never;
 *  - one this process wrote: only while this process still holds that token (a
 *    release write that failed doesn't block this window);
 *  - one whose holder the process table can check: while that process runs and
 *    the claim was rewritten within MOVE_CLAIM_UNREFRESHED_MS of host uptime,
 *    whatever the wall clock says;
 *  - otherwise while `at` is within MOVE_CLAIM_STALE_MS of now, either direction. */
export async function claimLive(
  content: string,
  now: number,
  holderAlive: ClaimHolderProbe,
  ctx: { selfPid?: number; uptimeMs?: () => number } = {}
): Promise<boolean> {
  const [atRaw, token, startRaw, nsRaw, upRaw] = content.trim().replace(/;$/, "").split(" ");
  const at = Number(atRaw);
  if (!Number.isFinite(at) || at <= 0) return false;
  const pid = Number(/^(\d+)-/.exec(token ?? "")?.[1]);
  const start = Number(startRaw);
  if (Number.isInteger(pid) && pid > 0 && startRaw !== undefined) {
    if (pid === (ctx.selfPid ?? process.pid) && `${startRaw} ${nsRaw}` === (await moveClaimIdentity())) return heldTokens.has(token);
  }
  if (Number.isInteger(pid) && pid > 0 && startRaw !== undefined && startRaw !== "-" && Number.isFinite(start)) {
    let alive: boolean | undefined;
    try {
      alive = await holderAlive(pid, start, nsRaw === undefined || nsRaw === "-" ? undefined : nsRaw);
    } catch {
      alive = undefined;
    }
    if (alive === false) return false;
    if (alive === true) {
      const up = Number(upRaw);
      if (upRaw !== undefined && Number.isFinite(up)) return (ctx.uptimeMs ?? hostUptimeMs)() - up <= MOVE_CLAIM_UNREFRESHED_MS;
      return Math.abs(now - at) <= MOVE_CLAIM_UNREFRESHED_MS;
    }
  }
  return Math.abs(now - at) <= MOVE_CLAIM_STALE_MS;
}

/** File operations a claim write uses (tests make them fail part-way). */
export interface ClaimIo {
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  linkSync(existing: string, link: string): void;
}
const claimIo: ClaimIo = { writeFileSync: (p, d) => writeFileSync(p, d), renameSync, linkSync };

/** A temp name in the claim folder; never matches a `move-` claim name. */
const claimTemp = (dir: string): string => join(dir, `.tmp-claim-${process.pid}-${randomBytes(6).toString("hex")}`);

/** Write a claim whole: the full content to a temp file in the same folder,
 *  renamed over the claim, so a reader sees the old claim or the new one,
 *  never a part (rename replaces atomically on POSIX and on NTFS, where Node
 *  uses MoveFileEx with MOVEFILE_REPLACE_EXISTING). A failed write leaves the
 *  previous claim in place, and throws. */
export function writeClaimFile(file: string, data: string, io: ClaimIo = claimIo): void {
  const tmp = claimTemp(dirname(file));
  try {
    io.writeFileSync(tmp, data);
    io.renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // never written
    }
    throw err;
  }
}

/** Create a new claim generation whole and exclusively: the content goes to a
 *  temp file, hard-linked to the claim name (link fails with EEXIST when the
 *  name exists, the same guarantee as O_EXCL), then the temp name is removed.
 *  Where the file system has no hard links, an O_EXCL create plus write is the
 *  fallback; a reader that catches it mid-write sees an incomplete claim and
 *  counts it busy. true = ours, false = exists, undefined = unusable dir. */
export async function createClaimFile(dir: string, file: string, content: string, io: ClaimIo = claimIo): Promise<boolean | undefined> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return undefined;
  }
  const tmp = claimTemp(dir);
  try {
    io.writeFileSync(tmp, content);
  } catch {
    return undefined;
  }
  try {
    io.linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code === "EEXIST") return false;
    // No hard links here (FAT, some network shares): exclusive create instead.
    try {
      await writeFile(file, content, { flag: "wx" });
      return true;
    } catch (err2) {
      return (err2 as { code?: unknown }).code === "EEXIST" ? false : undefined;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // gone
    }
  }
}

const readOrUndefined = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** Ends every claim this release writes, so no proper prefix of a claim is
 *  itself a whole claim. */
const CLAIM_END = ";";
/** A whole claim: this release's `<at> <token> <start> <ns> <uptime>;` or
 *  `0 released;`, or an older release's `<at> <token>` / `0 released` (those
 *  wrote in place; a prefix of one still holds a full time, so the age rule
 *  reads it live). Anything else was read mid-write: busy. */
const CLAIM_CONTENT = /^(?:0 released;?|\d+ \S+ \S+ \S+ \d+;|\d+ [^\s;]+)$/;

/** A finished move marks its claim with this time: free at once, never live. */
const RELEASED = `0 released${CLAIM_END}`;
/** Claim generations below the newest are deleted once they are this old. */
const CLAIM_GC_MS = 24 * 60 * 60_000;

const claimFile = (dir: string, key: string, gen: number): string => join(dir, gen === 0 ? `move-${key}` : `move-${key}.${gen}`);

/** Generations of the claim on `key` present in `dir`; undefined when the
 *  folder can't be read. `move-<key>` is generation 0, `move-<key>.<n>` is n. */
function claimGens(dir: string, key: string): number[] | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const base = `move-${key}`;
  const out: number[] = [];
  for (const n of names) {
    if (n === base) out.push(0);
    else if (n.startsWith(`${base}.`) && /^\d{1,9}$/.test(n.slice(base.length + 1))) out.push(Number(n.slice(base.length + 1)));
  }
  return out;
}

/** Take the claim on `key`. Claims are numbered generations, each created once
 *  with O_EXCL and never re-created: a window may create generation n+1 only
 *  after reading generation n, the newest, as stale or released, so racing
 *  windows all try the same n+1 and exactly one create succeeds. There is no
 *  takeover lock, so a window that dies at any point leaves at most a claim
 *  that goes stale like any other. After creating, the window lists again and
 *  backs off if a newer generation exists (a window whose view was old).
 *  Returns the claim file held, false when busy, undefined when unusable. */
async function acquireClaim(
  dir: string,
  key: string,
  content: string,
  now: () => number,
  holderAlive: ClaimHolderProbe,
  ctx: { selfPid?: number; uptimeMs?: () => number }
): Promise<{ file: string; gen: number } | false | undefined> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return undefined;
  }
  const gens = claimGens(dir, key);
  if (gens === undefined) return undefined;
  const top = gens.length > 0 ? Math.max(...gens) : -1;
  if (top >= 0) {
    const topFile = claimFile(dir, key, top);
    const seen = readOrUndefined(topFile);
    if (seen === undefined) return false; // changing under us: not ours to take
    if (!CLAIM_CONTENT.test(seen)) {
      // Empty or cut short: read between a create, refresh or release and its
      // write (a write truncates first). Not free, unless it has sat like that
      // past the stale age (a window that died between create and write).
      let mtime: number | undefined;
      try {
        mtime = statSync(topFile).mtimeMs;
      } catch {
        mtime = undefined;
      }
      if (mtime === undefined || Math.abs(Date.now() - mtime) <= MOVE_CLAIM_STALE_MS) return false;
    } else if (await claimLive(seen, now(), holderAlive, ctx)) return false;
  }
  const mine = top + 1;
  const file = claimFile(dir, key, mine);
  const created = await createClaimFile(dir, file, content);
  if (created !== true) return created;
  if (Math.max(...(claimGens(dir, key) ?? [mine])) > mine) {
    writeIfOurs(file, content, RELEASED);
    return false;
  }
  // Old generations: only long-stale ones, so no window still acting on an old
  // view can find a deleted number free and re-create it.
  for (const g of gens) {
    const f = claimFile(dir, key, g);
    try {
      if (Date.now() - statSync(f).mtimeMs > CLAIM_GC_MS) unlinkSync(f);
    } catch {
      // gone, or not ours to clean
    }
  }
  return { file, gen: mine };
}

/** Delete the generations of `key` below `gen` (a move that held `gen` ended).
 *  Safe while `gen` itself stays: a window acting on an old view that re-creates
 *  a deleted lower number finds `gen` above it when it lists again, and backs
 *  off. So the newest generation is kept, and one file per session remains. */
function pruneBelow(dir: string, key: string, gen: number): void {
  for (const g of claimGens(dir, key) ?? []) {
    if (g >= gen) continue;
    try {
      unlinkSync(claimFile(dir, key, g));
    } catch {
      // gone, or locked: the next move or the sweep gets it
    }
  }
}

/** Move-claim files a sweep looks at, at most, per run. */
const CLAIM_SWEEP_LIMIT = 500;
/** A released claim is swept once this old (no window still acts on a view of it). */
const CLAIM_SWEEP_RELEASED_MS = 60 * 60_000;

/** Delete move-claim files of sessions SessionDeck no longer lists. Older
 *  generations go once released for an hour, or after a day. A session's newest
 *  generation is what keeps a takeover exclusive, so it goes only once it is a
 *  day old and the process it records is not running. Looks at no more than
 *  CLAIM_SWEEP_LIMIT files. Run once at activation, off the startup path. Other
 *  files in the folder (the publisher lease, once-claims) are left alone; temp
 *  files of a claim write that died go after a day. Returns how many were deleted. */
export async function sweepMoveClaims(
  dir: string,
  listed: (id: string) => boolean,
  now: () => number = Date.now,
  holderAlive: ClaimHolderProbe = claimHolderAlive
): Promise<number> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const byKey = new Map<string, number[]>();
  let seen = 0;
  for (const n of names) {
    if (n.startsWith(".tmp-claim-")) {
      // A temp file left by a window that died between its write and rename.
      try {
        if (now() - statSync(join(dir, n)).mtimeMs > CLAIM_GC_MS) unlinkSync(join(dir, n));
      } catch {
        // gone
      }
      continue;
    }
    const m = /^move-([0-9a-z-]{8,128})(?:\.(\d{1,9}))?$/.exec(n);
    if (m === null) continue;
    if (++seen > CLAIM_SWEEP_LIMIT) break;
    const gens = byKey.get(m[1]) ?? [];
    gens.push(m[2] === undefined ? 0 : Number(m[2]));
    byKey.set(m[1], gens);
  }
  let deleted = 0;
  for (const [key, gens] of byKey) {
    if (listed(key)) continue;
    // Newest from a fresh listing, not the possibly stale one above.
    const newest = Math.max(...(claimGens(dir, key) ?? gens));
    for (const g of gens) {
      const f = claimFile(dir, key, g);
      try {
        const age = now() - statSync(f).mtimeMs;
        const content = readFileSync(f, "utf8");
        let drop: boolean;
        if (g < newest) drop = age > CLAIM_GC_MS || (age > CLAIM_SWEEP_RELEASED_MS && /^0 released;?$/.test(content));
        else drop = age > CLAIM_GC_MS && !(await claimHolderRunning(content, holderAlive));
        if (drop) {
          unlinkSync(f);
          deleted++;
        }
      } catch {
        // gone, or locked: next activation
      }
    }
  }
  return deleted;
}

/** Does the process a claim records still run? false when it records none or the
 *  table can't tell (the caller's age rule then decides). */
async function claimHolderRunning(content: string, holderAlive: ClaimHolderProbe): Promise<boolean> {
  const [, token, startRaw, nsRaw] = content.trim().replace(/;$/, "").split(" ");
  const pid = Number(/^(\d+)-/.exec(token ?? "")?.[1]);
  const start = Number(startRaw);
  if (!Number.isInteger(pid) || pid <= 0 || startRaw === undefined || startRaw === "-" || !Number.isFinite(start)) return false;
  try {
    return (await holderAlive(pid, start, nsRaw === undefined || nsRaw === "-" ? undefined : nsRaw)) === true;
  } catch {
    return false;
  }
}

/** Rewrite `file` with `next` only while it still holds `current`. False when a
 *  read or write failed (a lock, a permission), true when done or not ours. */
function writeIfOurs(file: string, current: string, next: string, write: (f: string, d: string) => void = writeClaimFile): boolean {
  let cur: string;
  try {
    cur = readFileSync(file, "utf8");
  } catch (err) {
    return (err as { code?: unknown }).code === "ENOENT";
  }
  if (cur !== current) return true;
  try {
    write(file, next);
    return true;
  } catch {
    return false;
  }
}

/** Mark a claim released; if the write fails (an antivirus or indexer lock on
 *  Windows, say), retry with backoff until it lands, the claim is no longer
 *  ours, or the window closes. Other windows meanwhile see it go stale after
 *  MOVE_CLAIM_UNREFRESHED_MS; this window already treats it as free. */
function releaseClaim(file: string, content: string, write: (f: string, d: string) => void, firstDelay: number): void {
  if (writeIfOurs(file, content, RELEASED, write)) return;
  let delay = firstDelay;
  const retry = (): void => {
    if (writeIfOurs(file, content, RELEASED, write)) return;
    delay = Math.min(delay * 2, firstDelay * 60);
    setTimeout(retry, delay).unref?.();
  };
  setTimeout(retry, delay).unref?.();
}

/** Run `fn` holding an exclusive claim on moving session `id`: one in-window set
 *  plus an O_EXCL claim file in `dir` (globalStorage, shared by every window on
 *  this host), refreshed while `fn` runs and marked released when it ends.
 *  "busy": another move of the same session holds it; "unavailable": the claim
 *  folder can't be written, so no move can be reserved. */
export async function withMoveClaim<T>(
  dir: string,
  id: string,
  fn: () => Promise<T>,
  opts: ClaimOptions = {}
): Promise<{ result: T } | "busy" | "unavailable"> {
  const now = opts.now ?? Date.now;
  const windowSet = opts.windowSet ?? movesInWindow;
  const key = id.toLowerCase();
  if (windowSet.has(key)) return "busy";
  windowSet.add(key);
  let content = "";
  try {
    const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
    const holder = `${token} ${await moveClaimIdentity()}`;
    const upMs = opts.uptimeMs ?? hostUptimeMs;
    const write = opts.write ?? ((f: string, d: string) => writeClaimFile(f, d));
    content = `${now()} ${holder} ${upMs()}${CLAIM_END}`;
    // Held from before the create, so a racing window of this process never
    // reads our new claim as a failed release.
    heldTokens.add(token);
    // A claim left over from a window that died mid-move is superseded.
    const claim = await acquireClaim(dir, key, content, now, opts.holderAlive ?? claimHolderAlive, opts);
    if (claim === undefined || claim === false) {
      heldTokens.delete(token);
      return claim === undefined ? "unavailable" : "busy";
    }
    const { file, gen } = claim;
    // Due by host uptime, checked every second: uptime keeps counting through
    // sleep (and on macOS moves with a wall-clock jump), while timers don't, so
    // on wake the first tick refreshes before the claim can look unrefreshed.
    const refreshMs = opts.refreshMs ?? MOVE_CLAIM_REFRESH_MS;
    let refreshedAt = upMs();
    const timer = setInterval(() => {
      if (upMs() - refreshedAt < refreshMs) return;
      const next = `${now()} ${holder} ${upMs()}${CLAIM_END}`;
      try {
        // A newer generation means another window took the claim over: stop.
        if (Math.max(...(claimGens(dir, key) ?? [gen])) > gen) {
          clearInterval(timer);
          return;
        }
        if (readFileSync(file, "utf8") !== content) return; // not ours any more
        write(file, next);
        content = next;
        refreshedAt = upMs();
      } catch {
        // The previous whole claim is still in place; the next tick tries again.
      }
    }, opts.tickMs ?? Math.min(1000, refreshMs));
    try {
      return { result: await fn() };
    } finally {
      clearInterval(timer);
      heldTokens.delete(token);
      releaseClaim(file, content, write, opts.releaseRetryMs ?? MOVE_CLAIM_RELEASE_RETRY_MS);
      pruneBelow(dir, key, gen);
    }
  } finally {
    windowSet.delete(key);
  }
}

// ---- move: process identity --------------------------------------------------

/** Where identity facts come from. The start-time source is pluggable: /proc on
 *  Linux, the `ps` / Win32_Process table on macOS and Windows. */
export interface IdentitySources {
  /** Start time as recorded by our own process table when the row was listed. */
  liveStart(pid: number): number | undefined;
  /** A fresh read from the same source, right before a signal. */
  freshStart(pid: number): Promise<number | undefined>;
  /** Does the registry's procStart agree with the live process? undefined when
   *  the formats can't be compared on this platform (Windows: unverified). */
  procStartAgrees(pid: number, procStart: string): boolean | undefined;
  readRegistry(homeDir: string, pid: number): unknown;
  /** This process's pid namespace ("pid:[4026531836]"); undefined where pid
   *  namespaces don't exist (macOS, Windows) or can't be read. */
  ownPidNamespace(): string | undefined;
  /** Does the registry's pidDomain place the session in our process space? A
   *  string names the problem. */
  checkPidDomain(pidDomain: unknown): string | undefined;
  /** Pids that must never be signalled (this extension host, its parent). */
  protectedPids(): number[];
  codexHolds(pid: number, rolloutPath: string): boolean;
  argv0(pid: number): string | undefined;
  /** The program a pid runs, with its start time (processLaunchFacts). */
  program(pid: number): Promise<{ start?: number; exe?: string; argv?: string[] } | undefined>;
  /** Do those facts identify the Claude Code or Codex program (isCliProcess)? */
  isCli(tool: MoveTool, facts: { exe?: string; argv?: readonly string[] }): boolean;
  /** This editor's install roots: no process under them is ever a session. */
  editorRoots(): readonly string[];
}

/** Is the program part of the editor itself? Anything under the editor's
 *  install root, except its extensions folder (a remote server keeps
 *  extensions under the same root, and the Claude Code extension's sessions
 *  run its CLI from there). */
export function editorProgram(exe: string | undefined, roots: readonly string[]): boolean {
  if (!underRoot(exe, roots)) return false;
  return !underRoot(exe, roots.map((r) => `${r.replace(/[\\/]+$/, "")}/extensions`));
}

/** The pid must run the Claude Code or Codex program itself (the check the
 *  resume capture uses), started at the verified time, and not the editor. A
 *  forged registry entry with the right start time and pid domain still can't
 *  point a stop at any other process. */
export async function programProblem(s: MoveSubject, src: IdentitySources): Promise<string | undefined> {
  const facts = await src.program(s.pid);
  if (facts === undefined || facts.start === undefined || facts.start !== s.start) return "SessionDeck could not read which program it runs";
  if (editorProgram(facts.exe === undefined ? undefined : withoutDeleted(facts.exe), src.editorRoots())) return `pid ${s.pid} is part of the editor`;
  if (!src.isCli(s.tool, facts)) return `pid ${s.pid} is not running ${s.tool === "claude" ? "Claude Code" : "Codex"}`;
  return undefined;
}

function protectedPid(pid: number, src: IdentitySources): string | undefined {
  if (!Number.isInteger(pid) || pid <= 1 || src.protectedPids().includes(pid)) return `pid ${pid} is not one SessionDeck will stop`;
  return undefined;
}

/** The start time a Claude session's registry entry vouches for: the entry for
 *  `pid` must exist and name this session; its procStart must match the live
 *  process (an absent or uncomparable one is refused); on Linux it must come from
 *  our pid namespace. Undefined (with the reason) otherwise. */
export function verifiedClaudeStart(
  x: { pid: number; sessionId: string; homeDir: string },
  src: IdentitySources
): { start?: number; problem?: string } {
  const prot = protectedPid(x.pid, src);
  if (prot !== undefined) return { problem: prot };
  const raw = src.readRegistry(x.homeDir, x.pid);
  if (raw === null || typeof raw !== "object") return { problem: "its session record is gone" };
  const reg = raw as { sessionId?: unknown; procStart?: unknown; pidDomain?: unknown };
  if (reg.sessionId !== x.sessionId) return { problem: `pid ${x.pid} now runs a different session` };
  const live = src.liveStart(x.pid);
  if (live === undefined) return { problem: "SessionDeck could not identify its process" };
  // Windows builds may write procStartFt instead (seen in the CLI's reader).
  const stored = typeof reg.procStart === "string" ? reg.procStart : typeof (raw as { procStartFt?: unknown }).procStartFt === "string" ? (raw as { procStartFt: string }).procStartFt : "";
  // Only a start time that matches vouches for the pid: a missing or unreadable
  // one (undefined) is refused on every platform, or a stale entry whose pid now
  // belongs to an unrelated process could be stopped.
  const agrees = src.procStartAgrees(x.pid, stored);
  if (agrees !== true) {
    return {
      problem:
        typeof reg.procStart === "string" && reg.procStart !== ""
          ? `pid ${x.pid} now belongs to a different process`
          : "its session record has no process start time to check",
    };
  }
  const domainProblem = src.checkPidDomain(reg.pidDomain);
  if (domainProblem !== undefined) return { problem: domainProblem };
  return { start: live };
}

/** Re-verify a subject right before a signal: the registry checks again, and a
 *  fresh read of the start time from the same source must equal the one
 *  recorded when the move was offered. */
export async function identityProblem(s: MoveSubject, src: IdentitySources): Promise<string | undefined> {
  if (s.start === undefined) return "SessionDeck could not identify its process";
  if (s.tool === "claude") {
    if (s.homeDir === undefined) return "its session record is unknown";
    const v = verifiedClaudeStart({ pid: s.pid, sessionId: s.id, homeDir: s.homeDir }, src);
    if (v.problem !== undefined) return v.problem;
  } else {
    const prot = protectedPid(s.pid, src);
    if (prot !== undefined) return prot;
    const exe = src.argv0(s.pid);
    if (exe === undefined || basename(exe) !== "codex") return `pid ${s.pid} is no longer Codex`;
    if (s.rolloutPath === undefined || !src.codexHolds(s.pid, s.rolloutPath)) return "that Codex process no longer has this session open";
  }
  if ((await src.freshStart(s.pid)) !== s.start) return `pid ${s.pid} now belongs to a different process`;
  return programProblem(s, src);
}

const readRegistryFile = (homeDir: string, pid: number): unknown => {
  try {
    return JSON.parse(readFileSync(join(homeDir, "sessions", `${pid}.json`), "utf8")) as unknown;
  } catch {
    return undefined;
  }
};

/** Linux: every registry seen (Claude Code 2.1.278 to 2.1.288) carries pidDomain
 *  "linux:<machine-id>:pid:[<ns>]", the machine id being /etc/machine-id. The
 *  whole value must be this host's: this machine id and our pid namespace. A bare
 *  namespace, another prefix or another machine's id is refused, as is a missing
 *  value: without it a pid can't be tied to this host's processes. */
export function linuxPidDomainProblem(pidDomain: unknown, ownNs: string | undefined, machineId: string | undefined): string | undefined {
  const m = typeof pidDomain === "string" ? /^linux:([^:\s]+):(pid:\[\d+\])$/.exec(pidDomain) : null;
  if (m === null) return "its session record doesn't say which process namespace it runs in (updating Claude Code fixes this)";
  if (ownNs === undefined || m[2] !== ownNs) return "it runs in a different process namespace (a container or another machine)";
  if (machineId === undefined) return "SessionDeck could not read this machine's id to check where it runs";
  if (m[1] !== machineId) return "it runs on another machine";
  return undefined;
}

/** This host's machine id, as Claude Code writes it into pidDomain. */
export function linuxMachineId(): string | undefined {
  for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    const id = readOrUndefined(f)?.trim();
    if (id !== undefined && /^[0-9a-f]{32}$/.test(id)) return id;
  }
  return undefined;
}

/** Windows: the registry carries pidDomain "win32:<host name, lower case>" (seen
 *  on 2.1.286 and 2.1.288). It must name this machine. macOS: the format has not
 *  been seen on a real machine, so it is not checked there (the start-time checks
 *  still apply). */
export function tablePidDomainProblem(platform: NodeJS.Platform, pidDomain: unknown, host: string = hostname()): string | undefined {
  if (platform !== "win32") return undefined;
  if (typeof pidDomain !== "string" || !pidDomain.startsWith("win32:")) {
    return "its session record doesn't say which machine it runs on (updating Claude Code fixes this)";
  }
  if (pidDomain.slice("win32:".length).toLowerCase() !== host.toLowerCase()) return "it runs on another machine";
  return undefined;
}

export const linuxIdentitySources: IdentitySources = {
  liveStart: (pid) => pidStartTime(pid),
  freshStart: async (pid) => pidStartTime(pid),
  procStartAgrees: (pid, procStart) => /^\d+$/.test(procStart) && String(pidStartTime(pid)) === procStart,
  readRegistry: readRegistryFile,
  ownPidNamespace: () => {
    try {
      return readlinkSync("/proc/self/ns/pid");
    } catch {
      return undefined;
    }
  },
  checkPidDomain: (pidDomain) => linuxPidDomainProblem(pidDomain, linuxIdentitySources.ownPidNamespace(), linuxMachineId()),
  protectedPids: () => [process.pid, process.ppid],
  codexHolds: (pid, path) => pidHasOpen(pid, path, true),
  argv0: (pid) => pidCmdline(pid)?.[0],
  program: (pid) => processLaunchFacts(pid),
  isCli: (tool, facts) => isCliProcess(tool, facts, "linux"),
  editorRoots: () => runningEditorRoots(),
};

/** This editor's install roots (empty outside an extension host). */
function runningEditorRoots(): string[] {
  return editorFamilyRoots(vscode.env?.appRoot ?? "", process.execPath);
}

/** macOS / Windows: the spawned process table. The registry procStart is compared
 *  where the formats were shown to agree: macOS (the same `ps -o lstart` text, per
 *  the CLI's source) and Windows (FILETIME, matched at microsecond resolution on a
 *  real machine). The table's own start, re-read before signals, guards reuse. */
export function tableIdentitySources(platform: NodeJS.Platform): IdentitySources {
  return {
    liveStart: (pid) => processStartOf(pid),
    freshStart: (pid) => currentStartOf(pid),
    procStartAgrees: (pid, procStart) => {
      const token = procTable()?.peek(pid)?.token;
      if (token === undefined) return false;
      // Empty or non-numeric (Windows) procStart can't be compared: refused, as
      // on macOS, where Claude Code always writes one.
      return registryStartAgrees(platform, procStart, token) ?? false;
    },
    readRegistry: readRegistryFile,
    ownPidNamespace: () => undefined,
    checkPidDomain: (pidDomain) => tablePidDomainProblem(platform, pidDomain),
    protectedPids: () => [process.pid, process.ppid],
    codexHolds: () => false,
    argv0: () => undefined,
    program: (pid) => processLaunchFacts(pid),
    isCli: (tool, facts) => isCliProcess(tool, facts, platform),
    editorRoots: () => runningEditorRoots(),
  };
}

/** The identity sources for this platform. */
export function identitySources(): IdentitySources {
  const platform = procHost();
  return platform === "linux" ? linuxIdentitySources : tableIdentitySources(platform);
}

// ---- move: vscode wiring -----------------------------------------------------

export function claudeExtensionInstalled(): boolean {
  return vscode.extensions.getExtension(CLAUDE_EXTENSION_ID) !== undefined;
}

export function moveSetting(): MoveSetting {
  return readMoveSetting(vscode.workspace.getConfiguration("sessionDeck").get<string>("moveTarget", "auto"));
}

function inWindow(cwd: string): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some((f) => {
    // path.relative handles Windows separators, drive letters and case.
    const rel = relative(f.uri.fsPath, cwd);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/** Stop a process. macOS/Linux: SIGTERM (graceful; Claude Code and Codex exit and
 *  end their tool processes) or SIGKILL; resolves undefined. Windows has no
 *  graceful stop for a console program, and TerminateProcess on the one process
 *  would orphan the session's tool processes, so the session's own descendants
 *  are ended, leaf first, by one PowerShell exchange that holds the target and
 *  re-checks its start (stopTreeWindows); `win.expectStart` is the verified
 *  start. Resolves a reason when nothing was stopped (refused or not held). */
export async function stopProcess(
  pid: number,
  sig: "SIGTERM" | "SIGKILL",
  platform: NodeJS.Platform = process.platform,
  win?: { expectStart: number; familyRoots?: readonly string[]; onLeftover?: (procs: LeftoverProc[]) => void }
): Promise<string | undefined> {
  if (platform === "win32") {
    if (win === undefined) return "SessionDeck could not verify which process runs it";
    const r = await stopTreeWindows(pid, win.expectStart, { protectedPids: [process.pid, process.ppid], familyRoots: win.familyRoots });
    if (r.refused !== undefined) return `${r.refused}. Nothing was stopped`;
    win.onLeftover?.(windowsLeftovers(r.results, pid));
    const self = r.results.find((x) => x.pid === pid);
    if (self === undefined) return "the stop did not report on it";
    if (self.result === "changed") return `pid ${pid} now belongs to a different process`;
    if (self.result === "denied") return "Windows did not allow SessionDeck to stop it (its child processes may have been stopped)";
    return undefined;
  }
  try {
    process.kill(pid, sig);
  } catch {
    // already gone: the exit wait decides
  }
  return undefined;
}

/** Descendants of `target` the Windows stop could not end: access denied, or
 *  still there after the kill. */
export function windowsLeftovers(results: readonly { pid: number; result: string; name?: string }[], target: number): LeftoverProc[] {
  return results
    .filter((x) => x.pid !== target && (x.result === "denied" || x.result === "running"))
    .map((x) => ({ pid: x.pid, name: x.name ?? "unknown program" }));
}

/** How long a fallback terminal's shell may take to report shell integration
 *  before SessionDeck gives up and shows the command instead. */
export const SHELL_READY_MS = 15_000;

/** The parts of vscode.window a resume uses (tests pass their own). */
export interface TerminalApi {
  createTerminal(options: vscode.TerminalOptions): vscode.Terminal;
  onDidChangeTerminalShellIntegration?: vscode.Event<vscode.TerminalShellIntegrationChangeEvent>;
}

/** Wait up to `ms` for `terminal`'s shell integration; undefined when it never
 *  comes (no integration, or a shell rc file still waiting for input). */
function shellReady(terminal: vscode.Terminal, api: TerminalApi, ms: number): Promise<vscode.TerminalShellIntegration | undefined> {
  const now = (terminal as { shellIntegration?: vscode.TerminalShellIntegration }).shellIntegration;
  if (now !== undefined) return Promise.resolve(now);
  if (api.onDidChangeTerminalShellIntegration === undefined) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(undefined);
    }, ms);
    const sub = api.onDidChangeTerminalShellIntegration!((e) => {
      if (e.terminal !== terminal) return;
      clearTimeout(timer);
      sub.dispose();
      resolve(e.shellIntegration);
    });
  });
}

/** Start the session here. A Claude tab opens through the Claude Code extension.
 *  A terminal runs the CLI itself as its process (`launch`): no shell, so no rc
 *  file can swallow or delay the command, and the terminal ends when the CLI
 *  exits. Without a known executable the terminal gets a shell, and the command
 *  goes in only through shell integration once the shell reports ready; it is
 *  never typed blind. Throws when the session could not be started. */
export async function resumeHere(
  s: MoveSubject,
  target: MoveTarget,
  api: TerminalApi = vscode.window,
  waitMs = SHELL_READY_MS,
  checks: { usable: (l: LaunchSpec) => boolean; onPath: () => LaunchSpec | undefined } = {
    usable: launchUsable,
    onPath: () => pathLaunch(s.tool),
  }
): Promise<{ terminal: vscode.Terminal; direct: boolean } | undefined> {
  if (target === "claudeTab") {
    await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND, s.id);
    return undefined;
  }
  const cmd = resumeCommand(s.tool, s.id);
  if (cmd === undefined) throw new Error("unexpected session id");
  const env: Record<string, string> = {};
  if (s.tool === "claude" && s.homeDir !== undefined && !isDefaultClaudeHome(s.homeDir)) {
    env.CLAUDE_CONFIG_DIR = s.homeDir;
  }
  // Codex finds a session only in the home it was written to, and that home
  // carries the login: point the resume at it.
  if (s.tool === "codex" && s.codexHome !== undefined) env.CODEX_HOME = s.codexHome;
  const name = s.title.length > 40 ? `${s.title.slice(0, 39)}…` : s.title;
  // An editor tab, not the bottom panel. Every later lookup (focus, the ↗ badge,
  // Stop) goes through window.terminals and the shell pid, which hold for
  // editor-area terminals too, and Terminal.show() reveals the tab. Read here,
  // not at module load: a few callers import this module without the vscode API.
  const location = vscode.TerminalLocation.Editor;
  // Re-checked now, after the stop: the program may have been replaced or
  // removed (an update) since it was captured. Then PATH, then the shell.
  let launch = s.launch !== undefined && checks.usable(s.launch) ? s.launch : undefined;
  if (launch === undefined) {
    const found = checks.onPath();
    if (found !== undefined && checks.usable(found)) launch = found;
  }
  if (launch !== undefined) {
    const terminal = api.createTerminal({
      name,
      cwd: s.cwd,
      env,
      location,
      shellPath: launch.exe,
      shellArgs: [...launch.args, ...resumeArgs(s.tool, s.id)],
    });
    terminal.show();
    return { terminal, direct: true };
  }
  const terminal = api.createTerminal({ name, cwd: s.cwd, env, location });
  terminal.show();
  const si = await shellReady(terminal, api, waitMs);
  if (si === undefined) throw new Error(`SessionDeck could not find the ${s.tool} program, and the terminal's shell did not get ready to run it`);
  si.executeCommand(cmd);
  return { terminal, direct: false };
}

/** Can this launch start right now: an executable program, and its script (the
 *  absolute arguments) present as files? */
export function launchUsable(l: LaunchSpec, platform: NodeJS.Platform = process.platform): boolean {
  return executableFile(l.exe, platform) && l.args.every((a) => !(platform === "win32" ? win32 : posix).isAbsolute(a) || fileExists(a));
}

/** Is a resumed session running? Claude: a registry entry for the id whose
 *  process is live (procStart matches), is not the old pid, and registered at or
 *  after the stop. Codex: a live codex process other than the old one holding
 *  the rollout open (the old one is dead, so it holds nothing). */
export async function resumedRunning(s: MoveSubject, sinceMs: number): Promise<boolean> {
  if (s.tool === "claude") {
    const home = s.homeDir ?? join(homedir(), ".claude");
    let files: string[];
    try {
      files = readdirSync(join(home, "sessions"));
    } catch {
      return false;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const pid = Number(f.slice(0, -5));
      if (!Number.isInteger(pid) || pid === s.pid || !processRunning(pid, undefined)) continue;
      const reg = linuxIdentitySources.readRegistry(home, pid) as { sessionId?: unknown; procStart?: unknown; startedAt?: unknown } | undefined;
      if (reg?.sessionId !== s.id) continue;
      if (typeof reg.procStart !== "string") continue;
      // macOS / Windows: a new pid is not in the table cache yet. Wait for its
      // row rather than read the miss as a mismatch, which would end in "not
      // seen, run the command" while the resumed copy is starting.
      if (procHost() !== "linux") await procTable()?.resolve(pid);
      if (identitySources().procStartAgrees(pid, reg.procStart) !== true) continue;
      if (typeof reg.startedAt !== "number" || reg.startedAt < sinceMs) continue;
      return true;
    }
    return false;
  }
  if (s.rolloutPath === undefined) return false;
  const holder = codexHolderPid(s.rolloutPath);
  return holder !== undefined && holder !== s.pid;
}

/** The buttons of a move confirmation, first = default (Enter). VS Code moves
 *  an item marked as the close affordance to the end, so a safe default can't
 *  be Cancel: it is "Leave It Running", a plain item, and VS Code adds its own
 *  Cancel (Escape) after it. */
export function confirmItems(action: string, safeDefault: boolean): { items: vscode.MessageItem[]; go: vscode.MessageItem } {
  const go: vscode.MessageItem = { title: action };
  if (safeDefault) return { items: [{ title: "Leave It Running" }, go], go };
  return { items: [go, { title: "Cancel", isCloseAffordance: true }], go };
}

/** Run a move from the UI. Checks that can fail without side effects (unsafe id,
 *  missing folder, unverified process) run before anything is stopped; one move
 *  per session at a time across the windows on this host (`claimDir`). */
export async function moveSession(s: MoveSubject, claimDir: string): Promise<MoveOutcome> {
  if (resumeCommand(s.tool, s.id) === undefined) {
    void vscode.window.showErrorMessage(`"${s.title}" can't be moved: its session id is not one SessionDeck can resume.`);
    return "cancelled";
  }
  if (!existsSync(s.cwd)) {
    void vscode.window.showErrorMessage(`"${s.title}" can't be moved: its folder ${s.cwd} no longer exists.`);
    return "cancelled";
  }
  if (s.start === undefined) {
    void vscode.window.showErrorMessage(`"${s.title}" can't be moved: SessionDeck could not verify which process runs it.`);
    return "cancelled";
  }
  const choice = {
    setting: moveSetting(),
    tool: s.tool,
    claudeExtension: claudeExtensionInstalled(),
    inThisWindow: inWindow(s.cwd),
    defaultHome: s.homeDir === undefined || isDefaultClaudeHome(s.homeDir),
  };
  const target = chooseMoveTarget(choice);
  const start = s.start;
  s = { ...s, targetNote: moveTargetNote({ ...choice, cwd: s.cwd, target }) };
  // The exact program, captured from the process before it is stopped; PATH
  // only when that fails.
  if (s.launch === undefined) {
    const cap = await captureProcess(s);
    s = { ...s, launch: cap.launch ?? pathLaunch(s.tool), droppedOptions: cap.dropped };
  }
  let resumed: vscode.Terminal | undefined;
  let direct = false;
  const proc = processDeps(s, start);
  const outcome = await withMoveClaim(claimDir, s.id, () =>
    moveFlow(s, target, {
      ...proc,
      resume: async () => {
        const r = await resumeHere(s, target);
        resumed = r?.terminal;
        direct = r?.direct === true;
      },
      resumeEnded: () => {
        const exit = resumed?.exitStatus;
        if (exit === undefined) return undefined;
        return `the terminal running it closed${exit.code !== undefined ? ` (exit code ${exit.code})` : ""}`;
      },
      // Only a terminal whose own process is the CLI says the CLI is running.
      resumeAlive: () => direct && resumed !== undefined && resumed.exitStatus === undefined,
      started: (since) => resumedRunning(s, since),
      error: (m) => void vscode.window.showErrorMessage(m),
      notice: (m) => void vscode.window.showWarningMessage(m),
      info: (m) => void vscode.window.showInformationMessage(m),
    }, process.platform === "win32")
  );
  if (outcome === "busy") {
    void vscode.window.showInformationMessage(busyText(s.title));
    return "cancelled";
  }
  if (outcome === "unavailable") {
    void vscode.window.showErrorMessage(
      `"${s.title}" was not moved: SessionDeck could not write to its storage folder to reserve the move. Nothing was stopped.`
    );
    return "cancelled";
  }
  return outcome.result;
}

/** A move or a stop of this session is already running (they share one claim). */
export function busyText(title: string): string {
  return `SessionDeck is already moving or stopping "${title}".`;
}

/** The process-facing half of Move and Stop: the modal confirmation, liveness,
 *  the identity re-check and the platform stop, bound to one verified subject. */
function processDeps(s: MoveSubject, start: number): StopDeps {
  let leftover: LeftoverProc[] = [];
  return {
    confirm: async (message, detail, action, cancelDefault) => {
      const { items, go } = confirmItems(action, cancelDefault === true);
      return (await vscode.window.showWarningMessage(message, { modal: true, detail }, ...items)) === go;
    },
    running: () => processRunning(s.pid, start),
    identity: () => identityProblem(s, identitySources()),
    signal: (sig) =>
      stopProcess(s.pid, sig, process.platform, {
        expectStart: start,
        familyRoots: editorFamilyRoots(vscode.env.appRoot ?? "", process.execPath),
        onLeftover: (procs) => (leftover = procs),
      }),
    leftover: () => leftover,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    error: (m) => void vscode.window.showErrorMessage(m),
    notice: (m) => void vscode.window.showWarningMessage(m),
  };
}

/** How long the "Stopped" note stays in the status bar. */
const STOPPED_NOTE_MS = 8_000;

/** Run Stop Session from the UI, in the window that shows the confirmation. The
 *  subject must carry a verified start; the same claim as Move keeps a stop and
 *  a move of one session from running at once. Every message is shown here; the
 *  last one is returned too, for a stop asked from another host. */
export async function stopSession(
  s: MoveSubject,
  claimDir: string
): Promise<{ outcome: StopOutcome | "busy" | "unavailable"; message?: string; reason?: string }> {
  let message: string | undefined;
  let reason: string | undefined;
  const say = (show: (m: string) => unknown) => (m: string) => {
    message = m;
    void show(m);
  };
  if (s.start === undefined) {
    reason = "SessionDeck could not verify which process runs it";
    say((m) => vscode.window.showErrorMessage(m))(`"${s.title}" was not stopped: ${reason}.`);
    return { outcome: "changed", message, reason };
  }
  const proc = processDeps(s, s.start);
  const outcome = await withMoveClaim(claimDir, s.id, () =>
    stopFlow(s, {
      ...proc,
      error: say((m) => vscode.window.showErrorMessage(m)),
      notice: say((m) => vscode.window.showWarningMessage(m)),
      info: say((m) => vscode.window.showInformationMessage(m)),
      done: say((m) => vscode.window.setStatusBarMessage(`$(debug-stop) ${m}`, STOPPED_NOTE_MS)),
      reason: (why) => (reason = why),
    }, process.platform === "win32")
  );
  if (outcome === "busy") {
    say((m) => vscode.window.showInformationMessage(m))(busyText(s.title));
    return { outcome, message, reason: "a move or stop of it is already running" };
  }
  if (outcome === "unavailable") {
    reason = "SessionDeck could not write to its storage folder to reserve the stop";
    say((m) => vscode.window.showErrorMessage(m))(`"${s.title}" was not stopped: ${reason}.`);
    return { outcome, message, reason };
  }
  return { outcome: outcome.result, message, reason };
}
