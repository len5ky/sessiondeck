// Optional click-to-navigate feature. Entirely self-contained: extension.ts only
// constructs a Navigator when sessionDeck.enableNavigation is true, and every
// external dependency (Claude extension command, editor CLI, shared-file relay)
// degrades to a no-op on failure — so the extension ships fine without any of it.
import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { FSWatcher, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { delimiter, join, posix, sep, win32 } from "node:path";
import { tmpdir } from "node:os";
import { SessionRow } from "./discovery";
import { ConfigHome } from "./homes";
import { composerFocusPlan } from "./cursor";
import { ancestryOfPid, pidAlive } from "./procs";
import { CLAUDE_EXTENSION_ID, CLAUDE_OPEN_COMMAND, findLocalTerminal, focusLocalTerminal } from "./injector";

const REQUEST_FILE = "focus-request.json";
const CURSOR_REQUEST_FILE = "cursor-focus-request.json";
const REQUEST_TTL_MS = 10_000;
/** The receiving window's answers to a FocusRequest: first `{ nonce, ack: true }`
 *  the moment it takes the request, then `{ nonce, shown, raised?, detail? }`
 *  once it is done. */
const REPLY_FILE = "focus-reply.json";
/** One request and one reply file per hand-off (`focus-request-<nonce>.json`,
 *  `focus-reply-<nonce>.json`), so two hand-offs in flight never overwrite each
 *  other. The single REQUEST_FILE / REPLY_FILE are still written for windows
 *  on older builds, which know only those. */
const NONCE_RE = /^[0-9a-z]{1,32}$/;
const PER_REQUEST_RE = /^focus-request-([0-9a-z]{1,32})\.json$/;
const requestFileFor = (nonce: string): string => `focus-request-${nonce}.json`;
const replyFileFor = (nonce: string): string => `focus-reply-${nonce}.json`;
/** Created exclusively by the one window that acts on a hand-off (a receiver,
 *  or the sender falling back to opening the tab itself): whoever fails to
 *  create it stands down, so a late window never opens a second tab. */
const claimFileFor = (nonce: string): string => `focus-claim-${nonce}.json`;
/** How long the windows that hold a hand-off's folder wait for each other
 *  before the deepest (then lowest id) acts. */
const ELECTION_MS = 150;
/** The longest a window waits to learn whether its extension host started a
 *  session's process (a process-table query on macOS / Windows; the result is
 *  cached, and the tree has usually asked for it already). Past this the owner
 *  is unknown and the folder rules decide, as before. Kept well inside
 *  HANDOFF_ACK_MS so a receiver that looks it up still answers in time. */
export const OWNER_LOOKUP_MS = 1_000;
const WINDOW_ID_RE = /^w[0-9a-z]{1,16}$/;
/** Per-hand-off files older than this are deleted by the next hand-off. */
const HANDOFF_FILE_TTL_MS = 60_000;
/** How long a hand-off waits for a window to take the request before it falls
 *  back to raising the folder's window with the editor CLI itself (a window on
 *  an older SessionDeck takes a request without saying so). */
export const HANDOFF_ACK_MS = 2_000;
/** How long a hand-off waits for the final answer once a window took it: that
 *  window may run the editor CLI to come to the front (up to CLI_WAIT_MS). */
export const HANDOFF_CONFIRM_MS = 10_000;
const HANDOFF_POLL_MS = 100;
/** Time kept back before the poster's deadline to post the report. */
const REPORT_MARGIN_MS = 1_000;
/** When a step must be done for its report to reach the poster in time. */
const reportBy = (deadline: number | undefined): number | undefined => (deadline !== undefined ? deadline - REPORT_MARGIN_MS : undefined);

/** Cursor-only workbench commands (absent in plain VS Code → executeCommand
 *  throws, which every caller treats as "not a Cursor window" and degrades).
 *  `focusComposer` reveals the agent pane; with a composerId it switches to that
 *  specific tab. `getOrderedSelectedComposerIds` returns the window's open-tab ids
 *  (plain string[], serializable across the extension-host boundary). Verified
 *  against the Cursor 2026-07 desktop bundle. */
const COMPOSER_FOCUS_COMMAND = "composer.focusComposer";
const COMPOSER_SELECTED_IDS_COMMAND = "composer.getOrderedSelectedComposerIds";

export interface CursorNavTarget {
  cwd: string;
  /** "composer" = Cursor GUI agent (open its pane/tab); "cli" = cursor-agent
   *  terminal session (focus its integrated terminal). */
  kind: "composer" | "cli";
  /** Composer conversation id, when known (composer targets only). */
  composerId?: string;
  /** Live cursor-agent pid (cli targets only), for terminal-ancestry matching. */
  pid?: number;
}

interface FocusRequest {
  cwd: string;
  sessionId: string;
  entrypoint?: string;
  /** Session pid, so a relayed window can match the integrated terminal by ancestry. */
  sessionPid: number;
  ts: number;
  nonce: string;
  /** The window that takes it brings itself to the front (absent from windows
   *  older than this field: they show the session and leave raising to us). */
  raise?: boolean;
  /** Past this (same host, same clock) the taker does nothing visible. */
  deadline?: number;
  /** Sent by a window that holds the folder but whose extension host did not
   *  start the session: only a window that did (or cannot tell) may take it, so
   *  that when none did, the sender opens it itself as before. */
  ownerOnly?: boolean;
}

/** A reply in REPLY_FILE for one request. */
export interface FocusReply {
  ack?: boolean;
  shown?: boolean;
  raised?: boolean;
  detail?: string;
}

interface CursorFocusRequest {
  cwd: string;
  kind: "composer" | "cli";
  composerId?: string;
  sessionPid?: number;
  ts: number;
  nonce: string;
}

/** What a navigate() call did. `window` = another window was asked to show it and
 *  raised; `tab` / `terminal` = shown in this window (`unraised`: it could not
 *  be brought to the front, with why). */
export type NavOutcome =
  | { ok: true; how: "tab" | "terminal"; unraised?: string }
  /** `confirmed`: the window that got it said it showed the session. Absent when
   *  it did not answer in time (a window on an older SessionDeck never does). */
  | { ok: true; how: "window"; confirmed?: boolean; unraised?: string }
  | { ok: false; reason: "no-window" | "no-tab" | "no-terminal" | "cli-failed" | "expired" | "handoff-failed"; detail?: string };

/** `until`: the CLI run (and its retry) must be over by then. */
export type CliRun = (folder: string, until?: number) => Promise<{ ok: true } | { ok: false; reason: string }>;

/** Test seams: the window's folders and the editor CLI. */
export interface NavigatorDeps {
  folders?: () => readonly string[];
  /** The workspace file of a multi-root window, when it has one on disk. */
  workspaceFile?: () => string | undefined;
  runCli?: CliRun;
  /** Parent pids of a process (nearest first), or undefined when unknown. */
  ancestry?: (pid: number) => Promise<readonly number[] | undefined>;
  /** This window's extension host pid. */
  hostPid?: number;
  /** This window's integrated terminal running `pid` (its shell is `pid` or an
   *  ancestor), not yet revealed; undefined when it has none. */
  findTerminal?: (pid: number) => Promise<{ show(): void } | undefined>;
}

/** Did this window's extension host start the session's process? Claude Code
 *  spawns `claude` under the extension host of the window that shows its tab,
 *  so that window is the one to show it. "unknown": no live pid, no ancestry,
 *  or the lookup took too long. */
export type Ownership = "here" | "elsewhere" | "unknown";

export function ownershipOf(chain: readonly number[] | undefined, hostPid: number): Ownership {
  if (chain === undefined || chain.length === 0) return "unknown";
  return chain.includes(hostPid) ? "here" : "elsewhere";
}

export function navigationEnabled(): boolean {
  return vscode.workspace.getConfiguration("sessionDeck").get<boolean>("enableNavigation", true);
}

export class Navigator implements vscode.Disposable {
  private watcher: FSWatcher | undefined;
  /** Requests this window already took (fs.watch fires several events per
   *  write, and a new sender writes two request files). Bounded. */
  private readonly handledNonces = new Set<string>();
  private handledCursorNonce = "";
  /** Requests this window wrote: its own watcher must not take them. */
  private readonly sentNonces = new Set<string>();
  private readonly requestPath: string;
  private readonly cursorRequestPath: string;
  private readonly replyPath: string;
  private readonly storageDir: string;
  /** This window's id in hand-off elections. */
  private readonly windowId = "w" + Math.random().toString(36).slice(2, 12);
  private homes: ConfigHome[] = [];

  /** storageDir must be shared across windows: use context.globalStorageUri (same
   *  path in every window attached to this cursor-server). */
  constructor(
    storageDir: string,
    private readonly deps: NavigatorDeps = {}
  ) {
    this.requestPath = join(storageDir, REQUEST_FILE);
    this.cursorRequestPath = join(storageDir, CURSOR_REQUEST_FILE);
    this.replyPath = join(storageDir, REPLY_FILE);
    this.storageDir = storageDir;
    try {
      mkdirSync(storageDir, { recursive: true });
      this.watcher = watch(storageDir, (_event, filename) => {
        if (filename === REQUEST_FILE) void this.handleRequest(this.requestPath);
        const per = typeof filename === "string" ? PER_REQUEST_RE.exec(filename) : null;
        if (per !== null) void this.handleRequest(join(storageDir, filename as string));
        if (filename === CURSOR_REQUEST_FILE) void this.handleCursorRequest();
      });
    } catch {
      // relay unavailable; same-window navigation still works
    }
  }

  /** Config homes whose ide/ dirs are scanned to map a session cwd to an open
   *  window; refreshed by the extension as the home set changes. */
  setHomes(homes: ConfigHome[]): void {
    this.homes = homes;
  }

  dispose(): void {
    this.watcher?.close();
  }

  /** Show a session: its tab or terminal in this window, or hand it to the window
   *  that has its folder open, which shows it and comes to the front. `raise`
   *  also brings THIS window to the front when the session is here (a request
   *  from another host: the user is looking at a different window), and waits for
   *  the other window's answer when it is not. Not ok = nothing was shown; the
   *  caller may fall back to the preview. */
  async navigate(row: SessionRow, opts: { raise?: boolean; deadline?: number } = {}): Promise<NavOutcome> {
    const { cwd, sessionId, entrypoint, pid } = row.meta;
    // A request from another host whose poster has stopped waiting: re-checked
    // right before anything visible happens, so a window never switches after
    // the user was told nobody answered.
    const late = (): boolean => opts.deadline !== undefined && Date.now() > opts.deadline;
    if (late()) return { ok: false, reason: "expired" };
    // The same rule as the companion's routing and the hand-off receiver: a
    // session in a subfolder of this window's folder is this window's.
    const here = this.folderHolding(cwd);
    if (here !== undefined) {
      const raiseHere = async (shown: NavOutcome): Promise<NavOutcome> => {
        if (!shown.ok || opts.raise !== true) return shown;
        if (late()) return { ok: false, reason: "expired" };
        const raised = await this.runCli(this.raiseTarget(here), reportBy(opts.deadline));
        return raised.ok ? shown : { ok: false, reason: "cli-failed", detail: raised.reason };
      };
      // Only the Claude extension's own sessions have an editor tab. Every other
      // entrypoint (cli, sdk-cli, sdk-ts, …) runs in a terminal or an app: reveal the
      // integrated-terminal tab whose shell is an ancestor of the session pid.
      if (!hasEditorTab(entrypoint)) {
        const terminal = await this.findTerminal(pid);
        if (terminal !== undefined) {
          if (late()) return { ok: false, reason: "expired" };
          terminal.show();
          return raiseHere({ ok: true, how: "terminal" });
        }
        // Another window on this folder may have it: a terminal's process runs
        // under the editor's shared pty host, not under either window's extension
        // host, so holding the folder says nothing about which window has it. Ask
        // the other windows (the one with the terminal takes it); "no terminal"
        // only when none does within the ack window.
        return this.handOff(row, opts.raise === true, opts.deadline, async () => ({ ok: false, reason: "no-terminal" }));
      }
      const showHere = async (): Promise<NavOutcome> => {
        if (late()) return { ok: false, reason: "expired" };
        return raiseHere((await this.openTabHere(sessionId, entrypoint)) ? { ok: true, how: "tab" } : { ok: false, reason: "no-tab" });
      };
      // Another window on this folder may be the one showing the tab (its
      // extension host started the session): opening it here would make Claude
      // Code open a second tab. Hand it over; if nobody takes it, open it here.
      if ((await this.ownership(pid, reportBy(opts.deadline))) === "elsewhere") {
        return this.handOff(row, opts.raise === true, opts.deadline, showHere);
      }
      return showHere();
    }
    // Not this window's folder, but a terminal session's own terminal may be here.
    const mine = hasEditorTab(entrypoint) ? undefined : await this.findTerminal(pid);
    if (mine !== undefined) {
      mine.show();
      if (opts.raise !== true) return { ok: true, how: "terminal" };
      const own = this.raiseTarget(this.folders()[0]);
      if (own === undefined) return { ok: true, how: "terminal", unraised: "this window has no folder to bring up" };
      const raised = await this.runCli(own, reportBy(opts.deadline));
      return raised.ok ? { ok: true, how: "terminal" } : { ok: false, reason: "cli-failed", detail: raised.reason };
    }
    return this.handOff(row, opts.raise === true, opts.deadline);
  }

  /** Hand the session to the window that has its folder open: write the request
   *  every window watches; the one that has the folder (or the session's
   *  terminal) answers at once, shows it and brings itself up with the editor CLI.
   *  When nobody takes it within HANDOFF_ACK_MS (a window on an older SessionDeck
   *  takes requests without answering), raise the folder an ide lock file names
   *  with the CLI. The lock lookup is only that hint: no hint and no taker is
   *  "nobody has it open", never a guess. `wait` = report the final answer (a
   *  request from another host), else return once a window took it.
   *  `fallback` (this window holds the folder, but another window's extension
   *  host started the session, or the session's terminal is not here): when no
   *  window takes it, claim the hand-off and return what `fallback` does (show
   *  the tab here; "no terminal") instead of using the lock hint; windows on
   *  older builds are not asked, so they cannot act too. */
  private async handOff(row: SessionRow, wait: boolean, deadline: number | undefined, fallback?: () => Promise<NavOutcome>): Promise<NavOutcome> {
    const { cwd, sessionId, entrypoint, pid } = row.meta;
    const request: FocusRequest = {
      cwd,
      sessionId,
      entrypoint,
      sessionPid: pid,
      ts: Date.now(),
      nonce: Math.random().toString(36).slice(2),
      raise: true,
      ...(fallback !== undefined ? { ownerOnly: true } : {}),
      ...(deadline !== undefined ? { deadline } : {}),
    };
    const hint = bestOpenFolder(cwd, this.homes);
    this.sentNonces.add(request.nonce);
    this.pruneHandoffFiles();
    try {
      writeFileSync(join(this.storageDir, requestFileFor(request.nonce)), JSON.stringify(request));
      // Older windows read only the single file.
      if (fallback === undefined) {
        try {
          writeFileSync(this.requestPath, JSON.stringify(request));
        } catch {
          // the new windows still have the per-request file
        }
      }
    } catch {
      if (fallback !== undefined) return fallback();
      if (hint === undefined) return { ok: false, reason: "handoff-failed", detail: "could not pass the request to its other windows" };
      const raised = await this.runCli(hint, reportBy(deadline));
      if (!raised.ok) return { ok: false, reason: "cli-failed", detail: raised.reason };
      return { ok: false, reason: "handoff-failed", detail: "brought up the window that has its folder open, but could not pass it the request" };
    }
    try {
      return await this.followHandOff(request, hint, wait, deadline, fallback);
    } finally {
      // The claim stays (pruned after HANDOFF_FILE_TTL_MS): a window that reaches
      // this request late must still find it taken.
      for (const f of [requestFileFor(request.nonce), replyFileFor(request.nonce)]) rmSync(join(this.storageDir, f), { force: true });
      this.removeCandidates(request.nonce);
      this.sentNonces.delete(request.nonce);
    }
  }

  /** The rest of handOff, once the request is written: wait for a taker, fall
   *  back to the lock hint, and read the answer. */
  private async followHandOff(
    request: FocusRequest,
    hint: string | undefined,
    wait: boolean,
    deadline: number | undefined,
    fallback: (() => Promise<NavOutcome>) | undefined
  ): Promise<NavOutcome> {
    const { entrypoint } = request;
    const stopAt = (ms: number): number => Math.min(Date.now() + ms, deadline !== undefined ? deadline - REPORT_MARGIN_MS : Number.POSITIVE_INFINITY);
    const taken = (r: FocusReply): boolean => r.ack === true || r.shown !== undefined;
    let reply = await this.awaitReply(request.nonce, stopAt(HANDOFF_ACK_MS), taken);
    if (fallback !== undefined) {
      if (reply === undefined) {
        // Nobody answered: show it here (as before this hand-off existed), unless
        // a window claimed it just now, in which case its answer is coming.
        if (this.claim(request.nonce) !== "lost") return fallback();
        reply = await this.awaitReply(request.nonce, stopAt(HANDOFF_ACK_MS), taken);
        if (reply === undefined) return { ok: true, how: "window" };
      }
      hint = undefined; // the window that took it raises itself; no lock guess
    }
    let raisedHere = false;
    const raiseHint = async (): Promise<NavOutcome | undefined> => {
      if (hint === undefined || raisedHere) return undefined;
      if (deadline !== undefined && Date.now() > deadline) return { ok: false, reason: "expired" };
      raisedHere = true;
      const raised = await this.runCli(hint, reportBy(deadline));
      return raised.ok ? undefined : { ok: false, reason: "cli-failed", detail: raised.reason };
    };
    if (reply === undefined) {
      if (hint === undefined) return { ok: false, reason: hasEditorTab(entrypoint) ? "no-window" : "no-terminal" };
      const failed = await raiseHint();
      if (failed !== undefined) return failed;
    }
    if (!wait) {
      // A window from before `raise` showed it without coming up: raise it here.
      if (reply !== undefined && isLegacyShown(reply)) {
        const failed = await raiseHint();
        if (failed !== undefined) return failed;
      }
      return { ok: true, how: "window" };
    }
    if (reply?.shown === undefined) reply = await this.awaitReply(request.nonce, stopAt(HANDOFF_CONFIRM_MS), (r) => r.shown !== undefined);
    if (reply?.shown === undefined) return { ok: true, how: "window" };
    if (!reply.shown) return { ok: false, reason: hasEditorTab(entrypoint) ? "no-tab" : "no-terminal", detail: reply.detail };
    if (reply.raised === false) return { ok: false, reason: "cli-failed", detail: reply.detail };
    if (isLegacyShown(reply)) {
      // Builds between 0.42.5 and this change answer { nonce, shown } and never
      // raise their window: the tab opened behind whatever is in front.
      if (hint === undefined && !raisedHere) {
        return { ok: true, how: "window", confirmed: true, unraised: "it is on a SessionDeck build that does not bring its window up, and no Claude Code lock file names that window's folder" };
      }
      const failed = await raiseHint();
      if (failed !== undefined) return failed;
    }
    return { ok: true, how: "window", confirmed: true };
  }

  /** Cursor sibling of navigate(): open a Cursor GUI composer or cursor-agent CLI
   *  session. Same-window → act directly; another window → relay via the shared
   *  file and raise the owning window. Returns false only when there's nothing we
   *  can honestly do (unknown workspace, or the Cursor commands are absent), so
   *  the caller can fall back to its info-message preview. */
  async navigateCursor(target: CursorNavTarget): Promise<boolean> {
    if (target.cwd === "") return false; // unknown workspace — can't route honestly
    if (this.inThisWindow(target.cwd)) return this.openCursorHere(target);
    const request: CursorFocusRequest = {
      cwd: target.cwd,
      kind: target.kind,
      composerId: target.composerId,
      sessionPid: target.pid,
      ts: Date.now(),
      nonce: Math.random().toString(36).slice(2),
    };
    try {
      writeFileSync(this.cursorRequestPath, JSON.stringify(request));
    } catch {
      // relay write failed; still try to focus the window
    }
    void this.focusWindow(target.cwd);
    return true;
  }

  /** Act on a Cursor session that lives in THIS window. */
  private async openCursorHere(target: CursorNavTarget): Promise<boolean> {
    if (target.kind === "cli") {
      // Terminal session: reveal the integrated-terminal tab whose shell is an
      // ancestor of the agent pid (same mechanism as Claude cli sessions).
      return target.pid !== undefined ? focusLocalTerminal(target.pid) : false;
    }
    return this.openComposerPaneHere(target.composerId);
  }

  /** Reveal Cursor's agent (composer) pane, switching to the specific conversation
   *  tab when it's an open tab in this window (composerFocusPlan guards the id). */
  private async openComposerPaneHere(composerId: string | undefined): Promise<boolean> {
    if (composerId !== undefined) {
      try {
        const open = await vscode.commands.executeCommand<unknown>(COMPOSER_SELECTED_IDS_COMMAND);
        const ids = Array.isArray(open) ? open.filter((v): v is string => typeof v === "string") : [];
        if (composerFocusPlan(ids, composerId) === "tab") {
          await vscode.commands.executeCommand(COMPOSER_FOCUS_COMMAND, composerId);
          return true;
        }
      } catch {
        // command absent (plain VS Code) or query failed — try the pane below
      }
    }
    try {
      await vscode.commands.executeCommand(COMPOSER_FOCUS_COMMAND);
      return true;
    } catch {
      return false; // not a Cursor window — caller shows its preview instead
    }
  }

  private async handleCursorRequest(): Promise<void> {
    let request: CursorFocusRequest;
    try {
      request = JSON.parse(readFileSync(this.cursorRequestPath, "utf8")) as CursorFocusRequest;
    } catch {
      return;
    }
    if (request.nonce === this.handledCursorNonce) return; // fs.watch fires repeatedly per write
    if (Date.now() - request.ts > REQUEST_TTL_MS) return;
    if (!this.inThisWindow(request.cwd)) return;
    this.handledCursorNonce = request.nonce;
    await this.openCursorHere({
      cwd: request.cwd,
      kind: request.kind,
      composerId: request.composerId,
      pid: request.sessionPid,
    });
  }

  private inThisWindow(cwd: string): boolean {
    return this.folderHolding(cwd) !== undefined;
  }

  private folders(): readonly string[] {
    if (this.deps.folders !== undefined) return this.deps.folders();
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  /** This window's innermost workspace folder that is `cwd` or holds it
   *  (Windows: any drive-letter case, separator or trailing separator), or
   *  undefined. */
  private folderHolding(cwd: string): string | undefined {
    let best: string | undefined;
    for (const f of this.folders()) if (folderContains(f, cwd) && (best === undefined || f.length > best.length)) best = f;
    return best;
  }

  /** What to give the editor CLI so that it raises THIS window: its workspace file
   *  when it has one (a folder of a multi-root workspace could open a new window),
   *  else its folder. */
  private raiseTarget(folder: string): string;
  private raiseTarget(folder: string | undefined): string | undefined;
  private raiseTarget(folder: string | undefined): string | undefined {
    if (folder === undefined) return undefined;
    return this.workspaceFile() ?? folder;
  }

  private workspaceFile(): string | undefined {
    if (this.deps.workspaceFile !== undefined) return this.deps.workspaceFile();
    const f = vscode.workspace.workspaceFile;
    return f !== undefined && f.scheme === "file" ? f.fsPath : undefined;
  }

  private async openTabHere(sessionId: string, entrypoint?: string): Promise<boolean> {
    if (!hasEditorTab(entrypoint)) return false; // terminal or app session: no tab to reveal
    if (vscode.extensions.getExtension(CLAUDE_EXTENSION_ID) === undefined) return false;
    try {
      await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND, sessionId);
      return true;
    } catch {
      return false;
    }
  }

  /** Take a hand-off from another window when the session is ours: a Claude tab
   *  session when this window has its folder open, a terminal session when its
   *  terminal is here. Answers at once (`ack`), shows it, brings this window up
   *  when asked, then answers with the outcome. Not ours: no answer at all, so
   *  the window that has it is the one that answers. */
  private async handleRequest(path: string): Promise<void> {
    let request: FocusRequest;
    try {
      request = JSON.parse(readFileSync(path, "utf8")) as FocusRequest;
    } catch {
      return;
    }
    if (typeof request?.nonce !== "string" || !NONCE_RE.test(request.nonce) || typeof request.cwd !== "string") return;
    if (this.handledNonces.has(request.nonce)) return; // fs.watch fires multiple events per write
    if (this.sentNonces.has(request.nonce)) return; // our own request
    if (Date.now() - request.ts > REQUEST_TTL_MS) return;
    const late = (): boolean => typeof request.deadline === "number" && Date.now() > request.deadline;
    if (late()) return;
    const tab = hasEditorTab(request.entrypoint);
    const folder = this.folderHolding(request.cwd);
    if (tab && folder === undefined) return;
    const seenAt = Date.now();
    this.handledNonces.add(request.nonce);
    if (this.handledNonces.size > 64) this.handledNonces.delete(this.handledNonces.values().next().value as string);
    const legacySender = request.raise !== true; // an older window waits on the single reply file
    let shown: boolean;
    if (tab) {
      // Two windows can hold the folder (the same folder, or nested ones): only
      // one may open the tab and come up, the one whose extension host started
      // the session when that is known.
      const owner = await this.ownership(request.sessionPid, typeof request.deadline === "number" ? request.deadline : undefined);
      // The sender holds the folder too and knows it did not start the session:
      // a window that knows it did not either stays out, no entry and no claim.
      if (request.ownerOnly === true && owner === "elsewhere") return;
      if (!(await this.winsHandoff(request.nonce, folder as string, owner, seenAt))) return;
      // The election took time: past the deadline the clicker was already told
      // nobody answered, so open nothing.
      if (late()) return;
      // A late window, or the sender that gave up waiting and shows it itself,
      // may have claimed it first.
      if (this.claim(request.nonce) === "lost") return;
      this.reply(request.nonce, { ack: true }, legacySender);
      shown = await this.openTabHere(request.sessionId, request.entrypoint);
    } else {
      // Only the window that has the terminal answers. A terminal is in one
      // window only, so there is no election; the claim keeps it from revealing
      // after the sender gave up and reported that no window has it.
      const terminal = await this.findTerminal(request.sessionPid);
      if (terminal === undefined || late()) return;
      if (this.claim(request.nonce) === "lost") return;
      this.reply(request.nonce, { ack: true }, legacySender);
      terminal.show();
      shown = true;
    }
    const answer: FocusReply = { shown };
    if (shown && request.raise === true) {
      const target = this.raiseTarget(folder ?? this.folders()[0]);
      if (target === undefined) {
        answer.raised = false;
        answer.detail = "the window that has it has no folder to bring up";
      } else if (late()) {
        answer.raised = false;
        answer.detail = "the request reached it after you stopped waiting, so it did not switch";
      } else {
        // Done in time for the sender, which stops waiting a margin before the deadline.
        const raised = await this.runCli(target, typeof request.deadline === "number" ? request.deadline - 2 * REPORT_MARGIN_MS : undefined);
        answer.raised = raised.ok;
        if (!raised.ok) answer.detail = raised.reason;
      }
    }
    this.reply(request.nonce, answer, legacySender);
  }

  /** Answer on the request's own reply file, and on the single file too for a
   *  sender on an older build (it reads only that one). */
  private reply(nonce: string, r: FocusReply, legacySender: boolean): void {
    const doc = JSON.stringify({ nonce, ...r });
    for (const path of legacySender ? [join(this.storageDir, replyFileFor(nonce)), this.replyPath] : [join(this.storageDir, replyFileFor(nonce))]) {
      try {
        writeFileSync(path, doc);
      } catch {
        // no answer: the sender falls back to the editor CLI, or reports it unconfirmed
      }
    }
  }

  /** Among the windows holding a hand-off's folder, is this the one to act? Each
   *  candidate writes `focus-cand-<nonce>-<window>.json` with how deep its
   *  folder holds the cwd and whether its extension host started the session
   *  (`owner`: true, false, or "unknown" when it cannot tell), waits ELECTION_MS
   *  for the others, then picks the winner with `handoffWinner`. A window that
   *  knows it is not the owner waits until an owner still looking its process
   *  up (OWNER_LOOKUP_MS from when the request was seen) has had time to enter.
   *  A window that could not write its entry still counts itself. */
  private async winsHandoff(nonce: string, folder: string, owner: Ownership = "unknown", seenAt: number = Date.now()): Promise<boolean> {
    const depth = normFolder(folder).length;
    const prefix = `focus-cand-${nonce}-`;
    try {
      writeFileSync(join(this.storageDir, `${prefix}${this.windowId}.json`), JSON.stringify({ depth, owner: owner === "here" ? true : owner === "elsewhere" ? false : "unknown" }));
    } catch {
      // still compete with what the others wrote
    }
    const until = owner === "elsewhere" ? Math.max(Date.now() + ELECTION_MS, seenAt + OWNER_LOOKUP_MS + ELECTION_MS) : Date.now() + ELECTION_MS;
    await new Promise((r) => setTimeout(r, until - Date.now()));
    const entries: HandoffCandidate[] = [{ id: this.windowId, depth, owner }];
    try {
      for (const f of readdirSync(this.storageDir)) {
        if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
        const id = f.slice(prefix.length, -".json".length);
        if (!WINDOW_ID_RE.test(id) || id === this.windowId) continue;
        let c: { depth?: unknown; owner?: unknown };
        try {
          c = JSON.parse(readFileSync(join(this.storageDir, f), "utf8")) as { depth?: unknown; owner?: unknown };
        } catch {
          continue;
        }
        if (typeof c?.depth !== "number") continue;
        // No `owner` field at all: a window on a build from before owner routing.
        const them: Ownership | undefined = !("owner" in c) ? undefined : c.owner === true ? "here" : c.owner === false ? "elsewhere" : "unknown";
        entries.push({ id, depth: c.depth, owner: them });
      }
    } catch {
      // nothing to compare with: act
    }
    return handoffWinner(entries) === this.windowId;
  }

  /** Take the one right to act on a hand-off. "lost": another window (or the
   *  sender) has it. "error": the claim could not be written; act anyway, as
   *  before claims existed. */
  private claim(nonce: string): "won" | "lost" | "error" {
    try {
      writeFileSync(join(this.storageDir, claimFileFor(nonce)), this.windowId, { flag: "wx" });
      return "won";
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EEXIST" ? "lost" : "error";
    }
  }

  /** Did this window's extension host start process `pid`? Looked up at most
   *  OWNER_LOOKUP_MS (and never past `until`); the process-table result is
   *  cached, so a later lookup of the same pid is instant. */
  private async ownership(pid: number, until?: number): Promise<Ownership> {
    if (!Number.isInteger(pid) || pid <= 0) return "unknown";
    const budget = Math.min(OWNER_LOOKUP_MS, until !== undefined ? until - Date.now() : OWNER_LOOKUP_MS);
    if (budget <= 0) return "unknown";
    const lookup = this.deps.ancestry !== undefined ? this.deps.ancestry(pid) : ancestryOfPid(pid).then((c) => c?.map((p) => p.pid));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chain = await Promise.race([
      lookup.catch(() => undefined),
      new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), budget);
      }),
    ]);
    clearTimeout(timer);
    return ownershipOf(chain, this.deps.hostPid ?? process.pid);
  }

  private findTerminal(pid: number): Promise<{ show(): void } | undefined> {
    return this.deps.findTerminal !== undefined ? this.deps.findTerminal(pid) : findLocalTerminal(pid);
  }

  private removeCandidates(nonce: string): void {
    try {
      for (const f of readdirSync(this.storageDir)) if (f.startsWith(`focus-cand-${nonce}-`)) rmSync(join(this.storageDir, f), { force: true });
    } catch {
      // pruned later
    }
  }

  /** Delete per-hand-off files left behind (a sender that died, a late reply). */
  private pruneHandoffFiles(): void {
    try {
      const now = Date.now();
      for (const f of readdirSync(this.storageDir)) {
        if (!/^focus-(request|reply|cand|claim)-/.test(f)) continue;
        try {
          if (now - statSync(join(this.storageDir, f)).mtimeMs > HANDOFF_FILE_TTL_MS) rmSync(join(this.storageDir, f), { force: true });
        } catch {
          // gone meanwhile
        }
      }
    } catch {
      // best effort
    }
  }

  /** The first reply for `nonce` that `done` accepts, or undefined at `until`. */
  private async awaitReply(nonce: string, until: number, done: (r: FocusReply) => boolean): Promise<FocusReply | undefined> {
    for (;;) {
      const r = readReply(join(this.storageDir, replyFileFor(nonce)), nonce) ?? readReply(this.replyPath, nonce);
      if (r !== undefined && done(r)) return r;
      if (Date.now() >= until) return undefined;
      await new Promise((res) => setTimeout(res, Math.max(0, Math.min(HANDOFF_POLL_MS, until - Date.now()))));
    }
  }

  /** Bring the target project's window to front (or open it) via the editor CLI.
   *  Verified: opening an already-open folder reuses and focuses its window. */
  private focusWindow(cwd: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.runCli(bestOpenFolder(cwd, this.homes) ?? cwd);
  }

  /** Run the editor CLI on `folder`. Resolves once the CLI has exited (or after
   *  CLI_WAIT_MS, when it is still running and so did start), with the reason a
   *  failed run gives the user. */
  private runCli(folder: string, until?: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.deps.runCli !== undefined) return this.deps.runCli(folder, until);
    return runEditorCli(editorCliCommand(), folder, process.platform, cliLogArgs(), until);
  }
}

