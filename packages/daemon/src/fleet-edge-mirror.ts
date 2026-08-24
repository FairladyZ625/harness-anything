// Edge-side local mirror controller (design-v2 §3/§4): the replica view store
// under viewRoot is the transport truth; this module projects it into the
// registered workspace's authored harness root, detects local changes against
// the mirrored cut, and owns <workspace>/.harness/conflicts. Conflicts are staged, never
// merged: base/, local/, and center/ bytes land side by side and every record
// names its three explicit human exits. An unresolved divergence is a
// PERSISTENT gate — the marker keeps the last common base for diverged paths
// and re-detected divergence reuses its record instead of self-healing.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  consumeKnownError,
  documentPath,
  resolveDocRoute,
  resolveHarnessLayout,
  sha256Bytes,
} from "../../kernel/src/index.ts";

export interface FleetMirrorBlob {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}
export interface FleetMirrorView {
  readonly repoId: string;
  readonly viewId: string;
  readonly viewDir: string;
  readonly revision: number;
  readonly headDigest: string;
  readonly manifestDigest: string;
  readonly entries: ReadonlyMap<string, FleetMirrorBlob>;
}
export interface FleetMirrorDirtyFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly baseBlobSha256: string | null;
  readonly mediaType: "text/markdown" | "text/plain";
}
export interface FleetMirrorScan {
  readonly changes: readonly FleetMirrorDirtyFile[];
  readonly cleanCount: number;
  readonly blocked: readonly { readonly path: string; readonly reason: string }[];
}
export type FleetConflictTrigger = "pull" | "push-rejected" | "command-rejected";
export interface FleetConflictPathRow {
  readonly path: string;
  readonly baseBlobSha256: string | null;
  readonly localBlobSha256: string | null;
  readonly centerBlobSha256: string | null;
}
export interface FleetConflictRecord {
  readonly schema: "fleet-conflict/v1";
  readonly conflictId: string;
  readonly kind: "task-docs" | "shared-docs" | "pull-blocked";
  readonly trigger: FleetConflictTrigger;
  readonly code: string;
  readonly repoId: string;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly mirrorBaseRevision: number | null;
  readonly centerRevision: number | null;
  readonly createdAt: string;
  readonly paths: readonly FleetConflictPathRow[];
  readonly state: "staged" | "resolved";
  readonly resolvedVia: string | null;
  readonly exits: readonly string[];
}
export interface FleetStagedConflict {
  readonly conflictId: string;
  readonly paths: readonly string[];
  readonly dir: string;
}
export interface FleetMirrorApplyResult {
  readonly outcome: "applied" | "pull_blocked" | "no_view";
  readonly fromRevision: number | null;
  readonly toRevision: number | null;
  readonly dirtyPaths: readonly string[];
  readonly conflicts: readonly FleetStagedConflict[];
}
const materializationMarker = ".materialized-cut.json";
const materializationBaseCache = ".materialized-base-cache";
const conflictPrefix = "cflt-";

export class FleetMirrorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FleetMirrorError";
    this.code = code;
  }
}

// One edge daemon mutates one registered harness at a time: A auto-pulls, B sync
// rounds, and conflict exits serialize on this in-process chain so overlapping
// rounds cannot interleave marker writes, harness copies, or staging.
const mirrorLocks = new Map<string, Promise<void>>();
export function withFleetMirrorLock<T>(viewRoot: string, repoId: string, operation: () => Promise<T>): Promise<T> {
  const key = `${path.resolve(viewRoot)}\0${repoId}`;
  const previous = mirrorLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    tail = previous.then(() => gate);
  mirrorLocks.set(key, tail);
  return previous
    .then(async () => {
      const releaseFile = await acquireFleetMirrorFileLock(viewRoot, repoId);
      try {
        return await operation();
      } finally {
        releaseFile();
      }
    })
    .finally(() => {
      release();
      if (mirrorLocks.get(key) === tail) mirrorLocks.delete(key);
    });
}

