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
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Run a single read-only SELECT against `dbPath` and return its rows as
 * stringified columns (NULL → ""), or `null` when no engine is available or the
 * read fails. WAL-safe: the DB (+ -wal/-shm) is snapshotted into a private tmp
 * dir first, so the live DB is never locked. Never throws.
 */
export async function sqliteSelect(dbPath: string, sql: string): Promise<string[][] | null> {
  let tmpDir: string | undefined;
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
    const viaNode = readViaNodeSqlite(copy, sql);
    if (viaNode !== null) return viaNode;
    return await readViaPython(copy, sql);
  } catch {
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
 *  Electron/Node lacks the module) or on any read error. */
function readViaNodeSqlite(dbPath: string, sql: string): string[][] | null {
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
  } catch {
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

/** Fallback engine: async python3 one-shot (5s timeout). Never rejects. */
function readViaPython(dbPath: string, sql: string): Promise<string[][] | null> {
  return new Promise((resolve) => {
    execFile(
      "python3",
      ["-c", PY_SELECT, dbPath, sql],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err !== null) {
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
