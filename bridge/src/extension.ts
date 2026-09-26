import * as vscode from "vscode";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
// Shared source, imported DIRECTLY from the main extension's src/ (no byte-copy).
// The bridge is bundled with `bun build` (see bridge/package.json), which pulls
// these modules into the companion's single out/extension.js — one source of
// truth, verified vscode-free / dependency-free. Keep it that way: these files
// are also compiled into the main extension, so never add a vscode import to them.
import {
  copyMissingMementoValues,
  migrateLegacySettings,
  parseLegacyMemento,
  validateSnapshot,
  validateAction,
  HOST_ID_RE,
} from "../../src/bridgeSchema";
import type { StoredHostSnapshot, FocusAction, BridgeLicense, CursorEnumSessionWire, CursorSessionsResult } from "../../src/bridgeSchema";
import { extractPanelTitles, readComposerEnumeration } from "../../src/titleExtract";
import { sqliteSelect } from "../../src/sqliteRead";

// The bridge is an invisible "ui" companion: it always runs on the local
// desktop side of every window and owns the aggregation store. Main extension
// instances (workspace ext host, possibly remote) publish their host's snapshot
// and fetch every host via cross-ext-host command calls. See §5/§8 of
// docs/plan-command-bridge.md. Everything here is read-only w.r.t. remote input:
// remote strings are only ever validated, clamped, and persisted as data.

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — prune horizon
const TITLES_TTL_MS = 10_000; // re-extract panel titles at most every 10s
const ACTION_TTL_MS = 60_000; // a stale click must never fire minutes later
const ACTION_QUEUE_CAP = 20; // per-host pending-action ceiling (drop oldest)

type IngestResult = { ok: true } | { ok: false; error: string };
type CacheEntry = { mtimeMs: number; doc: StoredHostSnapshot };
type TitlesResult = { ok: true; titles: Record<string, string> } | { ok: false; error: string };
type PostResult = { ok: true } | { ok: false; error: string };
type TakeResult = { ok: true; actions: FocusAction[] } | { ok: false; error: string };

const LEGACY_EXTENSION_ID = "lensky.claude-overview-bridge";

