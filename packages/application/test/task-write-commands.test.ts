// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  createTaskEvent,
  reduceTaskEvent,
  sha256Text,
  type CanonicalEventStore,
  type CanonicalEventV1,
  type LeaseV1,
  type TaskLifecycleSnapshot,
  type TaskProjection,
  type TaskV2,
} from "@harness-anything/kernel";
import {
  selectTaskCreateProfile,
  taskDecisionTarget,
  type TaskCreateAdmissionCell,
  type TaskCreateProfileCandidate,
} from "../src/commands/task-create-admission.ts";
import { archiveCandidateIds, withRetiredTaskClass } from "../src/commands/task-maintenance-selection.ts";
import {
  taskMutation,
  type TaskLiveDispatchEntry,
  type TaskMutationCommandCell,
} from "../src/commands/task-mutation.ts";
import { compileTaskMutationWrite } from "../src/commands/task-mutation-write.ts";
import { appendProgress, type TaskProgressCommandCell } from "../src/commands/task-progress-append.ts";

const owner = { principal: { personId: "person_owner" }, executor: null } as const;
const other = { principal: { personId: "person_other" }, executor: null } as const;
const allowedDecision = {
  outcome: "allowed" as const,
  policyEpoch: 1,
  reason: "unit-test",
  evaluatedAt: "2026-11-25T00:00:00.000Z",
};
const binding = { actor: owner, source: "local" as const, authorizationDecision: allowedDecision };

class CodedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function cellCodedError(code: string, message: string): Error {
  return new CodedError(code, message);
}

function requiredCellText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw cellCodedError("invalid_command", `${name} is required.`);
  return value.trim();
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof CodedError && error.code === code);
}

function sampleTask(overrides: Partial<TaskV2> = {}): TaskV2 {
  return {
    schema: "task/v2",
    taskId: "task_alpha",
    title: "Initial title",
    status: "planned",
    taskClass: "standard",
    graph: {
      template: "replay/v1",
      nodes: [
        { id: "implementation", kind: "work" },
        { id: "review", kind: "review" },
      ],
      edges: [
        {
          id: "implementation-submitted",
          from: "implementation",
          to: "review",
          on: "submitted",
          actorRole: "executor",
          kind: "forward",
        },
        {
          id: "review-changes-requested",
          from: "review",
          to: "implementation",
          on: "changes_requested",
          actorRole: "reviewer",
          kind: "return",
        },
      ],
    },
    currentNode: "implementation",
    createdBy: owner,
    iteration: 0,
    contractVersion: 1,
    packageDisposition: "active",
    presetSnapshotDigest: `sha256:${"a".repeat(64)}`,
    completionGateIds: [],
    pinned: false,
    metadata: {
      idempotencyKey: null,
      parentTaskId: null,
      workKind: "feat",
      riskTier: "medium",
      urgency: "medium",
      verticalId: "software/coding",
      presetId: "standard-task",
      profileId: "baseline",
      moduleKey: null,
      slug: "alpha",
      surfaces: [],
      fromLegacyId: null,
    },
    ...overrides,
  };
}

function sampleSnapshot(task: TaskV2, overrides: Partial<TaskLifecycleSnapshot> = {}): TaskLifecycleSnapshot {
  return {
    task,
    revision: 1,
    lease: null,
    executions: [],
    reviews: [],
    consents: [],
    ...overrides,
  } as TaskLifecycleSnapshot;
}

