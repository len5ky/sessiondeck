// Degraded-capability note: one quiet, informational row at the bottom of the
// tree (and mirrored in the floating panel footer) surfaced when sessions EXIST
// but a capability that matters is silently off — e.g. a user who dismissed the
// one-shot hooks prompt can run blocked sessions with no approval path forever.
// The SELECTION is a pure, vscode-free seam (testable under bun like triage.ts /
// alerts.ts): given probe results + filter mode it returns at most ONE note or
// none. It reuses existing probes (hooksInstalled / hookScriptStale /
// bridge.available) — it never scans anything itself.

export type CapabilityNoteKind =
  | "install-hooks"
  | "reinstall-hooks"
  | "bridge-missing"
  | "hook-drift"
  | "cursor-hooks-silent"
  | "enable-cursor"
  | "format-drift"
  | "tick-slow";

export interface CapabilityNote {
  kind: CapabilityNoteKind;
  /** Dim one-line row/footer text ("problem — fix"). */
  message: string;
  /** Command the row's click invokes (the relevant fix). */
  command: string;
}

export interface CapabilityProbes {
  /** The tree has at least one local session (the note is meta about a live
   *  fleet — never shown on an empty tree, which has its own welcome guidance). */
  hasSessions: boolean;
  /** Only shown in the "all" filter, so a filtered view stays noise-free. */
  filterAll: boolean;
  /** hooksInstalled(homes): true only when our hooks are present in EVERY home. */
  hooksInstalled: boolean;
  /** hookScriptStale(): the installed hook script body is out of date. */
  hookScriptStale: boolean;
  /** False on native win32 (POSIX-shell hooks are never offered there). */
  platformSupportsHooks: boolean;
  /** True when this extension is running inside Cursor. */
  inCursor?: boolean;
  /** Our probe and all nine marker-tagged Cursor hook entries are installed. */
  cursorMonitoringInstalled?: boolean;
  /** The installed Cursor probe has recorded one or more write failures. */
  cursorHooksSilent?: boolean;
  /** The user dismissed the Cursor monitoring unlock offer. */
  cursorMonitoringDismissed?: boolean;
  /** crossHost master toggle. */
  crossHostEnabled: boolean;
  /** bridge.available: the companion answered its probe. */
  bridgeAvailable: boolean;
  /** The one-shot bridge-install prompt has already been shown/dismissed, so the
   *  user won't be nudged again — the note is the only remaining hint. */
  bridgePromptDismissed: boolean;
  /** Hook-payload canary: ≥2 recent hook events failed the structural shape check —
   *  the Notification/Stop payload the spool carries may have drifted, so instant
   *  refresh + permission alerts are degraded (transcript polling still covers status).
   *  Same soft "may have moved" family as driftHarness, one rung above it because the
   *  degraded surface is the ALERT path, not just row display. */
  hookDrift: boolean;
  /** Format-canary: the label of a harness whose private format is suspected to
   *  have drifted (≥2 files failed structural parse), or undefined when healthy.
   *  A soft "something may have moved", never urgent. */
  driftHarness?: string;
  /** Refresh tick watchdog: present ⟺ the watchdog has latched (sustained slow
   *  ticks or a throw), carrying the ring's mean total ms for the message. The
   *  LOWEST-priority note — below format-drift — a "your fleet is fine, but the
   *  overview itself is running slow, look at Diagnostics" nudge. */
  tickWatchdog?: { avgMs: number };
}

/** Pick the single most important capability note, or undefined when none should
 *  show. Broken/re-arming notes outrank dismiss-forever unlock offers, which
 *  outrank informational diagnostics. */
