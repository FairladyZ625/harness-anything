import { Effect } from "effect";
import { runExtensionCommand } from "../extensions/index.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

export const runExtensionRunnerCommand: CommandRunner = (context, command) =>
  Effect.gen(function* () {
    const coordinator = context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "extension" });
    const pendingOps: Parameters<typeof coordinator.enqueue>[0][] = [];
    const result = yield* Effect.sync(() => runExtensionCommand(command, coordinator, pendingOps));
    for (const op of pendingOps) yield* coordinator.enqueue(op);
    if (pendingOps.length > 0) yield* coordinator.flush("explicit");
    return result;
  });
