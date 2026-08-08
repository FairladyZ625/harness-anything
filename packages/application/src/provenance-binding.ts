import { Effect } from "effect";
import type { CurrentSessionProbePort, ProvenancePayload } from "@harness-anything/kernel";
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
        // Optional transcript capture must not make unrelated writes depend on runtime-log availability.
        // Execution submission applies the stricter confirmed-unavailable rule at its finalization boundary.
        Effect.catchAll((error) => transcriptCaptureIsOptionallyUnavailable(error)
          ? Effect.succeed(provenance)
          : Effect.fail(error))
      );
    })
  );
}

/**
 * A transcript this daemon will not admit is unavailable in the same sense a
 * missing runtime log is: the capture cannot happen here, and the unrelated
 * write it was riding along with has no stake in it. Session transcripts grow
 * without bound while the business write stays small, so an oversized capture
 * must not be able to fail `task create`. Every other write rejection — fence
 * loss, conflict, journal failure — still propagates.
 */
function transcriptCaptureIsOptionallyUnavailable(error: ProvenanceSessionExporterRejected): boolean {
  if (error.code === "transcript_unavailable" || error.code === "read_failed") return true;
  return error.code === "write_failed"
    && error.writeError?._tag === "WriteRejected"
    && error.writeError.code === "admission_payload_exceeds_limit";
}