function mutationCell(
  options: {
    readonly tasks?: ReadonlyMap<string, TaskV2>;
    readonly events?: ReadonlyMap<string, CanonicalEventV1>;
    readonly liveDispatches?: readonly TaskLiveDispatchEntry[];
    readonly dispatchSettled?: boolean;
  } = {},
): TaskMutationCommandCell {
  const tasks = options.tasks ?? new Map<string, TaskV2>();
  const events = options.events ?? new Map<string, CanonicalEventV1>();
  return {
    cellCodedError,
    requiredCellText,
    store: {
      readEvent: (opId: string) => events.get(opId) ?? null,
    },
    projection: {
      read: (taskId: string) =>
        ({
          status: "ready",
          snapshot: sampleSnapshot(tasks.get(taskId) ?? sampleTask({ taskId })),
          packagePath: `tasks/${taskId}`,
          watermark: 1,
          sourceRevision: 1,
          warnings: [],
        }) as ReturnType<TaskProjection["read"]>,
      readRuntimeDispatch: () => null,
      readDispatchLifecycle: ({ dispatchIds }) =>
        ({
          status: "ready",
          rows: (dispatchIds ?? []).map((dispatchId) => ({
            attempt: { dispatchId },
            policy: { groupSettled: options.dispatchSettled ?? false },
          })),
        }) as unknown as ReturnType<TaskProjection["readDispatchLifecycle"]>,
    },
    projectedTaskIds: () => new Set(tasks.keys()),
    readDispatchLiveEntries: () => options.liveDispatches ?? [],
  };
}

test("taskCreateAdmission selects lightweight for low-risk non-fix and validates decisions", () => {
  const decisions = new Map<string, { state: string; chosen: readonly { id: string }[] }>([
    ["dec_active", { state: "in_effect", chosen: [{ id: "CH1" }, { id: "CH2" }] }],
    ["dec_draft", { state: "proposed", chosen: [{ id: "CH1" }] }],
  ]);
  const cell: TaskCreateAdmissionCell = {
    cellCodedError,
    projection: {
      readDecision: (id: string) =>
        ({ decision: decisions.get(id) ?? null }) as unknown as ReturnType<TaskProjection["readDecision"]>,
    },
  };

  const compiledProfiles: (string | undefined)[] = [];
  const candidate = (profileId: string, nonLightweight: string | null = "baseline"): TaskCreateProfileCandidate => ({
    lightweightPresetIds: ["standard-task"],
    defaultNonLightweightProfileId: nonLightweight,
    snapshot: { identity: { id: "standard-task" }, profile: { id: profileId } },
  });

  const lowRisk = selectTaskCreateProfile(cell, { kind: "task-create", riskTier: "low", workKind: "feat" }, (p) => {
    compiledProfiles.push(p);
    return candidate(p ?? "baseline");
  });
  assert.equal(lowRisk.snapshot.profile.id, "lightweight");
  assert.deepEqual(compiledProfiles, [undefined, "lightweight"]);

  const lowFix = selectTaskCreateProfile(cell, { kind: "task-create", riskTier: "low", workKind: "fix" }, (p) =>
    candidate(p ?? "baseline"),
  );
  assert.equal(lowFix.snapshot.profile.id, "baseline");

  const mediumFromLightweight = selectTaskCreateProfile(cell, { kind: "task-create", riskTier: "medium" }, (p) =>
    candidate(p ?? "lightweight", "baseline"),
  );
  assert.equal(mediumFromLightweight.snapshot.profile.id, "baseline");

  expectCode(
    () =>
      selectTaskCreateProfile(cell, { kind: "task-create", riskTier: "high" }, () => candidate("lightweight", null)),
    "invalid_field",
  );

  assert.equal(taskDecisionTarget(cell, { kind: "task-create", taskClass: "standard" }), null);
  assert.equal(taskDecisionTarget(cell, { kind: "task-create", taskClass: "work", createMode: "import" }), null);
  expectCode(() => taskDecisionTarget(cell, { kind: "task-create", taskClass: "work" }), "decision_required");
  expectCode(() => taskDecisionTarget(cell, { kind: "task-create", decisionRef: "bad-ref" }), "invalid_field");
  expectCode(() => taskDecisionTarget(cell, { kind: "task-create", decisionRef: "dec_missing" }), "decision_not_found");
  expectCode(
    () => taskDecisionTarget(cell, { kind: "task-create", decisionRef: "dec_draft" }),
    "decision_not_in_effect",
  );
  expectCode(
    () => taskDecisionTarget(cell, { kind: "task-create", decisionRef: "dec_active/CH9" }),
    "decision_clause_not_found",
  );
  assert.equal(
    taskDecisionTarget(cell, { kind: "task-create", decisionRef: "dec_active/CH2" }),
    "decision/dec_active/CH2",
  );
});

