// Offline license key + free-tier gating (honor-system, "light protections by
// design" — owner-directed). EVERYTHING here is pure and vscode-free so it unit-
// tests under bun like format.ts / triage.ts / alerts.ts, and — crucially — makes
// NO network call, ever: a key is validated by a local modulo check and an expiry
// compared against the honor-system local clock. The extension keeps working fully
// offline; a license simply lifts the free-tier supervision caps.
//
// This module is the single owner-mandated addition that moves the module-freeze
// baseline 29 → 30 (see docs/MAINTENANCE.md): the licensing concern is genuinely
// cross-cutting (parse + state + free-tier measurement + coverage selection) and
// does not belong inside any existing surface.
//
// Key shape (input tolerant of case / whitespace / separator style, but the literal
// CMC prefix and the exact 6-4-4-4 grouping are REQUIRED):
//   CMC-<YYYYMM>-<4 digits>-<4 digits>-<4 digits>
// Validation: enforce that shape first, then `BigInt(the 18 digits) % 69 === 0`
// makes it STRUCTURALLY valid (so an arbitrary 18-digit number can't slip through);
// it then licenses NOW iff the expiry is 999912 (lifetime) or the current local date
// is on or before the last day of that month.

/** Expiry sentinel for a lifetime (never-expiring) key: YYYYMM = 999912. */
export const LIFETIME_EXPIRY = 999912;
/** Free evaluation: 3 days from first-ever activation. */
export const TRIAL_DAYS = 3;
export const DAY_MS = 24 * 3600 * 1000;
export const TRIAL_MS = TRIAL_DAYS * DAY_MS;
/** Free-tier cap: how many top-level sessions stay fully active on the free tier.
 *  Sessions beyond this — active ones taking the slots first — render as a LOCKED
 *  placeholder ("Not available in free version") with no title/details/children/
 *  controls and are excluded from all supervision. See selectFreeTierCoverage. */
export const FREE_MAX_SESSIONS = 3;
/** SINGLE, clearly-marked purchase URL: the landing page's checkout anchor, which
 *  hands off to Stripe (see docs/LICENSING.md, "Fulfillment flow"). Change ONLY this
 *  constant. */
export const BUY_URL = "https://sessiondeck.dev/#checkout";

/** Result of parsing a raw key string. `expiry` is the 6-digit YYYYMM number. */
export type ParsedKey =
  | { valid: true; expiry: number; lifetime: boolean }
  | { valid: false };

/** The required key shape: a literal `CMC` prefix and the exact 6-4-4-4 grouping.
 *  Case is folded and any run of whitespace/`-` between tokens is accepted (so
 *  `cmc 202612 7080 7854 9566` and `CMC-202612-7080-7854-9566` both parse), but the
 *  prefix and every group size are strict — an arbitrary 18-digit number is NOT a key. */
const KEY_SHAPE = /^CMC[-\s]*(\d{6})[-\s]*(\d{4})[-\s]*(\d{4})[-\s]*(\d{4})$/;

/** Parse + structurally validate a raw license key. Enforces the CMC 6-4-4-4 shape
 *  FIRST, then checks the 18 digits are divisible by 69, with a plausible YYYYMM in
 *  the leading group (or the 999912 lifetime sentinel). PURE — never touches the
 *  clock or the network. */
export function parseLicenseKey(raw: string): ParsedKey {
  const m = KEY_SHAPE.exec((raw ?? "").trim().toUpperCase());
  if (m === null) return { valid: false };
  const [, expiryStr, g2, g3, g4] = m;
  const digits = expiryStr + g2 + g3 + g4; // exactly 18 by the shape
  if (BigInt(digits) % 69n !== 0n) return { valid: false };
  const expiry = Number(expiryStr);
  const lifetime = expiryStr === String(LIFETIME_EXPIRY);
  if (!lifetime) {
    const year = Number(expiryStr.slice(0, 4));
    const month = Number(expiryStr.slice(4, 6));
    if (month < 1 || month > 12 || year < 2000) return { valid: false };
  }
  return { valid: true, expiry, lifetime };
}

/** The extension's licensing posture at a given instant. `licensed-until` carries
 *  the paid-through month (yyyy-mm); `trial` carries whole days left (≥1). */
export type LicenseState =
  | "licensed-lifetime"
  | `licensed-until:${string}`
  | `trial:${number}`
  | "free";

/** First millisecond AFTER the expiry month (local time): a monthly key licenses
 *  while `now < expiryEndMs` — i.e. through the whole last day of that month. */
function expiryEndMs(expiry: number): number {
  const year = Math.floor(expiry / 100);
  const month = expiry % 100; // 1..12
  // `new Date(year, month, 1)` = first day of the NEXT month, local time.
  return new Date(year, month, 1).getTime();
}

