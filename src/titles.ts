// Optional feature: real Claude panel tab titles for sessions ("Fix login bug"
// instead of "myproject-3f"). The Claude extension generates these titles
// client-side and serializes them into the local IDE's workspaceStorage state
// DBs (memento/workbench.parts.editor → webview inputs carrying
// {title, state.sessionID}). See titleExtract.ts for the extraction.
//
// Resolution is per window kind:
//  - Local window: read the sibling `workspaceStorage` of THIS extension's own
//    globalStorage dir directly — editor- and OS-agnostic, and handles portable
//    mode / --user-data-dir with no hardcoded host paths.
//  - Remote window (WSL/SSH): the desktop-side workspaceStorage isn't on this
//    filesystem, so ask the local "ui" companion over the VS Code command bridge.
// Everything degrades to undefined titles (fallback labels) when unavailable.
import * as vscode from "vscode";
import { join } from "node:path";
import { extractPanelTitles, titleScanStats } from "./titleExtract";
import { recordTitleScan } from "./canary";

const RESCAN_MS = 30_000;

type TitlesResult =
  | { ok: true; titles: Record<string, string> }
  | { ok: false; error?: string };

export class TitleSource {
  private titles = new Map<string, string>();
  private lastScan = 0;
  private scanning = false;
  /** Sibling workspaceStorage of our own globalStorage — used for local windows. */
  private readonly workspaceStorageRoot: string;

  constructor(globalStorageUri: vscode.Uri, private readonly onUpdate: () => void) {
    // .../User/globalStorage/<ext-id>  →  .../User/workspaceStorage
    this.workspaceStorageRoot = join(globalStorageUri.fsPath, "..", "..", "workspaceStorage");
  }

  get(sessionId: string): string | undefined {
    return this.titles.get(sessionId);
  }

  /** Read-only state for the Setup Doctor: which extraction path this window uses
   *  (local workspace storage, or the bridge companion for remote windows) and how
   *  many titles the last scan produced. */
  probe(): { path: "local" | "bridge"; count: number } {
    return { path: vscode.env.remoteName === undefined ? "local" : "bridge", count: this.titles.size };
  }

  /** Cheap to call often; actual rescan is throttled and async. */
  poke(): void {
    if (this.scanning || Date.now() - this.lastScan < RESCAN_MS) return;
    this.scanning = true;
    this.scan().finally(() => {
      this.lastScan = Date.now();
      this.scanning = false;
    });
  }

  private async scan(): Promise<void> {
    const parsed = await this.resolveTitles();
    if (parsed === undefined) return;
    let changed = false;
    for (const [sid, title] of Object.entries(parsed)) {
      if (this.titles.get(sid) !== title) {
        this.titles.set(sid, title);
        changed = true;
      }
    }
    if (changed) this.onUpdate();
  }

  /** Returns the freshly extracted map, or undefined to leave existing titles
   *  untouched (extraction failed or the companion is absent). */
  private async resolveTitles(): Promise<Record<string, string> | undefined> {
    if (vscode.env.remoteName === undefined) {
      try {
        const titles = await extractPanelTitles(this.workspaceStorageRoot);
        // Format-canary: feed the local scan's raw query stats to the canary. The
        // engine-present gate on the alarm lives in the evaluator (formatHealth),
        // so raw counts are recorded here unconditionally.
        recordTitleScan(titleScanStats.attempted, titleScanStats.queryFailed);
        return titles;
      } catch {
        return undefined;
      }
    }
    // Remote window: the local companion owns the desktop-side extraction.
    try {
      const res = await vscode.commands.executeCommand<TitlesResult>("sessionDeckBridge.titles");
      return res !== undefined && res.ok ? res.titles : undefined;
    } catch {
      // Companion not installed → keep prior titles / fall back to plain labels.
      return undefined;
    }
  }
}
