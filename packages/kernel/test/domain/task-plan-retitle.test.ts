// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { compileTaskLifecycleWrite, lifecycleDocumentFetchPaths, lifecycleDocumentPaths, type TaskEventV1, type TaskLifecycleSnapshot } from "../../src/index.ts";
import { validateCurrentTaskEvent, validateTaskEvent } from "../../src/domain/task-lifecycle.contract.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";

const packagePath = "tasks/task_RETITLE000000000000A-plan", taskId = "task_RETITLE000000000000A", actor = { principal: { personId: "person-retitle" }, executor: null };
const task = (title: string) => ({ schema: "task/v1", taskId, title, taskClass: "standard", status: "active", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0, createdBy: actor, completionGateIds: [], presetSnapshotDigest: null, metadata: { idempotencyKey: null, parentTaskId: null, workKind: null, riskTier: null, urgency: null, verticalId: "software/coding", presetId: "standard-task", profileId: "baseline", moduleKey: null, slug: "plan", surfaces: [], fromLegacyId: null } }) as never;
const amendEvent = (fields: readonly string[], title: string): TaskEventV1 => ({ schema: "task-event/v1", eventId: "event-retitle", workspaceRevision: 2, opId: "op-retitle", taskId, type: "task_amended", actor, source: "local", occurredAt: "2026-08-23T00:00:00.000Z", payload: { task: task(title), mutation: { command: "amend", reason: "declared retitle", fields }, documentClaims: [] } }) as unknown as TaskEventV1;
const snapshot = (title: string): TaskLifecycleSnapshot => ({ revision: 2, task: task(title), executions: [], reviews: [], consents: [], codeDocWitnesses: [], gateWitnesses: [], edgesTaken: [], lease: null }) as TaskLifecycleSnapshot;
const plan = `${packagePath}/task_plan.md`, planBody = "# old title\n\n## Brief\n\nworker prose stays byte-for-byte\n";

test("lifecycle paths keep the plan out of non-retitle amends and add it only to claimed retitles", () => {
  const base = [`${packagePath}/INDEX.md`, `${packagePath}/task-contract.json`];
  assert.deepEqual(lifecycleDocumentPaths(amendEvent(["pinned"], "old title"), packagePath), base);
  assert.deepEqual(lifecycleDocumentFetchPaths(amendEvent(["pinned"], "old title"), packagePath), base);
  assert.deepEqual(lifecycleDocumentPaths(amendEvent(["title"], "new title"), packagePath), base);
  assert.deepEqual(lifecycleDocumentFetchPaths(amendEvent(["title"], "new title"), packagePath), [...base, plan]);
  const claimed = { ...amendEvent(["title"], "new title"), payload: { ...amendEvent(["title"], "new title").payload, documentClaims: [{ path: plan, sha256: "0".repeat(64), size: 1, mediaType: "text/markdown" as const, policyId: "markdown-body-replaceable/v1" as const }] } } as unknown as TaskEventV1;
  assert.deepEqual(lifecycleDocumentPaths(claimed, packagePath), [...base, plan]);
});

test("compiling a title amend retitles a published plan under the prose policy and keeps the rest byte-for-byte", () => {
  const compiled = compileTaskLifecycleWrite({ event: amendEvent(["title"], "new title"), snapshot: snapshot("new title"), packagePath, currentDocuments: [{ path: plan, body: planBody, blobSha256: "0".repeat(64) }, { path: `${packagePath}/INDEX.md`, body: "---\ntaskId: x\nstatus: active\nowner: machine\n---\n# old title\n\n## Next\n\nn\n", blobSha256: "1".repeat(64) }, { path: `${packagePath}/task-contract.json`, body: "{}\n", blobSha256: "2".repeat(64) }] });
  const planClaim = compiled.event.payload.documentClaims.find((claim) => claim.path === plan);
  assert.ok(planClaim, "the retitle must claim the published plan");
  assert.equal(planClaim.policyId, "markdown-body-replaceable/v1");
  assert.equal(compiled.blobs.find((blob) => blob.sha256 === planClaim.sha256)?.body, "# new title\n\n## Brief\n\nworker prose stays byte-for-byte\n");
  assert.deepEqual(validateTaskEvent(compiled.event), []);
  assert.deepEqual(validateCurrentTaskEvent(compiled.event), []);
  assert.deepEqual(lifecycleDocumentPaths(compiled.event, packagePath), compiled.event.payload.documentClaims.map((claim) => claim.path));
});

test("compiling a title amend leaves an unpublished plan to its first prose sync", () => {
  const compiled = compileTaskLifecycleWrite({ event: amendEvent(["title"], "new title"), snapshot: snapshot("new title"), packagePath, currentDocuments: [] });
  assert.equal(compiled.changedPaths.includes(plan), false);
  assert.deepEqual(validateTaskEvent(compiled.event), []);
  assert.deepEqual(lifecycleDocumentPaths(compiled.event, packagePath), compiled.event.payload.documentClaims.map((claim) => claim.path));
});

test("task event validation only accepts the prose policy for task_plan.md lifecycle claims", () => {
  const machine = { ...amendEvent(["title"], "new title"), payload: { ...amendEvent(["title"], "new title").payload, documentClaims: [{ path: plan, sha256: "0".repeat(64), size: 1, mediaType: "text/markdown" as const, policyId: "typed-machine-writer/v1" as const }] } } as unknown as TaskEventV1;
  assert.equal(validateTaskEvent(machine).some((issue) => /document claims/u.test(issue.message)), true);
  const proseElsewhere = { ...amendEvent(["title"], "new title"), payload: { ...amendEvent(["title"], "new title").payload, documentClaims: [{ path: `${packagePath}/INDEX.md`, sha256: "0".repeat(64), size: 1, mediaType: "text/markdown" as const, policyId: "markdown-body-replaceable/v1" as const }] } } as unknown as TaskEventV1;
  assert.equal(validateTaskEvent(proseElsewhere).some((issue) => /document claims/u.test(issue.message)), true);
});
