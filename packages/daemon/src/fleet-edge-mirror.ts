// Edge-side local mirror controller (design-v2 §3/§4): the replica view store
// under viewRoot is the transport truth; this module owns its materialized
// worktree, dirty detection against the mirrored cut, and the conflict staging
// area under <workspace>/.harness/conflicts. Conflicts are staged, never
// merged: base/, local/, and center/ bytes land side by side and every record
// names its three explicit human exits.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { consumeKnownError, documentPath, resolveDocRoute, resolveHarnessLayout, sha256Bytes } from "../../kernel/src/index.ts";

export interface FleetMirrorBlob { readonly sha256: string; readonly size: number; readonly mediaType: string }
export interface FleetMirrorView { readonly repoId: string; readonly viewId: string; readonly viewDir: string; readonly worktreeRoot: string; readonly revision: number; readonly headDigest: string; readonly manifestDigest: string; readonly entries: ReadonlyMap<string, FleetMirrorBlob> }
export interface FleetMirrorDirtyFile { readonly path: string; readonly bytes: Uint8Array; readonly baseBlobSha256: string | null; readonly mediaType: "text/markdown" | "text/plain" }
export interface FleetMirrorScan { readonly changes: readonly FleetMirrorDirtyFile[]; readonly cleanCount: number; readonly blocked: readonly { readonly path: string; readonly reason: string }[] }
export type FleetConflictTrigger = "pull" | "push-rejected" | "command-rejected";
export interface FleetConflictPathRow { readonly path: string; readonly baseBlobSha256: string | null; readonly localBlobSha256: string | null; readonly centerBlobSha256: string | null }
export interface FleetConflictRecord { readonly schema: "fleet-conflict/v1"; readonly conflictId: string; readonly kind: "task-docs" | "shared-docs" | "pull-blocked"; readonly trigger: FleetConflictTrigger; readonly code: string; readonly repoId: string; readonly taskId: string | null; readonly executionId: string | null; readonly mirrorBaseRevision: number | null; readonly centerRevision: number | null; readonly createdAt: string; readonly paths: readonly FleetConflictPathRow[]; readonly state: "staged" | "resolved"; readonly resolvedVia: string | null; readonly exits: readonly string[] }
export interface FleetStagedConflict { readonly conflictId: string; readonly paths: readonly string[]; readonly dir: string }
export interface FleetMirrorApplyResult { readonly outcome: "applied" | "pull_blocked" | "no_view"; readonly fromRevision: number | null; readonly toRevision: number | null; readonly dirtyPaths: readonly string[]; readonly conflicts: readonly FleetStagedConflict[] }
const mirrorMarker = ".mirror-cut.json", conflictPrefix = "cflt-";

export class FleetMirrorError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = "FleetMirrorError"; this.code = code; } }

// One node mirrors one repo through one view; when several view directories
// exist the highest current cut wins so a stale view never shadows a live one.
export function locateFleetMirrorView(viewRoot: string, repoId: string, viewId?: string): FleetMirrorView | null {
  const viewsRoot = path.join(viewRoot, "repos", repoId, "views");
  if (!existsSync(viewsRoot)) return null;
  let best: FleetMirrorView | null = null;
  for (const candidate of readdirSync(viewsRoot, { withFileTypes: true })) {
    if (!candidate.isDirectory() || viewId !== undefined && candidate.name !== viewId) continue;
    const viewDir = path.join(viewsRoot, candidate.name), current = fleetMirrorReadJson<{ cut: { revision: number; headDigest: string }; manifestDigest: string }>(path.join(viewDir, "current.json"));
    if (current === null) continue;
    const manifest = fleetMirrorCutEntries(viewDir, current.cut.revision);
    if (manifest === null) continue;
    const view: FleetMirrorView = { repoId, viewId: candidate.name, viewDir, worktreeRoot: path.join(viewDir, "worktree"), revision: current.cut.revision, headDigest: current.cut.headDigest, manifestDigest: current.manifestDigest, entries: manifest };
    if (best === null || view.revision > best.revision) best = view;
  }
  return best;
}

