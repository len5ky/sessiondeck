// Optional click-to-navigate feature. Entirely self-contained: extension.ts only
// constructs a Navigator when sessionDeck.enableNavigation is true, and every
// external dependency (Claude extension command, editor CLI, shared-file relay)
// degrades to a no-op on failure — so the extension ships fine without any of it.
import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { FSWatcher, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { delimiter, join, relative, isAbsolute, sep } from "node:path";
import { SessionRow } from "./discovery";
import { ConfigHome } from "./homes";
import { composerFocusPlan } from "./cursor";
import { focusLocalTerminal, sendViaLocalTerminal, Step } from "./injector";

/** Undocumented but stable command of anthropic.claude-code: (sessionId?, initialPrompt?, viewColumn?).
 *  With a sessionId it reveals the existing tab for that session, or opens one resuming it. */
const OPEN_SESSION_COMMAND = "claude-vscode.editor.open";
const CLAUDE_EXTENSION_ID = "anthropic.claude-code";
const REQUEST_FILE = "focus-request.json";
const INJECT_FILE = "inject-request.json";
const CURSOR_REQUEST_FILE = "cursor-focus-request.json";
const REQUEST_TTL_MS = 10_000;

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
}

interface InjectRequest {
  sessionPid: number;
  steps: Step[];
  ts: number;
  nonce: string;
}

interface CursorFocusRequest {
  cwd: string;
  kind: "composer" | "cli";
  composerId?: string;
  sessionPid?: number;
  ts: number;
  nonce: string;
}

export function navigationEnabled(): boolean {
  return vscode.workspace.getConfiguration("sessionDeck").get<boolean>("enableNavigation", true);
}

export class Navigator implements vscode.Disposable {
  private watcher: FSWatcher | undefined;
  private handledNonce = "";
  private handledInjectNonce = "";
  private handledCursorNonce = "";
  private readonly requestPath: string;
  private readonly injectPath: string;
  private readonly cursorRequestPath: string;
  private homes: ConfigHome[] = [];

  /** storageDir must be shared across windows: use context.globalStorageUri (same
   *  path in every window attached to this cursor-server). */
  constructor(storageDir: string) {
    this.requestPath = join(storageDir, REQUEST_FILE);
    this.injectPath = join(storageDir, INJECT_FILE);
    this.cursorRequestPath = join(storageDir, CURSOR_REQUEST_FILE);
    try {
      mkdirSync(storageDir, { recursive: true });
      this.watcher = watch(storageDir, (_event, filename) => {
        if (filename === REQUEST_FILE) void this.handleRequest();
        if (filename === INJECT_FILE) void this.handleInject();
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

  /** Broadcast a key-sequence injection; the window owning the session's
   *  terminal (exact pid-ancestry match) is the only one that acts on it. */
  requestInjection(sessionPid: number, steps: Step[]): void {
    const request: InjectRequest = {
      sessionPid,
      steps,
      ts: Date.now(),
      nonce: Math.random().toString(36).slice(2),
    };
    try {
      writeFileSync(this.injectPath, JSON.stringify(request));
    } catch {
      // best-effort
    }
  }

  private async handleInject(): Promise<void> {
    let request: InjectRequest;
    try {
      request = JSON.parse(readFileSync(this.injectPath, "utf8")) as InjectRequest;
    } catch {
      return;
    }
    if (request.nonce === this.handledInjectNonce) return;
    if (Date.now() - request.ts > REQUEST_TTL_MS) return;
    this.handledInjectNonce = request.nonce;
    await sendViaLocalTerminal(request.sessionPid, request.steps);
  }

  dispose(): void {
    this.watcher?.close();
  }

  /** Returns false when there was nothing to navigate to (caller may fall back to preview). */
  async navigate(row: SessionRow): Promise<boolean> {
    const { cwd, sessionId, entrypoint, pid } = row.meta;
    if (this.inThisWindow(cwd)) {
      // Terminal (cli) sessions have no editor tab: reveal the integrated-terminal
      // tab whose shell is an ancestor of the session pid instead.
      if (entrypoint === "cli") return focusLocalTerminal(pid);
      return this.openTabHere(sessionId, entrypoint);
    }
    const request: FocusRequest = {
      cwd,
      sessionId,
      entrypoint,
      sessionPid: pid,
      ts: Date.now(),
      nonce: Math.random().toString(36).slice(2),
    };
    try {
      writeFileSync(this.requestPath, JSON.stringify(request));
    } catch {
      // relay write failed; still try to focus the window
    }
    this.focusWindow(cwd);
    return true;
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
    this.focusWindow(target.cwd);
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
    return (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.fsPath === cwd);
  }

  private async openTabHere(sessionId: string, entrypoint?: string): Promise<boolean> {
    if (entrypoint === "cli") return false; // terminal session: no tab to reveal
    if (vscode.extensions.getExtension(CLAUDE_EXTENSION_ID) === undefined) return false;
    try {
      await vscode.commands.executeCommand(OPEN_SESSION_COMMAND, sessionId);
      return true;
    } catch {
      return false;
    }
  }

  private async handleRequest(): Promise<void> {
    let request: FocusRequest;
    try {
      request = JSON.parse(readFileSync(this.requestPath, "utf8")) as FocusRequest;
    } catch {
      return;
    }
    if (request.nonce === this.handledNonce) return; // fs.watch fires multiple events per write
    if (Date.now() - request.ts > REQUEST_TTL_MS) return;
    if (!this.inThisWindow(request.cwd)) return;
    this.handledNonce = request.nonce;
    // Same terminal-vs-tab split as navigate(), now in the window that owns it.
    if (request.entrypoint === "cli") {
      await focusLocalTerminal(request.sessionPid);
      return;
    }
    await this.openTabHere(request.sessionId, request.entrypoint);
  }

  /** Bring the target project's window to front (or open it) via the editor CLI.
   *  Verified: opening an already-open folder reuses and focuses its window. */
  private focusWindow(cwd: string): void {
    const folder = bestOpenFolder(cwd, this.homes) ?? cwd;
    const cli = editorCliCommand();
    try {
      const child = spawn(cli, [folder], { detached: true, stdio: "ignore" });
      child.on("error", () => undefined); // CLI missing — window focus is best-effort
      child.unref();
    } catch {
      // best-effort only
    }
  }
}

/** Map a session cwd to the workspace folder of an open IDE window using each
 *  home's ide/*.lock, so a session running in a subdirectory focuses the
 *  containing window instead of opening a new one on the subdirectory. */
function bestOpenFolder(cwd: string, homes: ConfigHome[]): string | undefined {
  let best: string | undefined;
  for (const home of homes) {
    try {
      const dir = join(home.dir, "ide");
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".lock")) continue;
        let lock: { workspaceFolders?: string[] };
        try {
          lock = JSON.parse(readFileSync(join(dir, f), "utf8")) as { workspaceFolders?: string[] };
        } catch {
          continue;
        }
        for (const folder of lock.workspaceFolders ?? []) {
          if (!pathContains(folder, cwd)) continue;
          if (best === undefined || folder.length > best.length) best = folder;
        }
      }
    } catch {
      continue;
    }
  }
  return best;
}

/** Separator-agnostic containment: is `cwd` the folder itself or nested inside it?
 *  path.relative handles native Windows separators (and drive letters) that a
 *  literal `folder + "/"` prefix check would miss. */
function pathContains(folder: string, cwd: string): boolean {
  if (cwd === folder) return true;
  const rel = relative(folder, cwd);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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