// The in-process promise tail above is not sufficient when two edge daemons
// point at the same local replica/harness. The lock-file layer makes the
// round fence visible across processes as well; dead owners are reclaimed by
// PID liveness before a waiter enters its round.
async function acquireFleetMirrorFileLock(viewRoot: string, repoId: string): Promise<() => void> {
  const lockPath = path.join(viewRoot, "repos", repoId, ".mirror-round.lock"),
    token = `${process.pid}:${randomBytes(9).toString("hex")}`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, `${token}\n`, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readFileSync(lockPath, "utf8").trim() === token) unlinkSync(lockPath);
        } catch (error) {
          if (fleetMirrorErrorCode(error) === "ENOENT") return;
          consumeKnownError(error);
          throw error;
        }
      };
    } catch (error) {
      if (fleetMirrorErrorCode(error) !== "EEXIST") {
        consumeKnownError(error);
        throw error;
      }
      if (fleetMirrorLockIsStale(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch (cleanup) {
          if (fleetMirrorErrorCode(cleanup) === "ENOENT") continue;
          consumeKnownError(cleanup);
          throw cleanup;
        }
        continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}
function fleetMirrorLockIsStale(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8").trim();
  } catch (error) {
    return fleetMirrorErrorCode(error) !== "ENOENT";
  }
  // A competing process may observe the file in the tiny interval between its
  // exclusive create and synchronous token write. Do not steal that newborn
  // lock; a malformed lock only becomes reclaimable after that grace window.
  if (!/^\d+:[0-9a-f]+$/u.test(raw)) return Date.now() - statSync(lockPath).mtimeMs > 1_000;
  const pid = Number(raw.split(":", 1)[0]);
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return fleetMirrorErrorCode(error) === "ESRCH";
  }
}
function fleetMirrorErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

// One node mirrors one repo through one view; when several view directories
// exist the highest current cut wins so a stale view never shadows a live one.
export function locateFleetMirrorView(viewRoot: string, repoId: string, viewId?: string): FleetMirrorView | null {
  const viewsRoot = path.join(viewRoot, "repos", repoId, "views");
  if (!existsSync(viewsRoot)) return null;
  let best: FleetMirrorView | null = null;
  for (const candidate of readdirSync(viewsRoot, { withFileTypes: true })) {
    if (!candidate.isDirectory() || (viewId !== undefined && candidate.name !== viewId)) continue;
    const viewDir = path.join(viewsRoot, candidate.name),
      current = fleetMirrorReadJson<{ cut: { revision: number; headDigest: string }; manifestDigest: string }>(
        path.join(viewDir, "current.json"),
      );
    if (current === null) continue;
    const manifest = fleetMirrorCutEntries(viewDir, current.cut.revision);
    if (manifest === null) continue;
    const view: FleetMirrorView = {
      repoId,
      viewId: candidate.name,
      viewDir,
      revision: current.cut.revision,
      headDigest: current.cut.headDigest,
      manifestDigest: current.manifestDigest,
      entries: manifest,
    };
    if (best === null || view.revision > best.revision) best = view;
  }
  return best;
}

// Dirty detection against the mirrored cut: a file counts as changed only when
// its bytes diverge from the cut the mirror currently holds. Machine-owned
// task routes (INDEX.md, progress.md, executions/, ...) are never candidates —
// typed events own them — and locally deleted documents are reported blocked
// because canonical documents cannot be deleted through doc sync.
// Pre-pull base caching (F3): while the marker cut is still the view's
// CURRENT cut it is guaranteed on disk, so caching the base bytes of every
// dirty path at scan time — before the pull that can collect that cut — keeps
// base/ stageable no matter how many revisions the next pull jumps.
export function cacheFleetMirrorDirtyBases(viewRoot: string, repoId: string, workspaceRoot: string): void {
  const view = locateFleetMirrorView(viewRoot, repoId);
  const materializedRoot = fleetMirrorMaterializedRoot(workspaceRoot);
  if (view === null || !existsSync(materializedRoot)) return;
  const dirty = scanFleetMirrorWorktree(view, workspaceRoot).changes.map((change) => change.path);
  if (dirty.length > 0) fleetMirrorRefreshBaseCache(view, dirty);
}

