import { Effect } from "effect";
import {
  makeCoordinatedExecutionAuthoredStore,
  makeExecutionSagaService
} from "@harness-anything/application";
import { readSessionEntityDocument } from "@harness-anything/kernel";
import type { CommandRunnerContext } from "../../cli/runner-registry.ts";

export function commandExecutionSaga(context: CommandRunnerContext) {
  const coordinator = context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "execution-saga" });
  const authoredStore = makeCoordinatedExecutionAuthoredStore({
    rootInput: context.layoutInput,
    coordinator,
    artifactStore: context.artifactStore
  });
  return {
    authoredStore,
    saga: makeExecutionSagaService({
      taskHolderService: context.taskHolderService,
      authoredStore,
      finalizeSession: async (session) => {
        try {
          if (readSessionEntityDocument(context.layoutInput, session.sessionId).format === "manifest") return;
        } catch {
          // A missing or legacy Session is finalized through the existing exporter below.
        }
        const exported = await Effect.runPromise(context.provenanceSessionExporter.exportSession(session).pipe(
          Effect.catchAll((error) => error.code === "transcript_unavailable"
            ? Effect.succeed(null)
            : Effect.fail(error))
        ));
        if (!exported) return;
        await Effect.runPromise(context.syncExportedSession(exported));
      }
    })
  };
}