// Dirty detection against the mirrored cut: a file counts as changed only when
// its bytes diverge from the cut the mirror currently holds. Machine-owned
// task routes (INDEX.md, progress.md, executions/, ...) are never candidates —
// typed events own them — and locally deleted documents are reported blocked
// because canonical documents cannot be deleted through doc sync.
export function scanFleetMirrorWorktree(view: FleetMirrorView, selection?: readonly string[]): FleetMirrorScan {
  if (!existsSync(view.worktreeRoot)) return { changes: [], cleanCount: 0, blocked: [] };
  const wanted = selection === undefined ? null : new Set(selection), changes: FleetMirrorDirtyFile[] = [], blocked: { readonly path: string; readonly reason: string }[] = [];
  let cleanCount = 0;
  for (const logical of fleetMirrorWorktreePaths(view.worktreeRoot)) {
    if (!fleetMirrorProsePath(logical) || wanted !== null && !wanted.has(logical)) continue;
    const route = fleetMirrorRoute(logical);
    if (route === null) { blocked.push({ path: logical, reason: "path is not canonical NFC prose" }); continue; }
    if (!route.allowed) { blocked.push({ path: logical, reason: `path is owned by ${route.requiredRoute}; use the owning task or decision command` }); continue; }
    const bytes = readFileSync(path.join(view.worktreeRoot, ...logical.split("/"))), base = view.entries.get(logical) ?? null;
    if (base !== null && base.sha256 === sha256Bytes(bytes)) { cleanCount += 1; continue; }
    changes.push({ path: logical, bytes, baseBlobSha256: base?.sha256 ?? null, mediaType: logical.endsWith(".md") ? "text/markdown" : "text/plain" });
  }
  for (const logical of view.entries.keys()) {
    if (!fleetMirrorProsePath(logical) || wanted !== null && !wanted.has(logical)) continue;
    if (!existsSync(path.join(view.worktreeRoot, ...logical.split("/")))) blocked.push({ path: logical, reason: "canonical document is missing from the mirror worktree; rerun the sync so the cut is materialized, then restore any locally deleted document" });
  }
  return { changes, cleanCount, blocked };
}

