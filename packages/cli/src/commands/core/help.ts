import { Effect } from "effect";
import { buildHelpResult } from "../help.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

export const runHelpCommand: CommandRunner = (_context, command) => {
  const action = command.action as Extract<typeof command.action, { readonly kind: "help" }>;
  return Effect.sync(() => buildHelpResult(action));
};
