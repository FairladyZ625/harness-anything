import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect, Schema } from "effect";
import { moduleEntityId, stablePayloadHash, type WriteCoordinator, type WriteError } from "../../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../../kernel/src/index.ts";
import { resolveHarnessLayout } from "../../../kernel/src/index.ts";
import { LegacyIndexSchema, type LegacyIndex, type LegacyIndexEntry } from "../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { isGeneratedOrVendorPath, isPathInside, normalizeSlashes } from "../cli/path.ts";
import type { CliResult } from "../cli/types.ts";
import { applyCollisionReport, buildLegacyCopyPlan, readCollisionReport, writeCollisionReport } from "./migration-collision.ts";
import { collectLegacyProvenanceWarnings } from "./legacy-provenance-verify.ts";
import { buildScanReport, copyForwardDocs, copySource, renderIntakePlan, stripScanOnlyFields, summarize, type LegacyScanReport } from "./migration-scan.ts";
import type { LegacyCopySafeDocsAction, LegacyIndexAction, LegacyIntakePlanAction, LegacyScanAction, LegacyVerifyAction, MigratePlanAction, MigrateRunAction, MigrateStructureAction, MigrateVerifyAction } from "./migration-types.ts";
import { writeCoordinatedPayload } from "./core/coordinated-machine-write.ts";

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

export function runMigratePlan(rootInput: HarnessLayoutInput, action: MigratePlanAction): CliResult {
  const report = limitReport(buildScanReport(rootInput, "."), action.limit);
  return aliasResult("migrate-plan", report, {
    aliasOf: "legacy scan",
    hint: "migrate-plan is a Legacy Intake compatibility alias. It does not promise automatic migration or full cutover."
  });
}

export function runMigrateStructure(rootInput: HarnessLayoutInput, action: MigrateStructureAction): CliResult {
  const report = buildScanReport(rootInput, ".");
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
      error: cliError(CliErrorCode.PlanConfirmationRequired, "Run migrate-structure --plan first, inspect the Legacy Intake plan, then rerun --apply --confirm-plan.")
    };
  }
  const copied = applyLegacyCopy(rootInput, report);
  if (!copied.ok) return aliasFailure("migrate-structure", copied);
  const indexResult = applyLegacyIndex(rootInput, report);
  if (!indexResult.ok) return aliasFailure("migrate-structure", indexResult);
  return aliasResult("migrate-structure", report, {
    aliasOf: "legacy copy-safe-docs + legacy index",
    migrationMode: "apply",
    hint: "Legacy sources were copied under harness/legacy only; active task packages were not rewritten."
  });
}

export function runMigrateStructureEffect(rootInput: HarnessLayoutInput, action: MigrateStructureAction, coordinator: WriteCoordinator): Effect.Effect<CliResult, WriteError> {
  const report = buildScanReport(rootInput, ".");
  if (action.mode === "plan") return Effect.succeed(runMigrateStructure(rootInput, action));
  if (!action.confirmPlan) return Effect.succeed(runMigrateStructure(rootInput, action));
  return applyLegacyCopyEffect(rootInput, report, coordinator).pipe(
    Effect.map((copied) => {
      if (!copied.ok) return aliasFailure("migrate-structure", copied);
      const indexResult = applyLegacyIndex(rootInput, report);
      if (!indexResult.ok) return aliasFailure("migrate-structure", indexResult);
      return aliasResult("migrate-structure", report, {
        aliasOf: "legacy copy-safe-docs + legacy index",
        migrationMode: "apply",
        hint: "Legacy sources were copied under harness/legacy only; active authored forward docs were serialized through the daemon write queue."
      });
    })
  );
}

export function runMigrateRun(rootInput: HarnessLayoutInput, action: MigrateRunAction): CliResult {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const report = buildScanReport(rootInput, ".");
  if (!action.planOnly) {
    const copied = applyLegacyCopy(rootInput, report);
    if (!copied.ok) return aliasFailure("migrate-run", copied);
    const indexed = applyLegacyIndex(rootInput, report);
    if (!indexed.ok) return aliasFailure("migrate-run", indexed);
  }
  return migrateRunSessionResult(rootDir, report, action);
}