export function selectCapabilityNote(p: CapabilityProbes): CapabilityNote | undefined {
  // Meta row: only over a non-empty tree, and only in the unfiltered view.
  if (!p.hasSessions || !p.filterAll) return undefined;
  // The design's cross-render alternation among same-class eligible offers is
  // deliberately simplified to fixed priority: deterministic and testable.
  // BROKEN — re-arm until repaired.
  if (p.platformSupportsHooks && p.hookScriptStale) {
    return {
      kind: "reinstall-hooks",
      message: "Hooks outdated — Reinstall",
      command: "sessionDeck.installHooks",
    };
  }
  if (p.hookDrift) {
    return {
      kind: "hook-drift",
      message: "Hook payloads may have drifted — alerts degraded; Run Diagnostics",
      command: "sessionDeck.doctor",
    };
  }
  if (p.cursorMonitoringInstalled && p.cursorHooksSilent) {
    return {
      kind: "cursor-hooks-silent",
      message: "Cursor monitoring silent — probe write errors; Run Diagnostics",
      command: "sessionDeck.doctor",
    };
  }
  // UNLOCKS — optional capabilities offered in a stable order.
  if (p.inCursor && p.platformSupportsHooks && !p.cursorMonitoringInstalled && !p.cursorMonitoringDismissed) {
    return {
      kind: "enable-cursor",
      message: "Monitor Cursor Composer sessions — Enable",
      command: "sessionDeck.enableCursorMonitoring",
    };
  }
  if (p.platformSupportsHooks && !p.hooksInstalled) {
    return {
      kind: "install-hooks",
      message: "Approval alerts off — Install Hooks",
      command: "sessionDeck.installHooks",
    };
  }
  if (p.crossHostEnabled && !p.bridgeAvailable) {
    return {
      kind: "bridge-missing",
      message: "Cross-host off — bridge companion not installed",
      command: "sessionDeck.doctor",
    };
  }
  // INFORMATIONAL.
  // A parsed private format may have drifted. Soft and
  // diagnostic (not a broken-state claim): the parsers fail soft, so this only
  // nudges toward Diagnostics for the details.
  if (p.driftHarness !== undefined) {
    return {
      kind: "format-drift",
      message: `Format drift suspected (${p.driftHarness}) — Run Diagnostics`,
      command: "sessionDeck.doctor",
    };
  }
  // (f) lowest priority — the refresh loop itself has been running slow (or threw).
  // Diagnostic, not a fleet problem: every real capability gap above outranks it.
  if (p.tickWatchdog !== undefined) {
    return {
      kind: "tick-slow",
      message: `Refresh ticks running slow (avg ${Math.round(p.tickWatchdog.avgMs)}ms) — Run Diagnostics`,
      command: "sessionDeck.doctor",
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Same-path collision detection — a second pure, vscode-free seam (kept in this
// module rather than a net-new file to honor the module freeze). Given the live
// LOCAL session rows — each carrying an optional `pendingEditPath` (the normalized
// target of an edit-tool call that is pending RIGHT NOW at the transcript tail) —
// it flags any path that ≥2 distinct sessions are editing simultaneously: the
// multi-agent failure the tree can't otherwise see. Observe-only and NARROW:
//  • only the four edit tools contribute a path (discovery.ts::EDIT_TOOLS);
//  • only pending-NOW edits (the tail) count — never historical edits;
//  • known machine-written shared paths are ignored so the rare true signal isn't
//    drowned by tooling that legitimately co-writes them.

/** Basenames of files that package managers / tooling co-write as a matter of
 *  course — a "collision" on these is coordination noise, not a hand-authored
 *  conflict, so they never raise the warning. Documented constant (evidence: on
 *  this machine's 4155-transcript corpus these never appeared as agent edit-tool
 *  targets, but they are the classic shared-write footgun, so the guard is kept as
 *  a deliberate safety valve). package.json is intentionally NOT here: two agents
 *  hand-editing it concurrently is a real conflict worth surfacing. */
export const COLLISION_IGNORE_BASENAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "flake.lock",
]);

/** Final path segment (basename) of a `/`-normalized path. */
function basenameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** True when a path is on the collision ignore-list: a known shared-write lockfile
 *  basename, or anything inside a `.git/` directory (index, refs, HEAD — all
 *  machine-managed). Paths are the normalized `/`-separated form from
 *  normalizeEditPath. */
export function isIgnoredCollisionPath(path: string): boolean {
  if (COLLISION_IGNORE_BASENAMES.has(basenameOf(path))) return true;
  if (path.includes("/.git/") || path.endsWith("/.git")) return true;
  return false;
}

/** Minimal shape detectCollisions needs from a session row. */
export interface CollisionRow {
  sessionId: string;
  /** Normalized absolute edit path pending NOW, or undefined. */
  pendingEditPath?: string;
}

/** Group live local rows by their pending edit path, returning ONLY the paths that
 *  ≥2 DISTINCT sessions are editing simultaneously (the collision set). Rows with no
 *  pending edit, and ignore-listed paths, are dropped. The value is the sorted list
 *  of distinct session ids editing that path. A pure map — no vscode, no I/O. */
export function detectCollisions(rows: readonly CollisionRow[]): Map<string, string[]> {
  const byPath = new Map<string, Set<string>>();
  for (const r of rows) {
    const p = r.pendingEditPath;
    if (p === undefined || p === "" || isIgnoredCollisionPath(p)) continue;
    let set = byPath.get(p);
    if (set === undefined) byPath.set(p, (set = new Set()));
    set.add(r.sessionId);
  }
  const out = new Map<string, string[]>();
  for (const [p, ids] of byPath) {
    if (ids.size >= 2) out.set(p, [...ids].sort());
  }
  return out;
}

/** Per-session collision lookup derived from detectCollisions: sessionId → the
 *  colliding path plus the OTHER session ids on it. When a session collides on more
 *  than one path (rare) the first by path order is kept — the row shows one glyph. */
export interface CollisionInfo {
  path: string;
  others: string[];
}
export function collisionsBySession(collisions: Map<string, string[]>): Map<string, CollisionInfo> {
  const out = new Map<string, CollisionInfo>();
  for (const [path, ids] of [...collisions].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const id of ids) {
      if (out.has(id)) continue; // keep the first path for a multi-collision session
      out.set(id, { path, others: ids.filter((x) => x !== id) });
    }
  }
  return out;
}

/** Collapse a normalized path to `parent/basename` for the compact row surface —
 *  the full path stays hover-only. */
export function collapseCollisionPath(path: string): string {
  const parts = path.split("/").filter((s) => s !== "");
  if (parts.length === 0) return path;
  return parts.slice(-2).join("/");
}

/** The single capability-note-style line summarizing collisions (lowest priority,
 *  coexists with the other notes), or undefined when there are none. */
export function collisionNoteText(collisions: Map<string, string[]>): string | undefined {
  if (collisions.size === 0) return undefined;
  if (collisions.size === 1) {
    const ids = [...collisions.values()][0];
    return `${ids.length} sessions editing the same file`;
  }
  return `${collisions.size} files each being edited by multiple sessions`;
}
