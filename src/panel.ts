// Optional floating always-on-top window mirroring the SessionDeck tree.
// A single WebviewPanel is created on demand, then moved to its own auxiliary
// window and (optionally) pinned always-on-top. The extension pushes a fresh
// serialized model on every 3s refresh; the webview is styled to replicate the
// native VS Code tree view (codicons from the bundled codicon font, list.* theme
// colors, twisties, spinning icons). Clicks post back a navigate request that
// runs the exact same code path as a sidebar click.
import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { PanelModel, stripSubMinuteAge } from "./format";

/** Comparison key for the quiet-tick skip: a serialization of the model that
 *  ignores the two things that drift every 3s poll without any visible change —
 *  the publisher-only raw* fields (bridge-only, never rendered; rawAgeSec is raw
 *  seconds and so changes on every tick for every session) and sub-minute age
 *  tokens inside the rendered description/hover strings. Two ticks whose only
 *  difference is age drift produce the same key and skip the postMessage +
 *  full innerHTML rebuild; any real status/structure change still differs. The
 *  real (un-normalized) model is always what gets posted, so a re-render shows
 *  current ages. */
export function stableModelKey(model: PanelModel): string {
  return JSON.stringify(model, (key, value) => {
    if (
      key === "rawAgeSec" ||
      key === "rawStatus" ||
      key === "rawLastText" ||
      key === "titleIsPrompt" ||
      key === "titleStub"
    )
      return undefined;
    return typeof value === "string" ? stripSubMinuteAge(value) : value;
  });
}

const VIEW_TYPE = "sessionDeck.panel";

interface NavigateMessage {
  type: "navigate";
  sessionId: string;
}

interface NavigateCursorMessage {
  type: "navigateCursor";
  chatId: string;
}

interface NavigateCodexMessage {
  type: "navigateCodex";
  id: string;
}

interface NavigateComposerMessage {
  type: "navigateComposer";
  conversationId: string;
}

type InboundMessage =
  | NavigateMessage
  | NavigateCursorMessage
  | NavigateCodexMessage
  | NavigateComposerMessage
  | { type: "ready" }
  | { type: "toggleActivityTree" }
  | { type: "unlock" }
  | { type?: string };

export class OverviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private lastModel: PanelModel | undefined;
  /** stableModelKey of the last model actually posted, so an unchanged 3s tick
   *  skips the postMessage and the webview's full innerHTML rebuild. The key drops
   *  age drift (raw* fields + sub-minute "Ns" tokens), so identical *visible* state
   *  ⇒ identical key even when a session's raw age advanced by the tick interval. */
  private lastPostedJson: string | undefined;

  /** onNavigate maps a clicked sessionId back to the shared navigation command;
   *  onToggleActivityTree flips the activityTree setting from the panel header. */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onNavigate: (sessionId: string) => void,
    private readonly onToggleActivityTree: () => void,
    private readonly onNavigateCursor: (chatId: string) => void = () => undefined,
    private readonly onNavigateCodex: (id: string) => void = () => undefined,
    private readonly onNavigateComposer: (conversationId: string) => void = () => undefined,
    /** Free-tier locked placeholder "unlock" affordance → the license menu. */
    private readonly onUnlock: () => void = () => undefined
  ) {}

  isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** Create + reveal the panel (or reveal the existing one), then move it to a new
   *  window and pin it always-on-top per the setting. */
  async reveal(): Promise<void> {
    if (this.panel !== undefined) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "SessionDeck", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    });
    this.panel = panel;
    panel.webview.html = html(panel.webview, this.extensionUri);
    panel.webview.onDidReceiveMessage((msg: InboundMessage) => {
      if (msg.type === "ready") {
        if (this.lastModel !== undefined) this.post(this.lastModel);
      } else if (msg.type === "toggleActivityTree") {
        this.onToggleActivityTree();
      } else if (msg.type === "navigate" && typeof (msg as NavigateMessage).sessionId === "string") {
        this.onNavigate((msg as NavigateMessage).sessionId);
      } else if (msg.type === "navigateCursor" && typeof (msg as NavigateCursorMessage).chatId === "string") {
        this.onNavigateCursor((msg as NavigateCursorMessage).chatId);
      } else if (msg.type === "navigateCodex" && typeof (msg as NavigateCodexMessage).id === "string") {
        this.onNavigateCodex((msg as NavigateCodexMessage).id);
      } else if (
        msg.type === "navigateComposer" &&
        typeof (msg as NavigateComposerMessage).conversationId === "string"
      ) {
        this.onNavigateComposer((msg as NavigateComposerMessage).conversationId);
      } else if (msg.type === "unlock") {
        this.onUnlock();
      }
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
    });

    // Detach into its own OS window, then pin it. The move needs a beat to settle
    // before the aux window can be targeted for always-on-top.
    await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    const pin = vscode.workspace.getConfiguration("sessionDeck").get<boolean>("floatAlwaysOnTop", true);
    if (pin) {
      setTimeout(() => {
        void (async () => {
          try {
            await vscode.commands.executeCommand("workbench.action.toggleWindowAlwaysOnTop");
          } catch {
            // command unavailable on this platform/host — degrade silently
          }
        })();
      }, 300);
    }
  }

  /** Store the latest model and push it to the webview when open — but only when
   *  it actually differs from the last one posted, so a quiet tick (identical
   *  state) costs one string compare instead of a webview round-trip + re-render. */
  update(model: PanelModel): void {
    this.lastModel = model;
    if (this.panel === undefined) return;
    const key = stableModelKey(model);
    if (key === this.lastPostedJson) return;
    this.lastPostedJson = key;
    void this.panel.webview.postMessage({ type: "model", model });
  }

  /** Unconditional post (used for the initial "ready" replay, which must always
   *  deliver even if the model matches a stale pre-close snapshot). */
  private post(model: PanelModel): void {
    this.lastPostedJson = stableModelKey(model);
    void this.panel?.webview.postMessage({ type: "model", model });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}