export function scanFleetMirrorWorktree(
  view: FleetMirrorView,
  workspaceRoot: string,
  selection?: readonly string[],
): FleetMirrorScan {
  const materializedRoot = fleetMirrorMaterializedRoot(workspaceRoot);
  if (!existsSync(materializedRoot)) return { changes: [], cleanCount: 0, blocked: [] };
  const wanted = selection === undefined ? null : new Set(selection),
    changes: FleetMirrorDirtyFile[] = [],
    blocked: { readonly path: string; readonly reason: string }[] = [];
  let cleanCount = 0;
  for (const logical of fleetMirrorMaterializedPaths(materializedRoot)) {
    if (!fleetMirrorProsePath(logical) || (wanted !== null && !wanted.has(logical))) continue;
    const route = fleetMirrorRoute(logical);
    if (route === null) {
      blocked.push({ path: logical, reason: "path is not canonical NFC prose" });
      continue;
    }
    if (!route.allowed) {
      blocked.push({
        path: logical,
        reason: `path is owned by ${route.requiredRoute}; use the owning task or decision command`,
      });
      continue;
    }
    const bytes = readFileSync(path.join(materializedRoot, ...logical.split("/"))),
      base = view.entries.get(logical) ?? null;
    if (base !== null && base.sha256 === sha256Bytes(bytes)) {
      cleanCount += 1;
      continue;
    }
    changes.push({
      path: logical,
      bytes,
      baseBlobSha256: base?.sha256 ?? null,
      mediaType: logical.endsWith(".md") ? "text/markdown" : "text/plain",
    });
  }
  for (const logical of view.entries.keys()) {
    if (!fleetMirrorProsePath(logical) || (wanted !== null && !wanted.has(logical))) continue;
    if (!existsSync(path.join(materializedRoot, ...logical.split("/")))) {
      blocked.push({
        path: logical,
        reason:
          "canonical document is missing from the registered harness;" +
          " rerun the sync so the cut is materialized, then restore any locally deleted document",
      });
    }
  }
  return { changes, cleanCount, blocked };
}

