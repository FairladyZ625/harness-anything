// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { serializePersistedCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import {
  compileSettingsChangedEvent,
  validateCurrentSettingsEvent,
  validateSettingsEvent,
  type SettingsEventV1,
} from "../../src/domain/settings-event.ts";
import { readSettingsFacet, repositorySettings, writeRepositorySettingsFacet } from "../../src/domain/settings.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import type { EventStreamPort } from "../../src/projection/rebuildable-task-projection-types.ts";
import { eventShapeMigrations, type EventShapeCut } from "../../src/store/event-shape-migration.ts";
import { contentClaims } from "../../src/store/task-event-store-claims-layout.ts";
import { openSqliteEventStore } from "../../src/store/sqlite-event-store.ts";
import { withTempStore } from "./helpers.ts";

// The frozen sample is a real `settings-initialize` event from the canonical ledger (ORIGINS.md);
// its snapshot carries all four retired walFlush fields.
const frozen = JSON.parse(
  readFileSync(new URL("../../fixtures/canonical-events/settings-event-v1/accepted.json", import.meta.url), "utf8"),
) as SettingsEventV1 & { readonly payload: { readonly settings: { readonly walFlush: unknown } } };
// The harness.yaml that init wrote alongside such an event; the frozen sample's own blob is not retained.
const historicalBody = [
  "schema: harness-anything/v1",
  "name: fixture",
  "settings:",
  "  defaultVertical: software/coding",
  "  defaultPreset: standard-task",
  "  defaultProfile: baseline",
  "  walFlush:",
  "    adaptive: true",
  "    events: 256",
  "    bytes: 8388608",
  "    milliseconds: 2000",
  "  scaffolds:",
  "    task: governance/task-scaffold.json",
  "    repository: governance/repository-scaffold.json",
  "",
].join("\n");
const historicalBlob = {
  sha256: sha256Text(historicalBody),
  size: Buffer.byteLength(historicalBody),
  mediaType: "application/yaml" as const,
  body: historicalBody,
};

function historicalEvent(): SettingsEventV1 {
  return {
    ...frozen,
    payload: {
      ...frozen.payload,
      baseDocumentSha256: historicalBlob.sha256,
      harnessDocumentClaim: {
        ...frozen.payload.harnessDocumentClaim,
        sha256: historicalBlob.sha256,
        size: historicalBlob.size,
      },
    },
  };
}

test("a stored Settings event carrying the retired walFlush fields replays from zero and accepts a current write", () => {
  withTempStore((rootDir) => {
    const store = openSqliteEventStore({ repoId: "settings-wal", databasePath: path.join(rootDir, "ledger.sqlite") });
    const fence = { repoId: "settings-wal", holder: "fixture", epoch: 1 };
    const historical = historicalEvent();
    assert.deepEqual(frozen.payload.settings.walFlush, {
      adaptive: true,
      bytes: 8388608,
      events: 256,
      milliseconds: 2000,
    });
    assert.deepEqual(validateSettingsEvent(historical), []);
    assert.notDeepEqual(validateCurrentSettingsEvent(historical), []);
    const append = (event: SettingsEventV1, blobs: readonly (typeof historicalBlob)[]) =>
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
    append(historical, [historicalBlob]);
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
    const { walFlush: _retired, ...declared } = frozen.payload.settings;
    // Negative control: every other stored field projects exactly as recorded.
    assert.deepEqual(cold.getEntity("settings", "repository")!.value, declared);
    assert.equal(cold.readDocument("harness.yaml").document?.body, historicalBody);
    assert.deepEqual(store.event(historical.opId), historical, "historical event remains immutable");
    const current = repositorySettings(cold.getEntity("settings", "repository")!.value as never);
    cold.close();

    const nextSettings = { ...current, reviewReturnBudget: 5 },
      nextBody = writeRepositorySettingsFacet(historicalBody, nextSettings),
      next = compileSettingsChangedEvent({
        settings: nextSettings,
        baseDocumentBody: historicalBody,
        candidateDocumentBody: nextBody,
        eventId: "event-settings-wal-2",
        opId: "settings-wal-2",
        workspaceRevision: 2,
        actor: historical.actor,
        source: "local",
        occurredAt: "2026-10-01T00:00:00.000Z",
      });
    assert.deepEqual(validateCurrentSettingsEvent(next.event), []);
    append(next.event, next.blobs);
    const rebuilt = makeTaskProjection({ rootDir, eventStore, projectionPath: path.join(rootDir, "cold-2.sqlite") });
    assert.equal(rebuilt.rebuild().watermark, 2);
    assert.deepEqual(rebuilt.getEntity("settings", "repository")!.value, next.event.payload.settings);
    assert.equal(Object.hasOwn(next.event.payload.settings, "walFlush"), false);
    assert.equal(readSettingsFacet(nextBody).reviewReturnBudget, 5);
    // The retired block is unowned YAML now: a current write leaves its lines where they are.
    assert.equal(nextBody.replace("  reviewReturnBudget: 5\n", ""), historicalBody);
    assert.equal(rebuilt.readDocument("harness.yaml").document?.body, nextBody);
    rebuilt.close();
    store.close();
  });
});

test("settings-wal-flush migration drops the retired fields for the next generation and converges", () => {
  const historical = historicalEvent();
  const migration = eventShapeMigrations["settings-wal-flush-migrate"];
  const cut = {} as EventShapeCut; // This migration must not consult projection state.
  const rewritten = migration.rewrite(historical, cut);
  assert.ok(rewritten);
  assert.deepEqual(validateCurrentSettingsEvent(rewritten.event), []);
  const { walFlush: _retired, ...declared } = historical.payload.settings;
  assert.deepEqual((rewritten.event as SettingsEventV1).payload.settings, declared);
  assert.deepEqual(
    (rewritten.event as SettingsEventV1).payload.harnessDocumentClaim,
    historical.payload.harnessDocumentClaim,
  );
  assert.equal(rewritten.event.eventId, historical.eventId);
  assert.equal(rewritten.event.opId, historical.opId);
  assert.equal(migration.rewrite(rewritten.event, cut), null);
});
