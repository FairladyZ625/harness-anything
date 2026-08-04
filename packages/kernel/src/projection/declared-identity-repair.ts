import path from "node:path";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { assertNoSymlinkPath } from "../layout/path-safety.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { localDeclaredIdentityRepairFileSystem } from "../local/local-layout-file-system.ts";
import {
  captureProjectionSourceSnapshot,
  type DeclaredProjectionSnapshot
} from "./projection-source-snapshot.ts";

interface DeclaredIdentitySourceRecord {
  readonly entityKind: string;
  readonly projectionTable: string;
  readonly primaryKey: string;
  readonly sourcePath: string;
  readonly canonicalSourcePath: string;
  readonly body: string;
}

export interface DeclaredIdentityConflictReport {
  readonly entityKind: string;
  readonly projectionTable: string;
  readonly primaryKey: string;
  readonly sourcePaths: ReadonlyArray<string>;
  readonly canonicalSourcePath: string | null;
  readonly canonicalSourcePaths: ReadonlyArray<string>;
  readonly canonicalSourcePresent: boolean;
  readonly winnerSourcePath: string;
  readonly sourceBodiesDiffer: boolean;
  readonly unresolvedReason?: "ambiguous_canonical_path" | "unknown_lifecycle_state" | "canonical_update_unproven";
}

interface DeclaredIdentityInspection {
  readonly schema: "declared-identity-inspection/v1";
  readonly conflicts: ReadonlyArray<DeclaredIdentityConflictReport>;
  readonly misplaced: ReadonlyArray<DeclaredIdentitySourceRecord>;
  readonly sourceCount: number;
}

interface DeclaredIdentityRepairAction {
  readonly entityKind: string;
  readonly projectionTable: string;
  readonly primaryKey: string;
  readonly canonicalSourcePath: string;
  readonly winnerSourcePath: string;
  readonly wroteCanonical: boolean;
  readonly quarantinedSourcePaths: ReadonlyArray<string>;
  readonly quarantinePaths: ReadonlyArray<string>;
}

export interface DeclaredIdentityRepairReport {
  readonly schema: "declared-identity-repair/v1";
  readonly changed: boolean;
  readonly conflictsBefore: number;
  readonly misplacedBefore: number;
  readonly actions: ReadonlyArray<DeclaredIdentityRepairAction>;
  readonly unresolved: ReadonlyArray<DeclaredIdentityConflictReport>;
  readonly quarantineRoot: string;
}

interface RepairGroup {
  readonly entityKind: string;
  readonly projectionTable: string;
  readonly primaryKey: string;
  readonly records: ReadonlyArray<DeclaredIdentitySourceRecord>;
  readonly canonicalSourcePath: string | null;
}

export function inspectDeclaredIdentityState(rootInput: HarnessLayoutInput): DeclaredIdentityInspection {
  const records = declaredIdentitySourceRecords(rootInput);
  const groups = groupRecords(records);
  return {
    schema: "declared-identity-inspection/v1",
    conflicts: groups
      .filter((group) => group.records.length > 1)
      .map(conflictReportForGroup),
    misplaced: records
      .filter((record) => record.sourcePath !== record.canonicalSourcePath)
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
    sourceCount: records.length
  };
}

export function repairDeclaredIdentityState(rootInput: HarnessLayoutInput): DeclaredIdentityRepairReport {
  const layout = resolveHarnessLayout(rootInput);
  const inspection = inspectDeclaredIdentityState(rootInput);
  const groups = groupRecords(declaredIdentitySourceRecords(rootInput));
  const actionable = groups.filter((group) => group.records.length > 1 || group.records.some((record) => record.sourcePath !== record.canonicalSourcePath));
  const unresolved = actionable
    .filter((group) => repairDecision(group).unresolved)
    .map(conflictReportForGroup);
  const actions: DeclaredIdentityRepairAction[] = [];
  for (const group of actionable) {
    if (!group.canonicalSourcePath || repairDecision(group).unresolved) continue;
    actions.push(repairGroup(layout.authoredRoot, layout.tasksRoot, group));
  }
  return {
    schema: "declared-identity-repair/v1",
    changed: actions.some((action) => action.wroteCanonical || action.quarantinedSourcePaths.length > 0),
    conflictsBefore: inspection.conflicts.length,
    misplacedBefore: inspection.misplaced.length,
    actions,
    unresolved,
    quarantineRoot: relativePath(layout.authoredRoot, path.join(layout.authoredRoot, ".repair", "declared-identity"))
  };
}