// Project the freshest replica cut into the worktree. Clean files follow the
// center; locally changed files are preserved untouched; a path that diverged
// on BOTH sides is never merged — it is staged into the conflict area with
// base/local/center bytes and blocks the pull (PULL_BLOCKED, design §4).
export function applyFleetMirrorCut(viewRoot: string, repoId: string, workspaceRoot: string, trigger: FleetConflictTrigger, context: { readonly viewId?: string; readonly taskId?: string | null; readonly executionId?: string | null; readonly kind?: FleetConflictRecord["kind"]; readonly code?: string } = {}): FleetMirrorApplyResult {
  const view = locateFleetMirrorView(viewRoot, repoId, context.viewId);
  if (view === null) return { outcome: "no_view", fromRevision: null, toRevision: null, dirtyPaths: [], conflicts: [] };
  // The marker carries its own base digests: the replica view retains only the
  // current and previous cut, so a pull that jumps several revisions can drop
  // the cut this worktree was materialized from. Without embedded digests the
  // old base is unknowable and every changed path would look like divergence.
  const marker = fleetMirrorReadJson<{ revision: number; manifestDigest: string; blobs: Record<string, string> }>(path.join(view.worktreeRoot, mirrorMarker));
  const oldShaOf = (logical: string): string | null => marker?.blobs?.[logical] ?? null;
  mkdirSync(view.worktreeRoot, { recursive: true });
  const rows: FleetConflictPathRow[] = [], stage: { readonly path: string; readonly base: Uint8Array | null; readonly local: Uint8Array | null; readonly center: Uint8Array | null }[] = [], dirtyPaths: string[] = [];
  for (const [logical, blob] of view.entries) {
    const worktreeFile = path.join(view.worktreeRoot, ...logical.split("/")), localBytes = existsSync(worktreeFile) ? readFileSync(worktreeFile) : null, localSha = localBytes === null ? null : sha256Bytes(localBytes), oldSha = oldShaOf(logical);
    if (localSha === blob.sha256) continue; // already at the center bytes
    const localDirty = localSha !== null && localSha !== oldSha, localDeleted = localSha === null && oldSha !== null, centerChanged = blob.sha256 !== oldSha;
    if (localDirty || localDeleted) {
      dirtyPaths.push(logical);
      // Stage only true divergence — both sides moved the same path. A locally
      // deleted document the center still holds stays a reported dirty path;
      // it is un-pushable by contract and never blocks an unchanged path.
      if (centerChanged) { rows.push({ path: logical, baseBlobSha256: oldSha, localBlobSha256: localSha, centerBlobSha256: blob.sha256 }); stage.push({ path: logical, base: oldSha === null || marker === null ? null : fleetMirrorCutFile(view.viewDir, marker.revision, logical), local: localBytes, center: fleetMirrorCutFile(view.viewDir, view.revision, logical) }); }
      continue;
    }
    mkdirSync(path.dirname(worktreeFile), { recursive: true });
    const centerBytes = fleetMirrorCutFile(view.viewDir, view.revision, logical);
    if (centerBytes !== null) fleetMirrorWriteBytes(worktreeFile, centerBytes);
  }
  for (const logical of fleetMirrorWorktreePaths(view.worktreeRoot)) if (!view.entries.has(logical) && fleetMirrorProsePath(logical)) dirtyPaths.push(logical);
  const conflicts = rows.length === 0 ? [] : [stageFleetConflict(workspaceRoot, {
    record: { schema: "fleet-conflict/v1", conflictId: `${conflictPrefix}${randomBytes(9).toString("hex")}`, kind: context.kind ?? "pull-blocked", trigger, code: context.code ?? "pull_blocked", repoId, taskId: context.taskId ?? null, executionId: context.executionId ?? null, mirrorBaseRevision: marker?.revision ?? null, centerRevision: view.revision, createdAt: new Date().toISOString(), paths: rows },
    files: stage
  })];
  fleetMirrorWriteJson(path.join(view.worktreeRoot, mirrorMarker), { revision: view.revision, manifestDigest: view.manifestDigest, blobs: Object.fromEntries([...view.entries].map(([logical, blob]) => [logical, blob.sha256])) });
  return { outcome: conflicts.length > 0 ? "pull_blocked" : "applied", fromRevision: marker?.revision ?? null, toRevision: view.revision, dirtyPaths: [...new Set(dirtyPaths)].sort(), conflicts };
}

export function stageFleetConflict(workspaceRoot: string, input: { readonly record: Omit<FleetConflictRecord, "state" | "resolvedVia" | "exits">; readonly files: readonly { readonly path: string; readonly base: Uint8Array | null; readonly local: Uint8Array | null; readonly center: Uint8Array | null }[] }): FleetStagedConflict {
  const dir = path.join(fleetMirrorConflictRoot(workspaceRoot), input.record.conflictId);
  for (const file of input.files) for (const [side, bytes] of [["base", file.base], ["local", file.local], ["center", file.center]] as const) if (bytes !== null) { fleetMirrorAssertLogical(file.path); const target = path.join(dir, side, ...file.path.split("/")); mkdirSync(path.dirname(target), { recursive: true }); fleetMirrorWriteBytes(target, bytes); }
  const record: FleetConflictRecord = { ...input.record, state: "staged", resolvedVia: null, exits: ["resolve", "discard-local", "overwrite-center"] };
  fleetMirrorWriteJson(path.join(dir, "manifest.json"), record);
  return { conflictId: input.record.conflictId, paths: input.record.paths.map((row) => row.path), dir };
}

export function readFleetConflictRecord(workspaceRoot: string, conflictId: string): FleetConflictRecord {
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(conflictId)) throw new FleetMirrorError("conflict_id_invalid", "The conflict id must be a single conflict directory name.");
  const file = path.join(fleetMirrorConflictRoot(workspaceRoot), conflictId, "manifest.json"), record = fleetMirrorReadJson<FleetConflictRecord>(file);
  if (record === null || record.schema !== "fleet-conflict/v1" || !Array.isArray(record.paths) || record.paths.length === 0) throw new FleetMirrorError("conflict_not_found", `No staged conflict record exists at ${file}.`);
  return record;
}

