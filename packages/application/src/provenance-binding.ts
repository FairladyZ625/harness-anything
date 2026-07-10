import { Effect } from "effect";
import type { CurrentSessionProbePort, ProvenancePayload } from "../../kernel/src/index.ts";
import { currentSessionToProvenancePayload } from "./current-session-probe.ts";
import type { ProvenanceSessionExporter, ProvenanceSessionExporterRejected, ProvenanceSessionExportResult } from "./provenance-session-exporter.ts";

export interface ProvenanceBindingOptions {
  readonly currentSessionProbe?: CurrentSessionProbePort;
  readonly provenanceSessionExporter?: ProvenanceSessionExporter;
  readonly syncExportedSession?: (result: ProvenanceSessionExportResult) => Effect.Effect<void, ProvenanceSessionExporterRejected>;
}

export function bindCreateProvenance(
  options: ProvenanceBindingOptions,
  boundAt: string
): Effect.Effect<ProvenancePayload | undefined, ProvenanceSessionExporterRejected> {
  if (!options.currentSessionProbe) return Effect.succeed(undefined);
  return options.currentSessionProbe.currentSession.pipe(
    Effect.flatMap((session) => {
      const provenance = currentSessionToProvenancePayload(session, boundAt);
      if (!options.provenanceSessionExporter) return Effect.succeed(provenance);
      return options.provenanceSessionExporter.readById(session.sessionId).pipe(
        Effect.catchAll(() => options.provenanceSessionExporter!.exportSession(session)),
        Effect.flatMap((result) => options.syncExportedSession ? options.syncExportedSession(result) : Effect.void),
        Effect.as(provenance),
        Effect.catchAll((error) => error.code === "transcript_unavailable"
          ? Effect.succeed(provenance)
          : Effect.fail(error))
      );
    })
  );
}