function declaredIdentitySourceRecords(rootInput: HarnessLayoutInput): ReadonlyArray<DeclaredIdentitySourceRecord> {
  const snapshot = captureProjectionSourceSnapshot(rootInput);
  const bodiesByKindAndPath = new Map<string, string>();
  for (const source of snapshot.declaredSources) {
    for (const input of source.source.inputs) {
      if (input.body !== undefined) bodiesByKindAndPath.set(`${source.declaration.kind}\0${input.relativePath}`, input.body);
    }
  }
  const records: DeclaredIdentitySourceRecord[] = [];
  for (const table of snapshot.declaredTables) appendTableRecords(table, bodiesByKindAndPath, records);
  return records.sort((left, right) => left.projectionTable.localeCompare(right.projectionTable)
    || left.primaryKey.localeCompare(right.primaryKey)
    || left.sourcePath.localeCompare(right.sourcePath));
}

function appendTableRecords(
  table: DeclaredProjectionSnapshot,
  bodiesByKindAndPath: ReadonlyMap<string, string>,
  records: DeclaredIdentitySourceRecord[]
): void {
  const primaryKeyColumn = table.declaration.projection.columns.find((column) => column.primaryKey)!;
  for (const document of table.documents) {
    const body = bodiesByKindAndPath.get(`${table.declaration.kind}\0${document.relativePath}`);
    if (body === undefined) continue;
    records.push({
      entityKind: table.declaration.kind,
      projectionTable: table.table,
      primaryKey: String(document.row[primaryKeyColumn.name]),
      sourcePath: document.relativePath,
      canonicalSourcePath: document.canonicalRelativePath,
      body
    });
  }
}

function groupRecords(records: ReadonlyArray<DeclaredIdentitySourceRecord>): ReadonlyArray<RepairGroup> {
  const groups = new Map<string, DeclaredIdentitySourceRecord[]>();
  for (const record of records) {
    const key = `${record.projectionTable}\0${record.primaryKey}`;
    const existing = groups.get(key) ?? [];
    existing.push(record);
    groups.set(key, existing);
  }
  return [...groups.values()]
    .map((recordsForIdentity) => {
      const first = recordsForIdentity[0]!;
      const canonicalPaths = new Set(recordsForIdentity.map((record) => record.canonicalSourcePath));
      return {
        entityKind: first.entityKind,
        projectionTable: first.projectionTable,
        primaryKey: first.primaryKey,
        records: recordsForIdentity,
        canonicalSourcePath: canonicalPaths.size === 1 ? [...canonicalPaths][0]! : null
      };
    })
    .sort((left, right) => left.projectionTable.localeCompare(right.projectionTable)
      || left.primaryKey.localeCompare(right.primaryKey));
}

function conflictReportForGroup(group: RepairGroup): DeclaredIdentityConflictReport {
  const sourcePaths = group.records.map((record) => record.sourcePath).sort();
  const winner = selectWinner(group);
  const canonicalSourcePaths = [...new Set(group.records.map((record) => record.canonicalSourcePath))].sort();
  const unresolvedReason = repairDecision(group).reason;
  return {
    entityKind: group.entityKind,
    projectionTable: group.projectionTable,
    primaryKey: group.primaryKey,
    sourcePaths,
    canonicalSourcePath: group.canonicalSourcePath,
    canonicalSourcePaths,
    canonicalSourcePresent: group.canonicalSourcePath !== null && sourcePaths.includes(group.canonicalSourcePath),
    winnerSourcePath: winner.sourcePath,
    sourceBodiesDiffer: new Set(group.records.map((record) => record.body)).size > 1,
    ...(unresolvedReason ? { unresolvedReason } : {})
  };
}