/** A "shown" answer from a window that predates `raise` (it never says whether
 *  it came to the front, and does not try). */
/** One window's entry in a hand-off election. `owner` undefined: the entry has
 *  no `owner` field, so it comes from a build before owner routing, which
 *  ranks by depth alone. */
export interface HandoffCandidate {
  id: string;
  depth: number;
  owner: Ownership | undefined;
}

/** The window that acts on a hand-off, computed the same way by every window
 *  on this build so they agree. If the deepest holder (ties to the lowest window
 *  id) is an older-build entry, it wins: that is the rule the older build
 *  applies, so it acts and every newer window stands down. Otherwise the older
 *  entries stand down by their own rule, and among the entries that carry
 *  `owner` the owner beats unknown beats a known non-owner, then the deepest
 *  holder, then the lowest window id. */
export function handoffWinner(entries: readonly HandoffCandidate[]): string | undefined {
  const deeper = (a: HandoffCandidate, b: HandoffCandidate): boolean => (a.depth !== b.depth ? a.depth > b.depth : a.id < b.id);
  let byDepth: HandoffCandidate | undefined;
  for (const e of entries) if (byDepth === undefined || deeper(e, byDepth)) byDepth = e;
  if (byDepth === undefined || byDepth.owner === undefined) return byDepth?.id;
  const rank = (o: Ownership | undefined): number => (o === "here" ? 2 : o === "unknown" ? 1 : 0);
  let best: HandoffCandidate | undefined;
  for (const e of entries) {
    if (e.owner === undefined) continue;
    if (best === undefined || (rank(e.owner) !== rank(best.owner) ? rank(e.owner) > rank(best.owner) : deeper(e, best))) best = e;
  }
  return best?.id;
}

