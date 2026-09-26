// Setup Doctor: a one-command, read-only diagnostic of every subsystem the
// extension depends on. `buildDoctorReport` is a PURE function over an injected
// `DoctorProbes` object — no vscode, no fs — so it is fully unit-testable and
// extension.ts only wires the real probes into it. Every line is result-oriented:
// a mark (✗ / – / ✓), what it means, and the exact command or setting to act on.
// Results are ordered problem-first (✗, then –, then ✓) so the actionable stuff
// tops the report.

import { FormatHealthReport, HarnessReport, HooksReport } from "./canary";
import { LicenseState, licenseSummary, redactLicenseKeys } from "./license";

// ============================================================================
// Refresh tick watchdog — a vscode-free ring buffer of the last N refresh-tick
// timings plus a latch that flips to a warning state on sustained slowness or a
// throw. Pure and unit-tested (record/latch/unlatch sequences, percentile math,
// throw recording); extension.ts owns the thin instrumentation that times each
// refresh phase and feeds record(). The latch surfaces three ways: a
// lowest-priority capability note ("Refresh ticks running slow…"), the doctor
// section rendered by watchdogSection() below, and the debug report (which reuses
// that section wholesale and scrubs it). Lives here (not a new module — module
// freeze) because it exists to feed the diagnostics this file already builds.

/** Which snapshot path a tick took — decided by the ReuseHint extension.ts built:
 *  quiet (pure cache reuse), dirty (some sessions reclassified), full (registry
 *  rescan) or reconcile (the periodic forceFull safety net). */
export type TickPath = "quiet" | "dirty" | "full" | "reconcile";

const TICK_PATHS: readonly TickPath[] = ["quiet", "dirty", "full", "reconcile"];

/** Soft per-tick TOTAL budget (ms). Deliberately generous — the watchdog exists to
 *  catch PATHOLOGY (a tick an order of magnitude over a warm few-ms tick), not to
 *  tune the steady state. A constant, not a setting (MAINTENANCE: no new knobs). */
export const TICK_BUDGET_MS = 250;
/** Last N ticks retained; the ring is preallocated and overwritten in place, so
 *  recording a tick never allocates or grows. */
export const WATCHDOG_RING = 100;
/** Consecutive over-budget ticks that latch the warning. */
const SLOW_STREAK = 3;
/** Consecutive under-budget, non-throwing ticks that clear it. */
const RECOVER_STREAK = 10;

export interface PathStats {
  path: TickPath;
  count: number;
  /** total-ms percentiles across this path's ticks in the ring. */
  p50: number;
  p95: number;
  max: number;
}

export interface WatchdogWorst {
  path: TickPath;
  totalMs: number;
  reloadMs: number;
  panelMs: number;
  publishMs: number;
}

export interface WatchdogSummary {
  latched: boolean;
  /** Samples currently in the ring (0..WATCHDOG_RING). */
  ticks: number;
  /** Mean total ms across the ring — the number the capability-note message shows. */
  avgTotalMs: number;
  budgetMs: number;
  /** Per-path total-ms percentiles, only for paths actually seen in the ring. */
  byPath: PathStats[];
  /** Phase breakdown of the single worst (max total) tick in the ring. */
  worst?: WatchdogWorst;
  throwCount: number;
  /** Sanitized message of the most recent throw (control chars stripped + capped);
   *  the debug report adds path/username scrubbing when it embeds this section. */
  lastError?: string;
}

export function emptyWatchdogSummary(): WatchdogSummary {
  return { latched: false, ticks: 0, avgTotalMs: 0, budgetMs: TICK_BUDGET_MS, byPath: [], throwCount: 0 };
}

/** Nearest-rank percentile of an ASCENDING-sorted array; 0 for an empty input. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const i = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[i];
}

/** The doctor-view error sanitize: strip control chars, collapse whitespace, cap
 *  length. Path/username redaction is layered on by the debug report's whole-body
 *  scrub — this only keeps the message to one clean, bounded line. */