function selectWinner(group: RepairGroup): DeclaredIdentitySourceRecord {
  return [...group.records].sort((left, right) => {
    const scoreDelta = (repairScore(right) ?? Number.NEGATIVE_INFINITY) - (repairScore(left) ?? Number.NEGATIVE_INFINITY);
    if (scoreDelta !== 0) return scoreDelta;
    const leftCanonical = left.sourcePath === group.canonicalSourcePath ? 0 : 1;
    const rightCanonical = right.sourcePath === group.canonicalSourcePath ? 0 : 1;
    return leftCanonical - rightCanonical || left.sourcePath.localeCompare(right.sourcePath);
  })[0]!;
}

function repairScore(record: DeclaredIdentitySourceRecord): number | null {
  try {
    const value = JSON.parse(record.body) as Record<string, unknown>;
    const stateScore = scoreLifecycleState(value.state);
    if (stateScore === null) return null;
    const arraysScore = ["outputs", "session_bindings", "deliverables", "evidence_refs", "verification_notes"].reduce(
      (score, field) => score + (Array.isArray(value[field]) ? value[field].length : 0),
      0
    );
    const lifecycleScore = ["submitted_at", "closed_at", "submission"].reduce(
      (score, field) => score + (value[field] === null || value[field] === undefined ? 0 : 2),
      0
    );
    return stateScore * 100 + arraysScore + lifecycleScore;
  } catch {
    return null;
  }
}

function scoreLifecycleState(state: unknown): number | null {
  if (state === undefined) return 0;
  if (typeof state !== "string") return null;
  return ({ active: 1, submitted: 3, accepted: 5, changes_requested: 4, abandoned: 2 } as Record<string, number>)[state] ?? null;
}

function repairDecision(group: RepairGroup): { readonly unresolved: boolean; readonly reason?: DeclaredIdentityConflictReport["unresolvedReason"] } {
  if (group.canonicalSourcePath === null) return { unresolved: true, reason: "ambiguous_canonical_path" };
  if (group.records.some((record) => repairScore(record) === null)) return { unresolved: true, reason: "unknown_lifecycle_state" };
  const canonical = group.records.find((record) => record.sourcePath === group.canonicalSourcePath);
  if (!canonical) return { unresolved: false };
  const winner = selectWinner(group);
  const sourceBodiesDiffer = new Set(group.records.map((record) => record.body)).size > 1;
  if (sourceBodiesDiffer && winner.sourcePath !== canonical.sourcePath) {
    return { unresolved: true, reason: "canonical_update_unproven" };
  }
  return { unresolved: false };
}

function repairGroup(authoredRoot: string, tasksRoot: string, group: RepairGroup): DeclaredIdentityRepairAction {
  const targetRelativePath = group.canonicalSourcePath!;
  const targetPath = path.join(authoredRoot, targetRelativePath);
  const winner = selectWinner(group);
  const sourcePaths = new Set(group.records.map((record) => record.sourcePath));
  const winnerBody = winner.body;
  let wroteCanonical = false;
  const quarantinedSourcePaths: string[] = [];
  const quarantinePaths: string[] = [];

  for (const sourcePath of sourcePaths) {
    if (sourcePath === targetRelativePath) continue;
    const sourceAbsolutePath = path.join(authoredRoot, sourcePath);
    if (!localDeclaredIdentityRepairFileSystem.exists(sourceAbsolutePath)) continue;
    const quarantinePath = quarantineSource(
      authoredRoot,
      group,
      sourcePath,
      sourceAbsolutePath,
      group.records.find((record) => record.sourcePath === sourcePath)?.body ?? ""
    );
    quarantinedSourcePaths.push(sourcePath);
    quarantinePaths.push(quarantinePath);
    removeEmptyDirectories(path.dirname(sourceAbsolutePath), tasksRoot);
  }

  const existingTargetBody = localDeclaredIdentityRepairFileSystem.exists(targetPath) ? readRepairText(targetPath) : null;
  if (existingTargetBody !== winnerBody) {
    if (existingTargetBody !== null) {
      const quarantinePath = quarantineSource(authoredRoot, group, targetRelativePath, targetPath, existingTargetBody);
      quarantinedSourcePaths.push(targetRelativePath);
      quarantinePaths.push(quarantinePath);
    }
    writeAtomic(authoredRoot, targetPath, winnerBody);
    wroteCanonical = true;
  }

  return {
    entityKind: group.entityKind,
    projectionTable: group.projectionTable,
    primaryKey: group.primaryKey,
    canonicalSourcePath: targetRelativePath,
    winnerSourcePath: winner.sourcePath,
    wroteCanonical,
    quarantinedSourcePaths: [...new Set(quarantinedSourcePaths)].sort(),
    quarantinePaths: [...new Set(quarantinePaths)].sort()
  };
}