export function isLegacyShown(r: FocusReply): boolean {
  return r.shown === true && r.raised === undefined;
}

/** A reply file's answer for `nonce`, or undefined (missing, unreadable, or an
 *  answer to another request). */
export function readReply(path: string, nonce: string): FocusReply | undefined {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (r === null || typeof r !== "object" || r.nonce !== nonce) return undefined;
    const out: FocusReply = {};
    if (r.ack === true) out.ack = true;
    if (typeof r.shown === "boolean") out.shown = r.shown;
    if (typeof r.raised === "boolean") out.raised = r.raised;
    if (typeof r.detail === "string") out.detail = r.detail.slice(0, 300);
    return out;
  } catch {
    return undefined;
  }
}

/** True only for sessions the Claude Code extension owns (they have an editor
 *  tab). The tree labels everything else "terminal"; navigation must agree. */
export function hasEditorTab(entrypoint: string | undefined): boolean {
  return entrypoint === "claude-vscode";
}

/** Map a session cwd to the workspace folder of an open IDE window using each
 *  home's ide/*.lock, so a session running in a subdirectory focuses the
 *  containing window instead of opening a new one on the subdirectory. */
export function bestOpenFolder(cwd: string, homes: ConfigHome[]): string | undefined {
  let best: string | undefined;
  for (const home of homes) {
    try {
      const dir = join(home.dir, "ide");
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".lock")) continue;
        let lock: { workspaceFolders?: string[]; pid?: unknown };
        try {
          lock = JSON.parse(readFileSync(join(dir, f), "utf8")) as { workspaceFolders?: string[]; pid?: unknown };
        } catch {
          continue;
        }
        // A lock left behind by a closed window names a folder nobody has open.
        if (typeof lock.pid === "number" && !pidAlive(lock.pid)) continue;
        for (const folder of lock.workspaceFolders ?? []) {
          if (!folderContains(folder, cwd)) continue;
          if (best === undefined || folder.length > best.length) best = folder;
        }
      }
    } catch {
      continue;
    }
  }
  return best;
}