async function migrateRenameState(context: vscode.ExtensionContext): Promise<void> {
  const rootConfig = vscode.workspace.getConfiguration();
  await migrateLegacySettings({
    inspect: (key) => {
      const value = rootConfig.inspect<unknown>(key);
      return value === undefined
        ? undefined
        : { globalValue: value.globalValue, workspaceValue: value.workspaceValue };
    },
    update: (key, value, target) =>
      rootConfig.update(
        key,
        value,
        target === "global" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace
      ),
  });

  const globalStorageRoot = join(context.globalStorageUri.fsPath, "..");
  const rows = await sqliteSelect(
    join(globalStorageRoot, "state.vscdb"),
    `SELECT value FROM ItemTable WHERE key='${LEGACY_EXTENSION_ID}'`
  );
  const legacyMemento = parseLegacyMemento(rows?.[0]?.[0]);
  if (legacyMemento !== undefined) {
    await copyMissingMementoValues(context.globalState, legacyMemento);
  }

  // Preserve cached host snapshots and any other companion-owned files while
  // retaining the old directory as a non-destructive rollback source.
  const legacyStorage = join(globalStorageRoot, LEGACY_EXTENSION_ID);
  if (existsSync(legacyStorage)) {
    await cp(legacyStorage, context.globalStorageUri.fsPath, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    await migrateRenameState(context);
  } catch (err) {
    console.warn(`[sessiondeck-bridge] rename migration was incomplete: ${String(err)}`);
  }
  const hostsDir = join(context.globalStorageUri.fsPath, "hosts");
  // Cross-host actions (owner-approved focus): window A writes an action file for
  // host B into actions/<targetHostId>/; host B's main polls takeActions on its
  // refresh tick, which reads + DELETES its pending actions. All remote input is
  // validated before any fs use; targetHostId is HOST_ID_RE-gated by the
  // validator, which is what makes it safe as a directory name.
  const actionsDir = join(context.globalStorageUri.fsPath, "actions");
  // Desktop-side Claude panel titles for remote (WSL/SSH) windows: the main
  // extension there can't reach this machine's workspaceStorage, so it asks us.
  // Derive the workspaceStorage root from OUR OWN globalStorage dir — editor- and
  // OS-agnostic, and correct under portable mode / --user-data-dir.
  //   .../User/globalStorage/<ext-id>  →  .../User/workspaceStorage
  const workspaceStorageRoot = join(context.globalStorageUri.fsPath, "..", "..", "workspaceStorage");
  const globalStorageRoot = join(workspaceStorageRoot, "..", "globalStorage");
  const globalDbPath = join(globalStorageRoot, "state.vscdb");
  const instanceId = `i_${randomBytes(6).toString("hex")}`;
  let enumCache: { gen: string; sessions: CursorEnumSessionWire[] } | undefined;
  let enumDirty = true;
  let dirtyTimer: ReturnType<typeof setTimeout> | undefined;
  let rearmTimer: ReturnType<typeof setTimeout> | undefined;
  let enumWatcher: FSWatcher | undefined;
  let enumWatchDisposed = false;
  const markEnumDirty = (): void => {
    if (dirtyTimer !== undefined) clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(() => { enumDirty = true; }, 2_000);
  };
  const rearmEnumWatch = (): void => {
    markEnumDirty();
    enumWatcher?.close();
    enumWatcher = undefined;
    if (enumWatchDisposed || rearmTimer !== undefined) return;
    rearmTimer = setTimeout(() => {
      rearmTimer = undefined;
      armEnumWatch();
    }, 2_000);
  };
  const armEnumWatch = (): void => {
    if (enumWatchDisposed) return;
    try {
      enumWatcher = watch(`${globalDbPath}-wal`, (eventType) => {
        markEnumDirty();
        if (eventType === "rename") rearmEnumWatch();
      });
      enumWatcher.on("error", rearmEnumWatch);
    } catch { /* pulls remain correct without the optimization */ }
  };
  armEnumWatch();
  context.subscriptions.push({ dispose: () => {
    enumWatchDisposed = true;
    enumWatcher?.close();
    if (dirtyTimer !== undefined) clearTimeout(dirtyTimer);
    if (rearmTimer !== undefined) clearTimeout(rearmTimer);
  } });

  const cursorSessionsRpc = (arg: unknown): CursorSessionsResult => {
    try {
      const sinceGen = typeof arg === "object" && arg !== null && "sinceGen" in arg &&
        typeof (arg as { sinceGen: unknown }).sinceGen === "string"
        ? (arg as { sinceGen: string }).sinceGen : "";
      if (enumCache === undefined || enumDirty || enumWatcher === undefined) {
        const read = readComposerEnumeration(globalDbPath, { prevGen: enumDirty ? undefined : enumCache?.gen });
        enumDirty = false;
        if (!read.engine) return { instanceId, gen: "", sessions: [] };
        enumCache = { gen: read.gen, sessions: read.sessions };
      }
      if (sinceGen === enumCache.gen) return { instanceId, gen: enumCache.gen, unchanged: true };
      return { instanceId, gen: enumCache.gen, sessions: enumCache.sessions };
    } catch {
      return { instanceId, gen: "", sessions: [] };
    }
  };
  let titlesCache: { at: number; titles: Record<string, string> } | undefined;
  const titles = async (): Promise<TitlesResult> => {
    try {
      const now = Date.now();
      if (titlesCache === undefined || now - titlesCache.at >= TITLES_TTL_MS) {
        titlesCache = { at: now, titles: await extractPanelTitles(workspaceStorageRoot) };
      }
      return { ok: true, titles: titlesCache.titles };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "titles failed" };
    }
  };
  // Companion license/trial authority. The bridge is the local desktop-side host,
  // persistent across window reloads and shared by every remote window on this
  // machine, so it owns the canonical trial origin: stamp trialStart ONCE (on the
  // first license() call, honoring an already-persisted value) and never reset it.
  // Also surface the synced-settings license key when readable, so a remote whose
  // own Settings Sync hasn't carried the key can still learn it. Read-only + local.
  //
  // DELIBERATE trade-off (a command is callable by any extension in this window's
  // hosts, including a remote workspace one): the returned `key` is a LOW-VALUE,
  // offline-DEFEATABLE license key, not a credential — the project already accepts
  // that "a determined user can defeat it" and syncs it in plaintext settings (see
  // docs/LICENSING.md "Settings Sync" and docs/cross-host-design.md §7/§10). Its
  // worst-case abuse is using the license without paying, which the honor-system
  // design tolerates by construction. It carries NO transcript, credential, or
  // trial-bypass power, and never leaves the user's own machines. Returning it is
  // what lets a remote instance whose sync lagged still be licensed. If the owner
  // wants stricter data minimization, drop the `key` line — trial-authority (the
  // trialStart merge) is independent of it and still works.
  const LICENSE_TRIAL_KEY = "licenseTrialStart";
  const license = (): BridgeLicense => {
    let trialStart = context.globalState.get<number>(LICENSE_TRIAL_KEY);
    if (typeof trialStart !== "number" || !Number.isFinite(trialStart)) {
      trialStart = Date.now();
      void context.globalState.update(LICENSE_TRIAL_KEY, trialStart);
    }
    const out: BridgeLicense = { trialStart };
    const key = vscode.workspace.getConfiguration("sessionDeck").get<string>("licenseKey", "");
    if (typeof key === "string" && key.length > 0) out.key = key;
    return out;
  };

  // In-memory map, effectively keyed by host.id (filename is `<host.id>.json`),
  // caching the last-read doc + mtime so list() only re-reads changed files.
  const store = new Map<string, CacheEntry>();

  const pkg = context.extension.packageJSON as { version?: unknown };
  const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";

  // Register all commands together once rename migration has settled. VS Code
  // awaits this activation promise before completing a command-triggered probe.
  context.subscriptions.push(
    vscode.commands.registerCommand("sessionDeckBridge.hello", () => ({ v: 1 as const, version, instanceId })),
    vscode.commands.registerCommand("sessionDeckBridge.publish", (doc: unknown) => ingest(doc, Date.now())),
    vscode.commands.registerCommand("sessionDeckBridge.list", () => list()),
    vscode.commands.registerCommand("sessionDeckBridge.titles", () => titles()),
    vscode.commands.registerCommand("sessionDeckBridge.cursorSessions", (arg: unknown) => cursorSessionsRpc(arg)),
    vscode.commands.registerCommand("sessionDeckBridge.license", () => license()),
    vscode.commands.registerCommand("sessionDeckBridge.postAction", (action: unknown) => postAction(action)),
    vscode.commands.registerCommand("sessionDeckBridge.takeActions", (hostId: unknown) => takeActions(hostId))
  );

  // Dev-only backdoor: same ingest path as publish, but honours a receivedAt
  // override baked into the doc so a test can fake a second (possibly stale)
  // host without SSH. Registered only under SESSIONDECK_DEV.
  if (process.env.SESSIONDECK_DEV) {
    context.subscriptions.push(
      vscode.commands.registerCommand("sessionDeckBridge._injectTest", (doc: unknown) =>
        ingest(doc, readReceivedAt(doc) ?? Date.now())
      )
    );
  }

  // Best-effort dir setup after synchronous registration; ingest() also ensures
  // the dir, so an early publish that races this is still safe.
  void mkdir(hostsDir, { recursive: true }).catch(() => undefined);

  async function ingest(doc: unknown, receivedAt: number): Promise<IngestResult> {
    try {
      const res = validateSnapshot(doc);
      if (!res.ok) return { ok: false, error: res.error };
      // res.doc is a sanitized fresh deep copy — the only thing we persist.
      // host.id already matched HOST_ID_RE in the validator, so it is safe as a
      // filename; nothing else from the doc is ever path-joined.
      const stored: StoredHostSnapshot = { ...res.doc, receivedAt };
      const name = `${res.doc.host.id}.json`;
      const full = join(hostsDir, name);
      await mkdir(hostsDir, { recursive: true });
      await writeAtomic(full, JSON.stringify(stored));
      const st = await stat(full);
      store.set(name, { mtimeMs: st.mtimeMs, doc: stored });
      return { ok: true };
    } catch {
      return { ok: false, error: "write failed" };
    }
  }

  async function list(): Promise<StoredHostSnapshot[]> {
    let names: string[];
    try {
      names = await readdir(hostsDir);
    } catch {
      return [];
    }
    const now = Date.now();
    const seen = new Set<string>();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      seen.add(name);
      const full = join(hostsDir, name);
      let st;
      try {
        st = await stat(full);
      } catch {
        store.delete(name);
        continue;
      }
      if (!st.isFile()) {
        seen.delete(name);
        continue;
      }
      const cached = store.get(name);
      if (cached && cached.mtimeMs === st.mtimeMs) {
        // Unchanged since last read — but still prune if it has aged out.
        if (now - cached.doc.receivedAt > MAX_AGE_MS) {
          await tryUnlink(full);
          store.delete(name);
        }
        continue;
      }
      // Changed (or first-seen, e.g. written by another window's bridge): re-read.
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(full, "utf8"));
      } catch {
        await tryUnlink(full);
        store.delete(name);
        continue;
      }
      // Identity + liveness come from file CONTENT; validate on read too.
      const receivedAt = readReceivedAt(parsed);
      const res = validateSnapshot(parsed);
      if (!res.ok || receivedAt === undefined) {
        await tryUnlink(full);
        store.delete(name);
        continue;
      }
      if (now - receivedAt > MAX_AGE_MS) {
        await tryUnlink(full);
        store.delete(name);
        continue;
      }
      store.set(name, { mtimeMs: st.mtimeMs, doc: { ...res.doc, receivedAt } });
    }
    // Forget cache entries whose files vanished.
    for (const key of [...store.keys()]) if (!seen.has(key)) store.delete(key);
    // Dedupe by content host.id (filename is convenience only); last wins.
    const byHost = new Map<string, StoredHostSnapshot>();
    for (const { doc } of store.values()) byHost.set(doc.host.id, doc);
    return [...byHost.values()];
  }

  /** Validate + persist one action for its targetHostId. Validation runs BEFORE
   *  any fs work; targetHostId is HOST_ID_RE-gated by the validator, so it is
   *  safe as the per-host directory name. Never throws. */
  async function postAction(input: unknown): Promise<PostResult> {
    try {
      const res = validateAction(input);
      if (!res.ok) return { ok: false, error: res.error };
      const dir = join(actionsDir, res.action.targetHostId);
      await mkdir(dir, { recursive: true });
      // One file per action; the postedAt prefix keeps names chronological.
      const name = `${res.action.postedAt}-${Math.random().toString(36).slice(2)}.json`;
      await writeAtomic(join(dir, name), JSON.stringify(res.action));
      await capActionQueue(dir);
      return { ok: true };
    } catch {
      return { ok: false, error: "post failed" };
    }
  }

  /** Return + DELETE the pending actions for a host (a poll consumes them). Drops
   *  actions older than the TTL — a stale click must never fire minutes later —
   *  and keeps at most the newest ACTION_QUEUE_CAP. hostId is HOST_ID_RE-gated
   *  before any path use. Never throws. */
  async function takeActions(hostId: unknown): Promise<TakeResult> {
    try {
      if (typeof hostId !== "string" || !HOST_ID_RE.test(hostId)) return { ok: false, error: "bad hostId" };
      const dir = join(actionsDir, hostId);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return { ok: true, actions: [] };
      }
      names = names.filter((n) => n.endsWith(".json")).sort(); // chronological (postedAt prefix)
      const now = Date.now();
      const valid: FocusAction[] = [];
      for (const name of names) {
        const full = join(dir, name);
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(full, "utf8"));
        } catch {
          await tryUnlink(full);
          continue;
        }
        await tryUnlink(full); // taking consumes the action regardless of validity
        const res = validateAction(parsed);
        if (!res.ok) continue;
        if (now - res.action.postedAt > ACTION_TTL_MS) continue; // stale → dropped
        valid.push(res.action);
      }
      // Bound the batch: on overflow keep the newest actions.
      const actions = valid.length > ACTION_QUEUE_CAP ? valid.slice(valid.length - ACTION_QUEUE_CAP) : valid;
      return { ok: true, actions };
    } catch {
      return { ok: false, error: "take failed" };
    }
  }

  /** Keep a host's pending-action directory bounded by deleting the oldest files
   *  beyond the cap (defense against a flood between the target's polls). */
  async function capActionQueue(dir: string): Promise<void> {
    try {
      const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
      if (names.length <= ACTION_QUEUE_CAP) return;
      for (const name of names.slice(0, names.length - ACTION_QUEUE_CAP)) {
        await tryUnlink(join(dir, name));
      }
    } catch {
      /* best-effort */
    }
  }
}

export function deactivate(): void {
  /* no-op: no listeners, timers, or resources beyond disposables */
}

/** Extract a finite receivedAt override from raw input, if present. */
function readReceivedAt(input: unknown): number | undefined {
  if (typeof input === "object" && input !== null && "receivedAt" in input) {
    const r = (input as { receivedAt: unknown }).receivedAt;
    if (typeof r === "number" && Number.isFinite(r)) return r;
  }
  return undefined;
}

/** Write via tmp file in the same dir + rename, so readers never see a partial file. */
async function writeAtomic(target: string, data: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data, "utf8");
  try {
    await rename(tmp, target);
  } catch (err) {
    await tryUnlink(tmp);
    throw err;
  }
}

async function tryUnlink(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    /* ignore */
  }
}
