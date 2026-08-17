// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection, readRelationGraphProjection, readTaskProjection, rebuildTaskProjection, REPLAY_TASK_GRAPH, taskLifecycleWritePlan, type TaskEventV1 } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

const actor = { principal: { personId: "person-surface" }, executor: null } as const;

test("task create publishes complete metadata and initial relations that survive cold rebuild", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-surface-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("task-surface"), rootDir: canonicalRoot(rootDir), ownerId: "task-surface-create", now: () => "2026-08-15T00:00:00.000Z" }); const binding = { actor, source: "local" as const };
    assert.equal((await cell.run({ kind: "task-create", taskId: "task_dependency", title: "Dependency" }, binding)).outcome, "applied");
    const created = await cell.run({ kind: "task-create", taskId: "task_surface", title: "Surface", idempotencyKey: "surface-once", parentTaskId: "task_dependency", workKind: "feat", riskTier: "high", urgency: "medium", verticalId: "software/coding", presetId: "standard-task", profileId: "baseline", moduleKey: "kernel", registerModule: { key: "kernel", title: "Kernel", prefix: "KER", scope: "packages/kernel/**" }, slug: "surface", surfaces: ["ha task create", "packages/kernel"], relations: [{ type: "depends-on", target: "task/task_dependency", rationale: "Dependency must land first" }], locale: "zh-CN" }, binding) as Record<string, unknown>;
    assert.equal(created.outcome, "applied", JSON.stringify(created)); assert.equal(created.packagePath, "tasks/task_surface-surface");
    const event = makeTaskEventStore({ repoId: "task-surface", rootDir }).read().events.find((candidate) => candidate.schema === "task-bootstrap-event/v1" && candidate.taskId === "task_surface"); assert.ok(event && event.schema === "task-bootstrap-event/v1");
    assert.deepEqual(event.payload.task.metadata, { idempotencyKey: "surface-once", parentTaskId: "task_dependency", workKind: "feat", riskTier: "high", urgency: "medium", verticalId: "software/coding", presetId: "standard-task", profileId: "baseline", moduleKey: "kernel", slug: "surface", surfaces: ["ha task create", "packages/kernel"], fromLegacyId: null });
    assert.equal(event.payload.task.relations?.[0]?.type, "depends-on");
    const index = readFileSync(path.join(rootDir, "harness/tasks/task_surface-surface/INDEX.md"), "utf8"), contract = JSON.parse(readFileSync(path.join(rootDir, "harness/tasks/task_surface-surface/task-contract.json"), "utf8")) as Record<string, unknown>;
    assert.match(index, /schema: task-package\/v2[\s\S]*task_id: task_surface[\s\S]*parent: task_dependency[\s\S]*packageDisposition: active[\s\S]*relations:[\s\S]*depends-on/u); assert.equal((contract.metadata as { moduleKey: string }).moduleKey, "kernel");
    rebuildTaskProjection({ rootDir }); const row = readTaskProjection({ rootDir }).rows.find((candidate) => candidate.taskId === "task_surface"), edge = readRelationGraphProjection({ rootDir }).edges.find((candidate) => candidate.sourceRef === "task/task_surface");
    assert.equal(row?.parentTaskId, "task_dependency"); assert.equal(row?.moduleKey, "kernel"); assert.equal(row?.riskTier, "high"); assert.equal(edge?.targetRef, "task/task_dependency");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("task lifecycle mutations publish L1 events, exact documents, and replayable dispositions", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-lifecycle-surface-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("task-lifecycle-surface"), rootDir: canonicalRoot(rootDir), ownerId: "task-lifecycle-surface", now: () => "2026-08-15T01:00:00.000Z" }); const binding = { actor, source: "local" as const };
    for (const [taskId, title] of [["task_lifecycle", "Lifecycle"], ["task_replacement", "Replacement"], ["task_reviewing", "Reviewing"]] as const) assert.equal((await cell.run({ kind: "task-create", taskId, title, profileId: "baseline" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-start", taskId: "task_lifecycle", executionId: "exe_surface", ttlMs: 60_000 }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-release", taskId: "task_lifecycle", reason: "Pause before changing scope" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-transition", taskId: "task_lifecycle", status: "blocked", reason: "Waiting on scope" }, binding)).outcome, "applied");
    const unblocked = await cell.run({ kind: "task-transition", taskId: "task_lifecycle", status: "active" }, binding);
    assert.equal(unblocked.outcome, "applied");
    const plannedActivation = await cell.run({ kind: "task-transition", taskId: "task_replacement", status: "active", reason: "Bypass task start" }, binding);
    assert.equal(plannedActivation.outcome, "rejected"); assert.equal(plannedActivation.code, "invalid_transition");
    assert.equal((await cell.run({ kind: "task-start", taskId: "task_reviewing", executionId: "exe_reviewing" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-submit", taskId: "task_reviewing", executionId: "exe_reviewing", submission: { completionClaim: "Status routing is ready for review.", deliverables: ["aggregate status route"], outputs: ["task lifecycle event"], verificationNotes: ["daemon integration"], knownGaps: [], residualRisks: [], commitSha: git(rootDir, "rev-parse", "HEAD") } }, binding)).outcome, "applied");
    const reviewActivation = await cell.run({ kind: "task-transition", taskId: "task_reviewing", status: "active", reason: "Bypass review outcome" }, binding);
    assert.equal(reviewActivation.outcome, "rejected"); assert.equal(reviewActivation.code, "invalid_transition");
    assert.equal((await cell.run({ kind: "task-transition", taskId: "task_lifecycle", status: "done", reason: "bypass" }, binding)).outcome, "rejected");
    assert.equal((await cell.run({ kind: "task-amend", taskId: "task_lifecycle", patches: [{ field: "title", value: "Lifecycle amended" }, { field: "riskTier", value: "high" }, { field: "moduleKey", value: "daemon" }, { field: "taskClass", value: "milestone" }] }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-amend", taskId: "task_lifecycle", patches: [{ field: "taskClass", value: "container" }] }, binding)).outcome, "rejected");
    const related = await cell.run({ kind: "task-relate", taskId: "task_lifecycle", target: "task/task_replacement", relationType: "depends-on", rationale: "Replacement establishes the new contract" }, binding); assert.equal(related.outcome, "applied", JSON.stringify(related));
    assert.equal((await cell.run({ kind: "task-archive", taskId: "task_lifecycle", reason: "Scope retired", archivedBy: "person-surface" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-reopen", taskId: "task_lifecycle", reason: "Scope restored" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-supersede", oldTaskId: "task_lifecycle", byTaskId: "task_replacement", confirm: "task_lifecycle" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-delete", taskId: "task_replacement", mode: "hard", confirm: "task_replacement", reason: "destructive" }, binding)).outcome, "rejected");
    assert.equal((await cell.run({ kind: "task-delete", taskId: "task_replacement", mode: "soft", reason: "Duplicate" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-reopen", taskId: "task_replacement", reason: "Not a duplicate" }, binding)).outcome, "applied");
    const taskRead = (await cell.run({ kind: "task-show", taskId: "task_lifecycle" }, binding)) as Record<string, unknown>, replacementRead = (await cell.run({ kind: "task-show", taskId: "task_replacement" }, binding)) as Record<string, unknown>;
    assert.match(String(taskRead.evidence), /"taskClass":"milestone"/u); assert.match(String(taskRead.evidence), /"packageDisposition":"archived"/u); assert.match(String(taskRead.evidence), /"supersededBy":"task_replacement"/u); assert.match(String(replacementRead.evidence), /"packageDisposition":"active"/u);
    const events = makeTaskEventStore({ repoId: "task-lifecycle-surface", rootDir }).read().events.filter((event) => event.schema === "task-event/v1").map((event) => event.type);
    for (const type of ["lease_released", "task_transitioned", "task_amended", "task_relation_added", "task_archived", "task_reopened", "task_superseded", "task_deleted"]) assert.ok(events.includes(type as never), `${type} missing from ${events.join(",")}`);
    rebuildTaskProjection({ rootDir }); const rows = readTaskProjection({ rootDir }).rows, lifecycle = rows.find((row) => row.taskId === "task_lifecycle"), replacement = rows.find((row) => row.taskId === "task_replacement"), edge = readRelationGraphProjection({ rootDir }).edges.find((row) => row.sourceRef === "task/task_lifecycle" && row.targetRef === "task/task_replacement");
    assert.equal(lifecycle?.title, "Lifecycle amended"); assert.equal(lifecycle?.riskTier, "high"); assert.equal(lifecycle?.moduleKey, "daemon"); assert.equal(lifecycle?.packageDisposition, "archived"); assert.equal(replacement?.packageDisposition, "active"); assert.equal(edge?.relationType, "depends-on");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("forced cancellation is audited and terminal tasks require supersede instead of reopen", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-terminal-surface-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("task-terminal-surface"), rootDir: canonicalRoot(rootDir), ownerId: "task-terminal-surface", now: () => "2026-08-15T02:00:00.000Z" }); const binding = { actor, source: "local" as const }; await cell.run({ kind: "task-create", taskId: "task_terminal", title: "Terminal", profileId: "baseline" }, binding);
    assert.equal((await cell.run({ kind: "task-transition", taskId: "task_terminal", status: "cancelled" }, binding)).outcome, "rejected"); assert.equal((await cell.run({ kind: "task-transition", taskId: "task_terminal", status: "cancelled", force: true, reason: "Audited cancellation after invalid scope" }, binding)).outcome, "applied"); await cell.run({ kind: "task-archive", taskId: "task_terminal", reason: "Retain cancellation audit" }, binding); const reopen = await cell.run({ kind: "task-reopen", taskId: "task_terminal", reason: "More work" }, binding); assert.equal(reopen.outcome, "rejected"); assert.match(String(reopen.nextAction), /supersede/u);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("aggregate-authored status events rebuild to the exact hot snapshot", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-status-replay-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("task-status-replay"), rootDir: canonicalRoot(rootDir), ownerId: "task-status-replay", now: () => "2026-08-15T02:15:00.000Z" }); const binding = { actor, source: "local" as const };
    assert.equal((await cell.run({ kind: "task-create", taskId: "task_status_replay", title: "Status replay" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-transition", taskId: "task_status_replay", status: "blocked", reason: "Waiting for a dependency" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-transition", taskId: "task_status_replay", status: "active" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-transition", taskId: "task_status_replay", status: "blocked", reason: "Dependency regressed" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-transition", taskId: "task_status_replay", status: "cancelled", force: true, reason: "Scope withdrawn" }, binding)).outcome, "applied");
    const hot = (await cell.read("repo.tasks.list")).rows.find((row) => row.taskId === "task_status_replay")?.snapshot;
    assert.ok(hot); await cell.close(); cell = undefined;
    const store = makeTaskEventStore({ repoId: "task-status-replay", rootDir }), replay = makeTaskProjection({ rootDir, eventStore: store });
    assert.deepEqual(store.read().events.filter((event) => event.schema === "task-event/v1").map((event) => event.type), ["task_transitioned", "task_transitioned", "task_transitioned", "task_transitioned"]);
    rmSync(replay.path, { force: true }); const rebuilt = replay.rebuild(), cold = replay.read("task_status_replay").snapshot;
    assert.equal(rebuilt.watermark, store.readHead()?.revision); assert.deepEqual(cold, hot);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("batch archive preflights every selected task before publishing any event", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-archive-preflight-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("task-archive-preflight"), rootDir: canonicalRoot(rootDir), ownerId: "task-archive-preflight", now: () => "2026-08-15T02:30:00.000Z" }); const binding = { actor, source: "local" as const }; await cell.run({ kind: "task-create", taskId: "task_archive_valid", title: "Archive valid" }, binding); const before = makeTaskEventStore({ repoId: "task-archive-preflight", rootDir }).read().events.length;
    const receipt = await cell.run({ kind: "task-archive", taskIds: ["task_archive_valid", "task_archive_missing"], reason: "Batch retirement" }, binding); assert.equal(receipt.outcome, "rejected"); assert.equal(makeTaskEventStore({ repoId: "task-archive-preflight", rootDir }).read().events.length, before); assert.match(String((await cell.run({ kind: "task-show", taskId: "task_archive_valid" }, binding)).evidence), /"packageDisposition":"active"/u);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("contract migration keeps incomplete legacy L1 tasks in the manual queue", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-contract-manual-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); const event: TaskEventV1 = { schema: "task-event/v1", eventId: "event-legacy", workspaceRevision: 1, opId: "op-legacy", taskId: "task_legacy_l1", type: "task_created", actor, source: "local", occurredAt: "2026-08-15T02:45:00.000Z", payload: { task: { schema: "task/v1", taskId: "task_legacy_l1", title: "Legacy L1", taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0, createdBy: actor, completionGateIds: [], presetSnapshotDigest: null } } }; makeTaskEventStore({ repoId: "task-contract-manual", rootDir }).append({ event, plan: taskLifecycleWritePlan(event), blobs: [] }); cell = await openRepoCell({ repoId: workspaceId("task-contract-manual"), rootDir: canonicalRoot(rootDir), ownerId: "task-contract-manual", now: () => "2026-08-15T02:45:00.000Z" }); const receipt = await cell.run({ kind: "task-contract-migrate", mode: "dry-run", taskId: "task_legacy_l1" }, { actor, source: "local" }); assert.equal(receipt.outcome, "applied"); assert.match(String(receipt.evidence), /"status":"manual"[\s\S]*"reason":"contract_metadata_incomplete"/u);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("task read surfaces, dry-runs, idempotency, structured input, and supersede facade stay closed", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-read-surface-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("task-read-surface"), rootDir: canonicalRoot(rootDir), ownerId: "task-read-surface", now: () => "2026-08-15T03:00:00.000Z" }); const binding = { actor, source: "local" as const };
    await cell.run({ kind: "task-create", taskId: "task_target", title: "Target", moduleKey: "kernel" }, binding); writeFileSync(path.join(rootDir, "task-input.json"), JSON.stringify({ title: "Searchable Surface", workKind: "fix", riskTier: "high", urgency: "medium", moduleKey: "daemon", surfaces: ["ha task list"] }));
    const created = await cell.run({ kind: "task-create", taskId: "task_source", idempotencyKey: "stable-create", fromFile: "task-input.json" }, binding) as Record<string, unknown>; assert.equal(created.outcome, "applied"); mkdirSync(path.join(rootDir, "harness/legacy/source"), { recursive: true }); writeFileSync(path.join(rootDir, "harness/legacy/source/old.md"), "# Legacy\n"); writeFileSync(path.join(rootDir, "harness/legacy/index.json"), JSON.stringify({ entries: [{ id: "legacy-1", title: "Legacy Rebuilt", storedPath: "harness/legacy/source/old.md" }] })); const legacy = await cell.run({ kind: "task-create", fromLegacyId: "legacy-1" }, binding) as Record<string, unknown>; assert.equal(legacy.outcome, "applied", JSON.stringify(legacy)); const eventCount = makeTaskEventStore({ repoId: "task-read-surface", rootDir }).read().events.length;
    const reused = await cell.run({ kind: "task-create", title: "Different retry title", idempotencyKey: "stable-create" }, binding) as Record<string, unknown>; assert.equal(reused.taskId, "task_source"); assert.match(String(reused.evidence), /"reused":true/u);
    const startPreview = await cell.run({ kind: "task-start", taskId: "task_source", ttlMs: 60_000, dryRun: true }, binding), relationPreview = await cell.run({ kind: "task-relate", taskId: "task_source", target: "task/task_target", relationType: "depends-on", rationale: "Preview only", dryRun: true }, binding); assert.equal(startPreview.outcome, "applied"); assert.equal(relationPreview.outcome, "applied"); assert.equal(makeTaskEventStore({ repoId: "task-read-surface", rootDir }).read().events.length, eventCount);
    await cell.run({ kind: "task-relate", taskId: "task_source", target: "task/task_target", relationType: "depends-on", rationale: "Required target" }, binding); assert.equal((await cell.run({ kind: "task-relate", taskId: "task_target", target: "task/task_source", relationType: "depends-on", rationale: "Would cycle" }, binding)).outcome, "rejected");
    const listed = evidence(await cell.run({ kind: "task-list", status: "planned", module: "daemon", search: "searchable" }, binding)), relations = evidence(await cell.run({ kind: "relation-list", entity: "task/task_source", relationType: "depends-on", state: "active" }, binding)), review = evidence(await cell.run({ kind: "task-review", taskId: "task_source", reviewerId: "reviewer" }, binding)), migration = evidence(await cell.run({ kind: "task-contract-migrate", mode: "dry-run", taskId: "task_source" }, binding)); assert.deepEqual((listed.rows as { taskId: string }[]).map((row) => row.taskId), ["task_source"]); assert.equal((relations.rows as unknown[]).length, 1); assert.equal(review.completionAuthority, false); assert.match(JSON.stringify(migration), /"status":"current"/u);
    const superseded = await cell.run({ kind: "task-supersede", oldTaskId: "task_source", title: "Replacement Surface", slug: "replacement-surface", reason: "Reframed scope" }, binding) as Record<string, unknown>; assert.equal(superseded.outcome, "applied", JSON.stringify(superseded)); assert.equal(typeof superseded.replacementTaskId, "string"); rebuildTaskProjection({ rootDir }); assert.equal(readTaskProjection({ rootDir }).rows.find((row) => row.taskId === "task_source")?.packageDisposition, "archived");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("a lapsed lease stays readable through task show and releasable through task release", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-lease-exit-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined; let clock = "2026-08-15T02:00:00.000Z";
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("task-lease-exit"), rootDir: canonicalRoot(rootDir), ownerId: "task-lease-exit", now: () => clock });
    const holder = { actor: { principal: { personId: "person-surface" }, executor: { kind: "agent" as const, id: "executor-departed" } }, source: "local" as const };
    const reclaimer = { actor: { principal: { personId: "person-surface" }, executor: { kind: "agent" as const, id: "executor-reclaimer" } }, source: "local" as const };
    assert.equal((await cell.run({ kind: "task-create", taskId: "task_lease", title: "Lease exit" }, holder)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-start", taskId: "task_lease", executionId: "exe_lapse", ttlMs: 60_000 }, holder)).outcome, "applied");
    const held = String((await cell.run({ kind: "task-show", taskId: "task_lease" }, reclaimer) as Record<string, unknown>).summary);
    assert.match(held, /\nlease: [^\n]*phase=active/u, held);
    assert.match(held, /\nlease: [^\n]*expiresAt=2026-08-15T02:01:00\.000Z/u, held);
    const earlyReclaim = await cell.run({ kind: "task-release", taskId: "task_lease", reason: "Holder is still active" }, reclaimer);
    assert.equal(earlyReclaim.outcome, "rejected", JSON.stringify(earlyReclaim));
    assert.equal((earlyReclaim as Record<string, unknown>).code, "lease_conflict", JSON.stringify(earlyReclaim));
    clock = "2026-08-15T03:00:00.000Z";
    const summary = String((await cell.run({ kind: "task-show", taskId: "task_lease" }, reclaimer) as Record<string, unknown>).summary);
    assert.match(summary, /\nlease: [^\n]*executionId=exe_lapse[^\n]*phase=orphaned/u, summary);
    assert.match(summary, /\nlease: [^\n]*expiresAt=2026-08-15T02:01:00\.000Z/u, summary);
    assert.match(summary, /\ntask: [^\n]*status=active[^\n]*/u, summary);
    assert.match(summary, /executions:\n[^\n]*\texe_lapse\t/u, summary);
    // The reporter's bite: the failed append must say when the lease lapsed and name the round to re-enter.
    const bite = await cell.run({ kind: "task-progress-append", taskId: "task_lease", text: "Append after the lease lapsed", evidence: [] }, reclaimer) as Record<string, unknown>;
    assert.equal(bite.outcome, "rejected", JSON.stringify(bite));
    assert.equal(bite.code, "progress_lease_required", JSON.stringify(bite));
    assert.match(String(bite.nextAction), /lapsed at 2026-08-15T02:01:00\.000Z/u, JSON.stringify(bite));
    assert.match(String(bite.nextAction), /ha task release task_lease, then re-enter the round with ha task start task_lease --execution-id exe_lapse/u, JSON.stringify(bite));
    const outsider = { actor: { principal: { personId: "person-outsider" }, executor: { kind: "agent" as const, id: "executor-outsider" } }, source: "local" as const };
    const crossPrincipal = await cell.run({ kind: "task-release", taskId: "task_lease", reason: "Different principal" }, outsider);
    assert.equal(crossPrincipal.outcome, "rejected", JSON.stringify(crossPrincipal));
    assert.equal((crossPrincipal as Record<string, unknown>).code, "lease_conflict", JSON.stringify(crossPrincipal));
    const released = await cell.run({ kind: "task-release", taskId: "task_lease", reason: "The holder never came back" }, reclaimer);
    assert.equal(released.outcome, "applied", JSON.stringify(released));
    assert.equal(evidence(await cell.run({ kind: "task-show", taskId: "task_lease" }, reclaimer)).lease, null);
    // The recovery the error prescribes must actually work: same execution re-leases the round, then the append lands.
    assert.equal((await cell.run({ kind: "task-start", taskId: "task_lease", executionId: "exe_lapse", ttlMs: 60_000 }, reclaimer)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-progress-append", taskId: "task_lease", text: "Re-entered after the lapse", evidence: [] }, reclaimer)).outcome, "applied");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("a released round is re-enterable by its own execution and still refuses a second one", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-round-reenter-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("task-round-reenter"), rootDir: canonicalRoot(rootDir), ownerId: "task-round-reenter", now: () => "2026-08-15T02:00:00.000Z" }); const binding = { actor, source: "local" as const };
    assert.equal((await cell.run({ kind: "task-create", taskId: "task_round", title: "Round re-entry" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-start", taskId: "task_round", executionId: "exe_round" }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-release", taskId: "task_round", reason: "Holder handed the round back" }, binding)).outcome, "applied");
    // Release ends the lease but not the round: the execution is still active, so a *second* execution stays refused.
    const second = await cell.run({ kind: "task-start", taskId: "task_round", executionId: "exe_second" }, binding);
    assert.equal(second.outcome, "rejected", JSON.stringify(second)); assert.equal(second.code, "invalid_transition");
    // The adjudicated exit: the same execution re-leases the round it never finished.
    const rejoined = await cell.run({ kind: "task-start", taskId: "task_round", executionId: "exe_round" }, binding);
    assert.equal(rejoined.outcome, "applied", JSON.stringify(rejoined));
    const shown = evidence(await cell.run({ kind: "task-show", taskId: "task_round" }, binding));
    assert.deepEqual((shown.executions as readonly { readonly executionId: string; readonly state: string }[]).map((row) => `${row.executionId}/${row.state}`), ["exe_round/active"]);
    assert.equal((shown.lease as { readonly executionId: string } | null)?.executionId, "exe_round");
    // Re-entry must not require the caller to remember the id. Omitting it used to derive a fresh one,
    // which the round then refused — the reported dead end, reachable with no execution id at all.
    assert.equal((await cell.run({ kind: "task-release", taskId: "task_round", reason: "Handed back again" }, binding)).outcome, "applied");
    const blind = await cell.run({ kind: "task-start", taskId: "task_round" }, binding);
    assert.equal(blind.outcome, "applied", JSON.stringify(blind));
    assert.equal((evidence(await cell.run({ kind: "task-show", taskId: "task_round" }, binding)).lease as { readonly executionId: string } | null)?.executionId, "exe_round");
    // Replay is the real contract: a cold rebuild from the event log must not grow a duplicate execution.
    await cell.close(); cell = undefined;
    const store = makeTaskEventStore({ repoId: "task-round-reenter", rootDir }), replay = makeTaskProjection({ rootDir, eventStore: store });
    rmSync(replay.path, { force: true }); replay.rebuild();
    assert.deepEqual(replay.read("task_round").snapshot.executions.map((row) => `${row.executionId}/${row.state}`), ["exe_round/active"]);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("read commands report projection readiness instead of asserting canonical visibility", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-readiness-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("task-readiness"), rootDir: canonicalRoot(rootDir), ownerId: "task-readiness", now: () => "2026-08-15T02:00:00.000Z" }); const binding = { actor, source: "local" as const };
    assert.equal((await cell.run({ kind: "task-create", taskId: "task_ready", title: "Readiness" }, binding)).outcome, "applied");
    const listed = await cell.run({ kind: "task-list" }, binding), payload = evidence(listed);
    assert.equal(listed.outcome, "applied");
    // A caught-up read now says so in its own payload, so "count=0" can never again be mistaken for an empty ledger.
    assert.equal(payload.status, "ready");
    assert.equal(payload.watermark, payload.sourceRevision);
    assert.equal(listed.proof?.canonicalVisible, true);
    assert.equal(listed.proof?.appliedCut, payload.watermark);
    assert.match(String((listed as Record<string, unknown>).summary), /status=ready/u);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

function evidence(receipt: Awaited<ReturnType<Awaited<ReturnType<typeof openRepoCell>>["run"]>>): Record<string, unknown> { return JSON.parse(String(receipt.evidence)) as Record<string, unknown>; }

function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Task Surface Test"); git(rootDir, "config", "user.email", "task-surface@example.invalid"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
