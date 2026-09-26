// Format canary — drift detection for every private surface the extension parses.
//
// The extension reads three vendors' PRIVATE, UNDOCUMENTED formats (Claude JSONL
// transcripts, Codex rollout JSONL, Cursor store.db) plus VS Code's sqlite title
// storage. All of them WILL drift with vendor releases, and today drift manifests
// as a silently empty or wrong tree — the parsers fail soft, so nothing tells you
// the data moved. This module is the DETECTION layer: it turns that silent failure
// into one honest, conservative signal.
//
// Two kinds of signal, deliberately separated:
//  1. VERSION SNIFFING (a NOTE, never an alarm): the version each format exposes
//     today, captured against a KNOWN-good ceiling observed on a real machine. A
//     live file ABOVE the ceiling means a new vendor release shipped — worth noting,
//     but a newer version is not a broken parser.
//  2. PARSE-HEALTH (the real alarm): a cheap structural check on data the tick is
//     ALREADY reading (zero new I/O) — did the required structure parse at all? An
//     alarm fires only when the REQUIRED structure is ABSENT across ≥2 files, never
//     on unknown extra fields and never on a single corrupt file. False "format
//     broken" alarms are worse than late detection, so the bar is high.
//
// The evaluators are pure, vscode-free functions over a small accumulator that the
// scanners populate as a side effect of reads they already perform — so this adds
// no per-tick disk work (verified on the perf bench: quiet-tick counters unchanged).
// It is testable under bun like triage.ts / alerts.ts / capability.ts.

/** ≥2 affected files/sessions before an alarm — a single corrupt file is noise. */
const DRIFT_MIN = 2;

/** Recent-window size for the hook-payload shape canary (below). The window is a
 *  ring of the last N consumed event outcomes; ≥DRIFT_MIN failures IN the window
 *  latch drift, and healthy events aging in flush it back out (self-unlatching). */
const HOOK_WINDOW = 50;

// ---- Known-good version ceilings (observed on a real machine, 2026-07-21) --------
// A live file EXCEEDING one of these is a NOTE ("new release"), not an alarm.
/** Claude transcript `version` field (per user/assistant record). */
export const KNOWN_CLAUDE_VERSION_CEILING = "2.1.216";
/** Codex rollout head `session_meta.payload.cli_version`. */
export const KNOWN_CODEX_VERSION_CEILING = "0.142.5";
/** Cursor chat `meta.json` `schemaVersion` (an integer; store.db meta['0'] carries
 *  no version of its own — verified: its keys are agentId/name/mode/…). */
export const KNOWN_CURSOR_SCHEMA_CEILING = "1";

export type Harness = "claude" | "codex" | "cursor" | "titles";

export interface HarnessReport {
  harness: Harness;
  /** Human label for surfacing (doctor line + capability note). */
  label: string;
  /** Files/sessions with a recorded parse-health datum this run. */
  seen: number;
  /** Of those, how many lacked the required structure (the alarm numerator). */
  failed: number;
  /** The alarm: ≥DRIFT_MIN affected files — required structure absent, likely drift. */
  driftSuspected: boolean;
  /** Highest version/schema observed (undefined when none seen). */
  observedVersion?: string;
  /** Known-good ceiling for this harness (undefined for titles — no version field). */
  ceiling?: string;
  /** observedVersion is strictly above the ceiling — a NOTE (new release), not drift. */
  aboveCeiling: boolean;
}

export interface FormatHealthReport {
  claude: HarnessReport;
  codex: HarnessReport;
  cursor: HarnessReport;
  titles: HarnessReport;
}

/** The hook-spool payload-shape canary — a FIFTH surface the format canary above does
 *  not cover. The hook forwarder (hooks.ts SCRIPT_BODY) spools Notification/Stop/
 *  UserPromptSubmit events into events.jsonl, and extension.ts::onHookEvents consumes
 *  them for instant refresh + permission-prompt alerts. If Claude Code changes that
 *  payload shape (renames session_id, drops the Notification message, …) the consumer
 *  silently DROPS the event (`continue`) and alert death is invisible. This report
 *  turns that into one honest signal, mirroring HarnessReport's conservative bar. */
export interface HooksReport {
  /** Total events consumed since construction (the "N consumed" doctor count). */
  consumed: number;
  /** Events in the recent window (≤ HOOK_WINDOW). */
  seen: number;
  /** Of those, how many failed the structural shape check (missing a REQUIRED field
   *  the consumer uses, OR a complete malformed-JSON line). The alarm numerator. */
  failed: number;
  /** The alarm: ≥DRIFT_MIN shape failures in the recent window — payload likely drifted. */
  driftSuspected: boolean;
  /** A healthy event in the window lacked the top-level `bridge` field the current
   *  SCRIPT_BODY writes → an OLD hook script is still feeding the spool (reinstall
   *  hint). NOT a shape failure (the consumer tolerates a missing bridge). */
  legacyScriptSuspected: boolean;
}

