// SHARED SOURCE — the single copy. Imported directly by both the main extension
// (./bridgeSchema) and the bridge companion (../../src/bridgeSchema, bundled into
// its out/extension.js by `bun build`). There is no byte-copy anymore; edit here
// and both packages pick it up. Keep it vscode-free and dependency-free so the
// bundle stays self-contained.
//
// Shared, vscode-free, dependency-free schema + validator for the cross-host
// command-bridge (plan §4/§5). Node/browser-agnostic: only JSON + string work
// happens here. Do NOT import vscode or any repo module (e.g. format.ts) into
// this file — it is copied verbatim into the companion extension at build time,
// so any import that isn't a bare Node builtin would break the copy.
//
// One exception to "only JSON + string work": claimOnceFile() uses node:fs (a Node
// builtin, so the companion bundle stays self-contained).
//
// The validator treats every input as hostile (it ingests documents produced by
// remote extension hosts). Structural violations are rejected; everything else
// is sanitized into a freshly built object — the input is never spread or
// mutated, so extra fields and prototype-pollution keys can never leak through.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";

// ---- rename migrations -----------------------------------------------------

/** Complete old→new setting-key table for the SessionDeck rename. Keep the old
 * names here: activation needs them to discover explicitly configured values. */
export const SETTING_MIGRATIONS = [
  ["claudeOverview.enableNavigation", "sessionDeck.enableNavigation"],
  ["claudeOverview.activityTree", "sessionDeck.activityTree"],
  ["claudeOverview.density", "sessionDeck.density"],
  ["claudeOverview.layout", "sessionDeck.layout"],
  ["claudeOverview.inboxLane", "sessionDeck.inboxLane"],
  ["claudeOverview.showCursorAgents", "sessionDeck.showCursorAgents"],
  ["claudeOverview.showCursorComposer", "sessionDeck.showCursorComposer"],
  ["claudeOverview.showCodexAgents", "sessionDeck.showCodexAgents"],
  ["claudeOverview.floatAlwaysOnTop", "sessionDeck.floatAlwaysOnTop"],
  ["claudeOverview.editorCliPath", "sessionDeck.editorCliPath"],
  ["claudeOverview.cursorCliPath", "sessionDeck.cursorCliPath"],
  ["claudeOverview.extraConfigDirs", "sessionDeck.extraConfigDirs"],
  ["claudeOverview.crossHost", "sessionDeck.crossHost"],
  ["claudeOverview.notifications", "sessionDeck.notifications"],
  ["claudeOverview.unfocusedSound", "sessionDeck.unfocusedSound"],
  ["claudeOverview.unfocusedOsNotification", "sessionDeck.unfocusedOsNotification"],
  ["claudeOverview.publishLastText", "sessionDeck.publishLastText"],
  ["claudeOverview.licenseKey", "sessionDeck.licenseKey"],
] as const;

/** Settings declared `"scope": "machine"` in package.json: they name a program
 *  SessionDeck runs or a config home it hands to `claude` (whose settings.json can
 *  run commands), so a cloned repository's workspace settings must not set them.
 *  VS Code ignores a workspace value for these and refuses to write one. */
export const MACHINE_SCOPED_SETTINGS: ReadonlySet<string> = new Set([
  "sessionDeck.editorCliPath",
  "sessionDeck.cursorCliPath",
  "sessionDeck.extraConfigDirs",
]);

export interface SettingInspection {
  globalValue?: unknown;
  workspaceValue?: unknown;
}

export interface SettingsMigrationPort {
  inspect(key: string): SettingInspection | undefined;
  update(key: string, value: unknown, target: "global" | "workspace"): PromiseLike<void>;
}

/** Copy explicitly-set legacy values once per setting. Any explicit new value at
 * either supported scope wins, so migration never overwrites a user's choice. */
/** Copy old-name settings to their new keys. Returns true when ANY old-name
 *  setting is set (whether or not it still needed copying): a sign this user ran
 *  the extension under its former name, which the trial welcome needs to know. */
export async function migrateLegacySettings(config: SettingsMigrationPort): Promise<boolean> {
  let foundLegacy = false;
  for (const [oldKey, newKey] of SETTING_MIGRATIONS) {
    const oldValue = config.inspect(oldKey);
    if (oldValue === undefined) continue;
    if (oldValue.globalValue === undefined && oldValue.workspaceValue === undefined) continue;
    foundLegacy = true;
    // A machine-scoped setting takes no workspace value: the old name's workspace
    // value (which a cloned repository could carry) is never copied, and the new
    // name's is not a user choice that blocks the copy.
    const machine = MACHINE_SCOPED_SETTINGS.has(newKey);
    const newValue = config.inspect(newKey);
    if (newValue?.globalValue !== undefined || (!machine && newValue?.workspaceValue !== undefined)) continue;
    if (oldValue.globalValue !== undefined) await config.update(newKey, oldValue.globalValue, "global");
    if (!machine && oldValue.workspaceValue !== undefined) await config.update(newKey, oldValue.workspaceValue, "workspace");
  }
  return foundLegacy;
}

/** Extension ids SessionDeck shipped under before the rename (publisher
 *  `lensky`): the `claude-overview` ids of its former names, and a short-lived
 *  `sessiondeck` under the old publisher. Still installed next to SessionDeck, they show every
 *  session twice and write the same hook script. */
export const LEGACY_EXTENSION_IDS: readonly string[] = [
  "lensky.claude-overview",
  "lensky.claude-overview-bridge",
  "lensky.sessiondeck",
  "lensky.sessiondeck-bridge",
];

/** Which legacy ids are installed, given an installed-check. */
export function installedLegacyExtensions(isInstalled: (id: string) => boolean): string[] {
  return LEGACY_EXTENSION_IDS.filter((id) => isInstalled(id));
}

