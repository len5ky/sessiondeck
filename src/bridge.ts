// Cross-host command-bridge CLIENT (plan §2/§4/§6). vscode-dependent by design:
// this is the main extension's half of the bridge — it publishes this host's
// snapshot and fetches every host via cross-ext-host `executeCommand` calls to
// the invisible `sessiondeck-bridge` companion. All companion input is
// treated as untrusted display data: never executed, fs-touched, or shell-
// interpolated here; `receivedAt` (companion's local clock) is the only liveness
// input. When the companion is absent everything degrades to single-host silently.
import * as vscode from "vscode";

import {
  BridgeChild,
  BridgeLicense,
  BridgeSession,
  CAPS,
  FocusAction,
  HostSnapshot,
  StoredHostSnapshot,
  CursorEnumSessionWire,
  hostDisplayLabel,
  validateAction,
  validateBridgeLicense,
  validateCursorSessions,
} from "./bridgeSchema";
import { HostIdentity } from "./hostid";
import { PanelChild, PanelModel, publishableTitle, publishableAttention } from "./format";

const HELLO = "sessionDeckBridge.hello";
const PUBLISH = "sessionDeckBridge.publish";
const LIST = "sessionDeckBridge.list";
const POST_ACTION = "sessionDeckBridge.postAction";
const TAKE_ACTIONS = "sessionDeckBridge.takeActions";
const CURSOR_SESSIONS = "sessionDeckBridge.cursorSessions";
const LICENSE = "sessionDeckBridge.license";

const HEARTBEAT_MS = 15000; // republish an unchanged snapshot at least this often
const MIN_INTERVAL_MS = 3000; // never publish twice within this window, ever
const STALE_MS = 24 * 60 * 60 * 1000; // hosts unseen longer than this are hidden
const PROBE_BUDGET_MS = 60000; // availability retry window after activation
const LICENSE_TTL_MS = 60000; // re-fetch the companion's license at most this often

interface BridgeClientOptions {
  /** This host's id, so `remoteHosts()` can exclude our own snapshot. */
  selfHostId: string | undefined;
  /** Our extension version, for hello() minor-skew detection (console only). */
  ourVersion: string;
  /** Master toggle read once at construction: when it returns false the hello
   *  probe never starts, so `crossHost: false` is truly zero-work (a flip back to
   *  true takes a reload — no config watcher). */
  enabled?: () => boolean;
  /** Fired once if the companion never answers within the probe window. */
  onInitialProbeFailed?: () => void;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Minor version from an "x.y.z" string, or undefined when unparseable. */
function minorOf(version: string): number | undefined {
  const parts = version.split(".");
  const minor = parts.length > 1 ? Number(parts[1]) : NaN;
  return Number.isFinite(minor) ? minor : undefined;
}

/** A StoredHostSnapshot as returned across the command boundary (plain JSON) —
 *  validate the load-bearing fields before trusting an entry from list(). */
function isStored(x: unknown): x is StoredHostSnapshot {
  return (
    isObject(x) &&
    isObject(x.host) &&
    typeof (x.host as Record<string, unknown>).id === "string" &&
    typeof x.receivedAt === "number" &&
    Array.isArray(x.sessions)
  );
}

export class BridgeClient {
  private _available = false;
  private probeFinished = false;
  private disposed = false;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;

  private seq = 0;
  private lastPublishAt = 0;
  private lastPublishKey = "";

  /** Companion version from the last successful hello(), and whether it minor-skews
   *  from ours — surfaced read-only by the Setup Doctor (console-only otherwise). */
  private _companionVersion: string | undefined;
  private _versionSkew = false;
  private companionInstanceId: string | undefined;
  private enumSinceGen = "";
  private enumLastInstanceId: string | undefined;
  private enumCache: CursorEnumSessionWire[] = [];
  private _cursorEnumAvailable = false;

  private cache: StoredHostSnapshot[] = [];

  private _license: BridgeLicense | undefined;
  private licenseFetchedAt = 0;

  constructor(private readonly opts: BridgeClientOptions) {
    // Skip all probe work when cross-host is disabled — no hello backoff loop runs.
    if (opts.enabled?.() ?? true) this.startProbe();
  }

  /** True once the initial hello() probe has finished, found or not. */
  get probeSettled(): boolean {
    return this.probeFinished;
  }

  /** True while the companion is answering; false = degraded (single-host). */
  get available(): boolean {
    return this._available;
  }

  /** Companion version from the last successful hello() (undefined until one). */
  get companionVersion(): string | undefined {
    return this._companionVersion;
  }

  /** Whether the companion minor-skews from our version (tolerated; doctor-only). */
  get versionSkew(): boolean {
    return this._versionSkew;
  }

