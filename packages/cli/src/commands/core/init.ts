import { Effect } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateTaskId, queryTaskProjection, resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { initializeHarness } from "../init.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult } from "../../cli/types.ts";

const initSmokeTitle = "Harness onboarding smoke";
const initSmokeSlug = "harness-onboarding-smoke";

export const runInitCommand: CommandRunner = (context, command) => {
  const action = command.action as Extract<typeof command.action, { readonly kind: "init" }>;
  return Effect.sync(() => {
    try {
      return initializeHarness(context.layoutInput, action.addNpmScripts, action.projectName, context.actorAttribution().commitAuthor);
    } catch (error) {
      return {
        ok: false,
        command: "init",
        error: cliError(CliErrorCode.AuthMissing, error instanceof Error ? error.message : String(error))
      } satisfies CliResult;
    }
  })
    .pipe(Effect.flatMap((result) => runConfigureVerifySmoke(context, result)));
};

function runConfigureVerifySmoke(
  context: Parameters<CommandRunner>[0],
  result: CliResult
): ReturnType<CommandRunner> {
  if (!result.ok) return Effect.succeed(result);
  return Effect.sync(() => {
    const layout = resolveHarnessLayout(context.layoutInput);
    const smokeTaskId = generateTaskId();
    const smokePackagePath = layout.createTaskPackagePath(smokeTaskId, initSmokeSlug);
    try {
      writeSmokeTaskPackage(smokePackagePath, smokeTaskId);
      const verified = verifySmokeProjection(context, result, smokeTaskId);
      if (!verified.ok) return verified;
      rmSync(smokePackagePath, { recursive: true, force: true });
      const cleanupProjection = queryTaskProjection({
        rootDir: context.rootDir,
        layoutOverrides: context.layoutOverrides,
        filters: {}
      });
      return markSmokeCleanedUp(verified, cleanupProjection.rows.length);
    } catch (error) {
      rmSync(smokePackagePath, { recursive: true, force: true });
      return smokeFailure(context, result, smokeTaskId, error);
    }
  });
}

function verifySmokeProjection(context: Parameters<CommandRunner>[0], result: CliResult, smokeTaskId: string): CliResult {
  const layout = resolveHarnessLayout(context.layoutInput);
  const projection = queryTaskProjection({
    rootDir: context.rootDir,
    layoutOverrides: context.layoutOverrides,
    filters: { search: initSmokeTitle }
  });
  const smokeRow = projection.rows.find((row) => row.taskId === smokeTaskId);
  const hardFailures = projection.warnings.filter((warning) => warning.severity === "hard-fail");
  const initializationReport = initInitializationReport(result);
  const report = {
    schema: "init-configure-verify-report/v1",
    scaffold: {
      configPath: result.path,
      agentsPath: "AGENTS.md"
    },
    ...(initializationReport ? { isolation: initializationReport.isolation } : {}),
    configureVerify: {
      smokeTaskId,
      smokeTaskTitle: initSmokeTitle,
      smokeTaskFound: Boolean(smokeRow),
      smokeTaskCleanedUp: false,
      smokeTaskPackagePath: initRelativePath(context.rootDir, layout.createTaskPackagePath(smokeTaskId, initSmokeSlug)),
      projectionPath: initRelativePath(context.rootDir, layout.projectionPath),
      taskRows: projection.rows.length,
      warningCount: projection.warnings.length,
      hardFailCount: hardFailures.length
    }
  };

  if (!smokeRow || hardFailures.length > 0) {
    return {
      ok: false,
      command: "init",
      warnings: projection.warnings,
      report,
      error: cliError(
        CliErrorCode.ProjectionCheckFailed,
        !smokeRow
          ? `init Configure-Verify smoke failed: task ${smokeTaskId} was not queryable after creation.`
          : `init Configure-Verify smoke failed: projection reported ${hardFailures.length} hard failure(s).`
      )
    };
  }

  return {
    ...result,
    report
  };
}

function writeSmokeTaskPackage(packagePath: string, taskId: string): void {
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(path.join(packagePath, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${initSmokeTitle}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: planned",
    "  ref: ",
    `  titleSnapshot: ${initSmokeTitle}`,
    "  url: ",
    `  bindingCreatedAt: ${new Date().toISOString()}`,
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    "packageDisposition: active",
    "workKind: chore",
    "riskTier: low",
    "urgency: low",
    "vertical: software/coding",
    "preset: init-configure-verify",
    "---",
    "",
    `# ${initSmokeTitle}`,
    ""
  ].join("\n"), "utf8");
}

function markSmokeCleanedUp(result: CliResult, postCleanupTaskRows: number): CliResult {
  const report = result.report as {
    readonly schema: string;
    readonly scaffold: unknown;
    readonly configureVerify: Record<string, unknown>;
  };
  return {
    ...result,
    report: {
      ...report,
      configureVerify: {
        ...report.configureVerify,
        smokeTaskCleanedUp: true,
        postCleanupTaskRows
      }
    }
  };
}

function smokeFailure(context: Parameters<CommandRunner>[0], result: CliResult, smokeTaskId: string, error: unknown): CliResult {
  const layout = resolveHarnessLayout(context.layoutInput);
  const message = error instanceof Error ? error.message : String(error);
  const initializationReport = initInitializationReport(result);
  return {
    ok: false,
    command: "init",
    warnings: result.warnings,
    report: {
      schema: "init-configure-verify-report/v1",
      scaffold: {
        configPath: result.path,
        agentsPath: "AGENTS.md"
      },
      ...(initializationReport ? { isolation: initializationReport.isolation } : {}),
      configureVerify: {
        smokeTaskId,
        smokeTaskTitle: initSmokeTitle,
        smokeTaskFound: false,
        smokeTaskCleanedUp: true,
        smokeTaskPackagePath: initRelativePath(context.rootDir, layout.createTaskPackagePath(smokeTaskId, initSmokeSlug)),
        projectionPath: initRelativePath(context.rootDir, layout.projectionPath),
        taskRows: 0,
        warningCount: 0,
        hardFailCount: 1,
        error: message
      }
    },
    error: cliError(CliErrorCode.ProjectionCheckFailed, `init Configure-Verify smoke failed: ${message}`)
  };
}

function initRelativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function initInitializationReport(result: CliResult): { readonly isolation?: unknown } | undefined {
  const report = result.report;
  return report && typeof report === "object" && !Array.isArray(report)
    ? report as { readonly isolation?: unknown }
    : undefined;
}
