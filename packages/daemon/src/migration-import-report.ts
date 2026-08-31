import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { normalizePersistedTimestamp, type ColdRebuildIssue } from "../../kernel/src/index.ts";
import type {
  AuthoredCoverage,
  Draft,
  EntityKind,
  IdRemapping,
  ImportCounts,
  MigrationDisposition,
  MigrationBackfillRow,
  MigrationFieldDerivation,
  MigrationFormatObservation,
  MigrationKindReconciliation,
  MigrationOracleBasis,
  Skip,
  SourceGitIdentity,
} from "./migration-import-types.ts";
import { migrationOracleKinds, type MigrationOracleKind } from "./migration-import-oracle.ts";
import type { TaskContractRestatementCounts } from "./migration-import-task-restatement.ts";

export function isMigrationImportRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactMigrationFields(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasNonEmptyMigrationStrings(value: unknown): boolean {
  return Array.isArray(value) && value.every(nonEmpty);
}

export function skippedCounts(skips: readonly Skip[]): ImportCounts {
  return {
    task: count(skips, "task"),
    decision: count(skips, "decision"),
    fact: count(skips, "fact"),
    relation: count(skips, "relation"),
    agent: count(skips, "agent"),
    schedule: count(skips, "schedule"),
    "runtime-session": count(skips, "runtime-session"),
    coverage: skips.reduce((sum, item) => sum + (item.coverage ?? 0), 0),
  };
}

export function reportTable(
  dryRun: boolean,
  old: ImportCounts,
  skipped: ImportCounts,
  expected: ImportCounts,
  actual: ImportCounts,
  skips: readonly Skip[],
  idMapPath: string,
  unexplained: readonly MigrationOracleKind[],
  authored: AuthoredCoverage,
  attribution: { readonly restored: number; readonly fallback: number },
  sourceGit: SourceGitIdentity,
  remappings: readonly IdRemapping[],
  alreadyImported: ImportCounts,
  taskRestatement: TaskContractRestatementCounts,
  oracle: MigrationOracleBasis,
  setReconciliation: Readonly<Record<MigrationOracleKind, MigrationKindReconciliation>>,
  fieldDerivations: readonly MigrationFieldDerivation[],
  dispositions: readonly MigrationDisposition[],
  formatObservations: readonly MigrationFormatObservation[],
  backfillRows: readonly MigrationBackfillRow[],
  backfillMapPath: string,
): string {
  const rows = (Object.keys(old) as EntityKind[]).map((kind) =>
      [
        "| ",
        `${kind}`,
        " | ",
        `${old[kind]}`,
        " | ",
        `${skipped[kind]}`,
        " | ",
        `${expected[kind]}`,
        " | ",
        `${actual[kind]}`,
        " | ",
        `${actual[kind] === expected[kind] ? "PASS" : "FAIL"}`,
        " |",
      ].join(""),
    ),
    authoredRows = authored.rows.map((row) =>
      [
        "| ",
        `${row.surface}`,
        " | ",
        `${row.disposition}`,
        " | ",
        `${row.old}`,
        " | ",
        `${row.disposition === "migrated" || row.disposition === "excluded" ? "PASS" : "FAIL"}`,
        " | ",
        `${row.reason}`,
        " |",
      ].join(""),
    ),
    requiredRows = authored.rows
      .filter(({ disposition }) => disposition === "required")
      .map((row) => `- REQUIRED ${row.surface} (${row.old}): ${row.reason}; examples: ${row.samples.join(", ")}`),
    already = Object.entries(alreadyImported)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(", "),
    reconciliation = unexplained.length ? `FAIL (${unexplained.join(", ")})` : "PASS",
    oracleRows = migrationOracleKinds.map((kind) => {
      const row = setReconciliation[kind];
      return [
        `| ${kind} | ${row.source} | ${row.target} | ${row.difference}`,
        `| ${row.derived} | ${row.archived} | ${row.retired}`,
        `| ${row.passed ? "PASS" : "FAIL"} |`,
      ].join(" ");
    }),
    sampleRows = migrationOracleKinds.flatMap((kind) => [
      ...fieldDerivations
        .filter(({ entityType }) => entityType === kind)
        .slice(0, 20)
        .map(({ entityId, field, derived_from }) => `- SAMPLE derived ${kind} ${entityId}.${field} <- ${derived_from}`),
      ...dispositions
        .filter(({ entityType }) => entityType === kind)
        .slice(0, 20)
        .map(
          ({ entityId, disposition, sourcePath, reason }) =>
            `- SAMPLE ${disposition} ${kind} ${entityId} (${sourcePath}): ${reason}`,
        ),
    ]),
    backfillDifferenceRows = backfillRows.map(
      ({ entityType, entityId, action, sourceAnchor }) =>
        `| ${entityType} | ${entityId} | ${action} | ${sourceAnchor} |`,
    );
  return [
    `Migration import ${dryRun ? "dry-run" : "apply"}`,
    `Source Git: root=${sourceGit.rootCommit}, head=${sourceGit.head}, tree=${sourceGit.tree}, clean=true`,
    [
      `Oracle: ${oracle.kind}, database=${oracle.databasePath}, watermark=${oracle.watermark}`,
      `eventHeadRevision=${oracle.eventHeadRevision ?? "absent"}`,
    ].join(", "),
    "",
    "| Entity | Oracle | Observed skips | Expected | Target included | Result |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...rows,
    "Skipped observations are diagnostic only; they are not subtracted from the same-cut oracle.",
    "",
    "| Kind | Source active | Target included | Difference | Derived | Archived | Retired | Result |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...oracleRows,
    ...sampleRows,
    "",
    "| Contract restatement | Source | Target | Pinned preserved | Pinned explicit false | Provenance |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    [
      "| Task/v1 -> Task/v2 | ",
      `${taskRestatement.sourceV1}`,
      " | ",
      `${taskRestatement.targetV2}`,
      " | ",
      `${taskRestatement.pinnedPreserved}`,
      " | ",
      `${taskRestatement.pinnedExplicitFalse}`,
      " | ",
      `${taskRestatement.importedSnapshot}`,
      " imported_snapshot |",
    ].join(""),
    "",
    `Already imported from this Git lineage: ${already || "none"}`,
    `ID remappings: ${remappings.length ? remappings.length : "none"}`,
    ...remappings.map((item) => `- REMAP ${item.entityType} ${item.sourceId} -> ${item.targetId}: ${item.reason}`),
    `Format observations: ${skips.length ? `${skips.length} legacy parser observations` : "none"}; ` +
      (formatObservations.length
        ? `${formatObservations.length} accepted historical variants`
        : "no accepted historical variants"),
    ...formatObservations.map(
      (item) => `- ACCEPT ${item.code} (${item.sourcePath}): ${item.detail}; treatment=${item.treatment}`,
    ),
    "",
    "| Backfill family | Entity ID | Difference | Source anchor |",
    "| --- | --- | --- | --- |",
    ...backfillDifferenceRows,
    `Backfill map: ${dryRun || !authored.passed ? `would write ${backfillMapPath}` : backfillMapPath}`,
    [
      "Attribution: principal restored from source records for ",
      `${attribution.restored}`,
      " entities, ",
      `${attribution.fallback}`,
      " fell back to the importer; executor is the importer throughout",
    ].join(""),
    ...[...skips]
      .sort(bySkip)
      .map((item) => `- SKIP ${item.entityType} ${item.migratedFrom} (${item.sourcePath}): ${item.reason}`),
    "",
    "| Authored surface | Disposition | Old | Result | Rule |",
    "| --- | --- | ---: | --- | --- |",
    ...authoredRows,
    ...requiredRows,
    [
      "Authored directory audit (informational): ",
      authored.passed ? "complete" : `required=${authored.counts.required}`,
    ].join(""),
    `ID map: ${dryRun || !authored.passed ? `would write ${idMapPath}` : idMapPath}`,
    ["Reconciliation: ", reconciliation, ""].join(""),
  ].join("\n");
}

export function fromColdIssue(issue: ColdRebuildIssue): Skip {
  return { ...issue, entityType: issue.entityType };
}

export function sourcePathFor(kind: Draft["kind"], id: string): string {
  return `${kind}:${id}`;
}

export function taskIndexPaths(tasksRoot: string): readonly string[] {
  try {
    return readdirSync(tasksRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(tasksRoot, entry.name, "INDEX.md"))
      .filter((target) => {
        try {
          return statSync(target).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

export function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = clean(value);
  return normalizePersistedTimestamp(cleaned);
}

export function clean(value: string): string {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

export function count(skips: readonly Skip[], kind: EntityKind): number {
  return skips.filter(({ entityType }) => entityType === kind).length;
}

export function bySkip(a: Skip, b: Skip): number {
  return `${a.entityType}\0${a.migratedFrom}`.localeCompare(`${b.entityType}\0${b.migratedFrom}`);
}

export function requiredMigrationText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw migrationImportError("invalid_command", `${field} is required`);
  return value;
}

export function migrationImportError(code: string, detail: string): Error {
  return Object.assign(new Error(detail), { code });
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