/** Compare two dotted version strings numerically and tolerantly: missing or
 *  non-numeric segments compare as 0, so a garbled input never throws — it just
 *  compares low. Returns -1 | 0 | 1 for a<b | a==b | a>b. Works for the integer
 *  Cursor schema ("2" vs "1") as well as dotted semver ("2.1.216" vs "2.1.215"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const y = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---- The accumulator (populated by scanners, read by the evaluators) ------------
// Per-file health maps: key = a stable per-file id, value = healthy (required
// structure parsed). Re-recording the same file overwrites, so a file that recovers
// flips back to healthy; each scanner prunes its own map to the ids it visited this
// tick (claude/codex/cursor), so every map stays bounded to live files.
export interface CanaryState {
  claude: Map<string, boolean>;
  codex: Map<string, boolean>;
  cursor: Map<string, boolean>;
  /** Editor title DBs the last local scan actually queried (cache misses only). */
  titleAttempted: number;
  /** Of those, how many had the required-query return null (structure absent). */
  titleFailed: number;
  claudeVersion?: string;
  codexVersion?: string;
  cursorSchema?: string;
  /** Hook-payload shape canary. A ring of the last HOOK_WINDOW consumed events:
   *  `ok` = all required consumer fields present; `legacy` = healthy but written by
   *  an old (pre-bridge) script. Bounded by construction — the oldest entry is
   *  dropped when a new one arrives, so a recovered stream self-unlatches. */
  hookRing: Array<{ ok: boolean; legacy: boolean }>;
  /** Total events consumed since reset (monotonic; the ring only keeps the tail). */
  hookConsumed: number;
}

function emptyState(): CanaryState {
  return {
    claude: new Map(),
    codex: new Map(),
    cursor: new Map(),
    titleAttempted: 0,
    titleFailed: 0,
    hookRing: [],
    hookConsumed: 0,
  };
}

const state: CanaryState = emptyState();

// Side maps from a health-map key back to the SOURCE FILE that produced the datum,
// so the drift-fixture capture (below) can re-read the offending files. Codex's
// health-map key IS the rollout path, so it needs no side map; Claude keys by
// sessionId and Cursor by chatId, so those two carry a path here. Populated only
// when the recorder is handed a path (zero cost otherwise) and bounded alongside
// the health maps.
const claudeSrc = new Map<string, string>(); // sessionId → transcript path
const cursorSrc = new Map<string, string>(); // chatId → store.db path

/** Cap a map by dropping its oldest half once it exceeds `max` (insertion-order
 *  eviction, like discovery's capMap) so a long-lived process can't grow it. */
function cap(m: Map<string, unknown>, max = 500): void {
  if (m.size <= max) return;
  const drop = m.size >> 1;
  let i = 0;
  for (const k of m.keys()) {
    m.delete(k);
    if (++i >= drop) break;
  }
}

function maxVersion(prev: string | undefined, seen: string): string {
  if (seen === "") return prev ?? "";
  if (prev === undefined || compareVersions(seen, prev) > 0) return seen;
  return prev;
}

// ---- Recording (called by the scanners, zero new I/O) ---------------------------

/** A live Claude session's transcript tail: healthy ⟺ ≥1 line parsed as JSON with a
 *  `type` (the required discriminator). `version` is the transcript record version,
 *  if the tail exposed one. */
export function recordClaudeHealth(sessionId: string, healthy: boolean, version?: string, sourcePath?: string): void {
  state.claude.set(sessionId, healthy);
  cap(state.claude);
  if (sourcePath !== undefined) {
    claudeSrc.set(sessionId, sourcePath);
    cap(claudeSrc);
  }
  if (version !== undefined) state.claudeVersion = maxVersion(state.claudeVersion, version);
}

/** A recent Codex rollout: healthy ⟺ its head parsed into a `session_meta` with the
 *  required session_id + cwd (else it is silently dropped from the tree — the exact
 *  drift failure). `cliVersion` is the head's `cli_version`. */
export function recordCodexHealth(path: string, healthy: boolean, cliVersion?: string): void {
  state.codex.set(path, healthy);
  cap(state.codex);
  if (cliVersion !== undefined) state.codexVersion = maxVersion(state.codexVersion, cliVersion);
}

/** A Cursor chat whose store.db was successfully queried (engine present): healthy ⟺
 *  meta['0'] decoded into JSON. Only call when the query itself succeeded — a null
 *  read (no engine / busy db) is not a drift signal and must NOT be recorded. */
