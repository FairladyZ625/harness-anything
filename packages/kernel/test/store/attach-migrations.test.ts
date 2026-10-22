// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { applyAttachMigrations, attachMigrationRegistry } from "../../src/store/attach-migrations.ts";
import { retiredPersistedSchemaFields } from "../../src/domain/event-shape-migration-event.ts";
import {
  normalizeHistoricalEvent,
  normalizeHistoricalPresetSnapshot,
  normalizeHistoricalVerticalDocument,
} from "../../src/projection/historical-event-normalization.ts";
import type { CanonicalEventStore } from "../../src/store/task-event-store-types.ts";
import type { PersistedCanonicalEventV1 } from "../../src/domain/doc-sync-types.ts";

function fakeStore(initial: readonly PersistedCanonicalEventV1[]) {
  const events = [...initial];
  const store = {
    read: () => ({ schema: "canonical-event-stream/v1" as const, revision: events.length, events }),
    readHead: () =>
      events.length === 0
        ? null
        : { revision: events.length, opId: events.at(-1)!.opId, eventDigest: "sha256:" + "0".repeat(64) },
    append: ({ event }: { event: PersistedCanonicalEventV1 }) => {
      events.push(event);
      return {};
    },
    queryEvents: ({ limit }: { readonly limit: number }) => events.slice(0, limit),
  } as unknown as CanonicalEventStore;
  return { store, events };
}

const actor = { principal: { personId: "fixture" }, executor: null } as const;
const envelope = (schema: string, payload: unknown, opId: string): PersistedCanonicalEventV1 =>
  ({
    schema,
    eventId: `event-${opId}`,
    workspaceRevision: 1,
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
    attachMigrationRegistry.map(({ name }) => name),
    [
      "closeout-overrides.fact",
      "schedule.ciObserve",
      "squad-run.subject",
      "settings.ci",
      "runtime.reviewDispatchKey",
      "vertical.completion.sources",
    ],
  );
  assert.deepEqual(
    attachMigrationRegistry.flatMap(({ fields }) => fields).sort(),
    [...retiredPersistedSchemaFields].sort(),
  );
  const { store, events } = fakeStore([
    envelope("task-event/v1", { task: { closeoutOverrides: { fact: false } } }, "old-task"),
    envelope("schedule-event/v1", { schedule: { status: { ciObserve: { workflow: "retired" } } } }, "old-schedule"),
    envelope(
      "agent-runtime-event/v1",
      { squadRun: { squadRunId: "squad_0123456789abcdef01234567", taskId: "task-old", executionId: "execution-old" } },
      "old-squad-dispatch",
    ),
    envelope("settings-event/v1", { settings: { ci: { workflows: ["rewrite-ci"] } } }, "old-settings"),
    envelope(
      "vertical-declaration-event/v1",
      { declaration: { definition: { completion: { sources: { ci: { kind: "github-actions" } } } } } },
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
    "schedule.ciObserve",
    "squad-run.subject",
    "settings.ci",
    "runtime.reviewDispatchKey",
    "vertical.completion.sources",
  ]);
  assert.equal(events.length, 12);
  const second = applyAttachMigrations({ store, now: () => "2026-10-20T00:00:02.000Z" });
  assert.deepEqual(second.applied, []);
  assert.equal(events.length, 12);
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
  assert.equal(normalizeHistoricalEvent(pathLane), pathLane);
});

test("attach notices a retired source embedded in a task preset snapshot blob", () => {
  const events = [
      envelope("task-bootstrap-event/v1", { presetSnapshotClaim: { sha256: "snapshot-blob" } }, "old-task"),
    ] as PersistedCanonicalEventV1[],
    store = {
      readHead: () => ({ revision: events.length, opId: events.at(-1)!.opId, eventDigest: "sha256:" + "0".repeat(64) }),
      queryEvents: ({ limit }: { readonly limit: number }) => events.slice(0, limit),
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
        { settings: { ci: { workflows: ["retired"] }, gates: [{ adapter: "manual-attest" }] } },
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
