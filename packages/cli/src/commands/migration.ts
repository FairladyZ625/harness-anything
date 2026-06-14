import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import { resolveHarnessLayout } from "../../../kernel/src/layout/index.ts";
import { LegacyIndexSchema, type LegacyIndex, type LegacyIndexEntry } from "../../../kernel/src/schemas/registry.ts";
import type { CliResult } from "../cli/types.ts";
import { applyCollisionReport, buildLegacyCopyPlan, readCollisionReport, writeCollisionReport } from "./migration-collision.ts";
import { collectLegacyProvenanceWarnings } from "./legacy-provenance-verify.ts";
import { buildScanReport, copyForwardDocs, copySource, renderIntakePlan, stripScanOnlyFields, summarize, type LegacyScanReport } from "./migration-scan.ts";
import type { LegacyCopySafeDocsAction, LegacyIndexAction, LegacyIntakePlanAction, LegacyScanAction, LegacyVerifyAction, MigratePlanAction, MigrateRunAction, MigrateStructureAction, MigrateVerifyAction } from "./migration-types.ts";

interface LegacyIntakeSession {
  readonly schema: "legacy-intake-session/v1";
  readonly strategy: "legacy-intake";
  readonly applied: boolean;
  readonly compatibility?: {
    readonly locale?: "zh-CN" | "en-US";
    readonly assumeLocale?: "zh-CN" | "en-US";
    readonly allowDirty: boolean;
    readonly sessionDir?: string;
  };
  readonly indexDigest: `sha256:${string}`;
  readonly entries: ReadonlyArray<LegacyIndexEntry>;
}

type LegacyIndexValidation =
  | { readonly ok: true; readonly index: LegacyIndex }
  | { readonly ok: false; readonly result: CliResult };

export function runMigratePlan(rootDir: string, action: MigratePlanAction): CliResult {
  const report = limitReport(buildScanReport(rootDir, "."), action.limit);
  return aliasResult("migrate-plan", report, {
    aliasOf: "legacy scan",
    hint: "migrate-plan is a Legacy Intake compatibility alias. It does not promise automatic migration or full cutover."
  });
}

export function runMigrateStructure(rootDir: string, action: MigrateStructureAction): CliResult {
  const report = buildScanReport(rootDir, ".");
  if (action.mode === "plan") {
    return aliasResult("migrate-structure", report, {
      aliasOf: "legacy copy-safe-docs",
      migrationMode: "plan",
      hint: "migrate-structure --plan is a Legacy Intake dry-run alias."
    });
  }
  if (!action.confirmPlan) {
    return {
      ok: false,
      command: "migrate-structure",
      migrationMode: "apply",
      report,
      error: {
        code: "plan_confirmation_required",
        hint: "Run migrate-structure --plan first, inspect the Legacy Intake plan, then rerun --apply --confirm-plan."
      }
    };
  }
  const copied = applyLegacyCopy(rootDir, report);
  if (!copied.ok) return aliasFailure("migrate-structure", copied);
  const indexResult = applyLegacyIndex(rootDir, report);
  if (!indexResult.ok) return aliasFailure("migrate-structure", indexResult);
  return aliasResult("migrate-structure", report, {
    aliasOf: "legacy copy-safe-docs + legacy index",
    migrationMode: "apply",
    hint: "Legacy sources were copied under harness/legacy only; active task packages were not rewritten."
  });
}

export function runMigrateRun(rootDir: string, action: MigrateRunAction): CliResult {
  const report = buildScanReport(rootDir, ".");
  if (!action.planOnly) {
    const copied = applyLegacyCopy(rootDir, report);
    if (!copied.ok) return aliasFailure("migrate-run", copied);
    const indexed = applyLegacyIndex(rootDir, report);
    if (!indexed.ok) return aliasFailure("migrate-run", indexed);
  }
  const session: LegacyIntakeSession = {
    schema: "legacy-intake-session/v1",
    strategy: "legacy-intake",
    applied: !action.planOnly,
    compatibility: {
      locale: action.locale,
      assumeLocale: action.assumeLocale,
      allowDirty: action.allowDirty,
      sessionDir: action.sessionDir
    },
    indexDigest: digestJson(toLegacyIndex(rootDir, report)),
    entries: report.entries
  };
  const sessionPath = writeSession(rootDir, action.outDir, session);
  return {
    ok: true,
    command: "migrate-run",
    path: relative(rootDir, sessionPath),
    rows: report.entries.length,
    warnings: [retiredMigrationWarning("migrate-run", "legacy scan/copy/index")],
    report: session
  };
}