/** The one warning shown while an old copy is installed. */
export function legacyExtensionMessage(ids: readonly string[]): string {
  return (
    `An older copy of this extension is still installed (${ids.join(", ")}), from before it was renamed SessionDeck. ` +
    `Uninstall it and reload the window: while both are installed every session shows twice and both rewrite the same hook script.`
  );
}

export interface MementoMigrationPort {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Parse the JSON object stored under an extension id in VS Code's state DB. */
export function parseLegacyMemento(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Copy an old extension-id memento into the new one without overwriting state
 * already written by SessionDeck. The old memento is retained in VS Code's DB. */
export async function copyMissingMementoValues(
  state: MementoMigrationPort,
  legacy: Readonly<Record<string, unknown>>
): Promise<void> {
  for (const [key, value] of Object.entries(legacy)) {
    if (state.get(key) === undefined) await state.update(key, value);
  }
}

export const BRIDGE_V = 1;

/** Revision of the companion's COMMAND SET, reported as `rev` in hello. Separate
 *  from BRIDGE_V on purpose: BRIDGE_V versions the snapshot/action DOCUMENTS, which
 *  did not change, and bumping it would make old and new peers reject each other's
 *  snapshots. A hello without `rev` is revision 1 (0.42.4 and older).
 *  Revision 5: actions of kind "stop" (Stop Session on a row from another host)
 *  and the stop outcomes of a result. The host that runs the session asks its
 *  user to confirm, stops it, and reports. A main posts a stop only to a rev-5
 *  companion; an older companion's validator would refuse the kind.
 *  Revision 4: `takeActions(hostId, route)` takes an optional second argument,
 *  `TakeRoute` { window, folders }: the asking window's folders. The companion
 *  hands an action to the window whose folders hold its cwd, and holds it back
 *  from the others for ROUTE_HOLD_MS (see routeAction). Older companions ignore
 *  the argument (first come, as before); an older main sends none.
 *  Revision 3 adds `postFocusResult` / `takeFocusResult`: the host that acted on a
 *  focus action reports what happened, so the window that clicked can tell the user.
 *  Revision 2 adds `legacyState` and `claimOnce`, and its `license` seeds the trial
 *  start from the former extension's saved state. */
export const BRIDGE_COMMAND_REV = 5;

export interface BridgeHelloResult {
  v: 1;
  version: string;
  instanceId?: string;
  /** Command-set revision (absent = 1). */
  rev?: number;
}

/** The companion's hello answer. `v` and `version` are what every main since 1.0
 *  checks; `rev` is ignored by mains older than command rev 2. */
export function bridgeHello(version: string, instanceId: string): BridgeHelloResult {
  return { v: 1, version, instanceId, rev: BRIDGE_COMMAND_REV };
}

/** The command-set revision a hello result reports: 1 when absent or malformed. */
export function helloRev(hello: unknown): number {
  if (!isObject(hello)) return 1;
  const rev = hello.rev;
  return typeof rev === "number" && Number.isInteger(rev) && rev >= 1 ? rev : 1;
}

// ---- former-extension state, read on the desktop (command rev 2) -------------
// VS Code keeps every extension's saved state (its memento) in the DESKTOP state
// DB. In a remote window the main extension runs on the remote host and cannot
// read the former extension's memento, so a remote-only upgrader lost the trial
// start (the trial restarted) along with pins and the filter. The companion runs on
// the desktop, so it reads that memento and hands over what matters.

/** The former main extension's id; its memento lives under this key. */
export const LEGACY_MAIN_EXTENSION_ID = "lensky.claude-overview";
/** Every sort and filter mode the Sessions view has. tree.ts derives its SortMode
 *  and FilterMode types from these lists, so a new mode can't be added there
 *  without becoming importable here. */
export const SORT_MODES = ["activity", "name", "heat"] as const;
export const FILTER_MODES = ["all", "1h", "24h", "attention"] as const;
const LEGACY_FILTER_MODES = FILTER_MODES;
const LEGACY_SORT_MODES = SORT_MODES;
const LEGACY_PIN_CAP = 50; // = the main extension's MAX_PINS

/** The former companion's id (its memento key in the same DB). */
export const LEGACY_BRIDGE_EXTENSION_ID = "lensky.claude-overview-bridge";

/** The one query the companion runs against the desktop state DB at activation:
 *  both former mementos in a single read (each read copies the whole DB). */
export const LEGACY_MEMENTOS_SQL =
  `SELECT key, value FROM ItemTable WHERE key IN ('${LEGACY_BRIDGE_EXTENSION_ID}', '${LEGACY_MAIN_EXTENSION_ID}')`;

/** Split that query's rows into the two mementos. null in = the read failed (no
 *  engine, copy or query error), which is NOT the same as "no former extension". */
export function legacyMementosFromRows(
  rows: string[][] | null
): { bridge?: Record<string, unknown>; main?: Record<string, unknown> } | null {
  if (rows === null) return null;
  const out: { bridge?: Record<string, unknown>; main?: Record<string, unknown> } = {};
  for (const [key, value] of rows) {
    const memento = parseLegacyMemento(value);
    if (memento === undefined) continue;
    if (key === LEGACY_BRIDGE_EXTENSION_ID) out.bridge = memento;
    else if (key === LEGACY_MAIN_EXTENSION_ID) out.main = memento;
  }
  return out;
}

/** The trial start a memento holds, when it is a finite number. */
export function mementoTrialStart(memento: Readonly<Record<string, unknown>> | undefined): number | undefined {
  const v = memento?.licenseTrialStart;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The companion's trial start: the OLDEST valid value across every source it
 *  has (its own, the former companion's memento, the former main extension's
 *  memento), so the result never depends on which source was read or copied
 *  first. A valid value is a finite, positive ms epoch not after `nowMs`; a
 *  future-dated or non-numeric value is ignored. Undefined when no source has a
 *  valid value (license() then stamps now). The caller writes it only when it is
 *  earlier than what it holds, so a trial start only ever moves earlier. */
export function seedTrialStart(candidates: readonly unknown[], nowMs: number): number | undefined {
  let oldest: number | undefined;
  for (const c of candidates) {
    if (typeof c !== "number" || !Number.isFinite(c) || c <= 0 || c > nowMs) continue;
    if (oldest === undefined || c < oldest) oldest = c;
  }
  return oldest;
}

/** `sessionDeckBridge.legacyState` result. Pins travel as [cwd, lastSeenMs] pairs
 *  rather than an object, so a hostile key can never become a prototype key. */
export interface LegacyStateDoc {
  /** False when the desktop holds no former-extension memento, or (with
   *  `unreadable`) when the companion could not read the state DB. */
  found: boolean;
  /** The read failed: nothing is known yet, so the main must ask again later
   *  rather than treat this as "no former extension". */
  unreadable?: true;
  /** With `unreadable`: the failure comes from a read made for THIS request, not a
   *  cached failure (the companion re-reads at most once a minute). Only fresh
   *  failures count toward LEGACY_IMPORT_MAX_ATTEMPTS. */
  fresh?: true;
  filterMode?: (typeof LEGACY_FILTER_MODES)[number];
  sortMode?: (typeof LEGACY_SORT_MODES)[number];
  pinnedProjects?: [string, number][];
}

function enumOf<T extends string>(x: unknown, allowed: readonly T[]): T | undefined {
  return typeof x === "string" && (allowed as readonly string[]).includes(x) ? (x as T) : undefined;
}

function pinPairs(x: unknown): [string, number][] | undefined {
  const entries: [string, number][] = [];
  if (Array.isArray(x)) {
    for (const e of x) {
      if (Array.isArray(e) && e.length === 2) entries.push([e[0] as string, e[1] as number]);
    }
  } else if (isObject(x)) {
    for (const k of Object.keys(x)) entries.push([k, x[k] as number]);
  } else {
    return undefined;
  }
  const out: [string, number][] = [];
  for (const [cwd, ms] of entries) {
    if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > CAPS.cwd) continue;
    if (typeof ms !== "number" || !Number.isFinite(ms)) continue;
    out.push([cwd, ms]);
  }
  // Newest first, capped like the main extension's own pin set.
  out.sort((a, b) => b[1] - a[1]);
  return out.slice(0, LEGACY_PIN_CAP);
}

/** Build the legacyState answer from the former extension's memento (companion
 *  side). Only the allow-listed keys leave; everything is rebuilt fresh. */
export function legacyStateFromRead(
  mementos: { main?: Record<string, unknown> } | null,
  fresh = false
): LegacyStateDoc {
  if (mementos !== null) return legacyStateFromMemento(mementos.main);
  return fresh ? { found: false, unreadable: true, fresh: true } : { found: false, unreadable: true };
}

export function legacyStateFromMemento(memento: Readonly<Record<string, unknown>> | undefined): LegacyStateDoc {
  if (memento === undefined) return { found: false };
  return validateLegacyState({
    found: true,
    filterMode: memento.filterMode,
    sortMode: memento.sortMode,
    pinnedProjects: memento.pinnedProjects,
  }) ?? { found: false };
}

/** Validate a legacyState result (main side; hostile input). Fresh object out,
 *  unknown or malformed fields dropped; null when it isn't a document at all. */
export function validateLegacyState(input: unknown): LegacyStateDoc | null {
  if (!isObject(input) || typeof input.found !== "boolean") return null;
  const out: LegacyStateDoc = { found: input.found };
  if (!input.found) {
    if (input.unreadable === true) {
      out.unreadable = true;
      if (input.fresh === true) out.fresh = true;
    }
    return out;
  }
  const filterMode = enumOf(input.filterMode, LEGACY_FILTER_MODES);
  if (filterMode !== undefined) out.filterMode = filterMode;
  const sortMode = enumOf(input.sortMode, LEGACY_SORT_MODES);
  if (sortMode !== undefined) out.sortMode = sortMode;
  const pins = pinPairs(input.pinnedProjects);
  if (pins !== undefined && pins.length > 0) out.pinnedProjects = pins;
  return out;
}

/** How many window activations may ask about an unreadable desktop DB before the
 *  remote window gives up on the import for good. */
export const LEGACY_IMPORT_MAX_ATTEMPTS = 5;

/** After one legacyState answer: is the import finished, and how many fresh
 *  failed reads have been seen so far (persisted across activations)? Done when
 *  the companion actually read the DB (found or definitively none), or after
 *  LEGACY_IMPORT_MAX_ATTEMPTS failed reads. A cached failure (not `fresh`) counts
 *  for nothing, so several activations inside the companion's one-minute re-read
 *  window can't use up the attempts on a single failed read. */
export function legacyImportOutcome(
  doc: LegacyStateDoc,
  unreadableSoFar: number
): { done: boolean; unreadable: number } {
  if (doc.unreadable !== true) return { done: true, unreadable: unreadableSoFar };
  if (doc.fresh !== true) return { done: false, unreadable: unreadableSoFar };
  const unreadable = unreadableSoFar + 1;
  return { done: unreadable >= LEGACY_IMPORT_MAX_ATTEMPTS, unreadable };
}

/** What a remote window copies into its own saved state: only keys it has not set
 *  itself (the user's choices in this install win). */
export function legacyStateUpdates(
  doc: LegacyStateDoc,
  has: (key: string) => boolean
): [key: string, value: unknown][] {
  if (!doc.found) return [];
  const out: [string, unknown][] = [];
  if (doc.filterMode !== undefined && !has("filterMode")) out.push(["filterMode", doc.filterMode]);
  if (doc.sortMode !== undefined && !has("sortMode")) out.push(["sortMode", doc.sortMode]);
  if (doc.pinnedProjects !== undefined && !has("pinnedProjects")) {
    const pins: Record<string, number> = {};
    for (const [cwd, ms] of doc.pinnedProjects) {
      Object.defineProperty(pins, cwd, { value: ms, enumerable: true, writable: true, configurable: true });
    }
    out.push(["pinnedProjects", pins]);
  }
  return out;
}

// ---- once-per-machine claims (command rev 2) -----------------------------------

/** Claim names: lower-case, digits, dot and dash, so a name is always a safe
 *  file name (`key-expired-2026-08`). */
export const CLAIM_NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** Claim `name` once in `dir` by creating `<dir>/<name>` exclusively (O_EXCL): of
 *  any number of racing callers, across processes, exactly one gets true. A name
 *  already claimed gives false; an invalid name or an unusable dir gives undefined
 *  (the caller decides without a claim). Only for dirs on a local filesystem. */
export async function claimOnceFile(dir: string, name: unknown): Promise<boolean | undefined> {
  if (typeof name !== "string" || !CLAIM_NAME_RE.test(name)) return undefined;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), String(Date.now()), { flag: "wx" });
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === "EEXIST" ? false : undefined;
  }
}