export function recordCursorHealth(chatId: string, healthy: boolean, sourcePath?: string): void {
  state.cursor.set(chatId, healthy);
  cap(state.cursor);
  if (sourcePath !== undefined) {
    cursorSrc.set(chatId, sourcePath);
    cap(cursorSrc);
  }
}

/** The Cursor chat schema version (from meta.json). */
export function recordCursorSchema(schema: number): void {
  state.cursorSchema = maxVersion(state.cursorSchema, String(schema));
}

/** One local editor-title extraction pass: `attempted` = DBs actually queried this
 *  scan, `failed` = of those, how many had the required SELECT return null. The
 *  engine-present gate lives in the evaluator (formatHealth), so record raw counts. */
export function recordTitleScan(attempted: number, failed: number): void {
  state.titleAttempted = attempted;
  state.titleFailed = failed;
}

/** One consumed hook-event line, recorded by EventTail as a side effect of the read it
 *  already does (mirrors the format-canary scanners): `ok` ⟺ the line carried every
 *  REQUIRED field the consumer uses (a malformed line, or one missing session_id / the
 *  Notification message, is not ok). `legacy` ⟺ a healthy line that lacked the top-level
 *  `bridge` field the current SCRIPT_BODY writes (an old script is still feeding events).
 *  The ring is bounded to HOOK_WINDOW so a long-lived host can't grow it. */
export function recordHookHealth(ok: boolean, legacy = false): void {
  state.hookConsumed++;
  state.hookRing.push({ ok, legacy: ok && legacy });
  if (state.hookRing.length > HOOK_WINDOW) state.hookRing.shift();
}

// ---- Pruning (keep the maps bounded to live files) ------------------------------

export function pruneClaudeHealth(liveIds: Set<string>): void {
  for (const id of state.claude.keys()) if (!liveIds.has(id)) state.claude.delete(id);
  for (const id of claudeSrc.keys()) if (!liveIds.has(id)) claudeSrc.delete(id);
}

export function pruneCursorHealth(liveIds: Set<string>): void {
  for (const id of state.cursor.keys()) if (!liveIds.has(id)) state.cursor.delete(id);
  for (const id of cursorSrc.keys()) if (!liveIds.has(id)) cursorSrc.delete(id);
}

/** Drop codex health entries for rollout paths not scanned this tick — so a stale
 *  `failed` entry from a half-written/abandoned rollout that has since left the
 *  two-day scan window can't linger and latch `driftSuspected` forever. */
export function pruneCodexHealth(livePaths: Set<string>): void {
  for (const p of state.codex.keys()) if (!livePaths.has(p)) state.codex.delete(p);
}

/** Test-only: wipe all accumulated state so a suite starts clean. */
export function resetCanary(): void {
  Object.assign(state, emptyState());
  claudeSrc.clear();
  cursorSrc.clear();
}

// ---- The evaluators (pure) ------------------------------------------------------

function versionedReport(
  harness: Harness,
  label: string,
  map: Map<string, boolean>,
  ceiling: string,
  observed: string | undefined
): HarnessReport {
  let failed = 0;
  for (const ok of map.values()) if (!ok) failed++;
  const aboveCeiling = observed !== undefined && observed !== "" && compareVersions(observed, ceiling) > 0;
  return {
    harness,
    label,
    seen: map.size,
    failed,
    driftSuspected: failed >= DRIFT_MIN,
    observedVersion: observed,
    ceiling,
    aboveCeiling,
  };
}

/** Titles has no version field; its alarm needs the engine to be present, because a
 *  missing engine makes EVERY query return null (which would look like total drift).
 *  Only alarm when the engine is present AND every one of ≥2 queried DBs failed. */
function titlesReport(s: CanaryState, enginePresent: boolean): HarnessReport {
  const seen = s.titleAttempted;
  const failed = s.titleFailed;
  return {
    harness: "titles",
    label: "Editor title storage",
    seen,
    failed,
    driftSuspected: enginePresent && seen >= DRIFT_MIN && failed === seen,
    aboveCeiling: false,
  };
}

/** Evaluate the accumulator into a per-harness report. Pure over the given state,
 *  so tests feed a synthetic state directly. `enginePresent` gates only the titles
 *  alarm (see titlesReport). */
export function evaluate(s: CanaryState, enginePresent: boolean): FormatHealthReport {
  return {
    claude: versionedReport("claude", "Claude transcript", s.claude, KNOWN_CLAUDE_VERSION_CEILING, s.claudeVersion),
    codex: versionedReport("codex", "Codex rollout", s.codex, KNOWN_CODEX_VERSION_CEILING, s.codexVersion),
    cursor: versionedReport("cursor", "Cursor store", s.cursor, KNOWN_CURSOR_SCHEMA_CEILING, s.cursorSchema),
    titles: titlesReport(s, enginePresent),
  };
}

