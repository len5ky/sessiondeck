// Focus-return digest core. Vscode-free by design (extension.ts wires the window
// focus listener + the info toast to it) so the whole decision is unit-testable.
//
// The VoC failure it fixes: a needs-you toast fires while the window is unfocused,
// gets buried, and the user comes back 30 minutes later never having seen it. On a
// real refocus — focus returning after the window was unfocused ≥ threshold — we
// show ONE summary instead of relying on the buried per-incident toasts.
//
// Precision variant (shipped): we compare the current needs-you set against a
// snapshot of it captured the moment focus LEFT, and count only ids that AROSE
// during the absence (were not already needing you at defocus). If nothing new
// arose we stay silent — the user already knew about the rest. This is exactly the
// VoC case: the session that "had been waiting since minute 3" was NOT blocked at
// defocus (minute 0), so it lands in the delta and is surfaced.

export const DIGEST_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export interface DigestDecision {
  /** Show the one-shot "while you were away" summary. */
  readonly show: boolean;
  /** Sessions that NEWLY need you (arose during the absence). 0 when not showing. */
  readonly count: number;
}

const NO: DigestDecision = { show: false, count: 0 };

/** Tracks a single focused→unfocused→focused cycle and decides whether a refocus
 *  warrants the digest. Not vscode-aware; extension.ts calls onBlur/onFocus off the
 *  real `onDidChangeWindowState` events and reads back the decision. */
export class FocusDigest {
  /** Timestamp focus left, or undefined while focused / not yet armed. */
  private unfocusedSince: number | undefined;
  /** The needs-you id set captured at defocus (basis of the delta). */
  private snapshot: ReadonlySet<string> = new Set();

  constructor(private readonly thresholdMs: number = DIGEST_THRESHOLD_MS) {}

  /** Focus left the window: start the clock and snapshot the current needs-you set.
   *  Only the FIRST blur of a focused→unfocused transition is recorded — repeat blur
   *  events while already unfocused are ignored so the timer/snapshot don't reset. */
  onBlur(now: number, currentIds: readonly string[]): void {
    if (this.unfocusedSince !== undefined) return;
    this.unfocusedSince = now;
    this.snapshot = new Set(currentIds);
  }

  /** Focus returned: decide, then re-arm. Shows the digest only when the window was
   *  unfocused ≥ threshold, notifications are on, and at least one session came to
   *  need you during the absence (delta non-empty). The delta count is returned.
   *  Always re-arms: the next digest can only fire after another real ≥threshold
   *  absence (a fresh onBlur). */
  onFocus(now: number, currentIds: readonly string[], enabled: boolean): DigestDecision {
    const since = this.unfocusedSince;
    const snapshot = this.snapshot;
    // Re-arm regardless of the outcome (even when suppressed by the setting), so a
    // later focus with no intervening blur never re-fires a stale digest.
    this.unfocusedSince = undefined;
    this.snapshot = new Set();

    if (since === undefined) return NO; // focus event without a preceding blur
    if (!enabled) return NO; // notifications:off silences the digest too
    if (now - since < this.thresholdMs) return NO; // came back too soon

    // Delta variant: only ids not already needing you at defocus. An empty delta
    // (whether the set is empty or unchanged) stays silent — nothing new to report.
    let count = 0;
    for (const id of currentIds) if (!snapshot.has(id)) count++;
    return count > 0 ? { show: true, count } : NO;
  }
}

/** The digest message + button label, shared by the wiring and its test. */
export function digestMessage(count: number): string {
  const s = count === 1 ? "" : "s";
  const verb = count === 1 ? "needs" : "need";
  return `While you were away: ${count} session${s} ${verb} you`;
}