export interface CursorEnumSessionWire {
  composerId: string;
  name: string;
  mode: string;
  lastUpdatedAt: number;
  createdAt: number;
  hasUnread: boolean;
  todos: number;
}

export type CursorSessionsResult =
  | { instanceId: string; gen: string; sessions: CursorEnumSessionWire[] }
  | { instanceId: string; gen: string; unchanged: true };

/** A host id is `"h_" + 12 lowercase hex`. This regex also sanitizes the id for
 *  use as a filename in the companion — reject anything that doesn't match. */
export const HOST_ID_RE = /^h_[0-9a-f]{12}$/;

/** Hard caps applied by the validator (plan §4). Bytes for the whole serialized
 *  document; the rest are per-string / per-array element counts. */
export const CAPS = {
  docBytes: 262144,
  sessions: 200,
  cwd: 1024,
  title: 200,
  lastText: 300,
  children: 20,
  childLabel: 120,
  status: 40,
  hostString: 120,
} as const;

export type BridgePlatform = "wsl" | "linux" | "darwin" | "win32";

export interface BridgeHost {
  id: string;
  hostname: string;
  platform: BridgePlatform;
  authorityHint?: string;
  label?: string;
}

export interface BridgeChild {
  kind: "agent" | "workflow" | "task";
  label: string;
  status?: string;
}

