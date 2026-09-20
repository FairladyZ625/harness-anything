// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { serializePersistedCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import {
  compileSettingsChangedEvent,
  validateCurrentSettingsEvent,
  validateSettingsEvent,
  type SettingsEventV1,
} from "../../src/domain/settings-event.ts";
import { INITIAL_SETTINGS_V1, repositorySettings } from "../../src/domain/settings.ts";
import { normalizeHistoricalSettingsRoles } from "../../src/domain/settings-history.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import type { EventStreamPort } from "../../src/projection/rebuildable-task-projection-types.ts";
import { eventShapeMigrations, type EventShapeCut } from "../../src/store/event-shape-migration.ts";
import { contentClaims } from "../../src/store/task-event-store-claims-layout.ts";
import { openSqliteEventStore } from "../../src/store/sqlite-event-store.ts";
import { withTempStore } from "./helpers.ts";

const actor = { principal: { personId: "person-settings-replay" }, executor: null } as const;
const historicalBody = "settings:\n  defaultReviewer: arch-reviewer\n";

function bundle(revision: number, body: string) {
  return compileSettingsChangedEvent({
    settings: { ...repositorySettings(INITIAL_SETTINGS_V1), roles: { defaultReviewer: "current-reviewer" } },
    baseDocumentBody: historicalBody,
    candidateDocumentBody: body,
    eventId: `event-settings-${revision}`,
    opId: `settings-${revision}`,
    workspaceRevision: revision,
    actor,
    source: "local",
    occurredAt: "2026-09-20T00:00:00.000Z",
  });
}

function historicalEvent(): SettingsEventV1 {
  const current = bundle(1, historicalBody).event;
  const { roles: _roles, ...base } = current.payload.settings;
  return {
    ...current,
    payload: { ...current.payload, settings: { ...base, defaultReviewer: "arch-reviewer" } },
  } as unknown as SettingsEventV1;
}

test("historical Settings and matching document blobs survive cold rebuild and a current roles append", () => {
  withTempStore((rootDir) => {
    const store = openSqliteEventStore({ repoId: "settings-roles", databasePath: path.join(rootDir, "ledger.sqlite") });
    const fence = { repoId: "settings-roles", holder: "fixture", epoch: 1 };
    const historical = historicalEvent();
    assert.deepEqual(validateSettingsEvent(historical), []);
    assert.notDeepEqual(validateCurrentSettingsEvent(historical), []);
    const append = (event: SettingsEventV1, blobs: ReturnType<typeof bundle>["blobs"]) =>
      store.appendCommand({
        fence,
        intent: {
          opId: event.opId,
          intentDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`,
          summary: event.type,
        },
        events: [event],
        blobs,
      });
    // Fixture seeding uses the historical storage boundary, never the current event compiler.
    append(historical, bundle(1, historicalBody).blobs);
    const eventStore: EventStreamPort = {
      readHead: () => ({ revision: store.revision() }),
      readContentBlob: store.readContentObject,
      readBatch: (cursor, maxItems) => {
        const events = store.eventsAfter(Number(cursor ?? 0), maxItems);
        const revision = events.at(-1)?.workspaceRevision ?? Number(cursor ?? 0);
        return {
          sourceRevision: store.revision(),
          events,
          cursor: String(revision),
          done: revision === store.revision(),
          accessedItems: events.length,
          prefetchContent: (batch) =>
            new Map(
              batch.flatMap((event) =>
                contentClaims(event).map((claim) => [claim.sha256, store.readContentObject(claim.sha256)] as const),
              ),
            ),
        };
      },
    };
    const cold = makeTaskProjection({ rootDir, eventStore, projectionPath: path.join(rootDir, "cold-1.sqlite") });
    assert.equal(cold.rebuild().watermark, 1);
    const settings = cold.getEntity("settings", "repository")!.value;
    assert.deepEqual(settings.roles, { defaultReviewer: "arch-reviewer" });
    assert.equal(Object.hasOwn(settings, "defaultReviewer"), false);
    assert.equal(cold.readDocument("harness.yaml").document?.body, historicalBody);
    assert.deepEqual(store.event(historical.opId), historical, "historical event remains immutable");
    cold.close();
    // Simulate the previous binary's warm cache with the retired entity shape.
    const oldCache = new DatabaseSync(cold.path);
    oldCache.prepare("UPDATE projection_meta SET schema_version = 23 WHERE singleton = 1").run();
    oldCache
      .prepare("UPDATE entity_projection SET value_json = ? WHERE entity_kind = 'settings'")
      .run(JSON.stringify(historical.payload.settings));
    oldCache.close();
    const reopened = makeTaskProjection({ rootDir, eventStore, projectionPath: cold.path });
    assert.equal(reopened.catchUp!().watermark, 1);
    assert.deepEqual(reopened.getEntity("settings", "repository")!.value, settings);
    reopened.close();
    const currentBody = "settings:\n  roles:\n    defaultReviewer: current-reviewer\n";
    const current = bundle(2, currentBody);
    assert.deepEqual(validateCurrentSettingsEvent(current.event), []);
    append(current.event, current.blobs);
    const rebuilt = makeTaskProjection({ rootDir, eventStore, projectionPath: path.join(rootDir, "cold-2.sqlite") });
    assert.equal(rebuilt.rebuild().watermark, 2);
    assert.deepEqual(rebuilt.getEntity("settings", "repository")!.value, current.event.payload.settings);
    assert.equal(rebuilt.readDocument("harness.yaml").document?.body, currentBody);
    rebuilt.close();
    store.close();
  });
});

test("settings-roles migration preserves explicit roles, strips old keys, and converges", () => {
  const historical = historicalEvent();
  const migration = eventShapeMigrations["settings-roles-migrate"];
  const cut = {} as EventShapeCut; // This migration must not consult projection state.
  const rewritten = migration.rewrite(historical, cut);
  assert.ok(rewritten);
  assert.deepEqual(validateCurrentSettingsEvent(rewritten.event), []);
  assert.deepEqual(rewritten.event.payload.harnessDocumentClaim, historical.payload.harnessDocumentClaim);
  assert.equal(rewritten.event.eventId, historical.eventId);
  assert.equal(rewritten.event.opId, historical.opId);
  assert.equal(migration.rewrite(rewritten.event, cut), null);
  assert.deepEqual(
    normalizeHistoricalSettingsRoles({
      defaultReviewer: "old",
      roles: {
        defaultReviewer: "new",
        defaultWorker: "worker",
        defaultCommander: "commander",
      },
    }),
    { roles: { defaultReviewer: "new", defaultWorker: "worker", defaultCommander: "commander" } },
  );
  assert.deepEqual(normalizeHistoricalSettingsRoles({ defaultReviewer: "old", roles: { defaultWorker: "worker" } }), {
    roles: { defaultReviewer: "old", defaultWorker: "worker" },
  });
  assert.throws(() => normalizeHistoricalSettingsRoles({ defaultReviewer: "old", roles: "invalid" }), /object/u);
});