function quarantineSource(
  authoredRoot: string,
  group: RepairGroup,
  sourcePath: string,
  sourceAbsolutePath: string,
  body: string
): string {
  assertNoSymlinkPath(authoredRoot, sourceAbsolutePath, localDeclaredIdentityRepairFileSystem);
  const quarantineBasePath = path.join(
    authoredRoot,
    ".repair",
    "declared-identity",
    group.projectionTable,
    safePathSegment(group.primaryKey),
    `${sourcePath.replaceAll("/", "__")}.${sha256Text(body).slice(0, 16)}`
  );
  const quarantinePath = nextAvailableQuarantinePath(quarantineBasePath);
  assertNoSymlinkPath(authoredRoot, quarantinePath, localDeclaredIdentityRepairFileSystem);
  localDeclaredIdentityRepairFileSystem.mkdirp(path.dirname(quarantinePath));
  assertNoSymlinkPath(authoredRoot, quarantinePath, localDeclaredIdentityRepairFileSystem);
  localDeclaredIdentityRepairFileSystem.rename(sourceAbsolutePath, quarantinePath);
  return relativePath(authoredRoot, quarantinePath);
}

function nextAvailableQuarantinePath(basePath: string): string {
  if (!localDeclaredIdentityRepairFileSystem.exists(basePath)) return basePath;
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = `${basePath}.${suffix}`;
    if (!localDeclaredIdentityRepairFileSystem.exists(candidate)) return candidate;
  }
  throw new Error(`declared identity quarantine namespace is exhausted: ${basePath}`);
}

function writeAtomic(authoredRoot: string, targetPath: string, body: string): void {
  assertNoSymlinkPath(authoredRoot, targetPath, localDeclaredIdentityRepairFileSystem);
  localDeclaredIdentityRepairFileSystem.mkdirp(path.dirname(targetPath));
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.repair.tmp`;
  assertNoSymlinkPath(authoredRoot, temporaryPath, localDeclaredIdentityRepairFileSystem);
  localDeclaredIdentityRepairFileSystem.writeText(temporaryPath, body);
  assertNoSymlinkPath(authoredRoot, targetPath, localDeclaredIdentityRepairFileSystem);
  assertNoSymlinkPath(authoredRoot, temporaryPath, localDeclaredIdentityRepairFileSystem);
  localDeclaredIdentityRepairFileSystem.rename(temporaryPath, targetPath);
}

function removeEmptyDirectories(startPath: string, stopPath: string): void {
  let current = startPath;
  const boundary = path.resolve(stopPath);
  while (path.resolve(current).startsWith(`${boundary}${path.sep}`)) {
    if (!localDeclaredIdentityRepairFileSystem.exists(current) || localDeclaredIdentityRepairFileSystem.readNames(current).length > 0) break;
    localDeclaredIdentityRepairFileSystem.removeEmptyDirectory(current);
    current = path.dirname(current);
  }
}

function readRepairText(filePath: string): string {
  // The repair has already captured the bytes from the stable source snapshot;
  // this local read is only used to make an idempotent write decision.
  return localDeclaredIdentityRepairFileSystem.readText(filePath);
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 160) || "identity";
}

function relativePath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}
