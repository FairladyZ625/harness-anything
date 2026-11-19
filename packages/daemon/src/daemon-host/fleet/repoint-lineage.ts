import {
  canonicalEventCut,
  canonicalLedgerCut,
} from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import {
  makeTaskEventReader,
  openFleetStorage,
  type DaemonStorageConfig,
  type ReplicationPosition,
} from "@harness-anything/storage";
import type { FleetFrameV1 } from "./command-protocol.ts";

export const REPOINT_RESUME_ONLY = "repoint-resume-only/v1";

export async function readFleetRepointLineage(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly storage?: DaemonStorageConfig;
  readonly position: ReplicationPosition;
  readonly retentionWindowCommits: number;
}): Promise<{
  readonly replicationSequence: number;
  readonly witness: NonNullable<Extract<FleetFrameV1, { schema: "fleet.repo.metadata.result/v1" }>["lineage"]>;
}> {
  const reader = makeTaskEventReader({ rootInput: input.rootDir, repoId: input.repoId, storage: input.storage });
  try {
    const event = reader.readEventAtRevision?.(input.position.revision),
      tipHash = event
        ? canonicalEventCut(input.repoId, event).headDigest
        : input.position.revision === 0
          ? canonicalLedgerCut(input.repoId, null).headDigest
          : null;
    const source = openFleetStorage(input);
    try {
      const head = source.replicationPosition(),
        page =
          head.sequence - input.position.sequence <= input.retentionWindowCommits
            ? source.replicationCommits(input.position, 1)
            : null,
        resumeAvailable =
          page !== null && (page.done || page.commits[0]?.position.sequence === input.position.sequence + 1);
      return {
        replicationSequence: head.sequence,
        witness: {
          ledgerGeneration: reader.ledgerMetadata().generation,
          tipHash,
          revision: input.position.revision,
          resumeAvailable,
        },
      };
    } finally {
      source.close();
    }
  } finally {
    await reader.drain();
  }
}