function sanitizeError(msg: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = msg.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export class TickWatchdog {
  // Preallocated parallel arrays — the ring never grows, so recording a tick is a
  // handful of array writes with zero allocation churn.
  private readonly total = new Float64Array(WATCHDOG_RING);
  private readonly reload = new Float64Array(WATCHDOG_RING);
  private readonly panel = new Float64Array(WATCHDOG_RING);
  private readonly publish = new Float64Array(WATCHDOG_RING);
  private readonly pathCode = new Uint8Array(WATCHDOG_RING);
  private readonly threwFlag = new Uint8Array(WATCHDOG_RING);
  private next = 0; // write cursor
  private filled = 0; // 0..WATCHDOG_RING
  private overStreak = 0;
  private underStreak = 0;
  private latched = false;
  private throwCount = 0;
  private lastError: string | undefined;

  get isLatched(): boolean {
    return this.latched;
  }

  get avgTotalMs(): number {
    if (this.filled === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.filled; i++) sum += this.total[i];
    return sum / this.filled;
  }

  /** Record one refresh tick. `errorMessage` is read only when `threw`. Latches on a
   *  throw immediately (and resets the recovery streak), or after SLOW_STREAK
   *  consecutive over-budget ticks. Unlatches after RECOVER_STREAK consecutive
   *  under-budget, non-throwing ticks. */
  record(
    path: TickPath,
    totalMs: number,
    reloadMs: number,
    panelMs: number,
    publishMs: number,
    threw: boolean,
    errorMessage?: string
  ): void {
    const i = this.next;
    this.total[i] = totalMs;
    this.reload[i] = reloadMs;
    this.panel[i] = panelMs;
    this.publish[i] = publishMs;
    this.pathCode[i] = Math.max(0, TICK_PATHS.indexOf(path));
    this.threwFlag[i] = threw ? 1 : 0;
    this.next = (this.next + 1) % WATCHDOG_RING;
    if (this.filled < WATCHDOG_RING) this.filled++;

    if (threw) {
      this.throwCount++;
      if (errorMessage !== undefined) this.lastError = sanitizeError(errorMessage);
      this.overStreak = 0;
      this.underStreak = 0;
      this.latched = true;
      return;
    }
    if (totalMs > TICK_BUDGET_MS) {
      this.overStreak++;
      this.underStreak = 0;
      if (this.overStreak >= SLOW_STREAK) this.latched = true;
    } else {
      this.overStreak = 0;
      this.underStreak++;
      if (this.latched && this.underStreak >= RECOVER_STREAK) this.latched = false;
    }
  }

  summary(): WatchdogSummary {
    const s = emptyWatchdogSummary();
    s.latched = this.latched;
    s.ticks = this.filled;
    s.avgTotalMs = this.avgTotalMs;
    s.throwCount = this.throwCount;
    s.lastError = this.lastError;
    if (this.filled === 0) return s;

    // Group total-ms by path and find the worst (max total) tick in one pass.
    const byPath = new Map<TickPath, number[]>();
    let worstIdx = 0;
    for (let i = 0; i < this.filled; i++) {
      const path = TICK_PATHS[this.pathCode[i]] ?? "quiet";
      const arr = byPath.get(path);
      if (arr === undefined) byPath.set(path, [this.total[i]]);
      else arr.push(this.total[i]);
      if (this.total[i] > this.total[worstIdx]) worstIdx = i;
    }
    s.byPath = TICK_PATHS.filter((p) => byPath.has(p)).map((p) => {
      const arr = (byPath.get(p) as number[]).slice().sort((a, b) => a - b);
      return { path: p, count: arr.length, p50: percentile(arr, 50), p95: percentile(arr, 95), max: arr[arr.length - 1] };
    });
    s.worst = {
      path: TICK_PATHS[this.pathCode[worstIdx]] ?? "quiet",
      totalMs: this.total[worstIdx],
      reloadMs: this.reload[worstIdx],
      panelMs: this.panel[worstIdx],
      publishMs: this.publish[worstIdx],
    };
    return s;
  }
}

/** Render the watchdog ring-buffer summary as a doctor section. Pure over the
 *  summary; the debug report embeds these same lines and scrubs them. Empty ring →
 *  one honest "no ticks yet" line. */
export function watchdogSection(w: WatchdogSummary): string[] {
  const fmt = (n: number): string => n.toFixed(1);
  const lines: string[] = ["Refresh tick watchdog", "---------------------"];
  if (w.ticks === 0) {
    lines.push("no ticks recorded yet this session");
    return lines;
  }
  const status = w.latched
    ? `SLOW/FAULTY — latched (avg ${Math.round(w.avgTotalMs)}ms)`
    : `ok (avg ${fmt(w.avgTotalMs)}ms)`;
  lines.push(`${status} · soft budget ${w.budgetMs}ms · ${w.ticks} tick(s) in ring`);
  lines.push("per-path total ms (p50 / p95 / max, count):");
  for (const s of w.byPath) {
    lines.push(`    ${s.path.padEnd(9)} ${fmt(s.p50)} / ${fmt(s.p95)} / ${fmt(s.max)}  (${s.count})`);
  }
  if (w.worst !== undefined) {
    const b = w.worst;
    lines.push(
      `worst tick: ${b.path} ${fmt(b.totalMs)}ms  (reload ${fmt(b.reloadMs)}, panel ${fmt(b.panelMs)}, publish ${fmt(b.publishMs)})`
    );
  }
  lines.push(`throws: ${w.throwCount}${w.throwCount > 0 && w.lastError !== undefined ? ` · last error: ${w.lastError}` : ""}`);
  return lines;
}

/** Virtual-document scheme for the diagnostics report (opened as an editor tab). */
export const DOCTOR_SCHEME = "sessiondeck-doctor";

/** Virtual-document scheme for the drift-fixture-capture summary (read-only tab). */
export const CAPTURE_SUMMARY_SCHEME = "sessiondeck-capture";

/** ✗ = broken/actionable, – = degraded/unsupported/off (informational), ✓ = healthy. */
export type DoctorMark = "problem" | "info" | "ok";

export interface DoctorCheck {
  mark: DoctorMark;
  title: string;
  /** What the current state is / what it means. */
  detail: string;
  /** The exact fix — a command name or setting — when there is something to do. */
  fix?: string;
}

export interface DoctorHome {
  label: string;
  dir: string;
  liveCount: number;
}

export interface DoctorHostEntry {
  label: string;
  lastSeenSec: number;
  stale: boolean;
}

/** Raw subsystem state, gathered by extension.ts from the real modules' probes. */
export interface DoctorProbes {
  version: string;
  // 1 — config homes
  homes: DoctorHome[];
  extraConfigDirs: string[];
  // 2 — hooks
  platformSupportsHooks: boolean;
  hooksInstalled: boolean;
  hookScriptStale: boolean;
  cursorMonitoringInstalled: boolean;
  cursorSpoolFreshSec: number;
  cursorProbeErrors: number;
  cursorMalformed: number;
  // 3 — bridge companion
  crossHost: boolean;
  bridgeAvailable: boolean;
  bridgeCompanionVersion?: string;
  bridgeVersionSkew: boolean;
  bridgeHosts: DoctorHostEntry[];
  cursorEnumAvailable: boolean;
  cursorEnumCount: number;
  cursorEnumGen: string;
  // 4 — host identity
  hostId?: string;
  hostLabel?: string;
  hostPlatform?: string;
  hostError?: string;
  // 5 — titles
  titlePath: "local" | "bridge";
  titleCount: number;
  // 6 — sqlite engine
  nodeSqlite: boolean;
  python3: boolean;
  // 7 — process introspection
  procPlatform: string;
  procFs: boolean;
  /** Age of the shared /proc census cache in seconds (one probe feeds all three
   *  liveness scans); undefined before the first census runs. */
  procCensusAgeSec?: number;
  // 8 — editor CLI
  editorCli: string;
  editorCliSource: "editorCliPath" | "cursorCliPath" | "default";
  editorCliOnPath: boolean;
  // 9 — notifications
  notifications: "urgent" | "off";
  attentionCount: number;
  // 10 — unfocused OS-alert channels (opt-in sound / OS notification)
  unfocusedSoundEnabled: boolean;
  unfocusedOsNotificationEnabled: boolean;
  unfocusedSoundAvailable: boolean;
  unfocusedOsNotificationAvailable: boolean;
  unfocusedSoundTool?: string;
  unfocusedOsNotificationTool?: string;
  // 12 — format canary (drift detection for every parsed private surface)
  formatHealth: FormatHealthReport;
  // 12b — hook-payload shape canary (the hook spool's undocumented event shape)
  hooksHealth: HooksReport;
  // 13 — license / free-tier (state only — NEVER the key; see the scrubber)
  licenseState: LicenseState;
  licenseOverLimit: boolean;
  licenseCovered: number;
  licenseTotal: number;
  // 14 — refresh tick watchdog (ring-buffer of per-phase tick timings + latch)
  watchdog: WatchdogSummary;
}

const GLYPH: Record<DoctorMark, string> = { problem: "✗", info: "–", ok: "✓" };
const RANK: Record<DoctorMark, number> = { problem: 0, info: 1, ok: 2 };

/** The Install Hooks command as it reads in the palette (category + title). */
const INSTALL_HOOKS_CMD = "SessionDeck: Install Hooks (instant updates + approval alerts)";

function homesCheck(p: DoctorProbes): DoctorCheck {
  if (p.homes.length === 0) {
    return {
      mark: "problem",
      title: "Config homes",
      detail: "no Claude config home found — no sessions can be discovered",
      fix: "add a directory in the sessionDeck.extraConfigDirs setting",
    };
  }
  const parts = p.homes.map((h) => `${h.label} (${h.liveCount} live)`).join(", ");
  return {
    mark: "ok",
    title: "Config homes",
    detail: `${p.homes.length} scanned: ${parts}`,
    fix:
      p.extraConfigDirs.length === 0
        ? "homes without live sessions (or on macOS/Windows) aren't auto-detected — add them via sessionDeck.extraConfigDirs"
        : undefined,
  };
}

function hooksCheck(p: DoctorProbes): DoctorCheck {
  if (!p.platformSupportsHooks) {
    return {
      mark: "info",
      title: "Hooks",
      detail: "POSIX-shell hooks are unsupported on native Windows (WSL is fine); the 3s poll still covers status",
    };
  }
  if (!p.hooksInstalled) {
    return {
      mark: "problem",
      title: "Hooks",
      detail: "not installed in every config home — no instant updates or approval alerts",
      fix: `run '${INSTALL_HOOKS_CMD}'`,
    };
  }
  if (p.hookScriptStale) {
    return {
      mark: "problem",
      title: "Hooks",
      detail: "installed, but the spool script is out of date and the auto-refresh could not rewrite it (permissions?)",
      fix: `reload the window, or run '${INSTALL_HOOKS_CMD}' to rewrite the script`,
    };
  }
  return { mark: "ok", title: "Hooks", detail: "installed in every home and up to date" };
}

function cursorMonitoringCheck(p: DoctorProbes): DoctorCheck {
  if (!p.platformSupportsHooks) {
    return {
      mark: "info",
      title: "Cursor monitoring",
      detail: "not available on native Windows (POSIX-shell hooks)",
    };
  }
  if (!p.cursorMonitoringInstalled) {
    return {
      mark: "info",
      title: "Cursor monitoring",
      detail: "not enabled — run 'SessionDeck: Enable Cursor Monitoring' to watch Composer sessions",
    };
  }
  if (p.cursorProbeErrors > 0) {
    return {
      mark: "problem",
      title: "Cursor monitoring",
      detail: `on (9 events) · probe write errors: ${p.cursorProbeErrors}`,
    };
  }
  if (p.cursorSpoolFreshSec >= 0) {
    const malformed = p.cursorMalformed > 0 ? ` · ${p.cursorMalformed} malformed` : "";
    return {
      mark: "ok",
      title: "Cursor monitoring",
      detail: `on (9 events) · spool fresh ${p.cursorSpoolFreshSec}s${malformed}`,
    };
  }
  return { mark: "ok", title: "Cursor monitoring", detail: "on (9 events) · no events yet" };
}

function bridgeCheck(p: DoctorProbes): DoctorCheck {
  if (!p.crossHost) {
    return {
      mark: "info",
      title: "Bridge companion",
      detail: "cross-host is off — single-host view only",
      fix: "set sessionDeck.crossHost: true to aggregate your other hosts",
    };
  }
  if (!p.bridgeAvailable) {
    return {
      mark: "problem",
      title: "Bridge companion",
      detail: "not answering — cross-host has degraded to single-host",
      fix: "install the sessiondeck-bridge companion vsix on your local (desktop) side (see README → Cross-host)",
    };
  }
  const hosts =
    p.bridgeHosts.length === 0
      ? "no other hosts in the store yet"
      : p.bridgeHosts
          .map((h) => `${h.label} (${h.stale ? `last seen ${h.lastSeenSec}s ago` : "live"})`)
          .join(", ");
  const skew = p.bridgeVersionSkew ? " — version skew vs main (tolerated)" : "";
  return {
    mark: "ok",
    title: "Bridge companion",
    detail: `answering${p.bridgeCompanionVersion !== undefined ? ` (v${p.bridgeCompanionVersion})` : ""}${skew}; ${hosts}`,
  };
}

function cursorEnumerationCheck(p: DoctorProbes): DoctorCheck {
  if (!p.crossHost || !p.bridgeAvailable) {
    return { mark: "info", title: "Cursor enumeration (bridge)", detail: "n/a: bridge companion not connected" };
  }
  if (!p.cursorEnumAvailable) {
    return {
      mark: "info",
      title: "Cursor enumeration (bridge)",
      detail: "node:sqlite unavailable on the desktop host — enumeration off; live hooks still work",
    };
  }
  const shortGen = p.cursorEnumGen.slice(0, 8);
  return {
    mark: "ok",
    title: "Cursor enumeration (bridge)",
    detail: `${p.cursorEnumCount} recent Composer sessions · gen ${shortGen}`,
  };
}

function hostIdCheck(p: DoctorProbes): DoctorCheck {
  if (p.hostId === undefined) {
    return {
      mark: "problem",
      title: "Host identity",
      detail: `could not load — cross-host disabled${p.hostError !== undefined ? ` (${p.hostError})` : ""}`,
      fix: "ensure ~/.local/state/claude-overview/host.json is readable and writable",
    };
  }
  const named = p.hostLabel !== undefined && p.hostLabel !== "";
  const detail = named
    ? `${p.hostLabel} · ${p.hostPlatform ?? "?"} · id ${p.hostId}`
    : `${p.hostPlatform ?? "?"} · id ${p.hostId}`;
  return { mark: "ok", title: "Host identity", detail };
}

function titlesCheck(p: DoctorProbes): DoctorCheck {
  const via = p.titlePath === "local" ? "local workspace storage" : "the bridge companion";
  if (p.titleCount > 0) {
    return { mark: "ok", title: "Real tab titles", detail: `via ${via} — ${p.titleCount} extracted` };
  }
  return {
    mark: "info",
    title: "Real tab titles",
    detail: `via ${via} — none extracted yet; rows fall back to project labels`,
    fix:
      p.titlePath === "bridge"
        ? "needs the local bridge companion; check it is installed"
        : "open a Claude tab so the editor serializes its title",
  };
}

function sqliteCheck(p: DoctorProbes): DoctorCheck {
  if (p.nodeSqlite) return { mark: "ok", title: "SQLite engine", detail: "node:sqlite (built-in, no subprocess)" };
  if (p.python3) {
    return { mark: "ok", title: "SQLite engine", detail: "python3 fallback (node:sqlite unavailable in this runtime)" };
  }
  return {
    mark: "info",
    title: "SQLite engine",
    detail: "none available — Cursor session names and real tab titles degrade to fallbacks",
    fix: "install python3 (or use an editor build whose Node has node:sqlite)",
  };
}

function procsCheck(p: DoctorProbes): DoctorCheck {
  if (p.procFs) {
    // One unified /proc census now feeds claude/cursor/codex liveness — surface its
    // cache age so the single sweep is visible (was three independent scans).
    const census = p.procCensusAgeSec === undefined ? "" : `; census age ${Math.round(p.procCensusAgeSec)}s`;
    return {
      mark: "ok",
      title: "Process introspection",
      detail: `full via /proc on ${p.procPlatform} — liveness, config-home auto-detect and terminal matching all work${census}`,
    };
  }
  return {
    mark: "info",
    title: "Process introspection",
    detail: `${p.procPlatform}: signal-0 liveness only (no /proc) — config-home auto-detect and terminal matching are unavailable`,
    fix: "add config homes explicitly via sessionDeck.extraConfigDirs",
  };
}

function editorCliCheck(p: DoctorProbes): DoctorCheck {
  const src =
    p.editorCliSource === "default"
      ? "auto-detected from the running editor"
      : `sessionDeck.${p.editorCliSource}`;
  if (p.editorCliOnPath) {
    return { mark: "ok", title: "Editor CLI", detail: `'${p.editorCli}' (${src}) found on PATH` };
  }
  return {
    mark: "problem",
    title: "Editor CLI",
    detail: `'${p.editorCli}' (${src}) not found on PATH — focusing another window won't work`,
    fix: "set sessionDeck.editorCliPath to the right binary (e.g. code, code-insiders, codium, cursor, windsurf)",
  };
}

function notificationsCheck(p: DoctorProbes): DoctorCheck {
  const need = `${p.attentionCount} session(s) need you now`;
  if (p.notifications === "off") {
    return {
      mark: "info",
      title: "Notifications",
      detail: `toasts off (the status-bar chip is still honest); ${need}`,
      fix: "set sessionDeck.notifications: urgent to toast on approval prompts and questions",
    };
  }
  return { mark: "ok", title: "Notifications", detail: `urgent toasts on; ${need}` };
}

function unfocusedAlertsCheck(p: DoctorProbes): DoctorCheck {
  const sound = p.unfocusedSoundEnabled
    ? p.unfocusedSoundAvailable
      ? `sound on (via ${p.unfocusedSoundTool ?? "?"})`
      : "sound on but no player available here"
    : "sound off";
  const osn = p.unfocusedOsNotificationEnabled
    ? p.unfocusedOsNotificationAvailable
      ? `OS notification on (via ${p.unfocusedOsNotificationTool ?? "?"})`
      : "OS notification on but unsupported on this platform"
    : "OS notification off";
  const soundBroken = p.unfocusedSoundEnabled && !p.unfocusedSoundAvailable;
  const osnBroken = p.unfocusedOsNotificationEnabled && !p.unfocusedOsNotificationAvailable;
  if (soundBroken || osnBroken) {
    return {
      mark: "problem",
      title: "Unfocused alerts",
      detail: `${sound}; ${osn} — an enabled channel can't deliver on this platform`,
      fix: soundBroken
        ? "install a player: paplay/pw-play (Linux), afplay (macOS), or powershell.exe (WSL/Windows)"
        : "OS notifications need notify-send (Linux) or osascript (macOS); WSL/Windows have none out of the box — use the sound channel there",
    };
  }
  if (!p.unfocusedSoundEnabled && !p.unfocusedOsNotificationEnabled) {
    return {
      mark: "info",
      title: "Unfocused alerts",
      detail: "off — no sound or OS notification when a session needs you while VS Code is unfocused (opt-in)",
      fix: "set sessionDeck.unfocusedSound and/or sessionDeck.unfocusedOsNotification: true",
    };
  }
  return { mark: "ok", title: "Unfocused alerts", detail: `${sound}; ${osn}` };
}

/** One "<Harness> format" line. The alarm (✗) fires only on suspected drift —
 *  required structure absent across ≥2 files. A version above the known-good
 *  ceiling is a NOTE (–), not a fault (a newer vendor release, parsing still fine).
 *  Otherwise ✓ with the observed version, or an informational "none observed". */
function formatCheck(title: string, r: HarnessReport, degradeHint: string): DoctorCheck {
  if (r.driftSuspected) {
    return {
      mark: "problem",
      title,
      detail: `${r.failed} of ${r.seen} failed structural parse — format may have drifted; ${degradeHint}`,
      fix: "run 'SessionDeck: Capture Drift Fixture' to save a sanitized sample for the fix, then update the extension (its parser for this vendor format may be out of date) and run Diagnostics again",
    };
  }
  const version = r.observedVersion !== undefined && r.observedVersion !== "" ? r.observedVersion : undefined;
  if (r.aboveCeiling && version !== undefined) {
    return {
      mark: "info",
      title,
      detail: `version ${version} is above the known-good ceiling ${r.ceiling} — likely a new release; parsing still healthy (watch for drift)`,
    };
  }
  if (r.seen === 0) {
    return { mark: "info", title, detail: "no sessions observed yet this run — nothing to check" };
  }
  const ver =
    version !== undefined
      ? `, version ${version}${r.ceiling !== undefined ? `, ceiling ${r.ceiling}` : ""}`
      : "";
  return { mark: "ok", title, detail: `healthy (${r.seen} parsed${ver})` };
}

/** Hook-payload shape canary line. Mirrors formatCheck's conservative bar: a drift
 *  alarm only when ≥2 recent events failed the structural shape check. A "legacy
 *  script still feeding events" observation adds a Reinstall hint — but only when the
 *  main Hooks line hasn't already flagged a stale local script (no duplicate nag). */
function hooksCanaryCheck(p: DoctorProbes): DoctorCheck {
  const h = p.hooksHealth;
  const legacyHint =
    h.legacyScriptSuspected && !p.hookScriptStale ? ` — old hook script still feeding events, run '${INSTALL_HOOKS_CMD}'` : "";
  if (h.driftSuspected) {
    return {
      mark: "problem",
      title: "Hook events",
      detail:
        `${h.failed} of ${h.seen} recent events failed shape — hook payloads may have drifted; ` +
        `alerts degraded, transcript polling still active${legacyHint}`,
      fix: "update the extension (its hook-event consumer may be out of date), or run 'SessionDeck: Install Hooks' to reinstall the spool script, then run Diagnostics again",
    };
  }
  if (h.legacyScriptSuspected && !p.hookScriptStale) {
    return {
      mark: "info",
      title: "Hook events",
      detail: `healthy (${h.consumed} consumed) — but an old hook script is still feeding events`,
      fix: `run '${INSTALL_HOOKS_CMD}' to refresh the spool script`,
    };
  }
  if (h.consumed === 0) {
    return { mark: "info", title: "Hook events", detail: "no hook events observed yet this run — nothing to check" };
  }
  return { mark: "ok", title: "Hook events", detail: `healthy (${h.consumed} consumed)` };
}

/** License / free-tier line. Reports STATE ONLY — never the key (the debug-report
 *  scrubber redacts any key that slips into free text as a backstop). A free fleet
 *  over the caps is a note (–); everything else is informational/ok. */
function licenseCheck(p: DoctorProbes): DoctorCheck {
  const detail = licenseSummary(p.licenseState, p.licenseOverLimit, p.licenseCovered, p.licenseTotal);
  if (p.licenseState === "free" && p.licenseOverLimit) {
    return {
      mark: "info",
      title: "License",
      detail,
      fix: "run 'SessionDeck: Enter License Key' or 'Buy License' to cover your whole fleet",
    };
  }
  return { mark: "ok", title: "License", detail };
}

/** Build the ordered check list (natural order), before problem-first sorting. */
export function doctorChecks(p: DoctorProbes): DoctorCheck[] {
  const fh = p.formatHealth;
  return [
    homesCheck(p),
    hooksCheck(p),
    cursorMonitoringCheck(p),
    bridgeCheck(p),
    cursorEnumerationCheck(p),
    hostIdCheck(p),
    titlesCheck(p),
    sqliteCheck(p),
    procsCheck(p),
    editorCliCheck(p),
    notificationsCheck(p),
    unfocusedAlertsCheck(p),
    formatCheck("Claude transcript format", fh.claude, "sessions degrade to idle/unknown status"),
    formatCheck("Codex rollout format", fh.codex, "affected Codex sessions vanish from the tree"),
    formatCheck("Cursor store format", fh.cursor, "Cursor chats degrade to fallback names"),
    formatCheck("Editor title storage format", fh.titles, "rows fall back to project labels"),
    hooksCanaryCheck(p),
    licenseCheck(p),
  ];
}

/** Render the full read-only report. Pure: same probes → same text. */
export function buildDoctorReport(p: DoctorProbes): string {
  // Stable sort keeps each rank in its natural (subsystem) order.
  const checks = doctorChecks(p).sort((a, b) => RANK[a.mark] - RANK[b.mark]);
  const problems = checks.filter((c) => c.mark === "problem").length;
  const notes = checks.filter((c) => c.mark === "info").length;
  const ok = checks.filter((c) => c.mark === "ok").length;

  const lines: string[] = [
    "SessionDeck — Diagnostics",
    "======================",
    "",
    `v${p.version} · ${p.hostLabel ?? p.hostId ?? "unknown host"} · ${p.hostPlatform ?? p.procPlatform}`,
    `${problems} problem(s) · ${notes} note(s) · ${ok} ok`,
    "",
    "Read-only. Each line: what it means, then the exact fix. Problems first.",
    "",
  ];
  for (const c of checks) {
    lines.push(`${GLYPH[c.mark]} ${c.title}: ${c.detail}`);
    if (c.fix !== undefined) lines.push(`    → ${c.fix}`);
  }
  lines.push("", ...watchdogSection(p.watchdog));
  lines.push("");
  return lines.join("\n");
}

// ============================================================================
// Copy Debug Report — a single markdown blob meant to be pasted into a bug
// report. It stitches this file's own diagnostics (buildDoctorReport, reused
// wholesale — NO duplicated probes) together with the format-canary state, a
// settings snapshot and a few counts, then SCRUBS the result so nothing private
// leaks into a public issue: no home paths, no usernames, no session cwds /
// titles / prompt text. Lives here (not a new module — module freeze) because it
// is the doctor report plus extras. `buildDebugReport` is PURE over an injected
// input object, so both the assembly and the scrubber are unit-tested under bun;
// extension.ts only gathers the real data and calls in.


/** Virtual-document scheme for the debug report (opened as a read-only editor tab). */
export const DEBUG_REPORT_SCHEME = "sessiondeck-debug";

/** Runtime identifiers the report builder needs to redact private data. `scrub()`
 *  itself only consumes `username`; `homeDir`/`hostname` are read by
 *  `buildDebugReport` for field-level label tokenization (labels aren't paths, so
 *  the text scrubber can't reach them). */
export interface ScrubContext {
  /** Current username → masked. Substring-masked when ≥4 chars (safe: a 4+-char
   *  name rarely appears as an incidental substring); whole-word only when shorter
   *  so a 2–3 char name can't corrupt tokens like `git`/`code`. Residual risk:
   *  a short name embedded in a longer identifier is left as-is. */
  username?: string;
  /** os.homedir() — lets the default `~/.claude` config home keep a readable label
   *  instead of an opaque `<home-N>` token. */
  homeDir?: string;
  /** os.hostname() — tokenized as a `<host-N>` in the report body. */
  hostname?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Path-scrub building blocks. SEG = one path-segment char (no separator, quote,
// whitespace, pipe or bracket); MID = a mid-path char (segments + separators, still
// no quote/space/pipe/bracket); BND = a left boundary so a match never starts inside
// another word or a URL scheme (`https:` never reads as a `s:` drive).
const SEG = "[^\\s\"'`)\\]|/\\\\]";
const MID = "[^\\s\"'`)\\]|]";
const BND = "(^|[\\s\"'`(\\[=,])";

/** Collapse every absolute path to `<path>/<basename>` — keep only the final
 *  segment so a path can never carry a home dir, mount point, client/org name or
 *  username. Covers POSIX (`/a/b`), Windows drive (`C:\a\b`, `C:/a/b`, doubled
 *  `C:\\a\\b`), UNC (`\\host\share\f`, JSON-escaped `\\\\host\\share\\f`) and
 *  `file://` URIs. Pure and idempotent (`<path>/x` has no boundary-anchored `/`). */
function collapseAbsolutePaths(text: string): string {
  let out = text;
  // file:// URIs first (they wrap POSIX or Windows paths).
  out = out.replace(new RegExp(`file:\\/\\/\\/?(?:${MID}*[\\/\\\\])?(${SEG}+)`, "gi"), "<path>/$1");
  // UNC (2+ leading backslashes at a boundary, incl. JSON-escaped \\\\host\\share\\…).
  // The boundary keeps this off a doubled-backslash *drive* path (C:\\a\\b), which
  // the drive rule below owns.
  out = out.replace(new RegExp(`${BND}\\\\{2,}(?:${MID}*[\\/\\\\])?(${SEG}+)`, "g"), "$1<path>/$2");
  // Windows drive paths (backslash or forward slash, incl. doubled backslashes).
  out = out.replace(new RegExp(`${BND}[A-Za-z]:[\\/\\\\]+(?:${MID}*[\\/\\\\])?(${SEG}+)`, "g"), "$1<path>/$2");
  // POSIX absolute paths.
  out = out.replace(new RegExp(`${BND}\\/(?:${SEG}+\\/)*(${SEG}+)`, "g"), "$1<path>/$2");
  return out;
}

/** Mask the current username per the length policy on ScrubContext.username. */
function maskUsername(text: string, user?: string): string {
  if (user === undefined || user.length < 2) return text;
  const re =
    user.length >= 4
      ? new RegExp(escapeRegExp(user), "g") // substring — a 4+-char name is a safe redact
      : new RegExp(`\\b${escapeRegExp(user)}\\b`, "g"); // whole-word — avoid corrupting real tokens
  return text.replace(re, "<user>");
}

/** The whole-body text backstop: collapse every absolute path, then mask the
 *  username. Host/home labels are tokenized at the field level by the report
 *  builder before this runs (they are identifiers, not paths). Pure + idempotent. */
export function scrub(text: string, ctx: ScrubContext): string {
  // redactLicenseKeys is a belt-and-suspenders backstop: the settings snapshot
  // never carries sessionDeck.licenseKey (it is omitted from DEBUG_SETTING_KEYS),
  // but any key that reaches free text is masked here so it can never leak.
  return redactLicenseKeys(maskUsername(collapseAbsolutePaths(text), ctx.username));
}

/** One key/value from the sessionDeck.* settings snapshot. Values are the raw
 *  config values (booleans, strings, string[]); path-bearing ones are scrubbed with
 *  the whole report, so this carries no home paths through by the time it is shown. */
export interface SettingEntry {
  key: string;
  value: boolean | number | string | string[];
}

export interface DebugReportInput {
  /** The exact probes object the doctor command builds — reused wholesale. */
  probes: DoctorProbes;
  // Editor/runtime environment (not part of DoctorProbes).
  appName: string;
  appVersion: string;
  platform: string;
  remoteName?: string;
  // Version facts from package.json.
  packageName: string;
  bridgeCompanionVersion?: string;
  vscodeEngine: string;
  // sessionDeck.* settings only.
  settings: SettingEntry[];
  // Cheap counts.
  sessionsByStatus: Record<string, number>;
  hostsInStore: number;
  caches?: Record<string, number>;
  /** Identifiers redacted from the final body. */
  scrub: ScrubContext;
}

function harnessLine(r: HarnessReport): string {
  const observed = r.observedVersion !== undefined && r.observedVersion !== "" ? r.observedVersion : "—";
  const ceiling = r.ceiling !== undefined ? r.ceiling : "—";
  const flags: string[] = [];
  if (r.driftSuspected) flags.push("DRIFT SUSPECTED");
  if (r.aboveCeiling) flags.push("above ceiling");
  const suffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  return `| ${r.label} | ${r.seen} | ${r.failed} | ${observed} | ${ceiling} |${suffix}`;
}

function canaryBlock(fh: FormatHealthReport): string[] {
  const rows = [fh.claude, fh.codex, fh.cursor, fh.titles];
  return [
    "| harness | seen | failed | observed | ceiling |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(harnessLine),
  ];
}

function renderValue(v: SettingEntry["value"]): string {
  if (Array.isArray(v)) return v.length === 0 ? "[]" : v.map((x) => `\`${x}\``).join(", ");
  if (typeof v === "string") return v === "" ? "(empty)" : `\`${v}\``;
  return `\`${String(v)}\``;
}

function countLine(record: Record<string, number>): string {
  const keys = Object.keys(record).sort();
  if (keys.length === 0) return "none";
  return keys.map((k) => `${k}: ${record[k]}`).join(", ");
}

function normSlashes(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Assemble the full markdown report, then scrub it. Pure: same input → same text.
 *
 *  Two-stage redaction. FIELD level (here): config-home and host labels are
 *  arbitrary identifiers — the default home label is `basename(dirname(dir))`, i.e.
 *  the username for `~/.claude` or a client/org name for a work tree, and host
 *  labels default to the machine hostname. Those are not paths, so the text
 *  scrubber can't reach them; we tokenize them to stable `<home-N>`/`<host-N>`
 *  before rendering (and reuse the SAME tokens in the reused doctor block).
 *  WHOLE-BODY (scrub, at the end): every absolute path → `<path>/<basename>`, and
 *  the username → `<user>`. Random `h_…` host ids are kept (not derived from any
 *  name) and the banner says so. */
export function buildDebugReport(input: DebugReportInput): string {
  const { probes } = input;
  const defaultHomeDir =
    input.scrub.homeDir !== undefined && input.scrub.homeDir !== ""
      ? `${normSlashes(input.scrub.homeDir)}/.claude`
      : undefined;

  // Stable label tokenizers. Homes: the default `~/.claude` keeps a readable label;
  // every other home → <home-N>. Hosts: self label first (=> <host-1>), then remote
  // bridge hosts, then os.hostname() and any remote-name suffix — all sharing one map
  // so identical labels collapse to the same token.
  const homeTokens = new Map<string, string>();
  const hostTokens = new Map<string, string>();
  const homeLabelFor = (label: string, dir: string): string => {
    if (defaultHomeDir !== undefined && normSlashes(dir) === defaultHomeDir) return "~/.claude";
    let t = homeTokens.get(label);
    if (t === undefined) homeTokens.set(label, (t = `<home-${homeTokens.size + 1}>`));
    return t;
  };
  const hostLabelFor = (label: string): string => {
    let t = hostTokens.get(label);
    if (t === undefined) hostTokens.set(label, (t = `<host-${hostTokens.size + 1}>`));
    return t;
  };

  // Redacted copy of the probes — labels tokenized, everything else (paths, hostId,
  // versions, counts) untouched here and handled by the whole-body scrub. Property
  // order matters: hostLabel (self) registers before bridgeHosts so it is <host-1>.
  const rp: DoctorProbes = {
    ...probes,
    homes: probes.homes.map((h) => ({ ...h, label: homeLabelFor(h.label, h.dir) })),
    hostLabel:
      probes.hostLabel !== undefined && probes.hostLabel !== "" ? hostLabelFor(probes.hostLabel) : probes.hostLabel,
    bridgeHosts: probes.bridgeHosts.map((b) => ({ ...b, label: hostLabelFor(b.label) })),
  };
  // Remote name often embeds a host after a `+` (ssh-remote+prod-box) — tokenize it.
  const remoteName =
    input.remoteName !== undefined
      ? ((): string => {
          const plus = input.remoteName.indexOf("+");
          return plus < 0 ? input.remoteName : input.remoteName.slice(0, plus + 1) + hostLabelFor(input.remoteName.slice(plus + 1));
        })()
      : undefined;
  // Register the real hostname so its literal occurrences share a stable token.
  if (input.scrub.hostname !== undefined && input.scrub.hostname !== "") hostLabelFor(input.scrub.hostname);

  const lines: string[] = [];

  lines.push("# SessionDeck — Debug Report", "");
  lines.push(
    "_Auto-scrubbed for public paste. **Kept:** extension/editor/engine versions, platform, the boolean & enum values of your `sessionDeck.*` settings, random per-machine host ids (`h_…`, not derived from your name or hostname), session/host/cache counts, format-canary versions. **Redacted:** every absolute path → `<path>/<basename>`, config-home & host labels → `<home-N>`/`<host-N>`, username → `<user>`. Never included: cwds, tab titles, message text, prompt text._",
    ""
  );

  // --- Environment -----------------------------------------------------------
  lines.push("## Environment", "");
  lines.push(`- Extension: v${probes.version}`);
  lines.push(`- Editor: ${input.appName} ${input.appVersion}`);
  lines.push(`- Platform: ${input.platform}${remoteName !== undefined ? ` · remote: ${remoteName}` : ""}`);
  lines.push(`- Host: ${rp.hostLabel ?? rp.hostId ?? "unknown"} (${rp.hostPlatform ?? rp.procPlatform})`);
  lines.push("");

  // --- Versions (the version facts package.json carries) ---------------------
  lines.push("## Versions", "");
  lines.push(`- ${input.packageName}: v${probes.version}`);
  lines.push(`- bridge companion: ${input.bridgeCompanionVersion !== undefined ? `v${input.bridgeCompanionVersion}` : "not connected"}`);
  lines.push(`- VS Code engine required: ${input.vscodeEngine}`);
  lines.push("");

  // --- Counts ----------------------------------------------------------------
  lines.push("## Counts", "");
  lines.push(`- Sessions by status: ${countLine(input.sessionsByStatus)}`);
  lines.push(`- Hosts in store: ${input.hostsInStore}`);
  if (input.caches !== undefined) lines.push(`- Caches: ${countLine(input.caches)}`);
  lines.push("");

  // --- Format canary ---------------------------------------------------------
  lines.push("## Format canary (parse health vs known-good ceilings)", "");
  lines.push(...canaryBlock(probes.formatHealth));
  lines.push("");

  // --- Settings snapshot -----------------------------------------------------
  lines.push("## Settings (sessionDeck.*)", "");
  for (const s of input.settings) lines.push(`- \`${s.key}\`: ${renderValue(s.value)}`);
  lines.push("");

  // --- Diagnostics (reused wholesale from the doctor, over the redacted probes) ---
  lines.push("## Diagnostics", "");
  lines.push("```");
  lines.push(buildDoctorReport(rp).trimEnd());
  lines.push("```");
  lines.push("");

  // Whole-body backstop: any host label still present literally (e.g. os.hostname()
  // echoed in free text) → its stable token, then the generic path + username scrub.
  let out = lines.join("\n");
  for (const [label, token] of hostTokens) {
    if (label.length >= 3) out = out.replace(new RegExp(`\\b${escapeRegExp(label)}\\b`, "g"), token);
  }
  return scrub(out, input.scrub);
}