/** Resolve the editor CLI used to focus other windows, and which source it came
 *  from. Precedence: explicit `editorCliPath`, then the legacy `cursorCliPath`,
 *  then a default derived from the running editor (appName) so VS Code / Insiders
 *  / VSCodium / Windsurf / Cursor each get the right binary out of the box. */
export function resolveEditorCli(): {
  command: string;
  source: "editorCliPath" | "cursorCliPath" | "default";
} {
  const cfg = vscode.workspace.getConfiguration("sessionDeck");
  const explicit = cfg.get<string>("editorCliPath", "").trim();
  if (explicit !== "") return { command: explicit, source: "editorCliPath" };
  const legacy = cfg.get<string>("cursorCliPath", "").trim();
  if (legacy !== "") return { command: legacy, source: "cursorCliPath" };
  return { command: defaultEditorCli(), source: "default" };
}

function editorCliCommand(): string {
  return resolveEditorCli().command;
}

/** Safe PATH lookup with NO spawn (never launches the editor). A command that
 *  already contains a path separator must exist as a file; a bare name must be an
 *  executable file on some PATH entry (with the usual Windows extensions). */
export function commandOnPath(command: string): boolean {
  if (command === "") return false;
  const isFile = (c: string): boolean => {
    try {
      return statSync(c).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes(sep) || command.includes("/")) return isFile(command);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) if (isFile(join(dir, command + ext))) return true;
  }
  return false;
}

