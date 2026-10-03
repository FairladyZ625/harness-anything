// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  blockingOf,
  closeoutReadiness,
  createImmutableLegacyGenerationSnapshot,
  convertLegacyGeneration,
  deriveRelationId,
  makeTaskProjection,
  parseCanonicalEvent,
  type EntityUpsertEventV1,
  openSqliteEventStore,
  sha256Text,
  validateCurrentCanonicalEvent,
  type CanonicalEventStore,
  type CanonicalEventV1,
} from "@harness-anything/kernel";
import { planLegacyGenerationConversion } from "../../kernel/test/store/canonical-generation.fixtures.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { initRepo } from "./migration-import.fixtures.ts";
import { canonicalRoot } from "../src/protocol/daemon-protocol.contract.ts";
import { makeTaskQueryReadModel } from "../src/task-query-read.ts";

function sourceStore(events: readonly CanonicalEventV1[], content: ReadonlyMap<string, Buffer>): CanonicalEventStore {
  return {
    read: () => ({ revision: events.length, events }),
    readHead: () => ({ revision: events.length, eventDigest: `sha256:${"0".repeat(64)}` }),
    readBatch: () => ({
      sourceRevision: events.length,
      events,
      cursor: null,
      done: true,
      accessedItems: events.length,
      prefetchContent: () => new Map(content),
    }),
    readContentBlob: (digest) => content.get(digest) ?? null,
  } as CanonicalEventStore;
}

const historical = parseCanonicalEvent(
  readFileSync(
    new URL(
      "../../kernel/fixtures/canonical-events/entity-event-v1/accepted-entity-upserted-ddcb7509cb2d.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as unknown as EntityUpsertEventV1;

test("inactive generation preserves upsert content and materializes task disposition for real queries", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-history-shapes-"));
  try {
    initRepo(root);
    // The accepted fixture's private declaration is replaced with public test content; its
    // event shape and single-document ownership remain the same.
    const body = `${JSON.stringify({ schema: "agent-declaration/v1", id: "sol", name: "Fixture", instructions: "Fixture", runtimes: [{ type: "codex" }] })}\n`;
    const claim = {
      ...historical.payload.declarationDocumentClaim,
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
    };
    const entity = {
      ...historical,
      workspaceRevision: 1,
      payload: { ...historical.payload, declarationDocumentClaim: claim },
    } as unknown as CanonicalEventV1;
    const tasks = lifecycleFixture().events.map((event) => {
      const { packageDisposition: _disposition, ...task } = event.payload.task;
      return {
        ...event,
        workspaceRevision: event.workspaceRevision + 1,
        payload: { ...event.payload, task },
      } as CanonicalEventV1;
    });
    const events = [entity, ...tasks],
      content = new Map([[claim.sha256, Buffer.from(body)]]);
    const source = sourceStore(events, content),
      before = JSON.stringify(events);
    const snapshotPath = path.join(root, ".harness/store/imports/source.json"),
      databasePath = path.join(root, ".harness/store/generations/1/ledger.sqlite");
    createImmutableLegacyGenerationSnapshot({ repoId: "history-shapes", source, snapshotPath });
    const original = readFileSync(snapshotPath, "utf8");
    assert.equal(convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath }).active, false);
    const store = openSqliteEventStore({ repoId: "history-shapes", databasePath });
    try {
      const converted = store.events();
      assert.deepEqual(converted[0]!.payload.declarationDocumentClaim, claim);
      assert.deepEqual(Buffer.from(store.readContentObject(claim.sha256)!), Buffer.from(body));
      for (const event of converted) assert.deepEqual(validateCurrentCanonicalEvent(event), []);
      const replay = sourceStore(converted, content);
      assert.equal(planLegacyGenerationConversion({ rootDir: root, store: replay }).rewrites.length, 0);
      const projection = makeTaskProjection({ rootDir: root, eventStore: replay });
      try {
        projection.catchUp?.();
        const result = makeTaskQueryReadModel({
          rootDir: canonicalRoot(root),
          projection,
          readPinnedEntities: () => [],
          judgments: { closeout: closeoutReadiness, blocking: blockingOf },
        }).guiTasks();
        assert.deepEqual(result.invalidRows, []);
        assert.equal(result.rows.length, 1);
        assert.equal(result.rows[0]!.snapshot.task!.packageDisposition, "active");
      } finally {
        projection.close();
      }
    } finally {
      store.close();
    }
    assert.equal(readFileSync(snapshotPath, "utf8"), original);
    assert.equal(JSON.stringify(events), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy relation carriers are isolated before missing pinned fields are normalized", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-history-relation-cut-"));
  try {
    const fixture = lifecycleFixture();
    const identity = {
      source: "task/task-1",
      target: "task/task-1",
      type: "depends-on",
      direction: "directed",
    } as const;
    const relationId = deriveRelationId(identity);
    const relation = {
      relation_id: relationId,
      ...identity,
      strength: "strong",
      origin: "declared",
      state: "active",
      rationale: "Historical hosted relation.",
    };
    const { pinned: _pinned, ...legacyTask } = fixture.events.at(-1)!.payload.task;
    const added = {
      ...fixture.events.at(-1),
      eventId: "event-history-relation",
      workspaceRevision: 8,
      opId: "op_history_relation",
      type: "task_relation_added",
      payload: {
        task: { ...legacyTask, relations: [relation] },
        mutation: { command: "relate", reason: "Historical relation creation.", fields: [relationId] },
        documentClaims: [],
      },
    } as unknown as CanonicalEventV1;
    const snapshot = {
      ...added,
      eventId: "event-history-relation-snapshot",
      workspaceRevision: 9,
      opId: "op_history_relation_snapshot",
      type: "task_amended",
      payload: {
        task: { ...legacyTask, relations: [relation] },
        mutation: { command: "amend", reason: "Historical redundant snapshot.", fields: [] },
        documentClaims: [],
      },
    } as unknown as CanonicalEventV1;
    const events = [...fixture.events, added, snapshot];
    const before = JSON.stringify(events);
    const plan = planLegacyGenerationConversion({ rootDir: root, store: sourceStore(events, new Map()) });
    assert.equal(plan.events[7]!.type, "relation_created");
    assert.equal(plan.events[7]!.payload.relation.targetObservedVersion, 7);
    assert.equal(Object.hasOwn(plan.events[8]!.payload.task, "relations"), false);
    assert.ok(plan.events.every((event) => validateCurrentCanonicalEvent(event).length === 0));
    assert.equal(JSON.stringify(events), before);
    assert.equal(
      planLegacyGenerationConversion({ rootDir: root, store: sourceStore(plan.events, new Map()) }).rewrites.length,
      0,
    );
    // Missing declarations still fail; changing batch boundaries must not waive relation integrity.
    assert.throws(
      () =>
        planLegacyGenerationConversion({
          rootDir: root,
          store: sourceStore([...fixture.events, { ...snapshot, workspaceRevision: 8 }], new Map()),
        }),
      /relations not present at its historical cut/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
