#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Schema } from "effect";
import { makeLocalLifecycleEngine } from "../../adapters/local/src/index.ts";
import { evaluateCompletionGate, evaluateReviewGate, parseReviewMarkdown } from "../../application/src/index.ts";
import type { DomainStatus, EngineError, WriteError } from "../../kernel/src/domain/index.ts";
import { isDomainStatus } from "../../kernel/src/domain/index.ts";
import { createTaskPackagePath, generateTaskId, resolveHarnessLayout, slugifyTaskTitle, taskDocumentPath } from "../../kernel/src/layout/index.ts";
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

export interface CliResult {
  readonly ok: boolean;
  readonly command: string;
  readonly taskId?: string;
  readonly slug?: string;
  readonly status?: DomainStatus;
  readonly path?: string;
  readonly packagePath?: string;
  readonly projectionPath?: string;
  readonly mode?: "soft" | "hard";
  readonly tasks?: ReadonlyArray<unknown>;
  readonly templates?: ReadonlyArray<unknown>;
  readonly document?: unknown;
  readonly issues?: ReadonlyArray<unknown>;
  readonly rows?: number;
  readonly warnings?: ReadonlyArray<unknown>;
  readonly report?: unknown;
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
  { kind: "check", primary: "harness check [--post-merge] [--json]", resultEnvelope: "CliResult/v1" },
  { kind: "governance-rebuild", primary: "harness governance rebuild [--json]", resultEnvelope: "CliResult/v1" },
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
    | { readonly kind: "check"; readonly postMerge: boolean }
    | { readonly kind: "governance-rebuild" }
    | { readonly kind: "gui" }
    | { readonly kind: "template-list"; readonly catalogPath: string }
    | { readonly kind: "template-render"; readonly templateRef: string; readonly catalogPath: string; readonly locale: "zh-CN" | "en-US" }
    | { readonly kind: "preset-validate"; readonly manifestPath: string; readonly kernelVersion: string }
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
    return Effect.sync(() => {
      const result = rebuildTaskProjection({ rootDir: command.rootDir });
      return {
        ok: true,
        command: "governance-rebuild",
        rows: result.rows.length,
        warnings: result.warnings,
        projectionPath: path.relative(command.rootDir, defaultTaskProjectionPath(command.rootDir)).split(path.sep).join("/")
      } satisfies CliResult;
    });
  }

  if (command.action.kind === "task-review") {
    const action = command.action;
    return Effect.sync(() => runTaskReview(command.rootDir, action.taskId, action.reviewerId));
  }

  if (command.action.kind === "task-complete") {
    const action = command.action;
    return Effect.sync(() => runTaskComplete(command.rootDir, action.taskId, action.reviewerId, action.ciGate));
  }

  return Effect.sync(() => {
    const result = checkTaskProjection({ rootDir: command.rootDir, postMerge: command.action.kind === "check" && command.action.postMerge });
    return {
      ok: result.ok,
      command: command.action.kind === "check" && command.action.postMerge ? "check --post-merge" : "check",
      rows: result.rows.length,
      warnings: result.warnings,
      report: result.report,
      error: result.ok ? undefined : {
        code: "projection_check_failed",
        hint: command.action.kind === "check" && command.action.postMerge
          ? "Post-merge governance checks found hard-fail warnings."
          : "Projection cache or markdown source has contract warnings."
      }
    } satisfies CliResult;
  });
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
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "check",
          postMerge: args.includes("--post-merge")
        }
      }
    };
  }

  if (args[0] === "governance" && args[1] === "rebuild") {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "governance-rebuild"
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

function isExtensionAction(action: ParsedCommand["action"]): action is Extract<ParsedCommand["action"], { readonly kind: "template-list" | "template-render" | "preset-validate" | "vertical-validate" }> {
  return action.kind === "template-list" || action.kind === "template-render" || action.kind === "preset-validate" || action.kind === "vertical-validate";
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