export function runMigrateVerify(rootDir: string, action: MigrateVerifyAction): CliResult {
  if (action.fullCutover) {
    return {
      ok: false,
      command: "migrate-verify",
      report: {
        schema: "legacy-intake-verify-report/v1",
        strategy: "legacy-intake",
        fullCutover: "retired"
      },
      error: {
        code: "full_cutover_retired",
        hint: "Full cutover is retired. Use harness legacy verify and agent-assisted rebuild instead."
      }
    };
  }
  return runLegacyVerify(rootDir, { kind: "legacy-verify" });
}

export function runLegacyScan(rootDir: string, action: LegacyScanAction): CliResult {
  const report = buildScanReport(rootDir, action.sourcePath);
  return {
    ok: true,
    command: "legacy-scan",
    rows: report.entries.length,
    report
  };
}

export function runLegacyIntakePlan(rootDir: string, action: LegacyIntakePlanAction): CliResult {
  const report = buildScanReport(rootDir, action.sourcePath);
  const body = renderIntakePlan(report);
  if (action.outPath) {
    const outPath = path.resolve(rootDir, action.outPath);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, body, "utf8");
  }
  return {
    ok: true,
    command: "legacy-intake-plan",
    path: action.outPath ? normalizeSlashes(action.outPath) : undefined,
    rows: report.entries.length,
    report
  };
}

export function runLegacyCopySafeDocs(rootDir: string, action: LegacyCopySafeDocsAction): CliResult {
  const report = buildScanReport(rootDir, action.sourcePath);
  if (!action.apply) {
    return {
      ok: true,
      command: "legacy-copy-safe-docs",
      migrationMode: "plan",
      rows: report.entries.length,
      report
    };
  }
  return applyLegacyCopy(rootDir, report);
}

export function runLegacyIndex(rootDir: string, action: LegacyIndexAction): CliResult {
  const report = buildScanReport(rootDir, action.sourcePath);
  if (!action.apply) {
    return {
      ok: true,
      command: "legacy-index",
      migrationMode: "plan",
      rows: report.entries.length,
      report: toLegacyIndex(rootDir, report)
    };
  }
  return applyLegacyIndex(rootDir, report);
}

export function runLegacyVerify(rootDir: string, _action: LegacyVerifyAction): CliResult {
  const layout = resolveHarnessLayout(rootDir);
  if (!existsSync(layout.legacyIndexPath)) {
    return {
      ok: false,
      command: "legacy-verify",
      report: { schema: "legacy-intake-verify-report/v1", ok: false, missingIndex: true },
      error: { code: "legacy_index_missing", hint: "harness/legacy/index.json is missing. Run legacy index <path> --apply." }
    };
  }
  let index: LegacyIndex;
  try {
    index = Schema.decodeUnknownSync(LegacyIndexSchema)(JSON.parse(readFileSync(layout.legacyIndexPath, "utf8")));
  } catch {
    return {
      ok: false,
      command: "legacy-verify",
      report: { schema: "legacy-intake-verify-report/v1", ok: false, invalidIndex: true },
      error: { code: "legacy_index_invalid", hint: "harness/legacy/index.json does not match the runtime LegacyIndexSchema." }
    };
  }
  let collisionReport: ReturnType<typeof readCollisionReport>;
  try {
    collisionReport = readCollisionReport(rootDir);
  } catch {
    return {
      ok: false,
      command: "legacy-verify",
      report: { schema: "legacy-intake-verify-report/v1", ok: false, invalidCollisionReport: true },
      error: { code: "legacy_collision_report_invalid", hint: "harness/legacy/collision-report.json does not match the runtime LegacyCollisionReportSchema." }
    };
  }
  const missingTargets = index.entries
    .map((entry) => entry.storedPath)
    .filter((storedPath) => !existsSync(path.join(rootDir, storedPath)));
  const ok = missingTargets.length === 0;
  const provenanceWarnings = collectLegacyProvenanceWarnings(rootDir);
  return {
    ok,
    command: "legacy-verify",
    rows: index.entries.length,
    warnings: provenanceWarnings.length > 0 ? provenanceWarnings : undefined,
    report: {
      schema: "legacy-intake-verify-report/v1",
      ok,
      missingIndex: false,
      invalidIndex: false,
      missingTargets,
      provenanceWarnings,
      summary: index.summary,
      collisionReport: collisionReport ? {
        entryCount: collisionReport.entries.length,
        overwriteAllowed: collisionReport.policy.overwriteAllowed
      } : undefined
    },
    error: ok ? undefined : { code: "legacy_index_targets_missing", hint: "Legacy index references stored paths that do not exist." }
  };
}