/** Evaluate the live module accumulator. */
export function formatHealth(enginePresent = true): FormatHealthReport {
  return evaluate(state, enginePresent);
}

/** Evaluate the hook-shape ring into a report. Pure over the given state, so tests feed
 *  a synthetic ring directly (like evaluate() above). Extra/unknown fields never count
 *  against health — only ABSENT required fields (or malformed JSON) do. */
export function hooksReport(s: CanaryState): HooksReport {
  const seen = s.hookRing.length;
  let failed = 0;
  let legacyScriptSuspected = false;
  for (const e of s.hookRing) {
    if (!e.ok) failed++;
    if (e.legacy) legacyScriptSuspected = true;
  }
  return {
    consumed: s.hookConsumed,
    seen,
    failed,
    driftSuspected: failed >= DRIFT_MIN,
    legacyScriptSuspected,
  };
}

/** Evaluate the live hook-shape accumulator. */
export function hooksHealth(): HooksReport {
  return hooksReport(state);
}

/** The label of the first harness (stable order) showing suspected drift, or
 *  undefined when every parser is healthy. Ceiling-exceeded alone is NOT drift —
 *  a new version is not a broken parser — so it never selects a harness here. */
export function driftHarness(r: FormatHealthReport): string | undefined {
  for (const h of [r.claude, r.codex, r.cursor, r.titles]) if (h.driftSuspected) return h.label;
  return undefined;
}

// ---- Drift → sanitized fixture capture ------------------------------------------
// When the canary alarm trips, the fastest way to fix a drifted parser is a committed
// fixture pinning the NEW shape (see docs/MAINTENANCE.md — "no historical-format
// support without a fixture"). This turns the alarm into a HEAD START on that artifact:
// it takes a small slice of each affected file and produces a machine-sanitized DRAFT.
//
// THE HONEST BAR. This is structure-preserving DESTRUCTION plus an automated privacy
// gate — NOT a semantic PII detector, and NOT a guarantee. Values are destroyed by the
// deny-by-default transform below (structure kept, content replaced), then the whole
// slice must clear personalDataLeak() (refuse-don't-write) before it is written. That
// gate is a backstop, not proof: a captured slice is a DRAFT a human MUST hand-audit
// before copying it into any public repo. The transform is hardened against the leak
// classes reachable with today's formats (third-party names, emails, foreign paths,
// secrets, drifted keys), but the hand-audit is the contract — the summary says so
// prominently, and this comment does not claim "nothing can survive".
//
// Everything here is PURE and vscode-/fs-free (like the evaluators above): the command
// in extension.ts reads the files and passes their TEXT in, so the seams below are
// unit-tested under bun with no IDE. Only the file-based harnesses have a slice shape
// (Claude tail / Codex head+tail JSONL, the decoded Cursor meta payload); the titles
// surface retains no per-file sample and is not capturable.

/** The three harnesses whose drift produces a capturable file slice. */
export type CaptureHarness = "claude" | "codex" | "cursor";

/** Runtime identity used only to REFUSE a slice that still leaks it (never to edit
 *  the slice — anonymization already destroyed content; this is the backstop grep). */
export interface CaptureIdentity {
  /** os.userInfo().username. */
  username?: string;
  /** os.homedir(). */
  homeDir?: string;
  /** os.hostname() — parity with the debug-report scrubber, which tokenizes it. */
  hostname?: string;
}

/** Source-file paths of the currently-affected (failed-parse) files for a harness,
 *  read straight off the live health maps — "the health map already knows them".
 *  Codex keys ARE rollout paths; Claude/Cursor resolve through the side maps. Only
 *  entries recorded with a path this session are returned. */
export function affectedSources(h: CaptureHarness): string[] {
  const out: string[] = [];
  if (h === "codex") {
    for (const [path, ok] of state.codex) if (!ok) out.push(path);
    return out;
  }
  const health = h === "claude" ? state.claude : state.cursor;
  const src = h === "claude" ? claudeSrc : cursorSrc;
  for (const [id, ok] of health) {
    if (ok) continue;
    const p = src.get(id);
    if (p !== undefined) out.push(p);
  }
  return out;
}

/** Lines kept in a JSONL tail slice — enough to carry a full last turn, small enough
 *  to hand-audit before committing. */
const SLICE_LINES = 20;
/** Head lines kept for Codex: the session_meta record (line 1) and the first turn's
 *  events live here, and Codex drift is a `parseHead` failure on session_meta — so a
 *  tail-only slice would MISS the drifted record on any rollout longer than the tail. */
const CODEX_HEAD_LINES = 6;

function nonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

