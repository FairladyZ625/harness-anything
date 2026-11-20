import type * as AccessStatus from "@harness-anything/kernel/internal/domain/access-status.ts";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  applyCanonicalTree,
  revokeCanonicalTree,
  makeTaskProjectionReader,
  openSqliteEventStore,
  readNodeMaterializationDocuments,
  requireTaskMaterializationMetadata,
} from "@harness-anything/storage";
import {
  documentPath,
  inspectDocCandidate,
  resolveHarnessLayout,
  serializeEventHead,
  sha256Bytes,
  sha256Text,
  type TaskProjectionQueries,
  type MaterializationRequest,
} from "@harness-anything/kernel";
import { nodeMaterializationPolicyForMode } from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";
import { readLocalState } from "./repo-cell-settings-state.ts";
import { BASE_BACKUP_ARCHIVE_ROOT } from "@harness-anything/storage";
import { withReplicaGeneration, type ReplicaGeneration } from "../fleet-sync/fleet/replica-generation.ts";
import { readAuthoredDocumentBytes } from "./authored-document-read-port.ts";
import { taskWorktreeCandidateInventory } from "./task-worktree-candidates.ts";
import { acceptTaskWorktreeDocumentBase, worktreeAuthoredRelative } from "./worktree-setup.ts";

export interface FleetMirrorBlob {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  /** The policy the center wrote this row under; `null` when the projection row carries none. */
  readonly policyId: string | null;
}
export interface FleetMirrorView {
  readonly repoId: string;
  readonly viewId: string;
  readonly viewDir: string;
  readonly revision: number;
  readonly schemaGeneration: number;
  readonly headDigest: string;
  readonly manifestDigest: string;
  readonly ledgerGeneration: number;
  readonly readerProfile: Readonly<Record<string, unknown>> | null;
  readonly authorizationShapeDigest: string;
  readonly entries: ReadonlyMap<string, FleetMirrorBlob>;
}
export interface FleetMirrorDirtyFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly baseBlobSha256: string | null;
  readonly mediaType: string;
  /** The policy this candidate must be submitted under; the scan settled it, callers never re-derive it. */
  readonly policyId: string;
  /** Task/review worktree checkout that authored this change when not edited in the workspace mirror. */
  readonly worktreeRoot?: string;
}
export interface FleetMirrorScan {
  readonly changes: readonly FleetMirrorDirtyFile[];
  readonly cleanCount: number;
  readonly cleanPaths: readonly string[];
  /** Dirty paths this channel does not carry and no route owns: the center's `inapplicable` answer. */
  readonly inapplicablePaths: readonly string[];
  readonly deletedPaths: readonly string[];
  readonly blocked: readonly {
    readonly path: string;
    readonly reason: string;
    readonly size?: number;
    readonly maxInlineBytes?: number;
    readonly code?: string;
    readonly requiredRoute?: string;
  }[];
}
export type FleetConflictTrigger = "pull" | "push-rejected" | "command-rejected";
export interface FleetConflictPathRow {
  readonly path: string;
  readonly baseBlobSha256: string | null;
  readonly localBlobSha256: string | null;
  readonly centerBlobSha256: string | null;
}
export interface FleetStagedConflict {
  readonly conflictId: string;
  readonly paths: readonly string[];
  readonly dir: string;
}
export interface FleetConflictRecord {
  readonly conflictId: string;
  readonly paths: readonly FleetConflictPathRow[];
  readonly repoId: string;
  readonly state: AccessStatus.FleetConflictState;
}
export interface FleetMirrorApplyResult {
  readonly outcome: AccessStatus.FleetMirrorApplyOutcome;
  readonly fromRevision: number | null;
  readonly toRevision: number | null;
  readonly dirtyPaths: readonly string[];
  readonly conflicts: readonly FleetStagedConflict[];
}
export class FleetMirrorError extends Error {
  readonly code: string;
  readonly dirtyPaths: readonly string[];
  constructor(code: string, message: string, dirtyPaths: readonly string[] = []) {
    super(message);
    this.code = code;
    this.dirtyPaths = dirtyPaths;
  }
}

export function pullBlockedMirrorError(
  result: Pick<FleetMirrorApplyResult, "dirtyPaths" | "conflicts">,
): FleetMirrorError {
  const paths =
    result.dirtyPaths.length > 0 ? result.dirtyPaths : result.conflicts.flatMap((conflict) => conflict.paths);
  return new FleetMirrorError(
    "pull_blocked",
    paths.length > 0
      ? `Local workspace changes conflict with canonical mirror paths: ${paths.join(", ")}`
      : "Local workspace changes conflict with the canonical mirror cut.",
    paths,
  );
}

