// In-window "needs-you" alerts for LOCAL Claude sessions. Vscode-free by design
// (the extension injects the notify/open callbacks) so the transition-dedup core
// is unit-testable. Two urgent states are watched, each keyed on the timestamp of
// its onset so one blocking incident toasts exactly once, never per refresh tick:
//   - approval: the session is blocked on a permission prompt (attentionMap ts).
//   - question: a still-open AskUserQuestion/ExitPlanMode (main-transcript mtime).
// Either can also come from the session registry's status "waiting" (its
// statusUpdatedAt is the onset) when the transcript or the hooks don't show it.
// A session that stays blocked keeps the same onset ts → no re-toast; one that
// unblocks and later re-blocks gets a fresh ts → toasts again.

import { sanitizeReason } from "./format";

export type AlertKind = "approval" | "question" | "remote-attention";

/** Separator for a remote alert's composite instance id `hostId∥sessionId` (the
 *  same `∥` the read-mark keys use in tree.ts — no host id or session id contains
 *  it, and it never contains the space the tracker keys split on). */
const REMOTE_SEP = "∥";
export function remoteAlertKey(hostId: string, sessionId: string): string {
  return `${hostId}${REMOTE_SEP}${sessionId}`;
}

/** One local Claude session's alert-relevant state for a single refresh. */
export interface AlertRow {
  sessionId: string;
  /** Display label: real tab title, else session name, else project basename. */
  label: string;
  /** Blocked on a permission/approval prompt (from the hook attentionMap). */
  attention: boolean;
  /** Onset ts of the current attention instance; present iff `attention`. */
  attentionTs?: number;
  /** Sanitized permission-request reason (hook Notification `message`) for the
   *  approval toast; absent when no message was captured. */
  reason?: string;
  /** Blocked on a pending question/plan awaiting the user. */
  pendingQuestion: boolean;
  /** Onset ts of the pending-question instance (main-transcript mtime — stable
   *  while the question is open, advances only once the user answers). */
  questionTs: number;
  /** The question prompt, pre-truncated upstream; absent for ExitPlanMode. */
  questionText?: string;
  /** The approval comes from the registry, not the hook (attentionTs is then the
   *  registry's statusUpdatedAt). */
  attentionFromRegistry?: boolean;
  /** The question comes from the registry, not the transcript (questionTs is then
   *  the registry's statusUpdatedAt). */
  questionFromRegistry?: boolean;
}

/** One LIVE remote session's alert-relevant state for a single refresh. Cross-host
 *  attention has no reason/question text (BridgeSession carries none), so the toast
 *  names the kind of block when the publisher tells them apart (`blockKind`), and
 *  says "needs you" otherwise. `onsetTs` is the block's onset on the
 *  publisher's clock (`publishedAt − ageSec·1000`, tree.ts remoteAlertRows); it
 *  does not advance while a block stays open across heartbeats, so one incident
 *  toasts exactly once. */
export interface RemoteAlertRow {
  hostId: string;
  sessionId: string;
  /** Display: the session's title, else an 8-char id prefix. */
  label: string;
  /** The remote host's display label. */
  hostLabel: string;
  /** Host is LIVE (receivedAt ≤45s old). A stale host must never toast. */
  live: boolean;
  /** The session's `attention` flag from the bridge snapshot. */
  attention: boolean;
  /** Onset instant of the current block on the publisher's clock
   *  (`publishedAt − ageSec·1000`; `receivedAt − ageSec·1000` without publishedAt).
   *  Stable to within a few ms of build-to-send time, not to the millisecond, so
   *  the tracker matches it with REMOTE_ONSET_SLACK_MS. */
  onsetTs: number;
  /** The snapshot comes from a publisher older than ONSET_PUBLISH_REV, whose
   *  blocked rows date their age from the newest write (subagents included), so
   *  the onset moves while one block stays open. Its blocks are told apart by a
   *  snapshot in between showing the session not blocked, not by onset. */
  legacyPublisher?: boolean;
  /** What the block is, for the toast's words only: never part of the alert's
   *  identity, so a block whose kind reads differently between two snapshots
   *  still toasts once. Absent when the publisher cannot tell a question from an
   *  approval (one older than ONSET_PUBLISH_REV publishes "waiting" for an
   *  approval open past 30 min). */
  blockKind?: "approval" | "question";
}

