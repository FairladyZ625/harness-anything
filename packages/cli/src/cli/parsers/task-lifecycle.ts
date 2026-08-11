import { parseTaskLifecycleArgs } from "../../commands/core/task-lifecycle.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CommandParser } from "../command-spec/types.ts";

const lifecycleVerbs = new Set(["create", "start", "submit", "review-execution", "complete", "show"]);

export const parseTaskLifecycleCommandArgs: CommandParser = (args, rootDir, json, _commandSpecs, input) => {
  if (args[0] !== "task" || !lifecycleVerbs.has(args[1] ?? "")) return null;
  if (args[1] === "create" && input?.commandKind === "task-create") {
    const payload = input.payload;
    const allowed = new Set(["title", "taskId", "completionGate"]);
    const unknown = Object.keys(payload).filter((key) => !allowed.has(key));
    if (unknown.length > 0) return { ok: false, error: cliError(CliErrorCode.InvalidJsonInput, `Unknown task create input fields: ${unknown.join(", ")}.`) };
    const flagValue = (flag: string): string | undefined => {
      const index = args.indexOf(flag);
      return index >= 0 ? args[index + 1] : undefined;
    };
    const title = flagValue("--title") ?? (typeof payload.title === "string" ? payload.title : undefined);
    const taskId = flagValue("--task-id") ?? (typeof payload.taskId === "string" ? payload.taskId : undefined);
    const completionGateIds = [
      ...(Array.isArray(payload.completionGate) ? payload.completionGate.filter((value): value is string => typeof value === "string") : []),
      ...args.flatMap((value, index) => value === "--completion-gate" && typeof args[index + 1] === "string" ? [args[index + 1]!] : [])
    ];
    if (!title?.trim()) return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Add `--title <title>` or JSON field title to create a replay/v1 task.") };
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "task-create",
          verb: "create",
          commandType: "CreateReplayTask",
          ...(taskId ? { taskId } : {}),
          title,
          completionGateIds
        }
      }
    };
  }
  const parsed = parseTaskLifecycleArgs(args);
  return parsed.ok
    ? { ok: true, value: { rootDir, json, action: parsed.value } }
    : {
        ok: false,
        error: cliError(
          parsed.error.code === "invalid_transition" ? CliErrorCode.InvalidTransition : CliErrorCode.InvalidTaskMetadata,
          parsed.error.nextAction
        )
      };
};
