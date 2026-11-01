import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { serializeCanonicalEvent } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";

export function memoryEventStore(
  events: readonly CanonicalEventV1[],
  blobs: ReadonlyMap<string, Uint8Array> = new Map(),
) {
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
        prefetchContent: () => new Map(blobs),
      };
    },
    readContentBlob: (sha256: string) => blobs.get(sha256) ?? null,
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
    }).events.slice(0, 5),
    second = lifecycleFixture({
      taskId: "task-second",
      executionId: secondExecutionId,
      reviewId: secondReviewId,
    })
      .events.slice(0, 5)
      .map((event, index) => ({
        ...event,
        eventId: `event-second-${index + 6}`,
        opId: `op-second-${event.type}-${index + 6}`,
        workspaceRevision: index + 6,
      }));
  return [...first, ...second] as readonly CanonicalEventV1[];
}
