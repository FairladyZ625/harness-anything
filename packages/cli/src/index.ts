#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Schema } from "effect";
import { makeLocalLifecycleEngine } from "../../adapters/local/src/index.ts";
import { evaluateCompletionGate, evaluateReviewGate, parseReviewMarkdown } from "../../application/src/index.ts";
import type { DomainStatus, EngineError, WriteError } from "../../kernel/src/domain/index.ts";
import { isDomainStatus } from "../../kernel/src/domain/index.ts";
import {
  createTaskPackagePath,
  generateTaskId,
  listTaskIndexPaths,
  readFrontmatter,
  readScalar,
  resolveHarnessLayout,
  slugifyTaskTitle,
  taskDocumentPath
} from "../../kernel/src/layout/index.ts";
import {
  PresetManifestSchema,
  TemplateCatalogSchema,
  VerticalDefinitionSchema,
  checkTaskProjection,
  defaultTaskProjectionPath,
  planTemplateMaterialization,
  readTaskProjection,
  rebuildTaskProjection,
  validateExtensionInputShape,
  validatePresetManifests,
  validateTemplateCatalog,
  validateVerticalDefinition
} from "../../kernel/src/index.ts";

type PresetManifest = Schema.Schema.Type<typeof PresetManifestSchema>;
type CheckProfile = "source-package" | "private-harness" | "target-project";
type GovernanceRebuildMode = "dry-run" | "archive" | "apply";
type LessonCommandMode = "dry-run" | "apply";

export interface CliResult {
  readonly ok: boolean;
  readonly command: string;
  readonly taskId?: string;
  readonly slug?: string;
  readonly status?: DomainStatus;
  readonly path?: string;
  readonly packagePath?: string;
  readonly projectionPath?: string;
  readonly mode?: GovernanceRebuildMode | LessonCommandMode | "soft" | "hard";
  readonly tasks?: ReadonlyArray<unknown>;
  readonly templates?: ReadonlyArray<unknown>;
  readonly presets?: ReadonlyArray<unknown>;
  readonly preset?: unknown;
  readonly modules?: ReadonlyArray<unknown>;
  readonly module?: unknown;
  readonly document?: unknown;
  readonly evidenceBundle?: string;
  readonly issues?: ReadonlyArray<unknown>;
  readonly rows?: number;
  readonly warnings?: ReadonlyArray<unknown>;
  readonly report?: unknown;
  readonly profile?: CheckProfile;
  readonly generated?: ReadonlyArray<string>;
  readonly reviewContract?: unknown;
  readonly completionGate?: unknown;
  readonly summary?: {
    readonly taskCount: number;
    readonly byPackageDisposition: Record<string, number>;
    readonly byCoordinationStatus: Record<string, number>;
  };
  readonly commands?: ReadonlyArray<CommandRegistryEntry>;
  readonly launchPlan?: {
    readonly packageName: "@harness-anything/gui";
    readonly mode: "local-desktop-controller";
    readonly apiHost: "127.0.0.1";
    readonly delegated: true;
    readonly dryRun: boolean;
    readonly command: readonly string[];
    readonly pid?: number;
  };
  readonly error?: {
    readonly code: string;
    readonly hint: string;
  };
}

export interface CommandRegistryEntry {
  readonly kind: string;
  readonly primary: string;
  readonly resultEnvelope: "CliResult/v1";
}

