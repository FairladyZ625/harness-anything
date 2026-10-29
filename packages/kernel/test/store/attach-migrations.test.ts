// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { applyAttachMigrations, attachMigrationRegistry } from "../../src/store/attach-migrations.ts";
import { historicalReadConclusions as publicHistoricalReadConclusions } from "../../src/index.ts";
import { retiredPersistedSchemaFields } from "../../src/domain/event-shape-migration-event.ts";
import {
  normalizeHistoricalEvent,
  normalizeHistoricalPresetSnapshot,
  normalizeHistoricalVerticalDocument,
} from "../../src/projection/historical-event-normalization.ts";
import type { CanonicalEventStore } from "../../src/store/task-event-store-types.ts";
import type { PersistedCanonicalEventV1 } from "../../src/domain/doc-sync-types.ts";
import {
  classifyDocCandidate,
  classifyTextualArtifactPath,
  effectiveDocCandidateClassification,
  OPAQUE_TEXTUAL_MEDIA_TYPE,
  OPAQUE_TEXTUAL_POLICY_ID,
  RAW_ARTIFACT_POLICY_ID,
} from "../../src/domain/artifact-text-classification.ts";
import { validDocEventChange } from "../../src/domain/doc-sync-validation.ts";

function fakeStore(initial: readonly PersistedCanonicalEventV1[]) {
  const events = [...initial],
    watermarks = new Map<string, number>(),
    reads = { queryEvents: 0, readBatch: 0, scannedRevisions: [] as number[] };
  const store = {
    read: () => ({ schema: "canonical-event-stream/v1" as const, revision: events.length, events }),
    readHead: () =>
      events.length === 0
        ? null
        : { revision: events.length, opId: events.at(-1)!.opId, eventDigest: "sha256:" + "0".repeat(64) },
    readEvent: (opId: string) => events.find((event) => event.opId === opId) ?? null,
    append: ({ event }: { event: PersistedCanonicalEventV1 }) => {
      events.push(event);
      return {};
    },
    queryEvents: ({ limit }: { readonly limit: number }) => {
      reads.queryEvents += 1;
      return events.slice(0, limit);
    },
    readBatch: (cursor: string | null, maxItems: number) => {
      reads.readBatch += 1;
      const start = cursor === null ? 0 : Number(cursor),
        page = events.slice(start, start + maxItems),
        next = start + page.length;
      reads.scannedRevisions.push(...page.map(({ workspaceRevision }) => workspaceRevision));
      return {
        sourceRevision: events.length,
        events: page,
        cursor: page.length > 0 ? String(next) : cursor,
        done: next >= events.length,
        accessedItems: page.length,
      };
    },
    readAttachMigrationScanWatermarks: () => new Map(watermarks),
    recordAttachMigrationScanWatermarks: (
      entries: readonly { readonly migration: string; readonly revision: number }[],
    ) => {
      for (const { migration, revision } of entries) watermarks.set(migration, revision);
    },
  } as unknown as CanonicalEventStore;
  return { store, events, reads, watermarks };
}

const actor = { principal: { personId: "fixture" }, executor: null } as const;
const envelope = (schema: string, payload: unknown, opId: string, workspaceRevision = 1): PersistedCanonicalEventV1 =>
  ({
    schema,
    eventId: `event-${opId}`,
    workspaceRevision,
    opId,
    type:
      schema === "task-event/v1"
        ? "task_created"
        : schema === "schedule-event/v1"
          ? "schedule_created"
          : schema === "agent-runtime-event/v1"
            ? "runtime_dispatch_requested"
            : "settings_changed",
    actor,
    source: "local",
    occurredAt: "2026-10-20T00:00:00.000Z",
    ...(schema === "schedule-event/v1" ? { entity: { kind: "schedule", id: "schedule-old" } } : {}),
    ...(schema === "settings-event/v1" ? { entity: { kind: "settings", id: "repository" } } : {}),
    payload,
  }) as unknown as PersistedCanonicalEventV1;