function migrateRunSessionResult(rootDir: string, report: LegacyScanReport, action: MigrateRunAction): CliResult {
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

export function runMigrateRunEffect(rootInput: HarnessLayoutInput, action: MigrateRunAction, coordinator: WriteCoordinator): Effect.Effect<CliResult, WriteError> {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const report = buildScanReport(rootInput, ".");
  if (!action.planOnly) {
    return applyLegacyCopyEffect(rootInput, report, coordinator).pipe(
      Effect.map((copied) => {
        if (!copied.ok) return aliasFailure("migrate-run", copied);
        const indexed = applyLegacyIndex(rootInput, report);
        if (!indexed.ok) return aliasFailure("migrate-run", indexed);
        return migrateRunSessionResult(rootDir, report, action);
      })
    );
  }
  return Effect.succeed(migrateRunSessionResult(rootDir, report, action));
}

export function runMigrateVerify(rootInput: HarnessLayoutInput, action: MigrateVerifyAction): CliResult {
  if (action.fullCutover) {
    return {
      ok: false,
      command: "migrate-verify",
      report: {
        schema: "legacy-intake-verify-report/v1",
        strategy: "legacy-intake",
        fullCutover: "retired"
      },
      error: cliError(CliErrorCode.FullCutoverRetired, "Full cutover is retired. Use harness-anything legacy verify and agent-assisted rebuild instead.")
    };
  }
  return runLegacyVerify(rootInput, { kind: "legacy-verify" });
}

export function runLegacyScan(rootInput: HarnessLayoutInput, action: LegacyScanAction): CliResult {
  const report = buildScanReport(rootInput, action.sourcePath);
  return {
    ok: true,
    command: "legacy-scan",
    rows: report.entries.length,
    report
  };
}

export function runLegacyIntakePlan(rootInput: HarnessLayoutInput, action: LegacyIntakePlanAction): CliResult {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const report = buildScanReport(rootInput, action.sourcePath);
  const body = renderIntakePlan(report);
  let outputPath: string | undefined;
  if (action.outPath) {
    const resolved = resolveLegacyIntakeArtifactPath(rootDir, action.outPath);
    if (!resolved.ok) {
      return {
        ok: false,
        command: "legacy-intake-plan",
        report,
        error: cliError(CliErrorCode.ArtifactWriteRejected, "Legacy intake plans can only be written beneath .harness/migration-artifacts using a non-symlink relative path.")
      };
    }
    outputPath = resolved.path;
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, body, "utf8");
  }
  return {
    ok: true,
    command: "legacy-intake-plan",
    path: outputPath ? normalizeSlashes(path.relative(rootDir, outputPath)) : undefined,
    rows: report.entries.length,
    report
  };
}

function resolveLegacyIntakeArtifactPath(rootDir: string, requestedPath: string): { readonly ok: true; readonly path: string } | { readonly ok: false } {
  const artifactRoot = path.join(rootDir, ".harness", "migration-artifacts");
  if (path.isAbsolute(requestedPath)) return { ok: false };
  const outputPath = path.resolve(artifactRoot, requestedPath);
  if (!isPathInside(artifactRoot, outputPath) || hasSymlinkInExistingPath(artifactRoot, outputPath)) return { ok: false };
  return { ok: true, path: outputPath };
}