export interface BridgeSession {
  id: string;
  tool: "claude" | "cursor" | "codex";
  cwd: string;
  title?: string;
  status: string;
  attention?: boolean;
  /** Runs outside the editor on its host (not an editor terminal/tab, not tmux).
   *  Optional and additive: older peers drop it on validation, so the row simply
   *  shows no mark there. Only ever `true` when present. */
  outside?: true;
  /** Its host can stop it (Stop Session, relayed as a "stop" action): the host
   *  knows where the session runs. Additive like `outside`; an older host never
   *  sends it, so its rows offer no stop. Only ever `true` when present. */
  stoppable?: true;
  ageSec: number;
  lastText?: string;
  children?: BridgeChild[];
}

export interface HostSnapshot {
  v: 1;
  host: BridgeHost;
  publishedAt: number;
  seq: number;
  sessions: BridgeSession[];
  truncated?: boolean;
}

/** The list()/stored form: the bridge stamps a LOCAL-clock receive time on
 *  ingest, which is the only liveness input (remote clocks are never trusted). */
export interface StoredHostSnapshot extends HostSnapshot {
  receivedAt: number;
}

/** Session status literals mirrored verbatim from src/format.ts's status union
 *  (`SessionFlags["status"]`, i.e. discovery.ts `Status`), plus "unknown" as the
 *  coercion target for anything unrecognized. Kept honest by a sync test in
 *  test/bridgeSchema.test.ts — update both together. */
export const KNOWN_SESSION_STATUSES: readonly string[] = ["working", "waiting", "idle", "unknown"];

const PLATFORMS: readonly string[] = ["wsl", "linux", "darwin", "win32"];
const TOOLS: readonly string[] = ["claude", "cursor", "codex"];
const CHILD_KINDS: readonly string[] = ["agent", "workflow", "task"];

// ---- small pure helpers -----------------------------------------------------

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Truncate a known string to a cap. */
function clamp(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) : s;
}

/** Truncate an optional field to a cap; non-strings become undefined (omitted). */
function clampOpt(x: unknown, cap: number): string | undefined {
  return typeof x === "string" ? clamp(x, cap) : undefined;
}