test("attach migration registry covers each retired historical field and is idempotent", () => {
  assert.deepEqual(
    attachMigrationRegistry.map((entry) => entry.name),
    [
      "closeout-overrides.fact",
      "closeout-overrides.codeDoc",
      "schedule.ciObserve",
      "squad-run.subject",
      "settings.ci",
      "settings.closeout.codeDoc",
      "settings.review.thresholds",
      "runtime.reviewDispatchKey",
      "vertical.completion.sources",
      "vertical.completion.closeoutCodeDoc",
      "submission.delivery-facts",
      "review.finding.category",
    ],
  );
  assert.deepEqual(
    attachMigrationRegistry.filter((entry) => entry.kind === "event-migration").map(({ name }) => name),
    [
      "closeout-overrides.fact",
      "closeout-overrides.codeDoc",
      "schedule.ciObserve",
      "squad-run.subject",
      "settings.ci",
      "settings.closeout.codeDoc",
      "settings.review.thresholds",
      "runtime.reviewDispatchKey",
      "vertical.completion.sources",
      "vertical.completion.closeoutCodeDoc",
    ],
  );
  assert.deepEqual(
    attachMigrationRegistry
      .filter((entry) => entry.kind === "event-migration")
      .flatMap(({ fields }) => fields)
      .sort(),
    [...retiredPersistedSchemaFields].sort(),
  );
  const { store, events, reads } = fakeStore([
    envelope("task-event/v1", { task: { closeoutOverrides: { fact: false } } }, "old-task"),
    envelope("task-event/v1", { task: { closeoutOverrides: { codeDoc: true } } }, "old-task-code-doc"),
    envelope("schedule-event/v1", { schedule: { status: { ciObserve: { workflow: "retired" } } } }, "old-schedule"),
    envelope(
      "agent-runtime-event/v1",
      { squadRun: { squadRunId: "squad_0123456789abcdef01234567", taskId: "task-old", executionId: "execution-old" } },
      "old-squad-dispatch",
    ),
    envelope("settings-event/v1", { settings: { ci: { workflows: ["rewrite-ci"] } } }, "old-settings"),
    envelope(
      "settings-event/v1",
      { settings: { review: { thresholds: { correctness: 80, migration: 85, securityAuth: 90 } } } },
      "old-review-thresholds",
    ),
    envelope(
      "settings-event/v1",
      { settings: { closeout: { overrides: { codeDoc: true, review: false } } } },
      "old-closeout-settings",
    ),
    envelope(
      "vertical-declaration-event/v1",
      {
        declaration: {
          definition: {
            completion: {
              sources: { ci: { kind: "github-actions" } },
              closeoutDefaults: { codeDoc: true },
            },
          },
        },
      },
      "old-vertical",
    ),
    {
      ...envelope(
        "agent-runtime-event/v1",
        {
          dispatchId: "dispatch-original",
          runtimeSessionId: "runtime-original",
          dispatchKey: `task-review:task-a:execution-a:2:sha256:${"a".repeat(64)}`,
          role: "reviewer",
          agentId: "reviewer-b",
          taskId: "task-a",
          executionId: "execution-a",
          reviewTarget: {
            kind: "task",
            taskId: "task-a",
            executionId: "execution-a",
            digest: `sha256:${"a".repeat(64)}`,
          },
        },
        "old-review-dispatch",
      ),
      type: "runtime_dispatch_requested",
    } as unknown as PersistedCanonicalEventV1,
  ]);
  const first = applyAttachMigrations({ store, now: () => "2026-10-20T00:00:01.000Z" });
  assert.deepEqual(first.applied, [
    "closeout-overrides.fact",
    "closeout-overrides.codeDoc",
    "schedule.ciObserve",
    "squad-run.subject",
    "settings.ci",
    "settings.closeout.codeDoc",
    "settings.review.thresholds",
    "runtime.reviewDispatchKey",
    "vertical.completion.sources",
    "vertical.completion.closeoutCodeDoc",
  ]);
  assert.equal(events.length, 19);
  const second = applyAttachMigrations({ store, now: () => "2026-10-20T00:00:02.000Z" });
  assert.deepEqual(second.applied, []);
  assert.equal(events.length, 19);
  assert.equal(reads.queryEvents, 0, "attach migration scans use bounded event batches");
  assert.equal(reads.readBatch, 1, "a completed migration set does not rescan the event history");
});

