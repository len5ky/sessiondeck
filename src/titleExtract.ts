// SHARED SOURCE — imported directly by both the main extension and the bridge
// companion (bundled via `bun build`); there is no byte-copy. Edit here only.
//
// Extracts real Claude panel tab titles ("Fix login bug" instead of
// "myproject-3f") from a VS Code / Cursor / VSCodium `workspaceStorage` tree.
// The Claude extension serializes each panel's {title, state.sessionID} into the
// editor layout memento stored in every workspace's `state.vscdb`. We read that
// row and DFS the layout for webview inputs whose viewType names claudeVSCodePanel.
//
// vscode-free, Node builtins + ./sqliteRead only, so it bundles cleanly into the
// zero-dep "ui" companion. Do NOT import vscode or any other repo module here.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { sqliteSelect } from "./sqliteRead";

export interface ComposerEnumSession {
  composerId: string;
  name: string;
  mode: string;
  lastUpdatedAt: number;
  createdAt: number;
  hasUnread: boolean;
  todos: number;
}

export interface ComposerEnumResult {
  sessions: ComposerEnumSession[];
  gen: string;
  engine: boolean;
}

interface SqliteStatement {
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

interface ComposerHeader {
  composerId: string;
  name: string;
  unifiedMode: string;
  lastUpdatedAt: number;
  createdAt: number;
  hasUnreadMessages: boolean;
}

/** Read Cursor's small global Composer header index directly, never copying the DB. */
export function readComposerEnumeration(
  globalDbPath: string,
  opts: { recentDays?: number; cap?: number; prevGen?: string } = {},
): ComposerEnumResult {
  let db: SqliteDatabase | undefined;
  try {
    const sqlite = require("node:sqlite") as SqliteModule;
    try {
      db = new sqlite.DatabaseSync(`file:${globalDbPath}?mode=ro&immutable=1`);
    } catch {
      db = new sqlite.DatabaseSync(globalDbPath, { readOnly: true });
    }
    const row = db.prepare("SELECT value FROM ItemTable WHERE key='composer.composerHeaders'").get();
    const value = recordString(row, "value");
    if (value === undefined) return { sessions: [], gen: "", engine: true };
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || !Array.isArray(parsed.allComposers)) {
      return { sessions: [], gen: "", engine: true };
    }
    const recentDays = finiteNonNegative(opts.recentDays, 14);
    const cap = Math.min(50, Math.floor(finiteNonNegative(opts.cap, 50)));
    const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;
    const headers = parsed.allComposers
      .map(composerHeader)
      .filter((h): h is ComposerHeader => h !== null && h.lastUpdatedAt >= cutoff)
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
      .slice(0, cap);
    const gen = fnv1a(headers.map((h) => `${h.composerId}:${h.lastUpdatedAt}`).join("|"));
    const body = db.prepare("SELECT value FROM cursorDiskKV WHERE key=?");
    const sessions = headers.map((h): ComposerEnumSession => ({
      composerId: h.composerId,
      name: h.name,
      mode: h.unifiedMode,
      lastUpdatedAt: h.lastUpdatedAt,
      createdAt: h.createdAt,
      hasUnread: h.hasUnreadMessages,
      todos: todoCount(body, h.composerId),
    }));
    return { sessions, gen, engine: true };
  } catch {
    return { sessions: [], gen: "", engine: false };
  } finally {
    try { db?.close(); } catch { /* fail-soft close */ }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function composerHeader(value: unknown): ComposerHeader | null {
  if (!isRecord(value) || typeof value.composerId !== "string" || value.composerId === "") return null;
  if (typeof value.lastUpdatedAt !== "number" || !Number.isFinite(value.lastUpdatedAt)) return null;
  return {
    composerId: value.composerId,
    name: typeof value.name === "string" ? value.name : "",
    unifiedMode: typeof value.unifiedMode === "string" ? value.unifiedMode : "",
    lastUpdatedAt: value.lastUpdatedAt,
    createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : 0,
    hasUnreadMessages: value.hasUnreadMessages === true,
  };
}

function todoCount(statement: SqliteStatement, composerId: string): number {
  try {
    const value = recordString(statement.get(`composerData:${composerId}`), "value");
    if (value === undefined) return 0;
    const body: unknown = JSON.parse(value);
    return isRecord(body) && Array.isArray(body.todos) ? body.todos.length : 0;
  } catch {
    return 0;
  }
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Constant, trusted SQL (never remote-derived).
const EDITOR_MEMENTO_SQL =
  "SELECT value FROM ItemTable WHERE key='memento/workbench.parts.editor'";
const MAX_DBS = 200;

interface DbCacheEntry {
  mtimeMs: number;
  titles: Record<string, string>;
}
// Module-level bounded cache: unchanged DBs (by mtime) are not re-read; the map
// is pruned to only the DBs seen in the latest call, so it stays ≤ MAX_DBS.
const cache = new Map<string, DbCacheEntry>();

// Format-canary: stats from the LAST extractPanelTitles pass — `attempted` = DBs
// actually queried this scan (cache misses only), `queryFailed` = of those, how
// many had the required SELECT return null (the editor-title-storage drift signal).
// Read by the caller (see titles.ts), which gates the alarm on engine presence.
// No canary import here — this file is auto-copied verbatim into the zero-dep
// bridge companion, so it must stay self-contained.
export const titleScanStats = { attempted: 0, queryFailed: 0 };

/**
 * Enumerate `<workspaceStorageRoot>/<ws>/state.vscdb`, extract sessionID→title
 * for every Claude panel found across all workspaces. Bounded: at most the
 * MAX_DBS most-recently-modified DBs are scanned, and unchanged DBs are served
 * from cache. Returns {} on any enumeration failure; never throws.
 */
export async function extractPanelTitles(
  workspaceStorageRoot: string
): Promise<Record<string, string>> {
  let entries: string[];
  try {
    entries = await readdir(workspaceStorageRoot);
  } catch {
    return {};
  }

  // Collect candidate DBs with their mtimes for the newest-first cap.
  const candidates: Array<{ db: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const db = join(workspaceStorageRoot, entry, "state.vscdb");
    try {
      const st = await stat(db);
      if (st.isFile() && st.size > 0) candidates.push({ db, mtimeMs: st.mtimeMs });
    } catch {
      /* not a workspace dir / no state.vscdb — skip */
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scan = candidates.slice(0, MAX_DBS);

  const result: Record<string, string> = {};
  const nextCache = new Map<string, DbCacheEntry>();
  let attempted = 0;
  let queryFailed = 0;
  for (const { db, mtimeMs } of scan) {
    const cached = cache.get(db);
    let titles: Record<string, string>;
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      titles = cached.titles;
    } else {
      // Only a real query (cache miss) counts toward the drift stats.
      attempted++;
      const one = await extractOne(db);
      titles = one.titles;
      if (one.queryFailed) queryFailed++;
    }
    nextCache.set(db, { mtimeMs, titles });
    Object.assign(result, titles);
  }
  // Replace the cache with only the DBs we just scanned (bounds its size).
  cache.clear();
  for (const [db, entry] of nextCache) cache.set(db, entry);

  titleScanStats.attempted = attempted;
  titleScanStats.queryFailed = queryFailed;
  return result;
}

/** Extract titles from one DB. `queryFailed` is true only when the required SELECT
 *  returned null (engine present but the row/table shape did not answer) — an empty
 *  result (no Claude panel in this workspace) is a normal miss, not a failure. */
async function extractOne(db: string): Promise<{ titles: Record<string, string>; queryFailed: boolean }> {
  const rows = await sqliteSelect(db, EDITOR_MEMENTO_SQL);
  if (rows === null) return { titles: {}, queryFailed: true };
  if (rows.length === 0) return { titles: {}, queryFailed: false };
  const value = rows[0][0];
  // The query answered (not a drift failure); parse the memento for Claude panels.
  return { titles: value === undefined ? {} : titlesFromMemento(value), queryFailed: false };
}

/** Pure: DFS a `memento/workbench.parts.editor` value for Claude-panel webview
 *  inputs, returning sessionID→title. `{}` for any value that isn't a Claude-bearing
 *  editor layout. Exported as the structural seam the format-canary fixture locks. */
export function titlesFromMemento(value: string): Record<string, string> {
  // Cheap pre-filter: skip parsing layouts that can't contain a Claude panel.
  if (value === "" || !value.includes("claudeVSCodePanel")) return {};

  let state: unknown;
  try {
    state = JSON.parse(value);
  } catch {
    return {};
  }

  const out: Record<string, string> = {};
  const stack: unknown[] = [state];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    const rec = node as Record<string, unknown>;
    if (rec.id === "workbench.editors.webviewInput") collectWebviewInput(rec, out);
    for (const v of Object.values(rec)) stack.push(v);
  }
  return out;
}

function collectWebviewInput(rec: Record<string, unknown>, out: Record<string, string>): void {
  try {
    const w = JSON.parse(typeof rec.value === "string" ? rec.value : "{}") as Record<string, unknown>;
    const viewType = typeof w.viewType === "string" ? w.viewType : "";
    if (!viewType.includes("claudeVSCodePanel")) return;
    const stateStr = typeof w.state === "string" && w.state !== "" ? w.state : "{}";
    const s = JSON.parse(stateStr) as Record<string, unknown>;
    const sid = s.sessionID;
    const title = w.title;
    if (typeof sid === "string" && sid !== "" && typeof title === "string" && title !== "") {
      out[sid] = title;
    }
  } catch {
    /* malformed serialized input — ignore this node */
  }
}