// Project the freshest replica cut into the registered workspace's harness.
// Clean files follow the
// center; locally changed files are preserved untouched; a path that diverged
// on BOTH sides (including center-deleted × locally-modified) is never merged —
// it is staged into the conflict area with base/local/center bytes and blocks
// the pull (PULL_BLOCKED, design §4). The marker records, per path, the LAST
// COMMON BASE: diverged and dirty paths keep their base digest so the
// divergence keeps re-detecting until an explicit exit resolves it, while
// converged paths adopt the center digest as the new base.
export function applyFleetMirrorCut(
  viewRoot: string,
  repoId: string,
  workspaceRoot: string,
  trigger: FleetConflictTrigger,
  context: {
    readonly viewId?: string;
    readonly taskId?: string | null;
    readonly executionId?: string | null;
    readonly kind?: FleetConflictRecord["kind"];
    readonly code?: string;
  } = {},
): FleetMirrorApplyResult {
  const view = locateFleetMirrorView(viewRoot, repoId, context.viewId);
  if (view === null) return { outcome: "no_view", fromRevision: null, toRevision: null, dirtyPaths: [], conflicts: [] };
  const materializedRoot = fleetMirrorMaterializedRoot(workspaceRoot);
  const marker = fleetMirrorReadJson<{ revision: number; manifestDigest: string; blobs: Record<string, string> }>(
    path.join(view.viewDir, materializationMarker),
  );
  const baseOf = marker?.blobs ?? {};
  mkdirSync(materializedRoot, { recursive: true });
  const rows: FleetConflictPathRow[] = [],
    stage: {
      readonly path: string;
      readonly base: Uint8Array | null;
      readonly local: Uint8Array | null;
      readonly center: Uint8Array | null;
    }[] = [],
    dirtyPaths: string[] = [],
    nextBlobs: Record<string, string> = {};
  const localBytesOf = (logical: string): Buffer | null => {
    const file = path.join(materializedRoot, ...logical.split("/"));
    return existsSync(file) ? readFileSync(file) : null;
  };
  for (const [logical, blob] of view.entries) {
    fleetMirrorAssertLogical(logical);
    const localBytes = localBytesOf(logical),
      localSha = localBytes === null ? null : sha256Bytes(localBytes),
      oldSha = baseOf[logical] ?? null;
    if (localSha === blob.sha256) {
      nextBlobs[logical] = blob.sha256;
      continue;
    } // converged: new common base
    const localDirty = localSha !== null && localSha !== oldSha,
      localDeleted = localSha === null && oldSha !== null,
      centerChanged = blob.sha256 !== oldSha;
    if (localDirty || localDeleted) {
      dirtyPaths.push(logical);
      if (oldSha !== null) nextBlobs[logical] = oldSha; // keep the last common base
      if (centerChanged) {
        rows.push({ path: logical, baseBlobSha256: oldSha, localBlobSha256: localSha, centerBlobSha256: blob.sha256 });
        stage.push({
          path: logical,
          base: fleetMirrorBaseBytes(view, marker?.revision ?? null, logical),
          local: localBytes,
          center: fleetMirrorCutFile(view.viewDir, view.revision, logical),
        });
      }
      continue;
    }
    const centerBytes = fleetMirrorCutFile(view.viewDir, view.revision, logical);
    mkdirSync(path.dirname(path.join(materializedRoot, ...logical.split("/"))), { recursive: true });
    if (centerBytes !== null) fleetMirrorWriteBytes(path.join(materializedRoot, ...logical.split("/")), centerBytes);
    nextBlobs[logical] = blob.sha256;
  }
  // Center deletions: a locally untouched path follows the deletion; a locally
  // modified path is a three-way divergence (center side absent by design).
  for (const logical of Object.keys(baseOf)) {
    fleetMirrorAssertLogical(logical);
    if (view.entries.has(logical)) continue;
    const localBytes = localBytesOf(logical),
      localSha = localBytes === null ? null : sha256Bytes(localBytes),
      oldSha = baseOf[logical]!;
    if (localSha === null || localSha === oldSha) {
      rmSync(path.join(materializedRoot, ...logical.split("/")), { force: true });
      continue;
    }
    dirtyPaths.push(logical);
    nextBlobs[logical] = oldSha;
    rows.push({ path: logical, baseBlobSha256: oldSha, localBlobSha256: localSha, centerBlobSha256: null });
    stage.push({
      path: logical,
      base: fleetMirrorBaseBytes(view, marker?.revision ?? null, logical),
      local: localBytes,
      center: null,
    });
  }
  for (const logical of fleetMirrorMaterializedPaths(materializedRoot)) {
    if (!view.entries.has(logical) && baseOf[logical] === undefined && fleetMirrorProsePath(logical))
      dirtyPaths.push(logical);
  }
  // Cache base bytes for every dirty/diverged path while they are still
  // obtainable: the replica view retains only two cuts, so a later pull that
  // jumps several revisions can collect the base cut before the divergence is
  // detected (F3).
  fleetMirrorRefreshBaseCache(view, dirtyPaths);
  const conflicts = fleetStageOrReuseDivergence(
    workspaceRoot,
    repoId,
    view,
    marker?.revision ?? null,
    trigger,
    context,
    rows,
    stage,
  );
  fleetMirrorWriteJson(path.join(view.viewDir, materializationMarker), {
    revision: view.revision,
    manifestDigest: view.manifestDigest,
    blobs: nextBlobs,
  });
  rmSync(path.join(view.viewDir, "worktree"), { recursive: true, force: true });
  return {
    outcome: conflicts.length > 0 ? "pull_blocked" : "applied",
    fromRevision: marker?.revision ?? null,
    toRevision: view.revision,
    dirtyPaths: [...new Set(dirtyPaths)].sort(),
    conflicts,
  };
}

