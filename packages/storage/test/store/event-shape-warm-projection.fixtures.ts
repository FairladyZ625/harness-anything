import { compileSettingsChangedEvent } from "@harness-anything/kernel/internal/domain/settings-event.ts";
import {
  INITIAL_SETTINGS_V1,
  repositorySettings,
  writeRepositorySettingsFacet,
} from "@harness-anything/kernel/internal/domain/settings.ts";
import type { CanonicalEventStore } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync-types.ts";
import type { EventStreamPort } from "@harness-anything/kernel/internal/ports/task-projection-source.ts";
import { contentClaims } from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";

export function warmProjectionFixture() {
  const baseBody = "settings:\n",
    body = writeRepositorySettingsFacet(baseBody, repositorySettings(INITIAL_SETTINGS_V1)),
    bundle = compileSettingsChangedEvent({
      settings: repositorySettings(INITIAL_SETTINGS_V1),
      baseDocumentBody: baseBody,
      candidateDocumentBody: body,
      eventId: "event-old-settings",
      opId: "old-settings",
      workspaceRevision: 1,
      actor: { principal: { personId: "fixture" }, executor: null },
      source: "local",
      occurredAt: "2026-11-12T00:00:00.000Z",
    }),
    oldSettings = { ...bundle.event.payload.settings, ci: { workflows: ["retired"] } },
    historical = { ...bundle.event, payload: { ...bundle.event.payload, settings: oldSettings } },
    events: PersistedCanonicalEventV1[] = [historical],
    blobs = new Map(bundle.blobs.map((blob) => [blob.sha256, new TextEncoder().encode(blob.body)])),
    scanned: number[] = [],
    eventStore: EventStreamPort = {
      readHead: () => ({ revision: events.length }),
      readContentBlob: (sha) => blobs.get(sha) ?? null,
      readBatch: (cursor, limit) => {
        const after = Number(cursor ?? 0),
          page = events.slice(after, after + limit),
          next = after + page.length;
        scanned.push(...page.map((event) => event.workspaceRevision));
        return {
          events: page,
          cursor: String(next),
          done: next === events.length,
          sourceRevision: events.length,
          accessedItems: page.length,
          prefetchContent: (batch) =>
            new Map(
              batch.flatMap((event) =>
                contentClaims(event).map((claim) => [claim.sha256, blobs.get(claim.sha256) ?? null] as const),
              ),
            ),
        };
      },
    },
    migrationStore = {
      ...eventStore,
      readEvent: (opId: string) => events.find((event) => event.opId === opId) ?? null,
      append: ({ event }: { event: PersistedCanonicalEventV1 }) => {
        events.push(event);
        return {};
      },
    } as unknown as CanonicalEventStore;
  return {
    bundle: { ...bundle, event: historical },
    oldSettings,
    expected: bundle.event.payload.settings,
    events,
    eventStore,
    migrationStore,
    scanned,
    body,
    baseBody,
  };
}