const commandRegistry = [
  { kind: "init", primary: "harness init", resultEnvelope: "CliResult/v1" },
  { kind: "new-task", primary: "harness new-task --title <title> [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "status-set", primary: "harness task status set <id> <status>", resultEnvelope: "CliResult/v1" },
  { kind: "progress-append", primary: "harness task progress append <id> --text <text>", resultEnvelope: "CliResult/v1" },
  { kind: "task-archive", primary: "harness task archive <id> --reason <reason>", resultEnvelope: "CliResult/v1" },
  { kind: "task-supersede", primary: "harness task supersede <old-id> --title <title> [--slug <slug>]", resultEnvelope: "CliResult/v1" },
  { kind: "task-delete", primary: "harness task delete (--soft|--hard) <id> --reason <reason>", resultEnvelope: "CliResult/v1" },
  { kind: "task-reopen", primary: "harness task reopen <id> --reason <reason>", resultEnvelope: "CliResult/v1" },
  { kind: "task-review", primary: "harness task-review <id> [--reviewer <id>]", resultEnvelope: "CliResult/v1" },
  { kind: "task-complete", primary: "harness task-complete <id> --ci passed|failed", resultEnvelope: "CliResult/v1" },
  { kind: "task-list", primary: "harness task list [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "status", primary: "harness status --json", resultEnvelope: "CliResult/v1" },
  { kind: "check", primary: "harness check [--profile source-package|private-harness|target-project] [--strict] [--post-merge] [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "governance-rebuild", primary: "harness governance rebuild [--dry-run|--archive|--apply] [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "lesson-promote", primary: "harness lesson-promote <task-id> <candidate-id> [--dry-run|--apply] [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "lesson-sediment", primary: "harness lesson-sediment <task-id> <candidate-id> [--dry-run] [--title <title>] [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "preset-list", primary: "harness preset list [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "preset-inspect", primary: "harness preset inspect <id> [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "preset-check", primary: "harness preset check <id> [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "preset-install", primary: "harness preset install <folder> [--project] [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "preset-seed", primary: "harness preset seed [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "preset-audit", primary: "harness preset audit [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "preset-uninstall", primary: "harness preset uninstall <id> [--project] [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "preset-run", primary: "harness preset run <id> <plan|scaffold|check> --task <id> [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "preset-action", primary: "harness preset action <id> <action> --task <id> [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "module-list", primary: "harness module list [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "module-inspect", primary: "harness module inspect <key> [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "module-register", primary: "harness module register <key> --title <title> --scope <path> [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "module-scaffold", primary: "harness module scaffold <key> [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "module-unregister", primary: "harness module unregister <key> [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "module-step", primary: "harness module-step <key> <step> --state <state> [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "gui", primary: "harness gui", resultEnvelope: "CliResult/v1" }
] as const satisfies ReadonlyArray<CommandRegistryEntry>;

interface ParsedCommand {
  readonly rootDir: string;
  readonly json: boolean;
  readonly action:
    | { readonly kind: "init" }
    | { readonly kind: "new-task"; readonly taskId?: string; readonly title: string; readonly slug: string; readonly allowManualId: boolean }
    | { readonly kind: "status-set"; readonly taskId: string; readonly status: DomainStatus }
    | { readonly kind: "progress-append"; readonly taskId: string; readonly text: string }
    | { readonly kind: "task-archive"; readonly taskId: string; readonly reason: string }
    | { readonly kind: "task-supersede"; readonly oldTaskId: string; readonly title: string; readonly slug: string; readonly reason: string }
    | { readonly kind: "task-delete"; readonly taskId: string; readonly mode: "soft" | "hard"; readonly reason: string }
    | { readonly kind: "task-reopen"; readonly taskId: string; readonly reason: string }
    | { readonly kind: "task-review"; readonly taskId: string; readonly reviewerId: string }
    | { readonly kind: "task-complete"; readonly taskId: string; readonly ciGate: "passed" | "failed"; readonly reviewerId: string }
    | { readonly kind: "task-list" }
    | { readonly kind: "status" }
    | { readonly kind: "check"; readonly profile: CheckProfile; readonly strict: boolean; readonly postMerge: boolean }
    | { readonly kind: "governance-rebuild"; readonly mode: GovernanceRebuildMode }
    | { readonly kind: "lesson-promote"; readonly taskId: string; readonly candidateId: string; readonly mode: LessonCommandMode }
    | { readonly kind: "lesson-sediment"; readonly taskId: string; readonly candidateId: string; readonly mode: "dry-run"; readonly title: string }
    | { readonly kind: "gui" }
    | { readonly kind: "template-list"; readonly catalogPath: string }
    | { readonly kind: "template-render"; readonly templateRef: string; readonly catalogPath: string; readonly locale: "zh-CN" | "en-US" }
    | { readonly kind: "preset-validate"; readonly manifestPath: string; readonly kernelVersion: string }
    | { readonly kind: "preset-list" }
    | { readonly kind: "preset-inspect"; readonly presetId: string }
    | { readonly kind: "preset-check"; readonly presetId: string }
    | { readonly kind: "preset-install"; readonly sourcePath: string; readonly layer: "project" | "user" }
    | { readonly kind: "preset-seed" }
    | { readonly kind: "preset-audit" }
    | { readonly kind: "preset-uninstall"; readonly presetId: string; readonly layer: "project" | "user" }
    | { readonly kind: "preset-run"; readonly presetId: string; readonly entrypoint: "plan" | "scaffold" | "check"; readonly taskId: string }
    | { readonly kind: "preset-action"; readonly presetId: string; readonly actionName: string; readonly taskId: string }
    | { readonly kind: "module-list" }
    | { readonly kind: "module-inspect"; readonly moduleKey: string }
    | { readonly kind: "module-register"; readonly moduleKey: string; readonly title: string; readonly scope: string }
    | { readonly kind: "module-scaffold"; readonly moduleKey: string }
    | { readonly kind: "module-unregister"; readonly moduleKey: string }
    | { readonly kind: "module-step"; readonly moduleKey: string; readonly stepId: string; readonly state: "planned" | "in-progress" | "blocked" | "done" }
    | { readonly kind: "vertical-validate"; readonly definitionPath: string };
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    emit({ ok: false, command: "parse", error: parsed.error }, true);
    return 2;
  }

  if (isExtensionAction(parsed.value.action)) {
    const result = runExtensionCommand(parsed.value);
    emit(result, parsed.value.json);
    return result.ok ? 0 : 1;
  }

  if (parsed.value.action.kind === "gui") {
    const result = launchGui(parsed.value.rootDir);
    emit(result, parsed.value.json);
    return 0;
  }

  const engine = makeLocalLifecycleEngine({ rootDir: parsed.value.rootDir });
  const result = await Effect.runPromise(runCommand(engine, parsed.value).pipe(
    Effect.match({
      onFailure: (error): CliResult => ({
        ok: false,
        command: parsed.value.action.kind,
        taskId: actionTaskId(parsed.value.action),
        error: toCliError(error)
      }),
      onSuccess: (value) => value
    })
  ));

  emit(result, parsed.value.json);
  return result.ok ? 0 : 1;
}

function runCommand(
  engine: ReturnType<typeof makeLocalLifecycleEngine>,
  command: ParsedCommand
): Effect.Effect<CliResult, EngineError | WriteError> {
  if (command.action.kind === "init") {
    return Effect.sync(() => initializeHarness(command.rootDir));
  }

  if (command.action.kind === "new-task") {
    const action = command.action;
    const taskId = action.taskId ?? generateTaskId();
    return engine.createTask({
      taskId,
      title: action.title,
      slug: action.slug,
      allowManualId: action.allowManualId
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "new-task",
      taskId: result.taskId,
      slug: action.slug,
      status: result.status,
      packagePath: path.relative(command.rootDir, createTaskPackagePath(command.rootDir, result.taskId, action.slug)).split(path.sep).join("/")
    })));
  }

  if (command.action.kind === "status-set") {
    return engine.setStatus({
      taskId: command.action.taskId,
      status: command.action.status
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "status-set",
      taskId: result.taskId,
      status: result.status
    })));
  }

  if (command.action.kind === "progress-append") {
    return engine.appendProgress({
      taskId: command.action.taskId,
      text: command.action.text
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "progress-append",
      taskId: result.taskId,
      path: result.path
    })));
  }

  if (command.action.kind === "task-archive") {
    return engine.archiveTask({
      taskId: command.action.taskId,
      reason: command.action.reason
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "task-archive",
      taskId: result.taskId,
      status: result.status,
      path: "INDEX.md"
    })));
  }

  if (command.action.kind === "task-supersede") {
    const action = command.action;
    const newTaskId = generateTaskId();
    return engine.supersedeTask({
      oldTaskId: action.oldTaskId,
      newTaskId,
      title: action.title,
      slug: action.slug,
      reason: action.reason
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "task-supersede",
      taskId: result.oldTaskId,
      path: `task/${result.newTaskId}`,
      packagePath: path.relative(command.rootDir, createTaskPackagePath(command.rootDir, result.newTaskId, action.slug)).split(path.sep).join("/")
    })));
  }

  if (command.action.kind === "task-delete") {
    return engine.deleteTask({
      taskId: command.action.taskId,
      mode: command.action.mode,
      reason: command.action.reason
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "task-delete",
      taskId: result.taskId,
      mode: result.mode,
      path: result.mode
    })));
  }

  if (command.action.kind === "task-reopen") {
    return engine.reopenTask({
      taskId: command.action.taskId,
      reason: command.action.reason
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "task-reopen",
      taskId: result.taskId,
      status: result.status,
      path: "INDEX.md"
    })));
  }

  if (command.action.kind === "task-list") {
    return Effect.sync(() => {
      const result = readTaskProjection({ rootDir: command.rootDir });
      return {
        ok: true,
        command: "task-list",
        tasks: result.rows,
        warnings: result.warnings
      } satisfies CliResult;
    });
  }

  if (command.action.kind === "status") {
    return Effect.sync(() => {
      const result = checkTaskProjection({ rootDir: command.rootDir, postMerge: true });
      return {
        ok: result.ok,
        command: "status",
        rows: result.rows.length,
        warnings: result.warnings,
        report: result.report,
        summary: summarizeStatus(result.rows),
        commands: commandRegistry,
        projectionPath: path.relative(command.rootDir, result.projectionPath).split(path.sep).join("/"),
        error: result.ok ? undefined : {
          code: "status_check_failed",
          hint: "Harness status has warnings that require attention."
        }
      } satisfies CliResult;
    });
  }

  if (command.action.kind === "governance-rebuild") {
    const action = command.action;
    return Effect.sync(() => runGovernanceRebuild(command.rootDir, action.mode));
  }

  if (command.action.kind === "lesson-promote") {
    const action = command.action;
    return Effect.sync(() => runLessonPromote(command.rootDir, action.taskId, action.candidateId, action.mode));
  }

  if (command.action.kind === "lesson-sediment") {
    const action = command.action;
    return Effect.sync(() => runLessonSediment(command.rootDir, action.taskId, action.candidateId, action.title));
  }

  if (command.action.kind === "task-review") {
    const action = command.action;
    return Effect.sync(() => runTaskReview(command.rootDir, action.taskId, action.reviewerId));
  }

  if (command.action.kind === "task-complete") {
    const action = command.action;
    return Effect.sync(() => runTaskComplete(command.rootDir, action.taskId, action.reviewerId, action.ciGate));
  }

  return Effect.sync(() => runCheckProfile(command.rootDir, command.action.kind === "check"
    ? command.action
    : { kind: "check", profile: "source-package", strict: false, postMerge: false }));
}

function launchGui(rootDir: string): CliResult {
  const command = ["npm", "--workspace", "@harness-anything/gui", "run", "dev"] as const;
  const dryRun = process.env.HARNESS_GUI_DRY_RUN === "1";
  if (dryRun) {
    return {
      ok: true,
      command: "gui",
      launchPlan: {
        packageName: "@harness-anything/gui",
        mode: "local-desktop-controller",
        apiHost: "127.0.0.1",
        delegated: true,
        dryRun,
        command
      }
    };
  }

  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HARNESS_GUI_ROOT: path.resolve(rootDir)
    }
  });
  child.unref();

  return {
    ok: true,
    command: "gui",
    launchPlan: {
      packageName: "@harness-anything/gui",
      mode: "local-desktop-controller",
      apiHost: "127.0.0.1",
      delegated: true,
      dryRun,
      command,
      pid: child.pid
    }
  };
}

