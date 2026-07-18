import {
  canonicalCborBytesEqual,
  type makeLocalAuthorityAttributionEventV2Log,
  type PhysicalChangeV2
} from "../../../kernel/src/index.ts";
import { materializeCommittedAttributionEventV2 } from "./committed-attribution-event-v2.ts";
import type { AuthorityCommittedEventPublisherV2 } from "./types.ts";

type AuthorityAttributionEventV2Log = ReturnType<typeof makeLocalAuthorityAttributionEventV2Log>;

export interface AuthorityCommittedPhysicalObservationV2 {
  readonly commitSha: string;
  readonly previousCommit: string | null;
  readonly physicalChanges: ReadonlyArray<PhysicalChangeV2>;
  readonly recordedAt: string;
}

export interface AuthorityCommittedPhysicalObservationPortV2 {
  readonly observe: (input: {
    readonly workspaceId: string;
    readonly opId: string;
    readonly commitSha: string;
    readonly previousCommit: string | null;
  }) => Promise<AuthorityCommittedPhysicalObservationV2>;
}

export function createDurableAuthorityCommittedEventPublisherV2(options: {
  readonly eventLog: AuthorityAttributionEventV2Log;
  readonly observation: AuthorityCommittedPhysicalObservationPortV2;
  readonly commitEvidence?: (canonicalCommitSha: string) => Promise<void>;
}): AuthorityCommittedEventPublisherV2 {
  return {
    publish: async (input) => {
      const observed = await options.observation.observe({
        workspaceId: input.receipt.workspaceId,
        opId: input.receipt.opId,
        commitSha: input.receipt.commitSha,
        previousCommit: input.receipt.previousCommit
      });
      if (observed.commitSha !== input.receipt.commitSha
        || observed.previousCommit !== input.receipt.previousCommit) {
        throw new Error("AUTHORITY_EVENT_V2_PUBLICATION_OBSERVATION_MISMATCH");
      }
      const event = materializeCommittedAttributionEventV2({
        receipt: input.receipt,
        actorAxesBinding: input.actorAxesBinding,
        physicalChanges: observed.physicalChanges,
        occurredAt: input.occurredAt,
        recordedAt: observed.recordedAt
      });
      const ensured = options.eventLog.ensure(event);
      const stored = options.eventLog.read(event.workspaceId, event.opId);
      const storedBytes = options.eventLog.readBytes(event.workspaceId, event.opId);
      if (!stored || !storedBytes) throw new Error("AUTHORITY_EVENT_V2_DURABLE_READ_MISSING");
      if (stored.workspaceId !== event.workspaceId || stored.opId !== event.opId
        || !canonicalCborBytesEqual(storedBytes, ensured.bytes)) {
        throw new Error("AUTHORITY_EVENT_V2_DURABLE_REPLAY_MISMATCH");
      }
      await options.commitEvidence?.(stored.commitSha);
      return stored;
    }
  };
}