test("taskMutation enforces parent cycles, active leases, dispositions, supersede dispatches, and releases", () => {
  const rootTask = sampleTask({ taskId: "task_root" });
  const childTask = sampleTask({
    taskId: "task_child",
    metadata: { ...rootTask.metadata!, parentTaskId: "task_root" },
  });
  const tasks = new Map<string, TaskV2>([
    ["task_root", rootTask],
    ["task_child", childTask],
  ]);

  const amended = taskMutation(
    mutationCell({ tasks }),
    {
      kind: "task-amend",
      taskId: "task_root",
      patches: [
        { field: "title", value: "Renamed" },
        { field: "urgency", value: "high" },
        { field: "surfaces", value: '["packages/application/**"]' },
      ],
    },
    rootTask,
    sampleSnapshot(rootTask),
    binding,
  );
  assert.equal(amended.type, "task_amended");
  assert.equal(amended.task.title, "Renamed");
  assert.equal(amended.task.metadata?.urgency, "high");
  assert.deepEqual(amended.task.metadata?.surfaces, ["packages/application/**"]);

  // Parent cycle is rejected at write boundary.
  expectCode(
    () =>
      taskMutation(
        mutationCell({ tasks }),
        { kind: "task-amend", taskId: "task_root", patches: [{ field: "parentTaskId", value: "task_child" }] },
        rootTask,
        sampleSnapshot(rootTask),
        binding,
      ),
    "parent_cycle",
  );

  // Active held lease blocks title amend but allows pure parentTaskId reparenting.
  const activeLease: LeaseV1 = {
    schema: "lease/v1",
    taskId: "task_child",
    executionId: "exe_1",
    actor: owner,
    source: "local",
    version: 1,
    phase: "held",
    expiresAt: "2026-11-25T01:00:00.000Z",
    ttlMs: 3_600_000,
  };
  expectCode(
    () =>
      taskMutation(
        mutationCell({ tasks }),
        { kind: "task-amend", taskId: "task_child", patches: [{ field: "title", value: "Blocked" }] },
        childTask,
        sampleSnapshot(childTask, { lease: activeLease }),
        binding,
      ),
    "active_lease",
  );
  const reparented = taskMutation(
    mutationCell({ tasks }),
    { kind: "task-amend", taskId: "task_child", patches: [{ field: "parentTaskId", value: "task_root" }] },
    childTask,
    sampleSnapshot(childTask, { lease: activeLease }),
    binding,
  );
  assert.equal(reparented.type, "task_amended");

  // Archive, reopen, terminal reopen refusal, soft delete vs hard delete refusal.
  const archived = taskMutation(
    mutationCell({ tasks }),
    { kind: "task-archive", taskId: "task_root", reason: "done cleanup" },
    rootTask,
    sampleSnapshot(rootTask),
    binding,
  );
  assert.equal(archived.task.packageDisposition, "archived");
  const reopened = taskMutation(
    mutationCell({ tasks }),
    { kind: "task-reopen", taskId: "task_root", reason: "resume" },
    archived.task,
    sampleSnapshot(archived.task),
    binding,
  );
  assert.equal(reopened.task.packageDisposition, "active");
  expectCode(
    () =>
      taskMutation(
        mutationCell({ tasks }),
        { kind: "task-reopen", taskId: "task_root", reason: "resume" },
        { ...archived.task, status: "done" },
        sampleSnapshot({ ...archived.task, status: "done" }),
        binding,
      ),
    "terminal_reopen_requires_supersede",
  );
  expectCode(
    () =>
      taskMutation(
        mutationCell({ tasks }),
        { kind: "task-delete", taskId: "task_root", mode: "hard", reason: "nope" },
        rootTask,
        sampleSnapshot(rootTask),
        binding,
      ),
    "hard_delete_forbidden",
  );
  const softDeleted = taskMutation(
    mutationCell({ tasks }),
    { kind: "task-delete", taskId: "task_root", mode: "soft", reason: "duplicate" },
    rootTask,
    sampleSnapshot(rootTask),
    binding,
  );
  assert.equal(softDeleted.task.packageDisposition, "tombstoned");

  // Supersede waits for unsettled live dispatches and succeeds once settled.
  expectCode(
    () =>
      taskMutation(
        mutationCell({
          tasks,
          liveDispatches: [{ dispatchId: "dispatch_1", runtimeSessionId: "runtime_1" }],
          dispatchSettled: false,
        }),
        { kind: "task-supersede", oldTaskId: "task_root", byTaskId: "task_child", confirm: "task_root" },
        rootTask,
        sampleSnapshot(rootTask),
        binding,
      ),
    "unsettled_dispatch",
  );
  const superseded = taskMutation(
    mutationCell({
      tasks,
      liveDispatches: [{ dispatchId: "dispatch_1", runtimeSessionId: "runtime_1" }],
      dispatchSettled: true,
    }),
    { kind: "task-supersede", oldTaskId: "task_root", byTaskId: "task_child", confirm: "task_root" },
    rootTask,
    sampleSnapshot(rootTask),
    binding,
  );
  assert.equal(superseded.type, "task_superseded");
  assert.equal(superseded.task.supersededBy, "task_child");

  // Release requires authorization and matching holder.
  expectCode(
    () =>
      taskMutation(
        mutationCell({ tasks }),
        { kind: "task-release", taskId: "task_child" },
        childTask,
        sampleSnapshot(childTask, { lease: activeLease }),
        { actor: owner, source: "local" },
      ),
    "authorization_missing",
  );
  expectCode(
    () =>
      taskMutation(
        mutationCell({ tasks }),
        { kind: "task-release", taskId: "task_child" },
        childTask,
        sampleSnapshot(childTask, { lease: activeLease }),
        { actor: other, source: "local", authorizationDecision: allowedDecision },
      ),
    "lease_conflict",
  );
  const released = taskMutation(
    mutationCell({ tasks }),
    { kind: "task-release", taskId: "task_child", reason: "handoff complete" },
    childTask,
    sampleSnapshot(childTask, { lease: activeLease }),
    binding,
  );
  assert.equal(released.type, "lease_released");
  assert.equal(released.releasedLease?.executionId, "exe_1");
});