function initializeHarness(rootDir: string): CliResult {
  const layout = resolveHarnessLayout(rootDir);
  for (const directory of [
    layout.authoredRoot,
    layout.standardsRoot,
    layout.contextRoot,
    path.join(layout.contextRoot, "architecture"),
    layout.planningRoot,
    layout.tasksRoot,
    layout.localRoot,
    layout.generatedRoot,
    layout.cacheRoot,
    layout.writeJournalRoot,
    layout.payloadsRoot,
    layout.locksRoot
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  writeIfMissing(path.join(layout.authoredRoot, "harness.yaml"), [
    "schema: harness-anything/v1",
    "name: harness-anything",
    "layout:",
    "  authoredRoot: harness",
    "  localRoot: .harness",
    "tasks:",
    "  root: harness/planning/tasks",
    "  idPolicy: random-ulid",
    ""
  ].join("\n"));
  writeIfMissing(path.join(layout.standardsRoot, "repo-governance.md"), [
    "# Repository Governance",
    "",
    "- Authored shared state lives under `harness/`.",
    "- Generated local state lives under `.harness/` and must remain untracked.",
    "- Task identities use random `task_<ULID>` values; titles and slugs are display metadata.",
    ""
  ].join("\n"));
  writeIfMissing(path.join(layout.rootDir, "AGENTS.md"), [
    "# Harness Agent Entry",
    "",
    "Read `harness/harness.yaml` and `harness/standards/repo-governance.md` before changing task state.",
    "",
    "Generated state under `.harness/` is local-only and must not be committed.",
    ""
  ].join("\n"));
  writeIfMissing(path.join(layout.rootDir, "CLAUDE.md"), [
    "# Claude Harness Entry",
    "",
    "Follow `AGENTS.md` and the shared authored harness under `harness/`.",
    ""
  ].join("\n"));
  ensureGitignoreEntry(path.join(layout.rootDir, ".gitignore"), ".harness/");

  return {
    ok: true,
    command: "init",
    path: "harness/harness.yaml"
  };
}

function summarizeStatus(
  rows: ReadonlyArray<{ readonly packageDisposition: string; readonly coordinationStatus: string }>
): NonNullable<CliResult["summary"]> {
  return {
    taskCount: rows.length,
    byPackageDisposition: countBy(rows.map((row) => row.packageDisposition)),
    byCoordinationStatus: countBy(rows.map((row) => row.coordinationStatus))
  };
}

function countBy(values: ReadonlyArray<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function runTaskReview(rootDir: string, taskId: string, reviewerId: string): CliResult {
  const reviewPath = taskDocumentPath(rootDir, taskId, "review.md");
  if (!existsSync(reviewPath)) {
    return {
      ok: false,
      command: "task-review",
      taskId,
      error: {
        code: "review_document_missing",
        hint: "Task review requires review.md in the task package."
      }
    };
  }

  const parsed = parseReviewMarkdown(readFileSync(reviewPath, "utf8"));
  if (parsed.issues.length > 0) {
    return {
      ok: false,
      command: "task-review",
      taskId,
      issues: parsed.issues,
      error: {
        code: "review_schema_invalid",
        hint: "review.md material findings table failed validation."
      }
    };
  }

  const gate = evaluateReviewGate({
    taskId,
    reviewerId,
    submittedAt: new Date().toISOString(),
    findings: parsed.findings
  });
  if (!gate.ok) {
    return {
      ok: false,
      command: "task-review",
      taskId,
      report: gate,
      issues: gate.issues,
      error: {
        code: "release_blocking_findings",
        hint: "Open release-blocking findings must be closed before review passes."
      }
    };
  }

  return {
    ok: true,
    command: "task-review",
    taskId,
    report: gate,
    reviewContract: gate.contract
  };
}

function runTaskComplete(rootDir: string, taskId: string, reviewerId: string, ciGate: "passed" | "failed"): CliResult {
  const review = runTaskReview(rootDir, taskId, reviewerId);
  if (!review.ok) {
    return {
      ok: false,
      command: "task-complete",
      taskId,
      report: review.report,
      issues: review.issues,
      error: {
        code: "review_not_passed",
        hint: "Task completion requires a passed task-review gate."
      }
    };
  }

  const projection = readTaskProjection({ rootDir });
  const row = projection.rows.find((item) => item.taskId === taskId);
  if (!row) {
    return {
      ok: false,
      command: "task-complete",
      taskId,
      error: {
        code: "task_not_found",
        hint: `task not found: ${taskId}`
      }
    };
  }

  const completionGate = evaluateCompletionGate({
    taskId,
    coordinationStatus: row.coordinationStatus,
    packageDisposition: row.packageDisposition,
    closeoutReadiness: row.closeoutReadiness,
    reviewGate: "passed",
    ciGate
  });
  if (!completionGate.ok) {
    return {
      ok: false,
      command: "task-complete",
      taskId,
      completionGate,
      issues: completionGate.issues,
      error: {
        code: completionGate.issues[0]?.code ?? "completion_gate_failed",
        hint: "Task completion gate failed."
      }
    };
  }

  return {
    ok: true,
    command: "task-complete",
    taskId,
    completionGate,
    reviewContract: review.reviewContract
  };
}

interface ProfileValidationIssue {
  readonly code: string;
  readonly source: string;
  readonly severity: "warning" | "hard-fail";
  readonly message: string;
  readonly repairHint: string;
}

function runCheckProfile(
  rootDir: string,
  action: { readonly kind: "check"; readonly profile: CheckProfile; readonly strict: boolean; readonly postMerge: boolean }
): CliResult {
  const profilePostMerge = action.postMerge || action.profile === "private-harness" || action.profile === "target-project" || action.strict;
  const projection = checkTaskProjection({ rootDir, postMerge: profilePostMerge });
  const validatorIssues = validateCheckProfile(rootDir, action.profile, action.strict);
  const warnings = [...projection.warnings, ...validatorIssues];
  const validatorHardFailCount = validatorIssues.filter((issue) => issue.severity === "hard-fail").length;
  const hardFailCount = warnings.filter((issue) => issue.severity === "hard-fail").length;
  const ok = hardFailCount === 0;
  const validatorSummary = summarizeValidatorIssues(validatorIssues);
  const profileReport = {
    schema: "harness-check-profile-report/v1",
    profile: action.profile,
    strict: action.strict,
    postMerge: profilePostMerge,
    projection: projection.report,
    validators: validatorSummary,
    summary: {
      rowCount: projection.rows.length,
      warningCount: warnings.length,
      hardFailCount
    }
  };
  return {
    ok,
    command: checkCommandName(action),
    profile: action.profile,
    rows: projection.rows.length,
    warnings,
    commands: commandRegistry,
    report: action.profile === "source-package" ? projection.report : profileReport,
    error: ok ? undefined : {
      code: projection.report.summary.hardFailCount > 0 && validatorHardFailCount === 0 ? "projection_check_failed" : "check_profile_failed",
      hint: `Harness check profile ${action.profile} found hard-fail issues.`
    }
  };
}

function validateCheckProfile(rootDir: string, profile: CheckProfile, strict: boolean): ReadonlyArray<ProfileValidationIssue> {
  const issues: ProfileValidationIssue[] = [];
  if (profile !== "source-package" || strict) {
    const taskDirs = listTaskIndexPaths(rootDir).map((indexPath) => path.dirname(indexPath));
    for (const taskDir of taskDirs) {
      issues.push(...validateTaskPackageContracts(rootDir, taskDir, profile, strict));
    }
  }

  if (profile === "private-harness" || profile === "target-project") {
    issues.push(...validateContextDocs(rootDir, strict));
    issues.push(...validateGovernanceGeneratedViews(rootDir, strict));
  }

  return issues;
}

function checkCommandName(action: { readonly profile: CheckProfile; readonly strict: boolean; readonly postMerge: boolean }): string {
  if (action.profile === "source-package" && !action.strict && !action.postMerge) return "check";
  if (action.profile === "source-package" && !action.strict && action.postMerge) return "check --post-merge";
  return `check:${action.profile}`;
}

function validateTaskPackageContracts(rootDir: string, taskDir: string, profile: CheckProfile, strict: boolean): ReadonlyArray<ProfileValidationIssue> {
  const issues: ProfileValidationIssue[] = [];
  const relativeTaskDir = relativePath(rootDir, taskDir);
  const indexPath = path.join(taskDir, "INDEX.md");
  const indexBody = readFileSync(indexPath, "utf8");
  const frontmatter = readFrontmatter(indexBody);
  if (!frontmatter) {
    issues.push(profileIssue("task-plan-contract", "task_index_frontmatter_missing", "hard-fail", `${relativeTaskDir}/INDEX.md is missing frontmatter.`, "Restore task package frontmatter before running check profiles."));
    return issues;
  }

  const taskPlanPath = path.join(taskDir, "task_plan.md");
  if (!existsSync(taskPlanPath)) {
    issues.push(profileIssue("task-plan-contract", "task_plan_missing", "hard-fail", `${relativeTaskDir}/task_plan.md is missing.`, "Restore task_plan.md from the task template or supersede the package."));
  } else {
    const taskPlanBody = readFileSync(taskPlanPath, "utf8");
    if (!/Task Contract:\s*harness-task(?:\/|\s+)v1/u.test(taskPlanBody) && profile !== "source-package") {
      issues.push(profileIssue("task-plan-contract", "task_contract_marker_missing", strictSeverity(strict), `${relativeTaskDir}/task_plan.md lacks Task Contract: harness-task/v1.`, "Add the task contract marker or keep this package outside strict M2 profiles."));
    }
    if (hasTemplatePlaceholder(taskPlanBody)) {
      issues.push(profileIssue("task-plan-contract", "task_plan_placeholder", "hard-fail", `${relativeTaskDir}/task_plan.md still contains template placeholders.`, "Replace scaffold placeholders before treating the task package as implementation-ready."));
    }
  }

  const reviewPath = path.join(taskDir, "review.md");
  if (existsSync(reviewPath)) {
    const parsed = parseReviewMarkdown(readFileSync(reviewPath, "utf8"));
    for (const issue of parsed.issues) {
      issues.push(profileIssue("review-schema", "review_schema_invalid", "hard-fail", `${relativeTaskDir}/review.md failed review schema validation.`, JSON.stringify(issue)));
    }
  } else if (profile !== "source-package") {
    issues.push(profileIssue("review-schema", "review_missing", strictSeverity(strict), `${relativeTaskDir}/review.md is missing.`, "Add review.md before strict private-harness/target-project validation."));
  }

  const visualPath = path.join(taskDir, "visual_map.md");
  if (existsSync(visualPath)) {
    const visualBody = readFileSync(visualPath, "utf8");
    if (!/\| Phase ID \| Kind \| Depends On \| State \| Completion \|/u.test(visualBody)) {
      issues.push(profileIssue("visual-map", "visual_phase_table_missing", strictSeverity(strict), `${relativeTaskDir}/visual_map.md lacks the canonical phase table.`, "Add the Visual Map Contract phase table."));
    }
    if (hasTemplatePlaceholder(visualBody)) {
      issues.push(profileIssue("visual-map", "visual_map_placeholder", "hard-fail", `${relativeTaskDir}/visual_map.md still contains template placeholders.`, "Replace scaffold placeholders in the visual map."));
    }
  } else if (profile !== "source-package") {
    issues.push(profileIssue("visual-map", "visual_map_missing", strictSeverity(strict), `${relativeTaskDir}/visual_map.md is missing.`, "Add visual_map.md or record why this task is exempt."));
  }

  const executionPath = path.join(taskDir, "execution_strategy.md");
  if (existsSync(executionPath)) {
    const executionBody = readFileSync(executionPath, "utf8");
    if (/\| worker subagent \| pending \|/u.test(executionBody)) {
      issues.push(profileIssue("subagent-authorization", "worker_authorization_pending", strictSeverity(strict), `${relativeTaskDir}/execution_strategy.md has pending worker authorization.`, "Resolve worker authorization as authorized, denied, or not-needed before strict validation."));
    }
  }

  const lessonPath = path.join(taskDir, "lesson_candidates.md");
  if (existsSync(lessonPath)) {
    const lessonBody = readFileSync(lessonPath, "utf8");
    if (hasTemplatePlaceholder(lessonBody) && !/Task-level status \| pending-review/u.test(lessonBody)) {
      issues.push(profileIssue("lesson-routing", "lesson_placeholder", strictSeverity(strict), `${relativeTaskDir}/lesson_candidates.md contains unresolved placeholders.`, "Resolve lesson candidate routing before closeout."));
    }
  }

  const status = readScalar(frontmatter, "  status");
  if ((status === "done" || status === "in_review") && !existsSync(path.join(taskDir, "walkthrough.md")) && !existsSync(path.join(taskDir, "closeout.md"))) {
    issues.push(profileIssue("completion-consistency", "closeout_missing", strictSeverity(strict), `${relativeTaskDir} is ${status} without closeout evidence.`, "Add walkthrough.md/closeout.md before claiming completion."));
  }

  return issues;
}

function validateContextDocs(rootDir: string, strict: boolean): ReadonlyArray<ProfileValidationIssue> {
  const issues: ProfileValidationIssue[] = [];
  for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = path.join(rootDir, fileName);
    if (!existsSync(filePath)) {
      issues.push(profileIssue("context-docs", "context_doc_missing", strictSeverity(strict), `${fileName} is missing.`, `Add ${fileName} or keep the project outside strict target-project/private-harness profiles.`));
    }
  }
  return issues;
}

function validateGovernanceGeneratedViews(rootDir: string, strict: boolean): ReadonlyArray<ProfileValidationIssue> {
  const layout = resolveHarnessLayout(rootDir);
  const issues: ProfileValidationIssue[] = [];
  const generatedRegistry = path.join(layout.generatedRoot, "Module-Registry.md");
  const authoredModules = path.join(layout.authoredRoot, "modules.json");
  if (existsSync(authoredModules) && !existsSync(generatedRegistry)) {
    issues.push(profileIssue("governance-boundary", "module_registry_projection_missing", strictSeverity(strict), ".harness/generated/Module-Registry.md is missing for authored modules.json.", "Run harness module scaffold/register or governance rebuild to regenerate local views."));
  }
  return issues;
}

function runGovernanceRebuild(rootDir: string, mode: GovernanceRebuildMode): CliResult {
  const projectionPath = defaultTaskProjectionPath(rootDir);
  const plannedRows = listTaskIndexPaths(rootDir).length;
  if (mode === "dry-run") {
    return {
      ok: true,
      command: "governance-rebuild",
      mode,
      rows: plannedRows,
      projectionPath: relativePath(rootDir, projectionPath),
      report: {
        schema: "governance-rebuild-report/v1",
        mode,
        writes: [],
        generatedViews: plannedGovernanceViews(rootDir)
      }
    };
  }

  const archivePath = mode === "archive" ? writeGovernanceArchive(rootDir, plannedRows) : null;
  const result = rebuildTaskProjection({ rootDir });
  const generated = writeGeneratedGovernanceViews(rootDir, result.rows.length);
  return {
    ok: true,
    command: "governance-rebuild",
    mode,
    rows: result.rows.length,
    warnings: result.warnings,
    projectionPath: relativePath(rootDir, projectionPath),
    generated: archivePath ? [archivePath, ...generated] : generated,
    report: {
      schema: "governance-rebuild-report/v1",
      mode,
      writes: archivePath ? [archivePath, relativePath(rootDir, projectionPath), ...generated] : [relativePath(rootDir, projectionPath), ...generated],
      generatedViews: generated
    }
  };
}

function runLessonPromote(rootDir: string, taskId: string, candidateId: string, mode: LessonCommandMode): CliResult {
  const candidate = readLessonCandidate(rootDir, taskId, candidateId);
  if (!candidate.ok) return candidate.result;
  const outputPath = path.join(resolveHarnessLayout(rootDir).generatedRoot, "lessons", `${candidateId}.json`);
  const relativeOutput = relativePath(rootDir, outputPath);
  if (mode === "apply") {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify({
      schema: "lesson-promotion/v1",
      taskId,
      candidateId,
      title: candidate.value.title,
      promotedAt: new Date().toISOString(),
      source: "task-local-candidate"
    }, null, 2), "utf8");
  }
  return {
    ok: true,
    command: "lesson-promote",
    taskId,
    mode,
    generated: mode === "apply" ? [relativeOutput] : [],
    report: {
      schema: "lesson-promotion-report/v1",
      mode,
      taskId,
      candidate: candidate.value,
      plannedWrite: relativeOutput
    }
  };
}

function runLessonSediment(rootDir: string, taskId: string, candidateId: string, title: string): CliResult {
  const candidate = readLessonCandidate(rootDir, taskId, candidateId);
  if (!candidate.ok) return candidate.result;
  const outputPath = path.join(resolveHarnessLayout(rootDir).authoredRoot, "lessons", `${candidateId}.md`);
  return {
    ok: true,
    command: "lesson-sediment",
    taskId,
    mode: "dry-run",
    generated: [],
    report: {
      schema: "lesson-sediment-report/v1",
      mode: "dry-run",
      taskId,
      candidate: candidate.value,
      plannedWrite: relativePath(rootDir, outputPath),
      title
    }
  };
}

function readLessonCandidate(
  rootDir: string,
  taskId: string,
  candidateId: string
): { readonly ok: true; readonly value: { readonly id: string; readonly status: string; readonly title: string } } | { readonly ok: false; readonly result: CliResult } {
  const lessonPath = taskDocumentPath(rootDir, taskId, "lesson_candidates.md");
  if (!existsSync(lessonPath)) {
    return { ok: false, result: { ok: false, command: "lesson", taskId, error: { code: "lesson_candidates_missing", hint: "lesson_candidates.md is required for lesson promotion or sedimentation." } } };
  }
  const body = readFileSync(lessonPath, "utf8");
  const candidate = parseLessonCandidate(body, candidateId);
  if (!candidate) {
    return { ok: false, result: { ok: false, command: "lesson", taskId, error: { code: "lesson_candidate_not_found", hint: `candidate not found: ${candidateId}` } } };
  }
  if (candidate.status !== "ready-for-review" && candidate.status !== "needs-promotion" && candidate.status !== "promoted") {
    return { ok: false, result: { ok: false, command: "lesson", taskId, error: { code: "lesson_candidate_not_promotable", hint: `candidate ${candidateId} has status ${candidate.status}` } } };
  }
  return { ok: true, value: candidate };
}

function parseLessonCandidate(body: string, candidateId: string): { readonly id: string; readonly status: string; readonly title: string } | null {
  for (const line of body.split(/\r?\n/u)) {
    const cells = line.split("|").map((cell) => cell.trim()).filter((cell) => cell.length > 0);
    if (cells[0] === candidateId) {
      return {
        id: cells[0],
        status: cells[1] ?? "",
        title: cells[2] ?? candidateId
      };
    }
  }
  return null;
}

function profileIssue(source: string, code: string, severity: "warning" | "hard-fail", message: string, repairHint: string): ProfileValidationIssue {
  return { source, code, severity, message, repairHint };
}

function strictSeverity(strict: boolean): "warning" | "hard-fail" {
  return strict ? "hard-fail" : "warning";
}

function hasTemplatePlaceholder(body: string): boolean {
  return /\[(?:用一句话|说明|为什么|路径|风险|owner|负责人|该产物|这份资料|标准 \d|步骤 \d|范围|未采用|什么时候必须确认)[^\]]*\]/u.test(body);
}