/** A finite number or 0 (rejects NaN/Infinity/non-numbers). */
function finiteOrZero(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

export function validateCursorSessions(input: unknown): CursorSessionsResult | null {
  if (!isObject(input) || typeof input.instanceId !== "string" || input.instanceId.length > 64) return null;
  if (Object.prototype.hasOwnProperty.call(input, "__proto__") || Object.prototype.hasOwnProperty.call(input, "prototype")) return null;
  if (typeof input.gen !== "string" || input.gen.length > 64) return null;
  if (input.unchanged === true) {
    if (input.sessions !== undefined) return null;
    return { instanceId: input.instanceId, gen: input.gen, unchanged: true };
  }
  if (!Array.isArray(input.sessions) || input.sessions.length > 50) return null;
  const sessions: CursorEnumSessionWire[] = [];
  for (const raw of input.sessions) {
    if (!isObject(raw)) return null;
    if (Object.prototype.hasOwnProperty.call(raw, "__proto__") || Object.prototype.hasOwnProperty.call(raw, "prototype")) return null;
    if (typeof raw.composerId !== "string" || raw.composerId.length > 64) return null;
    if (typeof raw.name !== "string" || raw.name.length > 200) return null;
    if (typeof raw.mode !== "string" || raw.mode.length > 32) return null;
    if (typeof raw.lastUpdatedAt !== "number" || !Number.isFinite(raw.lastUpdatedAt)) return null;
    if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return null;
    if (typeof raw.hasUnread !== "boolean") return null;
    if (typeof raw.todos !== "number" || !Number.isFinite(raw.todos) || raw.todos < 0) return null;
    sessions.push({
      composerId: raw.composerId,
      name: raw.name,
      mode: raw.mode,
      lastUpdatedAt: raw.lastUpdatedAt,
      createdAt: raw.createdAt,
      hasUnread: raw.hasUnread,
      todos: raw.todos,
    });
  }
  return { instanceId: input.instanceId, gen: input.gen, sessions };
}

// ---- validator --------------------------------------------------------------

export function validateSnapshot(
  input: unknown,
): { ok: true; doc: HostSnapshot } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: "not an object" };
  if (input.v !== 1) return { ok: false, error: "unsupported version" };

  const hostRaw = input.host;
  if (!isObject(hostRaw)) return { ok: false, error: "host not an object" };

  const id = hostRaw.id;
  if (typeof id !== "string" || !HOST_ID_RE.test(id)) return { ok: false, error: "invalid host.id" };

  const hostname = hostRaw.hostname;
  if (typeof hostname !== "string") return { ok: false, error: "invalid host.hostname" };

  const platform = hostRaw.platform;
  if (typeof platform !== "string" || !PLATFORMS.includes(platform)) {
    return { ok: false, error: "invalid host.platform" };
  }

  const sessionsRaw = input.sessions;
  if (!Array.isArray(sessionsRaw)) return { ok: false, error: "sessions not an array" };

  // Fresh host object — never spread the input (extra-field / proto-pollution safe).
  const host: BridgeHost = {
    id,
    hostname: clamp(hostname, CAPS.hostString),
    platform: platform as BridgePlatform,
  };
  const authorityHint = clampOpt(hostRaw.authorityHint, CAPS.hostString);
  if (authorityHint !== undefined) host.authorityHint = authorityHint;
  const label = clampOpt(hostRaw.label, CAPS.hostString);
  if (label !== undefined) host.label = label;

  // Bound hostile 10k-session documents BEFORE deep-processing each entry.
  let truncated = false;
  let slice: unknown[] = sessionsRaw;
  if (slice.length > CAPS.sessions) {
    slice = slice.slice(0, CAPS.sessions);
    truncated = true;
  }

  const sessions: BridgeSession[] = [];
  for (const raw of slice) {
    const s = sanitizeSession(raw);
    if (s) sessions.push(s);
  }

  const doc: HostSnapshot = {
    v: 1,
    host,
    publishedAt: finiteOrZero(input.publishedAt),
    seq: finiteOrZero(input.seq),
    sessions,
  };
  if (truncated) doc.truncated = true;

  // Final byte budget: drop sessions from the END until the serialized doc fits.
  if (JSON.stringify(doc).length > CAPS.docBytes) {
    while (doc.sessions.length > 0 && JSON.stringify(doc).length > CAPS.docBytes) {
      doc.sessions.pop();
    }
    doc.truncated = true;
  }

  return { ok: true, doc };
}

function sanitizeSession(raw: unknown): BridgeSession | null {
  if (!isObject(raw)) return null;
  if (typeof raw.id !== "string") return null;
  if (typeof raw.tool !== "string" || !TOOLS.includes(raw.tool)) return null;
  if (typeof raw.cwd !== "string") return null;
  if (typeof raw.status !== "string") return null;

  const status = KNOWN_SESSION_STATUSES.includes(raw.status) ? raw.status : "unknown";
  let ageSec = finiteOrZero(raw.ageSec);
  if (ageSec < 0) ageSec = 0;

  const session: BridgeSession = {
    id: clamp(raw.id, CAPS.cwd),
    tool: raw.tool as BridgeSession["tool"],
    cwd: clamp(raw.cwd, CAPS.cwd),
    status,
    ageSec,
  };

  const title = clampOpt(raw.title, CAPS.title);
  if (title !== undefined) session.title = title;
  if (raw.attention === true) session.attention = true;
  if (raw.outside === true) session.outside = true;
  if (raw.stoppable === true) session.stoppable = true;
  const lastText = clampOpt(raw.lastText, CAPS.lastText);
  if (lastText !== undefined) session.lastText = lastText;

  if (Array.isArray(raw.children)) {
    const children: BridgeChild[] = [];
    for (const c of raw.children) {
      if (children.length >= CAPS.children) break;
      const child = sanitizeChild(c);
      if (child) children.push(child);
    }
    if (children.length > 0) session.children = children;
  }

  return session;
}

function sanitizeChild(raw: unknown): BridgeChild | null {
  if (!isObject(raw)) return null;
  if (typeof raw.kind !== "string" || !CHILD_KINDS.includes(raw.kind)) return null;
  if (typeof raw.label !== "string") return null;

  const child: BridgeChild = {
    kind: raw.kind as BridgeChild["kind"],
    label: clamp(raw.label, CAPS.childLabel),
  };
  const status = clampOpt(raw.status, CAPS.status);
  if (status !== undefined) child.status = status;
  return child;
}

// ---- cross-host actions (owner-approved focus, plan follow-up) --------------
// A window can post one action into the bridge targeted at another host; that
// host's main extension polls for its own actions on the refresh tick and, if
// the referenced session is one it currently knows, performs the SAME local
// navigation a local click would. Actions are ingested from remote extension
// hosts, so the validator treats every input as hostile — exactly like the
// snapshot validator: enum-gated kind/tool, HOST_ID_RE-gated targetHostId (it
// becomes a directory name in the companion), length-capped ids, fresh object
// out (never spread), everything else rejected.

