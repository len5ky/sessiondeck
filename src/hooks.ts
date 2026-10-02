// Optional push-event feature (v0.4): a tiny hook script appended to the user's
// global ~/.claude/settings.json forwards Notification / Stop / UserPromptSubmit
// events into a spool file the extension watches. Gives instant refresh and
// "needs approval" detection. Everything degrades gracefully when not installed.
// Pure Node module (no vscode import) so it is testable outside the IDE.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  statSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { ConfigHome } from "./homes";
import { recordHookHealth } from "./canary";

export const STATE_DIR = join(homedir(), ".local", "state", "claude-overview");
export const EVENTS_FILE = join(STATE_DIR, "events.jsonl");
export const HOOK_SCRIPT = join(STATE_DIR, "hook.sh");
export const CURSOR_SPOOL = join(STATE_DIR, "cursor-events.jsonl");
export const CURSOR_PROBE = join(STATE_DIR, "cursor-hook.sh");
export const CURSOR_HOOKS_JSON = join(homedir(), ".cursor", "hooks.json");
const LEASE_FILE = join(STATE_DIR, "monitor.lease");
/** How often the extension renews the lease while a hook-fed monitor is in play.
 *  Well inside the probe scripts' 7-day expiry, so an open editor never lets it lapse. */
export const LEASE_RENEW_MS = 24 * 60 * 60_000;
const settingsPath = (home: ConfigHome): string => join(home.dir, "settings.json");
/** Marker used to find/remove our entries in settings.json idempotently. */
const MARKER = "claude-overview";
const HOOK_EVENTS: Record<string, string> = {
  Notification: "notification",
  Stop: "stop",
  UserPromptSubmit: "prompt",
};

const SCRIPT_BODY = `#!/bin/sh
# ${MARKER} hook forwarder — appends Claude Code hook events to a spool file
# watched by SessionDeck. Safe to delete; reinstall via the
# "SessionDeck: Install Hooks" command.
payload=$(cat)
lease="${LEASE_FILE}"
now=$(date +%s)
ok=0
if [ -f "$lease" ]; then
  lts=$(head -n1 "$lease" 2>/dev/null | tr -dc 0-9)
  [ -n "$lts" ] && [ "$lts" -gt 0 ] && \
    [ $((now - lts)) -lt 604800 ] && [ $((lts - now)) -lt 86400 ] && ok=1
fi
f="${EVENTS_FILE}"
[ "$ok" = 1 ] && {
  size=$(wc -c < "$f" 2>/dev/null || echo 0)
  [ "$size" -gt 1048576 ] && : > "$f"
  printf '%s\\n' "{\\"event\\":\\"\${1:-unknown}\\",\\"ts\\":$((now*1000)),\\"bridge\\":\\"\${CLAUDE_CODE_BRIDGE_SESSION_ID:-}\\",\\"payload\\":\${payload:-null}}" >> "$f"
}
exit 0
`;

export const CURSOR_HOOK_EVENTS = [
  "sessionStart", "beforeSubmitPrompt", "afterAgentThought", "afterAgentResponse",
  "afterFileEdit", "subagentStart", "subagentStop", "stop", "sessionEnd",
] as const;
export const CURSOR_HOOK_ALLOWLIST: ReadonlySet<string> = new Set(CURSOR_HOOK_EVENTS);

const CURSOR_SCRIPT_BODY = `#!/bin/sh
# claude-overview Cursor hook probe — logging only. Registered per Cursor lifecycle
# event by ~/.cursor/hooks.json. Safe to delete; reinstall via SessionDeck.
payload=$(cat)
lease="${LEASE_FILE}"
now=$(date +%s)
ok=0
if [ -f "$lease" ]; then
  lts=$(head -n1 "$lease" 2>/dev/null | tr -dc 0-9)
  [ -n "$lts" ] && [ "$lts" -gt 0 ] && \
    [ $((now - lts)) -lt 604800 ] && [ $((lts - now)) -lt 86400 ] && ok=1
fi
if [ "$ok" = 1 ]; then
  f="${CURSOR_SPOOL}"
  if ! printf '%s\\n' "{\\"ts\\":$((now*1000)),\\"src\\":\\"$(hostname 2>/dev/null || echo host)\\",\\"event\\":\\"\${1:-unknown}\\",\\"payload\\":\${payload:-null}}" >> "$f" 2>/dev/null; then
    printf '%s\\n' "$((now*1000)) \${1:-unknown}" >> "$f.probe-errors" 2>/dev/null || true
  fi
fi
printf '{}\\n'
exit 0
`;