function summarizeValidatorIssues(issues: ReadonlyArray<ProfileValidationIssue>): ReadonlyArray<{ readonly source: string; readonly warningCount: number; readonly hardFailCount: number; readonly codes: ReadonlyArray<string> }> {
  const sources = [...new Set(issues.map((issue) => issue.source))].sort();
  return sources.map((source) => {
    const sourceIssues = issues.filter((issue) => issue.source === source);
    return {
      source,
      warningCount: sourceIssues.filter((issue) => issue.severity === "warning").length,
      hardFailCount: sourceIssues.filter((issue) => issue.severity === "hard-fail").length,
      codes: [...new Set(sourceIssues.map((issue) => issue.code))].sort()
    };
  });
}

function isCheckProfile(value: string): value is CheckProfile {
  return value === "source-package" || value === "private-harness" || value === "target-project";
}

function plannedGovernanceViews(rootDir: string): ReadonlyArray<string> {
  const layout = resolveHarnessLayout(rootDir);
  return [
    relativePath(rootDir, defaultTaskProjectionPath(rootDir)),
    relativePath(rootDir, path.join(layout.generatedRoot, "Harness-Ledger.md"))
  ];
}

function writeGeneratedGovernanceViews(rootDir: string, rows: number): ReadonlyArray<string> {
  const layout = resolveHarnessLayout(rootDir);
  const ledgerPath = path.join(layout.generatedRoot, "Harness-Ledger.md");
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, [
    "# Harness Ledger",
    "",
    "Generated projection. Authored task packages remain the source of truth.",
    "",
    `- Generated At: ${new Date().toISOString()}`,
    `- Task Rows: ${rows}`,
    ""
  ].join("\n"), "utf8");
  return [relativePath(rootDir, ledgerPath)];
}

