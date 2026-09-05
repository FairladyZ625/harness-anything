import type { CanonicalEventV1 } from "../../src/domain/doc-sync.contract.ts";
import { serializeCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { lifecycleFixture } from "./task-lifecycle-fixture.ts";

export function memoryEventStore(events: readonly CanonicalEventV1[]) {
  return {
    readHead: () => ({
      revision: events.at(-1)?.workspaceRevision ?? 0,
      eventDigest: events.length === 0 ? null : `sha256:${sha256Text(serializeCanonicalEvent(events.at(-1)!))}`,
    }),
    readBatch: (cursor: string | null, maxItems: number) => {
      const start = cursor === null ? 0 : Number(cursor),
        slice = events.slice(start, start + maxItems);
      return {
        sourceRevision: events.at(-1)?.workspaceRevision ?? 0,
        events: slice,
        cursor: start + slice.length >= events.length ? null : String(start + slice.length),
        done: start + slice.length >= events.length,
        accessedItems: slice.length,
        prefetchContent: () => new Map<string, Uint8Array | null>(),
      };
    },
    readContentBlob: () => null,
  };
}

export function reviewEvents(
  secondReviewId: string,
  secondExecutionId = "execution-second",
): readonly CanonicalEventV1[] {
  const first = lifecycleFixture({
      taskId: "task-first",
      executionId: "execution-shared",
      reviewId: "review-shared",
    }).events.slice(0, 4),
    second = lifecycleFixture({
      taskId: "task-second",
      executionId: secondExecutionId,
      reviewId: secondReviewId,
    })
      .events.slice(0, 4)
      .map((event, index) => ({
        ...event,
        eventId: `event-second-${index + 5}`,
        opId: `op-second-${event.type}-${index + 5}`,
        workspaceRevision: index + 5,
      }));
  return [...first, ...second] as readonly CanonicalEventV1[];
}
