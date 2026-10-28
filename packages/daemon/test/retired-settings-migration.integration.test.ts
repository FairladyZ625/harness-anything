// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAttachMigrations,
  normalizeHistoricalVerticalDocument,
  type CanonicalEventStore,
} from "@harness-anything/kernel";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync-types";

function event(schema: string, payload: unknown, opId: string): PersistedCanonicalEventV1 {
  return {
    schema,
    eventId: `event-${opId}`,
    workspaceRevision: 1,
    opId,
    type: schema === "settings-event/v1" ? "settings_changed" : "vertical_declaration_changed",
    actor: { principal: { personId: "fixture" }, executor: null },
    source: "local",
    occurredAt: "2026-10-20T00:00:00.000Z",
    payload,
  } as unknown as PersistedCanonicalEventV1;
}

function fakeStore(initial: readonly PersistedCanonicalEventV1[]) {
  const events = [...initial];
  const store = {
    readHead: () =>
      events.length === 0
        ? null
        : { revision: events.length, opId: events.at(-1)!.opId, eventDigest: `sha256:${"0".repeat(64)}` },
    readEvent: (opId: string) => events.find((candidate) => candidate.opId === opId) ?? null,
    queryEvents: ({ limit }: { readonly limit: number }) => events.slice(0, limit),
    readBatch: (cursor: string | null, maxItems: number) => {
      const start = cursor === null ? 0 : Number(cursor),
        page = events.slice(start, start + maxItems),
        next = start + page.length;
      return {
        sourceRevision: events.length,
        events: page,
        cursor: page.length > 0 ? String(next) : cursor,
        done: next >= events.length,
        accessedItems: page.length,
      };
    },
    append: ({ event: next }: { readonly event: PersistedCanonicalEventV1 }) => {
      events.push(next);
      return {};
    },
  } as unknown as CanonicalEventStore;
  return { store, events };
}

test("attach applies retired settings migration without a manual command and is idempotent", () => {
  const { store, events } = fakeStore([
    event(
      "settings-event/v1",
      { settings: { ci: { workflows: ["retired"] }, gates: [{ adapter: "github-actions" }] } },
      "old-settings",
    ),
  ]);
  assert.deepEqual(applyAttachMigrations({ store, now: () => "2026-10-20T00:00:01.000Z" }).applied, ["settings.ci"]);
  // The one scan settles every step: only settings.ci matched, the others record zero affected events.
  const settled = events.length,
    markers = events
      .slice(1)
      .map((next) => (next as unknown as { payload: { migration: string; affectedEvents: number } }).payload);
  assert.ok(markers.length > 1);
  assert.deepEqual(
    markers.filter(({ affectedEvents }) => affectedEvents > 0).map(({ migration }) => migration),
    ["settings.ci"],
  );
  assert.deepEqual(applyAttachMigrations({ store }).applied, []);
  assert.equal(events.length, settled);
});

test("historical vertical declarations remain readable after hosted CI retirement", () => {
  assert.deepEqual(
    normalizeHistoricalVerticalDocument({
      schema: "repository-vertical-declaration/v1",
      definition: {
        completion: {
          sources: { ci: { kind: "github-actions" } },
          gates: { ci: { source: "ci" } },
        },
      },
    }),
    { schema: "repository-vertical-declaration/v1", definition: { completion: { sources: {}, gates: {} } } },
  );
});