function jsonlTail(text: string, maxLines: number): string {
  return nonEmptyLines(text).slice(-maxLines).join("\n");
}

/** Codex slice = HEAD (session_meta + first events, where drift lives) + TAIL (the last
 *  turn boundary, where finished-state lives). Both matter: the canary trips on the
 *  head, but the tail carries the event shapes. Short rollouts return every line once. */
function codexSlice(text: string): string {
  const lines = nonEmptyLines(text);
  if (lines.length <= CODEX_HEAD_LINES + SLICE_LINES) return lines.join("\n");
  return [...lines.slice(0, CODEX_HEAD_LINES), ...lines.slice(-SLICE_LINES)].join("\n");
}

/** Decode the Cursor store.db meta value (hex-encoded JSON, or raw JSON) into its
 *  compact JSON string. Mirrors cursor.ts's decodeMetaValue accept-both behavior.
 *  null when it neither decodes nor parses. */
export function extractCursorSlice(rawValue: string): string | null {
  let json = rawValue.trim();
  if (!json.startsWith("{")) {
    try {
      json = Buffer.from(rawValue, "hex").toString("utf8");
    } catch {
      return null;
    }
  }
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return null;
  }
}

/** The raw slice for a harness: a tail for Claude, head+tail for Codex (drift lives in
 *  the head session_meta), the decoded meta payload for Cursor. null/empty when there
 *  is nothing to slice. */
export function extractSlice(harness: CaptureHarness, rawText: string): string | null {
  if (harness === "cursor") return extractCursorSlice(rawText);
  const slice = harness === "codex" ? codexSlice(rawText) : jsonlTail(rawText, SLICE_LINES);
  return slice === "" ? null : slice;
}

// Anonymization policy — deny-by-default recursive JSON transform. The honest bar:
// this DESTROYS content structurally (it is not a semantic PII detector), and the
// captured slice is a machine-sanitized DRAFT that a human MUST hand-audit before it
// is copied into a public repo. The transform is built so a maintainer who skips the
// audit is still protected against the reachable-today leak classes, but the audit is
// the contract, not an optional nicety.
//
// Three rules make the default deny-by-default even when the vendor format has drifted:
//  1. VALUE-DOMAIN ON EVERY ALLOWLISTED KEY. Keeping a KEY never keeps an arbitrary
//     VALUE — under drift a vendor can repurpose an allowlisted key to carry free text,
//     so a kept value must additionally match the tight shape that key legitimately
//     holds (an enum token, a version, a tool identifier). Anything failing its domain
//     is destroyed like free text. (Closes: a renamed `source`/`name` smuggling PII.)
//  2. OBJECT KEYS ARE ANONYMIZED. Only allowlisted key NAMES survive verbatim (that is
//     the structure we preserve); every other key becomes a stable positional token
//     `k1`,`k2`,… A key is NEVER echoed into a value slot, so a map keyed by PII (e.g.
//     an email) can't leak as either key or value.
//  3. DESTRUCTION IS THE DEFAULT. ids → canonical token, paths → /home/user/project,
//     every other string → its OUTPUT key placeholder (an allowlisted name or `kN`,
//     never the raw input). Numbers/booleans/null carry no free text and pass through.

// Two allowlists, deliberately separate:
//
//  • STRUCT_KEYS — key NAMES kept verbatim. This is the curated VOCABULARY of the three
//    private formats' structural keys (containers the parsers traverse + discriminators
//    + leaf field names). Keeping a name only preserves SHAPE — the value is still run
//    through the value rules below. Any key NOT in this vocabulary (a PII data-key like
//    an email, OR a drifted brand-new field name) becomes a positional `k1`,`k2`,… and
//    is never echoed into a value. A drifted new key name is intentionally anonymized:
//    the maintainer reads the real new spelling from their LOCAL original during the
//    required hand-audit; the COMMITTED fixture needs correct shape + zero PII, not the
//    raw field name.
//  • KEEP_DOMAINS — the subset of STRUCT_KEYS whose VALUE may also survive, and ONLY
//    when it matches that key's tight shape (rule 1 of the header). `source`/`originator`
//    keep their NAME (shape) but never their value; Cursor `name` (a chat title) is
//    forced off-domain so its value is always destroyed.
const STRUCT_KEYS = new Set([
  // discriminators / versions (value-kept via KEEP_DOMAINS when in-domain)
  "type", "role", "operation", "stop_reason", "kind", "mode", "thread_source",
  "model_provider", "version", "cli_version", "name",
  // containers + leaves — NAME kept so parsers traverse; VALUE always destroyed here
  "message", "content", "payload", "input", "text", "thinking", "signature",
  "id", "uuid", "tool_use_id", "session_id", "last_agent_message",
  "cwd", "source", "originator", "timestamp", "git", "branch", "base_instructions",
]);