function hasSymlinkInExistingPath(rootPath: string, targetPath: string): boolean {
  let current = rootPath;
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true;
  const relative = path.relative(rootPath, targetPath);
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

export function runLegacyCopySafeDocs(rootInput: HarnessLayoutInput, action: LegacyCopySafeDocsAction): CliResult {
  const report = buildScanReport(rootInput, action.sourcePath);
  if (!action.apply) {
    return {
      ok: true,
      command: "legacy-copy-safe-docs",
      migrationMode: "plan",
      rows: report.entries.length,
      report
    };
  }
  return applyLegacyCopy(rootInput, report);
}

export function runLegacyCopySafeDocsEffect(rootInput: HarnessLayoutInput, action: LegacyCopySafeDocsAction, coordinator: WriteCoordinator): Effect.Effect<CliResult, WriteError> {
  const report = buildScanReport(rootInput, action.sourcePath);
  if (!action.apply) return Effect.succeed(runLegacyCopySafeDocs(rootInput, action));
  return applyLegacyCopyEffect(rootInput, report, coordinator);
}

export function runLegacyIndex(rootInput: HarnessLayoutInput, action: LegacyIndexAction): CliResult {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const report = buildScanReport(rootInput, action.sourcePath);
  if (!action.apply) {
    return {
      ok: true,
      command: "legacy-index",
      migrationMode: "plan",
      rows: report.entries.length,
      report: toLegacyIndex(rootDir, report)
    };
  }
  return applyLegacyIndex(rootInput, report);
}

export function runLegacyVerify(rootInput: HarnessLayoutInput, _action: LegacyVerifyAction): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  if (!existsSync(layout.legacyIndexPath)) {
    return {
      ok: false,
      command: "legacy-verify",
      report: { schema: "legacy-intake-verify-report/v1", ok: false, missingIndex: true },
      error: cliError(CliErrorCode.LegacyIndexMissing, "harness/legacy/index.json is missing. Run legacy index <path> --apply.")
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
      error: cliError(CliErrorCode.LegacyIndexInvalid, "harness/legacy/index.json does not match the runtime LegacyIndexSchema.")
    };
  }
  let collisionReport: ReturnType<typeof readCollisionReport>;
  try {
    collisionReport = readCollisionReport(rootInput);
  } catch {
    return {
      ok: false,
      command: "legacy-verify",
      report: { schema: "legacy-intake-verify-report/v1", ok: false, invalidCollisionReport: true },
      error: cliError(CliErrorCode.LegacyCollisionReportInvalid, "harness/legacy/collision-report.json does not match the runtime LegacyCollisionReportSchema.")
    };
  }
  const missingTargets = index.entries
    .map((entry) => entry.storedPath)
    .filter((storedPath) => !existsSync(path.join(rootDir, storedPath)));
  const ok = missingTargets.length === 0;
  const provenanceWarnings = collectLegacyProvenanceWarnings(rootInput);
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
    error: ok ? undefined : cliError(CliErrorCode.LegacyIndexTargetsMissing, "Legacy index references stored paths that do not exist.")
  };
}

function applyLegacyCopy(rootInput: HarnessLayoutInput, report: LegacyScanReport): CliResult {
  const archived = applyLegacyCopyArchive(rootInput, report);
  if (!archived.ok) return archived;
  copyForwardDocs(resolveHarnessLayout(rootInput).rootDir, report);
  return archived;
}

function applyLegacyCopyEffect(rootInput: HarnessLayoutInput, report: LegacyScanReport, coordinator: WriteCoordinator): Effect.Effect<CliResult, WriteError> {
  const archived = applyLegacyCopyArchive(rootInput, report);
  if (!archived.ok) return Effect.succeed(archived);
  return writeForwardDocsCoordinated(rootInput, report, coordinator).pipe(Effect.map(() => archived));
}

