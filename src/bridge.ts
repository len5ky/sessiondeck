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

/** How long a call to the companion may go unanswered before it is abandoned and
 *  the companion counts as unavailable, as if the call had thrown. A remote
 *  window's extension host keeps running after its window lost the connection
 *  (the editor waits up to 3 h for it to come back), and its calls through that
 *  window then neither fail nor arrive (#169). A slow but working companion
 *  answers in a few seconds. */
export const BRIDGE_CALL_TIMEOUT_MS = 10_000;

/** A call abandoned after the call timeout. */
class BridgeTimeout extends Error {}

/** The calls the refresh tick and activation make on their own. Only their
 *  timeout marks the companion unavailable: a click's call (postAction, the focus
 *  results, claimOnce) that times out fails that click, and the stop's final-post
 *  retries (#156) must still reach the companion. */
/** How many late answers to a consuming read (actions, focus results) are kept. */
const LATE_KEEP = 32;

const PERIODIC = new Set<string>([LIST, PUBLISH, HELLO, CURSOR_SESSIONS, LICENSE, TAKE_ACTIONS, LEGACY_STATE]);

/** When this window's snapshot last reached the companion (`lastDeliveredAt`, a
 *  reply of `{ ok: true }`), and since when its publishes have failed with no
 *  delivery in between (`failingSince`: a throw, a timeout or `{ ok: false }`;
 *  undefined when none has failed since the last delivery). Times are on the
 *  client's clock. The publisher lease follows it (PublisherLease.holds). */
