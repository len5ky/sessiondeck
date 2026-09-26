// OS-level escalation for needs-you incidents while VS Code is UNFOCUSED. This is
// a DELIVERY channel only — it adds no detection. It rides the exact incidents that
// already toast (SessionAlerts.notify fires once per fresh incident, already deduped
// by AlertTracker), and only escalates when `vscode.window.state.focused === false`
// at fire time: a focused window keeps the toast-only path, so we never double-alert.
//
// Two opt-in channels, both DEFAULT OFF:
//   - sound: a short audible cue. VS Code has no audio API, so we spawn a platform
//     player: afplay (macOS) / paplay|pw-play (Linux, incl. WSLg) plays the bundled
//     wav; powershell.exe (WSL/Windows) plays the system notification sound (a WSL
//     wav path isn't reliably reachable from Windows, so we use SystemSounds — no
//     file). No dependable player elsewhere → graceful no-op.
//   - osNotification: a real OS notification via notify-send (Linux) / osascript
//     (macOS). WSL/Windows have no zero-setup native toast (BurntToast/WinRT need
//     install + an AppId), so it no-ops there — documented honestly. Note VS Code's
//     own toasts are IN-WINDOW only (they do NOT surface in the OS notification
//     centre), so this channel is genuinely additive, not redundant.
//
// Spawn discipline: fixed argv arrays, no shell, stdio ignored, detached+unref'd so
// a hung/absent player can never keep the ext host alive or surface an error. The
// only text ever handed to a spawned command is a generic title + an integer count
// — never a session title or reason (those are sanitized for the UI but argv leaks
// into process lists, so we keep them out entirely).
//
// Vscode-free by design so the three seams — channel selection, the rate limiter,
// and focus gating — are unit-tested directly; extension.ts injects focus, config,
// the resolved platform tools and (in tests) the clock + spawner.

import { spawn } from "node:child_process";

/** The two opt-in channels' on/off state (both default false), read live from config. */
export interface UnfocusedAlertConfig {
  sound: boolean;
  osNotification: boolean;
}

/** What a given platform can dependably drive, derived from PATH probes once at
 *  activation. `undefined` argv/builder ⇒ the channel no-ops here. `soundTool` /
 *  `notifyTool` are the command names, surfaced by the doctor. */
export interface PlatformTools {
  /** Fixed argv to play the audible cue, or undefined when no player is available. */
  soundArgv?: readonly string[];
  soundTool?: string;
  /** Builds the OS-notification argv from a generic title + body (the only text
   *  ever passed), or undefined when no dependable notifier exists here. */
  notify?: (title: string, body: string) => readonly string[];
  notifyTool?: string;
}

/** Which platform each channel is available on, for the doctor + the pure planner. */
export interface ChannelAvailability {
  sound: boolean;
  osNotification: boolean;
}

/** Resolve the dependable per-platform delivery commands. Pure over its inputs
 *  (platform + a PATH probe + the bundled wav path), so the selection matrix is
 *  fully unit-testable. Ordering prefers a real player/notifier over the fallback.
 *  `soundFile` is only referenced by the file-playing branches (afplay/paplay/
 *  pw-play); the powershell branch never touches it. */
export function resolvePlatformTools(
  platform: NodeJS.Platform,
  onPath: (command: string) => boolean,
  soundFile: string
): PlatformTools {
  const t: PlatformTools = {};

  // --- Sound ---------------------------------------------------------------
  if (platform === "darwin" && onPath("afplay")) {
    t.soundArgv = ["afplay", soundFile];
    t.soundTool = "afplay";
  } else if (onPath("paplay")) {
    t.soundArgv = ["paplay", soundFile]; // Linux desktop or WSLg
    t.soundTool = "paplay";
  } else if (onPath("pw-play")) {
    t.soundArgv = ["pw-play", soundFile]; // PipeWire
    t.soundTool = "pw-play";
  } else if (onPath("powershell.exe")) {
    // WSL / Windows fallback: play the default notification sound through the
    // system audio device. Play() is async and returns immediately, so a short
    // sleep keeps the process alive long enough for it to be audible. The command
    // string is a fixed literal — no interpolation of any kind.
    t.soundArgv = [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 350",
    ];
    t.soundTool = "powershell.exe";
  }

  // --- OS notification -----------------------------------------------------
  if (platform === "linux" && onPath("notify-send")) {
    // Fixed flags + the app name; title/body are appended by the builder and are
    // never session-derived (generic title + count only).
    t.notify = (title, body) => ["notify-send", "-a", "SessionDeck", title, body];
    t.notifyTool = "notify-send";
  } else if (platform === "darwin" && onPath("osascript")) {
    // osascript takes one AppleScript string; we embed ONLY the generic title and
    // the integer-count body (both extension-authored), never any session text.
    t.notify = (title, body) => [
      "osascript",
      "-e",
      `display notification ${appleQuote(body)} with title ${appleQuote(title)}`,
    ];
    t.notifyTool = "osascript";
  }
  // WSL/Windows: no dependable zero-setup OS toast → notify stays undefined.

  return t;
}