function applyLegacyCopyArchive(rootInput: HarnessLayoutInput, report: LegacyScanReport): CliResult {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const validation = validateLegacyIndex(rootDir, report);
  if (!validation.ok) return validation.result;
  const unsafeSource = firstUnsafeLegacySource(rootInput, report);
  if (unsafeSource) {
    return {
      ok: false,
      command: "legacy-copy-safe-docs",
      migrationMode: "apply",
      report,
      error: cliError(CliErrorCode.LegacyUnsafeSource, `Legacy Intake refused unsafe source path ${unsafeSource}. Run Legacy Intake against an external legacy source root, not generated dependencies or the active harness workspace.`)
    };
  }
  const duplicateTarget = firstDuplicate(report.entries.map((entry) => entry.storedPath));
  if (duplicateTarget) {
    return {
      ok: false,
      command: "legacy-copy-safe-docs",
      migrationMode: "apply",
      report,
      error: cliError(CliErrorCode.LegacyDuplicateTarget, `Legacy Intake plan has duplicate target: ${duplicateTarget}`)
    };
  }
  const copyPlan = buildLegacyCopyPlan(rootDir, report.sourceRoot, report.entries);
  writeCollisionReport(rootInput, copyPlan.collisionReport);
  for (const target of copyPlan.targets) {
    copySource(target.sourcePath, path.join(rootDir, target.chosenPath));
  }
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

function writeForwardDocsCoordinated(rootInput: HarnessLayoutInput, report: LegacyScanReport, coordinator: WriteCoordinator): Effect.Effect<void, WriteError> {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const sourceRoot = path.resolve(rootDir, report.sourceRoot);
  return Effect.gen(function* () {
    for (const entry of report.entries) {
      if (!entry.forwardPath) continue;
      if (!isSafeForwardPath(rootDir, entry.forwardPath)) continue;
      const source = path.join(sourceRoot, entry.sourcePath);
      const target = path.resolve(rootDir, entry.forwardPath);
      if (!isPathInside(rootDir, target) || existsSync(target)) continue;
      yield* writeCoordinatedPayload(coordinator, {
        entityId: moduleEntityId("legacy-forward"),
        kind: "machine_artifact_write",
        opIdPrefix: `legacy-forward-${entry.id}`,
        payload: {
          boundary: "legacy-forward",
          path: normalizeSlashes(path.relative(rootDir, target)),
          body: readFileSync(source, "utf8")
        }
      });
    }
  });
}

function isSafeForwardPath(rootDir: string, forwardPath: string): boolean {
  const target = path.resolve(rootDir, forwardPath);
  const relativePath = path.relative(rootDir, target);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function applyLegacyIndex(rootInput: HarnessLayoutInput, report: LegacyScanReport): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const collisionReport = readCollisionReport(rootInput);
  const indexedReport = { ...report, entries: applyCollisionReport(report.entries, collisionReport), summary: summarize(applyCollisionReport(report.entries, collisionReport)) };
  const unsafeSource = firstUnsafeLegacySource(rootInput, indexedReport);
  if (unsafeSource) {
    return {
      ok: false,
      command: "legacy-index",
      migrationMode: "apply",
      report: indexedReport,
      error: cliError(CliErrorCode.LegacyUnsafeSource, `Legacy Intake refused unsafe source path ${unsafeSource}. Run Legacy Intake against an external legacy source root, not generated dependencies or the active harness workspace.`)
    };
  }
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
        error: cliError(CliErrorCode.LegacyIndexSchemaInvalid, "Generated Legacy Intake index failed runtime LegacyIndexSchema validation.")
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

function firstUnsafeLegacySource(rootInput: HarnessLayoutInput, report: LegacyScanReport): string | undefined {
  const unsafeRoot = unsafeLegacySourceRoot(rootInput, report);
  if (unsafeRoot) return unsafeRoot;
  return report.entries.find((entry) => isGeneratedOrVendorPath(entry.sourcePath))?.sourcePath;
}

function unsafeLegacySourceRoot(rootInput: HarnessLayoutInput, report: LegacyScanReport): string | undefined {
  const layout = resolveHarnessLayout(rootInput);
  const sourceRoot = path.resolve(layout.rootDir, report.sourceRoot);
  const guardedRoots = [layout.authoredRoot, layout.localRoot, layout.legacyRoot];
  return guardedRoots.some((guardedRoot) => isPathInside(guardedRoot, sourceRoot))
    ? report.sourceRoot
    : undefined;
}

function digestJson(value: unknown): `sha256:${string}` {
  return `sha256:${stablePayloadHash(value)}`;
}

function writeSession(rootDir: string, outDir: string, session: LegacyIntakeSession): string {
  const directory = path.resolve(rootDir, outDir);
  mkdirSync(directory, { recursive: true });
  const sessionPath = path.join(directory, "session.json");
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  return sessionPath;
}

function relative(rootDir: string, targetPath: string): string {
  return normalizeSlashes(path.relative(rootDir, targetPath));
}
