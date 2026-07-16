import { Effect } from "effect";
import { generateShellCompletion } from "../../cli/completion/index.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { ParsedCommand } from "../../cli/types.ts";

export const runCompletionCommand: CommandRunner = (context, command) => {
  const action = command.action as Extract<ParsedCommand["action"], { readonly kind: "completion" }>;
  return Effect.sync(() => ({
    ok: true,
    command: "completion",
    shell: action.shell,
    completionScript: generateShellCompletion(action.shell, context.commandRegistry)
  }));
};
