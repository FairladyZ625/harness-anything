import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { type ColdRebuildIssue } from "../../kernel/src/index.ts";
import type {
  AuthoredCoverage,
  Draft,
  EntityKind,
  IdRemapping,
  ImportCounts,
  Skip,
  SourceGitIdentity,
} from "./migration-import-types.ts";

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

export function zeroCounts(): ImportCounts {
  return { task: 0, decision: 0, fact: 0, relation: 0, coverage: 0 };
}

export function skippedCounts(skips: readonly Skip[]): ImportCounts {
  return {
    task: count(skips, "task"),
    decision: count(skips, "decision"),
    fact: count(skips, "fact"),
    relation: count(skips, "relation"),
    coverage: skips.reduce((sum, item) => sum + (item.coverage ?? 0), 0),
  };
}

export function subtract(old: ImportCounts, skipped: ImportCounts): ImportCounts {
  return Object.fromEntries(
    (Object.keys(old) as EntityKind[]).map((kind) => [kind, old[kind] - skipped[kind]]),
  ) as unknown as ImportCounts;
}

export function reportTable(
  dryRun: boolean,
  old: ImportCounts,
  skipped: ImportCounts,
  expected: ImportCounts,
  actual: ImportCounts,
  skips: readonly Skip[],
  idMapPath: string,
  unexplained: readonly EntityKind[],
  authored: AuthoredCoverage,
  attribution: { readonly restored: number; readonly fallback: number },
  sourceGit: SourceGitIdentity,
  remappings: readonly IdRemapping[],
  alreadyImported: ImportCounts,
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
    reconciliation =
      unexplained.length || !authored.passed
        ? `FAIL (${[...unexplained, ...(!authored.passed ? ["authored"] : [])].join(", ")})`
        : "PASS";
  return [
    `Migration import ${dryRun ? "dry-run" : "apply"}`,
    `Source Git: root=${sourceGit.rootCommit}, head=${sourceGit.head}, tree=${sourceGit.tree}, clean=true`,
    "",
    "| Entity | Old | Skipped | Expected | New | Result |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...rows,
    "",
    `Already imported from this Git lineage: ${already || "none"}`,
    `ID remappings: ${remappings.length ? remappings.length : "none"}`,
    ...remappings.map((item) => `- REMAP ${item.entityType} ${item.sourceId} -> ${item.targetId}: ${item.reason}`),
    `Format validation: ${skips.length ? `${skips.length} skipped` : "PASS"}`,
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
    `Authored reconciliation: ${authored.passed ? "PASS" : `FAIL (required=${authored.counts.required})`}`,
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
  return Number.isFinite(Date.parse(cleaned)) ? cleaned : null;
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
