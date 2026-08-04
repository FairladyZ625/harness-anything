import type { TaskFieldExtensionProjection } from "./types.ts";
import type { IncrementalProjectionRebuildReason } from "./projection-change-event.ts";
import {
  summarizeProjectionSourceFingerprint,
  type ProjectionSourceFingerprint,
  type ProjectionSourceSummary
} from "./projection-source-snapshot.ts";
import { tryReadProjectionDatabase } from "./sqlite-projection-store.ts";

export interface IncrementalProjectionDiagnostic {
  readonly kind: "source-capture" | "metadata";
  readonly phase: "captured" | "mismatch" | "stored";
  readonly summary: ProjectionSourceSummary;
  readonly existingSourceHash: string;
  readonly previousSourceFingerprint?: string;
  readonly storedSourceHash?: string;
}

export function sourceCaptureDiagnostic(
  source: ProjectionSourceFingerprint,
  existingSourceHash: string,
  previousSourceFingerprint?: string
): IncrementalProjectionDiagnostic {
  return metadataDiagnostic("captured", source, existingSourceHash, previousSourceFingerprint, "source-capture");
}

export function projectionMetadataDiagnostic(
  phase: "mismatch" | "stored",
  source: ProjectionSourceFingerprint,
  existingSourceHash: string,
  previousSourceFingerprint?: string,
  storedSourceHash?: string
): IncrementalProjectionDiagnostic {
  return metadataDiagnostic(phase, source, existingSourceHash, previousSourceFingerprint, "metadata", storedSourceHash);
}

export function rebuiltProjectionSourceHash(
  reason: IncrementalProjectionRebuildReason,
  projectionPath: string,
  taskFieldExtensions?: ReadonlyArray<TaskFieldExtensionProjection>
): string | undefined {
  if (reason !== "source-fingerprint-mismatch") return undefined;
  const persisted = tryReadProjectionDatabase(projectionPath, taskFieldExtensions);
  return persisted.ok ? persisted.meta.sourceHash : undefined;
}

function metadataDiagnostic(
  phase: "captured" | "mismatch" | "stored",
  source: ProjectionSourceFingerprint,
  existingSourceHash: string,
  previousSourceFingerprint: string | undefined,
  kind: IncrementalProjectionDiagnostic["kind"],
  storedSourceHash?: string
): IncrementalProjectionDiagnostic {
  return {
    kind,
    phase,
    summary: summarizeProjectionSourceFingerprint(source),
    existingSourceHash,
    ...(previousSourceFingerprint ? { previousSourceFingerprint } : {}),
    ...(storedSourceHash ? { storedSourceHash } : {})
  };
}
