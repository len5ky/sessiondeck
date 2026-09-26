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
  type LicenseStateReport,
} from "./licenseStateReport";

// TEMPORARY DEBUG command for exercising the subscription/trial flow.
// Remove by deleting this file AND ./licenseStateReport.ts (+ its test), the
// registerLicenseDebugCommand(...) subscription in src/extension.ts, and the
// sessionDeck.debugLicense command contribution in package.json.

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
}): vscode.Disposable {
  const refreshLicenseSurfaces = (): void => {
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
  };

  // The rendered document body, refreshed on each "show state" invocation.
  let stateMarkdown = "_Run “Show current license state” to populate this report._";
  const stateEmitter = new vscode.EventEmitter<vscode.Uri>();
  deps.context.subscriptions.push(
    stateEmitter,
    vscode.workspace.registerTextDocumentContentProvider(DEBUG_LICENSE_SCHEME, {
      onDidChange: stateEmitter.event,
      provideTextDocumentContent: () => stateMarkdown,
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
      await deps.context.globalState.update(TRIAL_START_KEY, Date.now() - daysUsed * DAY_MS);
      refreshLicenseSurfaces();
      void vscode.window.showInformationMessage(
        `SessionDeck DEBUG: trial start back-dated to ${daysUsed} day(s) used.`
      );
      return;
    }

    if (pick.id === "reset") {
      await vscode.workspace
        .getConfiguration("sessionDeck")
        .update("licenseKey", "", vscode.ConfigurationTarget.Global);
      await clearGlobalState();
      refreshLicenseSurfaces();
      void vscode.window.showInformationMessage("SessionDeck DEBUG: license reset; a fresh trial has begun.");
      return;
    }

    // Show state — render the full computed state as a never-truncated markdown
    // document (Cursor clips showInformationMessage to a few words).
    stateMarkdown = buildLicenseStateMarkdown(gatherReport());
    stateEmitter.fire(DEBUG_LICENSE_URI);
    await vscode.commands.executeCommand("markdown.showPreview", DEBUG_LICENSE_URI);
  });
}
