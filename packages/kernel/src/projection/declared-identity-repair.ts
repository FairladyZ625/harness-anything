import path from "node:path";
import type { HarnessLayoutInput } from "../layout/index.ts";
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
  readonly canonicalSourcePresent: boolean;
  readonly winnerSourcePath: string;
  readonly sourceBodiesDiffer: boolean;
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
    .filter((group) => group.canonicalSourcePath === null)
    .map(conflictReportForGroup);
  const actions: DeclaredIdentityRepairAction[] = [];
  for (const group of actionable) {
    if (!group.canonicalSourcePath) continue;
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
  return {
    entityKind: group.entityKind,
    projectionTable: group.projectionTable,
    primaryKey: group.primaryKey,
    sourcePaths,
    canonicalSourcePath: group.canonicalSourcePath,
    canonicalSourcePresent: group.canonicalSourcePath !== null && sourcePaths.includes(group.canonicalSourcePath),
    winnerSourcePath: winner.sourcePath,
    sourceBodiesDiffer: new Set(group.records.map((record) => record.body)).size > 1
  };
}

function selectWinner(group: RepairGroup): DeclaredIdentitySourceRecord {
  return [...group.records].sort((left, right) => {
    const scoreDelta = repairScore(right) - repairScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    const leftCanonical = left.sourcePath === group.canonicalSourcePath ? 0 : 1;
    const rightCanonical = right.sourcePath === group.canonicalSourcePath ? 0 : 1;
    return leftCanonical - rightCanonical || left.sourcePath.localeCompare(right.sourcePath);
  })[0]!;
}

function repairScore(record: DeclaredIdentitySourceRecord): number {
  try {
    const value = JSON.parse(record.body) as Record<string, unknown>;
    const stateScore = typeof value.state === "string"
      ? ({ active: 1, submitted: 3, changes_requested: 4, accepted: 5, abandoned: 2 } as Record<string, number>)[value.state] ?? 0
      : 0;
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
    return 0;
  }
}

function repairGroup(authoredRoot: string, tasksRoot: string, group: RepairGroup): DeclaredIdentityRepairAction {
  const targetRelativePath = group.canonicalSourcePath!;
  const targetPath = path.join(authoredRoot, targetRelativePath);
  const winner = selectWinner(group);
  const sourcePaths = new Set(group.records.map((record) => record.sourcePath));
  const winnerBody = winner.body;
  let wroteCanonical = false;
  const quarantinedSourcePaths: string[] = [];

  for (const sourcePath of sourcePaths) {
    if (sourcePath === targetRelativePath) continue;
    const sourceAbsolutePath = path.join(authoredRoot, sourcePath);
    if (!localDeclaredIdentityRepairFileSystem.exists(sourceAbsolutePath)) continue;
    quarantineSource(authoredRoot, group, sourcePath, sourceAbsolutePath);
    quarantinedSourcePaths.push(sourcePath);
    removeEmptyDirectories(path.dirname(sourceAbsolutePath), tasksRoot);
  }

  const existingTargetBody = localDeclaredIdentityRepairFileSystem.exists(targetPath) ? readRepairText(targetPath) : null;
  if (existingTargetBody !== winnerBody) {
    if (existingTargetBody !== null) {
      quarantineSource(authoredRoot, group, targetRelativePath, targetPath);
      quarantinedSourcePaths.push(targetRelativePath);
    }
    writeAtomic(targetPath, winnerBody);
    wroteCanonical = true;
  }

  return {
    entityKind: group.entityKind,
    projectionTable: group.projectionTable,
    primaryKey: group.primaryKey,
    canonicalSourcePath: targetRelativePath,
    winnerSourcePath: winner.sourcePath,
    wroteCanonical,
    quarantinedSourcePaths: [...new Set(quarantinedSourcePaths)].sort()
  };
}

function quarantineSource(
  authoredRoot: string,
  group: RepairGroup,
  sourcePath: string,
  sourceAbsolutePath: string
): void {
  const quarantinePath = path.join(
    authoredRoot,
    ".repair",
    "declared-identity",
    group.projectionTable,
    safePathSegment(group.primaryKey),
    sourcePath.replaceAll("/", "__")
  );
  localDeclaredIdentityRepairFileSystem.mkdirp(path.dirname(quarantinePath));
  if (localDeclaredIdentityRepairFileSystem.exists(quarantinePath)) localDeclaredIdentityRepairFileSystem.remove(quarantinePath);
  localDeclaredIdentityRepairFileSystem.rename(sourceAbsolutePath, quarantinePath);
}

function writeAtomic(targetPath: string, body: string): void {
  localDeclaredIdentityRepairFileSystem.mkdirp(path.dirname(targetPath));
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.repair.tmp`;
  localDeclaredIdentityRepairFileSystem.writeText(temporaryPath, body);
  if (localDeclaredIdentityRepairFileSystem.exists(targetPath)) localDeclaredIdentityRepairFileSystem.remove(targetPath);
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