/** Quote a string as an AppleScript literal (double-quoted, backslash-escaped). The
 *  inputs are always extension-authored (generic title + integer count), so this is
 *  belt-and-suspenders, not a sanitizer for untrusted data. */
function appleQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A monotonic one-per-window gate. `allow(now)` returns true at most once per
 *  `windowMs`; a burst of calls inside the window collapses to a single true. Seeded
 *  so the very first call always fires. */
export class RateLimiter {
  private last = Number.NEGATIVE_INFINITY;
  constructor(private readonly windowMs: number) {}
  allow(now: number): boolean {
    if (now - this.last < this.windowMs) return false;
    this.last = now;
    return true;
  }
}

/** The channels to actually drive right now. */
export interface EscalationPlan {
  sound: boolean;
  osNotification: boolean;
}
const NONE: EscalationPlan = { sound: false, osNotification: false };

/** The pure decision (no rate limiting): focus gating + per-channel enabled ∧
 *  available. A focused window escalates nothing — the in-window toast is enough,
 *  and the focus-return digest already covers what arose while away. */
export function planEscalation(
  focused: boolean,
  cfg: UnfocusedAlertConfig,
  avail: ChannelAvailability
): EscalationPlan {
  if (focused) return NONE;
  return {
    sound: cfg.sound && avail.sound,
    osNotification: cfg.osNotification && avail.osNotification,
  };
}

/** Does the plan drive at least one channel? */
export function planHasWork(p: EscalationPlan): boolean {
  return p.sound || p.osNotification;
}

/** Generic OS-notification body from the current needs-you count — the ONLY dynamic
 *  text that reaches a spawned command, and it carries no session identity. */
export function osNotificationBody(count: number): string {
  const n = Math.max(1, Math.floor(count));
  return `${n} session${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you`;
}

/** Detached, shell-free spawn. stdio ignored, unref'd, error swallowed — an absent
 *  or hung player must never surface to the user or keep the ext host alive. */
export function spawnDetached(argv: readonly string[]): void {
  try {
    const [cmd, ...args] = argv;
    if (cmd === undefined) return;
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => undefined); // ENOENT / spawn failure → silent no-op
    child.unref();
  } catch {
    // Delivery is best-effort; never let it throw into the refresh loop.
  }
}

/** Wires the seams together. `onIncident` is called once per fresh needs-you
 *  incident (from SessionAlerts.notify, so AlertTracker's per-incident dedup is
 *  reused verbatim). It escalates to the OS channels only while the window is
 *  unfocused, honoring the 30s rate window across BOTH channels so a burst delivers
 *  at most once. `focused`, `config` and (in tests) `now`/`spawner` are injected. */
export class UnfocusedAlerts {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly focused: () => boolean,
    private readonly config: () => UnfocusedAlertConfig,
    private readonly tools: PlatformTools,
    private readonly now: () => number = Date.now,
    private readonly spawner: (argv: readonly string[]) => void = spawnDetached,
    windowMs = 30_000
  ) {
    this.limiter = new RateLimiter(windowMs);
  }

  get availability(): ChannelAvailability {
    return {
      sound: this.tools.soundArgv !== undefined,
      osNotification: this.tools.notify !== undefined,
    };
  }

  onIncident(count: number): void {
    const plan = planEscalation(this.focused(), this.config(), this.availability);
    if (!planHasWork(plan)) return; // focused, or nothing enabled+available
    if (!this.limiter.allow(this.now())) return; // one delivery per 30s (burst→once)
    if (plan.sound && this.tools.soundArgv !== undefined) {
      this.spawner(this.tools.soundArgv);
    }
    if (plan.osNotification && this.tools.notify !== undefined) {
      this.spawner(this.tools.notify("SessionDeck", osNotificationBody(count)));
    }
  }
}