test("zero-match attach scans persist their local watermark and skip an unchanged head", () => {
  const { store, events, reads, watermarks } = fakeStore([
    envelope("task-event/v1", { task: { title: "Historical one" } }, "historical-one", 1),
    envelope("task-event/v1", { task: { title: "Historical two" } }, "historical-two", 2),
  ]);

  applyAttachMigrations({ store });
  assert.equal(events.length, 2, "zero matches do not append canonical marker events");
  assert.deepEqual(
    [...watermarks],
    attachMigrationRegistry.filter((entry) => entry.kind === "event-migration").map(({ name }) => [name, 2]),
  );
  assert.deepEqual(reads.scannedRevisions, [1, 2]);

  const completedReadBatches = reads.readBatch;
  applyAttachMigrations({ store });
  assert.equal(reads.readBatch, completedReadBatches, "the unchanged head requires no event batch read");
  assert.equal(events.length, 2);
});

test("an advanced attach head scans only events after the saved watermark", () => {
  const { store, events, reads, watermarks } = fakeStore([
      envelope("task-event/v1", { task: { title: "Historical one" } }, "historical-one", 1),
      envelope("task-event/v1", { task: { title: "Historical two" } }, "historical-two", 2),
    ]),
    migration = "closeout-overrides.fact";

  applyAttachMigrations({ store });
  const firstScanCount = reads.scannedRevisions.length;
  events.push(envelope("task-event/v1", { task: { closeoutOverrides: { fact: false } } }, "new-retired-shape", 3));

  const result = applyAttachMigrations({ store });
  assert.deepEqual(reads.scannedRevisions.slice(firstScanCount), [3]);
  assert.deepEqual(result.applied, [migration]);
  assert.deepEqual(
    events.slice(3).map((event) => event.type),
    ["event_shape_migration_applied"],
    "the existing positive-match marker path remains the only event write",
  );
  assert.equal(
    (events[3] as unknown as { payload: { migration: string; affectedEvents: number } }).payload.migration,
    migration,
  );
  assert.ok([...watermarks.values()].every((revision) => revision === 3));
});

test("a watermark ahead of the rolled-back head is discarded and rescanned", () => {
  const { store, events, reads, watermarks } = fakeStore([
    envelope("task-event/v1", { task: { title: "Historical one" } }, "historical-one", 1),
    envelope("task-event/v1", { task: { title: "Historical two" } }, "historical-two", 2),
  ]);

  applyAttachMigrations({ store });
  assert.ok([...watermarks.values()].every((revision) => revision === 2));

  events.pop();
  const previousReadBatches = reads.readBatch;
  reads.scannedRevisions.length = 0;
  assert.doesNotThrow(() => applyAttachMigrations({ store }));

  assert.deepEqual(reads.scannedRevisions, [1], "the stale watermark causes a scan from revision zero");
  assert.equal(reads.readBatch, previousReadBatches + 1);
  assert.equal(events.length, 1, "a zero-match rescan does not append an event");
  assert.ok([...watermarks.values()].every((revision) => revision === 1));
});

test("attach migration scan reports monotonic progress while paging historical events", () => {
  const { store, reads } = fakeStore(
      Array.from({ length: 513 }, (_, index) =>
        envelope("task-event/v1", { task: { title: `Historical ${index}` } }, `historical-${index}`),
      ),
    ),
    progress: { readonly applied: number; readonly total: number }[] = [];
  applyAttachMigrations({
    store,
    onProgress: (value: { readonly applied: number; readonly total: number }) => progress.push(value),
  });

  assert.deepEqual(progress, [
    { applied: 256, total: 513 },
    { applied: 512, total: 513 },
    { applied: 513, total: 513 },
  ]);
  assert.equal(reads.queryEvents, 0);
  assert.equal(reads.readBatch, 3);
});

