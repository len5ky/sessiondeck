// Control Panel — a single collapsible sidebar segment that gathers the three
// health signals a user actually acts on (hooks, host bridge, license) plus the
// license actions (Buy / Enter Key / What's included) into one place, instead of
// scattering them across the status bar, a dim tree leaf and a truncated toast.
//
// This module is PURE and vscode-free (like format.ts / doctor.ts / license.ts):
// `buildControlPanelRows` maps a plain data snapshot to an ordered list of row
// descriptors, so the row logic and the What's-included copy are unit-tested under
// bun. extension.ts owns the thin TreeDataProvider that turns a ControlRow into a
// vscode.TreeItem (icon + colour by mark, MarkdownString tooltip, click command)
// and feeds it the live snapshot on every refresh tick. It surfaces CURRENT data
// sources only — it changes no licensing logic.
//
// It lands inside the module-freeze baseline (29 → 30 top-level src modules; the
// freeze ceiling is 30 — see docs/MAINTENANCE.md) as pure UI-surfacing that
// deletes the scattered/truncated license UX it replaces.

import { LicenseState, licenseSummary } from "./license";

/** Row semantics, driving the icon colour extension.ts paints:
 *  ok = healthy (green), problem = broken/actionable (error), info = degraded/off
 *  (muted), action = a prominent clickable action (normal foreground). */
export type ControlMark = "ok" | "problem" | "info" | "action";

/** One rendered row. `tooltip` is markdown (rendered as a MarkdownString hover —
 *  never truncated, unlike a notification). `command` makes the row clickable. */
export interface ControlRow {
  /** Stable id within a build (used for the TreeItem id + de-dup). */
  id: string;
  label: string;
  /** Codicon id WITHOUT the `$()` wrapper (e.g. "pulse", "key"). */
  icon: string;
  mark: ControlMark;
  /** Rich markdown tooltip (full detail; never elided). */
  tooltip: string;
  /** Command id to run on click; omit for a pure status row. */
  command?: string;
}

/** The live snapshot the panel renders — a subset of the doctor probes plus the
 *  license state, all cheap synchronous reads extension.ts already has per tick. */
export interface ControlPanelInput {
  // Hooks — the #40 Claude + Cursor hook families.
  platformSupportsHooks: boolean;
  hooksInstalled: boolean;
  hookScriptStale: boolean;
  hookDriftSuspected: boolean;
  cursorMonitoringInstalled: boolean;
  cursorProbeErrors: number;
  /** Age of the freshest Cursor spool event in seconds; <0 = none yet. */
  cursorSpoolFreshSec: number;
  // Host bridge companion.
  crossHost: boolean;
  /** Whether a self host identity loaded. Cross-host cannot function without it
   *  (remote-host enumeration and publishing both require it), so a missing identity
   *  makes an otherwise-"answering" companion useless — the row must say so. */
  hostIdentityOk: boolean;
  bridgeAvailable: boolean;
  bridgeCompanionVersion?: string;
  bridgeVersionSkew: boolean;
  bridgeHostCount: number;
  /** Freshest remote-host last-seen age in seconds; undefined when no hosts. */
  bridgeNewestHostAgeSec?: number;
  // License / free-tier (STATE only — never the key).
  licenseState: LicenseState;
  licenseOverLimit: boolean;
  licenseCovered: number;
  licenseTotal: number;
}

/** The full, never-truncated "What's included" feature list, as markdown. This is
 *  the honest register the brand uses — it is the tooltip on the License row AND the
 *  body of the `sessionDeck.whatsIncluded` virtual document that replaces the old
 *  truncated `showInformationMessage`. Kept here (pure, testable) so the copy has one
 *  source of truth. */
