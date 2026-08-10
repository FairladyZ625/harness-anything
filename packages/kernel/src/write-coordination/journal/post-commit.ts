import type { VersionControlSystem } from "../../ports/version-control-system.ts";
import type { HarnessLayoutInput } from "../../layout/index.ts";
import type { ProjectionChangeEvent } from "../../projection/projection-change-event.ts";
import { rebuildProjectionHash } from "./publication/projection.ts";
import { compactJournalAndCanTrimWatermark } from "./journal-compaction.ts";
import { writeWatermarkDurably } from "./durable.ts";
import type { JournalPostCommitPhase, ReadableJournalRecord, WriteWatermark } from "./types.ts";

export function finalizeJournalPostCommit(input: {
  readonly rootDir: string;
  readonly rootInput: HarnessLayoutInput;
  readonly journalPath: string;
  readonly watermarkPath: string;
  readonly previousWatermark: WriteWatermark | null;
  readonly records: ReadonlyArray<ReadableJournalRecord>;
  readonly committedOpIds: ReadonlyArray<string>;
  readonly confirmedAttributionOpIds: ReadonlySet<string>;
  readonly mutationCommitSha: string;
  readonly projectionRelevant: boolean;
  readonly deferProjectionUpdate: boolean;
  readonly touchedPaths: ReadonlyArray<string>;
  readonly previousProjectionSourceFingerprint?: string;
  readonly entityIds: ReadonlyArray<string>;
  readonly versionControlSystem: VersionControlSystem;
  readonly onProjectionChange?: (event: ProjectionChangeEvent) => void;
  readonly onPostCommitPhase?: (phase: JournalPostCommitPhase) => void;
  readonly forceCompaction?: boolean;
}): void {
  report(input, "projection-hash-start");
  const projectionUpdate = input.committedOpIds.length > 0 && input.projectionRelevant && !input.deferProjectionUpdate
    ? rebuildProjectionHash(
      input.rootDir,
      input.rootInput,
      input.touchedPaths,
      input.previousProjectionSourceFingerprint,
      input.entityIds,
      input.versionControlSystem
    )
    : undefined;
  report(input, "projection-hash-done");
  const projectionHash = projectionUpdate?.hash ?? input.previousWatermark?.projectionHash ?? "no-projection-change";
  const allCommitted = [...(input.previousWatermark?.lastCommittedOpIds ?? []), ...input.committedOpIds];
  const recentCommitted = allCommitted.slice(-128);
  if (input.committedOpIds.length === 0) return;

  report(input, "watermark-start");
  const fullWatermark = {
    schema: "write-watermark/v1",
    lastCommittedOpIds: allCommitted,
    lastCommitSha: input.mutationCommitSha,
    projectionHash,
    updatedAt: new Date().toISOString()
  } satisfies WriteWatermark;
  writeWatermarkDurably(input.watermarkPath, fullWatermark);
  report(input, "watermark-done");
  const reclaimableRecordCount = input.records.filter((record) =>
    allCommitted.includes(record.opId)
      && (record.schema !== "write-journal/v2" || input.confirmedAttributionOpIds.has(record.opId))).length;
  const shouldCompact = input.forceCompaction === true
    || reclaimableRecordCount >= 32
    || allCommitted.length > 128;
  if (!shouldCompact) return notifyProjection(input, projectionUpdate);
  report(input, "compaction-start");
  if (compactJournalAndCanTrimWatermark(input.journalPath, new Set(allCommitted), input.confirmedAttributionOpIds) && recentCommitted.length < allCommitted.length) {
    writeWatermarkDurably(input.watermarkPath, {
      ...fullWatermark,
      lastCommittedOpIds: recentCommitted,
      updatedAt: new Date().toISOString()
    });
  }
  report(input, "compaction-done");
  notifyProjection(input, projectionUpdate);
}

function notifyProjection(
  input: Parameters<typeof finalizeJournalPostCommit>[0],
  projectionUpdate: ReturnType<typeof rebuildProjectionHash> | undefined
): void {
  if (!projectionUpdate) return;
  report(input, "projection-notify-start");
  try {
    input.onProjectionChange?.(projectionUpdate.event);
  } catch {
    // Projection publication and its durable watermark already succeeded.
  }
  report(input, "projection-notify-done");
}

function report(input: { readonly onPostCommitPhase?: (phase: JournalPostCommitPhase) => void }, phase: JournalPostCommitPhase): void {
  input.onPostCommitPhase?.(phase);
}