export function mirrorPathsFingerprint(workspaceRoot: string, paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const root = materializedRoot(workspaceRoot);
  return paths
    .map((logical) => {
      const target = path.join(root, ...logical.split("/")),
        stat = lstatSync(target, { throwIfNoEntry: false });
      if (!stat) return `${logical}:missing`;
      if (!stat.isFile()) return `${logical}:nonfile:${String(stat.mode)}`;
      return `${logical}:${sha256Bytes(readFileSync(target))}`;
    })
    .join("\n");
}

const objectPath = (generation: ReplicaGeneration, sha: string): string =>
  path.join(
    generation.rootDir,
    BASE_BACKUP_ARCHIVE_ROOT,
    "store",
    "generations",
    String(generation.metadata.ledgerGeneration),
    "objects",
    "sha256",
    sha.slice(0, 2),
    sha.slice(2),
  );
const materializedRoot = (workspaceRoot: string): string => resolveHarnessLayout(workspaceRoot).authoredRoot;
export function withFleetMirrorLock<T>(_viewRoot: string, _repoId: string, operation: () => Promise<T>): Promise<T> {
  return operation();
}
export function withFleetReplicaPullLock<T>(_viewDir: string, operation: () => Promise<T>): Promise<T> {
  return operation();
}

export function locateFleetMirrorView(
  viewRoot: string,
  repoId: string,
  viewId?: string,
  options: {
    readonly includeEntries?: boolean;
    readonly entriesPrefix?: string;
    readonly entryPaths?: readonly string[];
  } = {},
): FleetMirrorView | null {
  const viewsRoot = path.join(viewRoot, "repos", repoId, "views");
  if (!existsSync(viewsRoot)) return null;
  const names = readdirSync(viewsRoot, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && (viewId === undefined || entry.name === viewId),
  );
  let best: FleetMirrorView | null = null;
  for (const entry of names) {
    const viewDir = path.join(viewsRoot, entry.name);
    const view = withReplicaGeneration(viewDir, (generation): FleetMirrorView | null => {
      if (!generation) return null;
      const reader = makeTaskProjectionReader({
        rootDir: generation.rootDir,
        projectionPath: generation.projectionPath,
      });
      try {
        return reader.withSession((projection) =>
          fleetMirrorViewAtProjection(viewDir, repoId, generation, projection, options),
        );
      } finally {
        reader.close();
      }
    });
    if (view && (!best || view.revision > best.revision)) best = view;
  }
  return best;
}