test("compileTaskMutationWrite compiles canonical event, plan and lifecycle document reads", () => {
  const task = sampleTask();
  const snapshot = sampleSnapshot(task);
  const mutation = taskMutation(
    mutationCell({ tasks: new Map([[task.taskId, task]]) }),
    { kind: "task-amend", taskId: task.taskId, patches: [{ field: "title", value: "Updated via write compiler" }] },
    task,
    snapshot,
    binding,
  );
  const fetchedPaths: string[] = [];
  const compiled = compileTaskMutationWrite({
    taskId: task.taskId,
    packagePath: "tasks/task_alpha",
    snapshot,
    mutation,
    binding,
    opId: "op-amend-1",
    workspaceRevision: 2,
    occurredAt: "2026-11-25T00:05:00.000Z",
    readDocument: (target) => {
      fetchedPaths.push(target);
      return target.endsWith("task_plan.md")
        ? { path: target, body: "# Initial title\n", blobSha256: sha256Text("# Initial title\n") }
        : null;
    },
    completionContext: () => undefined,
  });
  assert.equal(compiled.event.type, "task_amended");
  assert.equal(compiled.event.opId, "op-amend-1");
  assert.equal(compiled.event.workspaceRevision, 2);
  assert.ok(fetchedPaths.some((p) => p.endsWith("task_plan.md")));
  const reduced = reduceTaskEvent(snapshot, compiled.event);
  assert.equal(reduced.task?.title, "Updated via write compiler");
});