function writeGovernanceArchive(rootDir: string, plannedRows: number): string {
  const archivePath = path.join(resolveHarnessLayout(rootDir).localRoot, "archive", "governance", `${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  mkdirSync(path.dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, JSON.stringify({
    schema: "governance-archive/v1",
    archivedAt: new Date().toISOString(),
    plannedRows
  }, null, 2), "utf8");
  return relativePath(rootDir, archivePath);
}

function relativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function writeIfMissing(filePath: string, body: string): void {
  if (existsSync(filePath)) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}

function ensureGitignoreEntry(filePath: string, entry: string): void {
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = existing.split(/\r?\n/u).map((line) => line.trim());
  if (lines.includes(entry)) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(filePath, `${existing}${prefix}${entry}\n`, "utf8");
}

function parseArgs(argv: ReadonlyArray<string>): { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] } {
  const rootDir = readOption(argv, "--root") ?? process.cwd();
  const json = argv.includes("--json");
  const args = argv.filter((arg, index) => {
    const previous = argv[index - 1];
    return arg !== "--json" && arg !== "--root" && previous !== "--root";
  });

  if (args[0] === "init") {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: { kind: "init" }
      }
    };
  }

  if (args[0] === "new-task") {
    const migrationMode = args.includes("--migration") || args.includes("--import") || args.includes("--admin");
    const manualId = readOption(args, "--id") ?? (args[1]?.startsWith("--") ? undefined : args[1]);
    if (manualId && !migrationMode) {
      return {
        ok: false,
        error: {
          code: "manual_task_id_forbidden",
          hint: "Task IDs are generated as random task_<ULID> values. Use --migration, --import, or --admin only for controlled backfills."
        }
      };
    }
    const title = readOption(args, "--title") ?? manualId ?? "Untitled task";
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "new-task",
          taskId: manualId,
          title,
          slug: readOption(args, "--slug") ?? slugifyTaskTitle(title),
          allowManualId: migrationMode
        }
      }
    };
  }

  if (args[0] === "task" && args[1] === "status" && args[2] === "set" && args[3] && args[4]) {
    if (!isDomainStatus(args[4])) {
      return { ok: false, error: { code: "invalid_status", hint: `Unknown status: ${args[4]}` } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "status-set",
          taskId: args[3],
          status: args[4]
        }
      }
    };
  }

  if (args[0] === "task" && args[1] === "progress" && args[2] === "append" && args[3]) {
    const text = readOption(args, "--text");
    if (!text) {
      return { ok: false, error: { code: "missing_text", hint: "Use --text for progress append." } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "progress-append",
          taskId: args[3],
          text
        }
      }
    };
  }

  if (args[0] === "task" && args[1] === "archive" && args[2]) {
    const reason = readOption(args, "--reason");
    if (!reason) {
      return { ok: false, error: { code: "missing_reason", hint: "Use --reason for task archive." } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "task-archive",
          taskId: args[2],
          reason
        }
      }
    };
  }

  if (args[0] === "task" && args[1] === "supersede" && args[2]) {
    const title = readOption(args, "--title");
    if (!title) {
      return { ok: false, error: { code: "missing_title", hint: "Use --title for task supersede." } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "task-supersede",
          oldTaskId: args[2],
          title,
          slug: readOption(args, "--slug") ?? slugifyTaskTitle(title),
          reason: readOption(args, "--reason") ?? "superseded"
        }
      }
    };
  }

  if (args[0] === "task" && args[1] === "delete") {
    if (args.includes("--hard") && args.includes("--soft")) {
      return { ok: false, error: { code: "conflicting_delete_mode", hint: "Use exactly one of --soft or --hard for task delete." } };
    }
    const mode = args.includes("--hard") ? "hard" : args.includes("--soft") ? "soft" : null;
    const taskId = args.find((arg, index) => index > 1 && !arg.startsWith("--") && args[index - 1] !== "--reason");
    if (!mode) {
      return { ok: false, error: { code: "missing_delete_mode", hint: "Use --soft or --hard for task delete." } };
    }
    if (!taskId) {
      return { ok: false, error: { code: "missing_task_id", hint: "Provide a task id for task delete." } };
    }
    const reason = readOption(args, "--reason");
    if (!reason) {
      return { ok: false, error: { code: "missing_reason", hint: "Use --reason for task delete." } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "task-delete",
          taskId,
          mode,
          reason
        }
      }
    };
  }

  if (args[0] === "task" && args[1] === "reopen" && args[2]) {
    const reason = readOption(args, "--reason");
    if (!reason) {
      return { ok: false, error: { code: "missing_reason", hint: "Use --reason for task reopen." } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "task-reopen",
          taskId: args[2],
          reason
        }
      }
    };
  }

  if (args[0] === "task-review" && args[1]) {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "task-review",
          taskId: args[1],
          reviewerId: readOption(args, "--reviewer") ?? "local-reviewer"
        }
      }
    };
  }

  if (args[0] === "task-complete" && args[1]) {
    const ciGate = readOption(args, "--ci");
    if (!ciGate) {
      return { ok: false, error: { code: "missing_ci_gate", hint: "task-complete requires --ci passed|failed" } };
    }
    if (ciGate !== "passed" && ciGate !== "failed") {
      return { ok: false, error: { code: "invalid_ci_gate", hint: `Unknown CI gate: ${ciGate}` } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "task-complete",
          taskId: args[1],
          ciGate,
          reviewerId: readOption(args, "--reviewer") ?? "local-reviewer"
        }
      }
    };
  }

  if (args[0] === "task" && args[1] === "list") {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "task-list"
        }
      }
    };
  }

  if (args[0] === "status") {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "status"
        }
      }
    };
  }

  if (args[0] === "check") {
    const profile = readOption(args, "--profile") ?? "source-package";
    if (!isCheckProfile(profile)) {
      return { ok: false, error: { code: "invalid_check_profile", hint: `Unknown check profile: ${profile}` } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "check",
          profile,
          strict: args.includes("--strict"),
          postMerge: args.includes("--post-merge")
        }
      }
    };
  }

  if (args[0] === "governance" && args[1] === "rebuild") {
    const mode = args.includes("--dry-run") ? "dry-run" : args.includes("--archive") ? "archive" : "apply";
    const selectedModes = [args.includes("--dry-run"), args.includes("--archive"), args.includes("--apply")].filter(Boolean).length;
    if (selectedModes > 1) {
      return { ok: false, error: { code: "conflicting_governance_mode", hint: "Use only one of --dry-run, --archive, or --apply." } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "governance-rebuild",
          mode
        }
      }
    };
  }

  if (args[0] === "lesson-promote" && args[1] && args[2]) {
    const mode = args.includes("--apply") ? "apply" : "dry-run";
    if (args.includes("--apply") && args.includes("--dry-run")) {
      return { ok: false, error: { code: "conflicting_lesson_mode", hint: "Use either --dry-run or --apply." } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "lesson-promote",
          taskId: args[1],
          candidateId: args[2],
          mode
        }
      }
    };
  }

  if (args[0] === "lesson-sediment" && args[1] && args[2]) {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "lesson-sediment",
          taskId: args[1],
          candidateId: args[2],
          mode: "dry-run",
          title: readOption(args, "--title") ?? args[2]
        }
      }
    };
  }

  if (args[0] === "gui") {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "gui"
        }
      }
    };
  }

  if (args[0] === "template" && args[1] === "list") {
    const catalogPath = readOption(args, "--catalog");
    if (!catalogPath) {
      return { ok: false, error: { code: "missing_catalog", hint: "Use --catalog for template list." } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "template-list",
          catalogPath
        }
      }
    };
  }

  if (args[0] === "template" && args[1] === "render" && args[2]) {
    const catalogPath = readOption(args, "--catalog");
    if (!catalogPath) {
      return { ok: false, error: { code: "missing_catalog", hint: "Use --catalog for template render." } };
    }
    const locale = readOption(args, "--locale") ?? "zh-CN";
    if (locale !== "zh-CN" && locale !== "en-US") {
      return { ok: false, error: { code: "invalid_locale", hint: `Unknown locale: ${locale}` } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "template-render",
          templateRef: args[2],
          catalogPath,
          locale
        }
      }
    };
  }

  if (args[0] === "preset" && args[1] === "validate" && args[2]) {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "preset-validate",
          manifestPath: args[2],
          kernelVersion: readOption(args, "--kernel-version") ?? "1.0.0"
        }
      }
    };
  }

  if (args[0] === "preset" && args[1] === "list") {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-list" } } };
  }

  if (args[0] === "preset" && args[1] === "inspect" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-inspect", presetId: args[2] } } };
  }

  if (args[0] === "preset" && args[1] === "check" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-check", presetId: args[2] } } };
  }

  if (args[0] === "preset" && args[1] === "install" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-install", sourcePath: args[2], layer: args.includes("--project") ? "project" : "user" } } };
  }

  if (args[0] === "preset" && args[1] === "seed") {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-seed" } } };
  }

  if (args[0] === "preset" && args[1] === "audit") {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-audit" } } };
  }

  if (args[0] === "preset" && args[1] === "uninstall" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-uninstall", presetId: args[2], layer: args.includes("--project") ? "project" : "user" } } };
  }

  if (args[0] === "preset" && args[1] === "run" && args[2] && args[3]) {
    const taskId = readOption(args, "--task");
    if (!taskId) return { ok: false, error: { code: "missing_task", hint: "preset run requires --task <id>." } };
    if (args[3] !== "plan" && args[3] !== "scaffold" && args[3] !== "check") {
      return { ok: false, error: { code: "invalid_entrypoint", hint: `Unknown preset entrypoint: ${args[3]}` } };
    }
    return { ok: true, value: { rootDir, json, action: { kind: "preset-run", presetId: args[2], entrypoint: args[3], taskId } } };
  }

  if (args[0] === "preset" && args[1] === "action" && args[2] && args[3]) {
    const taskId = readOption(args, "--task");
    if (!taskId) return { ok: false, error: { code: "missing_task", hint: "preset action requires --task <id>." } };
    return { ok: true, value: { rootDir, json, action: { kind: "preset-action", presetId: args[2], actionName: args[3], taskId } } };
  }

  if (args[0] === "module" && args[1] === "list") {
    return { ok: true, value: { rootDir, json, action: { kind: "module-list" } } };
  }

  if (args[0] === "module" && args[1] === "inspect" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "module-inspect", moduleKey: args[2] } } };
  }

  if (args[0] === "module" && args[1] === "register" && args[2]) {
    const title = readOption(args, "--title");
    const scope = readOption(args, "--scope");
    if (!title || !scope) return { ok: false, error: { code: "missing_module_fields", hint: "module register requires --title and --scope." } };
    return { ok: true, value: { rootDir, json, action: { kind: "module-register", moduleKey: args[2], title, scope } } };
  }

  if (args[0] === "module" && args[1] === "scaffold" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "module-scaffold", moduleKey: args[2] } } };
  }

  if (args[0] === "module" && args[1] === "unregister" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "module-unregister", moduleKey: args[2] } } };
  }

  if (args[0] === "module-step" && args[1] && args[2]) {
    const state = readOption(args, "--state") ?? "in-progress";
    if (state !== "planned" && state !== "in-progress" && state !== "blocked" && state !== "done") {
      return { ok: false, error: { code: "invalid_module_step_state", hint: `Unknown module step state: ${state}` } };
    }
    return { ok: true, value: { rootDir, json, action: { kind: "module-step", moduleKey: args[1], stepId: args[2], state } } };
  }

  if (args[0] === "vertical" && args[1] === "validate" && args[2]) {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "vertical-validate",
          definitionPath: args[2]
        }
      }
    };
  }

  return {
    ok: false,
    error: {
      code: "unknown_command",
      hint: `Supported commands: ${commandRegistry.map((entry) => entry.primary).join("; ")}, template list, template render, preset validate, vertical validate.`
    }
  };
}

function readOption(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function actionTaskId(action: ParsedCommand["action"]): string | undefined {
  if ("oldTaskId" in action) return action.oldTaskId;
  return "taskId" in action ? action.taskId : undefined;
}

function isExtensionAction(action: ParsedCommand["action"]): action is Extract<ParsedCommand["action"], {
  readonly kind:
    | "template-list"
    | "template-render"
    | "preset-validate"
    | "preset-list"
    | "preset-inspect"
    | "preset-check"
    | "preset-install"
    | "preset-seed"
    | "preset-audit"
    | "preset-uninstall"
    | "preset-run"
    | "preset-action"
    | "module-list"
    | "module-inspect"
    | "module-register"
    | "module-scaffold"
    | "module-unregister"
    | "module-step"
    | "vertical-validate"
}> {
  return [
    "template-list",
    "template-render",
    "preset-validate",
    "preset-list",
    "preset-inspect",
    "preset-check",
    "preset-install",
    "preset-seed",
    "preset-audit",
    "preset-uninstall",
    "preset-run",
    "preset-action",
    "module-list",
    "module-inspect",
    "module-register",
    "module-scaffold",
    "module-unregister",
    "module-step",
    "vertical-validate"
  ].includes(action.kind);
}

function runExtensionCommand(command: ParsedCommand): CliResult {
  try {
    if (command.action.kind === "template-list") {
      const decoded = decodeExtensionJsonFile("template-catalog", command.action.catalogPath, TemplateCatalogSchema);
      if (!decoded.ok) {
        return invalidExtensionResult("template-list", "template_catalog_invalid", "Template catalog failed validation.", decoded.issues);
      }
      const catalog = decoded.value;
      const validation = validateTemplateCatalog(catalog);
      return {
        ok: validation.ok,
        command: "template-list",
        templates: catalog.documents.map((document) => ({
          templateRef: `template://${document.id}@${document.version}`,
          documentKind: document.documentKind,
          slot: document.slot,
          materializeAs: document.materializeAs,
          locales: document.locales.map((variant) => variant.locale)
        })),
        issues: validation.issues,
        error: validation.ok ? undefined : {
          code: "template_catalog_invalid",
          hint: "Template catalog failed validation."
        }
      };
    }

    if (command.action.kind === "template-render") {
      const decoded = decodeExtensionJsonFile("template-catalog", command.action.catalogPath, TemplateCatalogSchema);
      if (!decoded.ok) {
        return invalidExtensionResult("template-render", "template_catalog_invalid", "Template catalog failed validation.", decoded.issues);
      }
      const catalog = decoded.value;
      const materialized = planTemplateMaterialization({
        catalog,
        locale: command.action.locale,
        selections: [{
          slot: "cli.render",
          templateRef: command.action.templateRef,
          materializeAs: "stdout.md",
          localePolicy: {
            prefer: "explicit",
            fallback: "en-US"
          }
        }]
      });
      return {
        ok: materialized.ok,
        command: "template-render",
        document: materialized.documents[0],
        issues: materialized.issues,
        error: materialized.ok ? undefined : {
          code: "template_render_failed",
          hint: "Template selection could not be materialized."
        }
      };
    }

    if (command.action.kind === "preset-validate") {
      const decoded = decodeExtensionJsonFile("preset-manifest", command.action.manifestPath, PresetManifestSchema);
      if (!decoded.ok) {
        return invalidExtensionResult("preset-validate", "preset_manifest_invalid", "Preset manifest failed validation.", decoded.issues);
      }
      const manifest = decoded.value;
      const validation = validatePresetManifests([manifest], { kernelVersion: command.action.kernelVersion });
      return {
        ok: validation.ok,
        command: "preset-validate",
        issues: validation.issues,
        error: validation.ok ? undefined : {
          code: "preset_manifest_invalid",
          hint: "Preset manifest failed validation."
        }
      };
    }

    if (command.action.kind === "preset-list") {
      return {
        ok: true,
        command: "preset-list",
        presets: discoverPresets(command.rootDir).map(publicPresetSummary)
      };
    }

    if (command.action.kind === "preset-inspect") {
      const preset = resolvePreset(command.rootDir, command.action.presetId);
      if (!preset) return presetNotFound("preset-inspect", command.action.presetId);
      return {
        ok: true,
        command: "preset-inspect",
        preset: {
          ...publicPresetSummary(preset),
          manifest: preset.manifest
        }
      };
    }

    if (command.action.kind === "preset-check") {
      const preset = resolvePreset(command.rootDir, command.action.presetId);
      if (!preset) return presetNotFound("preset-check", command.action.presetId);
      const validation = validatePresetManifests([preset.manifest], { kernelVersion: "1.0.0" });
      return {
        ok: validation.ok,
        command: "preset-check",
        preset: publicPresetSummary(preset),
        issues: validation.issues,
        error: validation.ok ? undefined : {
          code: "preset_manifest_invalid",
          hint: "Preset manifest failed validation."
        }
      };
    }

    if (command.action.kind === "preset-install") {
      const manifest = readPresetManifestFromSource(command.action.sourcePath);
      const validation = validatePresetManifests([manifest], { kernelVersion: "1.0.0" });
      if (!validation.ok) {
        return {
          ok: false,
          command: "preset-install",
          preset: { id: manifest.id },
          issues: validation.issues,
          error: { code: "preset_manifest_invalid", hint: "Preset manifest failed validation." }
        };
      }
      const target = presetManifestPath(command.rootDir, command.action.layer, manifest.id);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(manifest, null, 2), "utf8");
      return {
        ok: true,
        command: "preset-install",
        preset: publicPresetSummary({ manifest, layer: command.action.layer, sourcePath: target })
      };
    }

    if (command.action.kind === "preset-seed") {
      for (const manifest of bundledPresetManifests()) {
        const target = presetManifestPath(command.rootDir, "user", manifest.id);
        if (!existsSync(target)) {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, JSON.stringify(manifest, null, 2), "utf8");
        }
      }
      return {
        ok: true,
        command: "preset-seed",
        presets: discoverPresets(command.rootDir).filter((preset) => preset.layer === "user").map(publicPresetSummary)
      };
    }

    if (command.action.kind === "preset-audit") {
      const resolved = discoverPresets(command.rootDir);
      const bundledById = new Map(bundledPresetManifests().map((manifest) => [manifest.id, manifest.version]));
      const drift = resolved
        .filter((preset) => preset.layer !== "builtin" && bundledById.has(preset.manifest.id) && bundledById.get(preset.manifest.id) !== preset.manifest.version)
        .map((preset) => ({
          id: preset.manifest.id,
          layer: preset.layer,
          installedVersion: preset.manifest.version,
          bundledVersion: bundledById.get(preset.manifest.id)
        }));
      return {
        ok: true,
        command: "preset-audit",
        presets: resolved.map(publicPresetSummary),
        report: {
          totalResolved: resolved.length,
          drift
        }
      };
    }

    if (command.action.kind === "preset-uninstall") {
      const target = presetManifestPath(command.rootDir, command.action.layer, command.action.presetId);
      if (!existsSync(target)) return presetNotFound("preset-uninstall", command.action.presetId);
      rmSync(path.dirname(target), { recursive: true, force: true });
      return {
        ok: true,
        command: "preset-uninstall",
        preset: {
          id: command.action.presetId,
          layer: command.action.layer
        }
      };
    }

    if (command.action.kind === "preset-run") {
      return runPresetEntrypoint(command.rootDir, command.action.presetId, command.action.entrypoint, command.action.taskId, "preset-run");
    }

    if (command.action.kind === "preset-action") {
      if (command.action.actionName !== "plan" && command.action.actionName !== "scaffold" && command.action.actionName !== "check") {
        return {
          ok: false,
          command: "preset-action",
          preset: { id: command.action.presetId },
          error: { code: "preset_action_forbidden", hint: `Preset action ${command.action.actionName} is not declared.` }
        };
      }
      return runPresetEntrypoint(command.rootDir, command.action.presetId, command.action.actionName, command.action.taskId, "preset-action");
    }

    if (command.action.kind === "module-list") {
      return {
        ok: true,
        command: "module-list",
        modules: readModules(command.rootDir).modules.filter((module) => module.status !== "unregistered")
      };
    }

    if (command.action.kind === "module-inspect") {
      const action = command.action;
      const module = readModules(command.rootDir).modules.find((candidate) => candidate.key === action.moduleKey);
      if (!module || module.status === "unregistered") return moduleNotFound("module-inspect", action.moduleKey);
      return { ok: true, command: "module-inspect", module };
    }

    if (command.action.kind === "module-register") {
      const action = command.action;
      const registry = readModules(command.rootDir);
      const existing = registry.modules.find((module) => module.key === action.moduleKey);
      const module = {
        key: action.moduleKey,
        title: action.title,
        status: "active",
        scopes: [action.scope],
        steps: [] as Array<{ readonly id: string; readonly state: string }>
      };
      const modules = existing
        ? registry.modules.map((candidate) => candidate.key === action.moduleKey ? module : candidate)
        : [...registry.modules, module];
      writeModules(command.rootDir, { modules });
      return { ok: true, command: "module-register", module };
    }

    if (command.action.kind === "module-scaffold") {
      const action = command.action;
      const registry = readModules(command.rootDir);
      const module = registry.modules.find((candidate) => candidate.key === action.moduleKey);
      if (!module || module.status === "unregistered") return moduleNotFound("module-scaffold", action.moduleKey);
      const moduleRoot = path.join(resolveHarnessLayout(command.rootDir).planningRoot, "modules", module.key);
      mkdirSync(moduleRoot, { recursive: true });
      writeIfMissing(path.join(moduleRoot, "brief.md"), `# ${module.title}\n\nModule key: ${module.key}\n`);
      writeIfMissing(path.join(moduleRoot, "module_plan.md"), `# ${module.title} Module Plan\n\n| Step | State |\n| --- | --- |\n`);
      return {
        ok: true,
        command: "module-scaffold",
        module,
        path: path.relative(command.rootDir, path.join(moduleRoot, "module_plan.md")).split(path.sep).join("/")
      };
    }

    if (command.action.kind === "module-unregister") {
      const action = command.action;
      const registry = readModules(command.rootDir);
      const module = registry.modules.find((candidate) => candidate.key === action.moduleKey);
      if (!module || module.status === "unregistered") return moduleNotFound("module-unregister", action.moduleKey);
      const next = { ...module, status: "unregistered" };
      writeModules(command.rootDir, {
        modules: registry.modules.map((candidate) => candidate.key === module.key ? next : candidate)
      });
      return { ok: true, command: "module-unregister", module: next };
    }

    if (command.action.kind === "module-step") {
      const action = command.action;
      const registry = readModules(command.rootDir);
      const module = registry.modules.find((candidate) => candidate.key === action.moduleKey);
      if (!module || module.status === "unregistered") return moduleNotFound("module-step", action.moduleKey);
      const step = { id: action.stepId, state: action.state };
      const steps = module.steps.some((candidate) => candidate.id === step.id)
        ? module.steps.map((candidate) => candidate.id === step.id ? step : candidate)
        : [...module.steps, step];
      const next = { ...module, steps };
      writeModules(command.rootDir, {
        modules: registry.modules.map((candidate) => candidate.key === module.key ? next : candidate)
      });
      return { ok: true, command: "module-step", module: next };
    }

    if (command.action.kind === "vertical-validate") {
      const decoded = decodeExtensionJsonFile("vertical-definition", command.action.definitionPath, VerticalDefinitionSchema);
      if (!decoded.ok) {
        return invalidExtensionResult("vertical-validate", "vertical_definition_invalid", "Vertical definition failed validation.", decoded.issues);
      }
      const vertical = decoded.value;
      const validation = validateVerticalDefinition(vertical);
      return {
        ok: validation.ok,
        command: "vertical-validate",
        issues: validation.issues,
        error: validation.ok ? undefined : {
          code: "vertical_definition_invalid",
          hint: "Vertical definition failed validation."
        }
      };
    }

    return {
      ok: false,
      command: command.action.kind,
      error: {
        code: "unknown_command",
        hint: "Unsupported extension command."
      }
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid_registry_key:")) {
      const label = error.message.split(":")[1] ?? "registry";
      return {
        ok: false,
        command: command.action.kind,
        error: {
          code: "invalid_registry_key",
          hint: `Invalid ${label} key.`
        }
      };
    }
    return {
      ok: false,
      command: command.action.kind,
      error: {
        code: "decode_failed",
        hint: "Input JSON failed to decode or could not be read."
      }
    };
  }
}