interface Candidate {
  /** Local: the session id. Remote: the composite `hostId∥sessionId` key. */
  sessionId: string;
  kind: AlertKind;
  /** Monotonic onset timestamp of this specific blocking instance. */
  instanceTs: number;
  /** Which signal dated the onset. The registry and the transcript/hook see the
   *  same block a few hundred ms apart, in either order; see SOURCE_SLACK_MS.
   *  "remote": an onset derived from a peer's snapshot; see REMOTE_ONSET_SLACK_MS. */
  source?: "registry" | "remote" | "remote-legacy";
}

/** Two onsets from DIFFERENT sources (registry vs transcript/hook) this close
 *  together are one block seen twice, not two blocks: the alert fires once. Same-
 *  source onsets keep the exact comparison, so a quick second approval still toasts. */
export const SOURCE_SLACK_MS = 5_000;

/** A remote onset is `publishedAt − ageSec·1000`: ageSec is computed when the
 *  row is built and publishedAt when it is sent, so every snapshot of one open
 *  block yields an onset a few ms off the last one; without publishedAt the
 *  fallback `receivedAt − ageSec·1000` moves by the whole publish latency (more
 *  when the publishing window is busy). Two remote onsets
 *  this close, with no snapshot in between showing the session unblocked, are
 *  the same block. A new block's onset is at least the old block's length plus
 *  the gap later, so it still toasts. */
export const REMOTE_ONSET_SLACK_MS = 5_000;

/** Per-window, in-memory transition dedup. Not vscode-aware, so it is tested
 *  directly. `fresh()` returns only the candidates whose (session, kind, onset)
 *  instance has not been alerted yet, and prunes sessions that are gone. */
export class AlertTracker {
  /** key(sessionId, kind) -> onset ts and source of the last-alerted instance;
   *  `cleared` once a tick showed that session present without this kind. */
  private readonly seen = new Map<string, { ts: number; source: Candidate["source"]; cleared: boolean }>();

  private static key(sessionId: string, kind: AlertKind): string {
    return `${sessionId}\0${kind}`;
  }

  fresh(candidates: readonly Candidate[], liveIds: ReadonlySet<string>): Candidate[] {
    const out: Candidate[] = [];
    const current = new Set<string>();
    for (const c of candidates) {
      const k = AlertTracker.key(c.sessionId, c.kind);
      current.add(k);
      const prev = this.seen.get(k);
      // The exact onset is always the same block. The cross-source merge only
      // joins two views of a block that never cleared in between: once a tick saw
      // it gone, a new onset from the other source is a new block.
      const open = prev !== undefined && !prev.cleared;
      const dist = prev === undefined ? Number.POSITIVE_INFINITY : Math.abs(prev.ts - c.instanceTs);
      // A remote onset jitters by the publish latency on every snapshot (see
      // REMOTE_ONSET_SLACK_MS). The mark keeps the block's first onset, so the
      // jitter can't walk it along.
      const remoteSame = c.source === "remote" && open && dist < REMOTE_ONSET_SLACK_MS;
      const crossSame = open && prev.source !== c.source && dist < SOURCE_SLACK_MS;
      // An older publisher's onset can't identify a block: while the session stays
      // blocked in every snapshot seen, it is one block, whatever its onset.
      const legacySame = c.source === "remote-legacy" && open;
      // A matched block keeps its mark (and first onset); anything else re-marks.
      if (legacySame) prev.cleared = false;
      else if (!remoteSame) this.seen.set(k, { ts: c.instanceTs, source: c.source, cleared: false });
      if (!(dist === 0 || remoteSame || crossSame || legacySame)) out.push(c);
    }
    // Bound the map: drop marks for sessions no longer present on disk. A live
    // session that merely unblocked keeps its mark, flagged cleared (an exact
    // re-appearance of the same onset still doesn't re-fire).
    for (const [k, v] of [...this.seen]) {
      const sid = k.slice(0, k.indexOf("\0"));
      if (!liveIds.has(sid)) this.seen.delete(k);
      else if (!current.has(k)) v.cleared = true;
    }
    return out;
  }
}