export function settleFleetConflictRecord(workspaceRoot: string, conflictId: string, via: string): FleetConflictRecord {
  const record = readFleetConflictRecord(workspaceRoot, conflictId);
  if (record.state === "resolved") return record;
  const settled: FleetConflictRecord = { ...record, state: "resolved", resolvedVia: via };
  fleetMirrorWriteJson(path.join(fleetMirrorConflictRoot(workspaceRoot), conflictId, "manifest.json"), settled);
  return settled;
}

export function fleetConflictSideFile(workspaceRoot: string, conflictId: string, logicalPath: string, side: "base" | "local" | "center"): string | null {
  fleetMirrorAssertLogical(logicalPath);
  const file = path.join(fleetMirrorConflictRoot(workspaceRoot), conflictId, side, ...logicalPath.split("/"));
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

// The discard-local exit: restore one staged path in the mirror worktree to
// the recorded center bytes. A center side that never had the document
// removes the local file instead.
export function restoreFleetConflictCenterBytes(workspaceRoot: string, conflictId: string, view: FleetMirrorView, row: FleetConflictPathRow): void {
  const source = fleetConflictSideFile(workspaceRoot, conflictId, row.path, "center"), target = path.join(view.worktreeRoot, ...row.path.split("/"));
  if (source !== null) { mkdirSync(path.dirname(target), { recursive: true }); fleetMirrorWriteBytes(target, readFileSync(source)); }
  else rmSync(target, { force: true });
}

function fleetMirrorConflictRoot(workspaceRoot: string): string { return path.join(resolveHarnessLayout(workspaceRoot).localRoot, "conflicts"); }
function fleetMirrorCutEntries(viewDir: string, revision: number): ReadonlyMap<string, FleetMirrorBlob> | null { const manifest = fleetMirrorReadJson<{ entries: { path: string; blob: FleetMirrorBlob }[] }>(path.join(viewDir, "cuts", String(revision), "manifest.json")); return manifest === null ? null : new Map(manifest.entries.map((entry) => [entry.path, entry.blob])); }
function fleetMirrorCutFile(viewDir: string, revision: number, logical: string): Buffer | null { const file = path.join(viewDir, "cuts", String(revision), "files", ...logical.split("/")); return existsSync(file) && statSync(file).isFile() ? readFileSync(file) : null; }
function fleetMirrorWorktreePaths(worktreeRoot: string): string[] { const found: string[] = []; if (!existsSync(worktreeRoot)) return found; const visit = (directory: string): void => { for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) { const target = path.join(directory, entry.name); if (entry.isDirectory()) visit(target); else if (entry.isFile()) { const logical = path.relative(worktreeRoot, target).split(path.sep).join("/"); if (!logical.startsWith("..") && !path.isAbsolute(logical)) found.push(logical); } } }; visit(worktreeRoot); return found; }
function fleetMirrorProsePath(value: string): boolean { return value.endsWith(".md") || value.endsWith(".txt"); }
function fleetMirrorRoute(logical: string): { readonly allowed: boolean; readonly requiredRoute: string } | null { try { return resolveDocRoute(documentPath(logical)); } catch (error) { consumeKnownError(error); return null; } }
function fleetMirrorAssertLogical(value: string): void { if (value.startsWith("/") || value.split("/").some((part) => part === "" || part === "." || part === ".." || part === mirrorMarker)) throw new FleetMirrorError("unsafe_conflict_path", "A staged document path is not a safe relative path."); }
function fleetMirrorWriteBytes(file: string, bytes: Uint8Array): void { mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`, fd = openSync(temp, "w"); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); } renameSync(temp, file); }
function fleetMirrorWriteJson(file: string, value: unknown): void { fleetMirrorWriteBytes(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`)); }
function fleetMirrorReadJson<T>(file: string): T | null { if (!existsSync(file) || !statSync(file).isFile()) return null; try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch (error) { consumeKnownError(error); return null; } }
