import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  documentPath,
  inspectDocCandidate,
  makeTaskProjectionReader,
  openSqliteEventStore,
  resolveHarnessLayout,
  serializeEventHead,
  sha256Bytes,
  sha256Text,
} from "@harness-anything/kernel";
import { BASE_BACKUP_ARCHIVE_ROOT } from "./fleet/basebackup-layout.ts";
import { withReplicaGeneration, type ReplicaGeneration } from "./fleet/replica-generation.ts";
import { removeFileDurably, writeFileDurably } from "./durable-file.ts";

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
  readonly state: "staged" | "resolved";
}
export interface FleetMirrorApplyResult {
  readonly outcome: "applied" | "pull_blocked" | "no_view";
  readonly fromRevision: number | null;
  readonly toRevision: number | null;
  readonly dirtyPaths: readonly string[];
  readonly conflicts: readonly FleetStagedConflict[];
}
export class FleetMirrorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
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
        const entries =
          options.includeEntries === false
            ? new Map<string, FleetMirrorBlob>()
            : new Map<string, FleetMirrorBlob>(
                options.entryPaths
                  ? options.entryPaths.flatMap((logical) => {
                      const doc = reader.withSession((queries) => queries.readDocument(logical)).document;
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
                  : reader
                      .withSession((queries) => queries.readDocuments(options.entriesPrefix ?? ""))
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
          const head = ledger.eventIdentityAtRevision(generation.metadata.position.revision);
          headDigest = `sha256:${sha256Text(head === null ? "null\n" : serializeEventHead(head))}`;
        } finally {
          ledger.close();
        }
        return {
          repoId,
          viewId: entry.name,
          viewDir,
          revision: generation.metadata.position.revision,
          schemaGeneration: generation.metadata.projectionSchema,
          headDigest,
          manifestDigest: `sha256:${generation.metadata.position.history}:${generation.metadata.position.sequence}`,
          ledgerGeneration: generation.metadata.ledgerGeneration,
          readerProfile: generation.metadata.readerProfile ?? null,
          authorizationShapeDigest: "",
          entries,
        };
      } finally {
        reader.close();
      }
    });
    if (view && (!best || view.revision > best.revision)) best = view;
  }
  return best;
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
        () => readFileSync(file),
      );
    // Raw artifacts — a PNG, a PDF, a log with stray bytes, a JSON evidence file — are doc-sync
    // candidates inside a task package's artifacts subtree. Outside that subtree the edge keeps the
    // canonical-prose scope: only `.md`/`.txt` documents, or bytes the classifier accepts, travel this
    // channel.
    //
    // The shared inspector owns route attribution, candidate membership, persisted-policy handling,
    // and the path-specific read cap for both the center and this edge.
    const unchanged =
        inspection.bytes !== null &&
        base !== undefined &&
        base.size === inspection.bytes.byteLength &&
        base.sha256 === sha256Bytes(inspection.bytes),
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
      baseBlobSha256: base?.sha256 ?? null,
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
  _trigger: FleetConflictTrigger,
  context: {
    readonly viewId?: string;
    readonly taskId?: string | null;
    readonly executionId?: string | null;
    readonly kind?: string;
    readonly code?: string;
    readonly changedPaths?: readonly string[];
  } = {},
): FleetMirrorApplyResult {
  const markerLayout = resolveHarnessLayout(workspaceRoot).localRoot;
  const markerPath = path.join(markerLayout, "fleet-materialized.json");
  const markerExists = existsSync(markerPath);
  const marker: {
    readonly revision?: number | null;
    readonly generation?: number;
    readonly entries?: Record<string, string>;
  } = markerExists ? JSON.parse(readFileSync(markerPath, "utf8")) : {};
  const previous: {
    readonly revision: number | null;
    readonly generation?: number;
    readonly entries: Record<string, string>;
  } = {
    revision: marker.revision ?? null,
    ...(marker.generation === undefined ? {} : { generation: marker.generation }),
    entries: marker.entries ?? {},
  };
  const view = locateFleetMirrorView(viewRoot, repoId, context.viewId, {
    ...(markerExists && previous.revision !== null && context.changedPaths ? { entryPaths: context.changedPaths } : {}),
  });
  if (!view) return { outcome: "no_view", fromRevision: null, toRevision: null, dirtyPaths: [], conflicts: [] };
  const hasMaterializationBaseline =
    markerExists &&
    previous.revision !== null &&
    marker.entries !== undefined &&
    (previous.generation === undefined || previous.generation === view.ledgerGeneration);
  const root = materializedRoot(workspaceRoot),
    entries = { ...previous.entries },
    dirtyPaths: string[] = [];
  const selected = hasMaterializationBaseline && context.changedPaths ? new Set(context.changedPaths) : null;
  mkdirSync(root, { recursive: true });
  for (const [logical, blob] of view.entries) {
    if (selected && !selected.has(logical)) continue;
    const target = path.join(root, ...logical.split("/"));
    // Local files can change after materialization; compare them with the last successful write,
    // not the newer center blob. The center's validated object digest is already authoritative.
    if (existsSync(target)) {
      const local = sha256Bytes(readFileSync(target));
      if (local === blob.sha256) {
        entries[logical] = blob.sha256;
        continue;
      }
      if (hasMaterializationBaseline && local !== previous.entries[logical]) {
        dirtyPaths.push(logical);
        continue;
      }
    }
    const bytes = fleetMirrorCutFile(view, logical);
    if (bytes === null) throw new FleetMirrorError("replica_corrupt", `Replica document object is missing: ${logical}`);
    writeFileDurably(target, bytes);
    entries[logical] = blob.sha256;
  }
  // A center deletion is represented by the path disappearing from the current cut. Remove only
  // files this mirror previously wrote; a local candidate remains untouched and is surfaced for
  // the caller to reconcile, just like a conflicting update.
  for (const [logical, previousSha] of Object.entries(previous.entries)) {
    if (selected && !selected.has(logical)) continue;
    if (view.entries.has(logical)) continue;
    const target = path.join(root, ...logical.split("/"));
    if (!existsSync(target)) {
      delete entries[logical];
      continue;
    }
    if (sha256Bytes(readFileSync(target)) !== previousSha) {
      dirtyPaths.push(logical);
      continue;
    }
    removeFileDurably(target);
    delete entries[logical];
  }
  writeFileDurably(markerPath, JSON.stringify({ revision: view.revision, generation: view.ledgerGeneration, entries }));
  return { outcome: "applied", fromRevision: previous.revision, toRevision: view.revision, dirtyPaths, conflicts: [] };
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
