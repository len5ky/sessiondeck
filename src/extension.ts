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
import { codexHomeOf, focusLocalTerminal, identitySources, moveClaimIdentity, moveSession, MoveSubject, shortTitle, stopSession, sweepMoveClaims, verifiedClaudeStart } from "./injector";
import { Navigator, navigationEnabled, resolveEditorCli, commandOnPath } from "./navigation";
import { procIntrospection, procCensusAgeSec, pidCmdline, pidHasOpen, pidAlive, pidStartTime, procStartAgreement, procTable, type LocationVerdict } from "./procs";
import { hasNodeSqlite, hasPython3, sqliteSelect } from "./sqliteRead";
import {
  ACTIVATION_STEP,
  buildDoctorReport,
  DOCTOR_SCHEME,
  CAPTURE_SUMMARY_SCHEME,
  DoctorProbes,
  buildDebugReport,
  DEBUG_REPORT_SCHEME,
  SettingEntry,
  StartupFailure,
  StartupHealth,
  TickWatchdog,
  TickPath,
} from "./doctor";
import { TitleSource } from "./titles";
import { TokenScanner } from "./discovery";
import { cursorSessions, CursorEventTail, ComposerTracker } from "./cursor";
import { codexSessions } from "./codex";
import { fmtAge, snapshot, hotWatchTargets, watchEventDirty, ReuseHint, WatchTarget, registryStatus, registryStartEntries } from "./discovery";
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
  RootFetchSignal,
  codexPreviewMarkdown,
  previewDocPath,
} from "./format";
import { saveQuietly, onFailedSave, unsavedSettingKeys, decideTrialStart, trialOrigin, FIRST_SEEN_KEY, MIGRATION_FAILURES_KEY, ROW_CLICK_CMD, RowClickIndex, clickSafeProvider, revealWhenVisible, rowClickTarget, FILTER_LABELS, FilterMode, SessionsProvider, SessionNode, CursorNode, ComposerNode, CodexNode, ProjectNode, RemoteSessionNode, InboxRefNode, resolveRowArg, SortMode, TRIAL_START_KEY } from "./tree";
import { AccountDecorationProvider, PreviewDocs } from "./decorations";
import { OverviewPanel } from "./panel";
import { TableViewProvider } from "./tableView";
import { BridgeClient, buildSnapshot, FOCUS_NOTE_MS, LatestClick, PublisherLease, publishGate, type FocusNotice, focusNotice, navReport, remoteFocusPrecheck, actOnRemoteStop, followStop, STOP_ANSWER_WAIT_MS, stopNotice, waitForFocusResult } from "./bridge";
import {
  copyMissingMementoValues,
  hostDisplayLabel,
  installedLegacyExtensions,
  legacyExtensionMessage,
  migrateLegacySettings,
  parseLegacyMemento,
  legacyStateUpdates,
  legacyImportOutcome,
  claimOnceFile,
  type FocusAction,
  type FocusResult,
  LEGACY_IMPORT_MAX_ATTEMPTS,
} from "./bridgeSchema";
import { HostIdentity, loadHostIdentity } from "./hostid";
import { SessionAlerts } from "./alerts";
import { FocusDigest, digestMessage } from "./digest";
import { UnfocusedAlerts, UnfocusedAlertConfig, resolvePlatformTools } from "./osalert";
import { formatHealth, driftHarness, hooksHealth, affectedSources, captureFixtureSlice, buildCaptureSummary, CaptureIdentity } from "./canary";
import {
  buyUrl,
  TRIAL_MS,
  decideKeyExpiredNotice,
  decideOverLimitReminder,
  OVER_LIMIT_REMINDER_MESSAGE,
  decideTrialToast,
  expiredMonthlyKey,
  isLicensed,
  isReturningInstall,
  keyExpiredMessage,
  KeyExpiredNoticeRunner,
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
import { buildControlPanelRows, keepControlRows, ControlRow, ControlPanelInput, ControlMark, WHATS_INCLUDED_MD } from "./controlPanel";

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
  const stateDb = join(globalStorageRoot, "state.vscdb");
  const rows = await sqliteSelect(stateDb, `SELECT value FROM ItemTable WHERE key='${LEGACY_EXTENSION_ID}'`);
  // null is "could not read", not "nothing there" (the legacy import makes the
  // same distinction): a database that exists but didn't read may still hold the
  // former extension's trial start, so this counts as a failed migration.
  // After LEGACY_IMPORT_MAX_ATTEMPTS failed starts the trial origin is settled
  // without it (decideTrialStart), and an unreadable database stops failing.
  const gaveUp = (context.globalState.get<number>(MIGRATION_FAILURES_KEY) ?? 0) >= LEGACY_IMPORT_MAX_ATTEMPTS;
  if (rows === null && existsSync(stateDb) && !gaveUp) throw new Error("the editor's state database could not be read");
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
  private readonly emitter = new vscode.EventEmitter<ControlRow[] | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private rows: ControlRow[] = [];
  constructor(private readonly supply: () => ControlPanelInput) {
    this.rows = buildControlPanelRows(supply());
  }
  /** Runs every tick. Fires nothing when no row changed, only the changed rows
   *  when the set and order hold, and a full redraw otherwise (or when a toast
   *  waits for the redraw), so a click on a row isn't lost to a redraw it didn't need. */
  refresh(): void {
    const update = keepControlRows(this.rows, buildControlPanelRows(this.supply()));
    this.rows = update.rows;
    if (update.structural || this.rootFetch.waiting) this.emitter.fire(undefined);
    else if (update.changed.length > 0) this.emitter.fire(update.changed);
  }
  dispose(): void {
    this.emitter.dispose();
  }
  readonly rootFetch = new RootFetchSignal();
  getChildren(element?: ControlRow): ControlRow[] {
    if (element === undefined) this.rootFetch.fetched();
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

let logChannel: vscode.LogOutputChannel | undefined;
/** One line in SessionDeck's output channel (View > Output > SessionDeck),
 *  created on first use. console.log from an extension host lands in no place a
 *  user or tester can find (not the extension-host log, not the window console on
 *  a remote host). Never put conversation content here: kinds, pids, outcomes. */
function logLine(line: string): void {
  logChannel ??= vscode.window.createOutputChannel("SessionDeck", { log: true });
  logChannel.info(line);
}

/** Test seam: startup step names that throw on purpose (test/activationHarness.ts). */
export const injectedStartupFaults = new Set<string>();

/** Commands that can't work while a startup step has failed. They answer with a
 *  short message naming what failed instead of failing in some stranger way. */
/** What Move into Editor depends on: where a session runs, and reaching a window. */
const MOVE_NEEDS = ["process table", "navigation"] as const;

const COMMAND_NEEDS: Readonly<Record<string, readonly string[]>> = {
  "sessionDeck.focusRemoteSession": ["bridge client"],
  // The inline action and every context menu entry run this one command.
  "sessionDeck.moveSession": MOVE_NEEDS,
  "sessionDeck.showLastMessage": ["preview documents"],
  "sessionDeck.sessionProperties": ["preview documents"],
  "sessionDeck.whatsIncluded": ["license documents"],
  "sessionDeck.doctor": ["diagnostics documents"],
  "sessionDeck.copyDebugReport": ["diagnostics documents"],
  "sessionDeck.captureDriftFixture": ["diagnostics documents"],
};

type CommandHandler = Parameters<typeof vscode.commands.registerCommand>[1];

/** Every sessionDeck.* id the manifest contributes or names: commands, menu
 *  items, keybindings and command: links in the welcome views. */
function manifestCommandIds(packageJSON: unknown): string[] {
  const c = (packageJSON as { contributes?: Record<string, unknown> } | undefined)?.contributes ?? {};
  const ids = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string" && v.startsWith("sessionDeck.")) ids.add(v);
  };
  const items = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  for (const x of items(c.commands)) add(x.command);
  for (const x of items(c.keybindings)) add(x.command);
  for (const list of Object.values((c.menus ?? {}) as Record<string, unknown>)) for (const x of items(list)) add(x.command);
  for (const w of items(c.viewsWelcome)) {
    if (typeof w.contents === "string") for (const m of w.contents.matchAll(/command:(sessionDeck\.[A-Za-z0-9_]+)/g)) add(m[1]);
  }
  return [...ids];
}

/** A command that can't run because a startup step failed: say so, with a way
 *  to the detail (the output channel). */
function tellUnavailable(failure: StartupFailure | undefined): void {
  const what = failure === undefined ? "part of SessionDeck" : failure.feature;
  void vscode.window
    .showWarningMessage(`SessionDeck: this command is unavailable because ${what} failed to start.`, "Show Details")
    .then((choice) => {
      if (choice === "Show Details") logChannel?.show(true);
    });
}

/** After a failed startup: register every command the manifest names that nothing
 *  registered, so a click says what failed instead of "command not found". */
async function registerMissingCommands(
  context: vscode.ExtensionContext,
  registered: Set<string>,
  health: StartupHealth
): Promise<void> {
  let existing = new Set<string>();
  try {
    existing = new Set(await vscode.commands.getCommands(true));
  } catch {
    // unknown: try every id; a duplicate registration throws and is skipped below
  }
  const failure = health.blockedBy([ACTIVATION_STEP]) ?? health.failures[0];
  for (const id of manifestCommandIds(context.extension.packageJSON)) {
    if (registered.has(id) || existing.has(id)) continue;
    try {
      context.subscriptions.push(vscode.commands.registerCommand(id, () => tellUnavailable(failure)));
      registered.add(id);
    } catch {
      // registered by someone else in the meantime
    }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const health = new StartupHealth(logLine, injectedStartupFaults);
  const registered = new Set<string>();
  // Each registration is added to the subscriptions the moment it succeeds: the
  // call sites register many commands inside one push(...), and a throw midway
  // would otherwise leave the earlier ones registered but never disposed. The
  // returned disposable is a no-op so those push(...) calls don't dispose twice.
  const registerCommand = (id: string, handler: CommandHandler): vscode.Disposable => {
    const needs = COMMAND_NEEDS[id];
    const disposable = vscode.commands.registerCommand(
      id,
      needs === undefined
        ? handler
        : (...args: unknown[]) => {
            const failed = health.blockedBy(needs);
            if (failed !== undefined) return tellUnavailable(failed);
            return handler(...args);
          }
    );
    context.subscriptions.push(disposable);
    registered.add(id);
    return { dispose: () => undefined };
  };
  // The notice goes up once per window: at the end of activation, or later when
  // the first failure is a save that matters across restarts and lands after it.
  let started = false;
  let noticeShown = false;
  const showNotice = (): void => {
    const notice = health.notice();
    if (!started || noticeShown || notice === undefined) return;
    noticeShown = true;
    void vscode.window.showWarningMessage(notice, "Show Details").then((choice) => {
      if (choice === "Show Details") logChannel?.show(true);
    });
  };
  onFailedSave((key, err) => {
    try {
      logLine(`storage: could not save ${key}: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      // no output channel; Diagnostics still lists the key
    }
    if (!KEPT_ACROSS_RESTARTS.has(key)) return;
    health.record(STORAGE_STEP, "saved trial and notice state", err);
    showNotice();
  });
  try {
    await startSessionDeck(context, health, registerCommand);
  } catch (err) {
    health.record(ACTIVATION_STEP, "most of SessionDeck", err);
  }
  // Let the saves activation started report a failure before the notice is built.
  await new Promise((resolve) => setTimeout(resolve, 0));
  started = true;
  if (health.failures.some((f) => f.step !== STORAGE_STEP)) await registerMissingCommands(context, registered, health);
  showNotice();
}

const STORAGE_STEP = "storage";
/** State whose loss shows across restarts: the trial origin and the notice
 *  latches (a lost latch shows its notice again; a lost start restarts a trial). */
const KEPT_ACROSS_RESTARTS = new Set([
  TRIAL_START_KEY,
  FIRST_SEEN_KEY,
  MIGRATION_FAILURES_KEY,
  "trialSeenAt",
  "trialEndedPending",
  "trialEndedShown",
  "trialWelcomeShown",
  "trialWelcomeDisplayed",
  "licenseKeyExpiredNotified",
  "licenseReminderDay",
]);

async function startSessionDeck(
  context: vscode.ExtensionContext,
  health: StartupHealth,
  registerCommand: (id: string, handler: CommandHandler) => vscode.Disposable
): Promise<void> {
  const activatedAt = Date.now();
  // Read before anything this activation creates it: the folder holds the host id
  // and hook spool, so its presence means SessionDeck (or its former name) ran here.
  const stateDirExisted = existsSync(STATE_DIR);
  const legacy = await health.runAsync(
    "state migration",
    "settings and trial state from the former extension name (retried at the next start)",
    () => migrateRenameState(context),
    { legacyMemento: false, legacySettings: false }
  );
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
    await health.runAsync(
      "license state",
      "the saved trial state",
      () => Promise.resolve(context.globalState.update("trialWelcomeShown", true)),
      undefined
    );
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
  health.run("hooks status", "the hooks status", syncHooksContext, undefined);

  const titles = new TitleSource(context.globalStorageUri, () => refreshFn());
  // Off-tick model/mode/token scanner: pre-window session scans + lazy subagent
  // scans, one file at a time, each completion firing a refresh so a resolved total
  // replaces its "…" placeholder. Assigned to the provider below.
  const tokenScanner = new TokenScanner(() => refreshFn());
  const decorations = new AccountDecorationProvider();
  health.run(
    "file decorations",
    "account colours on rows",
    () => context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations)),
    0
  );
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
  const hostIdentity: HostIdentity | undefined = health.run(
    "host identity",
    "cross-host sessions",
    () => loadHostIdentity(),
    undefined
  );
  const hostIdentityError: string | undefined = health.blockedBy(["host identity"])?.error;

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
  // The provider owns the remote last-message command + content-provider
  // disposables (registered in its constructor) — dispose them with the extension.
  // Pushed at once, so a failure further down can't leave them behind.
  context.subscriptions.push({ dispose: () => provider.dispose() });
  // A failed migration leaves the former extension's trial start unread: stamping
  // one now would block it for good (the retry only fills missing keys). So the
  // trial origin waits, for at most LEGACY_IMPORT_MAX_ATTEMPTS starts, with the
  // clock running from the first of them; see decideTrialStart.
  const trialDecision = decideTrialStart({
    saved: context.globalState.get<number>(TRIAL_START_KEY),
    firstSeen: context.globalState.get<number>(FIRST_SEEN_KEY),
    failures: context.globalState.get<number>(MIGRATION_FAILURES_KEY) ?? 0,
    migrationFailed: health.blockedBy(["state migration"]) !== undefined,
    endedLatch:
      context.globalState.get<boolean>("trialEndedPending") === true ||
      context.globalState.get<boolean>("trialEndedShown") === true,
    seenAt: context.globalState.get<number>("trialSeenAt"),
    now: Date.now(),
    maxAttempts: LEGACY_IMPORT_MAX_ATTEMPTS,
    trialMs: TRIAL_MS,
  });
  if (trialDecision.firstSeen !== undefined) saveQuietly(context.globalState, FIRST_SEEN_KEY, trialDecision.firstSeen);
  if (trialDecision.failures !== undefined) saveQuietly(context.globalState, MIGRATION_FAILURES_KEY, trialDecision.failures);
  if (trialDecision.stamp !== undefined) saveQuietly(context.globalState, TRIAL_START_KEY, trialDecision.stamp);
  const trialWaiting = !trialDecision.settled;
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

  // Rows get an argument-free click command (see RowClickIndex in tree.ts): VS Code drops a
  // row's command arguments on every full refresh, and a click in that gap failed
  // with "Actual command not found".
  const rowClicks = new RowClickIndex<Parameters<SessionsProvider["getTreeItem"]>[0]>();
  const view = vscode.window.createTreeView("sessionDeck.sessions", {
    treeDataProvider: clickSafeProvider(provider, rowClicks),
  });
  context.subscriptions.push(view);
  // Which groups are open decides whether a group's own line can repaint without
  // making its rows briefly unclickable (SessionsProvider.fireTreeChanges).
  context.subscriptions.push(
    view.onDidExpandElement((e) => provider.noteOpen(e.element, true)),
    view.onDidCollapseElement((e) => provider.noteOpen(e.element, false)),
    // Column View hides this view: only whole-tree refreshes while hidden.
    view.onDidChangeVisibility((e) => provider.setViewVisible(e.visible))
  );
  provider.setViewVisible(view.visible);
  // A group that comes to need you opens without changing its id (an id change
  // redraws the whole level): reveal with expand, without moving selection or focus.
  // Only while the view is visible: reveal shows a hidden view (see revealWhenVisible).
  const needsYouReveal = revealWhenVisible(view, (n) => provider.isCurrent(n));
  context.subscriptions.push({ dispose: needsYouReveal.dispose });
  provider.expandRow = needsYouReveal.expand;
  context.subscriptions.push(
    registerCommand(ROW_CLICK_CMD, async () => {
      const target = rowClickTarget(view.selection, rowClicks);
      if ("message" in target) {
        void vscode.window.showInformationMessage(target.message);
        return;
      }
      await vscode.commands.executeCommand(target.command.command, ...(target.command.arguments ?? []));
    })
  );
  const syncFilterIndicator = (): void => {
    view.description = filterBadgeLabel(provider.filterMode, provider.hiddenAgentTypes);
    void vscode.commands.executeCommand(
      "setContext",
      "sessionDeck.filterActive",
      filterIsActive(provider.filterMode, provider.hiddenAgentTypes)
    );
  };
  syncFilterIndicator();

  const pkgVersion = ((): string => {
    const v = (context.extension.packageJSON as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  })();
  const bridgeOptions = {
    selfHostId: hostIdentity?.id,
    ourVersion: pkgVersion,
    // crossHost off = zero work: skip the 60s hello probe entirely (a later flip
    // back to true just needs a reload — no config watcher).
    enabled: () => crossHostEnabled(),
  };
  // A client that failed to start is replaced by a disabled one (no probe, no
  // remote hosts), so everything that reads the bridge still works single-host.
  const bridge = health.run(
    "bridge client",
    "the cross-host bridge",
    () => new BridgeClient(bridgeOptions),
    undefined
  ) ?? new BridgeClient({ ...bridgeOptions, enabled: () => false });
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
  health.run(
    "table webview",
    "the Table view",
    () =>
      context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("sessionDeck.table", tableView, {
          webviewOptions: { retainContextWhenHidden: true },
        })
      ),
    0
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
  const controlPanel = health.run(
    "control panel",
    "the Control Panel view",
    () => {
      const cp = new ControlPanelProvider(controlPanelInput);
      context.subscriptions.push({ dispose: () => cp.dispose() });
      context.subscriptions.push(vscode.window.createTreeView("sessionDeck.controlPanel", { treeDataProvider: cp }));
      return cp;
    },
    undefined
  );

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
  const platformTools = health.run(
    "os alerts",
    "sound and OS notifications while unfocused",
    () => resolvePlatformTools(process.platform, commandOnPath, soundFile),
    {}
  );
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
  // `otherNoticeShown`: Trial ended or the key-lapse notice went up this tick; the
  // reminder then waits until tomorrow instead of stacking a second toast.
  const REMINDER_KEY = "licenseReminderDay";
  const maybeRemindLicense = (otherNoticeShown: boolean): void => {
    const d = decideOverLimitReminder({
      overLimit: provider.freeTierOverLimit,
      today: new Date().toISOString().slice(0, 10), // local-ish calendar day
      remindedOn: context.globalState.get<string>(REMINDER_KEY),
      otherNoticeShown,
    });
    if (d.stamp !== undefined) saveQuietly(context.globalState, REMINDER_KEY, d.stamp);
    if (!d.show) return;
    void vscode.window
      .showInformationMessage(
        OVER_LIMIT_REMINDER_MESSAGE,
        "Enter Key",
        "Buy",
        "Later"
      )
      .then((choice) => {
        if (choice === "Enter Key") void vscode.commands.executeCommand("sessionDeck.enterLicenseKey");
        else if (choice === "Buy") void vscode.commands.executeCommand("sessionDeck.buyLicense", "cap");
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
  // The companion's answer settles it even after a failed migration: it already
  // holds the oldest trial start across the former extension's state too.
  const trialOriginSettled = (): boolean =>
    bridge.licenseCached !== undefined ||
    (!trialWaiting &&
      (!crossHostEnabled() || (bridge.probeSettled && !bridge.available) || Date.now() - activatedAt > 60_000));
  const maybeTrialToast = (): boolean => {
    const trialStart = context.globalState.get<number>(TRIAL_START_KEY);
    const now = Date.now();
    // Recompute from globalState rather than the provider's last reload, so a
    // trial origin the companion just moved earlier is already reflected.
    const state = licenseState(provider.licenseKey(), now, trialOrigin(context.globalState, now));
    const settled = trialOriginSettled();
    if (settled && state.startsWith("trial:") && context.globalState.get<number>(TRIAL_SEEN_KEY) === undefined) {
      saveQuietly(context.globalState, TRIAL_SEEN_KEY, now);
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
    if (d.setTrialEndedPending === true) saveQuietly(context.globalState, TRIAL_END_PENDING_KEY, true);
    if (d.setWelcomeShown === true) saveQuietly(context.globalState, WELCOME_KEY, true);
    if (d.setTrialEndedShown === true) saveQuietly(context.globalState, TRIAL_END_KEY, true);
    if (d.toast === "welcome") {
      saveQuietly(context.globalState, WELCOME_DISPLAYED_KEY, true);
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
          else if (choice === "Buy") void vscode.commands.executeCommand("sessionDeck.buyLicense", "trial_ended");
        });
    }
    return d.toast !== null;
  };

  // Once per lapsed monthly key: the tier just dropped to free, so say so and name
  // the next step; a later renewal that lapses gets its own notice. The globalState
  // latch alone was per window: two windows refreshing as the key lapsed both read
  // it unset before either write reached the other, and both showed the notice.
  // So the notice shows only in the window that wins an exclusive claim for that
  // month (licenseNoticeClaim), and the latch is saved after that (below).
  const KEY_EXPIRED_KEY = "licenseKeyExpiredNotified";
  const maybeKeyExpiredNotice = (): boolean => {
    const d = decideKeyExpiredNotice({
      key: provider.licenseKey(),
      nowMs: Date.now(),
      state: provider.currentLicenseState,
      notificationsOn: notificationsOn(),
      notifiedFor: context.globalState.get<string>(KEY_EXPIRED_KEY),
    });
    return keyExpiredRunner.run(d);
  };
  // The latch is saved only once the notice is up here, or another window won the
  // claim and shows it, so closing this window during the claim's wait loses
  // nothing. Returns true even when another window wins: this tick still holds back
  // the over-limit reminder, so no window stacks it on the lapse notice.
  const keyExpiredRunner = new KeyExpiredNoticeRunner({
    claim: (name) => licenseNoticeClaim(name),
    show: (through) => {
      void vscode.window
        .showInformationMessage(keyExpiredMessage(through), "Enter Key", "Open sessiondeck.dev")
        .then((choice) => {
          if (choice === "Enter Key") void vscode.commands.executeCommand("sessionDeck.enterLicenseKey");
          else if (choice === "Open sessiondeck.dev") void vscode.commands.executeCommand("sessionDeck.buyLicense", "expired");
        });
    },
    saveLatch: (through) => saveQuietly(context.globalState, KEY_EXPIRED_KEY, through),
    disposed: () => bridge.isDisposed,
  });

  // Exclusive once-per-machine claim for a one-time notice. Through the desktop
  // companion when it answers (command rev 2): every window on this desktop, local
  // or remote, claims in the same directory. Without it, in this extension host's
  // own storage, which covers the windows sharing this host (all local windows, or
  // all windows into one remote) but not a local and a remote window together.
  // A window still waiting for its companion's first answer waits for that check
  // to finish (it gives up by itself after 60 s) before falling back, so it doesn't claim locally while the other windows
  // claim through the companion. A claim that can't be made at all shows the
  // notice: late duplication beats silence.
  // A window closing during the wait gets "disposed" and claims nothing.
  const licenseNoticeClaim = (name: string): Promise<boolean | "disposed"> =>
    bridge.claimOnceOrLocal(name, (n) => claimOnceFile(join(context.globalStorageUri.fsPath, "claims"), n));

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
  // This process's start time for move claims (a table query off Linux), read now
  // so a move never waits on it.
  void moveClaimIdentity();
  // Once per activation, after the first refreshes have listed the sessions:
  // delete move-claim files of sessions no longer listed (bounded, see
  // sweepMoveClaims), so the folder doesn't grow by one file per session moved.
  const claimSweep = setTimeout(() => {
    void sweepMoveClaims(join(context.globalStorageUri.fsPath, "claims"), (id) => provider.findSession(id) !== undefined || provider.findCodex(id) !== undefined).catch(
      () => undefined
    );
  }, 60_000);
  context.subscriptions.push({ dispose: () => clearTimeout(claimSweep) });
  // Without a lease this window publishes regardless, as it does when the lease
  // file can't be written (CONTRACTS.md: a lone window must publish).
  const publisherLease = health.run(
    "publish lease",
    "one-publisher-per-host coordination",
    () => new PublisherLease(join(context.globalStorageUri.fsPath, "claims"), `${process.pid}-${Date.now().toString(36)}`),
    undefined
  );
  context.subscriptions.push({ dispose: () => publisherLease?.release() });
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
  /** The status-bar note of the last remote-row click (replaced by the next). */
  let focusNote: vscode.Disposable | undefined;
  const focusClicks = new LatestClick();
  /** Carries out a stop asked from another host (set once Stop Session is wired). */
  let remoteStop: ((a: FocusAction, deadline: number | undefined) => Promise<void>) | undefined;
  const applyRemoteActions = async (selfHostId: string): Promise<void> => {
    const taken = await bridge.takeActions(selfHostId, (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
    for (const { action: a, deadline } of taken) {
      if (a.targetHostId !== selfHostId) continue; // defense in depth
      // The poster already told the user nothing happened: don't act late.
      if (deadline !== undefined && Date.now() > deadline) continue;
      if (a.kind === "stop") {
        // Not awaited: the confirmation waits for the user, the tick does not.
        if (remoteStop !== undefined) void remoteStop(a, deadline);
        else if (a.id !== undefined) void bridge.postFocusResult({ id: a.id, outcome: "not-stopped", detail: "SessionDeck there is still starting. Try again." });
        continue;
      }
      const report = await actOnRemoteFocus(a, deadline);
      if (a.id !== undefined) void bridge.postFocusResult({ id: a.id, ...report });
    }
  };

  /** What a Cursor or Codex row click did, as openCursor / openCodex return it. A
   *  terminal focused here does not bring this window to the front. */
  const cursorCodexReport = (r: unknown): Pick<FocusResult, "outcome" | "detail"> => {
    if (r === "shown") return { outcome: "shown", detail: "focused its terminal there; that window may not have come to the front" };
    if (r === "handed-off" || r === "outside") return { outcome: r };
    return { outcome: "preview" };
  };

  /** Perform one focus action here and say what happened (the report the posting
   *  window shows its user). A Claude session is shown with the window raised,
   *  since the user is looking at another window. */
  const actOnRemoteFocus = async (a: FocusAction, deadline: number | undefined): Promise<Pick<FocusResult, "outcome" | "detail">> => {
    try {
      if (a.tool === "claude") {
        const node = provider.findSession(a.sessionId);
        if (node === undefined) return { outcome: "not-found" };
        if (provider.locationOf(node.row).location === "outside") {
          // Same as a click here: its last message plus the offer to move it into
          // the editor, in this window (the one attached to its host).
          await vscode.commands.executeCommand("sessionDeck.openSession", node);
          return { outcome: "outside" };
        }
        provider.noteFocus({ kind: "session", id: node.row.meta.sessionId });
        await provider.markRead(node);
        refresh();
        if (navigator === undefined) return navReport("disabled");
        return navReport(await navigator.navigate(node.row, { raise: true, deadline }));
      }
      if (a.tool === "cursor") {
        const node = provider.findCursor(a.sessionId);
        if (node === undefined) return { outcome: "not-found" };
        return cursorCodexReport(await vscode.commands.executeCommand<unknown>("sessionDeck.openCursor", node));
      }
      const node = provider.findCodex(a.sessionId);
      if (node === undefined) return { outcome: "not-found" };
      return cursorCodexReport(await vscode.commands.executeCommand<unknown>("sessionDeck.openCodex", node));
    } catch (err) {
      return { outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
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

  // Remote-only upgraders from the former extension: its saved state (pins, filter,
  // sort) sits in the DESKTOP state DB, which this remote host can't read, so the
  // rename migration above found nothing. Ask the desktop companion (command rev 2)
  // per activation and copy what this install hasn't set itself. Done once the
  // companion actually read its DB; a failed read is retried by later activations,
  // up to LEGACY_IMPORT_MAX_ATTEMPTS. A pre-rev-2 companion is never asked. (The trial
  // start needs none of this: a rev-2 companion seeds its own from the same memento
  // and reconcileTrialStart merges it prefer-older.)
  const LEGACY_IMPORT_KEY = "legacyStateImported";
  const LEGACY_UNREADABLE_KEY = "legacyStateUnreadable";
  // Asked at most once per activation; an unreadable answer is retried by later
  // activations only (legacyImportOutcome caps those), never every tick.
  let legacyImportAsked = false;
  const importLegacyStateViaBridge = async (): Promise<void> => {
    if (legacyImportAsked || vscode.env.remoteName === undefined || legacy.legacyMemento) return;
    if (context.globalState.get<boolean>(LEGACY_IMPORT_KEY) === true) return;
    if (bridge.commandRev < 2) return; // an old companion is never asked; a later one may be
    legacyImportAsked = true;
    const doc = await bridge.legacyState();
    if (doc === undefined) return; // no usable answer this activation; ask again next one
    const updates = legacyStateUpdates(doc, (key) => context.globalState.get(key) !== undefined);
    for (const [key, value] of updates) await context.globalState.update(key, value);
    const outcome = legacyImportOutcome(doc, context.globalState.get<number>(LEGACY_UNREADABLE_KEY) ?? 0);
    if (outcome.unreadable > 0) await context.globalState.update(LEGACY_UNREADABLE_KEY, outcome.unreadable);
    if (outcome.done) await context.globalState.update(LEGACY_IMPORT_KEY, true);
    if (updates.length > 0) {
      syncFilterIndicator();
      provider.forceReload();
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
  let lastLeaseRenew = health.run(
    "hooks lease",
    "the hooks lease renewal",
    () => renewLeaseIfDue(0, Date.now(), leaseInPlay),
    0
  );
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
      // Only the publisher-lease holder (or the window about to take a free lease)
      // counts as publishing; the others just read the lease file each tick.
      const bridgeUp = crossHostEnabled() && bridge.available && hostIdentity !== undefined;
      const lease = bridgeUp ? (publisherLease?.peek() ?? "mine") : "taken";
      const { bridgePublishing, heartbeatDue } = publishGate(bridgeUp, lease, bridge.publishDue());
      const panelOpen = overviewPanel.isOpen();
      const sig = provider.changeSignature;
      const decision = decidePanelBuild({
        signatureChanged: sig !== lastBuiltSignature,
        panelOpen,
        panelJustOpened: panelOpen && !panelWasOpen,
        bridgePublishing,
        heartbeatDue,
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
        if (bridge.available) void importLegacyStateViaBridge();
        if (bridgeUp && hostIdentity !== undefined) {
          // One window per host publishes (see PublisherLease): the host's
          // snapshot is one file, and windows overwriting each other made rows
          // and their marks flicker on other hosts.
          if (decision.publish && panelModel !== undefined && (publisherLease?.holds() ?? true)) {
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
            // Taking a free lease over always publishes (CONTRACTS.md: one
            // publisher per host), even an unchanged snapshot within 15 s.
            void bridge.publish(buildSnapshot(panelModel, hostIdentity), lease === "free");
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
      controlPanel?.refresh();
      // One license notice per tick: whichever of these shows first holds the
      // over-limit reminder back to the next day.
      const keyNotice = maybeKeyExpiredNotice();
      const trialNotice = maybeTrialToast();
      maybeRemindLicense(keyNotice || trialNotice);
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
  health.run("hook script", "the hook script update", refreshHookScript, undefined);
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
  health.run("hook events", "instant updates from Claude hooks", watchEvents, undefined);
  context.subscriptions.push({ dispose: () => eventsWatcher?.close() });

  // "What's included" — the full feature list as a rendered markdown document (the
  // #33 virtual-doc pattern), NOT a truncated notification. The Control Panel's
  // License row and What's-included action, the license QuickPick and the trial
  // welcome toast all route here so the copy is never elided.
  health.run(
    "license documents",
    "the What's included page",
    () => context.subscriptions.push(PreviewDocs.register(LICENSE_SCHEME, () => WHATS_INCLUDED_MD)),
    0
  );

  const previewEmitter = new vscode.EventEmitter<vscode.Uri>();
  context.subscriptions.push(previewEmitter);
  health.run("preview documents", "last-message and properties previews", () => context.subscriptions.push(
    PreviewDocs.register(
      PREVIEW_SCHEME,
      (uri: vscode.Uri): string => {
        // The row's id rides in the query ("codex:<id>" or the session id); the
        // path is only the tab's title. Older uris carried the id in the path.
        const cx = uri.query.startsWith("codex:") ? [uri.query, uri.query.slice(6)] : /^\/codex\/(.+)\.md$/.exec(uri.path);
        if (cx !== null) {
          const c = provider.findCodex(cx[1]);
          return c === undefined ? "_Session is no longer running._" : codexPreviewMarkdown(c.row);
        }
        const sessionId = uri.query !== "" ? uri.query : uri.path.replace(/^\//, "").replace(/\.md$/, "");
        const node = provider.findSession(sessionId);
        if (node === undefined) return "_Session is no longer running._";
        const { row } = node;
        // The same title the tree shows (not the registry's derived name).
        const header =
          `# ${provider.sessionTitle(row)}\n\n` +
          `\`${row.meta.cwd}\` · pid ${row.meta.pid} · ${row.meta.entrypoint ?? "?"}\n\n---\n\n`;
        return header + (row.lastText !== "" ? row.lastText : "_No assistant message yet._");
      },
      previewEmitter.event
    )
  ), 0);

  const propsEmitter = new vscode.EventEmitter<vscode.Uri>();
  context.subscriptions.push(propsEmitter);
  health.run("preview documents", "last-message and properties previews", () => context.subscriptions.push(
    PreviewDocs.register(
      PROPS_SCHEME,
      (uri: vscode.Uri): string => {
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
      propsEmitter.event
    )
  ), 0);

  // Setup Doctor: a one-shot read-only diagnostics report rendered into a virtual
  // document (reuses the TextDocumentContentProvider pattern above). The report
  // text is regenerated on each run and held here for the provider to serve.
  let doctorReport = "";
  const doctorEmitter = new vscode.EventEmitter<vscode.Uri>();
  // No leading slash: a remote window's desktop side titles a document by its
  // Windows-style path, which showed as "\\SessionDeck Diagnostics.txt".
  const doctorUri = vscode.Uri.from({ scheme: DOCTOR_SCHEME, path: "SessionDeck Diagnostics" });
  context.subscriptions.push(doctorEmitter);
  health.run(
    "diagnostics documents",
    "Diagnostics and the debug report",
    () =>
      context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(DOCTOR_SCHEME, {
          onDidChange: doctorEmitter.event,
          provideTextDocumentContent: () => doctorReport,
        })
      ),
    0
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
      procStartMatch: await procStartAgreement(homes.flatMap((h) => registryStartEntries(h.dir))),
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
      startupFailures: health.failures,
      unsavedKeys: unsavedSettingKeys(),
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
  const captureUri = vscode.Uri.from({ scheme: CAPTURE_SUMMARY_SCHEME, path: "Drift Fixture Capture" });
  context.subscriptions.push(captureEmitter);
  health.run(
    "diagnostics documents",
    "Diagnostics and the debug report",
    () =>
      context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(CAPTURE_SUMMARY_SCHEME, {
          onDidChange: captureEmitter.event,
          provideTextDocumentContent: () => captureSummary,
        })
      ),
    0
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
  context.subscriptions.push(debugEmitter);
  health.run(
    "diagnostics documents",
    "Diagnostics and the debug report",
    () =>
      context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(DEBUG_REPORT_SCHEME, {
          onDidChange: debugEmitter.event,
          provideTextDocumentContent: () => debugReport,
        })
      ),
    0
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

  // Without it a click falls back to the last-message preview, as with navigation off.
  let navigator: Navigator | undefined = health.run(
    "navigation",
    "jumping to a session's window",
    () => (navigationEnabled() ? new Navigator(context.globalStorageUri.fsPath) : undefined),
    undefined
  );
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

  // Every click that falls back to a preview comes through these two: with the
  // preview documents unregistered, say so instead of a provider error.
  const previewUnavailable = (): boolean => {
    const failed = health.blockedBy(["preview documents"]);
    if (failed !== undefined) tellUnavailable(failed);
    return failed !== undefined;
  };
  const showPreview = async (node: SessionNode): Promise<void> => {
    if (previewUnavailable()) return;
    // Titled after the session, as the tree shows it; the id rides in the query.
    const uri = vscode.Uri.from({
      scheme: PREVIEW_SCHEME,
      path: previewDocPath(provider.sessionTitle(node.row), node.row.meta.sessionId.slice(0, 8)),
      query: node.row.meta.sessionId,
    });
    previewEmitter.fire(uri);
    await vscode.commands.executeCommand("markdown.showPreview", uri);
  };

  /** A Codex row's last reply (its click, and Show Last Message). */
  const showCodexPreview = async (codexId: string): Promise<void> => {
    if (previewUnavailable()) return;
    const name = provider.findCodex(codexId)?.row.name ?? "";
    const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: previewDocPath(name, codexId.slice(0, 8)), query: `codex:${codexId}` });
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
  ): SessionNode | CursorNode | ComposerNode | CodexNode | RemoteSessionNode | undefined =>
    resolveRowArg(arg, {
      session: (id) => provider.findSession(id),
      cursor: (id) => provider.findCursor(id),
      codex: (id) => provider.findCodex(id),
      composer: (id) => provider.findComposer(id),
    });

  // Where a session runs: this window's terminal shell pids count as "in the
  // editor" on every OS, and on macOS/Windows the process table answers new pids
  // asynchronously, so a finished batch re-renders the rows it placed.
  const syncTerminalPids = async (): Promise<void> => {
    const pids = new Set<number>();
    for (const t of vscode.window.terminals) {
      const pid = await t.processId;
      if (pid !== undefined) pids.add(pid);
    }
    provider.setTerminalPids(pids);
  };
  void syncTerminalPids();
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => void syncTerminalPids()),
    vscode.window.onDidCloseTerminal(() => void syncTerminalPids())
  );
  health.run(
    "process table",
    "where-a-session-runs updates",
    () => {
      const table = procTable();
      if (table !== undefined) context.subscriptions.push(table.onUpdate(() => refresh()));
    },
    undefined
  );

  // Move into Editor: a session running outside the editor (not in an editor
  // terminal or tab, not in tmux) is stopped there and resumed here. Only rows the
  // tree marked "outside" qualify; everything is re-checked at click time.
  // Stop Session: the same subject for any session whose place is known (outside,
  // an editor terminal or tab, tmux); `where` is then the whole place phrase.
  const sessionSubjectOf = (
    node: SessionNode | CursorNode | ComposerNode | CodexNode | RemoteSessionNode | undefined,
    mode: "move" | "stop"
  ): MoveSubject | undefined => {
    if (node === undefined) return undefined;
    const place = (loc: LocationVerdict, tab: boolean): string | undefined => {
      if (mode === "move") return loc.location === "outside" ? loc.where ?? "a terminal" : undefined;
      if (loc.location === "outside") return `outside the editor, in ${loc.where ?? "a terminal"}`;
      if (loc.location === "tmux") return "in tmux";
      if (loc.location === "editor") return tab ? "in a Claude Code tab in the editor" : "in the editor";
      return undefined;
    };
    if (node.kind === "session") {
      const { row } = node;
      const loc = provider.locationOf(row);
      const where = place(loc, row.meta.entrypoint === "claude-vscode");
      if (where === undefined) return undefined;
      const regStatus = registryStatus(row.homeDir, row.meta.pid);
      return {
        tool: "claude",
        id: row.meta.sessionId,
        title: provider.sessionTitle(row),
        cwd: row.meta.cwd,
        pid: row.meta.pid,
        // Only a start time the session's own registry entry vouches for (same
        // session id, same namespace, same live start) is carried; else refused.
        start: verifiedClaudeStart({ pid: row.meta.pid, sessionId: row.meta.sessionId, homeDir: row.homeDir }, identitySources()).start,
        // The registry's live status is exact (busy/waiting = a turn is open);
        // without it, fall back to the transcript reading.
        working: regStatus !== undefined ? regStatus === "busy" || regStatus === "waiting" : row.status !== "idle" || row.pendingQuestion,
        background: regStatus === "shell",
        owner: loc.owner,
        where,
        homeDir: row.homeDir,
        ...(mode === "stop" && loc.location === "editor" && row.meta.entrypoint === "claude-vscode" ? { claudeTab: true } : {}),
      };
    }
    if (node.kind === "codex") {
      const { row } = node;
      const loc = provider.codexLocationOf(row);
      const where = place(loc, false);
      if (where === undefined || row.pid === undefined) return undefined;
      // The census matched this pid to the rollout by cwd; confirm it is still a
      // codex process before offering to stop it.
      if (basename(pidCmdline(row.pid)?.[0] ?? "") !== "codex") return undefined;
      // Uncached: the process may have closed this session's file since it was listed.
      if (!pidHasOpen(row.pid, row.rolloutPath, true)) return undefined;
      const pid = row.pid;
      const protectedPid = pid <= 1 || pid === process.pid || pid === process.ppid;
      return {
        tool: "codex",
        id: row.id,
        title: row.name,
        cwd: row.cwd,
        pid,
        start: protectedPid ? undefined : pidStartTime(pid),
        rolloutPath: row.rolloutPath,
        working: row.status === "working",
        owner: loc.owner,
        where,
        codexHome: codexHomeOf(row.rolloutPath),
      };
    }
    return undefined;
  };
  const moveSubjectOf = (node: Parameters<typeof sessionSubjectOf>[0]): MoveSubject | undefined => sessionSubjectOf(node, "move");

  // Every way into a move (the command, a click's offer, a click relayed from
  // another host, which arrives as openSession/openCodex) passes these two.
  const moveUnavailable = (): boolean => {
    const failed = health.blockedBy(MOVE_NEEDS);
    if (failed !== undefined) tellUnavailable(failed);
    return failed !== undefined;
  };
  const claimDir = (): string => join(context.globalStorageUri.fsPath, "claims");
  const runMove = async (subject: MoveSubject): Promise<void> => {
    if (moveUnavailable()) return;
    const outcome = await moveSession(subject, claimDir());
    if (outcome === "cancelled") return;
    registryChanged = true;
    refresh();
    // The resumed session registers a moment later: rescan again so its row shows
    // up without anyone having to refresh (the registry watcher usually beats this).
    if (outcome === "resumed" || outcome === "unconfirmed") {
      for (const ms of [3_000, 10_000]) {
        setTimeout(() => {
          registryChanged = true;
          refresh();
        }, ms);
      }
    }
  };

  /** Stop a session here (this host): the confirmation, the verified stop, no
   *  resume. The row goes when its registry entry does; rescan to hurry that. */
  const runStop = async (subject: MoveSubject): Promise<Awaited<ReturnType<typeof stopSession>> | undefined> => {
    if (moveUnavailable()) return undefined;
    const r = await stopSession(subject, claimDir());
    logLine(`stop: pid ${subject.pid} ${r.outcome}`);
    if (r.outcome !== "cancelled") {
      registryChanged = true;
      refresh();
    }
    return r;
  };

  /** Stop a session that runs on another host: the SessionDeck window there
   *  that has its folder shows the confirmation and stops it (a "stop" action
   *  through the bridge, routed like a focus click); this window says what
   *  happened. */
  /** The status-bar note of the last relayed stop (replaced by the next click's). */
  let stopNote: vscode.Disposable | undefined;
  const stopRemote = async (node: RemoteSessionNode): Promise<void> => {
    const s = node.session;
    const title = shortTitle(s.title !== undefined && s.title.length > 0 ? s.title : s.id.slice(0, 8));
    const host = remoteHostLabel(node.hostId);
    // Each note replaces the one before (a late answer replaces "no answer yet").
    // A later remote-row click owns the status bar: this click's late notes are
    // dropped, as a focus click's are.
    const click = focusClicks.begin();
    focusNote?.dispose();
    stopNote?.dispose();
    stopNote = undefined;
    const tell = (n: { level: "status" | "info" | "warning"; text: string }): void => {
      if (n.level === "status") {
        if (!focusClicks.isLatest(click)) return;
        stopNote?.dispose();
        stopNote = vscode.window.setStatusBarMessage(`$(radio-tower) ${n.text}`, STOP_ANSWER_WAIT_MS);
        return;
      }
      else if (n.level === "info") void vscode.window.showInformationMessage(n.text);
      else void vscode.window.showWarningMessage(n.text);
    };
    logLine(`stop command: remote-session ${s.tool}`);
    if (node.stale || s.stoppable !== true || s.tool === "cursor") {
      void vscode.window.showInformationMessage(`"${title}" runs on ${host}. Stop it from a SessionDeck window on that host.`);
      return;
    }
    const post =
      crossHostEnabled() && hostIdentity !== undefined
        ? await bridge.postFocus({ targetHostId: node.hostId, sessionId: s.id, tool: s.tool, cwd: s.cwd }, "stop")
        : { posted: false as const };
    if (!post.posted || post.id === undefined) return tell(stopNotice("old" in post && post.old === true ? "old" : "not-posted", title, host));
    const id = post.id;
    const waiting = vscode.window.setStatusBarMessage(`$(sync~spin) Asking ${host} to stop "${title}"…`);
    try {
      await followStop(
        () => bridge.takeFocusResult(id),
        (answer) => {
          waiting.dispose();
          tell(stopNotice(answer, title, host));
        }
      );
    } finally {
      waiting.dispose();
    }
  };

  // A stop asked from another host: the same confirmation and stop as a local
  // one, in this window, answered under the action's id ("asking" first).
  remoteStop = async (a, deadline) => {
    const id = a.id;
    if (id === undefined) return;
    const node = a.tool === "claude" ? provider.findSession(a.sessionId) : a.tool === "codex" ? provider.findCodex(a.sessionId) : undefined;
    await actOnRemoteStop(deadline, {
      find: () => (node === undefined ? undefined : { pid: node.kind === "session" ? node.row.meta.pid : node.row.pid }),
      subject: () => sessionSubjectOf(node, "stop"),
      alive: pidAlive,
      post: (r) => bridge.postFocusResult({ id, ...r }),
      run: runStop,
      now: Date.now,
    });
  };

  /** Non-modal offer shown with the preview when an outside row is clicked. */
  const offerMove = async (node: SessionNode | CodexNode, subject: MoveSubject): Promise<void> => {
    if (moveUnavailable()) return;
    const action = "Move into Editor";
    const stop = "Stop Session";
    const pick = await vscode.window.showInformationMessage(
      `"${subject.title}" runs outside the editor, in ${subject.where}.`,
      action,
      stop
    );
    if (pick === action) await runMove(subject);
    if (pick === stop) {
      // Looked up again: the offer may have sat open while the session ended.
      const s = sessionSubjectOf(node, "stop");
      if (s === undefined) void vscode.window.showInformationMessage(`"${shortTitle(subject.title)}" has already stopped.`);
      else await runStop(s);
    }
  };

  context.subscriptions.push(
    registerCommand("sessionDeck.refresh", refresh),

    registerCommand("sessionDeck.moveSession", async (arg: RowContextArg) => {
      const node = resolveRowNode(arg);
      const subject = moveSubjectOf(node);
      // One line per invocation (Output > SessionDeck): tells a click that never
      // reached the command apart from one the command turned down. Row kind and
      // pid only, never a title or message.
      logLine(`move command: ${node?.kind ?? "no row"}${subject !== undefined ? ` pid ${subject.pid}` : " (not movable)"}`);
      if (subject === undefined) {
        void vscode.window.showInformationMessage(
          "This session can't be moved: SessionDeck only moves sessions it can see running outside the editor."
        );
        return;
      }
      await runMove(subject);
    }),

    registerCommand("sessionDeck.stopSession", async (arg: RowContextArg | RemoteSessionNode) => {
      const node = resolveRowNode(arg as RowContextArg);
      if (node?.kind === "remote-session") {
        await stopRemote(node);
        return;
      }
      const subject = sessionSubjectOf(node, "stop");
      logLine(`stop command: ${node?.kind ?? "no row"}${subject !== undefined ? ` pid ${subject.pid}` : " (not stoppable)"}`);
      if (subject === undefined) {
        const pid = node?.kind === "session" ? node.row.meta.pid : node?.kind === "codex" ? node.row.pid : undefined;
        void vscode.window.showInformationMessage(
          pid === undefined || !pidAlive(pid)
            ? "That session has already stopped."
            : "SessionDeck can't stop this session: it stops a session only when it can tell where it runs and which process runs it."
        );
        return;
      }
      await runStop(subject);
    }),

    registerCommand("sessionDeck.doctor", runDoctor),

    registerCommand("sessionDeck.captureDriftFixture", runCaptureDriftFixture),

    registerCommand("sessionDeck.copyDebugReport", copyDebugReport),

    registerCommand("sessionDeck.openFloatingWindow", async () => {
      overviewPanel.update(buildPanelModel());
      await overviewPanel.reveal();
    }),

    // Two ids drive one action so the title bar can show a checked-state icon
    // (list-tree when off, list-flat when on) via the activityTree context.
    ...["sessionDeck.toggleActivityTree", "sessionDeck.toggleActivityTreeActive"].map((id) =>
      registerCommand(id, async () => {
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
      registerCommand(id, async () => {
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
      registerCommand(id, async () => {
        await vscode.workspace
          .getConfiguration("sessionDeck")
          .update(
            "layout",
            layoutOf() === "columns" ? "list" : "columns",
            vscode.ConfigurationTarget.Global
          );
      })
    ),

    registerCommand("sessionDeck.markAllRead", async () => {
      await provider.markAllRead();
      refresh();
    }),

    registerCommand("sessionDeck.openSession", async (node: SessionNode) => {
      provider.noteFocus({ kind: "session", id: node.row.meta.sessionId });
      await provider.markRead(node);
      refresh();
      // An outside session has no window or tab to jump to: show its last message
      // and offer to move it here.
      const outside = moveSubjectOf(node);
      if (outside !== undefined) {
        await showPreview(node);
        void offerMove(node, outside);
        return;
      }
      const navigated = navigator !== undefined && (await navigator.navigate(node.row)).ok;
      if (!navigated) await showPreview(node);
    }),

    registerCommand("sessionDeck.showLastMessage", async (arg: RowContextArg) => {
      // Resolve the tree node / inbox reference / table context object to the real
      // session (the inbox is a view; the table passes a context object with the id).
      const node = resolveRowNode(arg);
      if (node?.kind === "codex") {
        // A Codex row's click opens the same preview: offer it here too.
        provider.noteFocus({ kind: "codex", id: node.row.id });
        await provider.markCodexRead(node);
        refresh();
        await showCodexPreview(node.row.id);
        return;
      }
      if (node === undefined || node.kind !== "session") return;
      provider.noteFocus({ kind: "session", id: node.row.meta.sessionId });
      await provider.markRead(node);
      refresh();
      await showPreview(node);
    }),

    registerCommand("sessionDeck.sessionProperties", async (arg: RowContextArg) => {
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
    registerCommand(
      "sessionDeck.focusRemoteSession",
      async (node: RemoteSessionNode) => {
        provider.noteFocus({ kind: "remote-session", hostId: node.hostId, id: node.session.id });
        const s = node.session;
        const title = s.title !== undefined && s.title.length > 0 ? s.title : s.id.slice(0, 8);
        const host = remoteHostLabel(node.hostId);
        focusNote?.dispose(); // a new click replaces the last click's note
        stopNote?.dispose(); // and a relayed stop's
        const click = focusClicks.begin();
        const tell = async (n: FocusNotice): Promise<void> => {
          // A slow earlier click's note never replaces a later click's.
          if (n.level === "status") {
            if (focusClicks.isLatest(click)) focusNote = vscode.window.setStatusBarMessage(`$(radio-tower) ${n.text}`, FOCUS_NOTE_MS);
          } else if (n.level === "info") void vscode.window.showInformationMessage(n.text);
          else void vscode.window.showWarningMessage(n.text);
          if (n.preview) await vscode.commands.executeCommand("sessionDeck.showRemoteLastMessage", node);
        };
        const pre = remoteFocusPrecheck(node, title, host);
        if (pre !== undefined) return tell(pre);
        const post =
          crossHostEnabled() && hostIdentity !== undefined
            ? await bridge.postFocus({ targetHostId: node.hostId, sessionId: s.id, tool: s.tool, cwd: s.cwd })
            : { posted: false };
        if (!post.posted) {
          await vscode.commands.executeCommand("sessionDeck.showRemoteLastMessage", node);
          return;
        }
        if (post.id === undefined) return tell(focusNotice("unconfirmed", title, host));
        const id = post.id;
        const waiting = vscode.window.setStatusBarMessage(`$(sync~spin) Asking ${host} to show "${title}"…`);
        try {
          await tell(focusNotice(await waitForFocusResult(() => bridge.takeFocusResult(id)), title, host));
        } finally {
          waiting.dispose();
        }
      }
    ),

    // Cursor Agent CLI session click: focus its terminal when the live pid is
    // known and lives in this window; otherwise just surface its last activity.
    registerCommand("sessionDeck.openCursor", async (node: CursorNode) => {
      const { row } = node;
      provider.noteFocus({ kind: "cursor", id: row.chatId });
      await provider.markCursorRead(node);
      refresh();
      // Same-window first: focusLocalTerminal matches the integrated terminal by
      // pid ancestry (cwd-independent), so it works even when the agent was
      // launched from a subdirectory of the workspace. Only if no local terminal
      // owns the pid do we relay cross-window (which also raises the owning window),
      // then fall back to a last-activity note.
      // The result tells a remote request's report what actually happened.
      if (row.pid !== undefined && (await focusLocalTerminal(row.pid))) return "shown";
      if (navigator !== undefined && (await navigator.navigateCursor({ cwd: row.cwd, kind: "cli", pid: row.pid }))) return "handed-off";
      const pidNote = row.pid !== undefined ? ` (pid ${row.pid})` : "";
      void vscode.window.showInformationMessage(
        `${row.name} — Cursor Agent, last activity ${fmtAge(row.ageSec)} ago${pidNote}.`
      );
      return "preview";
    }),

    registerCommand("sessionDeck.openComposer", async (node: ComposerNode) => {
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
    registerCommand("sessionDeck.openCodex", async (node: CodexNode) => {
      const { row } = node;
      provider.noteFocus({ kind: "codex", id: row.id });
      await provider.markCodexRead(node);
      refresh();
      if (row.pid !== undefined && (await focusLocalTerminal(row.pid))) return "shown";
      // The last reply, as a Claude row's click shows it, plus the Move offer
      // for a run outside the editor.
      await showCodexPreview(row.id);
      const outside = moveSubjectOf(node);
      if (outside !== undefined) {
        await offerMove(node, outside);
        return "outside";
      }
      return "preview";
    }),

    registerCommand(
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

    registerCommand("sessionDeck.setSort", async () => {
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

    registerCommand("sessionDeck.setFilter", pickFilter),
    registerCommand("sessionDeck.setFilterFilled", pickFilter),

    // Pin / unpin a project (context menu, contextValue-gated) and hide a LOCAL
    // session row. Show Hidden opens the unhide picker.
    registerCommand("sessionDeck.pinProject", async (node: ProjectNode) => {
      if (node?.cwd === undefined) return;
      await provider.pinProject(node.cwd);
      refresh();
    }),
    registerCommand("sessionDeck.unpinProject", async (node: ProjectNode) => {
      if (node?.cwd === undefined) return;
      await provider.unpinProject(node.cwd);
      refresh();
    }),
    registerCommand(
      "sessionDeck.hideSession",
      async (arg: RowContextArg) => {
        // Tree node, inbox reference (hides the REAL row), or table context object.
        const node = resolveRowNode(arg);
        if (node === undefined || node.kind === "remote-session") return; // remote rows are not hideable
        await provider.hideSession(node);
        refresh();
      }
    ),
    registerCommand("sessionDeck.dismissOrphans", async () => {
      await provider.hideOrphans();
      refresh();
    }),
    registerCommand("sessionDeck.showHidden", pickHidden),

    // Status-bar chip click: reveal SessionDeck and filter to attention so
    // the sessions needing you are all that's left in the tree.
    registerCommand("sessionDeck.triage", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.sessionDeck");
      await provider.setFilterMode("attention");
      refresh();
    }),

    // Keyboard triage: step to the next / previous session needing you (default
    // ctrl+alt+] / ctrl+alt+[), open it, and reveal the row — no mouse required.
    registerCommand("sessionDeck.nextAttention", () => triageStep(1)),
    registerCommand("sessionDeck.prevAttention", () => triageStep(-1)),

    // Return to the last session you focused (survives re-sorts / density flips
    // that rotate tree-item ids and drop VS Code's own selection).
    registerCommand("sessionDeck.returnToFocus", returnToFocus),

    registerCommand("sessionDeck.collapseAll", () => {
      // The columns TABLE view owns its own webview collapse state; the list view is
      // the sidebar tree. They are mutually exclusive (sessionDeck.columns gates
      // which one shows), so route to whichever is live.
      if (collapseTarget(layoutOf()) === "table") tableView.setAllCollapsed(true);
      else provider.setAllCollapsed(true);
      void vscode.commands.executeCommand("setContext", "sessionDeck.collapsed", true);
    }),

    registerCommand("sessionDeck.expandAll", () => {
      if (collapseTarget(layoutOf()) === "table") tableView.setAllCollapsed(false);
      else provider.setAllCollapsed(false);
      void vscode.commands.executeCommand("setContext", "sessionDeck.collapsed", false);
    }),

    registerCommand("sessionDeck.clearFilter", async () => {
      await provider.setFilterMode("all");
      refresh();
    }),

    registerCommand("sessionDeck.installHooks", () => {
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

    registerCommand("sessionDeck.removeHooks", () => {
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

    registerCommand("sessionDeck.enableCursorMonitoring", () => {
      try {
        enableCursorMonitoring();
        syncTopologyContext();
        scheduleRefresh("cursor-monitoring-enabled");
        void vscode.window.showInformationMessage("Cursor monitoring enabled — your next Composer turn will appear in SessionDeck.");
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    registerCommand("sessionDeck.disableCursorMonitoring", () => {
      try {
        disableCursorMonitoring();
        syncTopologyContext();
        scheduleRefresh("cursor-monitoring-disabled");
        void vscode.window.showInformationMessage("Cursor monitoring disabled and its hook entries removed.");
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    registerCommand("sessionDeck.removeAllIntegrations", () => {
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
    registerCommand("sessionDeck.enterLicenseKey", async () => {
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
      // Arm before the repaint is requested, then confirm only once the Sessions
      // tree and the Control Panel have fetched the new state (or a hidden view's
      // timeout passed), so the toast never runs ahead of what the views show.
      const repainted = Promise.all([provider.rootFetch.wait(1500), controlPanel?.rootFetch.wait(1500)]);
      provider.forceReload();
      if (overviewPanel.isOpen()) overviewPanel.update(buildPanelModel());
      refresh();
      const licensed = isLicensed(provider.currentLicenseState);
      await repainted;
      void vscode.window.showInformationMessage(
        value.trim() === ""
          ? "License key cleared."
          : licensed
            ? "Licensed — thank you."
            : "Key saved, but it isn't licensing right now (expired or invalid). Free tier stays in effect."
      );
    }),

    // Open the purchase page. BUY_URL is a single clearly-marked constant in
    // src/license.ts (the sessiondeck.dev checkout anchor). Internal callers pass
    // an entry-point tag (utm_content); menu invocations pass a tree element, so
    // only a string counts.
    registerCommand("sessionDeck.buyLicense", (content?: unknown) => {
      void vscode.env.openExternal(vscode.Uri.parse(buyUrl(typeof content === "string" ? content : undefined)));
    }),
    // The Control Panel's Buy row: argument-free (tree rows must be), same page,
    // tagged as coming from the panel.
    registerCommand("sessionDeck.buyLicenseFromPanel", () => {
      void vscode.env.openExternal(vscode.Uri.parse(buyUrl("panel")));
    }),

    // Free-tier status-bar item click → QuickPick.
    registerCommand("sessionDeck.licenseMenu", async () => {
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
      else if (pick.id === "buy") await vscode.commands.executeCommand("sessionDeck.buyLicense", "menu");
      // "What's included" is the full feature list rendered as a markdown document —
      // never the old truncated toast (which cut the list off mid-sentence).
      else await vscode.commands.executeCommand("sessionDeck.whatsIncluded");
    }),

    // Open the full, never-truncated "What's included" feature list as a rendered
    // markdown document (replaces the truncated showInformationMessage path).
    registerCommand("sessionDeck.whatsIncluded", async () => {
      const uri = vscode.Uri.from({ scheme: LICENSE_SCHEME, path: "/What's included.md" });
      await vscode.commands.executeCommand("markdown.showPreview", uri);
    }),

    health.run(
      "license debug command",
      "the license debug command",
      () =>
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
        }),
      { dispose: () => undefined }
    )
  );

  // The first session scan. A throw here leaves the tree empty until the 3 s
  // refresh succeeds; every command is registered by now.
  health.run("first refresh", "the first session scan", refresh, undefined);
}

export function deactivate(): void {
  logChannel?.dispose();
  logChannel = undefined;
}
