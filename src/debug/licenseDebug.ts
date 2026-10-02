import * as vscode from "vscode";
import { TRIAL_START_KEY, type SessionsProvider } from "../tree";
import {
  DAY_MS,
  licenseState,
  parseLicenseKey,
  redactLicenseKeys,
  trialDaysLeft,
} from "../license";
import {
  REMINDER_KEY,
  WELCOME_KEY,
  TRIAL_END_PENDING_KEY,
  TRIAL_END_KEY,
  buildLicenseStateMarkdown,
  licenseDebugEnabled,
  DEBUG_MERGE_NOTE,
  type LicenseStateReport,
} from "./licenseStateReport";

// TEMPORARY DEBUG command for exercising the subscription/trial flow.
// Remove by deleting this file AND ./licenseStateReport.ts (+ its test), the
// registerLicenseDebugCommand(...) subscription in src/extension.ts. It is
// registered only outside production (see licenseDebugEnabled) and is not
// contributed in package.json.

// A dedicated virtual-doc scheme so "Show current license state" renders as a full,
// never-truncated markdown document (the #33 Session-Properties / #44 what's-included
// pattern) instead of a showInformationMessage that Cursor clips to a few words. Held
// here (not in extension.ts) so deleting this temporary file removes the surface too.
const DEBUG_LICENSE_SCHEME = "sessiondeck-license-debug";
const DEBUG_LICENSE_URI = vscode.Uri.from({
  scheme: DEBUG_LICENSE_SCHEME,
  path: "/SessionDeck License State (debug).md",
});

type DebugPick = { label: string; id: "set-days-used" | "reset" | "show-state" };

export function registerLicenseDebugCommand(deps: {
  context: vscode.ExtensionContext;
  provider: SessionsProvider;
  refresh: () => void;
  refreshPanel: () => void;
  /** Stop merging the desktop companion's (older) trial start in this window. */
  suspendTrialMerge: () => void;
}): vscode.Disposable {
  // An installed build must never be able to reset the trial or fake days used.
  if (!licenseDebugEnabled(deps.context.extensionMode)) return new vscode.Disposable(() => undefined);

  const refreshLicenseSurfaces = (): void => {
    stateEmitter.fire(DEBUG_LICENSE_URI); // an open state report re-renders too
    deps.provider.forceReload();
    deps.refreshPanel();
    deps.refresh();
  };

  const clearGlobalState = async (): Promise<void> => {
    await deps.context.globalState.update(TRIAL_START_KEY, undefined);
    await deps.context.globalState.update(WELCOME_KEY, undefined);
    await deps.context.globalState.update(TRIAL_END_PENDING_KEY, undefined);
    await deps.context.globalState.update(TRIAL_END_KEY, undefined);
    await deps.context.globalState.update(REMINDER_KEY, undefined);
    for (const key of ["trialSeenAt", "trialWelcomeDisplayed", "licenseKeyExpiredNotified"]) {
      await deps.context.globalState.update(key, undefined);
    }
  };

  // Rendered live on every read, so a reopened or restored preview is never stale.
  const stateEmitter = new vscode.EventEmitter<vscode.Uri>();
  deps.context.subscriptions.push(
    stateEmitter,
    vscode.workspace.registerTextDocumentContentProvider(DEBUG_LICENSE_SCHEME, {
      onDidChange: stateEmitter.event,
      provideTextDocumentContent: () => buildLicenseStateMarkdown(gatherReport()),
    })
  );

  const gatherReport = (): LicenseStateReport => {
    const cfg = vscode.workspace.getConfiguration("sessionDeck");
    const key = cfg.get<string>("licenseKey", "");
    const now = Date.now();
    const trialStartRaw = deps.context.globalState.get<number>(TRIAL_START_KEY);
    const trialStart = trialStartRaw ?? now;
    const state = licenseState(key, now, trialStart);
    const daysUsed = Math.max(0, Math.floor((now - trialStart) / DAY_MS));
    const parsed = parseLicenseKey(key);
    return {
      state,
      providerState: deps.provider.currentLicenseState,
      now,
      trialStartRaw,
      trialStart,
      daysUsed,
      trialDaysLeftValue: trialDaysLeft(state),
      keyPresent: key.trim() !== "",
      // Only carry a redacted form for a WELL-FORMED key; a malformed/directly-edited
      // value is never placed in the report (redactLicenseKeys can't mask arbitrary
      // text). The builder shows "present but not well-formed (value hidden)" instead.
      keyRedacted: parsed.valid ? redactLicenseKeys(key) : "",
      keyParsedValid: parsed.valid,
      freeTierOverLimit: deps.provider.freeTierOverLimit,
      licenseCovered: deps.provider.licenseCovered,
      licenseTotal: deps.provider.licenseTotal,
      reminderDay: deps.context.globalState.get<number>(REMINDER_KEY),
      welcomeShown: deps.context.globalState.get<boolean>(WELCOME_KEY) === true,
      trialEndedPending: deps.context.globalState.get<boolean>(TRIAL_END_PENDING_KEY) === true,
      trialEndedShown: deps.context.globalState.get<boolean>(TRIAL_END_KEY) === true,
    };
  };

  return vscode.commands.registerCommand("sessionDeck.debugLicense", async () => {
    const pick = await vscode.window.showQuickPick<DebugPick>(
      [
        { label: "$(watch) Set trial days used…", id: "set-days-used" },
        { label: "$(discard) Reset license & replay first-run trial", id: "reset" },
        { label: "$(info) Show current license state", id: "show-state" },
      ],
      { title: "SessionDeck DEBUG - License" }
    );
    if (pick === undefined) return;

    if (pick.id === "set-days-used") {
      const raw = await vscode.window.showInputBox({
        title: "SessionDeck DEBUG - Set Trial Days Used",
        prompt: "Enter a non-negative whole number of trial days used.",
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (value.trim() === "") return undefined;
          const n = Number(value.trim());
          return Number.isInteger(n) && n >= 0 ? undefined : "Enter an integer greater than or equal to 0.";
        },
      });
      if (raw === undefined || raw.trim() === "") return;
      const daysUsed = Number(raw.trim());
      deps.suspendTrialMerge();
      await deps.context.globalState.update(TRIAL_START_KEY, Date.now() - daysUsed * DAY_MS);
      refreshLicenseSurfaces();
      void vscode.window.showInformationMessage(`SessionDeck DEBUG: ${DEBUG_MERGE_NOTE(`trial start back-dated to ${daysUsed} day(s) used`)}`);
      return;
    }

    if (pick.id === "reset") {
      await vscode.workspace
        .getConfiguration("sessionDeck")
        .update("licenseKey", "", vscode.ConfigurationTarget.Global);
      deps.suspendTrialMerge();
      await clearGlobalState();
      refreshLicenseSurfaces();
      void vscode.window.showInformationMessage(`SessionDeck DEBUG: ${DEBUG_MERGE_NOTE("license reset; a fresh trial has begun")}`);
      return;
    }

    // Show state — render the full computed state as a never-truncated markdown
    // document (Cursor clips showInformationMessage to a few words).
    stateEmitter.fire(DEBUG_LICENSE_URI);
    await vscode.commands.executeCommand("markdown.showPreview", DEBUG_LICENSE_URI);
  });
}
