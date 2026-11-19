import { consumeKnownError } from "@harness-anything/kernel";
import { canonicalEventCut, canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { makeTaskEventReader, openFleetStorage, type DaemonStorageConfig, type ReplicationPosition } from "@harness-anything/storage";
import type { FleetFrameV1, FleetLoginAuthority } from "./command-protocol.ts";

export const REPOINT_RESUME_ONLY = "repoint-resume-only/v1";

export async function readFleetRepointLineage(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly storage?: DaemonStorageConfig;
  readonly position: ReplicationPosition;
  readonly retentionWindowCommits: number;
  readonly loginAuthority: FleetLoginAuthority | null;
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
      const head = source.replicationPosition();
      let resumeAvailable = false;
      if (head.sequence - input.position.sequence <= input.retentionWindowCommits) {
        try {
          const page = source.replicationCommits(input.position, 1);
          resumeAvailable = page.done || page.commits[0]?.position.sequence === input.position.sequence + 1;
        } catch (error) {
          if ((error as { readonly code?: unknown }).code !== "revision_conflict") throw error;
          consumeKnownError(error);
        }
      }
      return {
        replicationSequence: head.sequence,
        witness: {
          ledgerGeneration: reader.ledgerMetadata().generation,
          tipHash,
          revision: input.position.revision,
          resumeAvailable,
          loginAuthority: input.loginAuthority,
        },
      };
    } finally {
      source.close();
    }
  } finally {
    await reader.drain();
  }
}