function applyLegacyCopy(rootDir: string, report: LegacyScanReport): CliResult {
  const validation = validateLegacyIndex(rootDir, report);
  if (!validation.ok) return validation.result;
  const duplicateTarget = firstDuplicate(report.entries.map((entry) => entry.storedPath));
  if (duplicateTarget) {
    return {
      ok: false,
      command: "legacy-copy-safe-docs",
      migrationMode: "apply",
      report,
      error: {
        code: "legacy_duplicate_target",
        hint: `Legacy Intake plan has duplicate target: ${duplicateTarget}`
      }
    };
  }
  const copyPlan = buildLegacyCopyPlan(rootDir, report.sourceRoot, report.entries);
  writeCollisionReport(rootDir, copyPlan.collisionReport);
  for (const target of copyPlan.targets) {
    copySource(target.sourcePath, path.join(rootDir, target.chosenPath));
  }
  copyForwardDocs(rootDir, report);
  return {
    ok: true,
    command: "legacy-copy-safe-docs",
    migrationMode: "apply",
    rows: report.entries.length,
    report: {
      ...report,
      entries: applyCollisionReport(report.entries, copyPlan.collisionReport),
      collisionReport: copyPlan.collisionReport
    }
  };
}

function applyLegacyIndex(rootDir: string, report: LegacyScanReport): CliResult {
  const layout = resolveHarnessLayout(rootDir);
  const collisionReport = readCollisionReport(rootDir);
  const indexedReport = { ...report, entries: applyCollisionReport(report.entries, collisionReport), summary: summarize(applyCollisionReport(report.entries, collisionReport)) };
  const validation = validateLegacyIndex(rootDir, indexedReport);
  if (!validation.ok) return validation.result;
  const index = validation.index;
  mkdirSync(path.dirname(layout.legacyIndexPath), { recursive: true });
  writeFileSync(layout.legacyIndexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return {
    ok: true,
    command: "legacy-index",
    migrationMode: "apply",
    path: "harness/legacy/index.json",
    rows: index.entries.length,
    report: index
  };
}

function validateLegacyIndex(rootDir: string, report: LegacyScanReport): LegacyIndexValidation {
  try {
    return { ok: true, index: Schema.decodeUnknownSync(LegacyIndexSchema)(toLegacyIndex(rootDir, report)) };
  } catch {
    return {
      ok: false,
      result: {
        ok: false,
        command: "legacy-index",
        report,
        error: {
          code: "legacy_index_schema_invalid",
          hint: "Generated Legacy Intake index failed runtime LegacyIndexSchema validation."
        }
      }
    };
  }
}

function toLegacyIndex(rootDir: string, report: LegacyScanReport): LegacyIndex {
  return {
    schema: "legacy-index/v1",
    legacyRoot: "harness/legacy",
    generatedAt: new Date(0).toISOString(),
    sourceRoot: report.sourceRoot,
    entries: report.entries.map(stripScanOnlyFields),
    summary: summarize(report.entries)
  };
}

function aliasResult(command: string, report: LegacyScanReport, meta: { readonly aliasOf: string; readonly hint: string; readonly migrationMode?: "plan" | "apply" }): CliResult {
  return {
    ok: true,
    command,
    migrationMode: meta.migrationMode,
    rows: report.entries.length,
    warnings: [retiredMigrationWarning(command, meta.aliasOf)],
    report: {
      ...report,
      aliasOf: meta.aliasOf,
      compatibilityNotice: meta.hint
    }
  };
}

function aliasFailure(command: string, result: CliResult): CliResult {
  return {
    ...result,
    command,
    warnings: [
      ...(result.warnings ?? []),
      retiredMigrationWarning(command, "legacy scan/copy/index")
    ]
  };
}

function retiredMigrationWarning(command: string, aliasOf: string): Record<string, string> {
  return {
    code: "migration_alias_legacy_intake",
    command,
    aliasOf,
    severity: "warning",
    message: `${command} is a compatibility alias for Legacy Intake and does not perform automatic migration or full cutover.`
  };
}

function limitReport(report: LegacyScanReport, limit: number): LegacyScanReport {
  if (!Number.isFinite(limit)) return report;
  const entries = report.entries.slice(0, Math.max(0, limit));
  return { ...report, entries, summary: summarize(entries) };
}

function firstDuplicate(values: ReadonlyArray<string>): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function digestJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function writeSession(rootDir: string, outDir: string, session: LegacyIntakeSession): string {
  const directory = path.resolve(rootDir, outDir);
  mkdirSync(directory, { recursive: true });
  const sessionPath = path.join(directory, "session.json");
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  return sessionPath;
}

function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

function relative(rootDir: string, targetPath: string): string {
  return normalizeSlashes(path.relative(rootDir, targetPath));
}