export const WHATS_INCLUDED_MD = [
  "### SessionDeck — what's included",
  "",
  "**Free for 3 days.** Everything below is unlocked for a 3-day evaluation from",
  "first run — no key, no account, no card.",
  "",
  "**Free forever after, for light use:** up to **3 sessions** (top-level",
  "sessions — subagents and workflow children never count, and remote hosts don't",
  "count toward the limit).",
  "",
  "**What the free tier gives you for those 3 sessions:**",
  "",
  "- Every Claude Code, Codex and Cursor session on the host, grouped by project",
  "- Live status, subagent/child activity, unread and last-message previews",
  "- Click-to-navigate, session properties, diagnostics, offline by design",
  "",
  "Any sessions beyond the 3 (working ones kept first) show as",
  "**Not available in free version** — no details, children or controls — until you",
  "add a license.",
  "",
  "**What a license unlocks (your whole fleet):**",
  "",
  "- Approval / needs-you **alerts** on every session",
  "- The activity-bar **badge**",
  "- Keyboard **triage** of blocked sessions",
  "- The focus-return **digest**",
  "",
  "**A license is per person, not per machine** — monthly or lifetime. Validation is",
  "a local check on an offline key: no phone-home, no telemetry, no network call",
  "anywhere in licensing. With Settings Sync on, your key follows you across your own",
  "machines automatically.",
].join("\n");

/** Compose a small markdown tooltip: a bold title, a detail line, and an optional
 *  "→ fix" line — the same result-oriented shape the doctor uses. */
function tip(title: string, detail: string, fix?: string): string {
  const lines = [`**${title}**`, "", detail];
  if (fix !== undefined) lines.push("", `→ ${fix}`);
  return lines.join("\n");
}

function hooksClaudeRow(p: ControlPanelInput): ControlRow {
  const base = { id: "hooks-claude", icon: "pulse" };
  if (!p.platformSupportsHooks) {
    return {
      ...base,
      label: "Hooks (Claude): n/a on native Windows",
      mark: "info",
      tooltip: tip("Hooks (Claude)", "POSIX-shell hooks are unsupported on native Windows (WSL is fine); the 3s poll still covers status."),
    };
  }
  if (!p.hooksInstalled) {
    return {
      ...base,
      label: "Hooks (Claude): not installed",
      mark: "problem",
      tooltip: tip("Hooks (Claude)", "Not installed in every config home — no instant updates or approval alerts.", "run SessionDeck: Install Hooks"),
      command: "sessionDeck.installHooks",
    };
  }
  if (p.hookScriptStale) {
    return {
      ...base,
      label: "Hooks (Claude): out of date",
      mark: "problem",
      tooltip: tip("Hooks (Claude)", "Installed, but the spool script is out of date and auto-refresh could not rewrite it (permissions?).", "reload the window, or run SessionDeck: Install Hooks"),
      command: "sessionDeck.installHooks",
    };
  }
  if (p.hookDriftSuspected) {
    return {
      ...base,
      label: "Hooks (Claude): event drift",
      mark: "problem",
      tooltip: tip("Hooks (Claude)", "Recent hook events failed the expected shape — payloads may have drifted; alerts degraded, transcript polling still active.", "run SessionDeck: Diagnostics, then update the extension"),
      command: "sessionDeck.doctor",
    };
  }
  return {
    ...base,
    label: "Hooks (Claude): active",
    mark: "ok",
    tooltip: tip("Hooks (Claude)", "Installed in every home and up to date — instant updates and approval alerts are live."),
  };
}

function hooksCursorRow(p: ControlPanelInput): ControlRow {
  const base = { id: "hooks-cursor", icon: "pulse" };
  if (!p.platformSupportsHooks) {
    return {
      ...base,
      label: "Hooks (Cursor): n/a on native Windows",
      mark: "info",
      tooltip: tip("Hooks (Cursor)", "Cursor monitoring uses POSIX-shell hooks, unsupported on native Windows (WSL is fine)."),
    };
  }
  if (!p.cursorMonitoringInstalled) {
    return {
      ...base,
      label: "Hooks (Cursor): not enabled",
      mark: "info",
      tooltip: tip("Hooks (Cursor)", "Cursor Composer monitoring is off.", "run SessionDeck: Enable Cursor Monitoring"),
      command: "sessionDeck.enableCursorMonitoring",
    };
  }
  if (p.cursorProbeErrors > 0) {
    return {
      ...base,
      label: "Hooks (Cursor): write errors",
      mark: "problem",
      tooltip: tip("Hooks (Cursor)", `On, but ${p.cursorProbeErrors} probe write error(s) — events may be missing.`, "run SessionDeck: Diagnostics"),
      command: "sessionDeck.doctor",
    };
  }
  const fresh = p.cursorSpoolFreshSec >= 0 ? `spool fresh ${p.cursorSpoolFreshSec}s` : "no events yet";
  return {
    ...base,
    label: `Hooks (Cursor): on · ${fresh}`,
    mark: "ok",
    tooltip: tip("Hooks (Cursor)", `Cursor Composer monitoring is on (${fresh}).`),
  };
}

