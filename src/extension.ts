import * as vscode from "vscode";
import { existsSync, watch, FSWatcher, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, join } from "node:path";
import * as os from "node:os";
import { ConfigHome, detectConfigHomes } from "./homes";
import {
  EventTail,
  hooksInstalled,
  hooksInstalledInAnyHome,
  hooksCoverage,
  hookScriptStale,
  installHooks,
  isPermissionRequest,
  refreshHookScript,
  removeHooks,
  STATE_DIR,
  enableCursorMonitoring,
  disableCursorMonitoring,
  cursorMonitoringInstalled,
  renewLeaseIfDue,
  CURSOR_SPOOL,
} from "./hooks";
import { focusLocalTerminal } from "./injector";
import { Navigator, navigationEnabled, resolveEditorCli, commandOnPath } from "./navigation";
import { procIntrospection, procCensusAgeSec } from "./procs";
import { hasNodeSqlite, hasPython3, sqliteSelect } from "./sqliteRead";
import { buildDoctorReport, DOCTOR_SCHEME, CAPTURE_SUMMARY_SCHEME, DoctorProbes, buildDebugReport, DEBUG_REPORT_SCHEME, SettingEntry, TickWatchdog, TickPath } from "./doctor";
import { TitleSource } from "./titles";
import { TokenScanner } from "./discovery";
import { cursorSessions, CursorEventTail, ComposerTracker } from "./cursor";
import { codexSessions } from "./codex";
import { fmtAge, snapshot, hotWatchTargets, watchEventDirty, ReuseHint, WatchTarget } from "./discovery";
import {
  sanitizeReason,
  sessionPropertiesMarkdown,
  codexPropertiesMarkdown,
  cursorPropertiesMarkdown,
  composerPropertiesMarkdown,
  Density,
  Layout,
  collapseTarget,
  decidePanelBuild,
  filterBadgeLabel,
  filterIsActive,
  type AgentFamily,
  AGENT_FAMILIES,
  AGENT_FAMILY_LABELS,
} from "./format";
import { FILTER_LABELS, FilterMode, SessionsProvider, SessionNode, CursorNode, ComposerNode, CodexNode, ProjectNode, RemoteSessionNode, InboxRefNode, SortMode, TRIAL_START_KEY } from "./tree";
import { AccountDecorationProvider } from "./decorations";
import { OverviewPanel } from "./panel";
import { TableViewProvider } from "./tableView";
import { BridgeClient, buildSnapshot } from "./bridge";
import {
  copyMissingMementoValues,
  hostDisplayLabel,
  installedLegacyExtensions,
  legacyExtensionMessage,
  migrateLegacySettings,
  parseLegacyMemento,
} from "./bridgeSchema";
import { HostIdentity, loadHostIdentity } from "./hostid";
import { SessionAlerts } from "./alerts";
import { FocusDigest, digestMessage } from "./digest";
import { UnfocusedAlerts, UnfocusedAlertConfig, resolvePlatformTools } from "./osalert";
import { formatHealth, driftHarness, hooksHealth, affectedSources, captureFixtureSlice, buildCaptureSummary, CaptureIdentity } from "./canary";
import {
  BUY_URL,
  TRIAL_MS,
  decideKeyExpiredNotice,
  decideTrialToast,
  expiredMonthlyKey,
  isLicensed,
  isReturningInstall,
  keyExpiredMessage,
  licenseStatusItem,
  WELCOME_MESSAGE,
  TRIAL_ENDED_MESSAGE,
  TRIAL_ENDED_ELSEWHERE_MESSAGE,
  licenseKeyProblem,
  ENTER_KEY_PROMPT,
  licenseState,
  mergeTrialStart,
  trialWasObserved,
} from "./license";
import { registerLicenseDebugCommand } from "./debug/licenseDebug";
import { buildControlPanelRows, ControlRow, ControlPanelInput, ControlMark, WHATS_INCLUDED_MD } from "./controlPanel";

const PREVIEW_SCHEME = "sessiondeck";
const PROPS_SCHEME = "sessiondeck-props";
const LICENSE_SCHEME = "sessiondeck-license";
const LEGACY_EXTENSION_ID = "lensky.claude-overview";