/** The frame, document bases and rows must come from the same projection read transaction. */
export function fleetMirrorViewAtProjection(
  viewDir: string,
  repoId: string,
  generation: ReplicaGeneration,
  projection: TaskProjectionQueries,
  options: {
    readonly includeEntries?: boolean;
    readonly entriesPrefix?: string;
    readonly entryPaths?: readonly string[];
  } = {},
): FleetMirrorView {
  const revision = projection.readCut().watermark;
  const entries =
    options.includeEntries === false
      ? new Map<string, FleetMirrorBlob>()
      : new Map<string, FleetMirrorBlob>(
          options.entryPaths
            ? options.entryPaths.flatMap((logical) => {
                const doc = projection.readDocument(logical).document;
                return doc
                  ? [
                      [
                        logical,
                        {
                          sha256: doc.blobSha256,
                          size: doc.size,
                          mediaType: doc.mediaType,
                          policyId: doc.policyId,
                        },
                      ] as const,
                    ]
                  : [];
              })
            : projection
                .readDocuments(options.entriesPrefix ?? "")
                .documents.map((doc) => [
                  doc.path,
                  { sha256: doc.blobSha256, size: doc.size, mediaType: doc.mediaType, policyId: doc.policyId },
                ]),
        );
  // The replica holds the center's ledger, so its cut identity is the center's ledger cut at the
  // same revision: a mirrorBaseCut the edge sends is checked against exactly this digest.
  const ledger = openSqliteEventStore({
    databasePath: generation.ledgerPath,
    repoId,
    generation: generation.metadata.ledgerGeneration,
    readOnly: true,
  });
  let headDigest: string;
  try {
    const head = ledger.eventIdentityAtRevision(revision);
    headDigest = `sha256:${sha256Text(head === null ? "null\n" : serializeEventHead(head))}`;
  } finally {
    ledger.close();
  }
  return {
    repoId,
    viewId: path.basename(viewDir),
    viewDir,
    revision: revision,
    schemaGeneration: generation.metadata.projectionSchema,
    headDigest,
    manifestDigest: `sha256:${generation.metadata.position.history}:${generation.metadata.position.sequence}`,
    ledgerGeneration: generation.metadata.ledgerGeneration,
    readerProfile: generation.metadata.readerProfile ?? null,
    authorizationShapeDigest: "",
    entries,
  };
}
export function fleetMirrorTaskPaths(view: FleetMirrorView, taskId: string): string[] {
  return [...view.entries.keys()].filter((p) => {
    const folder = p.split("/")[1];
    return p.startsWith("tasks/") && (folder === taskId || folder?.startsWith(`${taskId}-`));
  });
}
export function fleetMirrorCutFile(view: FleetMirrorView, logical: string): Buffer | null {
  const blob = view.entries.get(logical);
  if (!blob) return null;
  return withReplicaGeneration(view.viewDir, (generation) => {
    if (!generation) throw new FleetMirrorError("replica_unavailable", "Replica generation is unavailable.");
    const file = objectPath(generation, blob.sha256);
    return existsSync(file) ? readFileSync(file) : null;
  });
}
export function scanFleetMirrorWorktree(
  view: FleetMirrorView,
  workspaceRoot: string,
  selection?: readonly string[],
): FleetMirrorScan {
  const root = materializedRoot(workspaceRoot),
    markerPath = path.join(resolveHarnessLayout(workspaceRoot).localRoot, "fleet-materialized.json"),
    markerExists = existsSync(markerPath),
    marker: {
      readonly revision?: number | null;
      readonly generation?: number;
      readonly entries?: Record<string, string>;
    } = markerExists ? JSON.parse(readFileSync(markerPath, "utf8")) : {},
    hasMaterializationBaseline =
      marker.revision !== null &&
      marker.revision !== undefined &&
      marker.entries !== undefined &&
      (marker.generation === undefined || marker.generation === view.ledgerGeneration),
    hasMarkerWithoutBaseline = markerExists && !hasMaterializationBaseline,
    materializedEntries: ReadonlySet<string> = hasMaterializationBaseline
      ? new Set(Object.keys(marker.entries ?? {}))
      : new Set(hasMarkerWithoutBaseline ? view.entries.keys() : (selection ?? [])),
    wanted = selection ? new Set(selection) : null,
    changes: FleetMirrorDirtyFile[] = [],
    cleanPaths: string[] = [],
    inapplicablePaths: string[] = [],
    blocked: {
      path: string;
      reason: string;
      size?: number;
      maxInlineBytes?: number;
      code?: string;
      requiredRoute?: string;
    }[] = [];
  for (const logical of materializedPaths(root)) {
    if (wanted && !wanted.has(logical)) continue;
    const file = path.join(root, ...logical.split("/")),
      base = view.entries.get(logical),
      fileSize = lstatSync(file).size,
      inspection = inspectDocCandidate(
        documentPath(logical),
        fileSize,
        base?.policyId ?? null,
        base !== undefined,
        () => readAuthoredDocumentBytes(root, logical),
      );
    // Raw artifacts — a PNG, a PDF, a log with stray bytes, a JSON evidence file — are doc-sync
    // candidates inside a task package's artifacts subtree. Outside that subtree the edge keeps the
    // canonical-prose scope: only `.md`/`.txt` documents, or bytes the classifier accepts, travel this
    // channel.
    //
    // The shared inspector owns route attribution, candidate membership, persisted-policy handling,
    // and the path-specific read cap for both the center and this edge.
    const originalSha = hasMaterializationBaseline ? (marker.entries?.[logical] ?? null) : (base?.sha256 ?? null),
      unchanged =
        inspection.bytes !== null &&
        (sha256Bytes(inspection.bytes) === originalSha ||
          (base !== undefined && base.sha256 === sha256Bytes(inspection.bytes))),
      route = inspection.route;
    // Membership first, then the unchanged check: an untouched file the channel does not carry is
    // simply not a candidate, and an untouched file it does carry is clean. A dirty path outside the
    // channel is still reported — but for a path no route owns it is not a refusal. The center answers
    // `inapplicable` for a path the shared classifier does not recognize and proceeds; blocking it
    // here refused every task command in the package over an ordinary file (`evidence/shot.png`,
    // `.DS_Store`, a NUL-bearing `.txt`) that the center never counted as doc-sync business. A path a
    // route owns keeps its block: the owning command is the one that must answer for it, and the
    // center reports it as blocked too.
    if (unchanged || (hasMarkerWithoutBaseline && base)) {
      cleanPaths.push(logical);
      continue;
    }
    if (inspection.kind === "route-owned") {
      blocked.push({
        path: logical,
        reason: `path is owned by ${route.requiredRoute}`,
        code: "doc_route_owned",
        requiredRoute: route.requiredRoute,
      });
      continue;
    }
    if (inspection.kind === "inapplicable") {
      inapplicablePaths.push(logical);
      continue;
    }
    if (inspection.kind === "unsupported") {
      blocked.push({ path: logical, reason: "path is not an allowed canonical document" });
      continue;
    }
    if (inspection.kind === "too-large") {
      blocked.push({
        path: logical,
        size: fileSize,
        maxInlineBytes: inspection.maxBytes,
        reason: "document exceeds inline limit",
        code: "doc_candidate_too_large",
        requiredRoute: "blob-content",
      });
      continue;
    }
    if (inspection.kind !== "candidate") continue;
    const { bytes, classification: docClass } = inspection;
    if (bytes === null || docClass === null) continue;
    changes.push({
      path: logical,
      bytes,
      baseBlobSha256: originalSha,
      mediaType: docClass.mediaType,
      policyId: docClass.policyId,
    });
  }
  const deletedPaths = [...view.entries.keys()].filter(
    (logical) =>
      (!wanted || wanted.has(logical)) &&
      (logical.endsWith(".md") || logical.endsWith(".txt")) &&
      materializedEntries.has(logical) &&
      !existsSync(path.join(root, ...logical.split("/"))),
  );
  for (const logical of deletedPaths)
    blocked.push({ path: logical, reason: "canonical document is missing from the registered harness" });
  return { changes, cleanCount: cleanPaths.length, cleanPaths, inapplicablePaths, deletedPaths, blocked };
}
export function cacheFleetMirrorDirtyBases(
  viewRoot: string,
  repoId: string,
  workspaceRoot: string,
  packagePath?: string,
): FleetMirrorScan | null {
  const view = locateFleetMirrorView(viewRoot, repoId);
  return view
    ? scanFleetMirrorWorktree(
        view,
        workspaceRoot,
        packagePath
          ? [...new Set([...view.entries.keys(), ...materializedPaths(materializedRoot(workspaceRoot))])].filter((p) =>
              p.startsWith(`${packagePath}/`),
            )
          : undefined,
      )
    : null;
}
export function applyFleetMirrorCut(
  viewRoot: string,
  repoId: string,
  workspaceRoot: string,
  trigger: FleetConflictTrigger | "replica-confirmed",
  context: {
    readonly viewId?: string;
    readonly taskId?: string | null;
    readonly executionId?: string | null;
    readonly kind?: string;
    readonly code?: string;
    readonly changedPaths?: readonly string[];
    readonly request?: MaterializationRequest;
  } = {},
): FleetMirrorApplyResult {
  const view = locateFleetMirrorView(viewRoot, repoId, context.viewId, { includeEntries: false });
  if (!view) return { outcome: "no_view", fromRevision: null, toRevision: null, dirtyPaths: [], conflicts: [] };
  return withReplicaGeneration(view.viewDir, (generation) => {
    if (!generation) throw new FleetMirrorError("replica_unavailable", "The mirror generation is unavailable.");
    const reader = makeTaskProjectionReader({ rootDir: generation.rootDir, projectionPath: generation.projectionPath });
    try {
      return reader.withSession((projection) => {
        const current = fleetMirrorViewAtProjection(view.viewDir, repoId, generation, projection, {
            includeEntries: false,
          }),
          result = materializeFleetMirrorView(workspaceRoot, current, projection, generation, context),
          // Confirmation reports skipped canonical updates. Command-driven pulls preserve candidates
          // and retain their applied outcome, including after a center write has already committed.
          blocked =
            trigger === "replica-confirmed" &&
            mirrorDirtyPathsConflictWithCanonical(
              workspaceRoot,
              current.ledgerGeneration,
              projection,
              result.dirtyPaths,
            );
        return { outcome: blocked ? ("pull_blocked" as const) : ("applied" as const), ...result, conflicts: [] };
      });
    } finally {
      reader.close();
    }
  });
}