interface ResolvedPreset {
  readonly manifest: PresetManifest;
  readonly layer: "project" | "user" | "builtin";
  readonly sourcePath: string;
}

interface ModuleRegistry {
  readonly modules: ReadonlyArray<ModuleRecord>;
}

interface ModuleRecord {
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly scopes: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<{ readonly id: string; readonly state: string }>;
}

const bundledPresetIds = [
  "standard-task",
  "module",
  "legacy-migration",
  "lesson-sedimentation",
  "version-upgrade",
  "publish-standard",
  "release-closeout"
] as const;

function discoverPresets(rootDir: string): ReadonlyArray<ResolvedPreset> {
  const byId = new Map<string, ResolvedPreset>();
  for (const manifest of bundledPresetManifests()) {
    byId.set(manifest.id, { manifest, layer: "builtin", sourcePath: `builtin:${manifest.id}` });
  }
  for (const layer of ["user", "project"] as const) {
    for (const preset of readLayerPresets(rootDir, layer)) {
      byId.set(preset.manifest.id, preset);
    }
  }
  return [...byId.values()].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

function resolvePreset(rootDir: string, presetId: string): ResolvedPreset | undefined {
  return discoverPresets(rootDir).find((preset) => preset.manifest.id === presetId);
}

function publicPresetSummary(preset: ResolvedPreset): Record<string, unknown> {
  return {
    id: preset.manifest.id,
    title: preset.manifest.title,
    version: preset.manifest.version,
    vertical: preset.manifest.vertical,
    defaultProfile: preset.manifest.defaultProfile,
    layer: preset.layer,
    sourcePath: safePresetSourcePath(preset.sourcePath)
  };
}

function safePresetSourcePath(sourcePath: string): string {
  return sourcePath.startsWith("builtin:") ? sourcePath : sourcePath.split(path.sep).slice(-3).join("/");
}

function readLayerPresets(rootDir: string, layer: "project" | "user"): ReadonlyArray<ResolvedPreset> {
  const layerRoot = presetLayerRoot(rootDir, layer);
  if (!existsSync(layerRoot)) return [];
  return readdirSync(layerRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(layerRoot, entry.name, "preset.json"))
    .filter((presetPath) => existsSync(presetPath))
    .map((presetPath) => ({
      manifest: decodePresetManifestFile(presetPath),
      layer,
      sourcePath: presetPath
    }));
}

function bundledPresetManifests(): ReadonlyArray<PresetManifest> {
  return bundledPresetIds.map((id): PresetManifest => ({
    schema: "preset-manifest/v1",
    id,
    title: titleizePresetId(id),
    vertical: "software/coding",
    version: "1.0.0",
    kernelVersionRange: {
      min: "1.0.0",
      maxExclusive: "2.0.0"
    },
    capabilityImports: [{
      id: `${id}-check`,
      kind: "checker",
      version: "1",
      required: false
    }],
    profiles: [{
      id: "baseline",
      title: "Baseline",
      checkerProfile: "standard",
      templateSelections: []
    }],
    defaultProfile: "baseline"
  }));
}

function titleizePresetId(id: string): string {
  return id.split("-").map((part) => part.length > 0 ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function readPresetManifestFromSource(sourcePath: string): PresetManifest {
  const resolved = path.resolve(sourcePath);
  const presetPath = existsSync(path.join(resolved, "preset.json")) ? path.join(resolved, "preset.json") : resolved;
  return decodePresetManifestFile(presetPath);
}

function decodePresetManifestFile(presetPath: string): PresetManifest {
  const raw = JSON.parse(readFileSync(presetPath, "utf8")) as unknown;
  const shape = validateExtensionInputShape("preset-manifest", raw);
  if (!shape.ok) {
    throw new Error("preset manifest shape invalid");
  }
  return Schema.decodeUnknownSync(PresetManifestSchema)(raw);
}

function presetLayerRoot(rootDir: string, layer: "project" | "user"): string {
  const layout = resolveHarnessLayout(rootDir);
  return layer === "project"
    ? path.join(layout.localRoot, "presets")
    : path.join(layout.localRoot, "user-presets");
}

function presetManifestPath(rootDir: string, layer: "project" | "user", presetId: string): string {
  validateRegistryKey(presetId, "preset");
  return path.join(presetLayerRoot(rootDir, layer), presetId, "preset.json");
}

function runPresetEntrypoint(
  rootDir: string,
  presetId: string,
  entrypoint: "plan" | "scaffold" | "check",
  taskId: string,
  commandName: "preset-run" | "preset-action"
): CliResult {
  const preset = resolvePreset(rootDir, presetId);
  if (!preset) return presetNotFound("preset-run", presetId);
  validateRegistryKey(taskId, "task");
  const evidenceDir = path.join(resolveHarnessLayout(rootDir).localRoot, "evidence", "presets", presetId, timestampForPath());
  mkdirSync(evidenceDir, { recursive: true });
  const generated: string[] = [];
  if (entrypoint === "scaffold") {
    const outputPath = path.join(resolveHarnessLayout(rootDir).generatedRoot, "preset-scaffold", taskId, `${presetId}.md`);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `# ${preset.manifest.title}\n\nTask: ${taskId}\n`, "utf8");
    generated.push(path.relative(rootDir, outputPath).split(path.sep).join("/"));
  }
  const evidence = {
    schema: "preset-evidence/v1",
    presetId,
    layer: preset.layer,
    taskId,
    entrypoint,
    generated,
    ok: true
  };
  writeFileSync(path.join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2), "utf8");
  return {
    ok: true,
    command: commandName,
    preset: publicPresetSummary(preset),
    evidenceBundle: path.relative(rootDir, evidenceDir).split(path.sep).join("/"),
    report: evidence
  };
}

function readModules(rootDir: string): ModuleRegistry {
  const registryPath = modulesRegistryPath(rootDir);
  if (!existsSync(registryPath)) return { modules: [] };
  const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as { readonly modules?: ReadonlyArray<ModuleRecord> };
  return { modules: parsed.modules ?? [] };
}

function writeModules(rootDir: string, registry: ModuleRegistry): void {
  const registryPath = modulesRegistryPath(rootDir);
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ schema: "module-registry/v1", modules: registry.modules }, null, 2), "utf8");
  writeModuleRegistryView(rootDir, registry);
}