test("a retired codeDoc step still runs on a ledger that already applied its parent step", () => {
  // Ledgers that installed the code/doc mechanism before 2026-10-21 already recorded
  // `settings.ci` / `vertical.completion.sources`; folding the new field into either step would
  // skip it wholesale and leave the retired value unrecorded. Each field owns its own step name.
  const migrationEvent = (migration: string) =>
    ({
      schema: "event-shape-migration/v1",
      eventId: `event-upgrade-${migration}`,
      workspaceRevision: 1,
      opId: `upgrade-${migration}`,
      type: "event_shape_migration_applied",
      actor,
      source: "local",
      occurredAt: "2026-10-20T00:00:00.000Z",
      payload: { migration, version: 1, sourceRevision: 0, affectedEvents: 1 },
    }) as unknown as PersistedCanonicalEventV1;
  const { store, events } = fakeStore([
    migrationEvent("settings.ci"),
    migrationEvent("vertical.completion.sources"),
    envelope(
      "settings-event/v1",
      { settings: { closeout: { overrides: { codeDoc: true } } } },
      "old-closeout-settings",
    ),
    envelope(
      "vertical-declaration-event/v1",
      { declaration: { definition: { completion: { closeoutDefaults: { codeDoc: true } } } } },
      "old-vertical",
    ),
  ]);
  assert.deepEqual(applyAttachMigrations({ store }).applied, [
    "settings.closeout.codeDoc",
    "vertical.completion.closeoutCodeDoc",
  ]);
  assert.equal(events.length, 6);
});

test("legacy submission facts stay readable without an attach migration event", () => {
  assert.deepEqual(
    publicHistoricalReadConclusions.map(({ name }) => name),
    ["submission.delivery-facts", "review.finding.category"],
  );
  const conclusion = attachMigrationRegistry.find(
    (entry) => entry.kind === "read-conclusion" && entry.name === "submission.delivery-facts",
  );
  assert.deepEqual(conclusion, {
    kind: "read-conclusion",
    name: "submission.delivery-facts",
    fields: ["Execution.submission.changedFiles", "Execution.submission.productionDelta"],
    attachRequired: false,
    conclusion:
      "Legacy rows remain byte-identical; the shared submission-facts reader exposes unambiguous stored paths and no production delta.",
  });
  // The finding-category narrowing is a read conclusion too: historical findings are immutable, so
  // its registered exit is a disposition, not an attach rewrite.
  const findingConclusion = attachMigrationRegistry.find(
    (entry) => entry.kind === "read-conclusion" && entry.name === "review.finding.category",
  );
  assert.equal(findingConclusion?.attachRequired, false);
  assert.deepEqual(findingConclusion?.fields, ["Review.findings[].category", "DecisionReview.findings[].category"]);
  const legacySubmission = {
      commitSha: "a".repeat(40),
      completionClaim: "Delivered before submission facts were added.",
      deliverables: ["packages/kernel/old.ts"],
      outputs: ["Deleted-Production-Paths: packages/kernel/retired.ts"],
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      completionContract: {},
    },
    historical = {
      ...envelope(
        "task-event/v1",
        { execution: { executionId: "execution-old", submission: legacySubmission } },
        "old-submission",
      ),
      type: "execution_submitted",
    } as unknown as PersistedCanonicalEventV1,
    { store, events } = fakeStore([historical]);
  assert.equal(
    attachMigrationRegistry.some((entry) => entry.kind === "event-migration" && entry.matches(historical)),
    false,
  );
  assert.deepEqual(applyAttachMigrations({ store }).applied, []);
  assert.equal(events.length, 1, "a read conclusion does not append a zero-match migration event");
  assert.deepEqual(
    (events[0] as unknown as { payload: { execution: { submission: unknown } } }).payload.execution.submission,
    legacySubmission,
  );
});