function mirrorDirtyPathsConflictWithCanonical(
  workspaceRoot: string,
  ledgerGeneration: number,
  projection: TaskProjectionQueries,
  dirtyPaths: readonly string[],
): boolean {
  if (dirtyPaths.length === 0) return false;
  const markerPath = path.join(resolveHarnessLayout(workspaceRoot).localRoot, "fleet-materialized.json"),
    marker: {
      readonly generation?: number;
      readonly entries?: Record<string, string>;
    } = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : {},
    markerEntries =
      marker.generation === undefined || marker.generation === ledgerGeneration ? (marker.entries ?? {}) : {};
  return dirtyPaths.some((logical) => {
    const baseSha = markerEntries[logical],
      canonicalSha = projection.readDocument(logical).document?.blobSha256;
    return baseSha === undefined || baseSha !== canonicalSha;
  });
}

/** Automatic pulls, node-setting reconciliation and explicit restores share the same physical owner. */
export function materializeFleetMirrorView(
  workspaceRoot: string,
  view: FleetMirrorView,
  projection: TaskProjectionQueries,
  generation: ReplicaGeneration,
  options: { readonly request?: MaterializationRequest; readonly changedPaths?: readonly string[] } = {},
): ReturnType<typeof applyCanonicalTree> {
  const layout = resolveHarnessLayout(workspaceRoot),
    policy = readLocalState(workspaceRoot, nodeMaterializationPolicyForMode("remote-edge"), layout.settingsLocalPath)
      .value.nodeTaskMaterializationPolicy,
    request = options.request;
  // A headless node does not traverse document or task history on ordinary pulls.
  if (policy === "none" && request === undefined)
    return { fromRevision: null, toRevision: view.revision, dirtyPaths: [], settlements: [] };
  const preserveExistingOnly = request?.reconcileNodePolicy === true && policy === "none",
    effective = request?.paths
      ? "none"
      : preserveExistingOnly
        ? "in_flight"
        : request && !request.reconcileNodePolicy
          ? "include_done"
          : policy,
    documents = readNodeMaterializationDocuments(projection, effective, request?.paths),
    entries = new Map<string, FleetMirrorBlob>(
      documents.map((doc) => [
        doc.path,
        { sha256: doc.blobSha256, size: doc.size, mediaType: doc.mediaType, policyId: doc.policyId },
      ]),
    ),
    changed = options.changedPaths ? [...options.changedPaths] : undefined;
  return applyCanonicalTree({
    layout,
    markerPath: path.join(layout.localRoot, "fleet-materialized.json"),
    revision: view.revision,
    generation: view.ledgerGeneration,
    entries,
    preview: request?.preview,
    selectedPaths: request?.preview ? undefined : request?.paths,
    changedPaths: changed,
    requirePreviousPaths: (previous) => {
      requireTaskMaterializationMetadata(projection, previous);
      if (preserveExistingOnly) {
        const held = new Set(previous);
        for (const logical of entries.keys()) if (!held.has(logical)) entries.delete(logical);
      }
      // A lifecycle/relationship change affects the entire hot Task package, including unchanged
      // context files. Ordinary documents keep the transport's incremental path selection.
      if (changed)
        for (const logical of [...entries.keys(), ...previous])
          if (logical.startsWith("tasks/task_")) changed.push(logical);
    },
    readContent: (logical) => {
      const file = objectPath(generation, entries.get(logical)!.sha256);
      return existsSync(file) ? readFileSync(file) : null;
    },
  });
}