/** Split YYYYMM into a "yyyy-mm" display string. */
function expiryLabel(expiry: number): string {
  const yyyy = Math.floor(expiry / 100);
  const mm = String(expiry % 100).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

/** Resolve the licensing state. A VALID, non-expired key licenses (lifetime or
 *  through its month); otherwise the 3-day trial applies while it lasts; otherwise
 *  free. An EXPIRED key is treated as no key (falls through to trial/free). PURE:
 *  `nowMs` and `trialStartMs` are injected, never read from the clock here. */
export function licenseState(key: string, nowMs: number, trialStartMs: number): LicenseState {
  const parsed = parseLicenseKey(key);
  if (parsed.valid) {
    if (parsed.lifetime) return "licensed-lifetime";
    if (nowMs < expiryEndMs(parsed.expiry)) return `licensed-until:${expiryLabel(parsed.expiry)}`;
    // expired — fall through to trial / free
  }
  const trialEnd = trialStartMs + TRIAL_MS;
  if (nowMs < trialEnd) {
    const daysLeft = Math.max(1, Math.ceil((trialEnd - nowMs) / DAY_MS));
    return `trial:${daysLeft}`;
  }
  return "free";
}

/** True when the state is a paid license (lifetime or a current monthly). */
export function isLicensed(s: LicenseState): boolean {
  return s === "licensed-lifetime" || s.startsWith("licensed-until:");
}

/** Merge a local trial-start with a companion-reported one using PREFER-OLDER
 *  semantics: the earlier (smaller) instant wins, so the trial can only ever move
 *  EARLIER — reinstalling into a fresh remote, or a companion with a later stamp,
 *  can never restart or extend it. Undefined inputs are ignored (the other wins);
 *  both undefined → undefined (caller keeps its own default). PURE — no clock. */
export function mergeTrialStart(
  local: number | undefined,
  bridge: number | undefined
): number | undefined {
  if (local === undefined) return bridge;
  if (bridge === undefined) return local;
  return Math.min(local, bridge);
}

/** Whole trial days remaining, or undefined when not in trial. */
export function trialDaysLeft(s: LicenseState): number | undefined {
  return s.startsWith("trial:") ? Number(s.slice("trial:".length)) : undefined;
}

// ---- One-time trial-lifecycle toasts (pure decision seam) --------------------
// Two once-ever notifications frame the honest trial→free register (see
// docs/LICENSING.md, "Trial UX"): a day-0 WELCOME when the evaluation begins, and a
// TRIAL-ENDED note the moment it lapses to free. They differ on purpose:
//   • Welcome is a COURTESY — if notifications are off for the whole trial it is
//     suppressed for good (once the trial ends the state is no longer trial, so the
//     branch is never taken again).
//   • Trial-ended is tier-change INFORMATION — its "pending" latch is armed the
//     moment the tier changes, INDEPENDENT of notifications, and it fires once at the
//     first refresh where notifications are on (which may be weeks later).
// This function is PURE: it only DECIDES and reports which globalState latches the
// caller must persist. The caller writes those latches BEFORE showing (so two racing
// windows can't double-show).

/** Which one-time trial toast (if any) is due right now. */
export type TrialToastKind = "welcome" | "trial-ended";

/** Inputs to the trial-toast decision. The `*Shown`/`*Pending` fields are the
 *  persisted latches; `notificationsOn` mirrors the notifications setting. */
export interface TrialToastInput {
  state: LicenseState;
  notificationsOn: boolean;
  welcomeShown: boolean;
  trialEndedPending: boolean;
  trialEndedShown: boolean;
  /** True once THIS install's own 3-day trial window has elapsed (now ≥ trialStart +
   *  TRIAL_MS). Gates the trial-ended pending latch so a pre-reload default-"free"
   *  (or a machine that never actually ran a trial) can't spuriously arm it. */
  trialElapsed: boolean;
}

/** What to show now and which latches to persist. Absent latch flags mean "leave
 *  as-is"; the caller persists any present flag BEFORE showing `toast`. */
export interface TrialToastDecision {
  toast: TrialToastKind | null;
  setWelcomeShown?: true;
  setTrialEndedPending?: true;
  setTrialEndedShown?: true;
}

/** Decide the due one-time toast + latch writes. See the block comment above for the
 *  welcome-vs-trial-ended asymmetry. */
export function decideTrialToast(i: TrialToastInput): TrialToastDecision {
  const decision: TrialToastDecision = { toast: null };

  // Tier-change detection is INDEPENDENT of notifications: the moment this install's
  // own trial window has elapsed and no license is in effect (state === "free"), arm
  // the pending latch once. This is what lets an off-through-trial user still get the
  // note when they later turn notifications on. `trialElapsed` is the spurious-fire
  // guard (a default/pre-reload "free" with no elapsed trial won't arm it).
  const armPending =
    !i.trialEndedShown && !i.trialEndedPending && i.state === "free" && i.trialElapsed;
  if (armPending) decision.setTrialEndedPending = true;
  const pending = i.trialEndedPending || armPending;

  if (!i.notificationsOn) return decision; // nothing shown; welcome stays un-latched

  // Welcome — courtesy: only while still in the trial, only with notifications on.
  if (!i.welcomeShown && i.state.startsWith("trial:")) {
    decision.toast = "welcome";
    decision.setWelcomeShown = true;
    return decision;
  }

  // Trial-ended — fires once at the first notifications-on refresh after arming.
  if (pending && !i.trialEndedShown) {
    decision.toast = "trial-ended";
    decision.setTrialEndedShown = true;
    return decision;
  }

  return decision;
}

/** One honest human line for the Setup Doctor / debug report — NEVER the key. */
export function licenseSummary(
  s: LicenseState,
  overLimit: boolean,
  covered: number,
  total: number
): string {
  if (s === "licensed-lifetime") return "licensed (lifetime)";
  if (s.startsWith("licensed-until:")) return `licensed through ${s.slice("licensed-until:".length)}`;
  const days = trialDaysLeft(s);
  if (days !== undefined) return `free evaluation — ${days} day(s) left (everything unlocked)`;
  return overLimit
    ? `free tier, over limit — supervising ${covered} of ${total} session(s) (subagents excluded)`
    : "free tier, within limits";
}

/** Redact anything that looks like a license key from arbitrary text — a real
 *  scrubber for the debug/diagnostics report so the key can never leak through a
 *  free-text field. Matches `CMC` followed by ≥12 further digits in any grouping. */
export function redactLicenseKeys(text: string): string {
  return text.replace(/CMC[-\s]*\d[\d\s-]{11,}/gi, "CMC-…");
}

// ---- Free-tier coverage selection (session-based, active-first) --------------
// OWNER-MANDATED semantic change (was project-based: 3 projects × 4 agents). The
// paid mechanic is now stated plainly: the free tier keeps FREE_MAX_SESSIONS
// top-level sessions fully live; every session BEYOND that renders as a LOCKED
// placeholder — no title/details/children/controls — and is excluded from all
// supervision. Coverage prioritizes ACTIVE sessions (working / waiting-on-you) for
// the free slots, then falls back to most-recent, so the sessions you are actually
// interacting with are the ones that stay covered. Remote hosts never enter here
// (they never count toward the limit); subagents / workflow children / codex
// children never enter either — only top-level local sessions are ranked.

export interface FreeSession {
  /** Stable, unique identity for the locked set (e.g. `session:<id>`). */
  key: string;
  /** Whether this session is active right now — a Claude row working, blocked on a
   *  question, or on an approval prompt; a Cursor/Codex row working. Active sessions
   *  take the free slots first, so the ones you're interacting with stay covered. */
  active: boolean;
  /** Last-activity instant — larger = more recently active. Ranks within the active
   *  set and within the idle set, and is the stable tiebreak that keeps coverage from
   *  flapping across quiet refreshes (an idle session's recency does not drift). */
  recencyMs: number;
}

export interface FreeCoverage {
  /** Session keys that are OVER the cap: render locked + excluded from supervision.
   *  (Field name kept as `dimmed` — the internal marker threaded through the tree —
   *  for continuity; the RENDER is now a locked placeholder, not a dim of the row.) */
  dimmed: Set<string>;
  /** Sessions still fully covered (total − locked). */
  coveredRows: number;
  totalRows: number;
}

/** Pick the session keys beyond the free-tier session cap. Fully deterministic and
 *  stable across refreshes: sessions are ranked ACTIVE-first, then by recency
 *  (descending), then by key — NOT enumeration order — so a quiet tick or a re-sort
 *  can never reshuffle which sessions are covered. The top FREE_MAX_SESSIONS are kept
 *  fully live; every remaining session key is returned in `dimmed` (locked).
 *
 *  Stickiness: an idle session's `recencyMs` does not change, so among equally-idle
 *  sessions the ordering is stable for the session's lifetime; active sessions hold
 *  their slots while active. Coverage only shifts when a session's activity actually
 *  changes — which is exactly when re-prioritizing is correct. */
export function selectFreeTierCoverage(sessions: readonly FreeSession[]): FreeCoverage {
  const ranked = [...sessions].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      b.recencyMs - a.recencyMs ||
      a.key.localeCompare(b.key)
  );
  const dimmed = new Set<string>();
  for (const s of ranked.slice(FREE_MAX_SESSIONS)) dimmed.add(s.key);
  return { dimmed, coveredRows: sessions.length - dimmed.size, totalRows: sessions.length };
}

/** Whether the fleet exceeds the free-tier session cap (the ENFORCEMENT trigger):
 *  more top-level sessions than the free tier covers. `sessionCount` is the live
 *  count of top-level local sessions (Claude + Cursor + Codex; children and remote
 *  hosts excluded), the same population selectFreeTierCoverage ranks. */
export function isOverFreeLimit(sessionCount: number): boolean {
  return sessionCount > FREE_MAX_SESSIONS;
}