function defaultEditorCli(): string {
  const name = (vscode.env.appName ?? "").toLowerCase();
  if (name.includes("cursor")) return "cursor";
  if (name.includes("insiders")) return "code-insiders";
  if (name.includes("vscodium")) return "codium";
  if (name.includes("windsurf")) return "windsurf";
  return "code";
}

// ---- editor CLI and folder matching ------------------------------------
// Path matching and editor-CLI spawning for window switching, with the platform
// passed in so the Windows rules are tested on every OS. vscode-free.
//
// Two Windows facts drive this file:
//  - The editor CLI on Windows is a batch shim (`cursor.cmd`, `code.cmd`). A bare
//    `spawn("cursor", …)` looks only for `cursor.exe` (ENOENT), and Node refuses to
//    spawn a .cmd/.bat file without a shell (EINVAL, since the 2024 fix for
//    CVE-2024-27980). Both errors used to be swallowed, so the window never came up.
//  - Windows paths compare without case, and the same folder arrives as `c:\x`
//    (VS Code's fsPath) or `C:\x\` (a terminal's cwd).

type Platform = NodeJS.Platform;

function pathApi(platform: Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** Normalise a folder for comparison: resolved, no trailing separator, and
 *  lower-cased on Windows. */
export function normFolder(p: string, platform: Platform = process.platform): string {
  const r = pathApi(platform).resolve(p);
  return platform === "win32" ? r.toLowerCase() : r;
}

/** Do two strings name the same folder on `platform`? */
export function sameFolder(a: string, b: string, platform: Platform = process.platform): boolean {
  return normFolder(a, platform) === normFolder(b, platform);
}

/** Is `cwd` the folder itself or somewhere inside it? */
export function folderContains(folder: string, cwd: string, platform: Platform = process.platform): boolean {
  const f = normFolder(folder, platform);
  const c = normFolder(cwd, platform);
  if (f === c) return true;
  const p = pathApi(platform);
  const rel = p.relative(f, c);
  return rel !== "" && !rel.startsWith("..") && !p.isAbsolute(rel);
}

export interface SpawnPlan {
  command: string;
  args: string[];
  options: { detached: boolean; windowsHide: boolean; windowsVerbatimArguments: boolean };
}

/** Characters cmd.exe expands or splits on even inside double quotes. A folder
 *  holding one can't be passed through cmd.exe safely, so we refuse it. */
const CMD_UNSAFE = /["%\r\n]/;

/** How to run the editor CLI on `folder`, or why it can't be run. On Windows a
 *  non-.exe CLI (the usual `cursor` / `code` / `cursor.cmd`) runs through
 *  `cmd.exe /d /s /c ""<cli>" "<folder>""`, each part quoted, so a space in either
 *  is safe. */
export function editorCliSpawnPlan(
  cli: string,
  folder: string,
  platform: Platform = process.platform,
  extra: readonly string[] = []
): { ok: true; plan: SpawnPlan } | { ok: false; reason: string } {
  if (platform !== "win32") {
    return { ok: true, plan: { command: cli, args: [folder, ...extra], options: { detached: true, windowsHide: true, windowsVerbatimArguments: false } } };
  }
  if (/\.exe$/i.test(cli)) {
    return { ok: true, plan: { command: cli, args: [folder, ...extra], options: { detached: false, windowsHide: true, windowsVerbatimArguments: false } } };
  }
  // An extra argument cmd.exe would mangle is left out, never refused for.
  extra = extra.filter((a) => !CMD_UNSAFE.test(a));
  if (CMD_UNSAFE.test(cli) || CMD_UNSAFE.test(folder)) {
    return { ok: false, reason: `the folder path or editor CLI contains a character (" or %) that cannot be passed to ${cli} safely` };
  }
  // The CLI shim hands its arguments to Cursor.exe / Code.exe, which reads
  // backslashes before a quote as escapes: `"c:\\"` would end in a literal quote.
  // Doubling trailing backslashes keeps them literal. /v:off: no delayed
  // expansion, so a `!` in a folder name is passed as is.
  const q = (v: string): string => `"${v.replace(/(\\+)$/, "$1$1")}"`;
  return {
    ok: true,
    plan: {
      command: "cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", `"${[cli, folder, ...extra].map(q).join(" ")}"`],
      options: { detached: false, windowsHide: true, windowsVerbatimArguments: true },
    },
  };
}

/** A failed CLI run, in words a user can act on. `code` is the exit code (9009 is
 *  cmd.exe's "is not recognized"), `errCode` a spawn error code. */
export function editorCliFailure(cli: string, r: { code?: number | null; errCode?: string; signal?: string | null }): string {
  if (r.errCode === "ENOENT" || r.code === 9009) {
    return `the editor CLI "${cli}" was not found; set sessionDeck.editorCliPath to its full path`;
  }
  if (r.errCode !== undefined) return `the editor CLI "${cli}" could not start (${r.errCode})`;
  if (r.signal !== undefined && r.signal !== null) return `the editor CLI "${cli}" was stopped by ${r.signal}`;
  return `the editor CLI "${cli}" exited with code ${r.code}`;
}

const CLI_WAIT_MS = 8_000;
/** A CLI run (or its retry) is started only with at least this long left
 *  before `until`: with less it could not be seen to finish, and a run that
 *  has not finished must not be reported as having raised the window. */
export const CLI_MIN_BUDGET_MS = 1_500;
const CLI_NO_TIME = "there was too little time left before the click stopped waiting to bring that window up";

/** Extra CLI arguments that keep the run from leaving a folder behind. On
 *  Windows every `cursor <folder>` / `code <folder>` starts a short-lived second
 *  instance that creates `<user data>\logs\<timestamp>` (mostly empty) before
 *  passing the folder to the running editor. `--logsPath` is the editor's own
 *  option (VS Code argv OPTIONS; its environment service uses it instead of the
 *  timestamped folder), so every run reuses one folder in the temp dir. The
 *  `--name=value` form can never be read as a second folder to open. */
export function cliLogArgs(platform: Platform = process.platform, tmp: string = tmpdir()): string[] {
  return platform === "win32" ? [`--logsPath=${win32.join(tmp, "sessiondeck-editor-cli-logs")}`] : [];
}

/** Run the editor CLI on `folder`. Resolves once the CLI has exited (or after
 *  CLI_WAIT_MS, when it is still running and so did start), with a reason a user
 *  can act on when it failed. Never rejects. If a run with cliLogArgs fails with
 *  an exit code, it is run once more without them, so an editor that rejects
 *  the option still switches. */
export async function runEditorCli(
  cli: string,
  folder: string,
  platform: NodeJS.Platform = process.platform,
  extra: readonly string[] = cliLogArgs(platform),
  until?: number
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Windows: find the shim ourselves. cmd.exe reports an unknown name only as
  // exit code 1, which would read as a crash rather than "not found".
  let resolved = cli;
  if (platform === "win32" && !/[\\/]/.test(cli)) {
    const found = findOnWindowsPath(cli, process.env.PATH ?? process.env.Path ?? "");
    if (found === undefined) return { ok: false, reason: editorCliFailure(cli, { errCode: "ENOENT" }) };
    resolved = found;
  }
  if (until !== undefined && until - Date.now() < CLI_MIN_BUDGET_MS) return { ok: false, reason: CLI_NO_TIME };
  const first = await spawnCli(cli, resolved, folder, platform, extra, until);
  if (first.ok || extra.length === 0 || first.code === undefined || first.code === 9009) return strip(first);
  // The retry only when there is still time for it to start.
  if (until !== undefined && until - Date.now() < CLI_MIN_BUDGET_MS) return strip(first);
  return strip(await spawnCli(cli, resolved, folder, platform, [], until));
}

type CliRunResult = { ok: true } | { ok: false; reason: string; code?: number };
const strip = (r: CliRunResult): { ok: true } | { ok: false; reason: string } => (r.ok ? r : { ok: false, reason: r.reason });

function spawnCli(cli: string, resolved: string, folder: string, platform: NodeJS.Platform, extra: readonly string[], until?: number): Promise<CliRunResult> {
  const planned = editorCliSpawnPlan(resolved, folder, platform, extra);
  if (!planned.ok) return Promise.resolve({ ok: false, reason: planned.reason });
  const { command, args, options } = planned.plan;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: CliRunResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    // Still running after the full CLI_WAIT_MS = it started: count that as done.
    // Cut short by `until` it has not finished, so it is not counted as raised.
    const waitMs = until !== undefined ? Math.max(0, Math.min(CLI_WAIT_MS, until - Date.now())) : CLI_WAIT_MS;
    const timer = setTimeout(
      () => finish(waitMs >= CLI_WAIT_MS ? { ok: true } : { ok: false, reason: `the editor CLI "${cli}" had not finished when the click stopped waiting` }),
      waitMs
    );
    try {
      const child = spawn(command, args, { ...options, stdio: "ignore" });
      child.on("error", (err: NodeJS.ErrnoException) => finish({ ok: false, reason: editorCliFailure(cli, { errCode: err.code ?? "error" }) }));
      // Only a clean exit counts; killed by a signal (code null) is a failure.
      child.on("exit", (code, signal) =>
        finish(code === 0 ? { ok: true } : { ok: false, reason: editorCliFailure(cli, { code, signal }), ...(code !== null ? { code } : {}) })
      );
      child.unref();
    } catch (err) {
      finish({ ok: false, reason: editorCliFailure(cli, { errCode: (err as NodeJS.ErrnoException).code ?? "error" }) });
    }
  });
}

/** The first `<dir>\\<name><ext>` on a Windows PATH that is a file, trying the
 *  executable extensions in cmd.exe's order. */
export function findOnWindowsPath(
  name: string,
  pathVar: string,
  isFile: (p: string) => boolean = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  }
): string | undefined {
  const exts = /\.[a-z0-9]+$/i.test(name) ? [""] : [".com", ".exe", ".bat", ".cmd"];
  for (const dir of pathVar.split(";")) {
    if (dir.trim() === "") continue;
    for (const ext of exts) {
      const full = win32.join(dir.trim(), name + ext);
      if (isFile(full)) return full;
    }
  }
  return undefined;
}
