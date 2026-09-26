// The "why is this session blocked" store for LOCAL Claude attention rows. A
// permission-prompt Notification hook carries the reason text ("Claude needs your
// permission to use Bash"); we keep the latest reason per session alongside the
// attention timestamp so the tree row, its hover and the alert toast can surface
// WHAT is being asked, not just "needs approval". Vscode-free by design (the
// extension injects sanitized text) so the bounding + latest-wins semantics are
// unit-testable. Reasons are cleared in lockstep with the attention flag.

/** Bounded, latest-wins map of sessionId -> sanitized reason string. Insertion
 *  order is the recency order (a re-set moves the key to newest), so the cap drops
 *  the coldest half — the same policy discovery.capMap uses for its parse caches. */
export class ReasonStore {
  private readonly map = new Map<string, string>();

  constructor(private readonly max = 200) {}

  /** Store (or replace) a session's latest reason. Text must already be sanitized
   *  by the caller — the store never renders, only holds. Latest-wins: re-setting
   *  a live session refreshes both the value and its recency. */
  set(sessionId: string, reason: string): void {
    this.map.delete(sessionId);
    this.map.set(sessionId, reason);
    if (this.map.size > this.max) {
      const drop = this.map.size >> 1;
      let i = 0;
      for (const k of this.map.keys()) {
        this.map.delete(k);
        if (++i >= drop) break;
      }
    }
  }

  /** The latest reason for a session, or undefined when none is stored (attention
   *  without a captured message, or already cleared). */
  get(sessionId: string): string | undefined {
    return this.map.get(sessionId);
  }

  /** Clear a session's reason — called wherever its attention flag is cleared
   *  (unblock event, or the tree's mtime-based attention expiry). */
  delete(sessionId: string): void {
    this.map.delete(sessionId);
  }

  /** Test/introspection only. */
  get size(): number {
    return this.map.size;
  }
}