test("appendProgress appends, replays idempotently, rejects conflicts, and carries documents", () => {
  const workTask = sampleTask({ taskId: "task_work", taskClass: "work" });
  const events = new Map<string, CanonicalEventV1>();
  let appliedCount = 0;
  let headRevision = 1;
  const makeCell = (lagging = false): TaskProgressCommandCell => ({
    input: { repoId: "repo-1" },
    cellCodedError,
    requiredCellText,
    now: () => "2026-11-25T00:10:00.000Z",
    operationId: (action) => String(action.opKey ?? "op-progress-1"),
    publicPublication: (value) => ({ commitSha: value.commitSha, cut: value.cut }),
    progressReceipt: (event, publication) => ({
      outcome: "applied",
      opId: event.opId,
      revision: event.workspaceRevision,
      evidence: `event:${event.opId}`,
      visibility: "center",
      proof: {
        committedRevision: event.workspaceRevision,
        appliedCut: event.workspaceRevision,
        durable: true,
        canonicalVisible: true,
        worktreeVisible: true,
      },
      ...publication,
    }),
    store: {
      readEvent: (opId: string) => events.get(opId) ?? null,
      readHead: () => ({ revision: headRevision, opId: "op-seed", eventDigest: `sha256:${"0".repeat(64)}` }),
      publication: (event: CanonicalEventV1) => ({
        commitSha: null,
        cut: {
          repoId: "repo-1",
          revision: event.workspaceRevision,
          opId: event.opId,
          headDigest: `sha256:${"1".repeat(64)}`,
        },
      }),
      append: (bundle: { readonly event: CanonicalEventV1 }) => {
        events.set(bundle.event.opId, bundle.event);
        headRevision = bundle.event.workspaceRevision;
        return {
          status: "applied",
          revision: bundle.event.workspaceRevision,
          commitSha: null,
          cut: {
            repoId: "repo-1",
            revision: bundle.event.workspaceRevision,
            opId: bundle.event.opId,
            headDigest: `sha256:${"1".repeat(64)}`,
          },
        };
      },
    } as unknown as CanonicalEventStore,
    projection: {
      read: () =>
        ({
          status: lagging ? "pending" : "ready",
          snapshot: sampleSnapshot(workTask),
          packagePath: "tasks/task_work-work",
          watermark: lagging ? 0 : headRevision,
          sourceRevision: headRevision,
          warnings: [],
        }) as ReturnType<TaskProjection["read"]>,
      currentLease: () => null,
      readRuntimeSession: () => null,
      readDocument: (target: string) =>
        ({
          status: "ready",
          watermark: headRevision,
          sourceRevision: headRevision,
          document: { path: target, body: "# Progress\n", blobSha256: sha256Text("# Progress\n") },
        }) as unknown as ReturnType<TaskProjection["readDocument"]>,
      apply: () => {
        appliedCount += 1;
        return { metrics: { storeTransactions: 1, reducedItems: 1 } };
      },
    } as unknown as TaskProjection,
  });

  expectCode(
    () => appendProgress(makeCell(true), { kind: "task-progress-append", taskId: "task_work", text: "wait" }, binding),
    "content_not_ready",
  );
  expectCode(
    () =>
      appendProgress(
        makeCell(),
        { kind: "task-progress-append", taskId: "task_work", text: "bad", evidence: "not-a-list" },
        binding,
      ),
    "invalid_progress",
  );

  const cell = makeCell();
  const first = appendProgress(
    cell,
    {
      kind: "task-progress-append",
      taskId: "task_work",
      text: "First update",
      evidence: [{ type: "log", path: "artifacts/check.log", summary: "passed" }],
    },
    binding,
  );
  assert.equal(first.outcome, "applied");
  assert.equal(first.revision, 2);
  assert.equal(appliedCount, 1);

  // Replaying the exact same opId returns the existing receipt without appending again.
  const replayed = appendProgress(
    cell,
    { kind: "task-progress-append", taskId: "task_work", text: "First update" },
    binding,
  );
  assert.equal(replayed.revision, 2);
  assert.equal(appliedCount, 1);

  // Replaying with different carried documents raises op_conflict.
  expectCode(
    () =>
      appendProgress(cell, { kind: "task-progress-append", taskId: "task_work", text: "First update" }, binding, {
        changes: [
          {
            path: "tasks/task_work-work/notes.md",
            baseBlobSha256: null,
            policyId: "opaque-textual-whole-file/v1",
            candidate: { sha256: sha256Text("hi"), size: 2, mediaType: "text/markdown" },
            regionProofs: [],
          },
        ],
        blobs: [{ sha256: sha256Text("hi"), size: 2, mediaType: "text/markdown", body: "hi" }],
      }),
    "op_conflict",
  );

  // Existing non-progress event with the same opId raises op_conflict.
  events.set(
    "op-non-progress",
    createTaskEvent(
      {
        eventId: "event-other",
        workspaceRevision: 3,
        opId: "op-non-progress",
        taskId: "task_work",
        actor: owner,
        source: "local",
        occurredAt: "2026-11-25T00:11:00.000Z",
      },
      "task_amended",
      { task: workTask, mutation: { command: "amend", reason: "x", fields: ["title"] } },
    ),
  );
  expectCode(
    () =>
      appendProgress(
        cell,
        { kind: "task-progress-append", opKey: "op-non-progress", taskId: "task_work", text: "collide" },
        binding,
      ),
    "op_conflict",
  );
});

