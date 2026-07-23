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
        const exported = await Effect.runPromise(context.provenanceSessionExporter.exportSession(session)).catch((error: unknown) => {
          if (isConfirmedTranscriptUnavailable(error)) return null;
          throw error;
        });
        if (!exported) return;
        await Effect.runPromise(context.syncExportedSession(exported));
      }
    })
  };
}

function isConfirmedTranscriptUnavailable(error: unknown): boolean {
  return Boolean(error && typeof error === "object"
    && "_tag" in error
    && (error as { readonly _tag?: unknown })._tag === "ProvenanceSessionExporterRejected"
    && "code" in error
    && (error as { readonly code?: unknown }).code === "transcript_unavailable");
}
