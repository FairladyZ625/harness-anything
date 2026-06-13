import { isDomainStatus } from "../../../kernel/src/domain/index.ts";
import { slugifyTaskTitle } from "../../../kernel/src/layout/index.ts";
import { commandRegistry } from "./command-registry.ts";
import { parseDoctorArgs } from "./parse-doctor-args.ts";
import { parseGitDiffArgs } from "./parse-git-diff-args.ts";
import { parseMigrationArgs } from "./parse-migration-args.ts";
import { isCheckProfile } from "../commands/check.ts";
import type { CliResult, ParsedCommand } from "./types.ts";

export function parseArgs(argv: ReadonlyArray<string>): { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] } {
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
    const force = args.includes("--force");
    const reason = readOption(args, "--reason");
    if (force && !reason) {
      return { ok: false, error: { code: "missing_force_reason", hint: "Forced terminal status changes require --reason for audit evidence." } };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "status-set",
          taskId: args[3],
          status: args[4],
          force,
          reason
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

  const migrationCommand = parseMigrationArgs(args, rootDir, json);
  if (migrationCommand) return migrationCommand;

  const gitDiffCommand = parseGitDiffArgs(args, rootDir, json);
  if (gitDiffCommand) return { ok: true, value: gitDiffCommand };

  const doctorCommand = parseDoctorArgs(args, rootDir, json);
  if (doctorCommand) return { ok: true, value: doctorCommand };

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

export function actionTaskId(action: ParsedCommand["action"]): string | undefined {
  if ("oldTaskId" in action) return action.oldTaskId;
  return "taskId" in action ? action.taskId : undefined;
}