test("taskMaintenanceSelection filters archive candidates by state/before and restates retired classes", () => {
  const queries: unknown[] = [];
  const ids = archiveCandidateIds(
    {
      cellCodedError,
      projection: {
        readTaskIndex: (query) => {
          queries.push(query);
          return {
            rows: [
              { taskId: "task_old", updatedAt: "2026-10-01T00:00:00.000Z" },
              { taskId: "task_new", updatedAt: "2026-11-20T00:00:00.000Z" },
            ],
          } as ReturnType<TaskProjection["readTaskIndex"]>;
        },
      },
    },
    { kind: "task-archive", filter: "state:done", before: "2026-11-01T00:00:00.000Z" },
  );
  assert.deepEqual(queries, [{ status: "done" }]);
  assert.deepEqual(ids, ["task_old"]);

  expectCode(
    () =>
      archiveCandidateIds(
        {
          cellCodedError,
          projection: {
            readTaskIndex: () => ({ rows: [] }) as unknown as ReturnType<TaskProjection["readTaskIndex"]>,
          },
        },
        { kind: "task-archive", before: "not-a-date" },
      ),
    "invalid_command",
  );

  const retiredCell = {
    projection: {
      read: (taskId: string) =>
        ({
          snapshot: { task: { taskClass: taskId === "task_legacy" ? "milestone" : "standard" } },
        }) as unknown as ReturnType<TaskProjection["read"]>,
    },
  };
  const restated = withRetiredTaskClass(retiredCell, "task_legacy", { taskId: "task_legacy", status: "current" });
  assert.equal(restated.status, "repair");
  assert.equal(restated.taskClassBefore, "milestone");
  assert.equal(restated.taskClassAfter, "work");
  assert.equal(
    withRetiredTaskClass(retiredCell, "task_legacy", { taskId: "task_legacy", status: "manual" }).status,
    "manual",
  );
  assert.equal(
    withRetiredTaskClass(retiredCell, "task_normal", { taskId: "task_normal", status: "current" }).status,
    "current",
  );
});
