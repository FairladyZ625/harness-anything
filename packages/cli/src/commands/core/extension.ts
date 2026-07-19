import { Effect } from "effect";
import { createHarnessRuntimeContext } from "@harness-anything/kernel";
import { runExtensionCommand } from "../extensions/index.ts";
import { readModules, writeModules } from "../extensions/state.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

export const runExtensionRunnerCommand: CommandRunner = (context, command) =>
  Effect.gen(function* () {
    const coordinator = context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "extension" });
    const pendingOps: Parameters<typeof coordinator.enqueue>[0][] = [];
    const result = yield* Effect.sync(() => runExtensionCommand(command, pendingOps));
    for (const op of pendingOps) yield* coordinator.enqueue(op);
    if (pendingOps.length > 0) yield* coordinator.flush("explicit");
    if (["module-register", "module-unregister", "module-step"].includes(command.action.kind)) {
      yield* Effect.sync(() => {
        const rootInput = createHarnessRuntimeContext(command.rootDir, command.layoutOverrides);
        writeModules(rootInput, readModules(rootInput));
      });
    }
    return result;
  });