export function stageFleetConflict(
  workspaceRoot: string,
  input: {
    readonly record: Omit<FleetConflictRecord, "state" | "resolvedVia" | "exits">;
    readonly files: readonly {
      readonly path: string;
      readonly base: Uint8Array | null;
      readonly local: Uint8Array | null;
      readonly center: Uint8Array | null;
    }[];
  },
): FleetStagedConflict {
  const dir = path.join(fleetMirrorConflictRoot(workspaceRoot), input.record.conflictId);
  for (const file of input.files)
    for (const [side, bytes] of [
      ["base", file.base],
      ["local", file.local],
      ["center", file.center],
    ] as const)
      if (bytes !== null) {
        fleetMirrorAssertLogical(file.path);
        const target = path.join(dir, side, ...file.path.split("/"));
        mkdirSync(path.dirname(target), { recursive: true });
        fleetMirrorWriteBytes(target, bytes);
      }
  const record: FleetConflictRecord = {
    ...input.record,
    state: "staged",
    resolvedVia: null,
    exits: ["resolve", "discard-local", "overwrite-center"],
  };
  fleetMirrorWriteJson(path.join(dir, "manifest.json"), record);
  return { conflictId: input.record.conflictId, paths: input.record.paths.map((row) => row.path), dir };
}

export function readFleetConflictRecord(workspaceRoot: string, conflictId: string): FleetConflictRecord {
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(conflictId))
    throw new FleetMirrorError("conflict_id_invalid", "The conflict id must be a single conflict directory name.");
  const file = path.join(fleetMirrorConflictRoot(workspaceRoot), conflictId, "manifest.json"),
    record = fleetMirrorReadJson<FleetConflictRecord>(file);
  if (
    record === null ||
    record.schema !== "fleet-conflict/v1" ||
    !Array.isArray(record.paths) ||
    record.paths.length === 0
  )
    throw new FleetMirrorError("conflict_not_found", `No staged conflict record exists at ${file}.`);
  return record;
}

// The unresolved-conflict gate (design §4: 冲突未处理前同一路径的新状态转换
// 继续阻塞). Rounds and task commands consult this before pushing.
export function readFleetUnresolvedConflicts(workspaceRoot: string, repoId?: string): readonly FleetConflictRecord[] {
  const root = fleetMirrorConflictRoot(workspaceRoot);
  if (!existsSync(root)) return [];
  const records: FleetConflictRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(conflictPrefix)) continue;
    const record = fleetMirrorReadJson<FleetConflictRecord>(path.join(root, entry.name, "manifest.json"));
    if (
      record !== null &&
      record.schema === "fleet-conflict/v1" &&
      record.state === "staged" &&
      (repoId === undefined || record.repoId === repoId)
    )
      records.push(record);
  }
  return records;
}

export function settleFleetConflictRecord(workspaceRoot: string, conflictId: string, via: string): FleetConflictRecord {
  const record = readFleetConflictRecord(workspaceRoot, conflictId);
  if (record.state === "resolved") return record;
  const settled: FleetConflictRecord = { ...record, state: "resolved", resolvedVia: via };
  fleetMirrorWriteJson(path.join(fleetMirrorConflictRoot(workspaceRoot), conflictId, "manifest.json"), settled);
  return settled;
}