/** "focus": show the session; "stop": ask that host's user to confirm stopping
 *  it, then stop it (command rev 5; always carries an id to answer under). */
export const ACTION_KINDS: readonly string[] = ["focus", "stop"];

/** Focus the given session's window/tab on `targetHostId`. `cwd` is a
 *  disambiguation hint only — the receiver resolves a locally-known session by
 *  `sessionId` + `tool` and never fs-touches this string. */
export interface FocusAction {
  v: 1;
  kind: "focus" | "stop";
  targetHostId: string;
  sessionId: string;
  tool: "claude" | "cursor" | "codex";
  cwd: string;
  postedAt: number;
  /** Set by a main that waits for a FocusResult (companion command rev 3). Added
   *  after 0.42.6 without a BRIDGE_V bump: an older validator drops it, so an old
   *  companion or main simply never answers and the clicker times out. */
  id?: string;
}

/** A focus action id: also the result's file name in the companion. */
export const ACTION_ID_RE = /^a_[0-9a-z]{8,32}$/;

export function newActionId(): string {
  let r = "";
  while (r.length < 16) r += Math.random().toString(36).slice(2);
  return "a_" + r.slice(0, 16);
}

/** How long a posting window waits for the acting host's report, and so how long
 *  an action that carries an id stays on offer. Measured by the desktop
 *  companion's clock from when it received the action (one clock both sides talk
 *  to), and handed to the acting window as a duration, so host clocks never meet. */
export const FOCUS_ANSWER_WAIT_MS = 15_000;
/** An action without an id (from a poster older than command rev 3) keeps the
 *  original one-minute limit. */
export const ACTION_TTL_MS = 60_000;

/** The companion's hand-out rule for queued actions, by its own clock: an action
 *  with an id is offered only within FOCUS_ANSWER_WAIT_MS of receipt (after that
 *  its poster has told the user nobody answered), one without within
 *  ACTION_TTL_MS. `remainingMs[id]` is how long the taker has left to act; old
 *  mains ignore it, which is why the companion also stops offering late ones. */
export function actionsToHandOut(
  queued: readonly { action: FocusAction; receivedAt: number }[],
  now: number
): { actions: FocusAction[]; remainingMs: Record<string, number> } {
  const actions: FocusAction[] = [];
  const remainingMs: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const { action, receivedAt } of queued) {
    const age = now - receivedAt;
    if (action.id !== undefined) {
      if (age > FOCUS_ANSWER_WAIT_MS) continue;
      remainingMs[action.id] = Math.max(0, FOCUS_ANSWER_WAIT_MS - Math.max(0, age));
    } else if (age > ACTION_TTL_MS) continue;
    actions.push(action);
  }
  return { actions, remainingMs };
}

// ---- routing actions to the window that has the folder (command rev 4) ------

/** A window's id for routing: random per activation. */
export const WINDOW_TOKEN_RE = /^w_[0-9a-z]{8,32}$/;

export function newWindowToken(): string {
  let r = "";
  while (r.length < 16) r += Math.random().toString(36).slice(2);
  return "w_" + r.slice(0, 16);
}

/** takeActions' second argument (rev 4): who is asking and which folders that
 *  window has open. */
export interface TakeRoute {
  window: string;
  folders: string[];
}

/** At most this many folders per window are kept for routing. */
export const ROUTE_MAX_FOLDERS = 32;
/** Another window that asked within this long counts as open. Windows ask on
 *  every 3 s refresh tick. */
export const WINDOW_FRESH_MS = 10_000;
/** An action whose folder another open window has is held back from the rest
 *  this long, so the owner (asking every 3 s) takes it; after that any window
 *  may take it and hand it over itself. */
export const ROUTE_HOLD_MS = 4_000;
/** A window record's `.tmp` file older than this is left over from a write or
 *  rename that failed, and the next ask deletes it. A younger one may belong to
 *  another window about to rename it, so it is left alone. */
export const ROUTE_TMP_STALE_MS = 60_000;

/** Validate a TakeRoute as hostile input: fresh object, token gated, folders
 *  capped. null = absent or invalid (the caller treats the window as unknown). */
export function validateTakeRoute(input: unknown): TakeRoute | null {
  if (!isObject(input)) return null;
  if (typeof input.window !== "string" || !WINDOW_TOKEN_RE.test(input.window)) return null;
  if (!Array.isArray(input.folders)) return null;
  const folders: string[] = [];
  for (const f of input.folders) {
    if (folders.length >= ROUTE_MAX_FOLDERS) break;
    if (typeof f === "string" && f.length > 0 && f.length <= CAPS.cwd) folders.push(f);
  }
  return { window: input.window, folders };
}

/** Is `cwd` the folder or inside it? Each path is compared in its own style
 *  (`c:\x` or `\\server\x` as Windows, without case; anything else POSIX),
 *  since the companion runs on the desktop while the folders may be a WSL or
 *  SSH window's. */
export function folderHolds(folder: string, cwd: string): boolean {
  return holdDepth(folder, cwd) >= 0;
}

/** How specific `folder` is as a holder of `cwd`: its normalised length, or -1
 *  when it does not hold it. The longest holder is the window to use. */
export function holdDepth(folder: string, cwd: string): number {
  const winStyle = (p: string): boolean => /^[a-zA-Z]:([\\/]|$)|^\\\\/.test(p);
  if (winStyle(folder) !== winStyle(cwd)) return -1;
  const api = winStyle(folder) ? win32 : posix;
  const norm = (p: string): string => (api === win32 ? api.resolve(p).toLowerCase() : api.resolve(p));
  const f = norm(folder);
  const c = norm(cwd);
  if (f === c) return f.length;
  const rel = api.relative(f, c);
  return rel !== "" && !rel.startsWith("..") && !api.isAbsolute(rel) ? f.length : -1;
}

