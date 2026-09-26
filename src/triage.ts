// Keyboard-triage core (vscode-free so it unit-tests under bun, like format.ts /
// alerts.ts). Two pure pieces power the "cycle every session that needs you"
// commands: buildTriageSet flattens the tree's needs-you rows into the exact
// display order, and advanceTriageCursor moves a session-scoped cursor over that
// set with wraparound. tree.ts feeds them the concrete node objects (which
// structurally satisfy the minimal read shapes below), so the returned target is
// still the real tree node — ready to reveal and open.

/** Minimal read shapes the builder needs from each row kind. The concrete
 *  SessionNode / CursorNode / CodexNode / RemoteSessionNode satisfy these
 *  structurally, so the builder stays pure + light-fixture-testable while still
 *  returning the real node for TreeView.reveal + the open command.
 *
 *  Each shape also exposes the timestamp that dates its *blocking onset*, so the
 *  builder can rank oldest-blocked-first within a tier (see buildTriageSet):
 *   - session tier-1 (attention/question): `row.mainMtimeMs` — the main-transcript
 *     write that raised the permission/question (attention expiry is keyed on it,
 *     and it is exactly the `questionTs` the alert candidates use);
 *   - session tier-2 (finished-unread): `row.mtimeMs` — the waiting-state activity
 *     instant the unread predicate compares against the read-mark;
 *   - cursor/codex tier-2: `row.updatedMs` — the same instant their unread predicate
 *     compares against the read-mark;
 *   - remote tier-3: `ageSec` — no absolute clock is trusted across hosts, so within
 *     the remote tier we order by age (largest = oldest-blocked = first). */
export interface TriageSessionLike {
  readonly unread: boolean;
  readonly attention: boolean;
  /** Free-tier over-limit rows are excluded from triage (supervision is gated). */
  readonly dimmed?: boolean;
  readonly row: {
    readonly meta: { readonly sessionId: string };
    readonly pendingQuestion: boolean;
    readonly mainMtimeMs: number;
    readonly mtimeMs: number;
  };
}
export interface TriageCursorLike {
  readonly unread: boolean;
  readonly dimmed?: boolean;
  readonly row: { readonly chatId: string; readonly updatedMs: number };
}
export interface TriageCodexLike {
  readonly unread: boolean;
  readonly dimmed?: boolean;
  readonly row: { readonly id: string; readonly updatedMs: number };
}
export interface TriageRemoteLike {
  readonly unread: boolean;
  readonly hostId: string;
  readonly ageSec: number;
  readonly session: { readonly id: string };
}

export interface TriageProjectLike<S, C, X> {
  readonly sessions: readonly S[];
  readonly cursors: readonly C[];
  readonly codexes: readonly X[];
}
export interface TriageRemoteProjectLike<R> {
  readonly sessions: readonly R[];
}
export interface TriageHostLike<R> {
  readonly projects: readonly TriageRemoteProjectLike<R>[];
}

/** One cyclable target: a stable id (cursor state) plus the real tree node. */
export interface TriageTarget<N> {
  readonly id: string;
  readonly node: N;
}

/** Urgency tier of a needs-you row (lower = more urgent, walked first). */
const TIER_ATTENTION = 1; // local approval / pending question — blocked ON you
const TIER_UNREAD = 2; // local finished-unread (session / cursor / codex)
const TIER_REMOTE = 3; // live-remote attention (another host owns the action)

/** The needs-you set — exactly the constituents of the status-bar chip's count —
 *  ranked for triage: by urgency TIER, then oldest-blocked-first within a tier, with
 *  the tree's own display order as the stable tiebreak.
 *
 *  MEMBERSHIP is unchanged from the display-order builder (so
 *  `needsYouIds().length === unreadCount` still holds): a local session qualifies on
 *  unread OR attention (the same predicate reload() sums), cursor/codex/remote rows
 *  on their unread flag. Only the ORDER changed — the tree itself still renders
 *  geographically; this ranking drives the `]`/`[` triage walk and the focus-return
 *  digest only.
 *
 *  Tiers: (1) attention — local approval rows plus pending-question rows (both block
 *  ON you); (2) finished-unread local sessions/cursors/codexes; (3) live-remote
 *  attention. Within a tier we sort ascending by the blocking-onset timestamp each
 *  row carries (documented on the *Like interfaces above): oldest block first, so a
 *  long-waiting red never sits behind a just-arrived one. The sort is stable, so
 *  onset ties fall back to the tree order the rows were collected in. */
export function buildTriageSet<
  S extends TriageSessionLike,
  C extends TriageCursorLike,
  X extends TriageCodexLike,
  R extends TriageRemoteLike,