/** Allowlisted key → the value-domain its kept value must match. `source`/`originator`
 *  are deliberately ABSENT (name kept for shape, value never). */
type KeepDomain = "enum" | "version" | "name";
const KEEP_DOMAINS: Record<string, KeepDomain> = {
  type: "enum",
  role: "enum",
  operation: "enum",
  stop_reason: "enum",
  kind: "enum",
  mode: "enum",
  thread_source: "enum",
  model_provider: "enum",
  version: "version",
  cli_version: "version",
  name: "name",
};

/** The value-domain in force for a key on this harness — or undefined (value destroyed).
 *  Cursor's `name` is a free-text chat title, so it is forced off-domain. */
function keepDomainFor(harness: CaptureHarness, key: string): KeepDomain | undefined {
  if (harness === "cursor" && key === "name") return undefined;
  return KEEP_DOMAINS[key];
}

// Value-domain shapes. An enum token / version has no spaces, URLs, @ or punctuation a
// real discriminator would carry, so free text repurposed into an allowlisted key fails
// and is destroyed.
const ENUM_TOKEN_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const VERSION_RE = /^[0-9]+(\.[0-9]+){0,3}(-[0-9a-z.]+)?$/i;
// Tool name: an identifier — no spaces, no '@'. MCP names (mcp__server__tool) pass via
// `_`. A bare hostname/FQDN ALSO matches `[\w.-]` (prod-db-07.internal.acme.com), so a
// candidate with 2+ dots is only kept when it is the explicit mcp__ form; otherwise it
// is treated as a hostname and destroyed. (Real tool names are either dotless-ish or the
// mcp__ pattern; a multi-dot non-mcp value is not a legitimate tool name.)
const NAME_RE = /^[A-Za-z][\w.-]{0,63}$/;
const MCP_NAME_RE = /^mcp__[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*__[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/;

function valueInDomain(domain: KeepDomain, v: string): boolean {
  if (domain === "enum") return ENUM_TOKEN_RE.test(v);
  if (domain === "version") return VERSION_RE.test(v);
  // name
  if (!NAME_RE.test(v)) return false;
  // A real tool name is DOTLESS (Read, Bash) or the explicit mcp__ form. Any dot at all
  // in a non-mcp value means it's a dotted identifier we can't vouch for — a hostname
  // (db.internal), an FQDN, or a person handle (john.smith) — so destroy it.
  return !v.includes(".") || MCP_NAME_RE.test(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
// An absolute path in any of the shapes the repo's own scrubber recognizes.
const ABS_PATH_RE = /^([A-Za-z]:[\\/]|\/|\\{2})|\/home\//;

function isIdKey(key: string): boolean {
  const k = key.toLowerCase();
  return k === "uuid" || k.endsWith("id");
}

/** Transform one string value. `origKey` is its ORIGINAL key (drives keep/domain/id/path
 *  decisions); `outKey` is the placeholder used when the value is destroyed — a STRUCT
 *  name or a positional `kN`, so the RAW key is never echoed into a value slot. */
function anonString(harness: CaptureHarness, origKey: string | null, outKey: string | null, value: string): string {
  if (origKey !== null && STRUCT_KEYS.has(origKey)) {
    const domain = keepDomainFor(harness, origKey);
    if (domain !== undefined && valueInDomain(domain, value)) return value; // structural + shape-valid
    // fell through: a structural key whose value is free text / off-domain → destroy it.
  }
  if (origKey !== null && isIdKey(origKey)) return UUID_RE.test(value) ? ZERO_UUID : "id";
  if (origKey === "cwd") return "/home/user/project";
  if (ABS_PATH_RE.test(value)) return "/home/user/project/file";
  return outKey ?? "text"; // free text → output-key placeholder; content destroyed
}

function anonValue(harness: CaptureHarness, origKey: string | null, outKey: string | null, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => anonValue(harness, null, null, v));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    let ki = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // STRUCT key names are the shape we keep; every other key → a PER-OBJECT positional
      // token k1,k2,… (PII data-keys and drifted names both anonymized). The counter
      // resets per object, so k1 in one record is unrelated to k1 in another — the token
      // marks POSITION within its object, not a stable identity across records. The key
      // is never used as a value.
      const ok = STRUCT_KEYS.has(k) ? k : `k${++ki}`;
      out[ok] = anonValue(harness, k, ok, v);
    }
    return out;
  }
  if (typeof value === "string") return anonString(harness, origKey, outKey, value);
  return value; // numbers / booleans / null carry no free text
}

/** Anonymize a raw slice. JSONL harnesses are transformed line-by-line (unparseable
 *  lines dropped); the Cursor payload is transformed as a single object and
 *  pretty-printed. Throws only if a JSONL slice has NO parseable line. */
export function anonymizeSlice(harness: CaptureHarness, slice: string): string {
  if (harness === "cursor") {
    return JSON.stringify(anonValue(harness, null, null, JSON.parse(slice)), null, 2);
  }
  const out: string[] = [];
  for (const line of slice.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.stringify(anonValue(harness, null, null, JSON.parse(line))));
    } catch {
      /* a truncated head-of-tail line — drop it */
    }
  }
  return out.join("\n");
}