test("historical reviewer dispatch key normalization preserves all dispatch identities and ignores other lanes", () => {
  const legacy = {
      ...envelope(
        "agent-runtime-event/v1",
        {
          dispatchId: "dispatch-original",
          runtimeSessionId: "runtime-original",
          dispatchKey: `task-review:task-a:execution-a:2:sha256:${"a".repeat(64)}:attempt3`,
          role: "reviewer",
          agentId: "reviewer-b",
          taskId: "task-a",
          executionId: "execution-a",
          reviewTarget: {
            kind: "task",
            taskId: "task-a",
            executionId: "execution-a",
            digest: `sha256:${"a".repeat(64)}`,
          },
        },
        "old-review-dispatch",
      ),
      type: "runtime_dispatch_requested",
    } as unknown as PersistedCanonicalEventV1,
    migrated = normalizeHistoricalEvent(legacy) as unknown as {
      readonly eventId: string;
      readonly opId: string;
      readonly payload: Readonly<Record<string, unknown>>;
    };
  assert.equal(
    migrated.payload.dispatchKey,
    `task-review:task-a:execution-a:2:sha256:${"a".repeat(64)}:reviewer:reviewer-b:attempt3`,
  );
  assert.equal(migrated.eventId, legacy.eventId);
  assert.equal(migrated.opId, legacy.opId);
  assert.equal(migrated.payload.dispatchId, "dispatch-original");
  assert.equal(migrated.payload.runtimeSessionId, "runtime-original");
  assert.deepEqual(normalizeHistoricalEvent(migrated as unknown as PersistedCanonicalEventV1), migrated);
  const { dispatchKey: legacyIdempotencyKey, ...payloadWithoutDispatchKey } = legacy.payload,
    oldSpelling = {
      ...legacy,
      payload: { ...payloadWithoutDispatchKey, idempotencyKey: legacyIdempotencyKey },
    } as unknown as PersistedCanonicalEventV1,
    migration = attachMigrationRegistry.find(({ name }) => name === "runtime.reviewDispatchKey");
  assert.ok(migration);
  assert.equal(migration.matches(oldSpelling), true, "attach detects the old idempotencyKey spelling");
  const normalizedOldSpelling = normalizeHistoricalEvent(oldSpelling) as unknown as {
    readonly payload: Readonly<Record<string, unknown>>;
  };
  assert.equal(
    normalizedOldSpelling.payload.dispatchKey,
    `task-review:task-a:execution-a:2:sha256:${"a".repeat(64)}:reviewer:reviewer-b:attempt3`,
  );
  assert.equal(Object.hasOwn(normalizedOldSpelling.payload, "idempotencyKey"), false);
  const base = `task-review:task-a:execution-a:2:sha256:${"a".repeat(64)}`,
    keyAfter = (dispatchKey: string) => {
      const normalized = normalizeHistoricalEvent({
        ...legacy,
        payload: { ...legacy.payload, dispatchKey },
      } as unknown as PersistedCanonicalEventV1) as unknown as { readonly payload: Readonly<Record<string, unknown>> };
      return normalized.payload.dispatchKey;
    };
  // Provider fallback continues the same dispatch under `:fallback:N`, with or without a prior attempt.
  assert.equal(keyAfter(`${base}:fallback:1`), `${base}:reviewer:reviewer-b:fallback:1`);
  assert.equal(keyAfter(`${base}:attempt1:fallback:2`), `${base}:reviewer:reviewer-b:attempt1:fallback:2`);
  // Every other tail keeps its historical bytes: already qualified, zero-indexed, or shaped otherwise.
  for (const unchanged of [
    `${base}:reviewer:reviewer-b`,
    `${base}:reviewer:reviewer-b:fallback:1`,
    `${base}:fallback:0`,
    `${base}:fallback:1:attempt2`,
    `${base}:attempt0`,
  ])
    assert.equal(keyAfter(unchanged), unchanged);
  const pathLane = {
    ...legacy,
    payload: { ...legacy.payload, dispatchKey: "task-review-lane:task-a:execution-a:data-migration" },
  } as unknown as PersistedCanonicalEventV1;
  // The persisted-event normalizer deep-canonicalizes squad identity and timestamps, so it may
  // return a fresh object; the lane guarantee is that its dispatch key bytes stay untouched.
  assert.deepEqual(normalizeHistoricalEvent(pathLane), pathLane);
  const { dispatchKey: laneIdempotencyKey, ...pathPayloadWithoutDispatchKey } = pathLane.payload,
    legacyPathLane = {
      ...pathLane,
      payload: { ...pathPayloadWithoutDispatchKey, idempotencyKey: laneIdempotencyKey },
    } as unknown as PersistedCanonicalEventV1;
  assert.equal(migration.matches(legacyPathLane), false, "the cut-key migration excludes path-review lane keys");
  assert.deepEqual(normalizeHistoricalEvent(legacyPathLane), legacyPathLane);
});