function modulesRegistryPath(rootDir: string): string {
  return path.join(resolveHarnessLayout(rootDir).authoredRoot, "modules.json");
}

function writeModuleRegistryView(rootDir: string, registry: ModuleRegistry): void {
  const outputPath = path.join(resolveHarnessLayout(rootDir).generatedRoot, "Module-Registry.md");
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const rows = registry.modules
    .map((module) => `| ${module.key} | ${module.title} | ${module.status} | ${module.scopes.join("<br>")} | ${module.steps.map((step) => `${step.id}:${step.state}`).join(", ")} |`)
    .join("\n");
  writeFileSync(outputPath, [
    "# Module Registry",
    "",
    "| Key | Title | Status | Scopes | Steps |",
    "| --- | --- | --- | --- | --- |",
    rows,
    ""
  ].join("\n"), "utf8");
}

function presetNotFound(command: string, presetId: string): CliResult {
  return {
    ok: false,
    command,
    preset: { id: presetId },
    error: { code: "preset_not_found", hint: `Preset ${presetId} was not found.` }
  };
}

function moduleNotFound(command: string, moduleKey: string): CliResult {
  return {
    ok: false,
    command,
    module: { key: moduleKey },
    error: { code: "module_not_found", hint: `Module ${moduleKey} was not found.` }
  };
}

