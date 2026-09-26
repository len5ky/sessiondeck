import * as vscode from "vscode";
import { nonce, brandSvg, stableModelKey } from "./panel";
import { PanelModel } from "./format";

interface InboundMessage {
  type?: unknown;
  sessionId?: unknown;
  chatId?: unknown;
  id?: unknown;
  conversationId?: unknown;
}

/**
 * The sidebar "Sessions" view rendered as a TREE with columns — the columns-layout
 * counterpart of the list-mode `sessionDeck.sessions` TreeView. It mirrors the
 * tree's hierarchy and ordering EXACTLY (needs-you inbox → projects → remote hosts,
 * with folded codex children and activity-tree children nested under sessions); only
 * the metrics presentation differs (status · time · model · tokens as aligned,
 * right-anchored columns instead of an inline description).
 *
 * Narrow-first: the target is a ~250–320px sidebar, so the columns degrade with a
 * CSS container query — below the threshold MODEL and TOKENS fold into a dim sub-line
 * under the title rather than overflowing (the page body never scrolls horizontally).
 *
 * Toolbar: the view/title buttons live in package.json (mirrored from the tree view),
 * so the webview carries NO in-body chrome. Collapse-all / expand-all reach the
 * webview's own collapse state via postMessage (setAllCollapsed).
 *
 * Right-click: native VS Code context menus (data-vscode-context + the package.json
 * `webview/context` block) reproduce the tree's per-node menu exactly — the labels are
 * static package.json contributions (no untrusted text is ever rendered as a menu),
 * and the invoked command receives the row's id/cwd for the extension to resolve.
 */
export class TableViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private lastModel?: PanelModel;
  private lastPostedKey?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onNavigate: (sessionId: string) => void,
    private readonly onNavigateCursor: (chatId: string) => void,
    private readonly onNavigateCodex: (id: string) => void,
    private readonly onNavigateComposer: (conversationId: string) => void,
    private readonly onVisible: () => void,
    /** Free-tier locked placeholder "unlock" affordance → the license menu. */
    private readonly onUnlock: () => void = () => undefined
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = tableHtml(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((message: InboundMessage) => {
      if (message.type === "ready") this.replay();
      else if (message.type === "navigate" && typeof message.sessionId === "string") {
        this.onNavigate(message.sessionId);
      } else if (message.type === "navigateCursor" && typeof message.chatId === "string") {
        this.onNavigateCursor(message.chatId);
      } else if (message.type === "navigateCodex" && typeof message.id === "string") {
        this.onNavigateCodex(message.id);
      } else if (message.type === "navigateComposer" && typeof message.conversationId === "string") {
        this.onNavigateComposer(message.conversationId);
      } else if (message.type === "unlock") {
        this.onUnlock();
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.onVisible();
        this.replay();
      }
    });
    // If the view resolves already-visible (the common case when the user toggles to
    // columns), build + post a fresh model NOW so the table isn't blank until the next
    // poll tick; otherwise replay whatever model we last held.
    if (view.visible) this.onVisible();
    else if (this.lastModel !== undefined) this.replay();
  }

  isVisible(): boolean {
    return this.view?.visible === true;
  }

  update(model: PanelModel): void {
    this.lastModel = model;
    if (this.view === undefined || !this.view.visible) return;
    const key = stableModelKey(model);
    if (key === this.lastPostedKey) return;
    this.lastPostedKey = key;
    void this.view.webview.postMessage({ type: "model", model });
  }

  /** Collapse / expand every collapsible row (projects, hosts, sessions, workflows).
   *  Drives the webview's own persisted collapse state — the collapse-all / expand-all
   *  toolbar commands route here when the table is the active view (the tree's
   *  setAllCollapsed handles the list view). A no-op before the webview resolves. */
  setAllCollapsed(collapsed: boolean): void {
    void this.view?.webview.postMessage({ type: "setAllCollapsed", collapsed });
  }

  private replay(): void {
    if (this.lastModel === undefined) return;
    this.lastPostedKey = stableModelKey(this.lastModel);
    void this.view?.webview.postMessage({ type: "model", model: this.lastModel });
  }
}

function tableHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const n = nonce();
  const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "codicon.css"));
  const brands = { cursor: brandSvg(extensionUri, "cursor"), codex: brandSvg(extensionUri, "codex") };
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
  /* All dynamic color/indent is expressed as CSS classes here (never inline style
     attributes) because the strict CSP blocks style="" attrs. */
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; padding: 0;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    font-weight: 400;
    -webkit-user-select: none; user-select: none;
    /* The container the column query resolves against: columns degrade with the
       sidebar's own width, not the window's. */
    container-type: inline-size;
    container-name: tree;
  }
  /* The single column-label strip: sticky at the top, aligned to the row metrics
     (its right edge is the container's right edge, same as every row's cluster). */
  .head {
    position: sticky; top: 0; z-index: 2;
    display: flex; align-items: center;
    height: 20px; padding: 0 10px 0 8px;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
  }
  .head .h-title { flex: 1 1 auto; min-width: 20px; }
  .head .cell, .head .h-title {
    text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; font-weight: 700;
    color: var(--vscode-descriptionForeground);
  }
  .head .h-spacer { flex: 0 0 38px; }

  /* Each nested level is a .group whose left border is the tree indent guide. */
  .group {
    margin-left: 16px;
    border-left: 1px solid var(--vscode-tree-indentGuidesStroke, transparent);
  }

  .row { cursor: pointer; }
  .row.nonav { cursor: default; }
  .mainline { display: flex; align-items: center; min-height: 22px; padding: 0 10px 0 8px; white-space: nowrap; }
  .row:hover > .mainline { background: var(--vscode-list-hoverBackground); }
  .row:active:not(.nonav) > .mainline {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .free-tier { opacity: 0.55; }
  .stale { opacity: 0.55; }
  /* Free-tier LOCKED placeholder: muted italic label + a quiet trailing "Unlock". */
  .row.locked { cursor: pointer; }
  .row.locked .locked-label { color: var(--vscode-disabledForeground); font-style: italic; }
  .row.locked .unlock-hint { opacity: 0.7; gap: 3px; }
  .row.locked:hover .unlock-hint { opacity: 1; text-decoration: underline; }

  .twistie { flex: 0 0 16px; width: 16px; display: flex; align-items: center; justify-content: center; font-size: 16px; color: var(--vscode-icon-foreground, var(--vscode-foreground)); }
  .icon { flex: 0 0 16px; width: 16px; margin-right: 6px; display: flex; align-items: center; justify-content: center; font-size: 16px; }
  .brand-icon svg { width: 16px; height: 16px; display: block; }
  .brand-icon.spin svg { animation: tv-brand-spin 1.5s linear infinite; }
  @keyframes tv-brand-spin { 100% { transform: rotate(360deg); } }

  .label { flex: 1 1 auto; min-width: 24px; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .section-label { flex: 0 1 auto; text-transform: uppercase; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; }
  /* Section-header (project/host) summary counts: a dim, flexible trailer that gets
     the row's spare width rather than being squeezed into a data column. */
  .section-desc { flex: 0 1 auto; margin-left: auto; padding-left: 10px; padding-right: 2px; color: var(--vscode-descriptionForeground); font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .host .label { font-weight: 600; }
  .badge-acct { flex: 0 0 auto; margin-left: 6px; font-size: 0.9em; font-weight: 600; }
  .badge-ext { flex: 0 0 auto; margin-left: 6px; padding: 0 5px; border-radius: 3px; font-size: 0.82em; font-weight: 600; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .wt-caption { color: var(--vscode-descriptionForeground); opacity: 0.85; }

  /* Right-anchored metrics cluster: fixed-width, right-aligned cells give true
     column alignment down the list regardless of a row's indent depth (the cluster
     always hugs the container's right edge). */
  .metrics { flex: 0 0 auto; margin-left: 8px; display: flex; align-items: center; }
  .cell { flex: 0 0 auto; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 8px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .cell-status { width: 78px; }
  .cell-time { width: 42px; }
  .cell-model { width: 84px; }
  .cell-tokens { width: 52px; }

  /* Status pill (right-aligned inside its cell). Short labels keep it narrow. */
  .status { display: inline-flex; align-items: center; max-width: 100%; padding: 0 6px; border-radius: 9px; font-size: 0.92em; font-weight: 600; line-height: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-attention { color: var(--vscode-charts-red); background: color-mix(in srgb, var(--vscode-charts-red) 16%, transparent); }
  .s-question { color: var(--vscode-charts-orange, var(--vscode-charts-yellow)); background: color-mix(in srgb, var(--vscode-charts-orange, var(--vscode-charts-yellow)) 16%, transparent); }
  .s-working { color: var(--vscode-charts-green); background: color-mix(in srgb, var(--vscode-charts-green) 16%, transparent); }
  .s-unread { color: var(--vscode-charts-yellow); background: color-mix(in srgb, var(--vscode-charts-yellow) 16%, transparent); }
  .s-done { color: var(--vscode-charts-blue); background: color-mix(in srgb, var(--vscode-charts-blue) 16%, transparent); }
  .s-idle { color: var(--vscode-descriptionForeground); background: var(--vscode-badge-background); }

  /* Dim sub-line under a row's title. Holds the folded MODEL·TOKENS at narrow widths
     (and a folded codex child's provenance). Hidden when empty. */
  .subline { padding: 0 10px 2px 38px; color: var(--vscode-descriptionForeground); font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subline:empty { display: none; }
  .prov { text-transform: uppercase; font-size: 0.85em; letter-spacing: 0.03em; margin-right: 4px; opacity: 0.85; }

  /* Narrow-first: MODEL/TOKENS live in the sub-line by default; the columns appear
     only once the sidebar is wide enough to hold them without overflow. */
  .foldcols { display: inline; }
  .cell-model, .cell-tokens, .head .cell-model, .head .cell-tokens { display: none; }
  @container tree (min-width: 400px) {
    .cell-model, .cell-tokens, .head .cell-model, .head .cell-tokens { display: block; }
    .foldcols { display: none; }
  }

  /* Icon / account theme colors. */
  .col-charts-red { color: var(--vscode-charts-red); }
  .col-charts-green { color: var(--vscode-charts-green); }
  .col-charts-blue { color: var(--vscode-charts-blue); }
  .col-charts-purple { color: var(--vscode-charts-purple); }
  .col-charts-yellow { color: var(--vscode-charts-yellow); }
  .col-charts-orange { color: var(--vscode-charts-orange, var(--vscode-charts-yellow)); }

  .section > .mainline { background: var(--vscode-sideBarSectionHeader-background); }
  .inbox-header { cursor: default; }
  .inbox-header .label { text-transform: uppercase; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; }

  #empty { padding: 16px; color: var(--vscode-descriptionForeground); font-style: italic; }
  #footer { padding: 4px 12px 6px 10px; color: var(--vscode-descriptionForeground); font-size: 0.9em; border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #footer.hidden { display: none; }
</style>
</head>
<body data-vscode-context='{&quot;preventDefaultContextMenuItems&quot;:true}'>
<div class="head">
  <span class="h-spacer"></span>
  <span class="h-title">Session</span>
  <span class="cell cell-status">Status</span>
  <span class="cell cell-time">Time</span>
  <span class="cell cell-model">Model</span>
  <span class="cell cell-tokens">Tokens</span>
</div>
<div id="root"></div>
<div id="footer" class="hidden"></div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const BRAND_SVG = ${JSON.stringify(brands)};
  const COL_EMPTY = "\\u2014";
  // Short status labels for the compact status column (the full phrase rides the hover).
  const shortStatus = { attention: "approve", question: "answer", working: "working", unread: "unread", done: "done", idle: "idle" };

  const saved = vscode.getState() || {};
  // Same XOR-toggle collapse model as the floating panel: a project/host row's
  // membership means "toggled away from the density default" (comfortable→open,
  // compact→open only when it needs you); session/workflow expansion sets mean
  // "explicitly expanded" (default collapsed).
  const collapsedProjects = new Set(saved.collapsedProjects || []);
  const expandedSessions = new Set(saved.expandedSessions || []);
  const expandedWorkflows = new Set(saved.expandedWorkflows || []);
  const collapsedHosts = new Set(saved.collapsedHosts || []);
  const collapsedRemoteProjects = new Set(saved.collapsedRemoteProjects || []);
  const expandedRemoteSessions = new Set(saved.expandedRemoteSessions || []);
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

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  // data-vscode-context attribute (double-quoted; esc() turns the JSON's " into
  // &quot; which the parser decodes back to valid JSON). No untrusted text ever
  // breaks out of the attribute, so there is no XSS surface — and native menu labels
  // come from package.json, never from data.
  function ctx(obj) { return ' data-vscode-context="' + esc(JSON.stringify(obj)) + '"'; }
  function colorClass(name) { return name ? "col-" + String(name).split(".").join("-") : ""; }

  function densityDefaultOpen(needsYou) {
    return model && model.density === "compact" ? (needsYou || 0) > 0 : true;
  }
  function toggleKey(baseKey, needsYou) {
    return model && model.density === "compact"
      ? baseKey + "|" + (((needsYou || 0) > 0) ? "n" : "q")
      : baseKey;
  }
  function openState(defaultOpen, toggledSet, key) {
    return toggledSet.has(key) ? !defaultOpen : defaultOpen;
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
    return '<span class="twistie"><span class="codicon codicon-chevron-' + (open ? "down" : "right") + '"></span></span>';
  }
  function statusHtml(kind) {
    return '<span class="status s-' + esc(kind) + '">' + esc(shortStatus[kind] || "idle") + '</span>';
  }
  // The four aligned metric cells (status · time · model · tokens). MODEL/TOKENS are
  // hidden by the container query at narrow widths; their values also ride the sub-line
  // (foldcols) so nothing is lost when a column is folded away.
  function metrics(kind, cols) {
    const c = cols || {};
    return (
      '<span class="metrics">' +
        '<span class="cell cell-status">' + statusHtml(kind) + '</span>' +
        '<span class="cell cell-time">' + esc(c.time || "") + '</span>' +
        '<span class="cell cell-model">' + esc(c.model || COL_EMPTY) + '</span>' +
        '<span class="cell cell-tokens">' + esc(c.tokens || COL_EMPTY) + '</span>' +
      '</span>'
    );
  }
  // The folded MODEL·TOKENS shown in the sub-line at narrow widths (only the present
  // ones; empty when the row has neither).
  function foldCols(cols) {
    const c = cols || {};
    const parts = [];
    if (c.model) parts.push(c.model);
    if (c.tokens) parts.push(c.tokens);
    if (parts.length === 0) return "";
    return '<span class="foldcols">' + esc(parts.join(" \\u00b7 ")) + '</span>';
  }
  function sublineHtml(inner) {
    return inner ? '<div class="subline">' + inner + '</div>' : "";
  }

  function acctBadge(multiHome, homeColor, homeLabel) {
    if (!(multiHome && homeColor)) return { cls: "", badge: "" };
    const cls = colorClass(homeColor);
    const badge = '<span class="badge-acct ' + cls + '" title="' + esc(homeLabel) + '">' +
      esc((homeLabel || "?").charAt(0).toUpperCase()) + '</span>';
    return { cls: cls, badge: badge };
  }

  // ---- Leaf rows -----------------------------------------------------------
  // A free-tier LOCKED placeholder row: a lock glyph, the fixed label, and a quiet
  // "unlock" affordance (data-unlock → license menu). NO nav handle, NO
  // data-vscode-context (so the native right-click menu is empty), NO title tooltip,
  // NO children — the model it renders from carries no real session data.
  function lockedRow() {
    return (
      '<div class="row locked" data-unlock>' +
        '<div class="mainline" title="Unlock — get a license">' +
          twistie(false, false) +
          iconHtml("lock", "", false) +
          '<span class="label locked-label">' + esc("Not available in free version") + '</span>' +
          '<span class="metrics unlock-hint"><span class="codicon codicon-unlock"></span> Unlock</span>' +
        '</div>' +
      '</div>'
    );
  }

  function sessionHtml(s, multiHome) {
    if (s.locked) return lockedRow();
    const childCount = (s.children ? s.children.length : 0) + (s.codexChildren ? s.codexChildren.length : 0) + (s.cursorChildren ? s.cursorChildren.length : 0);
    const hasKids = childCount > 0;
    const open = expandedSessions.has(s.sessionId);
    const a = acctBadge(multiHome, s.homeColor, s.homeLabel);
    let out =
      '<div class="row session' + (s.freeTier ? " free-tier" : "") + '" data-nav="' + esc(s.sessionId) + '"' +
        (hasKids ? ' data-toggle-session="' + esc(s.sessionId) + '"' : "") +
        ctx({ webviewSection: "session", sessionId: s.sessionId }) + '>' +
        '<div class="mainline" title="' + esc(s.hover) + '">' +
          twistie(open, hasKids) +
          iconHtml(s.icon, s.iconColor, s.spin) +
          '<span class="label ' + a.cls + '">' + esc(s.title) + '</span>' +
          a.badge +
          metrics(s.statusKind, s.columns) +
        '</div>' +
        sublineHtml(foldCols(s.columns)) +
      '</div>';
    if (hasKids && open) {
      const kids =
        (s.children || []).map((c) => childHtml(c, s.sessionId)).join("") +
        (s.codexChildren || []).map((c) => codexHtml(c, { child: true })).join("") +
        (s.cursorChildren || []).map((c) => cursorHtml(c)).join("");
      out += '<div class="group">' + kids + '</div>';
    }
    return out;
  }

  function leafRow(opts) {
    // opts: { cls, section, idAttr, dim, nonav, hover, icon, iconColor, spin, brand,
    //         title, kind, columns, subInner }
    const navAttr = opts.idAttr || "";
    const section = opts.section ? ctx(opts.section) : "";
    return (
      '<div class="row ' + opts.cls + (opts.dim ? " free-tier" : "") + (opts.nonav ? " nonav" : "") + '"' + navAttr + section + '>' +
        '<div class="mainline" title="' + esc(opts.hover) + '">' +
          twistie(false, false) +
          iconHtml(opts.icon, opts.iconColor, opts.spin, opts.brand) +
          '<span class="label">' + esc(opts.title) + '</span>' +
          metrics(opts.kind, opts.columns) +
        '</div>' +
        sublineHtml(opts.subInner !== undefined ? opts.subInner : foldCols(opts.columns)) +
      '</div>'
    );
  }

  // A cursor row (top-level or a folded child). A demoted external ended / orphaned run
  // renders dimmed + non-clickable (no nav handle) but still hideable.
  function cursorHtml(c) {
    if (c.locked) return lockedRow();
    return leafRow({
      cls: "cursor", section: { webviewSection: "cursor", chatId: c.chatId },
      idAttr: c.demoted ? "" : ' data-cursor="' + esc(c.chatId) + '"',
      dim: c.freeTier || c.demoted, nonav: c.demoted,
      hover: c.hover, icon: c.icon, iconColor: c.iconColor, spin: c.spin, brand: c.brand,
      title: c.title, kind: c.statusKind, columns: c.columns,
    });
  }
  // A codex row (top-level project row or a folded child). A demoted external ended
  // run renders dimmed + non-clickable (no nav handle) but still hideable. A folded
  // child shows its dim provenance label before the folded columns so it reads as a child.
  function codexHtml(c, opts) {
    if (c.locked) return lockedRow();
    opts = opts || {};
    const dim = c.freeTier || c.demoted;
    const prov = opts.child && c.provenance ? '<span class="prov">' + esc(c.provenance) + '</span>' : "";
    const fc = foldCols(c.columns);
    return leafRow({
      cls: "codex", section: { webviewSection: "codex", codexId: c.id },
      idAttr: c.demoted ? "" : ' data-codex="' + esc(c.id) + '"',
      dim: dim, nonav: c.demoted,
      hover: c.hover, icon: c.icon, iconColor: c.iconColor, spin: c.spin, brand: c.brand,
      title: c.title, kind: c.statusKind, columns: c.columns,
      subInner: prov + fc,
    });
  }
  function composerHtml(c) {
    if (c.locked) return lockedRow();
    return leafRow({
      cls: "composer", section: { webviewSection: "composer", conversationId: c.conversationId },
      idAttr: ' data-composer="' + esc(c.conversationId) + '"', dim: c.freeTier,
      hover: c.hover, icon: c.icon, iconColor: c.iconColor, spin: c.spin,
      title: c.title, kind: c.statusKind, columns: c.columns,
    });
  }

  // Activity-tree child (workflow/agent/task). Workflows nest their agents. These are
  // read-only rows with no per-node menu (matching the tree, which gives them none).
  function childHtml(c, keyPrefix) {
    const hasKids = c.kind === "workflow" && c.children && c.children.length > 0;
    const wfKey = keyPrefix + "|" + c.label;
    const open = expandedWorkflows.has(wfKey);
    const attrs = hasKids ? ' data-toggle-workflow="' + esc(wfKey) + '"' : "";
    // External-model attribution (Goal B): a wrapper subagent ("gpt-5.5: …", etc.)
    // surfaces its external CLI id as an honest badge; the row is still a Claude agent.
    const extBadge = c.extModel ? '<span class="badge-ext" title="external model (driven by a Claude subagent)">' + esc(c.extModel) + '</span>' : "";
    let out =
      '<div class="row child nonav"' + attrs + '>' +
        '<div class="mainline" title="' + esc(c.hover) + '">' +
          twistie(open, hasKids) +
          iconHtml(c.icon, c.iconColor, c.spin) +
          '<span class="label">' + esc(c.label) + '</span>' +
          extBadge +
          '<span class="metrics"><span class="cell cell-time">' + esc(c.description || "") + '</span></span>' +
        '</div>' +
      '</div>';
    if (hasKids && open) {
      out += '<div class="group">' + c.children.map((a) => childHtml(a, wfKey)).join("") + '</div>';
    }
    return out;
  }

  // ---- Needs-you inbox (command center; rendered FIRST, above projects) ------
  function inboxRowHtml(r, multiHome) {
    const navAttr =
      r.kind === "session" ? ' data-nav="' + esc(r.sessionId) + '"'
      : r.kind === "cursor" ? ' data-cursor="' + esc(r.chatId) + '"'
      : r.kind === "codex" ? ' data-codex="' + esc(r.codexId) + '"'
      : "";
    // Inbox rows are a VIEW of the real rows below; hide/props act on the real row
    // (its section carries the real id), matching the tree's inbox-ref semantics.
    const section =
      r.kind === "session" ? { webviewSection: "session", sessionId: r.sessionId }
      : r.kind === "cursor" ? { webviewSection: "cursor", chatId: r.chatId }
      : r.kind === "codex" ? { webviewSection: "codex", codexId: r.codexId }
      : null;
    const a = acctBadge(multiHome, r.homeColor, r.homeLabel);
    return (
      '<div class="row session"' + navAttr + (section ? ctx(section) : "") + '>' +
        '<div class="mainline" title="' + esc(r.hover) + '">' +
          twistie(false, false) +
          iconHtml(r.icon, r.iconColor, r.spin, r.brand) +
          '<span class="label ' + a.cls + '">' + esc(r.title) + '</span>' +
          a.badge +
          metrics(r.statusKind, r.columns) +
        '</div>' +
        sublineHtml(foldCols(r.columns)) +
      '</div>'
    );
  }
  function inboxHtml(rows, multiHome) {
    const header =
      '<div class="row section inbox-header">' +
        '<div class="mainline" title="Sessions ranked by urgency — a view of the rows below">' +
          twistie(false, false) +
          '<span class="icon col-charts-red"><span class="codicon codicon-bell-dot"></span></span>' +
          '<span class="label">Needs you (' + rows.length + ')</span>' +
        '</div>' +
      '</div>';
    return header + '<div class="group">' + rows.map((r) => inboxRowHtml(r, multiHome)).join("") + '</div>';
  }

  // ---- Project sections -----------------------------------------------------
  function projectHtml(p) {
    const key = toggleKey(p.cwd, p.needsYou);
    const open = openState(densityDefaultOpen(p.needsYou), collapsedProjects, key);
    const section = p.pinned ? "project-pinned" : "project-unpinned";
    // Worktree caption (Goal A, minimal flat fallback): the TREE nests worktrees
    // under their main repo; here a worktree project stays a flat top row with a
    // "↳ <branch> · worktree of <mainRepoName>" subline. Richer nesting is a follow-up.
    const wtCaption = p.branch
      ? '<div class="subline wt-caption">↳ ⑂ ' + esc(p.branch) + (p.worktreeOf ? ' · worktree of ' + esc(p.worktreeOf) : "") + '</div>'
      : "";
    let out =
      '<div class="row project section" data-toggle-project="' + esc(key) + '"' +
        ctx({ webviewSection: section, cwd: p.cwd }) + '>' +
        '<div class="mainline" title="' + esc(p.cwd) + '">' +
          twistie(open, true) +
          '<span class="label section-label">' + esc(p.name) + '</span>' +
          '<span class="section-desc">' + esc(p.description || "") + '</span>' +
        '</div>' +
        wtCaption +
      '</div>';
    if (open) {
      const kids =
        p.sessions.map((s) => sessionHtml(s, model.multiHome)).join("") +
        (p.cursors || []).map((c) => cursorHtml(c)).join("") +
        (p.codexes || []).map((c) => codexHtml(c)).join("") +
        (p.composers || []).map((c) => composerHtml(c)).join("");
      out += '<div class="group">' + kids + '</div>';
    }
    return out;
  }

  // ---- Remote host sections (read-only; every string escaped) ---------------
  function remoteChildHtml(c) {
    return (
      '<div class="row child nonav">' +
        '<div class="mainline" title="' + esc(c.hover) + '">' +
          twistie(false, false) +
          iconHtml(c.icon, c.iconColor, c.spin) +
          '<span class="label">' + esc(c.label) + '</span>' +
          '<span class="metrics"><span class="cell cell-time">' + esc(c.description || "") + '</span></span>' +
        '</div>' +
      '</div>'
    );
  }
  function remoteSessionHtml(s, hostId) {
    const hasKids = s.children && s.children.length > 0;
    const key = hostId + "|" + s.id;
    const open = expandedRemoteSessions.has(key);
    let out =
      '<div class="row session nonav"' + (hasKids ? ' data-toggle-rsession="' + esc(key) + '"' : "") + '>' +
        '<div class="mainline" title="' + esc(s.hover) + '">' +
          twistie(open, hasKids) +
          iconHtml(s.icon, s.iconColor, s.spin, s.brand) +
          '<span class="label">' + esc(s.title) + '</span>' +
          metrics(s.statusKind, s.columns) +
        '</div>' +
        sublineHtml(foldCols(s.columns)) +
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
      '<div class="row project section" data-toggle-rproject="' + esc(key) + '">' +
        '<div class="mainline" title="' + esc(p.cwd) + '">' +
          twistie(open, true) +
          '<span class="label section-label">' + esc(p.name) + '</span>' +
          '<span class="section-desc">' + esc(p.description || "") + '</span>' +
        '</div>' +
      '</div>';
    if (open) out += '<div class="group">' + p.sessions.map((s) => remoteSessionHtml(s, hostId)).join("") + '</div>';
    return out;
  }
  function hostHtml(h) {
    const key = toggleKey(h.hostId, h.needsYou);
    const open = openState(densityDefaultOpen(h.needsYou), collapsedHosts, key);
    const staleCls = h.stale ? " stale" : "";
    let out =
      '<div class="row host section' + staleCls + '" data-toggle-host="' + esc(key) + '">' +
        '<div class="mainline" title="' + esc(h.label) + '">' +
          twistie(open, true) +
          '<span class="icon"><span class="codicon codicon-server-environment"></span></span>' +
          '<span class="label section-label">' + esc(h.label) + '</span>' +
          '<span class="section-desc">' + esc(h.description || "") + '</span>' +
        '</div>' +
      '</div>';
    if (open) out += '<div class="group' + staleCls + '">' + h.projects.map((p) => remoteProjectHtml(p, h.hostId)).join("") + '</div>';
    return out;
  }

  function render() {
    const root = document.getElementById("root");
    const hasProjects = model && model.projects && model.projects.length > 0;
    const hasHosts = model && model.hosts && model.hosts.length > 0;
    const inboxRows = model && model.inbox ? model.inbox : [];
    if (!hasProjects && !hasHosts && inboxRows.length === 0) {
      root.innerHTML = '<div id="empty">No sessions to show.</div>';
      setFooter();
      return;
    }
    root.innerHTML =
      (inboxRows.length > 0 ? inboxHtml(inboxRows, model.multiHome) : "") +
      (hasProjects ? model.projects.map(projectHtml).join("") : "") +
      (hasHosts ? model.hosts.map(hostHtml).join("") : "");
    setFooter();
  }
  function setFooter() {
    const footer = document.getElementById("footer");
    const notes = [model && model.capabilityNote, model && model.collisionNote].filter(Boolean);
    if (notes.length > 0) { footer.textContent = notes.join(" \\u00b7 "); footer.className = ""; }
    else { footer.textContent = ""; footer.className = "hidden"; }
  }

  // ---- Collapse / expand all (driven by the toolbar via postMessage) ---------
  function setToggled(set, key, def, wantOpen) {
    const isOpen = set.has(key) ? !def : def;
    if (isOpen !== wantOpen) { if (set.has(key)) set.delete(key); else set.add(key); }
  }
  function setAll(wantOpen) {
    if (!model) return;
    for (const p of (model.projects || [])) {
      setToggled(collapsedProjects, toggleKey(p.cwd, p.needsYou), densityDefaultOpen(p.needsYou), wantOpen);
      for (const s of (p.sessions || [])) {
        const kids = (s.children ? s.children.length : 0) + (s.codexChildren ? s.codexChildren.length : 0) + (s.cursorChildren ? s.cursorChildren.length : 0);
        if (kids > 0) { if (wantOpen) expandedSessions.add(s.sessionId); else expandedSessions.delete(s.sessionId); }
        for (const c of (s.children || [])) {
          if (c.kind === "workflow" && c.children && c.children.length > 0) {
            const wk = s.sessionId + "|" + c.label;
            if (wantOpen) expandedWorkflows.add(wk); else expandedWorkflows.delete(wk);
          }
        }
      }
    }
    for (const h of (model.hosts || [])) {
      setToggled(collapsedHosts, toggleKey(h.hostId, h.needsYou), densityDefaultOpen(h.needsYou), wantOpen);
      for (const p of (h.projects || [])) {
        setToggled(collapsedRemoteProjects, toggleKey(h.hostId + "|" + p.cwd, p.needsYou), densityDefaultOpen(p.needsYou), wantOpen);
        for (const s of (p.sessions || [])) {
          if (s.children && s.children.length > 0) {
            const sk = h.hostId + "|" + s.id;
            if (wantOpen) expandedRemoteSessions.add(sk); else expandedRemoteSessions.delete(sk);
          }
        }
      }
    }
    persist();
    render();
  }

  // ---- Click: toggles (twistie) and navigation ------------------------------
  document.getElementById("root").addEventListener("click", (ev) => {
    const row = ev.target.closest(".row");
    if (!row) return;
    // Free-tier locked placeholder: only the quiet unlock affordance acts.
    if (row.hasAttribute("data-unlock")) { vscode.postMessage({ type: "unlock" }); return; }
    const onTwistie = ev.target.closest(".twistie") !== null;

    const proj = row.getAttribute("data-toggle-project");
    if (proj !== null) { toggleSet(collapsedProjects, proj); return; }
    const host = row.getAttribute("data-toggle-host");
    if (host !== null) { toggleSet(collapsedHosts, host); return; }
    const rproj = row.getAttribute("data-toggle-rproject");
    if (rproj !== null) { toggleSet(collapsedRemoteProjects, rproj); return; }
    const rsess = row.getAttribute("data-toggle-rsession");
    if (rsess !== null && onTwistie) { toggleSet(expandedRemoteSessions, rsess); return; }
    const wf = row.getAttribute("data-toggle-workflow");
    if (wf !== null && onTwistie) { toggleSet(expandedWorkflows, wf); return; }
    const sess = row.getAttribute("data-toggle-session");
    if (sess !== null && onTwistie) { toggleSet(expandedSessions, sess); return; }

    const cursor = row.getAttribute("data-cursor");
    if (cursor !== null) { vscode.postMessage({ type: "navigateCursor", chatId: cursor }); return; }
    const codex = row.getAttribute("data-codex");
    if (codex !== null) { vscode.postMessage({ type: "navigateCodex", id: codex }); return; }
    const composer = row.getAttribute("data-composer");
    if (composer !== null) { vscode.postMessage({ type: "navigateComposer", conversationId: composer }); return; }
    const nav = row.getAttribute("data-nav");
    if (nav !== null) vscode.postMessage({ type: "navigate", sessionId: nav });
  });
  function toggleSet(set, key) {
    if (set.has(key)) set.delete(key); else set.add(key);
    persist(); render();
  }

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === "model") {
      model = msg.model;
      // A density flip resets project-level toggles so the fresh density default
      // shows (the table's mirror of the sidebar's generation bump).
      const density = model.density || "comfortable";
      if (density !== lastDensity) {
        lastDensity = density;
        collapsedProjects.clear();
        collapsedHosts.clear();
        collapsedRemoteProjects.clear();
        persist();
      }
      render();
    } else if (msg.type === "setAllCollapsed") {
      setAll(!msg.collapsed);
    }
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
