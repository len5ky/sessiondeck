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
// The validator treats every input as hostile (it ingests documents produced by
// remote extension hosts). Structural violations are rejected; everything else
// is sanitized into a freshly built object — the input is never spread or
// mutated, so extra fields and prototype-pollution keys can never leak through.

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
export async function migrateLegacySettings(config: SettingsMigrationPort): Promise<void> {
  for (const [oldKey, newKey] of SETTING_MIGRATIONS) {
    const oldValue = config.inspect(oldKey);
    if (oldValue === undefined) continue;
    const newValue = config.inspect(newKey);
    if (newValue?.globalValue !== undefined || newValue?.workspaceValue !== undefined) continue;
    if (oldValue.globalValue !== undefined) await config.update(newKey, oldValue.globalValue, "global");
    if (oldValue.workspaceValue !== undefined) await config.update(newKey, oldValue.workspaceValue, "workspace");
  }
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

export interface BridgeHelloResult {
  v: 1;
  version: string;
  instanceId?: string;
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

/** The only action kind in this release. */
export const ACTION_KINDS: readonly string[] = ["focus"];

/** Focus the given session's window/tab on `targetHostId`. `cwd` is a
 *  disambiguation hint only — the receiver resolves a locally-known session by
 *  `sessionId` + `tool` and never fs-touches this string. */
export interface FocusAction {
  v: 1;
  kind: "focus";
  targetHostId: string;
  sessionId: string;
  tool: "claude" | "cursor" | "codex";
  cwd: string;
  postedAt: number;
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

  // Fresh object — never spread the input (extra-field / proto-pollution safe).
  const action: FocusAction = {
    v: 1,
    kind: "focus",
    targetHostId,
    sessionId,
    tool: tool as FocusAction["tool"],
    cwd,
    postedAt,
  };
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