test("attach notices a retired source embedded in a task preset snapshot blob", () => {
  const events = [
      envelope("task-bootstrap-event/v1", { presetSnapshotClaim: { sha256: "snapshot-blob" } }, "old-task"),
    ] as PersistedCanonicalEventV1[],
    store = {
      readHead: () => ({ revision: events.length, opId: events.at(-1)!.opId, eventDigest: "sha256:" + "0".repeat(64) }),
      readEvent: (opId: string) => events.find((event) => event.opId === opId) ?? null,
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
      readContentBlob: () =>
        Buffer.from(
          JSON.stringify({
            completion: { sources: { ci: { kind: "github-actions" } }, gates: { ci: { source: "ci" } } },
          }),
        ),
      append: ({ event }: { readonly event: PersistedCanonicalEventV1 }) => {
        events.push(event);
        return {};
      },
    } as unknown as CanonicalEventStore;
  assert.deepEqual(applyAttachMigrations({ store }).applied, ["vertical.completion.sources"]);
});

test("attach records the retired codeDoc override on both of its carriers", () => {
  // `codeDoc` is not only a task-bound override: a preset profile froze it into
  // `preset-snapshot/v1`, and that snapshot is content the matcher must read. One step covers both
  // carriers; the snapshot's declared `completion` default is a different field with its own step.
  const events = [
      envelope("task-event/v1", { task: { closeoutOverrides: { codeDoc: true, review: false } } }, "old-task"),
      envelope("task-bootstrap-event/v1", { presetSnapshotClaim: { sha256: "profile-blob" } }, "old-bootstrap"),
    ] as PersistedCanonicalEventV1[],
    store = {
      readHead: () => ({ revision: events.length, opId: events.at(-1)!.opId, eventDigest: "sha256:" + "0".repeat(64) }),
      readEvent: (opId: string) => events.find((event) => event.opId === opId) ?? null,
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
      readContentBlob: () =>
        Buffer.from(
          JSON.stringify({
            schema: "preset-snapshot/v1",
            profile: { id: "baseline", completionGateIds: [], closeoutOverrides: { codeDoc: true } },
            completion: { sources: {}, gates: {}, closeoutDefaults: {} },
          }),
        ),
      append: ({ event }: { readonly event: PersistedCanonicalEventV1 }) => {
        events.push(event);
        return {};
      },
    } as unknown as CanonicalEventStore;
  assert.deepEqual(applyAttachMigrations({ store }).applied, ["closeout-overrides.codeDoc"]);
});

test("historical projection strips the retired codeDoc override from task and preset carriers", () => {
  const task = normalizeHistoricalEvent(
      envelope("task-event/v1", { task: { closeoutOverrides: { codeDoc: true, review: false } } }, "task-code-doc"),
    ) as unknown as { readonly payload: { readonly task: { readonly closeoutOverrides?: unknown } } },
    onlyCodeDoc = normalizeHistoricalEvent(
      envelope("task-event/v1", { task: { closeoutOverrides: { codeDoc: true } } }, "task-code-doc-only"),
    ) as unknown as { readonly payload: { readonly task: Record<string, unknown> } };
  assert.deepEqual(task.payload.task.closeoutOverrides, { review: false });
  assert.equal(Object.hasOwn(onlyCodeDoc.payload.task, "closeoutOverrides"), false);
  assert.deepEqual(
    normalizeHistoricalPresetSnapshot({
      schema: "preset-snapshot/v1",
      profile: { id: "baseline", completionGateIds: [], closeoutOverrides: { codeDoc: true, consent: false } },
      completion: { sources: {}, gates: {}, closeoutDefaults: {} },
    }),
    {
      schema: "preset-snapshot/v1",
      profile: { id: "baseline", completionGateIds: [], closeoutOverrides: { consent: false } },
      completion: { sources: {}, gates: {}, closeoutDefaults: {} },
    },
  );
});

