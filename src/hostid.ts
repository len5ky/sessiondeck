// Host identity (plan §3): a stable, IDE-independent id per host, persisted at
// ~/.local/state/claude-overview/host.json on every platform. vscode-free —
// Node builtins only; synchronous fs is fine because this runs once at
// activation. Cursor and VS Code windows on the same host share the id, so it
// must never be derived from the process/IDE — only from this on-disk file.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { BridgePlatform, HOST_ID_RE } from "./bridgeSchema";

const HOST_JSON_V = 1;

export interface HostIdentity {
  id: string;
  label?: string;
  hostname: string;
  platform: BridgePlatform;
}

interface HostFile {
  v: number;
  id: string;
  label: string | null;
  createdAt: number;
}

/** Default state dir — the same directory Claude Code's hooks already use. */
function defaultStateDir(): string {
  return join(homedir(), ".local", "state", "claude-overview");
}

function parseHostFile(text: string): HostFile | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  // A corrupt or malformed id means "recreate" — the id is load-bearing.
  if (typeof d.id !== "string" || !HOST_ID_RE.test(d.id)) return null;
  const label = typeof d.label === "string" ? d.label : null;
  const createdAt =
    typeof d.createdAt === "number" && Number.isFinite(d.createdAt) ? d.createdAt : Date.now();
  const v = typeof d.v === "number" ? d.v : HOST_JSON_V;
  return { v, id: d.id, label, createdAt };
}

function readHostFile(file: string): HostFile | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return parseHostFile(text);
}

/** Write atomically: mkdir -p, write a unique tmp file, rename over the dest.
 *  A unique tmp name (pid + random) keeps racing instances from clobbering one
 *  another's temp file; rename is atomic so the dest is never half-written. */
function writeHostFileAtomic(stateDir: string, dest: string, data: HostFile): void {
  mkdirSync(stateDir, { recursive: true });
  const tmp = join(stateDir, `host.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(tmp, dest);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

/**
 * Load this host's identity, creating host.json if it is missing or corrupt.
 * Sequence: read → write-if-missing (atomic) → RE-READ and use what's on disk,
 * so two racing instances converge on whichever id won the rename.
 *
 * @param stateDir override for tests; defaults to ~/.local/state/claude-overview
 */
export function loadHostIdentity(stateDir: string = defaultStateDir()): HostIdentity {
  const file = join(stateDir, "host.json");

  let parsed = readHostFile(file);
  if (!parsed) {
    const fresh: HostFile = {
      v: HOST_JSON_V,
      id: "h_" + randomBytes(6).toString("hex"),
      label: null,
      createdAt: Date.now(),
    };
    writeHostFileAtomic(stateDir, file, fresh);
    // Re-read: another instance may have won the rename with a different id.
    parsed = readHostFile(file) ?? fresh;
  }

  const identity: HostIdentity = {
    id: parsed.id,
    hostname: hostname(),
    platform: detectPlatform(),
  };
  if (parsed.label !== null) identity.label = parsed.label;
  return identity;
}

/**
 * Map the running OS to a BridgePlatform. WSL is `process.platform === "linux"`
 * with `/proc/version` containing "microsoft" (case-insensitive). Params are
 * injectable for tests; unknown platforms fall back to "linux".
 */
export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  readProcVersion: () => string = () => readFileSync("/proc/version", "utf8"),
): BridgePlatform {
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "win32";
  if (platform === "linux") {
    try {
      if (readProcVersion().toLowerCase().includes("microsoft")) return "wsl";
    } catch {
      /* no /proc/version — treat as plain linux */
    }
    return "linux";
  }
  return "linux";
}