  get cursorEnumAvailable(): boolean { return this._cursorEnumAvailable; }
  get cursorEnumGen(): string { return this.enumSinceGen; }
  get cursorEnumSessions(): readonly CursorEnumSessionWire[] { return this.enumCache; }

  dispose(): void {
    this.disposed = true;
    if (this.probeTimer !== undefined) clearTimeout(this.probeTimer);
  }

  // ---- availability probe ---------------------------------------------------

  /** Retry hello() with 1s,2s,4s… backoff, capped at a 60s total window. On the
   *  first success we flip available; if the window elapses with no answer we
   *  settle degraded and fire the one-time install-prompt callback. */
  private startProbe(): void {
    let elapsed = 0;
    let delay = 1000;
    const attempt = async (): Promise<void> => {
      if (this.disposed) return;
      if (await this.tryHello()) {
        this.settleProbe(true);
        return;
      }
      if (elapsed + delay >= PROBE_BUDGET_MS) {
        this.settleProbe(false);
        return;
      }
      const wait = delay;
      this.probeTimer = setTimeout(() => {
        elapsed += wait;
        delay = Math.min(delay * 2, PROBE_BUDGET_MS - elapsed);
        void attempt();
      }, wait);
    };
    void attempt();
  }

  private settleProbe(found: boolean): void {
    if (this.probeFinished) return;
    this.probeFinished = true;
    if (!found && !this.disposed) this.opts.onInitialProbeFailed?.();
  }

  /** One hello() call: true when the companion answers with a valid handshake. */
  private async tryHello(): Promise<boolean> {
    try {
      const res: unknown = await vscode.commands.executeCommand(HELLO);
      if (isObject(res) && res.v === 1 && typeof res.version === "string") {
        this._available = true;
        this._companionVersion = res.version;
        this.companionInstanceId = typeof res.instanceId === "string" ? res.instanceId : undefined;
        this.checkSkew(res.version);
        return true;
      }
      return false;
    } catch {
      this._available = false;
      return false;
    }
  }

  private checkSkew(theirs: string): void {
    const a = minorOf(this.opts.ourVersion);
    const b = minorOf(theirs);
    this._versionSkew = a !== undefined && b !== undefined && a !== b;
    if (a !== undefined && b !== undefined && a !== b) {
      // Version skew is tolerated (still proceed); log only, never surface UI.
      console.log(`[sessiondeck] bridge version skew: main ${this.opts.ourVersion} vs companion ${theirs}`);
    }
  }

  // ---- publish --------------------------------------------------------------

  /** Fire-and-forget publish, throttled: skip when the snapshot is unchanged and
   *  the last publish was <15s ago (the 15s heartbeat republishes regardless of
   *  change), and never publish twice within 3s. Any failure marks degraded. */
  async publish(snapshot: HostSnapshot): Promise<void> {
    const now = Date.now();
    if (now - this.lastPublishAt < MIN_INTERVAL_MS) return; // hard 3s floor
    const key = stableKey(snapshot);
    if (key === this.lastPublishKey && now - this.lastPublishAt < HEARTBEAT_MS) return;

    this.seq += 1;
    const doc: HostSnapshot = { ...snapshot, seq: this.seq, publishedAt: now };
    try {
      // A `{ ok: false }` result still means the companion is present — the call
      // resolving (not throwing) is what proves availability.
      await vscode.commands.executeCommand(PUBLISH, doc);
      this._available = true;
      this.lastPublishAt = now;
      this.lastPublishKey = key;
    } catch {
      this._available = false;
    }
  }

  /** True when the 15s heartbeat is due (or nothing has been published yet), i.e.
   *  publish() would republish even an unchanged snapshot to refresh the receiver's
   *  liveness clock. refresh() reads this so a quiet tick still builds+publishes on
   *  the heartbeat boundary — keeping peers inside their live window — while skipping
   *  the build on the quiet ticks in between. Mirrors the HEARTBEAT_MS branch in
   *  publish(); a successful publish resets lastPublishAt, so this goes false for the
   *  next 15s, and a failed one leaves availability false (bridgePublishing gates it). */
  publishDue(): boolean {
    return Date.now() - this.lastPublishAt >= HEARTBEAT_MS;
  }

  // ---- fetch ----------------------------------------------------------------