export function revokeFleetMirrorTree(workspaceRoot: string): void {
  const layout = resolveHarnessLayout(workspaceRoot);
  revokeCanonicalTree(layout.authoredRoot, path.join(layout.localRoot, "fleet-materialized.json"));
}

export function readFleetConflictRecord(_workspaceRoot: string, _id: string): never {
  throw new FleetMirrorError("conflict_not_found", "No staged conflict record exists.");
}
export function readFleetUnresolvedConflicts(_workspaceRoot: string, _repoId?: string): readonly FleetConflictRecord[] {
  return [];
}
export function settleFleetConflictRecord(_workspaceRoot: string, _id: string, _via: string): never {
  throw new FleetMirrorError("conflict_not_found", "No staged conflict record exists.");
}
export function fleetConflictSideFile(
  _workspaceRoot: string,
  _id: string,
  _logical: string,
  _side: "base" | "local" | "center",
): string | null {
  return null;
}
export function restoreFleetConflictCenterBytes(_workspaceRoot: string, _id: string, _row: FleetMirrorBlob): void {
  throw new FleetMirrorError("conflict_not_found", "No staged conflict record exists.");
}
function edgeTaskWorktreeRoots(
  workspaceRoot: string,
  taskId: string,
  includeReviewWorktrees: boolean,
): readonly string[] {
  const roots: string[] = [];
  if (includeReviewWorktrees) {
    const reviewRoot = path.join(workspaceRoot, ".worktrees", ".review", taskId);
    const reviewStat = lstatSync(reviewRoot, { throwIfNoEntry: false });
    if (reviewStat?.isDirectory() && !reviewStat.isSymbolicLink())
      for (const entry of readdirSync(reviewRoot, { withFileTypes: true }).sort((a, b) =>
        b.name.localeCompare(a.name),
      )) {
        const candidate = path.join(reviewRoot, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) roots.push(candidate);
      }
  }
  const taskRoot = path.join(workspaceRoot, ".worktrees", taskId),
    taskStat = lstatSync(taskRoot, { throwIfNoEntry: false });
  if (taskStat?.isDirectory() && !taskStat.isSymbolicLink()) roots.push(taskRoot);
  return roots;
}