function validateRegistryKey(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)) {
    throw new Error(`invalid_registry_key:${label}`);
  }
}

function timestampForPath(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/gu, "-");
}

function decodeExtensionJsonFile<A, I>(
  kind: "template-catalog" | "preset-manifest" | "vertical-definition",
  filePath: string,
  schema: Schema.Schema<A, I, never>
): { readonly ok: true; readonly value: A } | { readonly ok: false; readonly issues: ReadonlyArray<unknown> } {
  const inputPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  const shape = validateExtensionInputShape(kind, raw);
  if (!shape.ok) {
    return { ok: false, issues: shape.issues };
  }
  return { ok: true, value: Schema.decodeUnknownSync(schema)(raw) };
}

function invalidExtensionResult(command: string, code: string, hint: string, issues: ReadonlyArray<unknown>): CliResult {
  return {
    ok: false,
    command,
    issues,
    error: {
      code,
      hint
    }
  };
}

function toCliError(error: EngineError | WriteError): CliResult["error"] {
  if (error._tag === "EngineOwnsStatus") {
    return {
      code: "engine_owns_status",
      hint: `Status is owned by ${error.engine}; change it in that engine context.`
    };
  }
  if (error._tag === "MalformedSnapshot") {
    const raw = String(error.raw);
    return {
      code: raw.includes("invalid transition") ? "invalid_transition" : raw.includes("task not found") ? "task_not_found" : "malformed_snapshot",
      hint: raw
    };
  }
  if (error._tag === "TerminalReopenRequiresSupersede") {
    return {
      code: "terminal_reopen_requires_supersede",
      hint: `Task ${error.taskId} is ${error.status}; create follow-up work with harness task supersede.`
    };
  }
  if (error._tag === "ArchivedHardDeleteForbidden") {
    return {
      code: "archived_hard_delete_forbidden",
      hint: `Task ${error.taskId} is archived; keep audit history or use soft delete.`
    };
  }
  if (error._tag === "TerminalHardDeleteForbidden") {
    return {
      code: "terminal_hard_delete_forbidden",
      hint: `Task ${error.taskId} is ${error.status}; terminal work cannot be hard deleted.`
    };
  }
  if (error._tag === "RelatedTaskHardDeleteForbidden") {
    return {
      code: "related_task_hard_delete_forbidden",
      hint: `Task ${error.taskId} has task relations; remove or supersede relations before hard delete.`
    };
  }
  if (error._tag === "WriteConflict") {
    return { code: "write_conflict", hint: error.owner ?? "Write lock is held." };
  }
  if (error._tag === "WriteRejected") {
    return { code: "write_rejected", hint: error.reason };
  }
  if (error._tag === "JournalUnavailable") {
    return { code: "journal_unavailable", hint: "Journal is unavailable." };
  }
  return { code: error._tag, hint: "Command failed." };
}

function emit(result: CliResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }

  if (result.ok) {
    const suffix = result.status ? ` status=${result.status}` : result.path ? ` path=${result.path}` : result.rows !== undefined ? ` rows=${result.rows}` : result.launchPlan ? ` mode=${result.launchPlan.mode} package=${result.launchPlan.packageName}` : "";
    console.log(`ok command=${result.command} task=${result.taskId ?? ""}${suffix}`);
    return;
  }

  console.error(`error code=${result.error?.code ?? "unknown"} hint=${result.error?.hint ?? "Command failed."}`);
}

function isCliEntrypoint(): boolean {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return invokedPath.endsWith("packages/cli/src/index.ts");
  }
}

if (isCliEntrypoint()) {
  process.exitCode = await main();
}
