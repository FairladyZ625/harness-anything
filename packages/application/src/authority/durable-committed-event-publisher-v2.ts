import {
  type makeLocalAuthorityAttributionEventV2Log,
} from "@harness-anything/kernel";
import { materializeCommittedAttributionEventV2 } from "./committed-attribution-event-v2.ts";
import type {
  AuthorityCommittedEventPublisherV2,
  AuthorityCommittedPhysicalObservationV2
} from "./types.ts";

type AuthorityAttributionEventV2Log = ReturnType<typeof makeLocalAuthorityAttributionEventV2Log>;

export interface AuthorityCommittedPhysicalObservationPortV2 {
  readonly observe: (input: {
    readonly workspaceId: string;
    readonly opIds: ReadonlyArray<string>;
    readonly commitSha: string;
    readonly previousCommit: string | null;
    readonly observation?: AuthorityCommittedPhysicalObservationV2;
  }) => Promise<AuthorityCommittedPhysicalObservationV2>;
}

export function createDurableAuthorityCommittedEventPublisherV2(options: {
  readonly eventLog: AuthorityAttributionEventV2Log;
  readonly observation: AuthorityCommittedPhysicalObservationPortV2;
  readonly commitEvidence?: (canonicalCommitSha: string) => Promise<void>;
}): AuthorityCommittedEventPublisherV2 {
  const publishBatch: NonNullable<AuthorityCommittedEventPublisherV2["publishBatch"]> = async (input) => {
      if (input.events.length === 0) return [];
      const [first, ...remaining] = input.events;
      if (remaining.some((candidate) => candidate.receipt.workspaceId !== first!.receipt.workspaceId
        || candidate.receipt.commitSha !== first!.receipt.commitSha
        || candidate.receipt.previousCommit !== first!.receipt.previousCommit)) {
        throw new Error("AUTHORITY_EVENT_V2_PUBLICATION_GROUP_MISMATCH");
      }
      const observed = await options.observation.observe({
        workspaceId: first!.receipt.workspaceId,
        opIds: input.events.map((candidate) => candidate.receipt.opId),
        commitSha: first!.receipt.commitSha,
        previousCommit: first!.receipt.previousCommit,
        ...(input.observation ? { observation: input.observation } : {})
      });
      if (observed.commitSha !== first!.receipt.commitSha
        || observed.previousCommit !== first!.receipt.previousCommit
        || input.events.some((candidate) => !observed.opIds.includes(candidate.receipt.opId))) {
        throw new Error("AUTHORITY_EVENT_V2_PUBLICATION_OBSERVATION_MISMATCH");
      }
      const stored = input.events.map((candidate) => options.eventLog.ensure(materializeCommittedAttributionEventV2({
        receipt: candidate.receipt,
        actorAxesBinding: candidate.actorAxesBinding,
        physicalChanges: observed.physicalChanges,
        occurredAt: candidate.occurredAt,
        recordedAt: candidate.occurredAt
      })).event);
      await options.commitEvidence?.(first!.receipt.commitSha);
      return stored;
  };
  return {
    publishBatch,
    publish: async (input) => {
      const [event] = await publishBatch({ events: [input] });
      if (!event) throw new Error("AUTHORITY_EVENT_V2_DURABLE_READ_MISSING");
      return event;
    }
  };
}
