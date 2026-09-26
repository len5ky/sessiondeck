import * as vscode from "vscode";

export const SESSION_SCHEME = "claude-session";
/** Scheme for a free-tier over-limit (dimmed) row: the whole label is muted so an
 *  excluded row reads as de-emphasized. A row can carry only one resourceUri, so a
 *  dimmed row uses this instead of its account badge (excess rows are cosmetic). */
export const DIM_SCHEME = "claude-dim";

/** URI marking a row as free-tier-dimmed. The key is opaque (used only for
 *  uniqueness); the decoration is identical for every dimmed row. */
export function dimResourceUri(key: string): vscode.Uri {
  return vscode.Uri.parse(`${DIM_SCHEME}:///${encodeURIComponent(key)}`);
}

/** Colors handed to non-primary accounts in order of first appearance. */
const BADGE_COLORS = ["charts.purple", "charts.blue", "charts.orange", "charts.green"];

/** URI that carries a session's account so the decoration provider can badge it.
 *  Path (not authority) holds the label so its original case survives. */
export function sessionResourceUri(homeLabel: string, sessionId: string): vscode.Uri {
  return vscode.Uri.parse(
    `${SESSION_SCHEME}:///${encodeURIComponent(homeLabel)}/${encodeURIComponent(sessionId)}`
  );
}

/** Badges each session row with a one-letter account marker. The primary home
 *  ("main", or whichever is sole) is left undecorated; every other label gets a
 *  stable color assigned the first time it is seen. */
export class AccountDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  /** label -> theme-color name (e.g. "charts.purple"), assigned once and kept
   *  stable across refreshes. The name (not a ThemeColor) is stored so the
   *  floating panel can resolve it to a CSS variable too. */
  private readonly colors = new Map<string, string>();

  /** Assign colors to any newly-seen labels (in appearance order) and repaint. */
  syncLabels(labels: string[]): void {
    for (const label of labels) {
      if (label === "main" || this.colors.has(label)) continue;
      const idx = this.colors.size % BADGE_COLORS.length;
      this.colors.set(label, BADGE_COLORS[idx]);
    }
    this.emitter.fire(undefined);
  }

  /** Theme-color name assigned to an account label, or undefined for the primary
   *  ("main") home / labels not yet seen. */
  colorName(label: string): string | undefined {
    return this.colors.get(label);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    // Free-tier over-limit rows: mute the whole label (no badge — see DIM_SCHEME).
    if (uri.scheme === DIM_SCHEME) {
      return {
        color: new vscode.ThemeColor("disabledForeground"),
        tooltip: "Free tier — supervision off for this row",
      };
    }
    if (uri.scheme !== SESSION_SCHEME) return undefined;
    const label = decodeURIComponent(uri.path.split("/")[1] ?? "");
    if (label === "" || label === "main") return undefined;
    const color = this.colors.get(label);
    return {
      badge: label.charAt(0).toUpperCase(),
      tooltip: label,
      color: color !== undefined ? new vscode.ThemeColor(color) : undefined,
    };
  }
}