  /** Pull the desktop Cursor enumeration feed. Invalid/old companions preserve
   * the last-good cache; a companion activation change forces one full re-pull. */
  async cursorSessions(): Promise<CursorEnumSessionWire[]> {
    if (!this._available) return this.enumCache;
    try {
      let validated = validateCursorSessions(
        await vscode.commands.executeCommand(CURSOR_SESSIONS, { sinceGen: this.enumSinceGen }),
      );
      if (validated === null) return this.enumCache;
      const expectedInstanceId = this.enumLastInstanceId ?? this.companionInstanceId;
      if (expectedInstanceId !== undefined && validated.instanceId !== expectedInstanceId) {
        this.enumSinceGen = "";
        validated = validateCursorSessions(
          await vscode.commands.executeCommand(CURSOR_SESSIONS, { sinceGen: "" }),
        );
        if (validated === null) return this.enumCache;
      }
      this.enumLastInstanceId = validated.instanceId;
      this.companionInstanceId = validated.instanceId;
      if (validated.gen !== "") this._cursorEnumAvailable = true;
      if ("unchanged" in validated) return this.enumCache;
      this.enumCache = validated.sessions;
      this.enumSinceGen = validated.gen;
      if (validated.sessions.length > 0) this._cursorEnumAvailable = true;
      return this.enumCache;
    } catch {
      return this.enumCache;
    }
  }

  /** Pull every host's snapshot; on success replace the cache and mark available,
   *  on failure keep the last-good cache and mark unavailable. Also the recovery
   *  probe after the initial window — a success here flips degraded back to live. */
  async fetchNow(): Promise<void> {
    try {
      const res: unknown = await vscode.commands.executeCommand(LIST);
      if (Array.isArray(res)) {
        this.cache = res.filter(isStored);
        this._available = true;
      }
    } catch {
      this._available = false; // keep the cache untouched
    }
  }

  // ---- companion license authority ------------------------------------------

  /** Last companion license/trial document fetched (no network call). */
  get licenseCached(): BridgeLicense | undefined {
    return this._license;
  }

  /** Fetch the companion's canonical trial-start (+ synced key when readable),
   *  cached for LICENSE_TTL_MS so the 3s tick doesn't re-probe every time. Returns
   *  undefined only until the first successful fetch; a degraded/absent companion
   *  or one too old to have the command keeps the last-good value and NEVER flips
   *  availability (a missing command still means the companion is present). The
   *  caller merges this with prefer-older semantics — it can only move the trial
   *  origin EARLIER, never restart it. */
  async license(): Promise<BridgeLicense | undefined> {
    if (!this._available) return this._license;
    const now = Date.now();
    if (this._license !== undefined && now - this.licenseFetchedAt < LICENSE_TTL_MS) {
      return this._license;
    }
    try {
      const res: unknown = await vscode.commands.executeCommand(LICENSE);
      const v = validateBridgeLicense(res);
      if (v !== null) {
        this._license = v;
        this.licenseFetchedAt = now;
      }
      return this._license;
    } catch {
      return this._license; // old companion (no license command) or transient
    }
  }

  // ---- cross-host actions (owner-approved focus) ----------------------------

  /** Post a focus action targeted at another host. Returns true only when the
   *  companion accepted it (`{ ok: true }`). A companion too old to have
   *  postAction makes executeCommand throw "command not found" — caught here and
   *  reported as `false` WITHOUT flipping availability (the companion IS present,
   *  it just predates this feature), so the caller can fall back to the preview.
   *  As a belt-and-suspenders the payload is validated locally before sending. */
  async postFocus(a: { targetHostId: string; sessionId: string; tool: FocusAction["tool"]; cwd: string }): Promise<boolean> {
    if (!this._available) return false;
    const payload: FocusAction = {
      v: 1,
      kind: "focus",
      targetHostId: a.targetHostId,
      sessionId: a.sessionId,
      tool: a.tool,
      cwd: a.cwd,
      postedAt: Date.now(),
    };
    if (!validateAction(payload).ok) return false;
    try {
      const res: unknown = await vscode.commands.executeCommand(POST_ACTION, payload);
      return isObject(res) && res.ok === true;
    } catch {
      return false; // old companion (no postAction) or transient failure — degrade.
    }
  }

