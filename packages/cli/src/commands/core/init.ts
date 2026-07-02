import { Effect } from "effect";
import { initializeHarness } from "../init.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

export const runInitCommand: CommandRunner = (_context, command) => {
  const action = command.action as Extract<typeof command.action, { readonly kind: "init" }>;
  return Effect.sync(() => initializeHarness(command.rootDir, action.addNpmScripts, action.projectName));
};