test("historical projection normalizes each registered retired field without changing claims", () => {
  const task = normalizeHistoricalEvent(
      envelope("task-event/v1", { task: { closeoutOverrides: { fact: false, review: true } } }, "task-normalize"),
    ) as unknown as { readonly payload: { readonly task: { readonly closeoutOverrides?: unknown } } },
    schedule = normalizeHistoricalEvent(
      envelope(
        "schedule-event/v1",
        { schedule: { status: { ciObserve: { workflow: "retired" }, missedCount: 0 } } },
        "schedule-normalize",
      ),
    ) as unknown as { readonly payload: { readonly schedule: { readonly status: Record<string, unknown> } } },
    settings = normalizeHistoricalEvent(
      envelope(
        "settings-event/v1",
        {
          settings: {
            ci: { workflows: ["retired"] },
            gates: [{ adapter: "manual-attest" }],
            review: { thresholds: { correctness: 80, migration: 85, securityAuth: 90 } },
          },
        },
        "settings-normalize",
      ),
    ) as unknown as { readonly payload: { readonly settings: Record<string, unknown> } },
    vertical = normalizeHistoricalEvent(
      envelope(
        "vertical-declaration-event/v1",
        {
          declaration: {
            definition: {
              completion: { sources: { ci: { kind: "github-actions" } }, gates: { ci: { source: "ci" } } },
            },
          },
        },
        "vertical-normalize",
      ),
    ) as unknown as { readonly payload: { readonly declaration: { readonly definition: Record<string, unknown> } } },
    squad = normalizeHistoricalEvent(
      envelope(
        "agent-runtime-event/v1",
        {
          squadRun: {
            squadRunId: "squad_0123456789abcdef01234567",
            squadId: "review",
            taskId: "task-old",
            executionId: "execution-old",
            mission: "Review",
            leaderAgentId: "leader",
          },
        },
        "squad-normalize",
      ),
    ) as unknown as { readonly payload: { readonly squadRun: Record<string, unknown> } };
  assert.deepEqual(task.payload.task.closeoutOverrides, { review: true });
  assert.deepEqual(schedule.payload.schedule.status, { missedCount: 0 });
  assert.deepEqual(settings.payload.settings, { gates: [{ adapter: "manual-attest" }] });
  assert.deepEqual((vertical.payload.declaration.definition.completion as Record<string, unknown>).sources, {});
  assert.deepEqual(squad.payload.squadRun.subject, {
    kind: "task",
    taskId: "task-old",
    executionId: "execution-old",
  });
  assert.equal(Object.hasOwn(squad.payload.squadRun, "taskId"), false);
  assert.deepEqual(
    normalizeHistoricalVerticalDocument({
      schema: "repository-vertical-declaration/v1",
      definition: { completion: { sources: { ci: { kind: "github-actions" } }, gates: { ci: { source: "ci" } } } },
    }),
    { schema: "repository-vertical-declaration/v1", definition: { completion: { sources: {}, gates: {} } } },
  );
  assert.deepEqual(
    normalizeHistoricalPresetSnapshot({
      schema: "preset-snapshot/v1",
      completion: {
        sources: { ci: { kind: "github-actions" }, manual: { kind: "manual" } },
        gates: { ci: { source: "ci" }, manual: { source: "manual" } },
      },
    }),
    {
      schema: "preset-snapshot/v1",
      completion: { sources: { manual: { kind: "manual" } }, gates: { manual: { source: "manual" } } },
    },
  );
});

