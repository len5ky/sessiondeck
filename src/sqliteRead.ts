// SHARED SOURCE — imported directly by both the main extension and the bridge
// companion (bundled via `bun build`); there is no byte-copy. Edit here only.
//
// Minimal, dependency-free, vscode-free read-only SQLite reader. Node builtins
// only, so it bundles cleanly into the "ui" companion extension (which must stay
// zero runtime deps). Do NOT import vscode or any repo module here — it would
// pull a non-bundleable dependency into the companion.
//
// SECURITY: callers pass only CONSTANT / TRUSTED SQL (never remote-derived
// strings). sqliteSelect runs a single read-only SELECT and returns rows of
// stringified columns; it never mutates the source DB (it reads a private copy)
// and never throws.
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Why a read failed, receiving one short line per engine that failed. The line
 *  carries the error's message only: the database path and the private copy's
 *  path are replaced with "the database" / "the copy", and any other absolute
 *  path with "<path>", so it is safe for Output > SessionDeck. */
export type SqliteErrorSink = (reason: string) => void;

/**
 * Run a single read-only SELECT against `dbPath` and return its rows as
 * stringified columns (NULL → ""), or `null` when no engine is available or the
 * read fails. WAL-safe: the DB (+ -wal/-shm) is snapshotted into a private tmp
 * dir first, so the live DB is never locked. Never throws. `onError`, when given,
 * hears why a `null` came back (see SqliteErrorSink).
 */
export async function sqliteSelect(dbPath: string, sql: string, onError?: SqliteErrorSink): Promise<string[][] | null> {
  let tmpDir: string | undefined;
  const reasons: string[] = [];
  const report = (stage: string, err: unknown): void => {
    reasons.push(`${stage}: ${errorReason(err, [[dbPath, "the database"], [tmpDir, "the copy"]])}`);
  };
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "sessiondeck-sql-"));
    const copy = join(tmpDir, "db");
    await copyFile(dbPath, copy);
    // The DB may be in WAL mode: uncommitted rows live in -wal, so copy the
    // sidecars too. Absent sidecars are fine (non-WAL or already checkpointed).
    for (const ext of ["-wal", "-shm"]) {
      try {
        await copyFile(dbPath + ext, copy + ext);
      } catch {
        /* sidecar absent — ignore */
      }
    }
    // Engine order: (1) native node:sqlite (fast, no subprocess), (2) python3
    // one-shot, (3) give up.
    const viaNode = readViaNodeSqlite(copy, sql, report);
    if (viaNode !== null) return viaNode;
    const viaPython = await readViaPython(copy, sql, report);
    if (viaPython === null && onError !== undefined) onError(reasons.join("; ") || "no SQLite engine answered");
    return viaPython;
  } catch (err) {
    report("copy", err);
    if (onError !== undefined) onError(reasons.join("; "));
    return null;
  } finally {
    if (tmpDir !== undefined) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/** sqliteSelect, tried once more after `retryDelayMs` when the first read fails
 *  (a copy can catch a live database mid-checkpoint); a missing database is read
 *  once, with no retry and no wait. Each failure is told to
 *  `log` as one line without paths (see SqliteErrorSink). Never throws. */
export async function sqliteSelectRetry(
  dbPath: string,
  sql: string,
  retryDelayMs: number,
  log: (line: string) => void = () => undefined
): Promise<string[][] | null> {
  // A database that isn't there won't be there in a moment either: no retry.
  if (!existsSync(dbPath)) return sqliteSelect(dbPath, sql, (r) => log(`read failed (${r})`));
  const first = await sqliteSelect(dbPath, sql, (r) => log(`read failed (${r}); retrying once`));
  if (first !== null) return first;
  if (!existsSync(dbPath)) return null;
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  return sqliteSelect(dbPath, sql, (r) => log(`read failed again (${r})`));
}

/** A known path as a pattern: either separator, any case (Windows paths). */
function knownPathPattern(path: string): RegExp {
  const body = path
    .split(/[\\/]+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]+");
  return new RegExp(body, "gi");
}

// An absolute path not in quotes: a drive letter, a UNC or \\wsl.localhost root,
// a POSIX root, ~/ or a file:// URL. It runs to the end of the line: a Windows
// user folder may hold spaces and parentheses, so any shorter stop could leave
// part of a user name behind, and losing the rest of the message is acceptable. A "/" right after a word character or
// "<" (the copy/db, <path>/x) is not a root.
const UNQUOTED_PATH = /(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|~[\\/]|(?<![\w<>~.])\/)[^\n]*/g;

/** One line for a failed read: the error's code and first message line, with
 *  `known` paths named, every quoted segment holding a path separator replaced by
 *  <path> as a whole, and every other absolute path replaced. No fragment of a
 *  user path survives. Never throws. */
export function errorReason(err: unknown, known: ReadonlyArray<readonly [string | undefined, string]> = []): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const [path, name] of known) {
    if (path !== undefined && path !== "") msg = msg.replace(knownPathPattern(path), name);
  }
  msg = (msg.split("\n")[0] ?? "")
    .replace(/'[^'\n]*[\\/][^'\n]*'/g, "'<path>'")
    .replace(/"[^"\n]*[\\/][^"\n]*"/g, '"<path>"')
    .replace(/`[^`\n]*[\\/][^`\n]*`/g, "`<path>`")
    .replace(UNQUOTED_PATH, "<path>")
    .trim();
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";
  const line = code !== "" && !msg.includes(code) ? `${code} ${msg}` : msg;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line || "unknown error";
}