async function migrateRenameState(
  context: vscode.ExtensionContext
): Promise<{ legacyMemento: boolean; legacySettings: boolean }> {
  const rootConfig = vscode.workspace.getConfiguration();
  const legacySettings = await migrateLegacySettings({
    inspect: (key) => {
      const value = rootConfig.inspect<unknown>(key);
      return value === undefined
        ? undefined
        : { globalValue: value.globalValue, workspaceValue: value.workspaceValue };
    },
    update: (key, value, target) =>
      rootConfig.update(
        key,
        value,
        target === "global" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace
      ),
  });

  const globalStorageRoot = join(context.globalStorageUri.fsPath, "..");
  const rows = await sqliteSelect(
    join(globalStorageRoot, "state.vscdb"),
    `SELECT value FROM ItemTable WHERE key='${LEGACY_EXTENSION_ID}'`
  );
  const legacyMemento = parseLegacyMemento(rows?.[0]?.[0]);
  // In a remote window this reads the remote host's state DB, which never holds
  // the old memento (VS Code keeps extension mementos on the desktop side), so
  // it finds nothing there. The trial origin still arrives via the desktop
  // companion; the welcome logic below copes with it arriving late.
  if (legacyMemento !== undefined) {
    await copyMissingMementoValues(context.globalState, legacyMemento);
  }

  // The extension id owns globalStorage too. Copy missing files so drift fixtures
  // and cross-window navigation state remain available; old data is retained.
  const legacyStorage = join(globalStorageRoot, LEGACY_EXTENSION_ID);
  if (existsSync(legacyStorage)) {
    await cp(legacyStorage, context.globalStorageUri.fsPath, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }
  return { legacyMemento: legacyMemento !== undefined, legacySettings };
}

/** Icon colour per Control Panel row mark (ThemeColor id). `action`/undefined keeps
 *  the default foreground so a clickable action row reads as prominent, not muted. */
const CONTROL_MARK_COLOR: Record<ControlMark, string | undefined> = {
  ok: "charts.green",
  problem: "errorForeground",
  info: "disabledForeground",
  action: undefined,
};

/** Thin TreeDataProvider for the collapsible Control Panel view. All row logic is
 *  the pure buildControlPanelRows(); this only maps a ControlRow → TreeItem (icon +
 *  colour by mark, a never-truncated MarkdownString tooltip, and the click command)
 *  and re-reads the live snapshot on refresh(). */
class ControlPanelProvider implements vscode.TreeDataProvider<ControlRow> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private rows: ControlRow[] = [];
  constructor(private readonly supply: () => ControlPanelInput) {
    this.rows = buildControlPanelRows(supply());
  }
  refresh(): void {
    this.rows = buildControlPanelRows(this.supply());
    this.emitter.fire();
  }
  dispose(): void {
    this.emitter.dispose();
  }
  getChildren(element?: ControlRow): ControlRow[] {
    return element === undefined ? this.rows : []; // flat: rows are leaves
  }
  getTreeItem(row: ControlRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = row.id;
    item.contextValue = "control-row";
    const md = new vscode.MarkdownString(row.tooltip);
    md.supportThemeIcons = true;
    item.tooltip = md;
    const color = CONTROL_MARK_COLOR[row.mark];
    item.iconPath = color !== undefined ? new vscode.ThemeIcon(row.icon, new vscode.ThemeColor(color)) : new vscode.ThemeIcon(row.icon);
    if (row.command !== undefined) item.command = { command: row.command, title: row.label };
    return item;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const activatedAt = Date.now();
  // Read before anything this activation creates it: the folder holds the host id
  // and hook spool, so its presence means SessionDeck (or its former name) ran here.
  const stateDirExisted = existsSync(STATE_DIR);
  let legacy = { legacyMemento: false, legacySettings: false };
  try {
    legacy = await migrateRenameState(context);
  } catch (err) {
    console.warn(`[sessiondeck] rename migration was incomplete: ${String(err)}`);
  }
  // An old-name copy still installed next to SessionDeck duplicates the tree and
  // writes the same hook script. Say so once per window, with the way out.
  const legacyInstalled = installedLegacyExtensions((id) => vscode.extensions.getExtension(id) !== undefined);
  if (legacyInstalled.length > 0) {
    void vscode.window
      .showWarningMessage(legacyExtensionMessage(legacyInstalled), "Show in Extensions")
      .then((choice) => {
        if (choice === "Show in Extensions")
          void vscode.commands.executeCommand("workbench.extensions.search", legacyInstalled[0]);
      });
  }
  // A returning user has seen the product: no first-run "free for 3 days" welcome,
  // even when (in a remote window) their old trial state hasn't reached us yet.
  if (
    context.globalState.get<boolean>("trialWelcomeShown") === undefined &&
    isReturningInstall({ ...legacy, stateDirExisted })
  ) {
    await context.globalState.update("trialWelcomeShown", true);
  }
  let refreshFn: () => void = () => undefined;
  const getExtraDirs = (): string[] =>
    vscode.workspace.getConfiguration("sessionDeck").get<string[]>("extraConfigDirs", []);
  const computeHomes = (): ConfigHome[] => detectConfigHomes(getExtraDirs());

  // Cached hooks capability state for the empty-state welcome (context key) and the
  // degraded-capability note. Recomputed at activation and whenever hooks are
  // installed/removed — never per 3s tick (that would re-read every settings.json).
  let hooksProbe = { installed: false, stale: false, homesInstalled: 0, homesTotal: 0 };
  const syncHooksContext = (): void => {
    const homes = computeHomes();
    const coverage = hooksCoverage(homes);
    hooksProbe = {
      installed: hooksInstalled(homes),
      stale: hookScriptStale(),
      homesInstalled: coverage.installed,
      homesTotal: coverage.total,
    };
    void vscode.commands.executeCommand("setContext", "sessionDeck.hooksInstalled", hooksProbe.installed);
  };
  syncHooksContext();

  const titles = new TitleSource(context.globalStorageUri, () => refreshFn());
  // Off-tick model/mode/token scanner: pre-window session scans + lazy subagent
  // scans, one file at a time, each completion firing a refresh so a resolved total
  // replaces its "…" placeholder. Assigned to the provider below.
  const tokenScanner = new TokenScanner(() => refreshFn());
  const decorations = new AccountDecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations));
  const showCursorAgents = (): boolean =>
    vscode.workspace.getConfiguration("sessionDeck").get<boolean>("showCursorAgents", true);
  const showCodexAgents = (): boolean =>
    vscode.workspace.getConfiguration("sessionDeck").get<boolean>("showCodexAgents", true);
  const showCursorComposer = (): boolean =>
    vscode.workspace.getConfiguration("sessionDeck").get<boolean>("showCursorComposer", true);
  const composerTracker = new ComposerTracker();
  const cursorTail = new CursorEventTail();
  const cursorProbeErrorCount = (): number => {
    try {
      const text = readFileSync(`${CURSOR_SPOOL}.probe-errors`, "utf8");
      return text.split(/\r?\n/).filter((line) => line.length > 0).length;
    } catch {
      return 0;
    }
  };
  const cursorProbeHasErrors = (): boolean => {
    try {
      return statSync(`${CURSOR_SPOOL}.probe-errors`).size > 0;
    } catch {
      return false;
    }
  };
  const cursorSpoolFreshSec = (): number => {
    try {
      return Math.max(0, Math.round((Date.now() - statSync(CURSOR_SPOOL).mtimeMs) / 1000));
    } catch {
      return -1;
    }
  };

  // Cross-host bridge (plan §2/§6). crossHost is the master toggle: off = publish,
  // fetch and the install prompt are all suppressed and behavior is identical to a
  // single-host build. A failed identity load disables cross-host for the session
  // without ever breaking activation.
  const crossHostEnabled = (): boolean =>
    vscode.workspace.getConfiguration("sessionDeck").get<boolean>("crossHost", true);
  let hostIdentity: HostIdentity | undefined;
  let hostIdentityError: string | undefined;
  try {
    hostIdentity = loadHostIdentity();
  } catch (err) {
    hostIdentity = undefined;
    hostIdentityError = err instanceof Error ? err.message : String(err);
    console.log(`[sessiondeck] host identity unavailable — cross-host disabled: ${String(err)}`);
  }

  const provider = new SessionsProvider(
    context.globalState,
    context.extensionUri,
    (sid) => titles.get(sid),
    (labels) => decorations.syncLabels(labels),
    () => vscode.workspace.getConfiguration("sessionDeck").get<boolean>("activityTree", false),
    () => (showCursorAgents() ? cursorSessions() : []),
    () => (showCodexAgents() ? codexSessions() : []),
    () => {
      composerTracker.ingest(cursorTail.readNew());
      return showCursorComposer() ? composerTracker.rows() : [];
    },
    () => densityOf(),
    () => layoutOf(),
    () => vscode.workspace.getConfiguration("sessionDeck").get<boolean>("inboxLane", true)
  );
  provider.tokenScanner = tokenScanner;
  // Carry the trial origin across the user's own machines via Settings Sync, so the
  // grain matches the license (per-person, not per-machine): a synced trialStart on
  // a fresh machine means the evaluation doesn't silently restart there. The bridge
  // companion is the authority WITHIN a machine (see reconcileTrialStart below);
  // this is the cross-machine leg. Both only ever move the origin EARLIER.
  context.globalState.setKeysForSync([TRIAL_START_KEY]);
  // Tick budget watchdog: a ring buffer of the last 100 refresh-tick timings whose
  // latch (sustained slow ticks or a throw) drives a lowest-priority capability note
  // + a doctor/debug section. Fed by the thin instrumentation in refresh() below.
  const watchdog = new TickWatchdog();

  const view = vscode.window.createTreeView("sessionDeck.sessions", {
    treeDataProvider: provider,
  });
  context.subscriptions.push(view);
  const syncFilterIndicator = (): void => {
    view.description = filterBadgeLabel(provider.filterMode, provider.hiddenAgentTypes);
    void vscode.commands.executeCommand(
      "setContext",
      "sessionDeck.filterActive",
      filterIsActive(provider.filterMode, provider.hiddenAgentTypes)
    );
  };
  syncFilterIndicator();
  // The provider owns the remote last-message command + content-provider
  // disposables (registered in its constructor) — dispose them with the extension.
  context.subscriptions.push({ dispose: () => provider.dispose() });

  const pkgVersion = ((): string => {
    const v = (context.extension.packageJSON as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  })();
  const bridge = new BridgeClient({
    selfHostId: hostIdentity?.id,
    ourVersion: pkgVersion,
    // crossHost off = zero work: skip the 60s hello probe entirely (a later flip
    // back to true just needs a reload — no config watcher).
    enabled: () => crossHostEnabled(),
  });
  const syncTopologyContext = (): void => {
    void vscode.commands.executeCommand("setContext", "sessionDeck.inCursor", /cursor/i.test(vscode.env.appName));
    void vscode.commands.executeCommand("setContext", "sessionDeck.cursorMonitoring", cursorMonitoringInstalled());
    void vscode.commands.executeCommand("setContext", "sessionDeck.bridgeAvailable", bridge.available);
    void vscode.commands.executeCommand("setContext", "sessionDeck.crossHost", crossHostEnabled());
  };
  syncTopologyContext();
  context.subscriptions.push({ dispose: () => bridge.dispose() });
  // Pinned cross-agent contract (tree.ts provides these settable hooks): remote
  // hosts only surface when cross-host is enabled AND we have a self identity.
  provider.remoteHosts = () => (crossHostEnabled() && hostIdentity ? bridge.remoteHosts() : []);
  provider.selfHostId = () => hostIdentity?.id;
  // License key (validated OFFLINE inside the provider — never sent anywhere). Read
  // from settings each reload so entering a key takes effect on the next render.
  // Fallback: when this instance's own setting is empty (e.g. a remote whose
  // Settings Sync hasn't carried the key), use the local companion's key if it
  // reported one — same per-person license, just sourced via the bridge.
  provider.licenseKey = () => {
    const fromSetting = vscode.workspace.getConfiguration("sessionDeck").get<string>("licenseKey", "");
    if (fromSetting.length > 0) return fromSetting;
    return bridge.licenseCached?.key ?? "";
  };
  // Publisher version skew for the host-hover fact block: reuse the bridge's hello
  // handshake getters (no new probe). Surfaced only when it differs from ours.
  provider.publisherSkew = () => ({ version: bridge.companionVersion, skew: bridge.versionSkew });
  // Degraded-capability note probes: all cheap/in-memory reads (cached hooks state,
  // bridge liveness, config + the one-shot prompt guard) — no per-tick disk scan.
  provider.capabilityInput = () => ({
    hooksInstalled: hooksProbe.installed,
    hooksPartial: hooksProbe.homesInstalled > 0 && hooksProbe.homesInstalled < hooksProbe.homesTotal,
    hookScriptStale: hooksProbe.stale,
    platformSupportsHooks: process.platform !== "win32",
    inCursor: /cursor/i.test(vscode.env.appName),
    cursorMonitoringInstalled: cursorMonitoringInstalled(),
    cursorHooksSilent: cursorProbeHasErrors(),
    cursorMonitoringDismissed: context.globalState.get<boolean>("cursorMonitoringDismissed") === true,
    crossHostEnabled: crossHostEnabled(),
    bridgeAvailable: bridge.available,
    bridgePromptDismissed: false,
    // Format-canary note. hasNodeSqlite() is the sync engine-present gate for the
    // titles alarm (the other harnesses need no gate).
    driftHarness: driftHarness(formatHealth(hasNodeSqlite())),
    // Hook-payload shape canary: ≥2 recent events failed the structural check → the
    // spool payload may have drifted; ranked just above format-drift (see capability.ts).
    // In-memory ring read, no scan.
    hookDrift: hooksHealth().driftSuspected,
    // Tick watchdog: the lowest-priority note — surfaced only while latched. Read
    // here (during reload, i.e. BEFORE this tick records) so it reflects prior-tick
    // history and can't feed back on itself. Cheap in-memory getters, no scan.
    tickWatchdog: watchdog.isLatched ? { avgMs: watchdog.avgTotalMs } : undefined,
  });

  // Floating always-on-top mirror. A click in the webview routes to the exact
  // same navigation command a sidebar click uses, so cross-window focus/relay
  // just work; the header toggle flips the same global activity-tree setting the
  // toolbar button does.
  const buildPanelModel = () => provider.panelModel((label) => decorations.colorName(label));
  const overviewPanel = new OverviewPanel(
    context.extensionUri,
    (sessionId) => {
      const node = provider.findSession(sessionId);
      if (node !== undefined) void vscode.commands.executeCommand("sessionDeck.openSession", node);
    },
    () => void vscode.commands.executeCommand("sessionDeck.toggleActivityTree"),
    (chatId) => {
      const node = provider.findCursor(chatId);
      if (node !== undefined) void vscode.commands.executeCommand("sessionDeck.openCursor", node);
    },
    (id) => {
      const node = provider.findCodex(id);
      if (node !== undefined) void vscode.commands.executeCommand("sessionDeck.openCodex", node);
    },
    (conversationId) => {
      const node = provider.findComposer(conversationId);
      if (node !== undefined) void vscode.commands.executeCommand("sessionDeck.openComposer", node);
    },
    () => void vscode.commands.executeCommand("sessionDeck.licenseMenu")
  );
  context.subscriptions.push({ dispose: () => overviewPanel.dispose() });
  const tableView = new TableViewProvider(
    context.extensionUri,
    (sessionId) => {
      const node = provider.findSession(sessionId);
      if (node !== undefined) void vscode.commands.executeCommand("sessionDeck.openSession", node);
    },
    (chatId) => {
      const node = provider.findCursor(chatId);
      if (node !== undefined) void vscode.commands.executeCommand("sessionDeck.openCursor", node);
    },
    (id) => {
      const node = provider.findCodex(id);
      if (node !== undefined) void vscode.commands.executeCommand("sessionDeck.openCodex", node);
    },
    (conversationId) => {
      const node = provider.findComposer(conversationId);
      if (node !== undefined) void vscode.commands.executeCommand("sessionDeck.openComposer", node);
    },
    () => tableView.update(buildPanelModel()),
    () => void vscode.commands.executeCommand("sessionDeck.licenseMenu")
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("sessionDeck.table", tableView, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Control Panel: a collapsible sidebar segment (present under BOTH the tree and the
  // table layouts) that surfaces the three signals a user acts on — hooks (Claude +
  // Cursor families), the host bridge, and the license — plus the Buy / Enter Key /
  // What's-included actions. The row logic is the pure buildControlPanelRows(); the
  // input is a cheap synchronous read of state extension.ts already holds per tick.
  const controlPanelInput = (): ControlPanelInput => {
    const hosts = crossHostEnabled() && hostIdentity ? bridge.remoteHosts() : [];
    const now = Date.now();
    const newestAgeSec =
      hosts.length === 0 ? undefined : Math.max(0, Math.round(Math.min(...hosts.map((h) => now - h.receivedAt)) / 1000));
    return {
      platformSupportsHooks: process.platform !== "win32",
      hooksInstalled: hooksProbe.installed,
      hooksHomesInstalled: hooksProbe.homesInstalled,
      hooksHomesTotal: hooksProbe.homesTotal,
      hookScriptStale: hooksProbe.stale,
      hookDriftSuspected: hooksHealth().driftSuspected,
      cursorMonitoringInstalled: cursorMonitoringInstalled(),
      cursorProbeErrors: cursorProbeErrorCount(),
      cursorSpoolFreshSec: cursorSpoolFreshSec(),
      crossHost: crossHostEnabled(),
      hostIdentityOk: hostIdentity !== undefined,
      bridgeAvailable: bridge.available,
      bridgeCompanionVersion: bridge.companionVersion,
      bridgeVersionSkew: bridge.versionSkew,
      bridgeHostCount: hosts.length,
      bridgeNewestHostAgeSec: newestAgeSec,
      licenseState: provider.currentLicenseState,
      licenseOverLimit: provider.freeTierOverLimit,
      licenseCovered: provider.licenseCovered,
      licenseTotal: provider.licenseTotal,
      licenseKeyExpiredThrough: expiredMonthlyKey(provider.licenseKey(), Date.now()),
    };
  };
  const controlPanel = new ControlPanelProvider(controlPanelInput);
  const controlPanelView = vscode.window.createTreeView("sessionDeck.controlPanel", {
    treeDataProvider: controlPanel,
  });
  context.subscriptions.push(controlPanelView, { dispose: () => controlPanel.dispose() });

  const activityTreeOn = (): boolean =>
    vscode.workspace.getConfiguration("sessionDeck").get<boolean>("activityTree", false);
  const syncActivityTreeContext = (): void => {
    void vscode.commands.executeCommand("setContext", "sessionDeck.activityTree", activityTreeOn());
  };
  syncActivityTreeContext();

  // View density (sessionDeck.density): "compact" collapses project rows by
  // default and folds a pressure summary into each header. The toolbar toggle
  // (two ids, one action — the activity-tree pattern) shows a checked state via the
  // sessionDeck.compact context.
  const densityOf = (): Density =>
    vscode.workspace.getConfiguration("sessionDeck").get<string>("density", "comfortable") === "compact"
      ? "compact"
      : "comfortable";
  const syncDensityContext = (): void => {
    void vscode.commands.executeCommand("setContext", "sessionDeck.compact", densityOf() === "compact");
  };
  syncDensityContext();

  // View layout (sessionDeck.layout): "columns" renders session rows as aligned
  // time·status·model·tokens columns (a real grid in the panel, ordered slots in the
  // tree). Orthogonal to density; same two-id toolbar-toggle pattern, checked state
  // via the sessionDeck.columns context.
  const layoutOf = (): Layout =>
    vscode.workspace.getConfiguration("sessionDeck").get<string>("layout", "list") === "columns"
      ? "columns"
      : "list";
  const syncLayoutContext = (): void => {
    void vscode.commands.executeCommand("setContext", "sessionDeck.columns", layoutOf() === "columns");
  };
  syncLayoutContext();

  // In-window "needs-you" alerts (§ needs-you). Toasts are gated by the
  // notifications setting ("off" silences them; the chip below is always honest);
  // the tracker inside SessionAlerts dedups so one blocking incident toasts once.
  const notificationsOn = (): boolean =>
    vscode.workspace.getConfiguration("sessionDeck").get<string>("notifications", "urgent") !== "off";

  // OS-level escalation (§ needs-you): when a session comes to need you while THIS
  // window is unfocused, an in-window toast is easy to miss. Two opt-in channels
  // (both default off) — a short sound and/or a real OS notification — ride the
  // exact incidents that already toast, deliver only while unfocused, and are
  // rate-limited to one per 30s. Platform delivery commands are resolved once here.
  const unfocusedConfig = (): UnfocusedAlertConfig => {
    const c = vscode.workspace.getConfiguration("sessionDeck");
    return {
      sound: c.get<boolean>("unfocusedSound", false),
      osNotification: c.get<boolean>("unfocusedOsNotification", false),
    };
  };
  const soundFile = vscode.Uri.joinPath(context.extensionUri, "media", "unfocused-ping.wav").fsPath;
  const platformTools = resolvePlatformTools(process.platform, commandOnPath, soundFile);
  const unfocusedAlerts = new UnfocusedAlerts(
    () => vscode.window.state.focused,
    unfocusedConfig,
    platformTools
  );

  const alerts = new SessionAlerts(
    notificationsOn,
    (message, open) => {
      void vscode.window.showWarningMessage(message, "Open").then((choice) => {
        if (choice === "Open") open();
      });
      // Escalate to the opt-in OS channels. Fires once per fresh incident (this
      // callback is only reached for AlertTracker-deduped incidents), self-gates
      // on window focus, and rate-limits internally — a no-op unless opted in.
      unfocusedAlerts.onIncident(provider.unreadCount);
    },
    (sessionId) => {
      const node = provider.findSession(sessionId);
      if (node !== undefined) void vscode.commands.executeCommand("sessionDeck.openSession", node);
    },
    (hostId, sessionId) => {
      // Same navigation a live remote row click uses: focusRemoteSession posts the
      // focus to the owning host and degrades to the last-message preview when the
      // bridge can't relay it. Resolves the LOCAL node first (never from strings).
      const node = provider.findRemoteSessionNode(hostId, sessionId);
      if (node !== undefined) void vscode.commands.executeCommand("sessionDeck.focusRemoteSession", node);
    },
    // Approval burst corridor (§ needs-you): when ≥3 sessions block within 45s the
    // per-incident toasts collapse into ONE "N sessions need you" summary whose
    // [Triage] button opens the urgency-ranked walk — the corridor itself. Still
    // escalates the OS channel (its own 30s limiter keeps that burst-safe, so no
    // double-summary), and never touches AlertTracker's per-incident dedup.
    (message, triage) => {
      void vscode.window.showWarningMessage(message, "Triage", "Dismiss").then((choice) => {
        if (choice === "Triage") triage();
      });
      unfocusedAlerts.onIncident(provider.unreadCount);
    },
    () => void vscode.commands.executeCommand("sessionDeck.triage")
  );

  // Focus-return digest (§ needs-you). Per-incident toasts fire even while the
  // window is unfocused, so a needs-you moment that arose during a real absence can
  // get buried and go unseen. When focus returns after the window was unfocused
  // ≥10min, show ONE summary of what CAME to need you while away (delta vs the set
  // snapshotted at defocus) — additive to the toasts, never a re-toast, so it does
  // not touch AlertTracker's per-incident dedup in either direction. Gated by the
  // same notifications setting (off silences it too).
  const digest = new FocusDigest();
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      const ids = provider.needsYouIds();
      if (!state.focused) {
        digest.onBlur(Date.now(), ids);
        return;
      }
      // On focus regain (NOT per tick — that would re-read every settings.json every
      // 3s), re-probe hooks. syncHooksContext otherwise runs only at activation +
      // install/remove, so a hook removed EXTERNALLY (another editor, manual edit)
      // leaves the welcome strip's Install-Hooks nudge and the "approval alerts off"
      // capability note silently wrong. Re-syncing here refreshes the context key
      // (welcome strip) and hooksProbe, then a refresh rebuilds the capability note.
      syncHooksContext();
      refreshFn();
      const decision = digest.onFocus(Date.now(), ids, notificationsOn());
      if (!decision.show) return;
      void vscode.window.showInformationMessage(digestMessage(decision.count), "Triage").then((choice) => {
        if (choice === "Triage") void vscode.commands.executeCommand("sessionDeck.triage");
      });
    })
  );

  // Status-bar triage chip: `$(bell) N` where N = sessions needing you (mirrors
  // the activity-bar badge, includes live remote attention). Hidden at N === 0;
  // clicking reveals SessionDeck filtered to attention.
  const chip = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  chip.command = "sessionDeck.triage";
  context.subscriptions.push(chip);
  const updateChip = (): void => {
    const n = provider.unreadCount;
    if (n <= 0) {
      chip.hide();
      return;
    }
    chip.text = `$(bell) ${n}`;
    chip.tooltip = `${n} session(s) need you\nclick: triage · ctrl+alt+]: next`;
    chip.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    chip.show();
  };

  // Free-tier status-bar item: `$(key) Free tier`, shown ONLY when the fleet is
  // over the caps on the free tier, or on the last day of the trial — never when
  // licensed. Clicking opens a QuickPick: Enter Key / Buy / What's included.
  const keyItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  keyItem.command = "sessionDeck.licenseMenu";
  context.subscriptions.push(keyItem);
  const updateKeyItem = (): void => {
    const shown = licenseStatusItem(provider.currentLicenseState, provider.freeTierOverLimit);
    if (shown === undefined) {
      keyItem.hide();
      return;
    }
    keyItem.text = shown.text;
    keyItem.tooltip = shown.tooltip;
    keyItem.show();
  };

  // At most ONE reminder toast per day while free + over-limit (globalState-stamped
  // by calendar day). Honest register per the brand voice; buttons act immediately.
  const REMINDER_KEY = "licenseReminderDay";
  const maybeRemindLicense = (): void => {
    if (!provider.freeTierOverLimit) return;
    const today = new Date().toISOString().slice(0, 10); // local-ish calendar day
    if (context.globalState.get<string>(REMINDER_KEY) === today) return;
    void context.globalState.update(REMINDER_KEY, today);
    void vscode.window
      .showInformationMessage(
        "Free tier covers 3 sessions; you have more, and the extras are locked. A license covers all of them.",
        "Enter Key",
        "Buy",
        "Later"
      )
      .then((choice) => {
        if (choice === "Enter Key") void vscode.commands.executeCommand("sessionDeck.enterLicenseKey");
        else if (choice === "Buy") void vscode.commands.executeCommand("sessionDeck.buyLicense");
      });
  };

  // Two once-ever trial-lifecycle toasts (see docs/LICENSING.md, "Trial UX"): a
  // day-0 WELCOME courtesy when the evaluation begins and a TRIAL-ENDED tier-change
  // note the moment it lapses to free. The DECISION is the pure decideTrialToast();
  // it also reports which latches to persist. We write the returned latches BEFORE
  // showing (anti double-window: two racing windows can't both show). Welcome is
  // never latched when notifications are off, so off-through-trial suppresses it for
  // good; trial-ended's PENDING latch is armed independent of notifications, so an
  // off-through-trial user still gets it the first time notifications are on later.
  const WELCOME_KEY = "trialWelcomeShown";
  const TRIAL_END_PENDING_KEY = "trialEndedPending";
  const TRIAL_END_KEY = "trialEndedShown";
  const TRIAL_SEEN_KEY = "trialSeenAt";
  const WELCOME_DISPLAYED_KEY = "trialWelcomeDisplayed";
  // The trial origin is final once the desktop companion has reported its trial
  // start, or is known to be absent (cross-host off, probe gave up), or the probe
  // window has passed anyway (a companion too old to have the license command).
  const trialOriginSettled = (): boolean =>
    !crossHostEnabled() ||
    bridge.licenseCached !== undefined ||
    (bridge.probeSettled && !bridge.available) ||
    Date.now() - activatedAt > 60_000;
  const maybeTrialToast = (): void => {
    const trialStart = context.globalState.get<number>(TRIAL_START_KEY);
    const now = Date.now();
    // Recompute from globalState rather than the provider's last reload, so a
    // trial origin the companion just moved earlier is already reflected.
    const state = licenseState(provider.licenseKey(), now, trialStart ?? now);
    const settled = trialOriginSettled();
    if (settled && state.startsWith("trial:") && context.globalState.get<number>(TRIAL_SEEN_KEY) === undefined) {
      void context.globalState.update(TRIAL_SEEN_KEY, now);
    }
    const d = decideTrialToast({
      state,
      originSettled: settled,
      trialObserved: trialWasObserved(context.globalState.get<number>(TRIAL_SEEN_KEY), trialStart),
      welcomeDisplayed: context.globalState.get<boolean>(WELCOME_DISPLAYED_KEY) === true,
      notificationsOn: notificationsOn(),
      welcomeShown: context.globalState.get<boolean>(WELCOME_KEY) === true,
      trialEndedPending: context.globalState.get<boolean>(TRIAL_END_PENDING_KEY) === true,
      trialEndedShown: context.globalState.get<boolean>(TRIAL_END_KEY) === true,
      trialElapsed: trialStart !== undefined && Date.now() >= trialStart + TRIAL_MS,
      keyExpired: expiredMonthlyKey(provider.licenseKey(), Date.now()) !== undefined,
    });
    // Persist latches BEFORE showing (pending is armed even with notifications off).
    if (d.setTrialEndedPending === true) void context.globalState.update(TRIAL_END_PENDING_KEY, true);
    if (d.setWelcomeShown === true) void context.globalState.update(WELCOME_KEY, true);
    if (d.setTrialEndedShown === true) void context.globalState.update(TRIAL_END_KEY, true);
    if (d.toast === "welcome") {
      void context.globalState.update(WELCOME_DISPLAYED_KEY, true);
      void vscode.window
        .showInformationMessage(WELCOME_MESSAGE, "What's included")
        .then((choice) => {
          if (choice === "What's included") void vscode.commands.executeCommand("sessionDeck.whatsIncluded");
        });
    } else if (d.toast === "trial-ended" || d.toast === "trial-ended-elsewhere") {
      void vscode.window
        .showInformationMessage(
          d.toast === "trial-ended" ? TRIAL_ENDED_MESSAGE : TRIAL_ENDED_ELSEWHERE_MESSAGE,
          "Enter Key",
          "Buy"
        )
        .then((choice) => {
          if (choice === "Enter Key") void vscode.commands.executeCommand("sessionDeck.enterLicenseKey");
          else if (choice === "Buy") void vscode.commands.executeCommand("sessionDeck.buyLicense");
        });
    }
  };

  // Once per lapsed monthly key: the tier just dropped to free, so say so and name
  // the next step. Latched on the key's yyyy-mm BEFORE showing (two racing windows
  // can't both show); a later renewal that lapses gets its own notice.
  const KEY_EXPIRED_KEY = "licenseKeyExpiredNotified";
  const maybeKeyExpiredNotice = (): void => {
    const d = decideKeyExpiredNotice({
      key: provider.licenseKey(),
      nowMs: Date.now(),
      state: provider.currentLicenseState,
      notificationsOn: notificationsOn(),
      notifiedFor: context.globalState.get<string>(KEY_EXPIRED_KEY),
    });
    if (!d.show) return;
    void context.globalState.update(KEY_EXPIRED_KEY, d.through);
    // This notice already offers Enter Key; skip today's over-limit reminder.
    void context.globalState.update(REMINDER_KEY, new Date().toISOString().slice(0, 10));
    void vscode.window
      .showInformationMessage(keyExpiredMessage(d.through), "Enter Key", "Open sessiondeck.dev")
      .then((choice) => {
        if (choice === "Enter Key") void vscode.commands.executeCommand("sessionDeck.enterLicenseKey");
        else if (choice === "Open sessiondeck.dev") void vscode.commands.executeCommand("sessionDeck.buyLicense");
      });
  };

  // ---- Dirty-set discovery (perf) -------------------------------------------
  // Every 3s tick used to run a full snapshot() — readdir the registry, re-read
  // every registry file, stat every transcript, readdir+stat every activity dir —
  // even when nothing had changed (~74ms warm at 600 sessions). Instead we watch
  // the filesystem and let a QUIET tick reuse the cached snapshot wholesale, only
  // reclassifying sessions that actually changed:
  //  • sessionWatchers (one per home's sessions/ dir): a registry add/remove sets
  //    `registryChanged`, so the next tick rescans the live set.
  //  • projectWatchers (one per LIVE project's projects/<slug>/ dir): a transcript
  //    write to <slug>/<sessionId>.jsonl marks that sessionId dirty → reclassified
  //    next tick. This is what makes status/question/interrupt flips immediate.
  //  • hook-spool events (onHookEvents) mark their session dirty too.
  // A missed event (fs.watch is lossy; subagent/task writes live deeper than the
  // watched dir) is healed by a full reconcile every RECONCILE_EVERY ticks — the
  // freshness window (180s) is >> the reconcile interval (30s), so an active
  // subagent never wrongly ages out between reconciles.
  //
  // inotify cost (honest): each fs.watch is ONE inotify instance on Linux, and the
  // count grows with DISTINCT LIVE PROJECT DIRS (1 per project + 1 sessions/ watcher
  // per home). The default `fs.inotify.max_user_instances` is 128 PER USER (shared
  // across every process), so a host spread over ≳126 live project dirs would start
  // throwing on watch(). Two guards keep that safe: a soft cap watches only the
  // PROJECT_WATCHER_CAP most-recently-active dirs (the rest ride the ~30s reconcile,
  // which is always correct — just up to one interval slower), and any watch() that
  // still throws is caught + dropped, again leaving that project to the reconcile.
  const RECONCILE_EVERY = 10; // ~30s at the 3s poll — the missed-event safety net
  const PROJECT_WATCHER_CAP = 100; // most-recently-active dirs get fs.watch; rest reconcile
  const dirtySessions = new Set<string>();
  let registryChanged = false;
  let tickCount = 0;
  let warnedWatcherCap = false;

  // one fs.watch per home's sessions/ dir, reconciled as homes come and go
  const sessionWatchers = new Map<string, FSWatcher>();
  const reconcileWatchers = (homes: ConfigHome[]): void => {
    const wanted = new Set(homes.map((h) => join(h.dir, "sessions")));
    for (const [dir, w] of sessionWatchers) {
      if (wanted.has(dir)) continue;
      w.close();
      sessionWatchers.delete(dir);
    }
    for (const dir of wanted) {
      if (sessionWatchers.has(dir) || !existsSync(dir)) continue;
      try {
        const w = watch(dir, () => {
          // A session started/ended → the live set may have changed; force a
          // registry rescan next tick (unchanged rows still reuse their cache).
          registryChanged = true;
          refreshFn();
        });
        // an unhandled 'error' (dir removed, inotify limit) would throw in the
        // ext host; drop the watcher and let the next reconcile re-add it. A 'close'
        // (ours or the runtime's) must also free the slot, or the entry lingers and
        // reconcile never re-creates it. Both delete only if the map still holds THIS
        // watcher, so a fresh watcher for the same dir isn't clobbered by a stale event.
        w.on("error", () => {
          w.close();
          if (sessionWatchers.get(dir) === w) sessionWatchers.delete(dir);
        });
        w.on("close", () => {
          if (sessionWatchers.get(dir) === w) sessionWatchers.delete(dir);
        });
        sessionWatchers.set(dir, w);
      } catch {
        // dir vanished between existsSync and watch; retried next reconcile
      }
    }
  };

  // one fs.watch per HOT dir, reconciled to the live set after each snapshot. THREE
  // watcher families share ONE activity-ranked budget (hotWatchTargets ranks them
  // together, hottest-first):
  //  • PROJECT dirs (projects/<slug>/): a <sid>.jsonl write names the dirty session —
  //    the status/question/interrupt signal. A null filename (non-Linux) marks every
  //    session the dir hosts.
  //  • SUBAGENT dirs (…/<sid>/subagents/) for WORKING sessions with DIRECT agents: the
  //    non-recursive watch fires on a direct-agent spawn AND on every ongoing append
  //    (children are agent-<id>.jsonl), so direct-agent ⚙N is live ≤1 tick.
  //  • WORKFLOWS dirs (…/<sid>/subagents/workflows/) for WORKING sessions with workflow
  //    runs: the non-recursive watch fires when a NEW wf_* run appears (live ≤1 tick),
  //    but NOT on journal/nested-agent appends deep inside a wf_*/ dir — those stay
  //    reconcile-bound (the honest limit of a one-level watch).
  // Each event marks the OWNING session dirty (the parent transcript never sees these
  // child writes, so the project watcher alone can't). watchEventDirty (pure, in
  // discovery) does the event→sid routing. Because a project's heat ≥ its own sessions'
  // ⚙N heat, the shared cap can never drop a project's status watcher for that same
  // project's ⚙N watcher; across projects a hot orchestrator's ⚙N watcher may evict a
  // COLD project watcher (intended — the cold flip isn't imminent, the reconcile heals).
  const hotWatchers = new Map<string, FSWatcher>();
  const reconcileHotWatchers = (targets: WatchTarget[]): void => {
    // Soft cap: watch only the hottest dirs across all families. Colder targets past
    // the cap ride the ~30s reconcile — correct, just slower — so a busy host can't
    // exhaust inotify instances (the total budget is unchanged by adding ⚙N watchers).
    const capped = targets.slice(0, PROJECT_WATCHER_CAP);
    const wanted = new Map(capped.map((t) => [t.dir, t] as const));
    if (targets.length > PROJECT_WATCHER_CAP && !warnedWatcherCap) {
      warnedWatcherCap = true;
      console.log(
        `[sessiondeck] ${targets.length} hot watch targets exceed the ${PROJECT_WATCHER_CAP}-watcher soft cap; ` +
          `the coldest ${targets.length - PROJECT_WATCHER_CAP} rely on the ~30s reconcile (avoids exhausting inotify instances).`
      );
    }
    for (const [dir, w] of hotWatchers) {
      if (wanted.has(dir)) continue;
      w.close();
      hotWatchers.delete(dir);
    }
    for (const [dir, t] of wanted) {
      if (hotWatchers.has(dir) || !existsSync(dir)) continue;
      try {
        const w = watch(dir, (_e, filename) => {
          for (const sid of watchEventDirty(t, typeof filename === "string" ? filename : null)) {
            dirtySessions.add(sid);
          }
          refreshFn();
        });
        // 'error' AND 'close' both free the slot (a closed watcher left in the map
        // would never be re-created by reconcile — the silent-watch-loss codex
        // flagged). Guarded by watcher identity so a stale event can't drop a fresh
        // watcher for the same dir.
        w.on("error", () => {
          w.close();
          if (hotWatchers.get(dir) === w) hotWatchers.delete(dir);
        });
        w.on("close", () => {
          if (hotWatchers.get(dir) === w) hotWatchers.delete(dir);
        });
        hotWatchers.set(dir, w);
      } catch {
        // dir vanished between existsSync and watch; retried next reconcile
      }
    }
  };
  context.subscriptions.push({
    dispose: () => {
      for (const w of sessionWatchers.values()) w.close();
      for (const w of hotWatchers.values()) w.close();
    },
  });

  // Display label for a remote host id (for the transient status-bar message);
  // falls back to the short id when the host isn't in the current cache.
  const remoteHostLabel = (hostId: string): string => {
    const snap = bridge.remoteHosts().find((h) => h.host.id === hostId);
    return snap !== undefined ? hostDisplayLabel(snap.host) : hostId.slice(0, 8);
  };

  // Receiver (plan follow-up): perform a focus action posted by another host, but
  // ONLY when the referenced session is one this host currently knows — resolve
  // the LOCAL node first (never navigate from the action's strings) and invoke
  // the exact command a local click uses. Unknown session ids drop silently; the
  // action's cwd is a disambiguation hint only and is never fs-touched.
  const applyRemoteActions = async (selfHostId: string): Promise<void> => {
    const actions = await bridge.takeActions(selfHostId);
    for (const a of actions) {
      if (a.targetHostId !== selfHostId) continue; // defense in depth
      if (a.tool === "claude") {
        const node = provider.findSession(a.sessionId);
        if (node !== undefined) await vscode.commands.executeCommand("sessionDeck.openSession", node);
      } else if (a.tool === "cursor") {
        const node = provider.findCursor(a.sessionId);
        if (node !== undefined) await vscode.commands.executeCommand("sessionDeck.openCursor", node);
      } else if (a.tool === "codex") {
        const node = provider.findCodex(a.sessionId);
        if (node !== undefined) await vscode.commands.executeCommand("sessionDeck.openCodex", node);
      }
    }
  };

  // Prefer the local companion's canonical trial origin over this instance's local
  // globalState, PREFER-OLDER: only ever move the stamped trialStart EARLIER, never
  // reset it. This is what stops a trial restarting when the extension is reinstalled
  // into a fresh remote after the evaluation already began on this machine. When the
  // companion is absent/old (undefined license), the local value is untouched.
  // Dev-only: the license debug command resets the trial in this window; without
  // this the companion's older origin would be merged straight back next tick.
  let trialMergeSuspended = false;
  const reconcileTrialStart = async (): Promise<void> => {
    if (trialMergeSuspended) return;
    const bl = await bridge.license();
    if (bl === undefined) return;
    const local = context.globalState.get<number>(TRIAL_START_KEY);
    const merged = mergeTrialStart(local, bl.trialStart);
    if (merged !== undefined && (local === undefined || merged < local)) {
      await context.globalState.update(TRIAL_START_KEY, merged);
    }
  };

  // Elapsed ms since an hrtime mark — the watchdog's phase clock. hrtime.bigint()
  // is a couple of nanoseconds per call, so timing costs the tick nothing measurable.
  const msSince = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;

  // Consumer-freshness gate state (persists across ticks). `lastBuiltSignature` is
  // the change-signature the most recently built panel model carried; a tick whose
  // signature still matches it — and which neither opened the panel nor is due a
  // bridge heartbeat — skips buildPanelModel() entirely (decidePanelBuild, format.ts).
  // `panelWasOpen` detects the open transition so a fresh model is forced on open.
  let lastBuiltSignature = "";
  let panelWasOpen = false;

  // The hook scripts stop forwarding once the lease is 7 days old. Renew at activation
  // (a user back after a week recovers immediately) and then daily from the tick,
  // whenever Claude hooks (in any config home) OR Cursor monitoring is installed.
  const leaseInPlay = (): boolean => cursorMonitoringInstalled() || hooksInstalledInAnyHome(computeHomes());
  let lastLeaseRenew = renewLeaseIfDue(0, Date.now(), leaseInPlay);
  const refresh = (): void => {
    const homes = computeHomes();
    reconcileWatchers(homes);
    // Dirty-set hint for this tick: reclassify the sessions fs.watch/hooks flagged,
    // rescan the registry if it changed, and every RECONCILE_EVERY-th tick run a
    // full reconcile that heals any missed event. Snapshot the accumulators and
    // reset them so events arriving mid-refresh land in the NEXT tick's set.
    tickCount++;
    const hint: ReuseHint = {
      dirty: new Set(dirtySessions),
      registryChanged,
      forceFull: tickCount % RECONCILE_EVERY === 0,
    };
    dirtySessions.clear();
    registryChanged = false;
    // Which snapshot path this tick takes — the same precedence snapshot() applies
    // internally, tagged here from the hint we just built (forceFull → reconcile,
    // registry change → full rescan, any dirty session → dirty, else quiet reuse).
    const path: TickPath = hint.forceFull
      ? "reconcile"
      : hint.registryChanged
        ? "full"
        : hint.dirty.size > 0
          ? "dirty"
          : "quiet";
    // Tick watchdog instrumentation: time the whole refresh + its big sub-phases.
    // The try/finally records EVERY tick — including one that throws — and rethrows
    // after the record lands, so a pathological tick both surfaces and still fails.
    const tickStart = process.hrtime.bigint();
    let reloadMs = 0;
    let panelMs = 0;
    let publishMs = 0;
    let threw = false;
    let errMsg: string | undefined;
    try {
      syncTopologyContext();
      lastLeaseRenew = renewLeaseIfDue(lastLeaseRenew, Date.now(), leaseInPlay);
      navigator?.setHomes(homes);
      titles.poke();
      // reload phase = provider.reload, dominated by the discovery snapshot() (which
      // owns the quiet/dirty/full/reconcile path tagged above); the tree-model rebuild
      // rides along in the same wall-time.
      const reloadStart = process.hrtime.bigint();
      provider.reload(homes, hint);
      reloadMs = msSince(reloadStart);
      // Re-aim the hot-dir watchers (project transcripts + working sessions' subagent
      // dirs) at the live set the snapshot just produced (cheap in-memory read of the
      // reuse cache). A brand-new session's/agent's dir starts being watched from the
      // next tick; the reconcile net covers the gap.
      reconcileHotWatchers(hotWatchTargets());
      // The panel model is the single most expensive derived object per tick (it
      // walks every session's activity tree when that setting is on) and feeds TWO
      // every-string serializations downstream (the panel skip-key + the bridge
      // snapshot key). Build it AT MOST once and share it — but also skip it entirely
      // on a quiet tick no consumer needs. Each consumer declares its freshness need
      // and the pure gate decides: the open panel needs a fresh model only on a real
      // change (its own stableModelKey skips an unchanged re-post) or its own open;
      // the bridge needs one only on a real change or a due 15s heartbeat (its
      // stableKey skips an unchanged re-publish otherwise). "Real change" is the tree
      // change-signature — the same string that fires the sidebar tree's repaint — so
      // the panel and published snapshot inherit exactly the tree's freshness. Alerts
      // are NOT a consumer: they run off provider.alertRows(), never the panel model.
      const bridgePublishing = crossHostEnabled() && bridge.available && hostIdentity !== undefined;
      const panelOpen = overviewPanel.isOpen();
      const sig = provider.changeSignature;
      const decision = decidePanelBuild({
        signatureChanged: sig !== lastBuiltSignature,
        panelOpen,
        panelJustOpened: panelOpen && !panelWasOpen,
        bridgePublishing,
        heartbeatDue: bridgePublishing && bridge.publishDue(),
      });
      panelWasOpen = panelOpen;
      const panelStart = process.hrtime.bigint();
      const tableVisible = tableView.isVisible();
      const panelModel = (decision.build || tableVisible) ? buildPanelModel() : undefined;
      if (panelModel !== undefined) {
        panelMs = msSince(panelStart);
        lastBuiltSignature = sig; // only advance when we actually built this signature
      }
      // Cross-host tick: always fetch (this is also the post-window recovery probe
      // that can flip a degraded bridge back to live) and always drain any focus
      // actions peers posted (unchanged 3s cadence — it never needed the model);
      // publish our own snapshot only when the gate says the bridge needed fresh
      // data. Both are fire-and-forget — the publish phase times only the synchronous
      // kickoff (snapshot assembly + the void calls).
      const publishStart = process.hrtime.bigint();
      let publishRan = false;
      if (crossHostEnabled()) {
        publishRan = true;
        void bridge.fetchNow();
        if (bridge.available) void bridge.cursorSessions();
        // Prefer the local companion's canonical trial origin (prefer-older): a
        // remote instance reinstalled after the trial began must not restart it.
        // Fire-and-forget — the merged value lands in globalState and the tree
        // picks it up on the next tick. Never resets local upward.
        if (bridge.available) void reconcileTrialStart();
        if (bridgePublishing && hostIdentity !== undefined) {
          if (decision.publish && panelModel !== undefined) {
            // buildSnapshot reads `panelModel`, which is built from the tree's already
            // hidden-filtered projects — so a session you hid locally is intentionally
            // absent from what we publish to peers too (hiding follows you across your
            // own fleet; documented in the README "Pin and hide" note). Peers therefore
            // can't see or restore a row you hid here — that's by design.
            //
            // Sub-3s burst edge: the gate decides to publish on every signature change,
            // but bridge.publish() enforces a hard 3s floor (MIN_INTERVAL_MS). If a
            // second real change lands <3s after the first, publish() drops that call —
            // and since we only rebuild on the NEXT signature change or the 15s
            // heartbeat, that second change reaches peers at the following heartbeat
            // rather than immediately. Bounded ≤15s + 1 tick ≪ the 45s live window, the
            // LOCAL panel still reflects it on its own next tick, and only the remote
            // mirror lags. (The 3s floor predates this gate — the gate just makes the
            // deferral land on the heartbeat instead of the next 3s tick's rebuild.)
            void bridge.publish(buildSnapshot(panelModel, hostIdentity));
          }
          // Consume any focus actions other hosts posted for us and perform the
          // same local navigation a click here would (guarded, fire-and-forget).
          void applyRemoteActions(hostIdentity.id);
        }
      }
      if (publishRan) publishMs = msSince(publishStart);
      // Detect transitions into blocked states and toast once per incident. Runs
      // off the rows the provider just derived — never re-reads disk.
      alerts.run(provider.alertRows(), provider.remoteAlertRows());
      view.badge =
        provider.unreadCount > 0
          ? { value: provider.unreadCount, tooltip: `${provider.unreadCount} unread session(s)` }
          : undefined;
      updateChip();
      updateKeyItem();
      controlPanel.refresh();
      maybeKeyExpiredNotice();
      maybeTrialToast();
      maybeRemindLicense();
      syncFilterIndicator();
      if (panelOpen && panelModel !== undefined) overviewPanel.update(panelModel);
      if (tableVisible && panelModel !== undefined) tableView.update(panelModel);
    } catch (err) {
      threw = true;
      errMsg = err instanceof Error ? err.message : String(err);
      throw err; // rethrow AFTER the finally records this tick
    } finally {
      watchdog.record(path, msSince(tickStart), reloadMs, panelMs, publishMs, threw, errMsg);
    }
  };

  // Coalesced refresh: every async trigger (the 3s poll, session-dir fs.watch,
  // hook-event spool, title/RC background updates, config changes) funnels through
  // here instead of calling the full discovery pass directly. A single ~75ms
  // trailing timer collapses a burst (e.g. a watch storm of back-to-back writes)
  // into ONE refresh rather than stacking a full snapshot() per event. Latency
  // cost is at most REFRESH_DEBOUNCE_MS; alerts/badges are fine with +75ms.
  const REFRESH_DEBOUNCE_MS = 75;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (_reason?: string): void => {
    if (refreshTimer !== undefined) return; // a refresh is already ≤75ms out — coalesce
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refresh();
    }, REFRESH_DEBOUNCE_MS);
  };
  refreshFn = scheduleRefresh;

  const timer = setInterval(scheduleRefresh, 3000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    },
  });

  // hook-event spool: instant refresh + permission-prompt detection. The script
  // body gains fields over time (e.g. the RC bridge id) — refresh it in place.
  refreshHookScript();
  const tail = new EventTail();
  const onHookEvents = (): void => {
    let changed = false;
    for (const event of tail.readNew()) {
      const sid = event.payload?.session_id;
      if (sid === undefined) continue;
      // Force this session dirty so the next tick reclassifies its transcript tail —
      // an attention/question/interrupt flip a hook reports must never wait for the
      // periodic reconcile.
      dirtySessions.add(sid);
      if (isPermissionRequest(event)) {
        provider.attentionMap.set(sid, event.ts);
        // Capture WHAT is being asked (sanitized on the way in, so every consumer
        // gets clean text). Empty message → store nothing; the row degrades to the
        // generic "needs approval" phrasing.
        const reason = sanitizeReason(event.payload?.message ?? "");
        if (reason !== "") provider.reasons.set(sid, reason);
        else provider.reasons.delete(sid);
      } else if (event.event === "stop" || event.event === "prompt") {
        provider.attentionMap.delete(sid);
        provider.reasons.delete(sid);
      }
      changed = true;
    }
    if (changed) scheduleRefresh("hook");
  };
  let eventsWatcher: FSWatcher | undefined;
  const watchEvents = (): void => {
    try {
      eventsWatcher = watch(STATE_DIR, (_e, filename) => {
        if (filename === "events.jsonl" || filename === basename(CURSOR_SPOOL) || filename === null) {
          onHookEvents();
          scheduleRefresh("composer-hook");
        }
      });
    } catch {
      // hooks not installed yet; the 3s poll still covers status
    }
  };
  watchEvents();
  context.subscriptions.push({ dispose: () => eventsWatcher?.close() });

  // "What's included" — the full feature list as a rendered markdown document (the
  // #33 virtual-doc pattern), NOT a truncated notification. The Control Panel's
  // License row and What's-included action, the license QuickPick and the trial
  // welcome toast all route here so the copy is never elided.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(LICENSE_SCHEME, {
      provideTextDocumentContent: () => WHATS_INCLUDED_MD,
    })
  );

  const previewEmitter = new vscode.EventEmitter<vscode.Uri>();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
      onDidChange: previewEmitter.event,
      provideTextDocumentContent(uri: vscode.Uri): string {
        const sessionId = uri.path.replace(/^\//, "").replace(/\.md$/, "");
        const node = provider.findSession(sessionId);
        if (node === undefined) return "_Session is no longer running._";
        const { row } = node;
        const header =
          `# ${row.meta.name ?? sessionId}\n\n` +
          `\`${row.meta.cwd}\` · pid ${row.meta.pid} · ${row.meta.entrypoint ?? "?"}\n\n---\n\n`;
        return header + (row.lastText !== "" ? row.lastText : "_No assistant message yet._");
      },
    })
  );

  const propsEmitter = new vscode.EventEmitter<vscode.Uri>();
  context.subscriptions.push(
    propsEmitter,
    vscode.workspace.registerTextDocumentContentProvider(PROPS_SCHEME, {
      onDidChange: propsEmitter.event,
      provideTextDocumentContent(uri: vscode.Uri): string {
        const m = /^\/(session|cursor|composer|codex)\/(.+)\.md$/.exec(uri.path);
        if (m === null) return "_Session is no longer running._";
        const [, kind, id] = m;
        if (kind === "session") {
          const node = provider.findSession(id);
          return node === undefined
            ? "_Session is no longer running._"
            : sessionPropertiesMarkdown(provider.sessionPropsView(node));
        }
        if (kind === "cursor") {
          const node = provider.findCursor(id);
          return node === undefined
            ? "_Session is no longer running._"
            : cursorPropertiesMarkdown(provider.cursorPropsView(node));
        }
        if (kind === "composer") {
          const node = provider.findComposer(id);
          return node === undefined
            ? "_Session is no longer running._"
            : composerPropertiesMarkdown(provider.composerPropsView(node));
        }
        const node = provider.findCodex(id);
        return node === undefined
          ? "_Session is no longer running._"
          : codexPropertiesMarkdown(provider.codexPropsView(node));
      },
    })
  );

  // Setup Doctor: a one-shot read-only diagnostics report rendered into a virtual
  // document (reuses the TextDocumentContentProvider pattern above). The report
  // text is regenerated on each run and held here for the provider to serve.
  let doctorReport = "";
  const doctorEmitter = new vscode.EventEmitter<vscode.Uri>();
  const doctorUri = vscode.Uri.from({ scheme: DOCTOR_SCHEME, path: "/SessionDeck Diagnostics.txt" });
  context.subscriptions.push(
    doctorEmitter,
    vscode.workspace.registerTextDocumentContentProvider(DOCTOR_SCHEME, {
      onDidChange: doctorEmitter.event,
      provideTextDocumentContent: () => doctorReport,
    })
  );
  // Gather every subsystem's real state via its own probe (no duplicated logic),
  // then hand the plain data object to the pure report builder.
  const gatherDoctorProbes = async (): Promise<DoctorProbes> => {
    const homes = computeHomes();
    // Per-home live-session count, reusing the discovery snapshot (no re-scan logic).
    const liveByHome = new Map<string, number>();
    for (const rows of snapshot(homes).values()) {
      for (const r of rows) liveByHome.set(r.homeDir, (liveByHome.get(r.homeDir) ?? 0) + 1);
    }
    const cfg = vscode.workspace.getConfiguration("sessionDeck");
    const cli = resolveEditorCli();
    const proc = procIntrospection();
    const tp = titles.probe();
    const now = Date.now();
    const bridgeHosts = bridge.remoteHosts().map((h) => {
      const lastSeenSec = Math.max(0, Math.round((now - h.receivedAt) / 1000));
      return { label: hostDisplayLabel(h.host), lastSeenSec, stale: now - h.receivedAt > 45_000 };
    });
    return {
      version: pkgVersion,
      homes: homes.map((h) => ({ label: h.label, dir: h.dir, liveCount: liveByHome.get(h.dir) ?? 0 })),
      extraConfigDirs: getExtraDirs(),
      platformSupportsHooks: process.platform !== "win32",
      hooksInstalled: hooksInstalled(homes),
      hooksHomesInstalled: hooksCoverage(homes).installed,
      hooksHomesTotal: homes.length,
      hookScriptStale: hookScriptStale(),
      cursorMonitoringInstalled: cursorMonitoringInstalled(),
      cursorSpoolFreshSec: cursorSpoolFreshSec(),
      cursorProbeErrors: cursorProbeErrorCount(),
      cursorMalformed: cursorTail.malformedCount,
      crossHost: crossHostEnabled(),
      bridgeAvailable: bridge.available,
      bridgeCompanionVersion: bridge.companionVersion,
      bridgeVersionSkew: bridge.versionSkew,
      bridgeHosts,
      cursorEnumAvailable: bridge.cursorEnumAvailable,
      cursorEnumCount: bridge.cursorEnumSessions.length,
      cursorEnumGen: bridge.cursorEnumGen,
      hostId: hostIdentity?.id,
      hostLabel: hostIdentity?.label,
      hostPlatform: hostIdentity?.platform,
      hostError: hostIdentityError,
      titlePath: tp.path,
      titleCount: tp.count,
      nodeSqlite: hasNodeSqlite(),
      python3: await hasPython3(),
      procPlatform: proc.platform,
      procFs: proc.procfs,
      procCensusAgeSec: procCensusAgeSec(),
      editorCli: cli.command,
      editorCliSource: cli.source,
      editorCliOnPath: commandOnPath(cli.command),
      notifications: cfg.get<string>("notifications", "urgent") === "off" ? "off" : "urgent",
      attentionCount: provider.unreadCount,
      // Unfocused OS-alert channels: each setting's on/off, whether this platform can
      // dependably deliver it, and (when so) which command would run.
      unfocusedSoundEnabled: cfg.get<boolean>("unfocusedSound", false),
      unfocusedOsNotificationEnabled: cfg.get<boolean>("unfocusedOsNotification", false),
      unfocusedSoundAvailable: unfocusedAlerts.availability.sound,
      unfocusedOsNotificationAvailable: unfocusedAlerts.availability.osNotification,
      unfocusedSoundTool: platformTools.soundTool,
      unfocusedOsNotificationTool: platformTools.notifyTool,
      // Format-canary: snapshot(homes) above just repopulated the Claude health; the
      // Codex/Cursor/titles health rides the tree's own scans. Engine present ⟺
      // either SQLite backend is available (gates only the titles alarm).
      formatHealth: formatHealth(hasNodeSqlite() || (await hasPython3())),
      // Hook-payload shape canary: the recent-window ring EventTail populates as it
      // consumes the spool (zero new I/O — read straight from the in-memory ring).
      hooksHealth: hooksHealth(),
      // License / free-tier: STATE only, never the key (the debug-report scrubber
      // also redacts any key that reaches free text).
      licenseState: provider.currentLicenseState,
      licenseOverLimit: provider.freeTierOverLimit,
      licenseCovered: provider.licenseCovered,
      licenseTotal: provider.licenseTotal,
      licenseKeyExpiredThrough: expiredMonthlyKey(provider.licenseKey(), Date.now()),
      // Refresh tick watchdog: the ring-buffer summary (per-path percentiles, worst
      // tick phase breakdown, throw count + last error) as of now.
      watchdog: watchdog.summary(),
    };
  };
  const runDoctor = async (): Promise<void> => {
    doctorReport = buildDoctorReport(await gatherDoctorProbes());
    doctorEmitter.fire(doctorUri);
    const doc = await vscode.workspace.openTextDocument(doctorUri);
    await vscode.window.showTextDocument(doc, { preview: false });
  };

  // Capture Drift Fixture: turn a tripped format-canary alarm into a regression
  // artifact. All the slicing + anonymization + the privacy grep are the PURE seams
  // in canary.ts; this wiring only resolves the affected files, reads them, writes
  // the sanitized slices to a scratch dir under globalStorage (never the repo), and
  // opens the folder + a read-only summary. The summary tab is served virtually (like
  // the doctor) so it can never be accidentally saved into the tree.
  let captureSummary = "";
  const captureEmitter = new vscode.EventEmitter<vscode.Uri>();
  const captureUri = vscode.Uri.from({ scheme: CAPTURE_SUMMARY_SCHEME, path: "/Drift Fixture Capture.txt" });
  context.subscriptions.push(
    captureEmitter,
    vscode.workspace.registerTextDocumentContentProvider(CAPTURE_SUMMARY_SCHEME, {
      onDidChange: captureEmitter.event,
      provideTextDocumentContent: () => captureSummary,
    })
  );
  const runCaptureDriftFixture = async (): Promise<void> => {
    const fh = formatHealth(hasNodeSqlite() || (await hasPython3()));
    const order = [
      ["claude", fh.claude],
      ["codex", fh.codex],
      ["cursor", fh.cursor],
    ] as const;
    const drifted = order.find(([, r]) => r.driftSuspected);
    if (drifted === undefined) {
      const msg = fh.titles.driftSuspected
        ? "SessionDeck: editor-title storage drift can't be sliced into a file fixture — nothing to capture."
        : "SessionDeck: no drift detected — nothing to capture.";
      void vscode.window.showInformationMessage(msg);
      return;
    }
    const [harness, report] = drifted;
    const sources = affectedSources(harness).slice(0, 5); // bound the write burst
    if (sources.length === 0) {
      void vscode.window.showWarningMessage(
        `SessionDeck: ${report.label} drift is suspected, but no affected source file is still available to slice.`
      );
      return;
    }
    const ctx: CaptureIdentity = { username: os.userInfo().username, homeDir: os.homedir(), hostname: os.hostname() };
    const dir = join(context.globalStorageUri.fsPath, "drift-fixtures", `${harness}-${Date.now()}`);
    const written: string[] = [];
    const refused: Array<{ source: string; reason: string }> = [];
    let idx = 0;
    for (const src of sources) {
      // Claude/Codex sources are the JSONL transcript/rollout files (read as text);
      // a Cursor source is a binary store.db, so its meta['0'] value is pulled with
      // the same trusted query the scanner uses, not read off disk.
      let raw: string | undefined;
      if (harness === "cursor") {
        const rows = await sqliteSelect(src, "SELECT value FROM meta WHERE key='0'");
        raw = rows?.[0]?.[0];
        if (raw === undefined) {
          refused.push({ source: basename(src), reason: "could not read store.db meta value" });
          continue;
        }
      } else {
        try {
          raw = readFileSync(src, "utf8");
        } catch {
          refused.push({ source: basename(src), reason: "could not read source file" });
          continue;
        }
      }
      const res = captureFixtureSlice(harness, raw, ctx, idx);
      if (!res.ok) {
        refused.push({ source: basename(src), reason: res.reason });
        continue;
      }
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, res.slice.filename), `${res.slice.content}\n`, "utf8");
        written.push(res.slice.filename);
        idx++;
      } catch {
        refused.push({ source: basename(src), reason: "could not write slice" });
      }
    }

    captureSummary = buildCaptureSummary(report.label, dir, written, refused);
    captureEmitter.fire(captureUri);
    // A self-describing copy in the folder too, so it stands alone once opened in OS.
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SUMMARY.txt"), captureSummary, "utf8");
    } catch {
      /* summary-on-disk is best-effort; the read-only tab is authoritative */
    }
    const summaryDoc = await vscode.workspace.openTextDocument(captureUri);
    await vscode.window.showTextDocument(summaryDoc, { preview: false });
    if (existsSync(dir)) void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));

    void vscode.window.showInformationMessage(
      written.length > 0
        ? `SessionDeck: captured ${written.length} sanitized ${report.label} slice(s) — see the summary tab for where to file them.`
        : `SessionDeck: ${report.label} drift produced 0 clean slices (see the summary tab for why).`
    );
  };

  // Copy Debug Report: a single scrubbed markdown blob for pasting into issues. It
  // reuses the doctor probes wholesale (no duplicated diagnostics), adds the canary
  // state, a sessionDeck.* settings snapshot and cheap counts, then hands it all
  // to the pure builder (which scrubs home paths/usernames out). Served read-only
  // via the same virtual-doc pattern as the doctor, AND placed on the clipboard.
  const DEBUG_SETTING_KEYS = [
    "enableNavigation",
    "activityTree",
    "density",
    "layout",
    "showCursorAgents",
    "showCodexAgents",
    "floatAlwaysOnTop",
    "editorCliPath",
    "cursorCliPath",
    "extraConfigDirs",
    "crossHost",
    "notifications",
    "unfocusedSound",
    "unfocusedOsNotification",
    "publishLastText",
  ] as const;
  let debugReport = "";
  const debugEmitter = new vscode.EventEmitter<vscode.Uri>();
  const debugUri = vscode.Uri.from({ scheme: DEBUG_REPORT_SCHEME, path: "/SessionDeck Debug Report.md" });
  context.subscriptions.push(
    debugEmitter,
    vscode.workspace.registerTextDocumentContentProvider(DEBUG_REPORT_SCHEME, {
      onDidChange: debugEmitter.event,
      provideTextDocumentContent: () => debugReport,
    })
  );
  // os.userInfo() can throw on hosts with no passwd entry — fall back to $USER.
  const currentUsername = (): string | undefined => {
    try {
      return os.userInfo().username;
    } catch {
      return process.env.USER ?? process.env.USERNAME;
    }
  };
  const buildDebugReportText = async (): Promise<string> => {
    const probes = await gatherDoctorProbes();
    const cfg = vscode.workspace.getConfiguration("sessionDeck");
    const settings: SettingEntry[] = DEBUG_SETTING_KEYS.map((k) => {
      const v = cfg.get(k);
      const value: SettingEntry["value"] =
        Array.isArray(v)
          ? v.map((x) => String(x))
          : typeof v === "boolean" || typeof v === "number" || typeof v === "string"
            ? v
            : String(v);
      return { key: `sessionDeck.${k}`, value };
    });
    const sessionsByStatus: Record<string, number> = {};
    for (const rows of snapshot(computeHomes()).values()) {
      for (const r of rows) sessionsByStatus[r.status] = (sessionsByStatus[r.status] ?? 0) + 1;
    }
    const pkg = context.extension.packageJSON as { name?: unknown; engines?: { vscode?: unknown } };
    return buildDebugReport({
      probes,
      appName: vscode.env.appName,
      appVersion: vscode.version,
      platform: process.platform,
      remoteName: vscode.env.remoteName,
      packageName: typeof pkg.name === "string" ? pkg.name : "sessiondeck",
      bridgeCompanionVersion: bridge.companionVersion,
      vscodeEngine: typeof pkg.engines?.vscode === "string" ? pkg.engines.vscode : "unknown",
      settings,
      sessionsByStatus,
      hostsInStore: bridge.remoteHosts().length,
      caches: { titles: probes.titleCount },
      scrub: { homeDir: os.homedir(), username: currentUsername(), hostname: os.hostname() },
    });
  };
  const copyDebugReport = async (): Promise<void> => {
    debugReport = await buildDebugReportText();
    debugEmitter.fire(debugUri);
    await vscode.env.clipboard.writeText(debugReport);
    const doc = await vscode.workspace.openTextDocument(debugUri);
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.setStatusBarMessage("SessionDeck: debug report copied to clipboard", 3000);
  };

  let navigator: Navigator | undefined = navigationEnabled()
    ? new Navigator(context.globalStorageUri.fsPath)
    : undefined;
  context.subscriptions.push(
    { dispose: () => navigator?.dispose() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("sessionDeck.extraConfigDirs")) scheduleRefresh("config");
      if (
        e.affectsConfiguration("sessionDeck.showCursorAgents") ||
        e.affectsConfiguration("sessionDeck.showCodexAgents")
      ) {
        provider.forceReload();
        if (overviewPanel.isOpen()) overviewPanel.update(buildPanelModel());
        if (tableView.isVisible()) tableView.update(buildPanelModel());
      }
      if (e.affectsConfiguration("sessionDeck.activityTree")) {
        provider.refreshActivityTree();
        syncActivityTreeContext();
        if (overviewPanel.isOpen()) overviewPanel.update(buildPanelModel());
        if (tableView.isVisible()) tableView.update(buildPanelModel());
      }
      if (e.affectsConfiguration("sessionDeck.density")) {
        provider.refreshDensity();
        syncDensityContext();
        if (overviewPanel.isOpen()) overviewPanel.update(buildPanelModel());
        if (tableView.isVisible()) tableView.update(buildPanelModel());
      }
      if (e.affectsConfiguration("sessionDeck.layout")) {
        provider.refreshLayout();
        syncLayoutContext();
        if (overviewPanel.isOpen()) overviewPanel.update(buildPanelModel());
        if (tableView.isVisible()) tableView.update(buildPanelModel());
      }
      if (e.affectsConfiguration("sessionDeck.inboxLane")) {
        // Toggling the lane changes the root structure only; forceReload fires a
        // repaint (signature reset) so the inbox section appears/disappears.
        provider.forceReload();
        if (overviewPanel.isOpen()) overviewPanel.update(buildPanelModel());
        if (tableView.isVisible()) tableView.update(buildPanelModel());
      }
      if (!e.affectsConfiguration("sessionDeck.enableNavigation")) return;
      navigator?.dispose();
      navigator = navigationEnabled() ? new Navigator(context.globalStorageUri.fsPath) : undefined;
    })
  );

  const pickFilter = async (): Promise<void> => {
    const TYPES_ID = "__agentTypes__";
    const hidden = provider.hiddenAgentTypes;
    const typeSummary =
      hidden.length === 0 ? "all shown" : (filterBadgeLabel("all", hidden) ?? "all shown");
    const timeItems: Array<vscode.QuickPickItem & { id: string }> = (
      Object.entries(FILTER_LABELS) as Array<[FilterMode, string]>
    ).map(([id, label]) => ({ id, label, description: id === provider.filterMode ? "current" : undefined }));
    const sep: vscode.QuickPickItem & { id: string } = {
      id: "__sep__",
      label: "",
      kind: vscode.QuickPickItemKind.Separator,
    };
    const typesRow: vscode.QuickPickItem & { id: string } = {
      id: TYPES_ID,
      label: "$(list-selection) Agent types…",
      description: typeSummary,
    };
    const pick = await vscode.window.showQuickPick([...timeItems, sep, typesRow], { title: "Filter sessions" });
    if (pick === undefined) return;
    if (pick.id === TYPES_ID) {
      const typeItems: Array<vscode.QuickPickItem & { fam: AgentFamily }> = AGENT_FAMILIES.map((f) => ({
        fam: f,
        label: AGENT_FAMILY_LABELS[f],
        description: f === "cursor" ? "CLI + Composer" : undefined,
        picked: provider.isTypeVisible(f),
      }));
      const picks = await vscode.window.showQuickPick(typeItems, {
        title: "Agent types to show",
        canPickMany: true,
        placeHolder: "Checked types are shown; uncheck to hide (all off = show all)",
      });
      if (picks === undefined) return;
      const visible = new Set(picks.map((p) => p.fam));
      const nextHidden = AGENT_FAMILIES.filter((f) => !visible.has(f));
      await provider.setHiddenAgentTypes(nextHidden);
      refresh();
      return;
    }
    await provider.setFilterMode(pick.id as FilterMode);
    refresh();
  };

  // Show Hidden Sessions: a QuickPick of currently-hidden rows (title + age) with
  // unhide-on-select, plus an "Unhide all" item at the top.
  const pickHidden = async (): Promise<void> => {
    const rows = provider.hiddenList();
    if (rows.length === 0) {
      void vscode.window.showInformationMessage("No hidden sessions.");
      return;
    }
    type HiddenItem = vscode.QuickPickItem & { key?: string; all?: boolean };
    const items: HiddenItem[] = [
      { label: "$(eye) Unhide all", all: true, description: `${rows.length} hidden` },
      ...rows.map((r): HiddenItem => ({ label: r.label, description: r.description, key: r.key })),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: "Hidden sessions — select to unhide" });
    if (pick === undefined) return;
    if (pick.all === true) await provider.unhideAll();
    else if (pick.key !== undefined) await provider.unhide([pick.key]);
    refresh();
  };

  const showPreview = async (node: SessionNode): Promise<void> => {
    const uri = vscode.Uri.from({
      scheme: PREVIEW_SCHEME,
      path: `/${node.row.meta.sessionId}.md`,
    });
    previewEmitter.fire(uri);
    await vscode.commands.executeCommand("markdown.showPreview", uri);
  };

  // Keyboard triage: cycle the needs-you set (recomputed each step) and open the
  // target via the exact command a click would use — local Claude → openSession,
  // cursor/codex rows → their open commands, live remote rows → the cross-host
  // focus path. Reveal FIRST: opening triggers a reload that replaces the node
  // instances, so the current one must be revealed before it's swapped out.
  const triageStep = async (dir: 1 | -1): Promise<void> => {
    const target = provider.triageAdvance(dir);
    if (target === undefined) {
      vscode.window.setStatusBarMessage("SessionDeck: nothing needs you", 2000);
      return;
    }
    const node = target.node;
    // One-deep "back": remember where focus was BEFORE this triage jump so
    // returnToFocus returns the user there, not to the triage target. The open
    // command below records the jumped-to session as the anchor; we restore the
    // pre-jump ref after. Not a history stack — a whole walk restores to the same
    // single pre-walk anchor each step (documented limit).
    const priorAnchor = provider.focusRef;
    try {
      await view.reveal(node, { select: true, focus: false, expand: true });
    } catch {
      // reveal can reject if the view isn't resolved yet — non-fatal, still open.
    }
    switch (node.kind) {
      case "session":
        await vscode.commands.executeCommand("sessionDeck.openSession", node);
        break;
      case "cursor":
        await vscode.commands.executeCommand("sessionDeck.openCursor", node);
        break;
      case "codex":
        await vscode.commands.executeCommand("sessionDeck.openCodex", node);
        break;
      case "remote-session":
        await vscode.commands.executeCommand("sessionDeck.focusRemoteSession", node);
        break;
    }
    provider.noteFocus(priorAnchor);
  };

  // Return to Last Focused Session: re-resolve the anchor the open/triage/click
  // paths recorded to its CURRENT node (by id — never a stored node reference,
  // which a re-sort/density flip would have replaced) and reveal + select it. This
  // is the recovery path when a generation-bumping repaint (density / collapse-all
  // / activity-tree toggle) drops the tree's id-tracked selection. Nothing to
  // return to, or the session is gone → a subtle status-bar note, never an error.
  const returnToFocus = async (): Promise<void> => {
    const ref = provider.focusRef;
    if (ref === undefined) {
      vscode.window.setStatusBarMessage("SessionDeck: no recent session to return to", 2000);
      return;
    }
    const node = provider.resolveFocus(ref);
    if (node === undefined) {
      vscode.window.setStatusBarMessage("SessionDeck: that session is no longer here", 2000);
      return;
    }
    try {
      await view.reveal(node, { select: true, focus: true, expand: true });
    } catch {
      // reveal can reject if the view isn't resolved yet — non-fatal.
    }
  };

  // Resolve a per-row command argument to a real tree node. The sidebar tree passes
  // the node itself (or an inbox reference wrapping one); the columns TABLE view's
  // native context menus (data-vscode-context) instead pass a plain object carrying
  // just the row's id — so a right-click in the table drives the SAME command handlers
  // as the tree. Nothing here trusts the object's shape beyond a single id field.
  type RowContextArg =
    | SessionNode
    | CursorNode
    | ComposerNode
    | CodexNode
    | InboxRefNode
    | { sessionId?: string; chatId?: string; codexId?: string; conversationId?: string };
  const resolveRowNode = (
    arg: RowContextArg | undefined
  ): SessionNode | CursorNode | ComposerNode | CodexNode | RemoteSessionNode | undefined => {
    // Guard non-object args up front: `"kind" in arg` would throw on a primitive.
    if (arg === null || typeof arg !== "object") return undefined;
    if ("kind" in arg) {
      // A real node (SessionNode | CursorNode | ComposerNode | CodexNode) or an inbox
      // reference, which unwraps to the real triage node it mirrors.
      return arg.kind === "inbox-ref" ? arg.target : arg;
    }
    // A table context object: resolve the single id it carries to the live node.
    if (typeof arg.sessionId === "string") return provider.findSession(arg.sessionId);
    if (typeof arg.chatId === "string") return provider.findCursor(arg.chatId);
    if (typeof arg.codexId === "string") return provider.findCodex(arg.codexId);
    if (typeof arg.conversationId === "string") return provider.findComposer(arg.conversationId);
    return undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("sessionDeck.refresh", refresh),

    vscode.commands.registerCommand("sessionDeck.doctor", runDoctor),

    vscode.commands.registerCommand("sessionDeck.captureDriftFixture", runCaptureDriftFixture),

    vscode.commands.registerCommand("sessionDeck.copyDebugReport", copyDebugReport),

    vscode.commands.registerCommand("sessionDeck.openFloatingWindow", async () => {
      overviewPanel.update(buildPanelModel());
      await overviewPanel.reveal();
    }),

    // Two ids drive one action so the title bar can show a checked-state icon
    // (list-tree when off, list-flat when on) via the activityTree context.
    ...["sessionDeck.toggleActivityTree", "sessionDeck.toggleActivityTreeActive"].map((id) =>
      vscode.commands.registerCommand(id, async () => {
        // Global setting flip; the onDidChangeConfiguration handler repaints the
        // tree + panel and re-syncs the toolbar checked-state context.
        await vscode.workspace
          .getConfiguration("sessionDeck")
          .update("activityTree", !activityTreeOn(), vscode.ConfigurationTarget.Global);
      })
    ),

    // Toggle Compact View: two ids drive one action so the toolbar can show a
    // checked-state icon (fold when comfortable, unfold when compact) via the
    // sessionDeck.compact context — the same pattern as the activity-tree toggle.
    // The onDidChangeConfiguration handler repaints the tree + panel and re-syncs
    // the context; the flip is a single repaint (provider.refreshDensity).
    ...["sessionDeck.toggleDensity", "sessionDeck.toggleDensityActive"].map((id) =>
      vscode.commands.registerCommand(id, async () => {
        await vscode.workspace
          .getConfiguration("sessionDeck")
          .update(
            "density",
            densityOf() === "compact" ? "comfortable" : "compact",
            vscode.ConfigurationTarget.Global
          );
      })
    ),

    // Toggle Column View: two ids drive one action (the density/activity-tree
    // pattern) so the toolbar shows a checked icon (list ↔ columns) via the
    // sessionDeck.columns context. The config handler repaints tree + panel and
    // re-syncs the context (provider.refreshLayout).
    ...["sessionDeck.toggleLayout", "sessionDeck.toggleLayoutActive"].map((id) =>
      vscode.commands.registerCommand(id, async () => {
        await vscode.workspace
          .getConfiguration("sessionDeck")
          .update(
            "layout",
            layoutOf() === "columns" ? "list" : "columns",
            vscode.ConfigurationTarget.Global
          );
      })
    ),

    vscode.commands.registerCommand("sessionDeck.markAllRead", async () => {
      await provider.markAllRead();
      refresh();
    }),

    vscode.commands.registerCommand("sessionDeck.openSession", async (node: SessionNode) => {
      provider.noteFocus({ kind: "session", id: node.row.meta.sessionId });
      await provider.markRead(node);
      refresh();
      const navigated = navigator !== undefined && (await navigator.navigate(node.row));
      if (!navigated) await showPreview(node);
    }),

    vscode.commands.registerCommand("sessionDeck.showLastMessage", async (arg: RowContextArg) => {
      // Resolve the tree node / inbox reference / table context object to the real
      // session (the inbox is a view; the table passes a context object with the id).
      const node = resolveRowNode(arg);
      if (node === undefined || node.kind !== "session") return;
      provider.noteFocus({ kind: "session", id: node.row.meta.sessionId });
      await provider.markRead(node);
      refresh();
      await showPreview(node);
    }),

    vscode.commands.registerCommand("sessionDeck.sessionProperties", async (arg: RowContextArg) => {
      const node = resolveRowNode(arg);
      if (node === undefined) return;
      let path: string;
      if (node.kind === "session") path = `/session/${node.row.meta.sessionId}.md`;
      else if (node.kind === "cursor") path = `/cursor/${node.row.chatId}.md`;
      else if (node.kind === "composer") path = `/composer/${node.row.conversationId}.md`;
      else if (node.kind === "codex") path = `/codex/${node.row.id}.md`;
      else return; // remote-session and anything else: not supported here
      const uri = vscode.Uri.from({ scheme: PROPS_SCHEME, path });
      propsEmitter.fire(uri);
      await vscode.commands.executeCommand("markdown.showPreview", uri);
    }),

    // Sender (plan follow-up): clicking a LIVE remote session posts a focus action
    // to its host via the bridge, then shows a transient status-bar note. Falls
    // back to the last-message preview when cross-host is off, we have no identity,
    // or the companion can't relay it (absent / too old to have postAction).
    vscode.commands.registerCommand(
      "sessionDeck.focusRemoteSession",
      async (node: RemoteSessionNode) => {
        provider.noteFocus({ kind: "remote-session", hostId: node.hostId, id: node.session.id });
        const posted =
          crossHostEnabled() &&
          hostIdentity !== undefined &&
          (await bridge.postFocus({
            targetHostId: node.hostId,
            sessionId: node.session.id,
            tool: node.session.tool,
            cwd: node.session.cwd,
          }));
        if (posted) {
          const s = node.session;
          const title = s.title !== undefined && s.title.length > 0 ? s.title : s.id.slice(0, 8);
          vscode.window.setStatusBarMessage(
            `$(radio-tower) Focusing ${title} on ${remoteHostLabel(node.hostId)}…`,
            3000
          );
        } else {
          await vscode.commands.executeCommand("sessionDeck.showRemoteLastMessage", node);
        }
      }
    ),

    // Cursor Agent CLI session click: focus its terminal when the live pid is
    // known and lives in this window; otherwise just surface its last activity.
    vscode.commands.registerCommand("sessionDeck.openCursor", async (node: CursorNode) => {
      const { row } = node;
      provider.noteFocus({ kind: "cursor", id: row.chatId });
      await provider.markCursorRead(node);
      refresh();
      // Same-window first: focusLocalTerminal matches the integrated terminal by
      // pid ancestry (cwd-independent), so it works even when the agent was
      // launched from a subdirectory of the workspace. Only if no local terminal
      // owns the pid do we relay cross-window (which also raises the owning window),
      // then fall back to a last-activity note.
      if (row.pid !== undefined && (await focusLocalTerminal(row.pid))) return;
      if (navigator !== undefined && (await navigator.navigateCursor({ cwd: row.cwd, kind: "cli", pid: row.pid }))) return;
      const pidNote = row.pid !== undefined ? ` (pid ${row.pid})` : "";
      void vscode.window.showInformationMessage(
        `${row.name} — Cursor Agent, last activity ${fmtAge(row.ageSec)} ago${pidNote}.`
      );
    }),

    vscode.commands.registerCommand("sessionDeck.openComposer", async (node: ComposerNode) => {
      if (node === undefined) return;
      await provider.markComposerRead(node);
      const { row } = node;
      // Best-effort open: same-window reveals the composer pane (its tab when the
      // conversation is open); another window gets a relayed request + is raised.
      // Falls back to a status/token preview when we can't open it.
      if (navigator !== undefined && (await navigator.navigateCursor({ cwd: row.cwd, kind: "composer", composerId: row.conversationId }))) return;
      const tokenNote = row.tokens === undefined ? "" : ` Tokens: ${row.tokens.input} in, ${row.tokens.output} out, ${row.tokens.cacheRead + row.tokens.cacheWrite} cache.`;
      void vscode.window.showInformationMessage(`${row.name} — ${row.status}, ${row.mode || "unknown mode"}${row.caption ? `, ${row.caption}` : ""}.${tokenNote}`);
    }),

    // Codex CLI session click: focus its terminal when the live pid is known and
    // lives in this window; otherwise just surface its last activity.
    vscode.commands.registerCommand("sessionDeck.openCodex", async (node: CodexNode) => {
      const { row } = node;
      provider.noteFocus({ kind: "codex", id: row.id });
      await provider.markCodexRead(node);
      refresh();
      if (row.pid !== undefined && (await focusLocalTerminal(row.pid))) return;
      const pidNote = row.pid !== undefined ? ` (pid ${row.pid})` : "";
      void vscode.window.showInformationMessage(
        `${row.name} — ${row.kind}, last activity ${fmtAge(row.ageSec)} ago${pidNote}.`
      );
    }),

    vscode.commands.registerCommand(
      "sessionDeck.openProject",
      async (node: ProjectNode | { cwd?: string }) => {
        // The table view passes a { cwd } context object; the tree passes a ProjectNode
        // (also carrying cwd). Guard a missing/non-string cwd so a stray invocation
        // can't crash on Uri.file(undefined).
        if (typeof node?.cwd !== "string") return;
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(node.cwd), {
          forceNewWindow: true,
        });
      }
    ),

    vscode.commands.registerCommand("sessionDeck.setSort", async () => {
      const items: Array<vscode.QuickPickItem & { id: SortMode }> = [
        { id: "activity", label: "Last activity", description: "most recently active first" },
        { id: "heat", label: "Heat", description: "projects with the most attention pressure first" },
        { id: "name", label: "Name", description: "projects and sessions alphabetically" },
      ];
      for (const i of items) if (i.id === provider.sortMode) i.description += " — current";
      const pick = await vscode.window.showQuickPick(items, { title: "Sort projects by" });
      if (pick !== undefined) {
        await provider.setSortMode(pick.id);
        refresh();
      }
    }),

    vscode.commands.registerCommand("sessionDeck.setFilter", pickFilter),
    vscode.commands.registerCommand("sessionDeck.setFilterFilled", pickFilter),

    // Pin / unpin a project (context menu, contextValue-gated) and hide a LOCAL
    // session row. Show Hidden opens the unhide picker.
    vscode.commands.registerCommand("sessionDeck.pinProject", async (node: ProjectNode) => {
      if (node?.cwd === undefined) return;
      await provider.pinProject(node.cwd);
      refresh();
    }),
    vscode.commands.registerCommand("sessionDeck.unpinProject", async (node: ProjectNode) => {
      if (node?.cwd === undefined) return;
      await provider.unpinProject(node.cwd);
      refresh();
    }),
    vscode.commands.registerCommand(
      "sessionDeck.hideSession",
      async (arg: RowContextArg) => {
        // Tree node, inbox reference (hides the REAL row), or table context object.
        const node = resolveRowNode(arg);
        if (node === undefined || node.kind === "remote-session") return; // remote rows are not hideable
        await provider.hideSession(node);
        refresh();
      }
    ),
    vscode.commands.registerCommand("sessionDeck.dismissOrphans", async () => {
      await provider.hideOrphans();
      refresh();
    }),
    vscode.commands.registerCommand("sessionDeck.showHidden", pickHidden),

    // Status-bar chip click: reveal SessionDeck and filter to attention so
    // the sessions needing you are all that's left in the tree.
    vscode.commands.registerCommand("sessionDeck.triage", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.sessionDeck");
      await provider.setFilterMode("attention");
      refresh();
    }),

    // Keyboard triage: step to the next / previous session needing you (default
    // ctrl+alt+] / ctrl+alt+[), open it, and reveal the row — no mouse required.
    vscode.commands.registerCommand("sessionDeck.nextAttention", () => triageStep(1)),
    vscode.commands.registerCommand("sessionDeck.prevAttention", () => triageStep(-1)),

    // Return to the last session you focused (survives re-sorts / density flips
    // that rotate tree-item ids and drop VS Code's own selection).
    vscode.commands.registerCommand("sessionDeck.returnToFocus", returnToFocus),

    vscode.commands.registerCommand("sessionDeck.collapseAll", () => {
      // The columns TABLE view owns its own webview collapse state; the list view is
      // the sidebar tree. They are mutually exclusive (sessionDeck.columns gates
      // which one shows), so route to whichever is live.
      if (collapseTarget(layoutOf()) === "table") tableView.setAllCollapsed(true);
      else provider.setAllCollapsed(true);
      void vscode.commands.executeCommand("setContext", "sessionDeck.collapsed", true);
    }),

    vscode.commands.registerCommand("sessionDeck.expandAll", () => {
      if (collapseTarget(layoutOf()) === "table") tableView.setAllCollapsed(false);
      else provider.setAllCollapsed(false);
      void vscode.commands.executeCommand("setContext", "sessionDeck.collapsed", false);
    }),

    vscode.commands.registerCommand("sessionDeck.clearFilter", async () => {
      await provider.setFilterMode("all");
      refresh();
    }),

    vscode.commands.registerCommand("sessionDeck.installHooks", () => {
      try {
        installHooks(computeHomes());
        eventsWatcher?.close();
        watchEvents();
        syncHooksContext();
        scheduleRefresh("hooks-installed");
        void vscode.window.showInformationMessage(
          "SessionDeck hooks installed. Sessions started from now on will push updates."
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `SessionDeck: could not update a config home's settings.json — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand("sessionDeck.removeHooks", () => {
      try {
        removeHooks(computeHomes());
        syncHooksContext();
        scheduleRefresh("hooks-removed");
        void vscode.window.showInformationMessage("SessionDeck hooks removed from every Claude config home.");
      } catch (err) {
        void vscode.window.showErrorMessage(
          `SessionDeck: could not update a config home's settings.json — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand("sessionDeck.enableCursorMonitoring", () => {
      try {
        enableCursorMonitoring();
        syncTopologyContext();
        scheduleRefresh("cursor-monitoring-enabled");
        void vscode.window.showInformationMessage("Cursor monitoring enabled — your next Composer turn will appear in SessionDeck.");
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand("sessionDeck.disableCursorMonitoring", () => {
      try {
        disableCursorMonitoring();
        syncTopologyContext();
        scheduleRefresh("cursor-monitoring-disabled");
        void vscode.window.showInformationMessage("Cursor monitoring disabled and its hook entries removed.");
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand("sessionDeck.removeAllIntegrations", () => {
      const results: string[] = [];
      let failed = false;
      try { removeHooks(computeHomes()); results.push("Claude hooks: removed"); }
      catch (err) { failed = true; results.push(`Claude hooks: ${err instanceof Error ? err.message : String(err)}`); }
      try { disableCursorMonitoring(); results.push("Cursor monitoring: removed"); }
      catch (err) { failed = true; results.push(`Cursor monitoring: ${err instanceof Error ? err.message : String(err)}`); }
      syncHooksContext();
      syncTopologyContext();
      scheduleRefresh("integrations-removed");
      const message = `SessionDeck integrations — ${results.join("; ")}`;
      if (failed) void vscode.window.showWarningMessage(message);
      else void vscode.window.showInformationMessage(message);
    }),

    // Enter a license key: InputBox with LIVE validation (shape + modulo + expiry
    // feedback). On success the key is saved to settings and the tree re-renders.
    vscode.commands.registerCommand("sessionDeck.enterLicenseKey", async () => {
      const cfg = vscode.workspace.getConfiguration("sessionDeck");
      const value = await vscode.window.showInputBox({
        title: "Enter License Key",
        prompt: ENTER_KEY_PROMPT,
        value: cfg.get<string>("licenseKey", ""),
        ignoreFocusOut: true,
        validateInput: (raw) => licenseKeyProblem(raw, Date.now()),
      });
      if (value === undefined) return; // cancelled
      await cfg.update("licenseKey", value.trim(), vscode.ConfigurationTarget.Global);
      provider.forceReload();
      if (overviewPanel.isOpen()) overviewPanel.update(buildPanelModel());
      refresh();
      const licensed = isLicensed(provider.currentLicenseState);
      void vscode.window.showInformationMessage(
        value.trim() === ""
          ? "License key cleared."
          : licensed
            ? "Licensed — thank you."
            : "Key saved, but it isn't licensing right now (expired or invalid). Free tier stays in effect."
      );
    }),

    // Open the purchase page. BUY_URL is a single clearly-marked constant in
    // src/license.ts (the sessiondeck.dev checkout anchor).
    vscode.commands.registerCommand("sessionDeck.buyLicense", () => {
      void vscode.env.openExternal(vscode.Uri.parse(BUY_URL));
    }),

    // Free-tier status-bar item click → QuickPick.
    vscode.commands.registerCommand("sessionDeck.licenseMenu", async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: "$(key) Enter License Key", id: "enter" as const },
          { label: "$(link-external) Buy License", id: "buy" as const },
          { label: "$(info) What's included", id: "info" as const },
        ],
        { title: "SessionDeck — License" }
      );
      if (pick === undefined) return;
      if (pick.id === "enter") await vscode.commands.executeCommand("sessionDeck.enterLicenseKey");
      else if (pick.id === "buy") await vscode.commands.executeCommand("sessionDeck.buyLicense");
      // "What's included" is the full feature list rendered as a markdown document —
      // never the old truncated toast (which cut the list off mid-sentence).
      else await vscode.commands.executeCommand("sessionDeck.whatsIncluded");
    }),

    // Open the full, never-truncated "What's included" feature list as a rendered
    // markdown document (replaces the truncated showInformationMessage path).
    vscode.commands.registerCommand("sessionDeck.whatsIncluded", async () => {
      const uri = vscode.Uri.from({ scheme: LICENSE_SCHEME, path: "/What's included.md" });
      await vscode.commands.executeCommand("markdown.showPreview", uri);
    }),

    registerLicenseDebugCommand({
      context,
      suspendTrialMerge: () => {
        trialMergeSuspended = true;
      },
      provider,
      refresh,
      refreshPanel: () => {
        if (overviewPanel.isOpen()) overviewPanel.update(buildPanelModel());
      },
    })
  );

  refresh();
}

export function deactivate(): void {}