export interface DeliveryState {
  lastDeliveredAt: number | undefined;
  failingSince: number | undefined;
}

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
  /** Fired when a fetch brings another host's snapshot this window has not seen
   *  (a new seq or receive time), so the caller can refresh right away instead of
   *  rendering it on the next 3 s tick. Not fired for an unchanged list. */
  onRemoteChange?: () => void;
  /** May this window publish now (it holds the publisher lease)? Checked before a
   *  held snapshot goes out, since the window may have lost the lease while it
   *  waited. Defaults to yes. */
  mayPublish?: () => boolean;
  /** Call timeout (BRIDGE_CALL_TIMEOUT_MS); tests pass a short one. */
  callTimeoutMs?: number;
  /** Clock for the publish cadence and delivery times (tests). Defaults to Date.now. */
  now?: () => number;
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
  /** Sessions with `attention` in the last snapshot sent: a session that gains it
   *  is published at once, past the 3 s floor (see publish()). */
  private lastSentAttention = new Set<string>();
  /** A changed snapshot the 3 s floor held back, sent when the floor ends. */
  private deferred: { snapshot: HostSnapshot; builtAt: number } | undefined;
  private deferTimer: ReturnType<typeof setTimeout> | undefined;
  /** Identity of the last fetched list (host id, seq, receivedAt per host). */
  private fetchedKey = "";

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

  /** Calls of these kinds still waiting for an answer, so a tick does not start
   *  another while one is pending (a call the timeout abandoned no longer counts). */
  private readonly busy = new Set<string>();
  /** The last call to the companion was abandoned unanswered (one log per streak). */
  private _timingOut = false;
  /** A publish is waiting for its answer; at most one is in flight. */
  private publishing = false;
  /** The latest snapshot asked for while a publish was in flight. */
  private queued: { snapshot: HostSnapshot; force: boolean; builtAt: number } | undefined;
  /** Focus results whose takeFocusResult answered after the timeout, by id, kept
   *  for the next poll of that id (the companion deleted them when it replied). */
  private readonly lateResults = new Map<string, { result: FocusResult; at: number }>();
  /** Actions whose takeActions answered after the timeout, for the next take. */
  private lateActions: { action: FocusAction; deadline?: number }[] = [];
  private lastDeliveredAt: number | undefined;
  private failingSince: number | undefined;
  private readonly now: () => number;

  private _license: BridgeLicense | undefined;
  private licenseFetchedAt = 0;

  constructor(private readonly opts: BridgeClientOptions) {
    this.now = opts.now ?? Date.now;
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

  /** True while calls to the companion go unanswered past the call timeout (the
   *  last call was abandoned); cleared by the next call that gets any answer. */
  get callsTimingOut(): boolean {
    return this._timingOut;
  }

  /** When this window's snapshot last reached the companion (see DeliveryState). */
  get delivery(): DeliveryState {
    return { lastDeliveredAt: this.lastDeliveredAt, failingSince: this.failingSince };
  }

  /** One command to the companion, abandoned after the call timeout: it then
   *  rejects with BridgeTimeout and, for a PERIODIC call, the companion counts
   *  as unavailable, as if the call had thrown, until a later call is answered.
   *  An answer that comes after the timeout is dropped. Logged once per streak of timeouts (command name and
   *  timeout only). */
  private call(cmd: string, ...args: unknown[]): Promise<unknown> {
    return this.invoke(cmd, args, undefined);
  }

  /** call(), for a read the companion consumes before it replies (an action, a
   *  focus result): an answer that comes after the timeout is gone from the
   *  companion, so it goes to `onLate` instead of being dropped. A late answer
   *  is never evidence of availability or delivery: it changes neither. */
  private callKeepingLate(cmd: string, onLate: (late: unknown) => void, ...args: unknown[]): Promise<unknown> {
    return this.invoke(cmd, args, onLate);
  }

  private invoke(cmd: string, args: unknown[], onLate: ((late: unknown) => void) | undefined): Promise<unknown> {
    const ms = this.opts.callTimeoutMs ?? BRIDGE_CALL_TIMEOUT_MS;
    let answer: Thenable<unknown>;
    try {
      answer = vscode.commands.executeCommand(cmd, ...args);
    } catch (err) {
      this._timingOut = false; // an error is an answer: the companion is reachable
      return Promise.reject(err);
    }
    return new Promise<unknown>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        done = true;
        if (PERIODIC.has(cmd)) this._available = false;
        if (!this._timingOut) {
          this._timingOut = true;
          const after = PERIODIC.has(cmd) ? "; treating the Bridge as unavailable until it answers again" : "";
          console.log(`[sessiondeck] bridge: ${cmd} got no answer in ${ms} ms${after}`);
        }
        reject(new BridgeTimeout(cmd));
      }, ms);
      const settle = (): boolean => {
        if (done) return false; // abandoned: the answer is not this call's any more
        done = true;
        clearTimeout(timer);
        this._timingOut = false; // any answer, an error too, means it is reachable
        return true;
      };
      answer.then(
        (v) => {
          if (settle()) resolve(v);
          else onLate?.(v);
        },
        (e: unknown) => settle() && reject(e)
      );
    });
  }

  /** Run `fn` unless a call of this kind is still pending; `whenBusy` otherwise. */
  private async single<T>(kind: string, whenBusy: T, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(kind)) return whenBusy;
    this.busy.add(kind);
    try {
      return await fn();
    } finally {
      this.busy.delete(kind);
    }
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
    this.cancelDeferred();
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
      const res: unknown = await this.call(HELLO);
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
   *  change), and publish at most once per 3s. A changed snapshot that lands
   *  inside the 3 s floor is not dropped: it is sent when the floor ends (the
   *  latest one wins; one equal to what was last sent cancels it). A session
   *  that newly needs the user (`attention`) is the most time-critical thing a
   *  snapshot carries, so a snapshot that adds one is sent at once, past the
   *  floor. `force` (this window just took the publisher
   *  lease over: another window may have written the host's snapshot since our
   *  last publish) skips all of it. Any failure marks degraded. At most one
   *  publish is in flight: a snapshot asked for meanwhile is held (the latest
   *  wins) and sent when the pending one is answered, fails or is abandoned. */
  async publish(snapshot: HostSnapshot, force = false): Promise<void> {
    const now = this.now();
    if (this.publishing) {
      this.queued = { snapshot, force: force || (this.queued?.force ?? false), builtAt: now };
      return;
    }
    const key = stableKey(snapshot);
    if (!force && !this.addsAttention(snapshot)) {
      if (now - this.lastPublishAt < MIN_INTERVAL_MS) {
        // Back to what was last sent: nothing is owed, drop a held snapshot.
        if (key === this.lastPublishKey) this.cancelDeferred();
        if (key !== this.lastPublishKey) this.defer(snapshot, now);
        return;
      }
      if (key === this.lastPublishKey && now - this.lastPublishAt < HEARTBEAT_MS) return;
    }
    this.cancelDeferred();
    await this.send(snapshot, key, now);
  }

  private async send(snapshot: HostSnapshot, key: string, now: number): Promise<void> {
    this.seq += 1;
    const doc: HostSnapshot = { ...snapshot, seq: this.seq, publishedAt: now };
    this.publishing = true;
    try {
      // A `{ ok: false }` result still means the companion is present — the call
      // resolving (not throwing) is what proves availability. Only `{ ok: true }`
      // is a delivery (the companion stored it).
      const res = await this.call(PUBLISH, doc);
      this._available = true;
      this.lastPublishAt = now;
      this.lastPublishKey = key;
      this.lastSentAttention = attentionIds(snapshot);
      if (isObject(res) && res.ok === true) {
        this.lastDeliveredAt = this.now();
        this.failingSince = undefined;
      } else {
        this.failingSince ??= this.now();
      }
    } catch {
      this._available = false;
      this.failingSince ??= this.now();
    } finally {
      this.publishing = false;
    }
    // The snapshot held meanwhile goes next, also after a failure or a timeout:
    // a session that newly needs the user must not wait for the heartbeat
    // because an older publish hung. Re-aged by the wait, as for the floor.
    const q = this.queued;
    this.queued = undefined;
    if (q === undefined || this.disposed) return;
    if (!(this.opts.mayPublish?.() ?? true)) return; // lost the lease meanwhile
    void this.publish(reaged(q.snapshot, (this.now() - q.builtAt) / 1000), q.force);
  }

  /** Does this snapshot carry a session needing the user that the last sent one
   *  did not? */
  private addsAttention(snapshot: HostSnapshot): boolean {
    return snapshot.sessions.some((s) => s.attention === true && !this.lastSentAttention.has(s.id));
  }

  /** Hold a snapshot the floor blocked and send it when the floor ends. ageSec
   *  is re-aged by the wait at send time, so a viewer's onset
   *  (receivedAt − ageSec·1000) does not move by the deferral. */
  private defer(snapshot: HostSnapshot, now: number): void {
    this.deferred = { snapshot, builtAt: now };
    if (this.deferTimer !== undefined || this.disposed) return;
    const wait = Math.max(0, this.lastPublishAt + MIN_INTERVAL_MS - now);
    this.deferTimer = setTimeout(() => {
      this.deferTimer = undefined;
      const d = this.deferred;
      this.deferred = undefined;
      if (d === undefined || this.disposed) return;
      if (!(this.opts.mayPublish?.() ?? true)) return; // lost the lease meanwhile
      const aged = reaged(d.snapshot, (this.now() - d.builtAt) / 1000);
      void this.publish(aged);
    }, wait);
  }

  private cancelDeferred(): void {
    this.deferred = undefined;
    this.queued = undefined;
    if (this.deferTimer !== undefined) clearTimeout(this.deferTimer);
    this.deferTimer = undefined;
  }

  /** True when the 15s heartbeat is due (or nothing has been published yet), i.e.
   *  publish() would republish even an unchanged snapshot to refresh the receiver's
   *  liveness clock. refresh() reads this so a quiet tick still builds+publishes on
   *  the heartbeat boundary — keeping peers inside their live window — while skipping
   *  the build on the quiet ticks in between. Mirrors the HEARTBEAT_MS branch in
   *  publish(); a successful publish resets lastPublishAt, so this goes false for the
   *  next 15s, and a failed one leaves availability false (bridgePublishing gates it). */
  publishDue(): boolean {
    return this.now() - this.lastPublishAt >= HEARTBEAT_MS;
  }

  // ---- fetch ----------------------------------------------------------------

  /** Pull the desktop Cursor enumeration feed. Invalid/old companions preserve
   * the last-good cache; a companion activation change forces one full re-pull. */
  async cursorSessions(): Promise<CursorEnumSessionWire[]> {
    if (!this._available) return this.enumCache;
    return this.single(CURSOR_SESSIONS, this.enumCache, () => this.pullCursorSessions());
  }

  private async pullCursorSessions(): Promise<CursorEnumSessionWire[]> {
    try {
      let validated = validateCursorSessions(
        await this.call(CURSOR_SESSIONS, { sinceGen: this.enumSinceGen }),
      );
      if (validated === null) return this.enumCache;
      const expectedInstanceId = this.enumLastInstanceId ?? this.companionInstanceId;
      if (expectedInstanceId !== undefined && validated.instanceId !== expectedInstanceId) {
        this.enumSinceGen = "";
        validated = validateCursorSessions(
          await this.call(CURSOR_SESSIONS, { sinceGen: "" }),
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
    return this.single(LIST, undefined, () => this.fetchList());
  }

  private async fetchList(): Promise<void> {
    try {
      const res: unknown = await this.call(LIST);
      if (Array.isArray(res)) {
        this.cache = res.filter(isStored);
        this._available = true;
        const key = this.cache
          .filter((h) => h.host.id !== this.opts.selfHostId)
          .map((h) => `${h.host.id}:${h.seq}:${h.receivedAt}`)
          .join(",");
        if (key !== this.fetchedKey) {
          this.fetchedKey = key;
          this.opts.onRemoteChange?.();
        }
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
    return this.single(LICENSE, this._license, () => this.fetchLicense(now));
  }

  private async fetchLicense(now: number): Promise<BridgeLicense | undefined> {
    try {
      const res: unknown = await this.call(LICENSE);
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
      return validateLegacyState(await this.call(LEGACY_STATE)) ?? undefined;
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
      const res: unknown = await this.call(CLAIM_ONCE, name);
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
      const res: unknown = await this.call(POST_ACTION, payload);
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
      const res: unknown = await this.call(POST_FOCUS_RESULT, doc);
      return isObject(res) && res.ok === true;
    } catch {
      return false;
    }
  }

  /** Take the acting host's report for a focus action, once; undefined = none yet. */
  async takeFocusResult(id: string): Promise<FocusResult | undefined> {
    const now = this.now();
    for (const [k, v] of this.lateResults) if (now - v.at > STOP_ANSWER_WAIT_MS) this.lateResults.delete(k);
    const late = this.lateResults.get(id);
    if (late !== undefined) {
      this.lateResults.delete(id);
      return late.result;
    }
    if (!this._available || this._rev < 3) return undefined;
    const parse = (res: unknown): FocusResult | undefined => {
      if (!isObject(res) || res.ok !== true) return undefined;
      const r = validateFocusResult(res.result);
      return r !== null && r.id === id ? r : undefined;
    };
    try {
      return parse(
        await this.callKeepingLate(TAKE_FOCUS_RESULT, (res) => {
          const r = parse(res);
          if (r === undefined) return;
          this.lateResults.delete(id);
          this.lateResults.set(id, { result: r, at: this.now() });
          // Bounded: drop the oldest beyond LATE_KEEP.
          while (this.lateResults.size > LATE_KEEP) this.lateResults.delete(this.lateResults.keys().next().value!);
        }, id)
      );
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
    const late = this.lateActions;
    this.lateActions = [];
    if (!this._available) return late;
    const taken = await this.single(TAKE_ACTIONS, [], () => this.pullActions(selfHostId, folders));
    return late.length === 0 ? taken : [...late, ...taken];
  }

  private async pullActions(selfHostId: string, folders?: readonly string[]): Promise<{ action: FocusAction; deadline?: number }[]> {
    try {
      const takenAt = Date.now();
      // Command rev 4: say which folders this window has open, so the companion
      // gives an action to the window that has its folder. Older companions
      // would ignore it; it is sent only to rev 4 and up all the same.
      const route: TakeRoute | undefined =
        this._rev >= 4 && folders !== undefined ? { window: this.windowToken, folders: folders.slice(0, ROUTE_MAX_FOLDERS) } : undefined;
      // An answer after the timeout is kept for the next take, its deadlines
      // still counted from now (the caller skips any action past its deadline).
      const onLate = (res: unknown): void => {
        const late = this.parseActions(res, selfHostId, takenAt).map((a) => ({ ...a, deadline: a.deadline ?? takenAt + FOCUS_ANSWER_WAIT_MS }));
        this.lateActions = [...this.lateActions, ...late].slice(-LATE_KEEP);
      };
      const res: unknown =
        route !== undefined
          ? await this.callKeepingLate(TAKE_ACTIONS, onLate, selfHostId, route)
          : await this.callKeepingLate(TAKE_ACTIONS, onLate, selfHostId);
      return this.parseActions(res, selfHostId, takenAt);
    } catch {
      return [];
    }
  }

  /** The actions in a takeActions answer, validated, with deadlines on this
   *  host's clock counted from `takenAt`. */
  private parseActions(res: unknown, selfHostId: string, takenAt: number): { action: FocusAction; deadline?: number }[] {
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

/** Ids of the sessions a snapshot flags as needing the user. */
function attentionIds(s: HostSnapshot): Set<string> {
  return new Set(s.sessions.filter((x) => x.attention === true).map((x) => x.id));
}

/** The snapshot with every session's ageSec advanced by `sec`. */
function reaged(s: HostSnapshot, sec: number): HostSnapshot {
  return { ...s, sessions: s.sessions.map((x) => ({ ...x, ageSec: x.ageSec + sec })) };
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

  return { v: 1, host, publishedAt: 0, seq: 0, sessions, publishRev: PUBLISH_REV };
}

/** A host's published snapshot is one file per host id, so every window on that
 *  host overwrote the others' and a viewer saw whichever wrote last: each window
 *  lists and hides rows its own way, so rows and their `outside` marks came and
 *  went. One window per host publishes: the holder of this lease (a file in the
 *  storage folder all of a host's windows share), renewed on every publish
 *  (at least the 15 s heartbeat) and free once it is LEASE_STALE_MS old, so a
 *  closed window's lease passes on. Two windows racing for a free lease both
 *  write; the one whose write is read back holds it. The holder renews only while
 *  its snapshots reach the companion (see PublisherLease.holds), so a window that
 *  lost its connection lets the lease go stale too (#169). */
export const LEASE_STALE_MS = 45_000;

/** What this build puts in a published snapshot, as one number: bump it whenever
 *  a snapshot gains a field a viewer acts on. The lease carries it, and a window
 *  whose build publishes more takes the lease from one that publishes less (see
 *  PublisherLease), so a window left on an older build can no longer hold the
 *  host's snapshot to that build's fields: it did, and `stoppable` never reached
 *  other hosts while a pre-Stop window held the lease. 1 = `stoppable`. 2 = a
 *  blocked row's ageSec counts from the block's onset, an approval never publishes
 *  "waiting", and the snapshot carries this number as `publishRev` (viewers trust
 *  the onset of a rev ≥ 2 snapshot to tell blocks apart). A lease without the
 *  number (a build from before it) counts as 0. */
export const PUBLISH_REV = 2;

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

/** For Diagnostics (#169): seconds since this window's snapshot last reached the
 *  companion (or, never having delivered one, since its publishes started
 *  failing), while that is longer than LEASE_STALE_MS and this window is the one
 *  that would publish: it holds the lease, or the lease is free, so no other
 *  window is publishing the host. Undefined once a delivery succeeds, while
 *  another window holds a live lease, and for a window that never tried (no
 *  companion). */
export function undeliveredSec(lease: LeaseState, d: DeliveryState, now: number): number | undefined {
  if (lease === "taken") return undefined;
  const since = d.lastDeliveredAt ?? d.failingSince;
  if (since === undefined) return undefined;
  return now - since > LEASE_STALE_MS ? Math.round((now - since) / 1000) : undefined;
}

export class PublisherLease {
  private readonly file: string;
  private readonly mine: string;
  /** The last write failed: the lease can't be stored, so this window publishes. */
  private unusable = false;
  /** When this window last took the lease while it was free (its grace to deliver). */
  private acquiredAt: number | undefined;
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
   *  lease can't be stored at all (a lone window must still publish).
   *
   *  With `delivery` (this window's BridgeClient.delivery), the lease follows
   *  delivery (#169): the window takes or renews it only while its last snapshot
   *  reached the companion within LEASE_STALE_MS, while no publish has failed
   *  since its last delivery (it has not had its chance yet), or within
   *  LEASE_STALE_MS of taking it over. Otherwise it leaves the file alone, so the
   *  lease goes stale and another window of the host takes over, but it still
   *  answers true while nobody else holds it: a window alone on its host keeps
   *  trying to publish, and takes the lease again once a snapshot gets through. */
  holds(delivery?: DeliveryState): boolean {
    const state = this.peek();
    if (state === "taken") return false;
    if (delivery !== undefined && !this.mayHold(state, delivery)) return true;
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      writeFileSync(this.file, `${this.now()} ${this.mine} ${this.rev}`);
      this.unusable = false;
      const mine = readFileSync(this.file, "utf8").split(" ")[1] === this.mine;
      if (mine && state === "free") this.acquiredAt = this.now();
      return mine;
    } catch {
      this.unusable = true;
      return true;
    }
  }

  /** May a window in this lease state with this delivery record take or renew it? */
  private mayHold(state: LeaseState, d: DeliveryState): boolean {
    const now = this.now();
    if (d.lastDeliveredAt !== undefined && now - d.lastDeliveredAt <= LEASE_STALE_MS) return true;
    if (d.failingSince === undefined) return true;
    return state === "mine" && this.acquiredAt !== undefined && now - this.acquiredAt <= LEASE_STALE_MS;
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
  /** Waits between retries of a final post (tests pass a fast one). */
  sleep?(ms: number): Promise<void>;
  /** Where a final post that never got stored is reported (console by default). */
  log?(msg: string): void;
}

/** Waits before the 2nd and 3rd try of a stop's final post. Each try already
 *  retries its file write for ~250 ms inside the companion; these cover a
 *  longer hold-up while staying far inside the clicking window's 110 s wait. */
export const FINAL_POST_RETRY_DELAYS_MS: readonly number[] = [500, 2_000];

/** Post a stop's final outcome: the clicking window waits for it, so a post
 *  that could not be stored is tried again, and logged if it never is. */
async function postFinal<S>(deps: RemoteStopDeps<S>, r: Pick<FocusResult, "outcome" | "detail">): Promise<boolean> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  for (let i = 0; ; i++) {
    if (await deps.post(r)) return true;
    if (i >= FINAL_POST_RETRY_DELAYS_MS.length) break;
    await sleep(FINAL_POST_RETRY_DELAYS_MS[i]);
  }
  (deps.log ?? ((m: string) => console.warn(m)))(
    `[sessiondeck] could not post the outcome "${r.outcome}" of a stop asked from another host after ${FINAL_POST_RETRY_DELAYS_MS.length + 1} tries; that window will say it did not hear back`
  );
  return false;
}

export async function actOnRemoteStop<S>(deadline: number | undefined, deps: RemoteStopDeps<S>): Promise<void> {
  const row = deps.find();
  if (row === undefined) {
    await postFinal(deps, { outcome: "gone" });
    return;
  }
  const subject = deps.subject();
  if (subject === undefined) {
    await postFinal(
      deps,
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
    await postFinal(deps, { outcome: "not-stopped", detail: "SessionDeck there can't stop sessions right now (a startup step failed)" });
    return;
  }
  if (r.outcome === "stopped" || r.outcome === "cancelled" || r.outcome === "gone") await postFinal(deps, { outcome: r.outcome });
  else await postFinal(deps, r.reason !== undefined ? { outcome: "not-stopped", detail: r.reason } : { outcome: "not-stopped" });
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