/** Should the asking window take this action now? Yes when its innermost folder
 *  holding the action's cwd is at least as deep as any other open window's; no
 *  while another open window holds it deeper (or the asker holds it not at all)
 *  and the action is younger than ROUTE_HOLD_MS; after that yes (first come, as
 *  before rev 4). `taker` undefined = an older main that sent no folders. */
export function routeAction(
  cwd: string,
  ageMs: number,
  taker: readonly string[] | undefined,
  others: readonly (readonly string[])[]
): boolean {
  const depth = (fs: readonly string[]): number => fs.reduce((m, f) => Math.max(m, holdDepth(f, cwd)), -1);
  const mine = taker !== undefined ? depth(taker) : -1;
  const theirs = others.reduce((m, fs) => Math.max(m, depth(fs)), -1);
  if (mine >= 0 && mine >= theirs) return true;
  if (ageMs >= ROUTE_HOLD_MS) return true;
  return theirs < 0;
}

/** The companion's takeActions over its stores (fs only, so it is tested
 *  directly): `actionsDir/<hostId>/*.json` holds the queued actions,
 *  `windowsDir/<hostId>/<window>.json` the folders of each window that asked
 *  with a route (rev 4), refreshed on every ask. Expired actions are deleted;
 *  an action routeAction keeps for another window stays queued; a taken one is
 *  claimed by an atomic rename first, so two windows asking at once never both
 *  get it. hostId must already be HOST_ID_RE-gated. */
