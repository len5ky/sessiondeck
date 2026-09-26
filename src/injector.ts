// Optional feature: drive a RUNNING terminal session's TUI by injecting key
// sequences. Extension-tab sessions own their stdin so they're out of reach, but
// terminal sessions are addressable through a VS Code terminal whose shell is an
// ancestor of the session pid (sendText). Everything is best-effort and returns
// false rather than throw.
import * as vscode from "vscode";
import { pidPpid } from "./procs";

export interface Step {
  literal?: string;
  key?: "Enter" | "Up";
  /** ms to wait before this step (lets the TUI's menus settle). */
  wait: number;
}

const TERMINAL_KEYS: Record<NonNullable<Step["key"]>, string> = {
  Enter: "\r",
  Up: "\x1b[A",
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// TUI injection walks the pid ancestry to find the terminal/pane hosting a
// session, which needs /proc-style ppid lookups. That is Linux-only; on native
// macOS/Windows pidPpid is unavailable, so ancestryOf can't be built and every
// entry point below returns false early (a graceful no-op — this was always a
// best-effort feature, and its callers already fall back to a relay).
const injectionSupported = process.platform === "linux";

function ancestryOf(pid: number): Set<number> {
  const chain = new Set<number>();
  let cur: number | undefined = pid;
  while (cur !== undefined && cur > 1 && chain.size < 30) {
    chain.add(cur);
    cur = pidPpid(cur);
  }
  return chain;
}

/** Focus (reveal) the integrated-terminal tab whose shell is an ancestor of the
 *  session pid, when that terminal lives in THIS window. Returns false when no
 *  local terminal matches, so the caller can relay or fall back. */
export async function focusLocalTerminal(sessionPid: number): Promise<boolean> {
  if (!injectionSupported) return false;
  const chain = ancestryOf(sessionPid);
  for (const terminal of vscode.window.terminals) {
    const shellPid = await terminal.processId;
    if (shellPid === undefined || !chain.has(shellPid)) continue;
    terminal.show();
    return true;
  }
  return false;
}

/** Try the terminals of THIS window; sessions in other windows need the relay. */
export async function sendViaLocalTerminal(sessionPid: number, steps: Step[]): Promise<boolean> {
  if (!injectionSupported) return false;
  const chain = ancestryOf(sessionPid);
  for (const terminal of vscode.window.terminals) {
    const shellPid = await terminal.processId;
    if (shellPid === undefined || !chain.has(shellPid)) continue;
    for (const s of steps) {
      if (s.wait > 0) await sleep(s.wait);
      terminal.sendText(s.literal ?? TERMINAL_KEYS[s.key ?? "Enter"], false);
    }
    return true;
  }
  return false;
}