interface CursorHookCommand { command?: unknown; [key: string]: unknown }
interface CursorHooksFile { version?: unknown; hooks?: Record<string, unknown>; [key: string]: unknown }

function cursorEntries(value: unknown): CursorHookCommand[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is CursorHookCommand => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function referencesCursorProbe(entry: CursorHookCommand): boolean {
  return typeof entry.command === "string" && entry.command.includes(CURSOR_PROBE);
}

function contentHash(raw: string | null): string {
  return createHash("sha256").update(raw ?? "<absent>").digest("hex");
}

export function renewLease(leaseFile: string = LEASE_FILE): void {
  mkdirSync(dirname(leaseFile), { recursive: true });
  // Seconds — the probe scripts compare against `date +%s`. Writing ms here would
  // read as ~1.7e12s in the future and trip the future-date guard, suppressing
  // EVERY event write (Cursor and Claude). Keep the unit in lockstep with the scripts.
  writeFileSync(leaseFile, `${Math.floor(Date.now() / 1000)}\n`);
}

/** Renew the lease when it is due and a hook-fed monitor is in play. Both hook.sh
 *  (Claude hooks) and the Cursor probe drop every event once the lease is 7 days old,
 *  so `inPlay` must cover either integration, not Cursor alone. Pass lastRenew = 0
 *  at activation so a user returning after a week recovers at once. Fail-soft: a
 *  failed write still advances the clock (retried next interval). Returns the new
 *  last-check time, unchanged when nothing was due. */
export function renewLeaseIfDue(
  lastRenew: number,
  now: number,
  inPlay: () => boolean,
  renew: () => void = renewLease
): number {
  if (now - lastRenew <= LEASE_RENEW_MS) return lastRenew;
  // Due: the probe runs at most once per interval either way (hooksInstalled reads
  // every settings.json, too costly for the 3s tick). Nothing installed is fine to
  // skip: installHooks and enableCursorMonitoring renew the lease themselves.
  if (!inPlay()) return now;
  try {
    renew();
  } catch {
    /* monitoring remains fail-soft */
  }
  return now;
}

export function cursorMonitoringInstalled(): boolean {
  try {
    if (!existsSync(CURSOR_PROBE)) return false;
    const parsed = JSON.parse(readFileSync(CURSOR_HOOKS_JSON, "utf8")) as CursorHooksFile;
    return CURSOR_HOOK_EVENTS.every((event) => cursorEntries(parsed.hooks?.[event]).some(referencesCursorProbe));
  } catch {
    return false;
  }
}

export function enableCursorMonitoring(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(CURSOR_PROBE, CURSOR_SCRIPT_BODY, { mode: 0o755 });
  if (!existsSync(CURSOR_SPOOL)) writeFileSync(CURSOR_SPOOL, "");
  renewLease();

  const existed = existsSync(CURSOR_HOOKS_JSON);
  const original = existed ? readFileSync(CURSOR_HOOKS_JSON, "utf8") : null;
  let parsed: CursorHooksFile;
  try {
    parsed = original === null ? { version: 1, hooks: {} } : JSON.parse(original) as CursorHooksFile;
  } catch (err) {
    throw new Error(`${CURSOR_HOOKS_JSON}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.hooks === undefined || parsed.hooks === null || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks)) parsed.hooks = {};
  for (const event of CURSOR_HOOK_EVENTS) {
    if (!CURSOR_HOOK_ALLOWLIST.has(event)) throw new Error(`Cursor hook event not allowed: ${event}`);
    const entries = cursorEntries(parsed.hooks[event]);
    if (!entries.some(referencesCursorProbe)) entries.push({ command: `${CURSOR_PROBE} ${event}` });
    parsed.hooks[event] = entries;
  }

  mkdirSync(join(homedir(), ".cursor"), { recursive: true });
  const tmp = `${CURSOR_HOOKS_JSON}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`);
  // Back up from the CAPTURED original (not a fresh live read) so the .bak reflects the
  // exact bytes we validated against — never a version that changed under us.
  if (existed && original !== null && !original.includes(CURSOR_PROBE) && !existsSync(`${CURSOR_HOOKS_JSON}.bak`)) {
    writeFileSync(`${CURSOR_HOOKS_JSON}.bak`, original);
  }
  // Re-read + hash-compare IMMEDIATELY before the rename: on any uncertainty (the file
  // moved since we parsed it) surface a conflict instead of clobbering a foreign edit.
  const current = existsSync(CURSOR_HOOKS_JSON) ? readFileSync(CURSOR_HOOKS_JSON, "utf8") : null;
  if (contentHash(current) !== contentHash(original)) {
    rmSync(tmp, { force: true });
    throw new Error(`${CURSOR_HOOKS_JSON} changed on disk — retry`);
  }
  renameSync(tmp, CURSOR_HOOKS_JSON);
}

export function disableCursorMonitoring(): void {
  try {
    if (existsSync(CURSOR_HOOKS_JSON)) {
      const parsed = JSON.parse(readFileSync(CURSOR_HOOKS_JSON, "utf8")) as CursorHooksFile;
      if (parsed.hooks !== undefined && parsed.hooks !== null && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks)) {
        for (const event of CURSOR_HOOK_EVENTS) {
          const entries = cursorEntries(parsed.hooks[event]);
          const kept = entries.filter((entry) => !referencesCursorProbe(entry));
          if (kept.length > 0) parsed.hooks[event] = kept;
          else if (kept.length !== entries.length) delete parsed.hooks[event];
        }
        writeFileSync(CURSOR_HOOKS_JSON, `${JSON.stringify(parsed, null, 2)}\n`);
      }
    }
  } catch { /* best-effort */ }
  for (const path of [CURSOR_PROBE, CURSOR_SPOOL, `${CURSOR_SPOOL}.probe-errors`]) {
    try { rmSync(path, { force: true }); } catch { /* best-effort */ }
  }
}

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}
interface Settings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Settings;
}

interface PreparedHome {
  path: string;
  settings: Settings;
  exists: boolean;
  /** existing content already had our marker → keep its .bak as the true pre-hook one */
  hadMarker: boolean;
}

/** Parse + add our hook entries in memory; throws (naming the path) if unparseable. */
function prepareHome(home: ConfigHome): PreparedHome {
  const path = settingsPath(home);
  const exists = existsSync(path);
  const raw = exists ? readFileSync(path, "utf8") : "";
  let settings: Settings;
  try {
    settings = exists ? (JSON.parse(raw) as Settings) : {};
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const hadMarker = raw.includes(MARKER);
  const hooks = (settings.hooks ??= {});
  for (const [event, arg] of Object.entries(HOOK_EVENTS)) {
    const entries = (hooks[event] ??= []);
    if (entries.some((e) => JSON.stringify(e).includes(MARKER))) continue;
    entries.push({ hooks: [{ type: "command", command: `"${HOOK_SCRIPT}" ${arg}`, timeout: 5 }] });
  }
  return { path, settings, exists, hadMarker };
}

function writeHome(p: PreparedHome): void {
  if (p.exists && !p.hadMarker) copyFileSync(p.path, `${p.path}.${MARKER}.bak`);
  writeFileSync(p.path, `${JSON.stringify(p.settings, null, 2)}\n`);
}

function removeHome(home: ConfigHome): void {
  const path = settingsPath(home);
  const settings = readSettings(path);
  if (settings.hooks === undefined) return;
  for (const event of Object.keys(HOOK_EVENTS)) {
    const entries = settings.hooks[event];
    if (entries === undefined) continue;
    const kept = entries.filter((e) => !JSON.stringify(e).includes(MARKER));
    if (kept.length > 0) settings.hooks[event] = kept;
    else if (kept.length !== entries.length) delete settings.hooks[event];
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** True only when our hooks are present in EVERY home's settings.json. */
export function hooksInstalled(homes: ConfigHome[]): boolean {
  try {
    if (homes.length === 0 || !existsSync(HOOK_SCRIPT)) return false;
    return homes.every((h) => JSON.stringify(readSettings(settingsPath(h)).hooks ?? {}).includes(MARKER));
  } catch {
    return false;
  }
}

/** True when at least one home's settings.json carries our hook entries. The lease
 *  decision needs ANY-home semantics: every installed home shares the one lease, so a
 *  single home without hooks (or with an unparsable settings.json) must not stop the
 *  renewal for the others. hooksInstalled() keeps its EVERY-home meaning for the
 *  "install hooks" prompts. */
export function hooksInstalledInAnyHome(homes: ConfigHome[]): boolean {
  return homes.some((h) => {
    try {
      return JSON.stringify(readSettings(settingsPath(h)).hooks ?? {}).includes(MARKER);
    } catch {
      return false;
    }
  });
}

/** Throws with a readable message (naming the offending path) on unparsable
 *  settings.json — parses every home first so no home is written unless all
 *  parse cleanly, never clobbering a partially-installed set. */
export function installHooks(homes: ConfigHome[]): void {
  const prepared = homes.map(prepareHome);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(HOOK_SCRIPT, SCRIPT_BODY, { mode: 0o755 });
  if (!existsSync(EVENTS_FILE)) writeFileSync(EVENTS_FILE, "");
  renewLease();
  for (const p of prepared) writeHome(p);
}

export function removeHooks(homes: ConfigHome[]): void {
  for (const home of homes) removeHome(home);
}

/** True when the hook script is installed but its body differs from the current
 *  SCRIPT_BODY — the exact staleness signal refreshHookScript acts on. False when
 *  the script is absent (nothing to refresh) or already up to date. */
export function hookScriptStale(): boolean {
  try {
    return existsSync(HOOK_SCRIPT) && readFileSync(HOOK_SCRIPT, "utf8") !== SCRIPT_BODY;
  } catch {
    return false;
  }
}

/** The script body evolves across extension versions (e.g. the bridge field);
 *  rewrite an installed script in place when it's stale. settings.json entries
 *  are untouched — the command line they reference is unchanged. */
export function refreshHookScript(): void {
  try {
    if (hookScriptStale()) writeFileSync(HOOK_SCRIPT, SCRIPT_BODY, { mode: 0o755 });
  } catch {
    // best-effort; the next installHooks rewrites it anyway
  }
}

export interface HookEvent {
  event: string; // "notification" | "stop" | "prompt"
  ts: number;
  /** Present iff written by the current hook script; used purely as the
   *  script-version discriminator for the parse-health canary
   *  (hookEventShape.legacy). Absent = an older hook script is still feeding
   *  events. */
  bridge?: string;
  payload: { session_id?: string; cwd?: string; message?: string } | null;
}

/** Structural health of one PARSED hook-event line, checked against the fields
 *  onHookEvents (extension.ts) ACTUALLY consumes — so a vendor payload change that
 *  would silently drop the event is caught here rather than dying silently:
 *   • top-level `event`  (string) — the routing discriminator
 *   • top-level `ts`     (number) — the attention timestamp
 *   • `payload.session_id` (string) — absent ⇒ the event is DROPPED entirely
 *   • `payload.message`  (string) — REQUIRED only for "notification" events
 *      (isPermissionRequest + the reason capture read it); ignored for stop/prompt.
 *  Unknown/extra fields never count against health (the canary rule). `legacy` ⟺ a
 *  healthy line that lacks the top-level `bridge` field the current SCRIPT_BODY
 *  writes → an OLD script is still feeding events (a reinstall hint, not a failure). */
export function hookEventShape(parsed: unknown): { healthy: boolean; legacy: boolean } {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { healthy: false, legacy: false };
  }
  const o = parsed as Record<string, unknown>;
  const p = o.payload;
  const payload = p !== null && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : undefined;
  const eventOk = typeof o.event === "string" && o.event !== "";
  const tsOk = typeof o.ts === "number" && Number.isFinite(o.ts);
  const sidOk = payload !== undefined && typeof payload.session_id === "string" && payload.session_id !== "";
  const messageOk = o.event !== "notification" || (payload !== undefined && typeof payload.message === "string");
  const healthy = eventOk && tsOk && sidOk && messageOk;
  return { healthy, legacy: healthy && !("bridge" in o) };
}

/** Incremental reader for the spool file. Starts at the current end so only
 *  events after construction are reported; handles truncation (rotation). */
export class EventTail {
  private offset: number;

  constructor(private readonly path: string = EVENTS_FILE) {
    try {
      this.offset = statSync(path).size;
    } catch {
      this.offset = 0;
    }
  }

  readNew(): HookEvent[] {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size < this.offset) this.offset = 0; // rotated
    if (size === this.offset) return [];
    const fd = openSync(this.path, "r");
    let chunk: string;
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      chunk = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const events: HookEvent[] = [];
    // A COMPLETE line ends with "\n"; a non-empty final segment without one is a torn
    // write (a concurrent append caught mid-line). Torn lines are benign — never count
    // them toward the shape canary — but a complete line that won't parse, or one that
    // parses yet lacks a required field, IS a shape-drift signal (recordHookHealth).
    const parts = chunk.split("\n");
    const lastTorn = !chunk.endsWith("\n"); // parts[last] is a partial line iff true
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      const torn = lastTorn && i === parts.length - 1;
      if (!line.startsWith("{")) continue; // blank/whitespace segments carry no event
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (!torn) recordHookHealth(false); // complete malformed line — a real failure
        continue;
      }
      const shape = hookEventShape(parsed);
      recordHookHealth(shape.healthy, shape.legacy);
      events.push(parsed as HookEvent);
    }
    return events;
  }
}

export function isPermissionRequest(event: HookEvent): boolean {
  return event.event === "notification" && /permission|approv/i.test(event.payload?.message ?? "");
}