test("the retired code/doc closeout default never makes an accepted declaration unreadable", () => {
  // Accepted `vertical.json`, every ledger preset snapshot and the bundled 1.4.0 vertical still
  // name `closeoutDefaults.codeDoc`; removing the field from the schema must normalize it away.
  const legacy = {
    schema: "preset-snapshot/v1",
    completion: { sources: {}, gates: {}, closeoutDefaults: { review: false, codeDoc: true } },
  };
  assert.deepEqual(normalizeHistoricalPresetSnapshot(legacy), {
    schema: "preset-snapshot/v1",
    completion: { sources: {}, gates: {}, closeoutDefaults: { review: false } },
  });
  const declaration = {
    schema: "repository-vertical-declaration/v1",
    definition: { completion: { sources: {}, gates: {}, closeoutDefaults: { codeDoc: true } } },
  };
  assert.deepEqual(normalizeHistoricalVerticalDocument(declaration), {
    schema: "repository-vertical-declaration/v1",
    definition: { completion: { sources: {}, gates: {}, closeoutDefaults: {} } },
  });
  // A record without the retired field is returned unchanged, so normalization stays a no-op.
  const current = { schema: "preset-snapshot/v1", completion: { sources: {}, gates: {}, closeoutDefaults: {} } };
  assert.equal(normalizeHistoricalPresetSnapshot(current), current);
});

// The doc-claim change rewrote which policy a *new* write chooses at a binary-claiming artifact name.
// It did not retire the opaque textual policy, so no attach step belongs in the registry. This test
// pins the two properties that make that true, so the day either stops holding the "no step needed"
// conclusion fails here instead of being discovered by a cold replay.
test("the opaque textual artifact policy is live, not retired, so doc claims need no attach step", () => {
  assert.deepEqual(
    retiredPersistedSchemaFields.filter((field) => /artifact|policy/i.test(field)),
    [],
  );
  const artifactPath = "tasks/task_legacy/artifacts/review/test.pdf",
    classification = classifyTextualArtifactPath(artifactPath);
  assert.equal(classification?.policyId, OPAQUE_TEXTUAL_POLICY_ID);
  const historicalChange = {
    path: artifactPath,
    baseBlobSha256: null,
    candidate: { sha256: "a".repeat(64), size: 873, mediaType: OPAQUE_TEXTUAL_MEDIA_TYPE },
    policyId: OPAQUE_TEXTUAL_POLICY_ID,
    regionProofs: [],
  };
  assert.equal(validDocEventChange(historicalChange, true), true);
});

// The invariant the registry's "no step" conclusion actually rests on is not "every persisted row
// decodes" — the old write boundary classified by path, so a persisted opaque row can carry a NUL
// byte that today's byte judgment calls non-textual. It is "the policy is read from the row, and the
// validator still admits it": this test forges exactly such a row and drives the real read/write
// judgment over it.
test("a persisted opaque row whose bytes now read as non-textual still reads and edits under its policy", () => {
  const artifactPath = "tasks/task_legacy/artifacts/notes/report.txt",
    nulBytes = Buffer.from([0x72, 0x65, 0x70, 0x6f, 0x72, 0x74, 0x00, 0x0a]),
    editedBytes = Buffer.from([0x72, 0x65, 0x70, 0x6f, 0x72, 0x74, 0x00, 0x0a, 0x21, 0x0a]),
    persistedPolicyId = OPAQUE_TEXTUAL_POLICY_ID,
    byteVerdict = classifyDocCandidate(artifactPath, nulBytes);
  // 1. The byte judgment alone would refuse this row; the persisted policy keeps it textual.
  assert.equal(byteVerdict, null);
  assert.deepEqual(effectiveDocCandidateClassification(artifactPath, byteVerdict, persistedPolicyId), {
    kind: "opaque-textual",
    mediaType: "text/plain",
    policyId: OPAQUE_TEXTUAL_POLICY_ID,
  });
  // A raw-artifact row is not rescued by the path judgment: bytes decide those.
  assert.equal(effectiveDocCandidateClassification(artifactPath, byteVerdict, RAW_ARTIFACT_POLICY_ID), null);
  // 2. The validator still admits an edit of that row under the policy it was written with.
  assert.equal(
    validDocEventChange(
      {
        path: artifactPath,
        baseBlobSha256: "b".repeat(64),
        candidate: { sha256: "c".repeat(64), size: editedBytes.byteLength, mediaType: OPAQUE_TEXTUAL_MEDIA_TYPE },
        policyId: persistedPolicyId,
        regionProofs: [],
      },
      true,
    ),
    true,
  );
});