export function fleetConflictSideFile(
  workspaceRoot: string,
  conflictId: string,
  logicalPath: string,
  side: "base" | "local" | "center",
): string | null {
  fleetMirrorAssertLogical(logicalPath);
  const file = path.join(fleetMirrorConflictRoot(workspaceRoot), conflictId, side, ...logicalPath.split("/"));
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

// The discard-local exit: restore one staged path in the registered harness to
// the recorded center bytes. A center side that never had the document
// removes the local file instead. The next materialize converges the path and
// adopts the center digest as the new common base.
export function restoreFleetConflictCenterBytes(
  workspaceRoot: string,
  conflictId: string,
  row: FleetConflictPathRow,
): void {
  const source = fleetConflictSideFile(workspaceRoot, conflictId, row.path, "center");
  const target = path.join(fleetMirrorMaterializedRoot(workspaceRoot), ...row.path.split("/"));
  if (source !== null) {
    mkdirSync(path.dirname(target), { recursive: true });
    fleetMirrorWriteBytes(target, readFileSync(source));
  } else rmSync(target, { force: true });
}

// A re-detected divergence reuses its unresolved record instead of staging a
// duplicate; an unresolved record whose every row is subsumed by the fresh
// staging is superseded so one divergence always has exactly one live record.
function fleetStageOrReuseDivergence(
  workspaceRoot: string,
  repoId: string,
  view: FleetMirrorView,
  markerRevision: number | null,
  trigger: FleetConflictTrigger,
  context: {
    readonly taskId?: string | null;
    readonly executionId?: string | null;
    readonly kind?: FleetConflictRecord["kind"];
    readonly code?: string;
  },
  rows: readonly FleetConflictPathRow[],
  stage: readonly {
    readonly path: string;
    readonly base: Uint8Array | null;
    readonly local: Uint8Array | null;
    readonly center: Uint8Array | null;
  }[],
): readonly FleetStagedConflict[] {
  if (rows.length === 0) return [];
  const signature = (row: FleetConflictPathRow): string =>
    `${row.path}\0${row.localBlobSha256 ?? ""}\0${row.centerBlobSha256 ?? ""}`;
  const fresh = new Set(rows.map(signature));
  for (const record of readFleetUnresolvedConflicts(workspaceRoot, repoId)) {
    const signatures = record.paths.map(signature);
    if (signatures.length === fresh.size && signatures.every((value) => fresh.has(value)))
      return [
        {
          conflictId: record.conflictId,
          paths: record.paths.map((row) => row.path),
          dir: path.join(fleetMirrorConflictRoot(workspaceRoot), record.conflictId),
        },
      ];
  }
  for (const record of readFleetUnresolvedConflicts(workspaceRoot, repoId))
    if (record.paths.every((row) => fresh.has(signature(row))))
      settleFleetConflictRecord(workspaceRoot, record.conflictId, "superseded");
  return [
    stageFleetConflict(workspaceRoot, {
      record: {
        schema: "fleet-conflict/v1",
        conflictId: `${conflictPrefix}${randomBytes(9).toString("hex")}`,
        kind: context.kind ?? "pull-blocked",
        trigger,
        code: context.code ?? "pull_blocked",
        repoId,
        taskId: context.taskId ?? null,
        executionId: context.executionId ?? null,
        mirrorBaseRevision: markerRevision,
        centerRevision: view.revision,
        createdAt: new Date().toISOString(),
        paths: rows,
      },
      files: stage,
    }),
  ];
}

// Base bytes for staging come from the marker's cut while retained, else from
// the dirty-base cache written by earlier materializations.
function fleetMirrorBaseBytes(
  view: FleetMirrorView,
  markerRevision: number | null,
  logical: string,
): Uint8Array | null {
  if (markerRevision !== null) {
    const fromCut = fleetMirrorCutFile(view.viewDir, markerRevision, logical);
    if (fromCut !== null) return fromCut;
  }
  const cached = path.join(view.viewDir, materializationBaseCache, ...logical.split("/"));
  return existsSync(cached) ? readFileSync(cached) : null;
}
function fleetMirrorRefreshBaseCache(view: FleetMirrorView, dirtyPaths: readonly string[]): void {
  const cacheRoot = path.join(view.viewDir, materializationBaseCache);
  const keep = new Set(dirtyPaths);
  const markerRevision = locateFleetMirrorMarkerRevision(view);
  for (const logical of keep) {
    const bytes =
      (markerRevision === null ? null : fleetMirrorCutFile(view.viewDir, markerRevision, logical)) ??
      (() => {
        const cached = path.join(cacheRoot, ...logical.split("/"));
        return existsSync(cached) ? readFileSync(cached) : null;
      })();
    if (bytes === null) continue;
    const target = path.join(cacheRoot, ...logical.split("/"));
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) {
      mkdirSync(path.dirname(target), { recursive: true });
      fleetMirrorWriteBytes(target, bytes);
    }
  }
  if (existsSync(cacheRoot)) {
    for (const stale of fleetMirrorMaterializedPaths(cacheRoot))
      if (!keep.has(stale)) rmSync(path.join(cacheRoot, ...stale.split("/")), { force: true });
  }
}
function locateFleetMirrorMarkerRevision(view: FleetMirrorView): number | null {
  const marker = fleetMirrorReadJson<{ revision: number }>(path.join(view.viewDir, materializationMarker));
  return marker?.revision ?? null;
}
function fleetMirrorConflictRoot(workspaceRoot: string): string {
  return path.join(resolveHarnessLayout(workspaceRoot).localRoot, "conflicts");
}
function fleetMirrorMaterializedRoot(workspaceRoot: string): string {
  return resolveHarnessLayout(workspaceRoot).authoredRoot;
}
function fleetMirrorCutEntries(viewDir: string, revision: number): ReadonlyMap<string, FleetMirrorBlob> | null {
  const manifest = fleetMirrorReadJson<{ entries: { path: string; blob: FleetMirrorBlob }[] }>(
    path.join(viewDir, "cuts", String(revision), "manifest.json"),
  );
  return manifest === null ? null : new Map(manifest.entries.map((entry) => [entry.path, entry.blob]));
}
function fleetMirrorCutFile(viewDir: string, revision: number, logical: string): Buffer | null {
  const file = path.join(viewDir, "cuts", String(revision), "files", ...logical.split("/"));
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file) : null;
}
function fleetMirrorMaterializedPaths(materializedRoot: string): string[] {
  const found: string[] = [];
  if (!existsSync(materializedRoot)) return found;
  const visit = (directory: string, depth: number): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0 && [".git", ".harness", ".worktrees"].includes(entry.name)) continue;
        visit(target, depth + 1);
      } else if (entry.isFile()) {
        const logical = path.relative(materializedRoot, target).split(path.sep).join("/");
        if (!logical.startsWith("..") && !path.isAbsolute(logical)) found.push(logical);
      }
    }
  };
  visit(materializedRoot, 0);
  return found;
}
function fleetMirrorProsePath(value: string): boolean {
  return value.endsWith(".md") || value.endsWith(".txt");
}
function fleetMirrorRoute(logical: string): { readonly allowed: boolean; readonly requiredRoute: string } | null {
  try {
    return resolveDocRoute(documentPath(logical));
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
function fleetMirrorAssertLogical(value: string): void {
  const unsafePart = (part: string): boolean =>
    part === "" ||
    part === "." ||
    part === ".." ||
    part === ".git" ||
    part === ".harness" ||
    part === ".worktrees" ||
    part.startsWith(".mirror-");
  if (value.startsWith("/") || value.split("/").some(unsafePart))
    throw new FleetMirrorError("unsafe_conflict_path", "A staged document path is not a safe relative path.");
}
function fleetMirrorWriteBytes(file: string, bytes: Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`,
    fd = openSync(temp, "w");
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}
function fleetMirrorWriteJson(file: string, value: unknown): void {
  fleetMirrorWriteBytes(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}
function fleetMirrorReadJson<T>(file: string): T | null {
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
