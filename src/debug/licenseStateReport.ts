// PURE, vscode-free markdown builder for the temporary "Show current license state"
// debug surface (see licenseDebug.ts). Kept separate from the command wiring so the
// key-redaction invariant and the report layout can be unit-tested without importing
// vscode. Delete alongside licenseDebug.ts when the debug command is removed.
import {
  DAY_MS,
  TRIAL_MS,
  type LicenseState,
  isLicensed,
  licenseSummary,
} from "../license";

// globalState latch key literals mirrored here for display (kept in sync with
// extension.ts / licenseDebug.ts).
export const REMINDER_KEY = "licenseReminderDay";
export const WELCOME_KEY = "trialWelcomeShown";
export const TRIAL_END_PENDING_KEY = "trialEndedPending";
export const TRIAL_END_KEY = "trialEndedShown";

/** vscode.ExtensionMode.Production. The enum's numeric value is part of the VS
 *  Code API (Production = 1, Development = 2, Test = 3); mirrored here so the
 *  gate stays vscode-free and unit-testable. */
export const EXTENSION_MODE_PRODUCTION = 1;

/** Debug toast text. The change holds in THIS window only: the companion keeps
 *  its own older trial start, other windows still merge it, and a reload here
 *  merges it again. Saying so keeps the debug command honest (GUI finding F-12). */
export function DEBUG_MERGE_NOTE(what: string): string {
  return `${what} in this window. The desktop companion's trial start is ignored here until you reload; other open windows still use it.`;
}

/** The license debug command can reset the trial and fake days used, so it exists
 *  only in an Extension Development Host or a test run, never in an installed
 *  build. It is also not contributed in package.json, so it never shows in the
 *  Command Palette or on the store listing; in a dev host, run it from a
 *  keybinding or `executeCommand("sessionDeck.debugLicense")`. */
export function licenseDebugEnabled(extensionMode: number): boolean {
  return extensionMode !== EXTENSION_MODE_PRODUCTION;
}

/** Everything the license-state report renders. Pure input so the builder is a
 *  deterministic string function (no clock, no VS Code API). */
export interface LicenseStateReport {
  state: LicenseState;
  providerState: LicenseState;
  now: number;
  trialStartRaw: number | undefined;
  trialStart: number;
  daysUsed: number;
  trialDaysLeftValue: number | undefined;
  keyPresent: boolean;
  keyRedacted: string;
  keyParsedValid: boolean;
  freeTierOverLimit: boolean;
  licenseCovered: number;
  licenseTotal: number;
  reminderDay: number | undefined;
  welcomeShown: boolean;
  trialEndedPending: boolean;
  trialEndedShown: boolean;
}

const flag = (b: boolean): string => (b ? "yes" : "no");
const iso = (ms: number | undefined): string =>
  ms === undefined ? "unset (fresh)" : new Date(ms).toISOString();

// NEVER echo the raw setting. `redactLicenseKeys` only masks well-formed CMC keys, so
// a malformed / directly-edited licenseKey (a partial key, or an unrelated secret the
// user mistyped into the field) would otherwise print verbatim. Show the redacted form
// ONLY for a key that parses valid; anything else is reported as hidden.
function keyDisplay(r: LicenseStateReport): string {
  if (!r.keyPresent) return "absent";
  if (r.keyParsedValid) return `\`${r.keyRedacted}\``;
  return "present but not well-formed (value hidden)";
}

/** Render the computed license state as a rich markdown document. NEVER prints the
 *  raw key — only its redacted form and parse verdict. */
export function buildLicenseStateMarkdown(r: LicenseStateReport): string {
  const trialLenDays = TRIAL_MS / DAY_MS;
  const summary = licenseSummary(r.state, r.freeTierOverLimit, r.licenseCovered, r.licenseTotal);
  const lines: string[] = [
    "# SessionDeck — license state (debug)",
    "",
    "> Temporary diagnostics surface. The license **key is never printed** — only its",
    "> redacted form and parse verdict appear below.",
    "",
    `_Snapshot at ${new Date(r.now).toISOString()}._`,
    "",
    "## Computed state",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Computed state | \`${r.state}\` |`,
    `| Provider state | \`${r.providerState}\` |`,
    `| Licensed? | ${flag(isLicensed(r.state))} |`,
    `| Summary line | ${summary} |`,
    "",
    "## Trial",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Trial start | ${iso(r.trialStartRaw)} |`,
    `| Trial days used | ${r.daysUsed} |`,
    `| Trial days left | ${r.trialDaysLeftValue ?? "—"} |`,
    `| Trial length | ${trialLenDays} day(s) |`,
    "",
    "## License key",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Present | ${flag(r.keyPresent)} |`,
    `| Redacted | ${keyDisplay(r)} |`,
    `| Parses valid | ${flag(r.keyParsedValid)} |`,
    "",
    "## Free-tier coverage",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Over free limit | ${flag(r.freeTierOverLimit)} |`,
    `| Sessions covered | ${r.licenseCovered} |`,
    `| Sessions total | ${r.licenseTotal} |`,
    "",
    "## Reminder / lifecycle bookkeeping",
    "",
    "| globalState latch | Value |",
    "| --- | --- |",
    `| \`${REMINDER_KEY}\` | ${r.reminderDay ?? "unset"} |`,
    `| \`${WELCOME_KEY}\` | ${flag(r.welcomeShown)} |`,
    `| \`${TRIAL_END_PENDING_KEY}\` | ${flag(r.trialEndedPending)} |`,
    `| \`${TRIAL_END_KEY}\` | ${flag(r.trialEndedShown)} |`,
    "",
  ];
  return lines.join("\n");
}