/** Does `dbPath` or one of its sidecars hold `text` as raw bytes? SQLite stores a
 *  short TEXT key contiguously inside its page, so "no" means no row has that
 *  key (stale bytes in free pages can only make it say "yes"). The sidecars
 *  (-wal, then the rollback -journal) are scanned before the main file, so a
 *  checkpoint that moves rows from a sidecar into the main file can't slip
 *  between the scans. A missing sidecar adds nothing. `true` as soon as any file
 *  holds it; `undefined` when any file failed to read (or the main file is
 *  missing); `false` only when every file was read in full without a match.
 *  Streams each file, so a large database is never held in memory. Never rejects. */
export async function dbFilesContain(dbPath: string, text: string): Promise<boolean | undefined> {
  const needle = Buffer.from(text, "utf8");
  let unreadable = false;
  for (const ext of ["-wal", "-journal"]) {
    const r = await fileContains(dbPath + ext, needle);
    if (r === true) return true;
    if (r === "error") unreadable = true;
  }
  const main = await fileContains(dbPath, needle);
  if (main === true) return true;
  if (main !== false || unreadable) return undefined;
  return false;
}

/** Scan one file for `needle`: true / false, "missing" (ENOENT) or "error". */
function fileContains(path: string, needle: Buffer): Promise<boolean | "missing" | "error"> {
  return new Promise((resolve) => {
    let carry = Buffer.alloc(0);
    let done = false;
    const finish = (v: boolean | "missing" | "error"): void => {
      if (done) return;
      done = true;
      stream.destroy();
      resolve(v);
    };
    const stream = createReadStream(path, { highWaterMark: 1 << 20 });
    stream.on("data", (chunk) => {
      const buf = Buffer.concat([carry, chunk as Buffer]);
      if (buf.includes(needle)) return finish(true);
      carry = buf.subarray(Math.max(0, buf.length - (needle.length - 1)));
    });
    stream.on("end", () => finish(false));
    stream.on("error", (err: NodeJS.ErrnoException) => finish(err.code === "ENOENT" ? "missing" : "error"));
  });
}

/** Is the built-in node:sqlite engine loadable in this runtime? (read-only probe
 *  for the Setup Doctor — the same require + shape check readViaNodeSqlite uses). */
export function hasNodeSqlite(): boolean {
  try {
    return isNodeSqliteModule(require("node:sqlite"));
  } catch {
    return false;
  }
}

/** Is a `python3` on PATH (the SQLite fallback engine)? Runs `python3 --version`
 *  with a short timeout; never rejects. */
export function hasPython3(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("python3", ["--version"], { timeout: 3_000 }, (err) => resolve(err === null));
  });
}

interface StatementSyncLike {
  all(): Array<Record<string, unknown>>;
}
interface DatabaseSyncLike {
  prepare(sql: string): StatementSyncLike;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
}

function isNodeSqliteModule(m: unknown): m is NodeSqliteModule {
  return (
    typeof m === "object" &&
    m !== null &&
    typeof (m as { DatabaseSync?: unknown }).DatabaseSync === "function"
  );
}

function stringifyCol(c: unknown): string {
  return c === null || c === undefined ? "" : String(c);
}

/** Try the built-in node:sqlite engine. Returns null when unavailable (older
 *  Electron/Node lacks the module) or on any read error (told to `report`). */
function readViaNodeSqlite(dbPath: string, sql: string, report: (stage: string, err: unknown) => void): string[][] | null {
  let mod: NodeSqliteModule;
  try {
    // Dynamic require (not a top-level import) so a runtime without node:sqlite
    // degrades to the python fallback instead of failing to load this module.
    const loaded: unknown = require("node:sqlite");
    if (!isNodeSqliteModule(loaded)) return null;
    mod = loaded;
  } catch {
    return null;
  }
  let db: DatabaseSyncLike | undefined;
  try {
    db = new mod.DatabaseSync(dbPath);
    const rows = db.prepare(sql).all();
    return rows.map((row) => Object.values(row).map(stringifyCol));
  } catch (err) {
    report("node:sqlite", err);
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

// One-shot python reader: connects to the copied DB, runs the SELECT passed as
// argv[2] (never interpolated into the script), prints JSON rows with NULL → "".
const PY_SELECT = `
import sqlite3, json, sys
con = sqlite3.connect(sys.argv[1])
try:
    rows = con.execute(sys.argv[2]).fetchall()
finally:
    con.close()
print(json.dumps([["" if c is None else str(c) for c in r] for r in rows]))
`;

/** Fallback engine: async python3 one-shot (5s timeout). Never rejects. A failure
 *  is told to `report` with python's last stderr line (the sqlite3 error). */
function readViaPython(
  dbPath: string,
  sql: string,
  report: (stage: string, err: unknown) => void = () => undefined
): Promise<string[][] | null> {
  return new Promise((resolve) => {
    execFile(
      "python3",
      ["-c", PY_SELECT, dbPath, sql],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err !== null) {
          const last = String(stderr ?? "").trim().split("\n").pop() ?? "";
          const e = err as NodeJS.ErrnoException;
          report("python3", e.code === "ENOENT" ? "python3 not found" : last !== "" ? last : err);
          resolve(null);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (!Array.isArray(parsed)) {
            resolve(null);
            return;
          }
          const rows: string[][] = [];
          for (const r of parsed) {
            if (!Array.isArray(r)) {
              resolve(null);
              return;
            }
            rows.push(r.map(stringifyCol));
          }
          resolve(rows);
        } catch {
          resolve(null);
        }
      }
    );
  });
}