  /** Consume the focus actions this host should act on (the companion deletes
   *  them on read). Every returned action is re-validated locally and its
   *  targetHostId is confirmed to be us, so a compromised store can't redirect us
   *  to a session we weren't asked to touch. Old companion / failure → []. */
  async takeActions(selfHostId: string): Promise<FocusAction[]> {
    if (!this._available) return [];
    try {
      const res: unknown = await vscode.commands.executeCommand(TAKE_ACTIONS, selfHostId);
      if (!isObject(res) || res.ok !== true || !Array.isArray(res.actions)) return [];
      const out: FocusAction[] = [];
      for (const raw of res.actions) {
        const v = validateAction(raw);
        if (v.ok && v.action.targetHostId === selfHostId) out.push(v.action);
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Remote hosts to render: from the cached list, drop our own host and any host
   *  unseen for >24h, sorted by display label (plan §6). */
  remoteHosts(): StoredHostSnapshot[] {
    const now = Date.now();
    const self = this.opts.selfHostId;
    return this.cache
      .filter((h) => h.host.id !== self && now - h.receivedAt <= STALE_MS)
      .sort((a, b) => hostDisplayLabel(a.host).localeCompare(hostDisplayLabel(b.host)));
  }
}

/** Stable identity of a snapshot for throttling: everything except the two
 *  per-publish fields (`publishedAt`, `seq`) that change on every heartbeat. */
function stableKey(s: HostSnapshot): string {
  return JSON.stringify({ v: s.v, host: s.host, sessions: s.sessions, truncated: s.truncated });
}

// ---- snapshot builder -------------------------------------------------------
// Derived SOLELY from panelModel() — the same distillation the panel renders, so
// no transcript body / credential ever enters a snapshot (plan §8.5). status/age/
// lastText come from the model's publisher-only raw fields (plan §9): the source
// row values threaded through by tree.ts, so nothing here reverse-parses a
// rendered string. They stay display-only downstream (staleness uses the bridge's
// own receivedAt), so a best-effort read is correct here.

/** Flatten panel activity-tree children into the flat BridgeChild list: top-level
 *  workflows/agents/tasks, plus a workflow's nested agents, bounded by the cap. */
function bridgeChildren(children: PanelChild[]): BridgeChild[] {
  const out: BridgeChild[] = [];
  const push = (c: PanelChild): void => {
    if (out.length >= CAPS.children) return;
    const child: BridgeChild = { kind: c.kind, label: c.label };
    const status = childStatus(c);
    if (status !== undefined) child.status = status;
    out.push(child);
  };
  for (const c of children) {
    push(c);
    if (c.children !== undefined) for (const g of c.children) push(g);
  }
  return out;
}

function childStatus(c: PanelChild): string | undefined {
  if (c.kind === "task") return c.description !== "" ? c.description : undefined;
  return c.spin ? "running" : "done";
}

/** Build this host's snapshot from the panel model. `seq`/`publishedAt` are
 *  placeholders — BridgeClient.publish() stamps the real values per publish. */
export function buildSnapshot(model: PanelModel, identity: HostIdentity): HostSnapshot {
  const includeLastText = vscode.workspace
    .getConfiguration("sessionDeck")
    .get<boolean>("publishLastText", true);
  const authorityHint = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? "";

  const sessions: BridgeSession[] = [];
  for (const project of model.projects) {
    for (const s of project.sessions) {
      if (sessions.length >= CAPS.sessions) break;
      // A free-tier LOCKED session is excluded LOCALLY (locked placeholder, no
      // supervision) — so it is not published cross-host either: a second window on
      // another host must not see data this host has locked. (Was: dimmed rows
      // published in full with attention stripped; the locked mechanic supersedes it.)
      if (s.locked === true) continue;
      const session: BridgeSession = {
        id: s.sessionId,
        tool: "claude",
        cwd: project.cwd,
        // A prompt-derived title is user-authored conversation content (same class
        // as lastText); publishableTitle keeps it off the wire unless publishLastText
        // is on, restoring the non-prompt stub otherwise (see format.ts).
        title: publishableTitle(s, includeLastText),
        status: s.rawStatus ?? "idle",
        ageSec: s.rawAgeSec ?? 0,
      };
      // Free-tier over-limit rows publish IN FULL (title/status/lastText — visibility
      // is never gated), but their attention is stripped at the publish seam (pure
      // publishableAttention) so a second window on another host can't alert on a
      // session this host has excluded from supervision.
      if (publishableAttention(s)) session.attention = true;
      if (includeLastText && s.rawLastText !== undefined && s.rawLastText !== "") {
        session.lastText = s.rawLastText; // validator clamps to CAPS.lastText on ingest
      }
      const children = bridgeChildren(s.children);
      if (children.length > 0) session.children = children;
      sessions.push(session);
    }
    for (const c of project.cursors) {
      if (sessions.length >= CAPS.sessions) break;
      if (c.locked === true) continue; // locked: not published cross-host (see above)
      sessions.push({
        id: c.chatId,
        tool: "cursor",
        cwd: project.cwd,
        title: c.title,
        status: c.spin ? "working" : "idle",
        ageSec: c.rawAgeSec ?? 0,
      });
    }
    for (const c of project.codexes) {
      if (sessions.length >= CAPS.sessions) break;
      if (c.locked === true) continue; // locked: not published cross-host (see above)
      sessions.push({
        id: c.id,
        tool: "codex",
        cwd: project.cwd,
        title: c.title,
        status: c.spin ? "working" : "idle",
        ageSec: c.rawAgeSec ?? 0,
      });
    }
  }

  const host: HostSnapshot["host"] = {
    id: identity.id,
    hostname: identity.hostname,
    platform: identity.platform,
  };
  if (authorityHint !== "") host.authorityHint = authorityHint;
  if (identity.label !== undefined) host.label = identity.label;

  return { v: 1, host, publishedAt: 0, seq: 0, sessions };
}
