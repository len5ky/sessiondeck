// Claude Code config-home discovery. A "config home" is a directory Claude Code
// keeps its state in (sessions/, projects/, settings.json, .credentials.json …).
// The default is ~/.claude, but users select others via CLAUDE_CONFIG_DIR or a
// HOME override, so the extension must find every home that has live sessions.
// Pure Node module (no vscode import) so it is testable outside the IDE.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { procCensus, type ClaudeProc } from "./procs";

export interface ConfigHome {
  dir: string;
  label: string;
}

/** basename of the dir, unless that is ".claude" (then the parent's basename). */
function configDirLabel(dir: string): string {
  const base = basename(dir);
  return base === ".claude" ? basename(dirname(dir)) : base;
}

function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function envMap(raw: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const kv of raw.split("\0")) {
    const i = kv.indexOf("=");
    if (i > 0) m.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return m;
}

/** Derive one claude process's config home from its environ (CLAUDE_CONFIG_DIR ??
 *  $HOME/.claude), or null when the environ names neither. Same per-pid logic
 *  scanProcHomes used before the census absorbed the /proc sweep. Exported as the
 *  label-derivation seam so the `.claude`-suffix special case is directly tested. */
export function homeOf(proc: ClaudeProc): ConfigHome | null {
  const env = envMap(proc.environ);
  const ccd = env.get("CLAUDE_CONFIG_DIR");
  if (ccd !== undefined && ccd !== "") return { dir: ccd, label: configDirLabel(ccd) };
  const home = env.get("HOME");
  if (home !== undefined && home !== "") return { dir: join(home, ".claude"), label: basename(home) };
  return null;
}

/** Config homes auto-detected from running claude processes. Now an adapter over
 *  the shared /proc census (procs.ts) instead of an independent sweep: the census
 *  supplies the claude-classified pids + their environs on one 30s TTL, and this
 *  maps each to its config home. On a census that could not enumerate /proc
 *  (`listed:false` — a transient read error) the last good set is kept, exactly as
 *  scanProcHomes's null-retry did; a successful empty census clears it. */
let lastProcHomes: ConfigHome[] = [];
function procHomes(): ConfigHome[] {
  if (process.platform !== "linux") return [];
  const census = procCensus();
  if (!census.listed) return lastProcHomes; // keep last-good over a transient failure
  const out: ConfigHome[] = [];
  for (const proc of census.claude) {
    const home = homeOf(proc);
    if (home !== null) out.push(home);
  }
  lastProcHomes = out;
  return out;
}

/** All config homes to scan, in priority order, deduped by realpath (first wins,
 *  keeps its label). Sources: default ~/.claude, this process's CLAUDE_CONFIG_DIR,
 *  the extraConfigDirs setting, and Linux /proc auto-detect of running sessions. */
export function detectConfigHomes(extraDirs: string[]): ConfigHome[] {
  const candidates: ConfigHome[] = [{ dir: join(homedir(), ".claude"), label: "main" }];
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir !== undefined && envDir !== "") candidates.push({ dir: envDir, label: configDirLabel(envDir) });
  for (const d of extraDirs) {
    const dir = expandTilde(d);
    candidates.push({ dir, label: configDirLabel(dir) });
  }
  candidates.push(...procHomes());

  const homes: ConfigHome[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!existsSync(c.dir)) continue;
    let real: string;
    try {
      real = realpathSync(c.dir);
    } catch {
      real = c.dir;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    homes.push({ dir: real, label: c.label });
  }
  return homes;
}