export async function takeActionsFromDir(
  actionsDir: string,
  windowsDir: string,
  hostId: string,
  rawRoute: unknown,
  now: number = Date.now()
): Promise<{ actions: FocusAction[]; remainingMs: Record<string, number> }> {
  const route = validateTakeRoute(rawRoute);
  const winDir = join(windowsDir, hostId);
  const others: string[][] = [];
  if (route !== null) {
    try {
      await mkdir(winDir, { recursive: true });
    } catch {
      // the write below fails too and is handled there
    }
    const own = join(winDir, `${route.window}.json`);
    const tmp = `${own}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ folders: route.folders }), "utf8");
      await rename(tmp, own);
    } catch {
      // routing is best effort: without the record this window is just unknown.
      // The temp file must not stay behind (a rename that fails on Windows, say
      // while another window reads the record, left one per failed ask).
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
  try {
    for (const name of await readdir(winDir)) {
      if (name.endsWith(".tmp")) {
        // Left over from a failed write or rename, in this window or another.
        // Only stale ones go: a fresh one may be renamed by its window any moment.
        try {
          if (now - (await stat(join(winDir, name))).mtimeMs > ROUTE_TMP_STALE_MS) await rm(join(winDir, name), { force: true });
        } catch {
          // renamed or removed meanwhile
        }
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const full = join(winDir, name);
      if (route !== null && name === `${route.window}.json`) continue;
      try {
        const age = now - (await stat(full)).mtimeMs;
        if (age > 60 * WINDOW_FRESH_MS) await rm(full, { force: true });
        if (age > WINDOW_FRESH_MS) continue;
        const doc: unknown = JSON.parse(await readFile(full, "utf8"));
        const r = isObject(doc) ? validateTakeRoute({ window: "w_00000000", folders: doc.folders }) : null;
        if (r !== null) others.push(r.folders);
      } catch {
        // vanished or half-written: skip
      }
    }
  } catch {
    // no window has asked with a route yet
  }
  const dir = join(actionsDir, hostId);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort(); // chronological (postedAt prefix)
  } catch {
    return { actions: [], remainingMs: {} };
  }
  const queued: { action: FocusAction; receivedAt: number }[] = [];
  for (const name of names) {
    const full = join(dir, name);
    let text: string;
    let receivedAt: number;
    try {
      // The file's mtime is when THIS companion stored it: its own clock,
      // never the posting host's.
      receivedAt = (await stat(full)).mtimeMs;
      text = await readFile(full, "utf8");
    } catch {
      continue; // claimed by another window meanwhile
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined; // junk: deleted below
    }
    const res = validateAction(parsed);
    if (!res.ok || actionsToHandOut([{ action: res.action, receivedAt }], now).actions.length === 0) {
      await rm(full, { force: true }).catch(() => undefined); // invalid or expired: nobody gets it
      continue;
    }
    if (!routeAction(res.action.cwd, now - receivedAt, route?.folders, others)) continue;
    const claimed = `${full}.${Math.random().toString(36).slice(2)}.taken`;
    try {
      await rename(full, claimed);
    } catch {
      continue; // another window claimed it first
    }
    await rm(claimed, { force: true }).catch(() => undefined);
    queued.push({ action: res.action, receivedAt });
  }
  return actionsToHandOut(queued, now);
}

/** What the host that took a focus action did with it. `shown` = the session's tab
 *  or terminal was shown (`detail` notes what was not done); `handed-off` = passed
 *  to the window there that has its folder open, which was raised, but nothing
 *  confirms it showed the session; `preview` = no window shows it, so only its
 *  last activity was shown there; `outside` = it runs outside the editor, so
 *  there is nothing to switch to; `not-found` = that host no longer knows the
 *  session; `failed` = it tried and could not (`detail` says why).
 *  A stop action (command rev 5) is answered first with `asking` (the
 *  confirmation is up there), then under the same id with `stopped`,
 *  `cancelled`, `gone` (it had already stopped) or `not-stopped` (`detail` says
 *  why). */
export const FOCUS_OUTCOMES = ["shown", "handed-off", "preview", "outside", "not-found", "failed", "asking", "stopped", "cancelled", "gone", "not-stopped"] as const;
export type FocusOutcome = (typeof FOCUS_OUTCOMES)[number];

export interface FocusResult {
  v: 1;
  id: string;
  outcome: FocusOutcome;
  detail?: string;
  at: number;
}

const FOCUS_DETAIL_CAP = 300;

/** Validate a focus result (hostile input, fresh object out). */
export function validateFocusResult(input: unknown): FocusResult | null {
  if (!isObject(input) || input.v !== 1) return null;
  const { id, outcome, at } = input;
  if (typeof id !== "string" || !ACTION_ID_RE.test(id)) return null;
  if (typeof outcome !== "string" || !(FOCUS_OUTCOMES as readonly string[]).includes(outcome)) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const out: FocusResult = { v: 1, id, outcome: outcome as FocusOutcome, at };
  if (typeof input.detail === "string" && input.detail.length > 0) out.detail = clamp(input.detail, FOCUS_DETAIL_CAP);
  return out;
}

/** Take the result for one action id from the companion's results folder, once:
 *  the file is claimed by an atomic rename before it is read, so a result
 *  written meanwhile under the same id (a stop's outcome after its "asking")
 *  lands as a new file and is not deleted unread. `id` must be ACTION_ID_RE-
 *  gated. Undefined = no result yet (or not a valid one). */
export async function takeResultFromDir(resultsDir: string, id: string): Promise<FocusResult | undefined> {
  const full = join(resultsDir, `${id}.json`);
  const claimed = `${full}.${Math.random().toString(36).slice(2)}.taken`;
  try {
    await rename(full, claimed);
  } catch {
    return undefined; // none yet, or another window took it
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(claimed, "utf8"));
  } catch {
    parsed = undefined;
  } finally {
    await rm(claimed, { force: true }).catch(() => undefined);
  }
  const r = validateFocusResult(parsed);
  return r !== null && r.id === id ? r : undefined;
}

export function validateAction(
  input: unknown,
): { ok: true; action: FocusAction } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: "not an object" };
  if (input.v !== 1) return { ok: false, error: "unsupported version" };

  const kind = input.kind;
  if (typeof kind !== "string" || !ACTION_KINDS.includes(kind)) return { ok: false, error: "invalid kind" };

  const targetHostId = input.targetHostId;
  // Regex-gated BEFORE any use — the companion turns this into a directory name.
  if (typeof targetHostId !== "string" || !HOST_ID_RE.test(targetHostId)) {
    return { ok: false, error: "invalid targetHostId" };
  }

  const tool = input.tool;
  if (typeof tool !== "string" || !TOOLS.includes(tool)) return { ok: false, error: "invalid tool" };

  // Session id / cwd are length-capped: reject the adversarial multi-MB string
  // outright (a real id is a short uuid; an over-cap id would never match a
  // local session anyway, so nothing legitimate is lost).
  const sessionId = input.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > CAPS.cwd) {
    return { ok: false, error: "invalid sessionId" };
  }
  const cwd = input.cwd;
  if (typeof cwd !== "string" || cwd.length > CAPS.cwd) return { ok: false, error: "invalid cwd" };

  const postedAt = input.postedAt;
  if (typeof postedAt !== "number" || !Number.isFinite(postedAt)) return { ok: false, error: "invalid postedAt" };

  // A stop is always answered: one without a valid id is refused.
  if (kind === "stop" && (typeof input.id !== "string" || !ACTION_ID_RE.test(input.id))) return { ok: false, error: "stop without id" };

  // Fresh object — never spread the input (extra-field / proto-pollution safe).
  const action: FocusAction = {
    v: 1,
    kind: kind === "stop" ? "stop" : "focus",
    targetHostId,
    sessionId,
    tool: tool as FocusAction["tool"],
    cwd,
    postedAt,
  };
  // Optional; a malformed id is dropped (the action still runs, unanswered).
  if (typeof input.id === "string" && ACTION_ID_RE.test(input.id)) action.id = input.id;
  return { ok: true, action };
}

// ---- companion license authority --------------------------------------------
// The bridge companion is the LOCAL (ui) host — persistent across window reloads
// and the same for every remote window on this machine — so it owns the canonical
// trial origin. `sessionDeckBridge.license` returns this document; a remote
// main extension prefers the companion's (older) trialStart so a trial can't be
// restarted by reinstalling into a fresh remote. `key` is the synced-settings
// license key when the companion can read it (a fallback for remotes whose own
// Settings Sync hasn't carried it). Validated like every other bridge payload:
// hostile input, fresh object out, capped strings.

/** Companion license/trial authority payload. */
export interface BridgeLicense {
  /** The license key from the companion's settings, when present/readable. */
  key?: string;
  /** The companion's canonical trial-start instant (ms epoch, its local clock). */
  trialStart: number;
}

/** Validate a `sessionDeckBridge.license` result. `trialStart` must be a finite
 *  number; `key` is an optional, length-capped string. Fresh object out — never
 *  spread. Returns null on any structural violation (caller degrades to local). */
export function validateBridgeLicense(input: unknown): BridgeLicense | null {
  if (!isObject(input)) return null;
  if (typeof input.trialStart !== "number" || !Number.isFinite(input.trialStart)) return null;
  const out: BridgeLicense = { trialStart: input.trialStart };
  if (typeof input.key === "string" && input.key.length > 0) out.key = clamp(input.key, CAPS.cwd);
  return out;
}

// ---- display ----------------------------------------------------------------

/** Host label precedence (plan §3): user `label` → prettified `authorityHint`
 *  (strip the `<scheme>+` prefix: `ssh-remote+devbox` → `devbox`,
 *  `wsl+Ubuntu-24.04` → `Ubuntu-24.04`) → `` `${hostname} (${platform})` ``. */
export function hostDisplayLabel(host: BridgeHost): string {
  if (host.label && host.label.length > 0) return host.label;

  const hint = host.authorityHint;
  if (hint && hint.length > 0) {
    const plus = hint.indexOf("+");
    const pretty = plus >= 0 ? hint.slice(plus + 1) : hint;
    if (pretty.length > 0) return pretty;
  }

  return `${host.hostname} (${host.platform})`;
}