>(
  projects: readonly TriageProjectLike<S, C, X>[],
  hostNodes: readonly TriageHostLike<R>[]
): TriageTarget<S | C | X | R>[] {
  // Collect in tree order first (so equal-rank rows keep geographic order under the
  // stable sort), tagging each with its tier and blocking-onset key.
  const ranked: { target: TriageTarget<S | C | X | R>; tier: number; onset: number }[] = [];
  for (const p of projects) {
    for (const s of p.sessions) {
      if (s.dimmed) continue; // free-tier over-limit: excluded from the needs-you set
      if (!(s.unread || s.attention)) continue;
      // Attention and pending-question both block ON you → tier 1, dated by the
      // main-transcript write that raised them; a plain finished-unread → tier 2,
      // dated by its waiting-state activity instant.
      const blocking = s.attention || s.row.pendingQuestion;
      ranked.push({
        target: { id: `session:${s.row.meta.sessionId}`, node: s },
        tier: blocking ? TIER_ATTENTION : TIER_UNREAD,
        onset: blocking ? s.row.mainMtimeMs : s.row.mtimeMs,
      });
    }
    for (const c of p.cursors) {
      if (c.unread && !c.dimmed)
        ranked.push({
          target: { id: `cursor:${c.row.chatId}`, node: c },
          tier: TIER_UNREAD,
          onset: c.row.updatedMs,
        });
    }
    for (const x of p.codexes) {
      if (x.unread && !x.dimmed)
        ranked.push({
          target: { id: `codex:${x.row.id}`, node: x },
          tier: TIER_UNREAD,
          onset: x.row.updatedMs,
        });
    }
  }
  for (const h of hostNodes) {
    for (const rp of h.projects) {
      for (const s of rp.sessions) {
        if (s.unread)
          ranked.push({
            target: { id: `remote:${s.hostId}:${s.session.id}`, node: s },
            // No cross-host clock is trusted, so order by age within the remote tier:
            // negate so a larger age (older block) sorts ascending to the front.
            tier: TIER_REMOTE,
            onset: -s.ageSec,
          });
      }
    }
  }
  // Stable sort (guaranteed since ES2019): urgency tier, then oldest-blocked-first,
  // then the collected tree order for ties.
  ranked.sort((a, b) => a.tier - b.tier || a.onset - b.onset);
  return ranked.map((r) => r.target);
}

/** Id prefix that namespaces a needs-you INBOX reference row so it can never
 *  collide with the real row's id (the bare triage id, e.g. "session:<id>"). The
 *  inbox is a VIEW, not a move: each reference points back at the real node, and its
 *  click / context-menu / focus-anchor all act on THAT node — so an inbox click
 *  records the real session anchor (returnToFocus/reveal keep working). */
export const INBOX_ID_PREFIX = "inbox:";

/** One inbox reference row: a distinct `inbox:`-prefixed id, the real triage id it
 *  points back at, and the real tree node (the reference's click/menu operate on
 *  this, so no duplicate identity leaks into counts or focus anchors). */
export interface InboxRef<N> {
  readonly refId: string;
  readonly anchorId: string;
  readonly node: N;
}

/** The needs-you inbox: the triage-ranked set surfaced as lightweight reference
 *  rows — SAME membership and order as `buildTriageSet` (the status-bar chip's set).
 *  Returns [] when the lane is disabled or nothing needs you (caller renders the
 *  section only when non-empty). Pure + vscode-free so the parity / id-scheme /
 *  no-collision guarantees unit-test under bun. The refId is derived by prefixing —
 *  never mutated from — the triage id, so `refId` and `anchorId` are always disjoint
 *  namespaces (no real row and its inbox mirror can share a tree-item id). */
export function buildInbox<N>(
  triage: readonly TriageTarget<N>[],
  enabled: boolean
): InboxRef<N>[] {
  if (!enabled) return [];
  return triage.map((t) => ({ refId: INBOX_ID_PREFIX + t.id, anchorId: t.id, node: t.node }));
}

/** A stable reference to the last session focused via any open/triage/click path
 *  — the anchor `sessionDeck.returnToFocus` re-resolves. Held by id (never a
 *  node reference: reload() rebuilds every node each pass), so the command always
 *  re-resolves the CURRENT node and degrades cleanly when the session is gone. */
export type FocusRef =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "cursor"; readonly id: string }
  | { readonly kind: "codex"; readonly id: string }
  | { readonly kind: "remote-session"; readonly hostId: string; readonly id: string };

/** Per-kind CURRENT-node lookups (the tree's existing find* methods). */
export interface FocusLookups<S, C, X, R> {
  readonly session: (id: string) => S | undefined;
  readonly cursor: (id: string) => C | undefined;
  readonly codex: (id: string) => X | undefined;
  readonly remote: (hostId: string, id: string) => R | undefined;
}

/** Re-resolve a focus ref to the CURRENT node by id (fresh lookup — never a
 *  stored node reference), or undefined when the session is gone (the caller then
 *  degrades to a subtle status-bar note, no error). Pure + vscode-free so the
 *  record/re-resolve and gone-session semantics unit-test under bun. */
export function resolveFocusRef<S, C, X, R>(
  ref: FocusRef,
  lookups: FocusLookups<S, C, X, R>
): S | C | X | R | undefined {
  switch (ref.kind) {
    case "session":
      return lookups.session(ref.id);
    case "cursor":
      return lookups.cursor(ref.id);
    case "codex":
      return lookups.codex(ref.id);
    case "remote-session":
      return lookups.remote(ref.hostId, ref.id);
  }
}

/** Target index after moving the triage cursor by dir (+1 next / −1 prev).
 *  Empty set → undefined. When lastId is absent from the current set (never set,
 *  or the row it named dropped out — a marked-read/vanished session) we start
 *  from the appropriate end: top for next, bottom for prev. Otherwise advance
 *  with wraparound. */
export function advanceTriageCursor(
  ids: readonly string[],
  lastId: string | undefined,
  dir: 1 | -1
): number | undefined {
  if (ids.length === 0) return undefined;
  const cur = lastId !== undefined ? ids.indexOf(lastId) : -1;
  if (cur < 0) return dir === 1 ? 0 : ids.length - 1;
  return (cur + dir + ids.length) % ids.length;
}
