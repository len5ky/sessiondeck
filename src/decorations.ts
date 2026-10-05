import * as vscode from "vscode";
import { OUTSIDE_GLYPH, OUTSIDE_TOOLTIP } from "./format";

export const SESSION_SCHEME = "claude-session";
/** Scheme for a free-tier over-limit (dimmed) row: the whole label is muted so an
 *  excluded row reads as de-emphasized. A row can carry only one resourceUri, so a
 *  dimmed row uses this instead of its account badge (excess rows are cosmetic). */
export const DIM_SCHEME = "claude-dim";

/** Scheme for a row that runs outside the editor and carries no other decoration.
 *  A row that already has a resourceUri (account badge, dim) gets OUTSIDE_QUERY on
 *  that URI instead, since a row can carry only one. */
export const OUTSIDE_SCHEME = "sessiondeck-outside";
const OUTSIDE_QUERY = "outside";

/** URI marking a row as free-tier-dimmed. The key is opaque (used only for
 *  uniqueness); the decoration is identical for every dimmed row. */
export function dimResourceUri(key: string): vscode.Uri {
  return vscode.Uri.parse(`${DIM_SCHEME}:///${encodeURIComponent(key)}`);
}

/** URI for an outside row with no other decoration. The key is opaque. */
export function outsideResourceUri(key: string): vscode.Uri {
  return vscode.Uri.parse(`${OUTSIDE_SCHEME}:///${encodeURIComponent(key)}`);
}

/** Colors handed to non-primary accounts in order of first appearance. */
const BADGE_COLORS = ["charts.purple", "charts.blue", "charts.orange", "charts.green"];

/** URI that carries a session's account so the decoration provider can badge it.
 *  Path (not authority) holds the label so its original case survives. */
export function sessionResourceUri(homeLabel: string, sessionId: string, outside = false): vscode.Uri {
  return vscode.Uri.parse(
    `${SESSION_SCHEME}:///${encodeURIComponent(homeLabel)}/${encodeURIComponent(sessionId)}${outside ? `?${OUTSIDE_QUERY}` : ""}`
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
    const base = this.baseDecoration(uri);
    // The query counts only on SessionDeck's own schemes: another extension's URI
    // whose query happens to be "outside" gets nothing from us.
    const ours = uri.scheme === SESSION_SCHEME || uri.scheme === DIM_SCHEME;
    if (uri.scheme !== OUTSIDE_SCHEME && !(ours && uri.query === OUTSIDE_QUERY)) return base;
    // Outside: a small glyph after the account letter (if any). It adds no color:
    // a decoration's color tints the whole label, and a muted title would read as
    // a free-tier dimmed row. The account color, when there is one, stays.
    return {
      badge: (base?.badge ?? "") + OUTSIDE_GLYPH,
      tooltip: base?.tooltip !== undefined ? `${base.tooltip} · ${OUTSIDE_TOOLTIP}` : OUTSIDE_TOOLTIP,
      color: base?.color,
      propagate: false,
    };
  }

  private baseDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
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

/** SessionDeck's markdown previews (a session's last message, its properties,
 *  "What's included", a remote row's last message) as a read-only file system.
 *  They were text-document content providers, but the markdown preview watches
 *  the file it shows, and a content provider is no file system: every preview
 *  logged "ENOPRO: No file system provider found". Content is computed on each
 *  read; `fire(uri)` tells open editors and previews it changed. */
export class PreviewDocs implements vscode.FileSystemProvider {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  private readonly mtimes = new Map<string, number>();
  private readonly born = Date.now();

  constructor(private readonly content: (uri: vscode.Uri) => string) {}

  /** Register for `scheme` (read-only); `onDidChange` events become file changes. */
  static register(scheme: string, content: (uri: vscode.Uri) => string, onDidChange?: vscode.Event<vscode.Uri>): vscode.Disposable {
    const docs = new PreviewDocs(content);
    const subs = [
      vscode.workspace.registerFileSystemProvider(scheme, docs, { isReadonly: true, isCaseSensitive: true }),
      ...(onDidChange !== undefined ? [onDidChange((uri) => docs.fire(uri))] : []),
    ];
    return new vscode.Disposable(() => {
      for (const d of subs) d.dispose();
      docs.changed.dispose();
    });
  }

  fire(uri: vscode.Uri): void {
    const key = uri.toString();
    // A new mtime on every change, so the editor never takes it for the old file.
    this.mtimes.set(key, Math.max(Date.now(), (this.mtimes.get(key) ?? this.born) + 1));
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    return {
      type: vscode.FileType.File,
      ctime: this.born,
      mtime: this.mtimes.get(uri.toString()) ?? this.born,
      size: Buffer.byteLength(this.content(uri), "utf8"),
      permissions: vscode.FilePermission.Readonly,
    };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    return Buffer.from(this.content(uri), "utf8");
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}