function bridgeRow(p: ControlPanelInput): ControlRow {
  const base = { id: "bridge", icon: "server" };
  if (!p.crossHost) {
    return {
      ...base,
      label: "Host bridge: off (single-host)",
      mark: "info",
      tooltip: tip("Host bridge companion", "Cross-host is off — single-host view only.", "set sessionDeck.crossHost: true to aggregate your other hosts"),
    };
  }
  if (!p.hostIdentityOk) {
    // Cross-host is enabled but this host has no identity — even a companion that
    // answers can't enumerate remote hosts or relay focus, so an "answering" row
    // would be misleading. Flag the real blocker instead.
    return {
      ...base,
      label: "Host bridge: host identity unavailable",
      mark: "problem",
      tooltip: tip("Host bridge companion", "Cross-host is on, but this host's identity could not load — remote-host enumeration and focus relay are disabled.", "ensure ~/.local/state/claude-overview/host.json is readable and writable, then reload"),
      command: "sessionDeck.doctor",
    };
  }
  if (!p.bridgeAvailable) {
    return {
      ...base,
      label: "Host bridge: not answering",
      mark: "problem",
      tooltip: tip("Host bridge companion", "The companion isn't answering — cross-host has degraded to single-host.", "install the sessiondeck-bridge companion on your desktop side (README → Cross-host)"),
    };
  }
  const ver = p.bridgeCompanionVersion !== undefined ? ` v${p.bridgeCompanionVersion}` : "";
  const skew = p.bridgeVersionSkew ? " · version skew (tolerated)" : "";
  const hosts =
    p.bridgeHostCount === 0
      ? "no other hosts yet"
      : `${p.bridgeHostCount} host(s)` + (p.bridgeNewestHostAgeSec !== undefined ? ` · newest ${p.bridgeNewestHostAgeSec}s ago` : "");
  return {
    ...base,
    label: `Host bridge: answering${ver} · ${hosts}`,
    mark: "ok",
    tooltip: tip("Host bridge companion", `Answering${ver}${skew}. ${hosts}.`),
  };
}

function licenseRow(p: ControlPanelInput): ControlRow {
  const summary = licenseSummary(p.licenseState, p.licenseOverLimit, p.licenseCovered, p.licenseTotal);
  const overLimit = p.licenseState === "free" && p.licenseOverLimit;
  // The License row carries the full What's-included list in its hover — the rich,
  // never-truncated surface that replaces the old truncated notification. Clicking
  // opens the same list as a markdown document.
  return {
    id: "license",
    label: `License: ${summary}`,
    icon: "key",
    mark: overLimit ? "info" : "ok",
    tooltip: `**License** — ${summary}\n\n${WHATS_INCLUDED_MD}`,
    command: "sessionDeck.whatsIncluded",
  };
}

/** Build the ordered Control Panel rows from a live snapshot. Deterministic and
 *  vscode-free. Order: three status rows (hooks Claude, hooks Cursor, bridge,
 *  license) then the license actions. */
export function buildControlPanelRows(p: ControlPanelInput): ControlRow[] {
  return [
    hooksClaudeRow(p),
    hooksCursorRow(p),
    bridgeRow(p),
    licenseRow(p),
    {
      id: "buy",
      label: "Buy License",
      icon: "link-external",
      mark: "action",
      tooltip: tip("Buy License", "Open the purchase page — monthly or lifetime, per person."),
      command: "sessionDeck.buyLicense",
    },
    {
      id: "enter-key",
      label: "Enter License Key",
      icon: "key",
      mark: "action",
      tooltip: tip("Enter License Key", "Paste a CMC-YYYYMM-XXXX-XXXX-XXXX key — validated offline, never sent anywhere."),
      command: "sessionDeck.enterLicenseKey",
    },
    {
      id: "whats-included",
      label: "What's included",
      icon: "info",
      mark: "action",
      tooltip: WHATS_INCLUDED_MD,
      command: "sessionDeck.whatsIncluded",
    },
  ];
}
