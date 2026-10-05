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
  validateLegacyState,
  helloRev,
  newActionId,
  FOCUS_ANSWER_WAIT_MS,
  ROUTE_MAX_FOLDERS,
  newWindowToken,
  type TakeRoute,
  validateFocusResult,
  type FocusResult,
  type LegacyStateDoc,
} from "./bridgeSchema";
import { HostIdentity } from "./hostid";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PanelChild, PanelModel, publishableTitle, publishableAttention } from "./format";

export { FOCUS_ANSWER_WAIT_MS };

const HELLO = "sessionDeckBridge.hello";
const PUBLISH = "sessionDeckBridge.publish";
const LIST = "sessionDeckBridge.list";
const POST_ACTION = "sessionDeckBridge.postAction";
const TAKE_ACTIONS = "sessionDeckBridge.takeActions";
const CURSOR_SESSIONS = "sessionDeckBridge.cursorSessions";
const LICENSE = "sessionDeckBridge.license";
const LEGACY_STATE = "sessionDeckBridge.legacyState"; // command rev 2
const CLAIM_ONCE = "sessionDeckBridge.claimOnce"; // command rev 2
const POST_FOCUS_RESULT = "sessionDeckBridge.postFocusResult"; // command rev 3
const TAKE_FOCUS_RESULT = "sessionDeckBridge.takeFocusResult"; // command rev 3

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
  private probeStarted = false;
  private settleWaiters: (() => void)[] = [];
  private disposed = false;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  /** This window's id for action routing (command rev 4). */
  private readonly windowToken = newWindowToken();

  private seq = 0;
  private lastPublishAt = 0;
  private lastPublishKey = "";

  /** Companion version from the last successful hello(), and whether it minor-skews
   *  from ours — surfaced read-only by the Setup Doctor (console-only otherwise). */
  private _companionVersion: string | undefined;
  /** The companion's command-set revision (helloRev; 1 = 0.42.4 and older). */
  private _rev = 1;
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
    if (opts.enabled?.() ?? true) {
      this.probeStarted = true;
      this.startProbe();
    }
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

  private releaseSettleWaiters(): void {
    const ws = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of ws) w();
  }

  dispose(): void {
    this.disposed = true;
    this.releaseSettleWaiters();
    if (this.probeTimer !== undefined) clearTimeout(this.probeTimer);
  }

  // ---- availability probe ---------------------------------------------------

  /** Retry hello() with 1s,2s,4s… backoff inside a 60s budget (attempts at 0, 1,
   *  3, 7, 15 and 31 s, so with no answer it settles at about 31 s). On the
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
    this.releaseSettleWaiters();
    if (!found && !this.disposed) this.opts.onInitialProbeFailed?.();
  }

  /** One hello() call: true when the companion answers with a valid handshake. */
  private async tryHello(): Promise<boolean> {
    try {
      const res: unknown = await vscode.commands.executeCommand(HELLO);
      if (isObject(res) && res.v === 1 && typeof res.version === "string") {
        this._available = true;
        this._companionVersion = res.version;
        this._rev = helloRev(res);
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
   *  change), and never publish twice within 3s. `force` (this window just took
   *  the publisher lease over: another window may have written the host's
   *  snapshot since our last publish) skips both. Any failure marks degraded. */
  async publish(snapshot: HostSnapshot, force = false): Promise<void> {
    const now = Date.now();
    const key = stableKey(snapshot);
    if (!force) {
      if (now - this.lastPublishAt < MIN_INTERVAL_MS) return; // hard 3s floor
      if (key === this.lastPublishKey && now - this.lastPublishAt < HEARTBEAT_MS) return;
    }

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

  // ---- command rev 2: former-extension state + once-per-machine claims -------

  /** The companion's command-set revision; 1 until a hello reports more. */
  get commandRev(): number {
    return this._rev;
  }

  /** The former extension's pins/filter/sort as the desktop holds them. Undefined
   *  when it can't be asked: companion absent, or older than rev 2 (an old
   *  companion is never sent the command), or an invalid answer. */
  async legacyState(): Promise<LegacyStateDoc | undefined> {
    if (!this._available || this._rev < 2) return undefined;
    try {
      return validateLegacyState(await vscode.commands.executeCommand(LEGACY_STATE)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** True once this window's client is disposed (the window is closing). */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** claimOnce, but first wait for the initial hello probe to finish (it gives up
   *  by itself about 31 s after activation when no hello answers: retries at 0, 1,
   *  3, 7, 15 and 31 s, then the next delay would pass PROBE_BUDGET_MS), so a
   *  window that has not heard from its companion yet does not fall back to a
   *  host-local claim while the companion is still about to answer. Returns at
   *  once when the probe never started (cross-host off) or has already finished.
   *  "disposed" when the window closed first: the caller must then do nothing. */
  async claimOnceWhenSettled(name: string): Promise<boolean | undefined | "disposed"> {
    if (this.probeStarted && !this.probeFinished && !this.disposed) {
      await new Promise<void>((resolve) => this.settleWaiters.push(resolve));
    }
    if (this.disposed) return "disposed";
    return this.claimOnce(name);
  }

  /** The once-per-machine claim for a one-time notice: through the companion when
   *  it answers, otherwise `local` (a claim in this extension host's own storage;
   *  undefined there means it couldn't claim, which counts as a win so the notice
   *  shows rather than being dropped). "disposed" when the window closed at any
   *  point before the claim: nothing was claimed and nothing must be shown. */
  async claimOnceOrLocal(
    name: string,
    local: (name: string) => Promise<boolean | undefined>
  ): Promise<boolean | "disposed"> {
    const viaBridge = await this.claimOnceWhenSettled(name);
    if (viaBridge === "disposed") return "disposed";
    if (viaBridge !== undefined) return viaBridge;
    if (this.disposed) return "disposed"; // closed while the companion was asked
    return (await local(name)) !== false;
  }

  /** Claim `name` once across every window on this desktop. true = this caller
   *  won; false = another window already claimed it; undefined = no answer (absent
   *  or pre-rev-2 companion, or a failure), and the caller falls back. */
  async claimOnce(name: string): Promise<boolean | undefined> {
    if (!this._available || this._rev < 2) return undefined;
    try {
      const res: unknown = await vscode.commands.executeCommand(CLAIM_ONCE, name);
      return isObject(res) && typeof res.claimed === "boolean" ? res.claimed : undefined;
    } catch {
      return undefined;
    }
  }

  // ---- cross-host actions (owner-approved focus) ----------------------------

  /** Post a focus action targeted at another host. `posted` is true only when the
   *  companion accepted it (`{ ok: true }`). With a rev-3 companion the action
   *  carries an `id` (returned here) under which the acting host reports what it
   *  did (takeFocusResult); an older companion would drop the id, so none is sent.
   *  A companion too old to have postAction makes executeCommand throw "command not
   *  found" — caught here and reported as not posted WITHOUT flipping availability
   *  (the companion IS present, it just predates this feature), so the caller can
   *  fall back to the preview. The payload is validated locally before sending. */
  async postFocus(
    a: {
      targetHostId: string;
      sessionId: string;
      tool: FocusAction["tool"];
      cwd: string;
    },
    kind: FocusAction["kind"] = "focus"
  ): Promise<{ posted: boolean; id?: string; old?: true }> {
    if (!this._available) return { posted: false };
    // A stop needs a companion that knows the kind (command rev 5).
    if (kind === "stop" && this._rev < 5) return { posted: false, old: true };
    const payload: FocusAction = {
      v: 1,
      kind,
      targetHostId: a.targetHostId,
      sessionId: a.sessionId,
      tool: a.tool,
      cwd: a.cwd,
      postedAt: Date.now(),
    };
    if (this._rev >= 3) payload.id = newActionId();
    if (!validateAction(payload).ok) return { posted: false };
    try {
      const res: unknown = await vscode.commands.executeCommand(POST_ACTION, payload);
      if (!(isObject(res) && res.ok === true)) return { posted: false };
      return payload.id !== undefined ? { posted: true, id: payload.id } : { posted: true };
    } catch {
      return { posted: false }; // old companion (no postAction) or transient failure — degrade.
    }
  }

  /** Report what this host did with a focus action (rev-3 companion only). */
  async postFocusResult(r: Omit<FocusResult, "v" | "at">): Promise<boolean> {
    if (!this._available || this._rev < 3) return false;
    const doc = validateFocusResult({ ...r, v: 1, at: Date.now() });
    if (doc === null) return false;
    try {
      const res: unknown = await vscode.commands.executeCommand(POST_FOCUS_RESULT, doc);
      return isObject(res) && res.ok === true;
    } catch {
      return false;
    }
  }

  /** Take the acting host's report for a focus action, once; undefined = none yet. */
  async takeFocusResult(id: string): Promise<FocusResult | undefined> {
    if (!this._available || this._rev < 3) return undefined;
    try {
      const res: unknown = await vscode.commands.executeCommand(TAKE_FOCUS_RESULT, id);
      if (!isObject(res) || res.ok !== true) return undefined;
      const r = validateFocusResult(res.result);
      return r !== null && r.id === id ? r : undefined;
    } catch {
      return undefined;
    }
  }

  /** Consume the focus actions this host should act on (the companion deletes
   *  them on read). Every returned action is re-validated locally and its
   *  targetHostId is confirmed to be us, so a compromised store can't redirect us
   *  to a session we weren't asked to touch. `deadline` (this host's clock) is
   *  when an action's poster stops waiting: the companion reports the time left
   *  as a duration, so the two hosts' clocks are never compared. Old companion /
   *  failure → []. */
  async takeActions(selfHostId: string, folders?: readonly string[]): Promise<{ action: FocusAction; deadline?: number }[]> {
    if (!this._available) return [];
    try {
      const takenAt = Date.now();
      // Command rev 4: say which folders this window has open, so the companion
      // gives an action to the window that has its folder. Older companions
      // would ignore it; it is sent only to rev 4 and up all the same.
      const route: TakeRoute | undefined =
        this._rev >= 4 && folders !== undefined ? { window: this.windowToken, folders: folders.slice(0, ROUTE_MAX_FOLDERS) } : undefined;
      const res: unknown =
        route !== undefined
          ? await vscode.commands.executeCommand(TAKE_ACTIONS, selfHostId, route)
          : await vscode.commands.executeCommand(TAKE_ACTIONS, selfHostId);
      if (!isObject(res) || res.ok !== true || !Array.isArray(res.actions)) return [];
      const remaining = isObject(res.remainingMs) ? res.remainingMs : {};
      const out: { action: FocusAction; deadline?: number }[] = [];
      for (const raw of res.actions) {
        const v = validateAction(raw);
        if (!v.ok || v.action.targetHostId !== selfHostId) continue;
        const id = v.action.id;
        if (id === undefined) {
          out.push({ action: v.action });
          continue;
        }
        const left = remaining[id];
        // An id with no time left reported (a companion without the rule): give
        // it the full wait from now, the most the poster can still be waiting.
        const ms = typeof left === "number" && Number.isFinite(left) ? Math.max(0, Math.min(left, FOCUS_ANSWER_WAIT_MS)) : FOCUS_ANSWER_WAIT_MS;
        out.push({ action: v.action, deadline: takenAt + ms });
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
      if (s.outside === true) session.outside = true;
      if (s.stoppable === true) session.stoppable = true;
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
        ...(c.stoppable === true ? { stoppable: true as const } : {}),
        ...(c.outside === true ? { outside: true as const } : {}),
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

/** A host's published snapshot is one file per host id, so every window on that
 *  host overwrote the others' and a viewer saw whichever wrote last: each window
 *  lists and hides rows its own way, so rows and their `outside` marks came and
 *  went. One window per host publishes: the holder of this lease (a file in the
 *  storage folder all of a host's windows share), renewed on every publish
 *  (at least the 15 s heartbeat) and free once it is LEASE_STALE_MS old, so a
 *  closed window's lease passes on. Two windows racing for a free lease both
 *  write; the one whose write is read back holds it. */
export const LEASE_STALE_MS = 45_000;

/** What this build puts in a published snapshot, as one number: bump it whenever
 *  a snapshot gains a field a viewer acts on. The lease carries it, and a window
 *  whose build publishes more takes the lease from one that publishes less (see
 *  PublisherLease), so a window left on an older build can no longer hold the
 *  host's snapshot to that build's fields: it did, and `stoppable` never reached
 *  other hosts while a pre-Stop window held the lease. 1 = `stoppable`. A lease
 *  without the number (a build from before it) counts as 0. */
export const PUBLISH_REV = 1;

/** What a window sees in the lease file without touching it: `mine` (this window
 *  holds it, or the file can't be written so this window publishes alone), `free`
 *  (no lease, or its holder went silent past LEASE_STALE_MS), `taken` (another
 *  window holds a live lease). */
export type LeaseState = "mine" | "free" | "taken";

/** The refresh gate's two bridge inputs for one tick. Only a window that may
 *  publish counts as publishing, so a window whose lease is `taken` never
 *  rebuilds the panel model for the bridge; its never-reset publishDue() would
 *  otherwise make every 3 s tick a heartbeat. A `free` lease is due at once, so
 *  the window that takes it over publishes on that tick. */
export function publishGate(
  bridgeUp: boolean,
  lease: LeaseState,
  publishDue: boolean
): { bridgePublishing: boolean; heartbeatDue: boolean } {
  const bridgePublishing = bridgeUp && lease !== "taken";
  return { bridgePublishing, heartbeatDue: bridgePublishing && (lease === "free" || publishDue) };
}

export class PublisherLease {
  private readonly file: string;
  private readonly mine: string;
  /** The last write failed: the lease can't be stored, so this window publishes. */
  private unusable = false;
  constructor(
    dir: string,
    token: string,
    private readonly now: () => number = Date.now,
    /** This build's PUBLISH_REV (a parameter so tests can play an older build). */
    private readonly rev: number = PUBLISH_REV
  ) {
    this.file = join(dir, "publisher-lease");
    this.mine = token;
  }

  /** Read-only look at the lease (one small file read, no write), cheap enough
   *  for every tick of a window that does not hold it. */
  peek(): LeaseState {
    let cur: string | undefined;
    try {
      cur = readFileSync(this.file, "utf8");
    } catch {
      cur = undefined;
    }
    if (cur === undefined) return this.unusable ? "mine" : "free";
    const [atRaw, owner, revRaw] = cur.split(" ");
    if (owner === this.mine) return "mine";
    const at = Number(atRaw);
    // Either direction: after a backward clock step a lease looks future-dated,
    // and must not block the takeover until the clock catches up.
    if (!Number.isFinite(at) || Math.abs(this.now() - at) > LEASE_STALE_MS) return "free";
    // A holder on a build that publishes less gives way (see PUBLISH_REV). The
    // older window keeps the token in the second field, where it reads it, so it
    // sees the newer window's lease as taken and stops publishing.
    const rev = Number(revRaw ?? "0");
    return Number.isFinite(rev) && rev < this.rev ? "free" : "taken";
  }

  /** May this window publish now? Takes or renews the lease. True when the
   *  lease can't be stored at all (a lone window must still publish). */
  holds(): boolean {
    if (this.peek() === "taken") return false;
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      writeFileSync(this.file, `${this.now()} ${this.mine} ${this.rev}`);
      this.unusable = false;
      return readFileSync(this.file, "utf8").split(" ")[1] === this.mine;
    } catch {
      this.unusable = true;
      return true;
    }
  }

  /** Give the lease up (window closing), if it is ours. */
  release(): void {
    try {
      if (readFileSync(this.file, "utf8").split(" ")[1] === this.mine) unlinkSync(this.file);
    } catch {
      // gone
    }
  }
}

// ---- remote focus outcome ---------------------------------------------
// Clicking a row from another host: what the clicking window tells the user, and
// what the acting host reports back. vscode-free so every case is unit-tested.
//
// Before this, a click posted a focus action and the status bar said "Focusing…"
// whether or not anything happened on the other host: no window there, a session
// outside the editor, a failed window switch and an expired action all ended in
// silence. Now the clicking window waits for the acting host's report (companion
// command rev 3) and says plainly what happened.

export const FOCUS_POLL_MS = 1_000;

/** How long a status-bar note about a remote click stays. A successful switch
 *  puts another window in front, so the user reads this one only on coming
 *  back to it; a 5 s note was gone by then (it read as "no message at all"). */
export const FOCUS_NOTE_MS = 30_000;

/** Which remote-row click is the latest: a slow earlier click's status-bar note
 *  must not replace a later click's. */
export class LatestClick {
  private seq = 0;
  /** Start a click; returns its number. */
  begin(): number {
    return ++this.seq;
  }
  isLatest(click: number): boolean {
    return click === this.seq;
  }
}

export interface FocusNotice {
  /** status = transient status-bar note; info/warning = a message the user sees. */
  level: "status" | "info" | "warning";
  text: string;
  /** Also open the session's last-message preview in the clicking window. */
  preview: boolean;
}

/** A reason not to post at all, decided from the row alone. (An `outside` row is
 *  still posted: the window on its host offers to move it into the editor.) */
export function remoteFocusPrecheck(node: { stale: boolean }, title: string, host: string): FocusNotice | undefined {
  if (node.stale) {
    return {
      level: "info",
      text: `No SessionDeck window is open on ${host}, so nothing there can switch to "${title}". Showing its last message instead.`,
      preview: true,
    };
  }
  return undefined;
}

/** What to tell the user once the acting host answered, or did not. `unconfirmed`
 *  = the companion predates reports (rev < 3), so no answer can come. */
export function focusNotice(answer: FocusResult | "timeout" | "unconfirmed", title: string, host: string): FocusNotice {
  if (answer === "unconfirmed") {
    return { level: "status", text: `Asked ${host} to show "${title}" (this SessionDeck companion can't confirm it).`, preview: false };
  }
  if (answer === "timeout") {
    return {
      level: "warning",
      text:
        `No answer yet from a SessionDeck window on ${host} after ${FOCUS_ANSWER_WAIT_MS / 1000} s, so "${title}" may not have been shown. ` +
        `A window there on an older SessionDeck may still switch to it; otherwise open a window on ${host} and click again.`,
      preview: false,
    };
  }
  switch (answer.outcome) {
    case "shown":
      return {
        level: answer.detail !== undefined ? "info" : "status",
        text: `Switched to "${title}" on ${host}.` + (answer.detail !== undefined ? ` (${answer.detail})` : ""),
        preview: false,
      };
    case "handed-off":
      return {
        level: "info",
        text: `${host} passed "${title}" to its window that has the folder open and brought that window up; that window did not confirm it showed the session.`,
        preview: false,
      };
    case "preview":
      return {
        level: "info",
        text: `No window on ${host} shows "${title}", so it showed only its last activity there. Showing it here too.`,
        preview: true,
      };
    case "outside":
      return {
        level: "info",
        text: `"${title}" runs outside the editor on ${host} (in a terminal or app), so there is no window to switch to. The SessionDeck window on ${host} offers to move it into the editor.`,
        preview: true,
      };
    case "not-found":
      return { level: "info", text: `${host} no longer has "${title}" running.`, preview: false };
    case "failed":
      return {
        level: "warning",
        text: `${host} could not switch to "${title}": ${answer.detail ?? "no reason given"}.`,
        preview: true,
      };
    default:
      // A stop outcome never answers a focus action.
      return { level: "warning", text: `${host} could not switch to "${title}".`, preview: false };
  }
}

/** The clicking window's side of a relayed stop: wait for the first answer;
 *  after "asking", wait for the outcome. Without an answer in the first wait it
 *  says so (as a replaceable note) and keeps listening, so a late answer still
 *  shows, replacing that note. `tell` replaces the previous status note. */
export async function followStop(
  take: () => Promise<FocusResult | undefined>,
  tell: (answer: Parameters<typeof stopNotice>[0]) => void,
  opts: { pollMs?: number; firstWaitMs?: number; answerWaitMs?: number } = {}
): Promise<void> {
  const first = opts.firstWaitMs ?? FOCUS_ANSWER_WAIT_MS;
  const answer = opts.answerWaitMs ?? STOP_ANSWER_WAIT_MS;
  const wait = (waitMs: number) => waitForFocusResult(take, { pollMs: opts.pollMs, waitMs });
  let r = await wait(first);
  if (r === "timeout") {
    tell("timeout");
    r = await wait(answer - first);
    if (r === "timeout") return;
  }
  if (r.outcome === "asking") {
    tell(r);
    r = await wait(answer);
    if (r === "timeout") {
      tell("unanswered");
      return;
    }
  }
  tell(r);
}

/** What the host that runs a session does with a stop asked from another host.
 *  Only outcome codes and SessionDeck's own reasons go back across the relay;
 *  the session's title (possibly the first line of a prompt) never does. */
export interface RemoteStopDeps<S> {
  /** The local row for the action's session, by id: undefined = not known here. */
  find(): { pid?: number } | undefined;
  /** The verified stop subject for it; undefined = can't be stopped from here. */
  subject(): S | undefined;
  alive(pid: number): boolean;
  /** Post a result under the action's id; false = it could not be stored. */
  post(r: Pick<FocusResult, "outcome" | "detail">): Promise<boolean>;
  /** The local Stop Session (confirmation and stop); undefined = unavailable. */
  run(subject: S): Promise<{ outcome: string; reason?: string } | undefined>;
  now(): number;
}

export async function actOnRemoteStop<S>(deadline: number | undefined, deps: RemoteStopDeps<S>): Promise<void> {
  const row = deps.find();
  if (row === undefined) {
    await deps.post({ outcome: "gone" });
    return;
  }
  const subject = deps.subject();
  if (subject === undefined) {
    await deps.post(
      row.pid === undefined || !deps.alive(row.pid)
        ? { outcome: "gone" }
        : { outcome: "not-stopped", detail: "SessionDeck there can't tell where it runs or which process runs it" }
    );
    return;
  }
  if (deadline !== undefined && deps.now() > deadline) return;
  // No confirmation unless the clicking window can learn that one is open:
  // otherwise it would report "no answer" while the session gets stopped.
  if (!(await deps.post({ outcome: "asking" }))) return;
  const r = await deps.run(subject);
  if (r === undefined) {
    await deps.post({ outcome: "not-stopped", detail: "SessionDeck there can't stop sessions right now (a startup step failed)" });
    return;
  }
  if (r.outcome === "stopped" || r.outcome === "cancelled" || r.outcome === "gone") await deps.post({ outcome: r.outcome });
  else await deps.post(r.reason !== undefined ? { outcome: "not-stopped", detail: r.reason } : { outcome: "not-stopped" });
}

/** How long the clicking window waits for the outcome of a stop once the host
 *  that runs the session has its confirmation up (the user there has to answer
 *  it). Below the companion's two-minute limit for unread results. */
export const STOP_ANSWER_WAIT_MS = 110_000;

/** What the clicking window says about a stop it asked another host for.
 *  `old`: this desktop's companion predates stop actions; `not-posted`: it
 *  could not be handed over; `timeout`: no answer yet (a confirmation may still
 *  be open there, or no window there takes stops); `unanswered`: the
 *  confirmation went up there but no outcome came back in time. */
export function stopNotice(
  answer: FocusResult | "old" | "not-posted" | "timeout" | "unanswered",
  title: string,
  host: string
): { level: "status" | "info" | "warning"; text: string } {
  const there = `stop it from a SessionDeck window on ${host}`;
  if (answer === "old") return { level: "warning", text: `The SessionDeck Bridge on this computer is too old to pass a stop to ${host}. Update it, or ${there}.` };
  if (answer === "not-posted") return { level: "warning", text: `SessionDeck could not pass the stop to ${host}. To stop "${title}", ${there}.` };
  if (answer === "timeout") {
    // Not "was not stopped": a confirmation may be open there and still stop it.
    return {
      level: "status",
      text: `No answer yet from ${host} about stopping "${title}"; a confirmation may be open there. If nothing comes up there (an older SessionDeck), ${there}.`,
    };
  }
  if (answer === "unanswered") return { level: "info", text: `${host} has not said whether "${title}" was stopped. The SessionDeck window there shows the answer.` };
  switch (answer.outcome) {
    case "asking":
      return { level: "status", text: `Confirm the stop of "${title}" in the SessionDeck window on ${host}.` };
    case "stopped":
      return { level: "status", text: `Stopped "${title}" on ${host}.` };
    case "cancelled":
      return { level: "status", text: `"${title}" was left running on ${host}.` };
    case "gone":
    case "not-found":
      return { level: "info", text: `"${title}" has already stopped on ${host}.` };
    case "not-stopped":
      // The detail is SessionDeck's own reason, never conversation text; the
      // title is the one this window already shows.
      return { level: "warning", text: `${host} did not stop "${title}"${answer.detail !== undefined ? `: ${answer.detail}.` : "."}` };
    default:
      return { level: "warning", text: `${host} did not stop "${title}".` };
  }
}

/** Poll for the acting host's report until it arrives or the wait runs out, by
 *  `waitMs` at the latest even when a bridge call hangs. */
export async function waitForFocusResult(
  take: () => Promise<FocusResult | undefined>,
  opts: { waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
): Promise<FocusResult | "timeout"> {
  const waitMs = opts.waitMs ?? FOCUS_ANSWER_WAIT_MS;
  const pollMs = opts.pollMs ?? FOCUS_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + waitMs;
  // A hard deadline: a bridge call that never answers can't hold the spinner.
  for (;;) {
    const left = deadline - now();
    if (left <= 0) return "timeout";
    const r = await Promise.race([take(), sleep(left).then(() => "timeout" as const)]);
    if (r !== undefined) return r;
    if (now() >= deadline) return "timeout";
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

/** The report for a navigation outcome on the acting host. */
export function navReport(
  nav:
    | { ok: true; how?: "tab" | "terminal" | "window"; confirmed?: boolean; unraised?: string }
    | { ok: false; reason: "no-window" | "no-tab" | "no-terminal" | "cli-failed" | "expired" | "handoff-failed"; detail?: string }
    | "disabled"
): Pick<FocusResult, "outcome" | "detail"> {
  if (nav === "disabled") return { outcome: "failed", detail: "window switching is turned off there (sessionDeck.enableNavigation)" };
  // A hand-off counts as shown once the window that got it says so.
  if (nav.ok) {
    if (nav.how === "window" && nav.confirmed !== true) return { outcome: "handed-off" };
    if (nav.unraised !== undefined) return { outcome: "shown", detail: `that window may not have come to the front: ${nav.unraised}` };
    return { outcome: "shown" };
  }
  switch (nav.reason) {
    case "no-window":
      return { outcome: "failed", detail: "no editor window there has the session's folder open (none of its SessionDeck windows took the request)" };
    case "no-tab":
      return { outcome: "failed", detail: nav.detail ?? "the Claude Code extension could not open the session's tab" };
    case "no-terminal":
      return { outcome: "failed", detail: nav.detail ?? "no integrated terminal there is running the session" };
    case "cli-failed":
      return { outcome: "failed", detail: nav.detail ?? "the editor CLI failed" };
    case "handoff-failed":
      return { outcome: "failed", detail: nav.detail ?? "could not pass the request to the window that has its folder open" };
    case "expired":
      return { outcome: "failed", detail: "the request reached it after you stopped waiting, so it did not switch" };
  }
}