/**
 * Scan both the edge workspace mirror and the task's materialized worktree mirrors as one logical view.
 * Untouched worktree files whose bytes match their recorded base are ignored so they never shadow or roll
 * back newer canonical revisions; edited/new worktree files carry their true worktree base SHA.
 */
export function scanEdgeTaskWorktrees(options: {
  readonly view: FleetMirrorView;
  readonly workspaceRoot: string;
  readonly taskId: string;
  readonly packagePath: string;
  readonly selection?: readonly string[];
  readonly includeReviewWorktrees?: boolean;
}): FleetMirrorScan {
  const { view, workspaceRoot, taskId, packagePath, selection, includeReviewWorktrees = false } = options,
    packagePrefix = `${packagePath}/`,
    packageSelection =
      selection ??
      [...new Set([...view.entries.keys(), ...materializedPaths(materializedRoot(workspaceRoot))])].filter((p) =>
        p.startsWith(packagePrefix),
      ),
    workspaceScan = scanFleetMirrorWorktree(view, workspaceRoot, packageSelection),
    selectionSet = selection ? new Set(selection) : null,
    authoredRelative = worktreeAuthoredRelative(resolveHarnessLayout(workspaceRoot)),
    changesByPath = new Map<string, FleetMirrorDirtyFile>(workspaceScan.changes.map((change) => [change.path, change])),
    conflictedPaths = new Set<string>(),
    overriddenPaths = new Set<string>(),
    extraInapplicable = new Set<string>(),
    blockedByPath = new Map<string, FleetMirrorScan["blocked"][number]>(
      workspaceScan.blocked.map((entry) => [entry.path, entry]),
    ),
    baseLedgerSha = {
      repoId: view.repoId,
      revision: view.revision,
      headDigest: view.headDigest,
    };
  for (const worktreeRoot of edgeTaskWorktreeRoots(workspaceRoot, taskId, includeReviewWorktrees)) {
    const gitEntry = lstatSync(path.join(worktreeRoot, ".git"), { throwIfNoEntry: false });
    if (!gitEntry || (!gitEntry.isFile() && !gitEntry.isDirectory())) continue;
    const mirrorPackage = path.join(worktreeRoot, authoredRelative, ...packagePath.split("/"));
    if (!lstatSync(mirrorPackage, { throwIfNoEntry: false })?.isDirectory()) continue;
    const inventory = taskWorktreeCandidateInventory(workspaceRoot, worktreeRoot, packagePath, baseLedgerSha);
    if (!inventory) continue;
    for (const row of inventory.rows) {
      if (selectionSet && !selectionSet.has(row.path)) continue;
      const base = view.entries.get(row.path),
        inspection = inspectDocCandidate(
          documentPath(row.path),
          row.size,
          base?.policyId ?? null,
          base !== undefined,
          () => row.bytes,
        ),
        route = inspection.route;
      if (inspection.kind === "route-owned") {
        if (!changesByPath.has(row.path)) {
          overriddenPaths.add(row.path);
          blockedByPath.set(row.path, {
            path: row.path,
            reason: `path is owned by ${route.requiredRoute}`,
            code: "doc_route_owned",
            requiredRoute: route.requiredRoute,
          });
        }
        continue;
      }
      if (inspection.kind === "inapplicable") {
        if (!changesByPath.has(row.path) && !blockedByPath.has(row.path)) {
          overriddenPaths.add(row.path);
          extraInapplicable.add(row.path);
        }
        continue;
      }
      if (inspection.kind === "unsupported") {
        if (!changesByPath.has(row.path)) {
          overriddenPaths.add(row.path);
          blockedByPath.set(row.path, { path: row.path, reason: "path is not an allowed canonical document" });
        }
        continue;
      }
      if (inspection.kind === "too-large") {
        if (!changesByPath.has(row.path)) {
          overriddenPaths.add(row.path);
          blockedByPath.set(row.path, {
            path: row.path,
            size: row.size ?? undefined,
            maxInlineBytes: inspection.maxBytes,
            reason: "document exceeds inline limit",
            code: "doc_candidate_too_large",
            requiredRoute: "blob-content",
          });
        }
        continue;
      }
      if (inspection.kind !== "candidate") continue;
      const { bytes, classification: docClass } = inspection;
      if (bytes === null || docClass === null) continue;
      if (base !== undefined && sha256Bytes(bytes) === base.sha256) {
        acceptTaskWorktreeDocumentBase(worktreeRoot, row.path, bytes, workspaceRoot);
        continue;
      }
      const baseBlobSha256 = row.baseBytes === null || row.baseBytes === undefined ? null : sha256Bytes(row.baseBytes),
        candidate: FleetMirrorDirtyFile = {
          path: row.path,
          bytes,
          baseBlobSha256,
          mediaType: docClass.mediaType,
          policyId: docClass.policyId,
          worktreeRoot,
        };
      overriddenPaths.add(row.path);
      const existing = changesByPath.get(row.path);
      if (existing === undefined) {
        changesByPath.set(row.path, candidate);
      } else if (existing.worktreeRoot === undefined) {
        if (sha256Bytes(existing.bytes) === sha256Bytes(candidate.bytes)) changesByPath.set(row.path, candidate);
        else {
          conflictedPaths.add(row.path);
          blockedByPath.set(row.path, {
            path: row.path,
            reason: "document edited in both task worktree and edge workspace",
            code: "worktree_workspace_conflict",
          });
        }
      }
    }
  }
  const cleanPaths = workspaceScan.cleanPaths.filter((p) => !overriddenPaths.has(p)),
    changes = [...changesByPath.values()].filter((change) => !conflictedPaths.has(change.path)),
    blocked = [...blockedByPath.values()],
    inapplicablePaths = [
      ...new Set([...workspaceScan.inapplicablePaths.filter((p) => !overriddenPaths.has(p)), ...extraInapplicable]),
    ];
  return {
    changes,
    cleanCount: cleanPaths.length,
    cleanPaths,
    inapplicablePaths,
    deletedPaths: workspaceScan.deletedPaths,
    blocked,
  };
}

export function acceptEdgeWorktreeScanBases(changes: readonly FleetMirrorDirtyFile[], workspaceRoot: string): void {
  for (const change of changes) {
    if (change.worktreeRoot === undefined || !existsSync(change.worktreeRoot)) continue;
    acceptTaskWorktreeDocumentBase(change.worktreeRoot, change.path, change.bytes, workspaceRoot);
  }
}

function materializedPaths(root: string): string[] {
  const found: string[] = [],
    // The view's own state directory is not a materialized repository path; which name it has is the
    // layout's answer, and a view without a layout has no local root of its own to skip.
    skipped = new Set([".git", ".worktrees"]);
  if (!existsSync(root)) return found;
  const localRootName = path.relative(root, resolveHarnessLayout(root).localRoot).split(path.sep)[0];
  if (localRootName && localRootName !== "." && !localRootName.startsWith("..")) skipped.add(localRootName);
  const visit = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (depth === 0 && skipped.has(entry.name)) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target, depth + 1);
      else if (entry.isFile()) found.push(path.relative(root, target).split(path.sep).join("/"));
    }
  };
  visit(root, 0);
  return found;
}