/** True when the anonymized slice is WELL-FORMED (every JSONL line parses as JSON;
 *  the Cursor payload is a JSON object) with at least one record. It deliberately does
 *  NOT require the current `type`/schema shape: discriminator drift — a renamed or
 *  removed `type` — is the exact failure that trips the canary, so the drifted file
 *  the maintainer most needs to capture would otherwise be refused for not matching
 *  the OLD schema. The anonymizer preserves the NEW shape's keys/nesting (only string
 *  VALUES are destroyed), so a well-formed slice is a usable head start on the fixture
 *  regardless of how the vendor moved the discriminator. */
function wellFormed(harness: CaptureHarness, text: string): boolean {
  if (harness === "cursor") {
    try {
      const o = JSON.parse(text) as unknown;
      return o !== null && typeof o === "object";
    } catch {
      return false;
    }
  }
  let records = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      JSON.parse(line);
    } catch {
      return false;
    }
    records++;
  }
  return records > 0;
}

function hexOf(s: string): string {
  return Buffer.from(s, "utf8").toString("hex").toLowerCase();
}

// The anonymizer's OWN canonical outputs — stripped before the generic shape checks so
// a sanitized path placeholder isn't misread as a leaked absolute path.
const CANON_PATH_RE = /\/home\/user\/project(\/file)?/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// A residual absolute path of ANY user (POSIX, Windows drive, UNC, file://) after the
// canonical placeholder is removed. A legit sanitized slice has no other absolute path.
const FOREIGN_PATH_RE = /file:\/\/|[A-Za-z]:[\\/]|\\{2}[A-Za-z]|\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]/;
// A high-entropy secret-ish run: 24+ contiguous base64-alphabet chars. Underscores,
// dots and dashes are OUTSIDE the class, so mcp__ names, dotted versions and dash-broken
// uuids can't reach 24 — only an actual key/token/hash blob does.
const LONG_TOKEN_RE = /[A-Za-z0-9+/]{24,}/;

/** The privacy bar — the automated gate a captured slice must clear before it is
 *  written (refuse-don't-write). It is INTENTIONALLY stricter than the hand-fixture
 *  guard in fixtures.test.ts, because for MACHINE capture the grep is the last line of
 *  defense, not a human. It refuses on: this machine's username / home path / hostname
 *  (incl. hex forms — parity with the debug-report scrubber), and generic third-party
 *  PII shapes — email addresses, any foreign absolute path, and long secret-like tokens.
 *  Returns a short label of the FIRST leak, or undefined when clean. NOT a guarantee of
 *  no PII: it is a backstop under the required hand-audit, not a replacement for it. */
export function personalDataLeak(text: string, ctx: CaptureIdentity): string | undefined {
  const lower = text.toLowerCase();
  const user = ctx.username;
  if (user !== undefined && user.length >= 3) {
    if (lower.includes(user.toLowerCase())) return "username";
    if (lower.includes(hexOf(user))) return "hex-encoded username";
  }
  const home = ctx.homeDir;
  if (home !== undefined && home !== "") {
    const norm = home.replace(/\\/g, "/");
    if (text.includes(home) || text.includes(norm)) return "home path";
    if (lower.includes(hexOf(home)) || lower.includes(hexOf(norm))) return "hex-encoded home path";
  }
  const host = ctx.hostname;
  if (host !== undefined && host.length >= 3) {
    if (lower.includes(host.toLowerCase())) return "hostname";
    if (lower.includes(hexOf(host))) return "hex-encoded hostname";
  }
  // Generic third-party PII shapes (not tied to this machine). Strip the anonymizer's
  // own canonical path placeholders first so they aren't misread as foreign paths.
  const probe = text.replace(CANON_PATH_RE, " ");
  if (EMAIL_RE.test(probe)) return "email address";
  if (FOREIGN_PATH_RE.test(probe)) return "absolute path";
  if (LONG_TOKEN_RE.test(probe)) return "long token / secret";
  return undefined;
}

/** The committed-fixture filename a captured slice should be copied to. Mirrors the
 *  names in test/fixtures/; a second+ file of the same harness gets an index suffix. */