export function nonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Read a brand mark's dark SVG and swap its fixed gray for `currentColor` so the
 *  webview can theme it (and tint it while working) exactly like a codicon. */
export function brandSvg(extensionUri: vscode.Uri, name: string): string {
  try {
    const p = vscode.Uri.joinPath(extensionUri, "media", `${name}-dark.svg`).fsPath;
    return readFileSync(p, "utf8").replace(/#C5C5C5/g, "currentColor").trim();
  } catch {
    return "";
  }
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const n = nonce();
  const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "codicon.css"));
  const brand = { cursor: brandSvg(extensionUri, "cursor"), codex: brandSvg(extensionUri, "codex") };
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'nonce-${n}'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${n}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${codiconUri}" rel="stylesheet" />
<style nonce="${n}">
  /* All dynamic color/indent is expressed as CSS classes here (never inline
     style attributes) because the strict CSP — style-src with a nonce and no
     'unsafe-inline' — authorizes <style> elements but blocks style="" attrs. */
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    font-weight: 400;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    -webkit-user-select: none;
    user-select: none;
  }
  /* Section header styled like the sidebar's own section header. */
  .header {
    display: flex;
    align-items: center;
    height: 22px;
    padding: 0 4px 0 8px;
    background: var(--vscode-sideBarSectionHeader-background);
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
  }
  .header .title {
    flex: 1 1 auto;
    text-transform: uppercase;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toolbtn {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 5px;
    cursor: pointer;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
  }
  .toolbtn:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  .toolbtn.active {
    color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
    background: var(--vscode-inputOption-activeBackground, var(--vscode-list-activeSelectionBackground));
    outline: 1px solid var(--vscode-inputOption-activeBorder, transparent);
  }
  #empty {
    padding: 16px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  /* Degraded-capability footer: a single dim, quiet line mirroring the sidebar's
     capability note (read-only here — the fix is actioned from the sidebar row). */
  #footer {
    padding: 4px 12px 6px 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #footer.hidden { display: none; }
  /* Each nested level lives in a .group whose left border is the tree's indent
     guide, offset so it sits under the parent row's twistie. */
  .group {
    margin-left: 16px;
    border-left: 1px solid var(--vscode-tree-indentGuidesStroke, transparent);
  }
  .row {
    display: flex;
    align-items: center;
    height: 22px;
    line-height: 22px;
    padding: 0 12px 0 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row:active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .twistie {
    flex: 0 0 16px;
    width: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
    font-size: 16px;
  }
  .icon {
    flex: 0 0 16px;
    width: 16px;
    margin-right: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
  }
  /* Native tree renders labels at normal weight — no bold for unread. */
  .label {
    flex: 0 0 auto;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 60%;
  }
  .desc {
    flex: 1 1 auto;
    margin-left: 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Column layout: fixed-width right-side cells give TRUE alignment down the list
     (the font is proportional, so there are no tab stops — equal fixed widths are
     what makes a column line up). The title flexes; Time/Status/Model/Tokens each
     take the same width on every row AND on the header, so they align. */
  .label.col-title { flex: 1 1 auto; max-width: none; min-width: 40px; margin-right: 6px; }
  .col {
    flex: 0 0 auto;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-right: 10px;
  }
  .col-time { width: 62px; }
  .col-status { width: 92px; }
  .col-model { width: 132px; }
  .col-tokens { width: 74px; padding-right: 0; }
  /* Column header row: a quiet, non-interactive label strip above a project's
     session rows, aligned to the same columns. */
  .row.col-head { cursor: default; height: 20px; line-height: 20px; }
  .row.col-head:hover { background: transparent; }
  .col-head .col, .col-head .col-title {
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.04em;
    font-weight: 700;
    color: var(--vscode-descriptionForeground);
  }
  .badge {
    flex: 0 0 auto;
    margin-left: 6px;
    font-size: 0.9em;
    font-weight: 600;
  }
  /* Icon / account colors: resolve a ThemeColor name to its --vscode-* var. */
  .col-charts-red { color: var(--vscode-charts-red); }
  .col-charts-green { color: var(--vscode-charts-green); }
  .col-charts-blue { color: var(--vscode-charts-blue); }
  .col-charts-purple { color: var(--vscode-charts-purple); }
  .col-charts-yellow { color: var(--vscode-charts-yellow); }
  .col-charts-orange { color: var(--vscode-charts-orange); }
  /* Remote host header row: slightly heavier label; stale hosts (and their
     subtrees) dim, mirroring the sidebar's muted icon + "last seen" convention. */
  .row.host .label { font-weight: 600; }
  /* Needs-you inbox header: a quiet section marker above the tree (bell + count). */
  .row.inbox-header { cursor: default; }
  .row.inbox-header .label { font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
  .col-charts-red { color: var(--vscode-charts-red); }
  .stale { opacity: 0.55; }
  .free-tier { opacity: 0.55; }
  /* A non-navigable row (a demoted/ended external codex run): no pointer, no active tint. */
  .row.nonav { cursor: default; }
  .row.nonav:active { background: transparent; color: inherit; }
  /* Free-tier LOCKED placeholder: muted label, a quiet trailing "Unlock" affordance. */
  .row.locked { cursor: pointer; }
  .row.locked .locked-label { color: var(--vscode-disabledForeground); font-style: italic; }
  .row.locked .unlock-hint { margin-left: auto; opacity: 0.7; display: inline-flex; align-items: center; gap: 3px; }
  .row.locked:hover .unlock-hint { opacity: 1; text-decoration: underline; }
  /* Dim provenance tag leading a folded codex child's description (subagent role / kind),
     so a nested run reads as a child of its father session rather than a peer. */
  .prov { text-transform: uppercase; font-size: 0.85em; letter-spacing: 0.03em; margin-right: 4px; opacity: 0.85; }
  /* codicon spin animation is provided by codicon.css (.codicon-modifier-spin) */
  /* Brand marks (Cursor/Codex) render as inline SVG sized like a codicon; the SVG
     uses currentColor so it themes with the row, and .spin animates it. */
  .brand-icon svg { width: 16px; height: 16px; display: block; }
  .brand-icon.spin svg { animation: mc-brand-spin 1.5s linear infinite; }
  @keyframes mc-brand-spin { 100% { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="header">
  <span class="title">SessionDeck</span>
  <span id="activityToggle" class="toolbtn" title="Show activity tree">
    <span class="codicon codicon-list-tree"></span>
  </span>
</div>
<div id="root"></div>
<div id="footer" class="hidden"></div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const BRAND_SVG = ${JSON.stringify(brand)};
  const saved = vscode.getState() || {};
  // Project/host/remote-project rows carry a "toggled away from the density default"
  // set (kept under the historical collapsed* names for state-shape compatibility):
  // in COMFORTABLE the default is open, so membership means collapsed — identical to
  // before; in COMPACT the default is collapsed (open only when the row needs you),
  // so membership inverts to mean explicitly-expanded. openState() applies the XOR.
  const collapsedProjects = new Set(saved.collapsedProjects || []);
  const expandedSessions = new Set(saved.expandedSessions || []);
  const expandedWorkflows = new Set(saved.expandedWorkflows || []);
  // Remote-host expansion state (keyed with hostId prefixes so a remote cwd can't
  // collide with a self project of the same path).
  const collapsedHosts = new Set(saved.collapsedHosts || []);
  const collapsedRemoteProjects = new Set(saved.collapsedRemoteProjects || []);
  const expandedRemoteSessions = new Set(saved.expandedRemoteSessions || []);
  // Last density we rendered: a flip resets the project-level toggles so the fresh
  // density default shows (mirroring the sidebar's generation bump).
  let lastDensity = saved.lastDensity || "comfortable";
  let model = null;

  function persist() {
    vscode.setState({
      collapsedProjects: [...collapsedProjects],
      expandedSessions: [...expandedSessions],
      expandedWorkflows: [...expandedWorkflows],
      collapsedHosts: [...collapsedHosts],
      collapsedRemoteProjects: [...collapsedRemoteProjects],
      expandedRemoteSessions: [...expandedRemoteSessions],
      lastDensity,
    });
  }

  // The default open-state for a project/host/remote-project row: comfortable is
  // always open, compact is open only when the row has needs-you children (the
  // "which one needs me is never buried" covenant), else collapsed.
  function densityDefaultOpen(needsYou) {
    return model && model.density === "compact" ? (needsYou || 0) > 0 : true;
  }
  // The set key a row's toggle is stored under. In compact the default open-state
  // depends on needs-you, so fold it into the key: a needs-you onset/resolution
  // flips the key, which forgets the now-stale toggle and lets the row follow the
  // NEW default — so a manually-expanded quiet project is NOT collapsed shut the
  // instant it comes to need you (it force-opens once per onset), and between onsets
  // the manual toggle is respected. Comfortable's default is always open, so its key
  // stays stable (a manual collapse persists across needs-you changes). This mirrors
  // format.ts's panelToggleKey/panelRowOpen exactly — that pure pair carries the
  // onset-after-manual-toggle contract under test (the webview can't import it).
  function toggleKey(baseKey, needsYou) {
    return model && model.density === "compact"
      ? baseKey + "|" + (((needsYou || 0) > 0) ? "n" : "q")
      : baseKey;
  }
  // Effective open-state = default XOR an explicit user toggle for this key.
  function openState(defaultOpen, toggledSet, key) {
    return toggledSet.has(key) ? !defaultOpen : defaultOpen;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Map a ThemeColor name ("charts.blue") to a CSS class defined in <style>.
  function colorClass(name) {
    return name ? "col-" + String(name).split(".").join("-") : "";
  }

  function iconHtml(icon, color, spin, brand) {
    if (brand && BRAND_SVG[brand]) {
      const cls = "icon brand-icon " + colorClass(color) + (spin ? " spin" : "");
      return '<span class="' + cls.trim() + '">' + BRAND_SVG[brand] + '</span>';
    }
    const cls = "icon " + colorClass(color);
    const inner = "codicon codicon-" + esc(icon) + (spin ? " codicon-modifier-spin" : "");
    return '<span class="' + cls.trim() + '"><span class="' + inner + '"></span></span>';
  }

  function twistie(open, hasChildren) {
    if (!hasChildren) return '<span class="twistie"></span>';
    return '<span class="twistie"><span class="codicon codicon-chevron-' +
      (open ? "down" : "right") + '"></span></span>';
  }

  function childHtml(c, keyPrefix) {
    const hasKids = c.kind === "workflow" && c.children && c.children.length > 0;
    const wfKey = keyPrefix + "|" + c.label;
    const open = expandedWorkflows.has(wfKey);
    const attrs = hasKids ? ' data-toggle-workflow="' + esc(wfKey) + '"' : "";
    let out =
      '<div class="row child"' + attrs + ' title="' + esc(c.hover) + '">' +
        twistie(open, hasKids) +
        iconHtml(c.icon, c.iconColor, c.spin) +
        '<span class="label">' + esc(c.label) + '</span>' +
        '<span class="desc">' + esc(c.description || "") + '</span>' +
      '</div>';
    if (hasKids && open) {
      out += '<div class="group">' + c.children.map((a) => childHtml(a, wfKey)).join("") + '</div>';
    }
    return out;
  }

  // ---- Column layout (sessionDeck.layout === "columns") -------------------
  const COL_EMPTY = "—";
  const inColumns = () => model && model.layout === "columns";
  // The four aligned cells (time · status · model · tokens) for a session row, in
  // fixed order; empty model/tokens show a placeholder so every row has the same
  // slots. Mirrors format.ts sessionColumnCells / SESSION_COLUMN_HEADERS.
  function colCells(cols) {
    const c = cols || {};
    return (
      '<span class="col col-time">' + esc(c.time || "") + '</span>' +
      '<span class="col col-status">' + esc(c.status || "") + '</span>' +
      '<span class="col col-model">' + esc(c.model || COL_EMPTY) + '</span>' +
      '<span class="col col-tokens">' + esc(c.tokens || COL_EMPTY) + '</span>'
    );
  }
  // The header strip above a project's session rows, aligned to the same columns.
  function colHeader() {
    return (
      '<div class="row col-head">' +
        '<span class="twistie"></span>' +
        '<span class="icon"></span>' +
        '<span class="label col-title">Session</span>' +
        '<span class="col col-time">Time</span>' +
        '<span class="col col-status">Status</span>' +
        '<span class="col col-model">Model</span>' +
        '<span class="col col-tokens">Tokens</span>' +
      '</div>'
    );
  }

  // A free-tier LOCKED placeholder row: a lock glyph, the fixed label, and a quiet
  // "unlock" affordance (data-unlock → license menu). It carries NO nav handle, NO
  // toggle, NO title tooltip, NO children — the model it renders from has no real
  // session data at all (see format.ts lockedPanel* builders). Shared by every kind.
  function lockedRowHtml() {
    return (
      '<div class="row locked" data-unlock title="Unlock — get a license">' +
        twistie(false, false) +
        iconHtml("lock", "", false) +
        '<span class="label locked-label">' + esc("Not available in free version") + '</span>' +
        '<span class="desc unlock-hint"><span class="codicon codicon-unlock"></span> Unlock</span>' +
      '</div>'
    );
  }

  function sessionHtml(s, multiHome) {
    if (s.locked) return lockedRowHtml();
    const childCount = (s.children ? s.children.length : 0) + (s.codexChildren ? s.codexChildren.length : 0) + (s.cursorChildren ? s.cursorChildren.length : 0);
    const hasKids = childCount > 0;
    const open = expandedSessions.has(s.sessionId);
    const columns = inColumns();
    // Non-primary accounts tint both the label and a right-aligned badge letter,
    // mirroring the sidebar's file-decoration coloring.
    const acct = multiHome && s.homeColor ? colorClass(s.homeColor) : "";
    const labelCls = "label" + (columns ? " col-title" : "") + (acct ? " " + acct : "");
    const badge = acct
      ? '<span class="badge ' + acct + '" title="' + esc(s.homeLabel) + '">' +
          esc((s.homeLabel || "?").charAt(0).toUpperCase()) + '</span>'
      : "";
    // In columns layout the four fixed cells must stay right-anchored so they line up
    // across every row AND the header — so the (fixed-width) account badge goes BEFORE
    // the flexible title, letting the title absorb its width; nothing variable sits to
    // the right of the columns. In list layout the badge keeps its trailing position.
    const body = columns
      ? badge + '<span class="' + labelCls + '">' + esc(s.title) + '</span>' + colCells(s.columns)
      : '<span class="' + labelCls + '">' + esc(s.title) + '</span>' +
        '<span class="desc">' + esc(s.description || "") + '</span>';
    const trailingBadge = columns ? "" : badge;
    let out =
      '<div class="row session' + (s.freeTier ? " free-tier" : "") + '" data-nav="' + esc(s.sessionId) + '"' +
        (hasKids ? ' data-toggle-session="' + esc(s.sessionId) + '"' : "") +
        ' title="' + esc(s.hover) + '">' +
        twistie(open, hasKids) +
        iconHtml(s.icon, s.iconColor, s.spin) +
        body +
        trailingBadge +
      '</div>';
    if (hasKids && open) {
      // Activity-tree children (workflows/agents/tasks) first, then folded codex child
      // rows nested under their father session — matching the sidebar tree's order.
      const kids =
        (s.children || []).map((c) => childHtml(c, s.sessionId)).join("") +
        (s.codexChildren || []).map((c) => codexHtml(c, { child: true })).join("") +
        (s.cursorChildren || []).map((c) => cursorHtml(c)).join("");
      out += '<div class="group">' + kids + '</div>';
    }
    return out;
  }

  // A cursor row, shared by top-level project rows and folded child rows. A demoted
  // external ended / orphaned run (c.demoted) renders dimmed and NON-clickable (no
  // data-cursor nav) — no window to focus. Free-tier rows dim too. Every string escaped.
  function cursorHtml(c) {
    if (c.locked) return lockedRowHtml();
    var dim = c.freeTier || c.demoted;
    var nav = c.demoted ? "" : ' data-cursor="' + esc(c.chatId) + '"';
    var cls = "row cursor" + (dim ? " free-tier" : "") + (c.demoted ? " nonav" : "");
    return (
      '<div class="' + cls + '"' + nav + ' title="' + esc(c.hover) + '">' +
        twistie(false, false) +
        iconHtml(c.icon, c.iconColor, c.spin, c.brand) +
        '<span class="label">' + esc(c.title) + '</span>' +
        '<span class="desc">' + esc(c.description || "") + '</span>' +
      '</div>'
    );
  }

  // A codex row, shared by top-level project rows and folded child rows. A demoted
  // external ended run (c.demoted) renders dimmed and NON-clickable (no data-codex nav).
  // A folded child (opts.child) shows its dim provenance label before the description so
  // it reads as a child, not a peer. Free-tier rows dim too. Every string is escaped.
  function codexHtml(c, opts) {
    if (c.locked) return lockedRowHtml();
    opts = opts || {};
    const dim = c.freeTier || c.demoted;
    const nav = c.demoted ? "" : ' data-codex="' + esc(c.id) + '"';
    const prov = opts.child && c.provenance ? '<span class="prov">' + esc(c.provenance) + '</span>' : "";
    const cls = "row codex" + (dim ? " free-tier" : "") + (c.demoted ? " nonav" : "");
    return (
      '<div class="' + cls + '"' + nav + ' title="' + esc(c.hover) + '">' +
        twistie(false, false) +
        iconHtml(c.icon, c.iconColor, c.spin, c.brand) +
        '<span class="label">' + esc(c.title) + '</span>' +
        '<span class="desc">' + prov + esc(c.description || "") + '</span>' +
      '</div>'
    );
  }

  // A Cursor GUI Composer row: activity-only (no attention), a codicon icon (no brand),
  // navigates to the composer session. Free-tier rows dim.
  function composerHtml(c) {
    if (c.locked) return lockedRowHtml();
    return (
      '<div class="row composer' + (c.freeTier ? " free-tier" : "") + '" data-composer="' + esc(c.conversationId) + '" title="' + esc(c.hover) + '">' +
        twistie(false, false) +
        iconHtml(c.icon, c.iconColor, c.spin) +
        '<span class="label">' + esc(c.title) + '</span>' +
        '<span class="desc">' + esc(c.description || "") + '</span>' +
      '</div>'
    );
  }

  // ---- Needs-you inbox (command center; rendered FIRST, above projects) -------
  // A view of the rows below: each carries the SAME nav handle as the real row, so
  // a click routes to the same open command. Remote rows are read-only (no nav),
  // matching the host sections. The section is always open (its whole point).
  function inboxRowHtml(r, multiHome) {
    const nav =
      r.kind === "session" ? ' data-nav="' + esc(r.sessionId) + '"'
      : r.kind === "cursor" ? ' data-cursor="' + esc(r.chatId) + '"'
      : r.kind === "codex" ? ' data-codex="' + esc(r.codexId) + '"'
      : "";
    // Multi-home account badge, mirroring the real session row (session kind only,
    // and only when more than one account is present).
    const acct = multiHome && r.homeColor ? colorClass(r.homeColor) : "";
    const labelCls = "label" + (acct ? " " + acct : "");
    const badge = acct
      ? '<span class="badge ' + acct + '" title="' + esc(r.homeLabel) + '">' +
          esc((r.homeLabel || "?").charAt(0).toUpperCase()) + '</span>'
      : "";
    return (
      '<div class="row session"' + nav + ' title="' + esc(r.hover) + '">' +
        twistie(false, false) +
        iconHtml(r.icon, r.iconColor, r.spin, r.brand) +
        '<span class="' + labelCls + '">' + esc(r.title) + '</span>' +
        '<span class="desc">' + esc(r.description || "") + '</span>' +
        badge +
      '</div>'
    );
  }

  function inboxHtml(rows, multiHome) {
    const header =
      '<div class="row inbox-header" title="Sessions ranked by urgency — a view of the rows below">' +
        twistie(false, false) +
        '<span class="icon col-charts-red"><span class="codicon codicon-bell-dot"></span></span>' +
        '<span class="label">Needs you (' + rows.length + ')</span>' +
      '</div>';
    return header + '<div class="group">' + rows.map((r) => inboxRowHtml(r, multiHome)).join("") + '</div>';
  }

  function projectHtml(p) {
    const key = toggleKey(p.cwd, p.needsYou);
    const open = openState(densityDefaultOpen(p.needsYou), collapsedProjects, key);
    let out =
      '<div class="row project" data-toggle-project="' + esc(key) + '" title="' + esc(p.cwd) + '">' +
        twistie(open, true) +
        '<span class="label">' + esc(p.name) + '</span>' +
        '<span class="desc">' + esc(p.description || "") + '</span>' +
      '</div>';
    if (open) {
      // In columns layout, a header strip labels the aligned Claude-session columns
      // (Time/Status/Model/Tokens); Cursor/Codex rows keep their inline description.
      const header = inColumns() && p.sessions.length > 0 ? colHeader() : "";
      // Cursor then Codex sessions render after Claude sessions, matching the tree.
      const kids =
        header +
        p.sessions.map((s) => sessionHtml(s, model.multiHome)).join("") +
        (p.cursors || []).map((c) => cursorHtml(c)).join("") +
        (p.codexes || []).map((c) => codexHtml(c)).join("") +
        (p.composers || []).map((c) => composerHtml(c)).join("");
      out += '<div class="group">' + kids + '</div>';
    }
    return out;
  }

  // ---- Remote host sections (read-only; every string escaped, plan §8.1) -----
  function remoteChildHtml(c) {
    return (
      '<div class="row child" title="' + esc(c.hover) + '">' +
        twistie(false, false) +
        iconHtml(c.icon, c.iconColor, c.spin) +
        '<span class="label">' + esc(c.label) + '</span>' +
        '<span class="desc">' + esc(c.description || "") + '</span>' +
      '</div>'
    );
  }

  function remoteSessionHtml(s, hostId) {
    const hasKids = s.children && s.children.length > 0;
    const key = hostId + "|" + s.id;
    const open = expandedRemoteSessions.has(key);
    let out =
      '<div class="row session"' +
        (hasKids ? ' data-toggle-rsession="' + esc(key) + '"' : "") +
        ' title="' + esc(s.hover) + '">' +
        twistie(open, hasKids) +
        iconHtml(s.icon, s.iconColor, s.spin, s.brand) +
        '<span class="label">' + esc(s.title) + '</span>' +
        '<span class="desc">' + esc(s.description || "") + '</span>' +
      '</div>';
    if (hasKids && open) {
      out += '<div class="group">' + s.children.map(remoteChildHtml).join("") + '</div>';
    }
    return out;
  }

  function remoteProjectHtml(p, hostId) {
    const key = toggleKey(hostId + "|" + p.cwd, p.needsYou);
    const open = openState(densityDefaultOpen(p.needsYou), collapsedRemoteProjects, key);
    let out =
      '<div class="row project" data-toggle-rproject="' + esc(key) + '" title="' + esc(p.cwd) + '">' +
        twistie(open, true) +
        '<span class="label">' + esc(p.name) + '</span>' +
        '<span class="desc">' + esc(p.description || "") + '</span>' +
      '</div>';
    if (open) {
      out += '<div class="group">' + p.sessions.map((s) => remoteSessionHtml(s, hostId)).join("") + '</div>';
    }
    return out;
  }

  function hostHtml(h) {
    const key = toggleKey(h.hostId, h.needsYou);
    const open = openState(densityDefaultOpen(h.needsYou), collapsedHosts, key);
    const staleCls = h.stale ? " stale" : "";
    let out =
      '<div class="row host' + staleCls + '" data-toggle-host="' + esc(key) + '" title="' + esc(h.label) + '">' +
        twistie(open, true) +
        '<span class="icon"><span class="codicon codicon-server-environment"></span></span>' +
        '<span class="label">' + esc(h.label) + '</span>' +
        '<span class="desc">' + esc(h.description || "") + '</span>' +
      '</div>';
    if (open) {
      out += '<div class="group' + staleCls + '">' + h.projects.map((p) => remoteProjectHtml(p, h.hostId)).join("") + '</div>';
    }
    return out;
  }

  function render() {
    const toggle = document.getElementById("activityToggle");
    toggle.className = "toolbtn" + (model && model.activityTree ? " active" : "");
    toggle.title = model && model.activityTree ? "Hide activity tree" : "Show activity tree";

    const root = document.getElementById("root");
    const hasProjects = model && model.projects && model.projects.length > 0;
    const hasHosts = model && model.hosts && model.hosts.length > 0;
    if (!hasProjects && !hasHosts) {
      root.innerHTML = '<div id="empty">No Claude Code sessions to show.</div>';
      const footer = document.getElementById("footer");
      footer.textContent = "";
      footer.className = "hidden";
      return;
    }
    // Needs-you inbox first (command center), then self projects, then remote host
    // sections (matching the tree order).
    const inboxRows = model && model.inbox ? model.inbox : [];
    root.innerHTML =
      (inboxRows.length > 0 ? inboxHtml(inboxRows, model.multiHome) : "") +
      (hasProjects ? model.projects.map(projectHtml).join("") : "") +
      (hasHosts ? model.hosts.map(hostHtml).join("") : "");

    // Footer mirrors the sidebar's meta notes (dim, read-only): the degraded-
    // capability note and the same-path collision note, joined on the single line.
    const footer = document.getElementById("footer");
    const notes = [model && model.capabilityNote, model && model.collisionNote].filter(Boolean);
    if (notes.length > 0) {
      footer.textContent = notes.join(" · ");
      footer.className = "";
    } else {
      footer.textContent = "";
      footer.className = "hidden";
    }
  }

  document.getElementById("activityToggle").addEventListener("click", () => {
    vscode.postMessage({ type: "toggleActivityTree" });
  });

  document.getElementById("root").addEventListener("click", (ev) => {
    const row = ev.target.closest(".row");
    if (!row) return;
    // A free-tier locked placeholder: the ONLY action is the quiet unlock affordance
    // (routes to the license menu). No nav, no toggle, no data about the real session.
    if (row.hasAttribute("data-unlock")) {
      vscode.postMessage({ type: "unlock" });
      return;
    }
    const onTwistie = ev.target.closest(".twistie") !== null;

    const proj = row.getAttribute("data-toggle-project");
    if (proj !== null) {
      if (collapsedProjects.has(proj)) collapsedProjects.delete(proj);
      else collapsedProjects.add(proj);
      persist();
      render();
      return;
    }
    // Remote host / remote-project / remote-session toggles (read-only rows: no
    // navigation, just viewer-side expand/collapse).
    const host = row.getAttribute("data-toggle-host");
    if (host !== null) {
      if (collapsedHosts.has(host)) collapsedHosts.delete(host);
      else collapsedHosts.add(host);
      persist();
      render();
      return;
    }
    const rproj = row.getAttribute("data-toggle-rproject");
    if (rproj !== null) {
      if (collapsedRemoteProjects.has(rproj)) collapsedRemoteProjects.delete(rproj);
      else collapsedRemoteProjects.add(rproj);
      persist();
      render();
      return;
    }
    const rsess = row.getAttribute("data-toggle-rsession");
    if (rsess !== null && onTwistie) {
      if (expandedRemoteSessions.has(rsess)) expandedRemoteSessions.delete(rsess);
      else expandedRemoteSessions.add(rsess);
      persist();
      render();
      return;
    }
    const wf = row.getAttribute("data-toggle-workflow");
    if (wf !== null && onTwistie) {
      if (expandedWorkflows.has(wf)) expandedWorkflows.delete(wf);
      else expandedWorkflows.add(wf);
      persist();
      render();
      return;
    }
    const sess = row.getAttribute("data-toggle-session");
    if (sess !== null && onTwistie) {
      if (expandedSessions.has(sess)) expandedSessions.delete(sess);
      else expandedSessions.add(sess);
      persist();
      render();
      return;
    }
    const cursor = row.getAttribute("data-cursor");
    if (cursor !== null) {
      vscode.postMessage({ type: "navigateCursor", chatId: cursor });
      return;
    }
    const codex = row.getAttribute("data-codex");
    if (codex !== null) {
      vscode.postMessage({ type: "navigateCodex", id: codex });
      return;
    }
    const composer = row.getAttribute("data-composer");
    if (composer !== null) {
      vscode.postMessage({ type: "navigateComposer", conversationId: composer });
      return;
    }
    const nav = row.getAttribute("data-nav");
    if (nav !== null) vscode.postMessage({ type: "navigate", sessionId: nav });
  });

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (msg && msg.type === "model") {
      model = msg.model;
      // A density flip resets the project-level toggles so the fresh density default
      // shows (the panel's mirror of the sidebar's generation bump); session/workflow
      // expansion is unaffected.
      const density = model.density || "comfortable";
      if (density !== lastDensity) {
        lastDensity = density;
        collapsedProjects.clear();
        collapsedHosts.clear();
        collapsedRemoteProjects.clear();
        persist();
      }
      render();
    }
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
