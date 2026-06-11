import { Effect } from "effect";
import { makeLocalLifecycleEngine } from "../../adapters/local/src/index.ts";
import type { DomainStatus, EngineError, WriteError } from "../../kernel/src/domain/index.ts";
import { isDomainStatus } from "../../kernel/src/domain/index.ts";
import { checkTaskProjection, readTaskProjection } from "../../kernel/src/index.ts";

export interface CliResult {
  readonly ok: boolean;
  readonly command: string;
  readonly taskId?: string;
  readonly status?: DomainStatus;
  readonly path?: string;
  readonly tasks?: ReadonlyArray<unknown>;
  readonly rows?: number;
  readonly warnings?: ReadonlyArray<unknown>;
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
    | { readonly kind: "check" };
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    emit({ ok: false, command: "parse", error: parsed.error }, true);
    return 2;
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

  return {
    ok: false,
    error: {
      code: "unknown_command",
      hint: "Supported commands: new-task, task status set, task progress append, task list, check."
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
    const suffix = result.status ? ` status=${result.status}` : result.path ? ` path=${result.path}` : result.rows !== undefined ? ` rows=${result.rows}` : "";
    console.log(`ok command=${result.command} task=${result.taskId ?? ""}${suffix}`);
    return;
  }

  console.error(`error code=${result.error?.code ?? "unknown"} hint=${result.error?.hint ?? "Command failed."}`);
}

if (process.argv[1]?.endsWith("packages/cli/src/index.ts")) {
  process.exitCode = await main();
}