export function fixtureName(harness: CaptureHarness, index = 0): string {
  const base =
    harness === "claude" ? "claude-transcript" : harness === "codex" ? "codex-rollout" : "cursor-store-meta0";
  const ext = harness === "cursor" ? "json" : "jsonl";
  return index === 0 ? `${base}.${ext}` : `${base}-${index + 1}.${ext}`;
}

export interface CaptureSlice {
  filename: string;
  content: string;
}

/** Extract → anonymize → structural-parse check → privacy guard, for one file's raw
 *  text. Returns the sanitized slice, or a reason it was refused. Never returns a
 *  slice that fails the privacy bar or lost its structure — the caller writes only
 *  `ok` results. Pure: same input → same output. */
export function captureFixtureSlice(
  harness: CaptureHarness,
  rawText: string,
  ctx: CaptureIdentity,
  index = 0
): { ok: true; slice: CaptureSlice } | { ok: false; reason: string } {
  const slice = extractSlice(harness, rawText);
  if (slice === null || slice.trim() === "") return { ok: false, reason: "no parseable records to slice" };
  let anon: string;
  try {
    anon = anonymizeSlice(harness, slice);
  } catch {
    return { ok: false, reason: "slice did not parse as JSON" };
  }
  if (anon.trim() === "") return { ok: false, reason: "nothing survived anonymization" };
  if (!wellFormed(harness, anon)) return { ok: false, reason: "anonymized slice was not well-formed JSON" };
  const leak = personalDataLeak(anon, ctx);
  if (leak !== undefined) return { ok: false, reason: `${leak} survived anonymization — refused` };
  return { ok: true, slice: { filename: fixtureName(harness, index), content: anon } };
}

/** The read-only summary doc written beside the captured slices: what was captured,
 *  how it was sanitized, and exactly where to put it when filing a drift report. */
export function buildCaptureSummary(
  harnessLabel: string,
  scratchDir: string,
  written: string[],
  refused: Array<{ source: string; reason: string }>
): string {
  const lines: string[] = [
    "SessionDeck — Drift Fixture Capture",
    "================================",
    "",
    `Harness with suspected drift: ${harnessLabel}`,
    `Scratch folder: ${scratchDir}`,
    "",
    "*** HAND-AUDIT REQUIRED BEFORE PUBLISHING ***",
    "These slices are a MACHINE-SANITIZED DRAFT, not a guarantee. Read every captured",
    "file yourself and confirm it carries no personal or third-party data before you",
    "copy it into a public repo. The anonymizer destroys content structurally and an",
    "automated gate refuses obvious leaks, but neither replaces your eyes.",
    "",
    "File the SLICE FILES only — NOT this summary. This summary names your local",
    "scratch-folder path (your machine), so never paste it wholesale into a public issue.",
    "",
    "The format canary tripped: the required structure was absent across ≥2 files, so",
    "this vendor format has likely drifted. Each slice is a head start on the regression",
    "fixture that pins the new shape (docs/MAINTENANCE.md: no historical-format support",
    "without a fixture).",
    "",
    "How each slice was sanitized (deny-by-default — structure kept, content destroyed):",
    "  • absolute paths          → /home/user/project",
    "  • ids / uuids             → canonical zero token",
    "  • structural key NAMES kept (type, role, message, …); every OTHER key → k1,k2,…",
    "  • allowlisted values kept ONLY if shape-valid (enum/version/tool-name); anything",
    "    else — prompts, messages, thinking, tool inputs, chat/branch names — destroyed",
    "  • a drifted NEW field name is anonymized to kN: restore its real spelling from",
    "    the LOCAL original during your audit before the fixture will parse",
    "",
    "Automated gate (refuse-don't-write): each slice was checked for your username, home",
    "path and hostname (incl. hex forms) AND generic third-party PII shapes (emails,",
    "foreign absolute paths, secret-like tokens). A slice that failed was not written.",
    "",
  ];
  if (written.length > 0) {
    lines.push(`Captured ${written.length} slice(s) — after hand-audit, copy into test/fixtures/ when filing:`);
    for (const f of written) lines.push(`  • ${f}`);
    lines.push("");
    lines.push("Then re-run the fixture lock to confirm the new shape parses + stays clean:");
    lines.push("  bun test test/fixtures.test.ts");
    lines.push("");
    lines.push("Note: cursor-store-meta0.json holds the DECODED payload; decodeMetaValue()");
    lines.push("accepts raw JSON directly, so it can back a fixture as-is (or re-hex it).");
  } else {
    lines.push("No slice could be captured (see refusals below).");
  }
  if (refused.length > 0) {
    lines.push("");
    lines.push(`Refused ${refused.length} file(s):`);
    for (const r of refused) lines.push(`  • ${r.source}: ${r.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}