export function candidatesFrom(rows: readonly AlertRow[]): Candidate[] {
  const out: Candidate[] = [];
  for (const r of rows) {
    if (r.attention && r.attentionTs !== undefined) {
      out.push({
        sessionId: r.sessionId,
        kind: "approval",
        instanceTs: r.attentionTs,
        ...(r.attentionFromRegistry === true ? { source: "registry" as const } : {}),
      });
    }
    if (r.pendingQuestion) {
      out.push({
        sessionId: r.sessionId,
        kind: "question",
        instanceTs: r.questionTs,
        ...(r.questionFromRegistry === true ? { source: "registry" as const } : {}),
      });
    }
  }
  return out;
}

/** Remote source: one candidate per LIVE remote session that is currently blocking
 *  ON the viewer (`attention`), keyed on the composite `hostId∥sessionId` so it
 *  can never collide with a local session id. A STALE host emits nothing — a host
 *  going stale must never toast, and when it flickers back to live the same onset
 *  reproduces (so the tracker suppresses a re-toast). */
export function remoteCandidatesFrom(rows: readonly RemoteAlertRow[]): Candidate[] {
  const out: Candidate[] = [];
  for (const r of rows) {
    if (r.live && r.attention) {
      out.push({
        sessionId: remoteAlertKey(r.hostId, r.sessionId),
        kind: "remote-attention",
        instanceTs: r.onsetTs,
        source: r.legacyPublisher === true ? "remote-legacy" : "remote",
      });
    }
  }
  return out;
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ---- Approval burst corridor -------------------------------------------------
// When several sessions block within a short window (a parallel fleet hitting the
// same permission class), per-incident toasts become a storm. The BurstGate is a
// pure seam (vscode-free, injected clock) that sits AFTER AlertTracker's per-
// incident dedup: it decides, incident by incident, whether each fresh needs-you
// incident toasts individually, converts into ONE summary toast, or is suppressed
// because a burst is already in flight. It NEVER touches AlertTracker — a burst-
// suppressed incident is still marked seen, so it can never re-fire later.

/** One incident's routing decision. `toast` → show the individual toast (incidents
 *  1 & 2 of a would-be burst, and every incident once no burst is active); `summary`
 *  → show ONE "N sessions just blocked" toast INSTEAD of this incident's individual
 *  one (the incident that brings the window to 3 distinct sessions); `suppress` →
 *  stay silent (a later incident inside an ongoing burst — the chip/badge already count it). `count` is
 *  DISTINCT sessions in the window (a session blocked on both approval and question
 *  emits two candidates but is one session), so it never over-counts. */
export type BurstDecision =
  | { readonly kind: "toast" }
  | { readonly kind: "summary"; readonly count: number; readonly reason?: string }
  | { readonly kind: "suppress" };

/** Longest common prefix of the burst incidents' sanitized reasons, trimmed to a
 *  whole-word (or whole-token) boundary — the grouping hint. Returns undefined
 *  unless EVERY incident carried a non-blank reason and they share a meaningful
 *  prefix, so a mixed burst (some approvals, some questions/remote) gets no hint.
 *  Purely a substring of reasons already in the store — it invents no text. */
export function commonReasonPrefix(reasons: readonly (string | undefined)[]): string | undefined {
  if (reasons.length === 0) return undefined;
  const strs: string[] = [];
  for (const r of reasons) {
    if (r === undefined || r.trim() === "") return undefined; // one hint-less incident ⇒ no hint
    strs.push(r.trim());
  }
  let prefix = strs[0];
  let exact = true; // all reasons identical so far → keep the full shared reason
  for (const s of strs.slice(1)) {
    if (s === prefix) continue;
    let i = 0;
    const n = Math.min(prefix.length, s.length);
    while (i < n && prefix[i] === s[i]) i += 1;
    prefix = prefix.slice(0, i);
    exact = false;
    if (prefix === "") return undefined;
  }
  let out = prefix; // e.g. all "Claude needs your permission to use Bash"
  if (!exact) {
    // Divergent prefix: if it ends mid-token (no trailing space) drop the partial
    // trailing token; a prefix with no internal space is kept whole (e.g. "Bash(").
    if (!/\s$/.test(out)) {
      const sp = out.lastIndexOf(" ");
      if (sp >= 0) out = out.slice(0, sp);
    }
    out = out.replace(/[\s([{<"'.,;:_/—-]+$/, "").trim();
  }
  // A hint shorter than this reads as noise — a lone "B" is worse than none.
  return out.length < MIN_REASON_HINT ? undefined : out;
}

/** Shortest grouping hint worth showing; below it the shared prefix is too vague. */
const MIN_REASON_HINT = 4;

/** The summary-toast line. Scoped to what JUST blocked in this burst window — the
 *  status-bar chip owns the honest running total of everything needing you, so this
 *  deliberately says "just blocked", not "need you". Appends the shared reason
 *  prefix when the whole burst shares one. */
export function burstSummaryMessage(count: number, reason?: string): string {
  const base = `${count} ${count === 1 ? "session" : "sessions"} just blocked`;
  return reason !== undefined && reason.trim() !== "" ? `${base} — ${truncate(reason, 60)}` : base;
}

/** Collapses toast storms: fresh incidents from ≥`threshold` distinct sessions
 *  inside a rolling `windowMs` → COLLAPSE. Incidents pass through as individual
 *  toasts until the one that brings the window to `threshold` distinct sessions,
 *  which converts to a single summary; further incidents while the burst is live are suppressed. The
 *  burst ENDS after `resetMs` with no fresh incident, after which per-incident
 *  toasts resume (detected lazily on the next incident — the gate is incident-driven,
 *  matching the injected-clock, timer-free design of the rest of the pipeline). */
export class BurstGate {
  private readonly recent: { ts: number; sessionId: string; reason?: string }[] = [];
  private inBurst = false;
  private lastTs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly windowMs = 45_000,
    private readonly resetMs = 60_000,
    private readonly threshold = 3
  ) {}

  admit(sessionId: string, reason: string | undefined, now: number): BurstDecision {
    if (this.inBurst) {
      if (now - this.lastTs >= this.resetMs) {
        this.reset(); // 60s of silence ended the burst — fall through to a fresh start
      } else {
        this.lastTs = now; // still bursting: silence, but keep the reset clock ticking
        return { kind: "suppress" };
      }
    }
    this.lastTs = now;
    const cutoff = now - this.windowMs;
    while (this.recent.length > 0 && this.recent[0].ts < cutoff) this.recent.shift();
    this.recent.push({ ts: now, sessionId, reason });
    // Count DISTINCT sessions, not raw incidents: one session blocking again (or on
    // both an approval and a question) is one session, already toasted by name. A
    // storm is several sessions, so only distinct sessions can trip the summary.
    const count = new Set(this.recent.map((r) => r.sessionId)).size;
    if (count >= this.threshold) {
      const hint = commonReasonPrefix(this.recent.map((r) => r.reason));
      this.inBurst = true;
      this.recent.length = 0; // window no longer consulted while a burst is live
      return { kind: "summary", count, reason: hint };
    }
    return { kind: "toast" };
  }

  private reset(): void {
    this.inBurst = false;
    this.recent.length = 0;
    this.lastTs = Number.NEGATIVE_INFINITY;
  }
}

export function alertMessage(row: AlertRow, kind: AlertKind): string {
  if (kind === "approval") {
    // Surface WHAT is being asked when the reason came through; the reason is
    // already sanitized upstream, so a plain truncate is enough here.
    return row.reason !== undefined && row.reason.trim() !== ""
      ? `${row.label}: ${truncate(row.reason, 80)}`
      : `${row.label}: needs your approval`;
  }
  const q =
    row.questionText !== undefined && row.questionText.trim() !== ""
      ? `asks: ${truncate(row.questionText, 80)}`
      : "needs your input";
  return `${row.label} ${q}`;
}

/** Cross-host toast text. BridgeSession carries no reason/question, so the message
 *  says the kind of block in the local toasts' words ("needs your approval",
 *  "needs your input"), or "needs you" when the kind is unknown. Names the host so a
 *  five-host fleet's toast says which machine to look at. Both interpolated strings
 *  are REMOTE-SUPPLIED (the session title / host label a peer published), so — like
 *  every other hook/remote free-text sink — they run through sanitizeReason to strip
 *  control chars and newlines that could otherwise corrupt or spoof the toast line
 *  (the upstream length clamp does not remove control chars). */
export function remoteAlertMessage(row: RemoteAlertRow): string {
  const what = row.blockKind === "approval" ? "needs your approval" : row.blockKind === "question" ? "needs your input" : "needs you";
  return `${sanitizeReason(row.label, 60)} on ${sanitizeReason(row.hostLabel, 40)}: ${what}`;
}

/** Wires the dedup core to VS Code. `notify` shows the toast + [Open] button;
 *  `open` (local) / `openRemote` (cross-host) run the same navigation a row click
 *  does; `enabled` gates toasts only (the tracker still advances when off, so
 *  flipping it back on never storms). Local and LIVE-remote blocking incidents
 *  share one tracker — the composite `hostId∥sessionId` key can't collide with a
 *  bare local session id. */
export class SessionAlerts {
  private readonly tracker = new AlertTracker();
  private readonly burst: BurstGate;

  constructor(
    private readonly enabled: () => boolean,
    private readonly notify: (message: string, open: () => void) => void,
    private readonly open: (sessionId: string) => void,
    private readonly openRemote: (hostId: string, sessionId: string) => void = () => undefined,
    /** Shows the collapsed summary toast (buttons [Triage]/[Dismiss]); the callback
     *  runs the urgency-ranked triage walk. Defaults to the individual-toast channel
     *  with the triage action as its button, so an unwired caller never drops it. */
    private readonly notifySummary: (message: string, triage: () => void) => void = (m, t) =>
      this.notify(m, t),
    /** Runs the triage command (sessionDeck.triage) — the corridor itself. */
    private readonly triage: () => void = () => undefined,
    private readonly now: () => number = Date.now,
    burstWindowMs = 45_000,
    burstResetMs = 60_000
  ) {
    this.burst = new BurstGate(burstWindowMs, burstResetMs);
  }

  run(rows: readonly AlertRow[], remoteRows: readonly RemoteAlertRow[] = []): void {
    // liveIds keeps a mark alive while its session is still PRESENT (local row, or
    // any remote row in the snapshot — even a stale one). A stale remote session
    // thus keeps its mark, so a stale→live flicker with the same onset never
    // re-toasts; a session that vanishes entirely is pruned and toasts anew if it
    // returns. Match local semantics for both sources.
    const liveIds = new Set<string>([
      ...rows.map((r) => r.sessionId),
      ...remoteRows.map((r) => remoteAlertKey(r.hostId, r.sessionId)),
    ]);
    const byId = new Map(rows.map((r) => [r.sessionId, r] as const));
    const remoteByKey = new Map(
      remoteRows.map((r) => [remoteAlertKey(r.hostId, r.sessionId), r] as const)
    );
    const fresh = this.tracker.fresh(
      [...candidatesFrom(rows), ...remoteCandidatesFrom(remoteRows)],
      liveIds
    );
    if (!this.enabled()) return;
    for (const c of fresh) {
      // Resolve this incident's individual message, its [Open] action, and the
      // sanitized reason (approvals only) that feeds the burst grouping hint.
      let message: string;
      let openAction: () => void;
      let reason: string | undefined;
      if (c.kind === "remote-attention") {
        const r = remoteByKey.get(c.sessionId);
        if (r === undefined) continue;
        message = remoteAlertMessage(r);
        openAction = () => this.openRemote(r.hostId, r.sessionId);
        reason = undefined; // BridgeSession carries no reason
      } else {
        const row = byId.get(c.sessionId);
        if (row === undefined) continue;
        const sid = c.sessionId;
        message = alertMessage(row, c.kind);
        openAction = () => this.open(sid);
        reason = c.kind === "approval" ? row.reason : undefined;
      }
      // Corridor: pass through, collapse into one summary, or stay silent. The
      // tracker already marked this incident above — a suppressed toast never
      // re-fires later regardless of the routing decision here.
      const decision = this.burst.admit(c.sessionId, reason, this.now());
      if (decision.kind === "toast") {
        this.notify(message, openAction);
      } else if (decision.kind === "summary") {
        this.notifySummary(burstSummaryMessage(decision.count, decision.reason), this.triage);
      }
    }
  }
}
