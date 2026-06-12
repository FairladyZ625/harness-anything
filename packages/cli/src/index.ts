#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Schema } from "effect";
import { makeLocalLifecycleEngine } from "../../adapters/local/src/index.ts";
import type { DomainStatus, EngineError, WriteError } from "../../kernel/src/domain/index.ts";
import { isDomainStatus } from "../../kernel/src/domain/index.ts";
import {
  PresetManifestSchema,
  TemplateCatalogSchema,
  VerticalDefinitionSchema,
  checkTaskProjection,
  planTemplateMaterialization,
  readTaskProjection,
  validateExtensionInputShape,
  validatePresetManifests,
  validateTemplateCatalog,
  validateVerticalDefinition
} from "../../kernel/src/index.ts";

export interface CliResult {
  readonly ok: boolean;
  readonly command: string;
  readonly taskId?: string;
  readonly status?: DomainStatus;
  readonly path?: string;
  readonly tasks?: ReadonlyArray<unknown>;
  readonly templates?: ReadonlyArray<unknown>;
  readonly document?: unknown;
  readonly issues?: ReadonlyArray<unknown>;
  readonly rows?: number;
  readonly warnings?: ReadonlyArray<unknown>;
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

interface ParsedCommand {
  readonly rootDir: string;
  readonly json: boolean;
  readonly action:
    | { readonly kind: "new-task"; readonly taskId: string; readonly title: string }
    | { readonly kind: "status-set"; readonly taskId: string; readonly status: DomainStatus }
    | { readonly kind: "progress-append"; readonly taskId: string; readonly text: string }
    | { readonly kind: "task-list" }
    | { readonly kind: "check" }
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
  if (command.action.kind === "new-task") {
    return engine.createTask({
      taskId: command.action.taskId,
      title: command.action.title
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "new-task",
      taskId: result.taskId,
      status: result.status
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

  return Effect.sync(() => {
    const result = checkTaskProjection({ rootDir: command.rootDir });
    return {
      ok: result.ok,
      command: "check",
      rows: result.rows.length,
      warnings: result.warnings,
      error: result.ok ? undefined : {
        code: "projection_check_failed",
        hint: "Projection cache or markdown source has contract warnings."
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

function parseArgs(argv: ReadonlyArray<string>): { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] } {
  const rootDir = readOption(argv, "--root") ?? process.cwd();
  const json = argv.includes("--json");
  const args = argv.filter((arg, index) => {
    const previous = argv[index - 1];
    return arg !== "--json" && arg !== "--root" && previous !== "--root";
  });

  if (args[0] === "new-task" && args[1]) {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "new-task",
          taskId: args[1],
          title: readOption(args, "--title") ?? args[1]
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

  if (args[0] === "check") {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "check"
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
      hint: "Supported commands: new-task, task status set, task progress append, task list, check, gui, template list, template render, preset validate, vertical validate."
    }
  };
}

function readOption(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function actionTaskId(action: ParsedCommand["action"]): string | undefined {
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
