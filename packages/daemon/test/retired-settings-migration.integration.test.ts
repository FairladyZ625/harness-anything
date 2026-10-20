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
    queryEvents: ({ limit }: { readonly limit: number }) => events.slice(0, limit),
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
  assert.equal(events.length, 2);
  assert.deepEqual(applyAttachMigrations({ store }).applied, []);
  assert.equal(events.length, 2);
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
