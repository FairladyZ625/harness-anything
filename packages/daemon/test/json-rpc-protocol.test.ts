// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { eventObjectTarget, makeTaskEventStore, makeTaskProjection, readDaemonRegistry, REPLAY_TASK_GRAPH, serializeCanonicalEvent, serializeEventHead, sha256Text, taskLifecycleWritePlan, type AgentRuntimeEventV1, type FrozenWritePlan, type TaskEventV1 } from "../../kernel/src/index.ts";
import { projectDecisionReadiness, reviewDigest } from "../../kernel/src/index.ts";
import { actionForDaemonMethod, canonicalRoot, commandClassForAction, daemonGuiActionMethods, daemonProtocolCommands, parseDaemonRpcParams, validateDaemonDecisionList, validateDaemonGuiCommandReceipt, validateDaemonRelationGraph, validateDaemonTaskSnapshotList, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { openRepoCell } from "../src/repo-cell.ts";
const DOC_POLICY_ID = "markdown-body-replaceable/v1";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;

test("descriptor-derived RBAC preserves every preset, runtime, doc-sync, Fact, and Decision action class", () => {
  const expected = {
    "migrate-import": "repo-write",
    "ledger-migrate": "repo-write",
    "projection-rebuild": "repo-write",
    "task-create": "repo-write",
    "preset-list": "repo-read",
    "preset-inspect": "repo-read",
    "preset-check": "repo-read",
    "preset-validate": "repo-read",
    "preset-install": "repo-write",
    "preset-seed": "repo-write",
    "preset-audit": "repo-read",
    "preset-uninstall": "repo-write",
    "preset-upgrade": "repo-write",
    "script-run": "repo-write",
    "preset-run-start": "repo-write",
    "preset-run-status": "repo-read",
    "task-start": "repo-write",
    "task-progress-append": "repo-write",
    "task-artifact-add": "repo-write",
    "task-submit": "repo-write", "task-declare-executor": "repo-write",
    "task-review-execution": "arbiter",
    "task-review-consent": "repo-write",
    "task-code-doc-reconcile": "repo-write",
    "task-complete": "repo-write",
    "task-show": "repo-read",
    "receipt-show": "repo-read",
    "doc-status": "repo-read",
    "doc-dry-run": "repo-read",
    "doc-submit": "repo-write",
    "doc-materialize": "repo-write",
    "doc-show": "repo-read",
    "fact-record": "repo-write",
    "fact-search": "repo-read",
    "fact-show": "repo-read",
    "decision-propose": "repo-write",
    "decision-validate": "repo-read",
    "decision-repin": "repo-write",
    "decision-transition": "repo-write",
    "decision-accept": "arbiter",
    "decision-reject": "arbiter",
    "decision-defer": "arbiter",
    "decision-retire": "repo-write",
    "decision-supersede": "repo-write",
    "decision-amend": "repo-write",
    "decision-claim-add": "repo-write",
    "decision-claim-fulfill": "repo-write",
    "decision-relate": "repo-write",
    "decision-relation-retire": "repo-write",
    "decision-relation-replace": "repo-write",
    "decision-reckon": "repo-write",
    "decision-list": "repo-read",
    "decision-show": "repo-read",
    "distill-candidate": "repo-write",
    "distill-promote": "repo-write"
  } as const;
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((kind) => [kind, commandClassForAction(kind)])), expected);
});

test("task-create and preset RPC descriptors enforce closed payloads and retire the open route", () => {
  const params = { repo: { repoId: "alpha" }, payload: { title: "Closed", presetId: "standard-task" } };
  assert.equal(parseDaemonRpcParams("repo.task.create", params).ok, true); assert.equal(parseDaemonRpcParams("repo.task.create", { ...params, payload: { ...params.payload, dryRun: true } }).ok, true); assert.equal(parseDaemonRpcParams("repo.task.create", { ...params, payload: { ...params.payload, dryRun: "true" } }).ok, false); assert.equal(parseDaemonRpcParams("repo.task.create", { ...params, payload: { ...params.payload, completionGateIds: [] } }).ok, false); assert.deepEqual(actionForDaemonMethod("repo.task.create", params.payload), { kind: "task-create", ...params.payload }); assert.throws(() => actionForDaemonMethod("repo.task.run", { action: { kind: "task-create", title: "Open" } }), /closed method/u);
  const fullPayload = { taskId: "task_full", title: "Full", idempotencyKey: "once", parentTaskId: "task_parent", workKind: "feat", riskTier: "high", urgency: "medium", moduleKey: "kernel", registerModule: { key: "kernel", title: "Kernel", prefix: "KER", scope: "packages/kernel/**" }, surfaces: ["ha task create"], relations: [{ type: "depends-on", target: "task/task_parent", rationale: "First" }], createMode: "admin" };
  assert.equal(parseDaemonRpcParams("repo.task.create", { repo: { repoId: "alpha" }, payload: fullPayload }).ok, true);
  const retiredBoolean = parseDaemonRpcParams("repo.task.create", { repo: { repoId: "alpha" }, payload: { ...fullPayload, longRunning: true } });
  assert.equal(retiredBoolean.ok, false);
  if (!retiredBoolean.ok) assert.deepEqual(retiredBoolean.errors, ["params.payload.longRunning is not allowed"]);
  assert.equal(parseDaemonRpcParams("repo.task.create", { repo: { repoId: "alpha" }, payload: { ...fullPayload, taskClass: "long_running" } }).ok, true);
});

test("daemon repo registration derives its closed mode enum at the wire boundary", () => {
  const base = { rootDir: "/tmp/workspace", repoId: "alpha" };
  for (const mode of [undefined, "local", "remote-center", "remote-edge"]) assert.equal(parseDaemonRpcParams("daemon.repo.register", { ...base, ...(mode ? { mode } : {}) }).ok, true, String(mode));
  const invalid = parseDaemonRpcParams("daemon.repo.register", { ...base, mode: "invalid" }); assert.equal(invalid.ok, false); if (!invalid.ok) assert.deepEqual(invalid.errors, ["params.mode must be one of local, remote-center, remote-edge"]);
});

test("ledger migrate runs through the RepoCell write queue and reports its bounded projection catch-up", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-ledger-layout-migrate-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); const flatEvent: TaskEventV1 = { schema: "task-event/v1", eventId: "event-flat-ledger", workspaceRevision: 1, opId: "migration-flat-ledger", taskId: "task_flat_ledger", type: "task_created", actor, source: "local", occurredAt: "2026-08-16T00:00:00.000Z", payload: { task: { schema: "task/v1", taskId: "task_flat_ledger", title: "Flat ledger", taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0, createdBy: actor, completionGateIds: [], presetSnapshotDigest: null } } }, eventBody = serializeCanonicalEvent(flatEvent), eventsRoot = path.join(rootDir, "harness/events"); mkdirSync(eventsRoot, { recursive: true }); writeFileSync(path.join(eventsRoot, `${flatEvent.opId}.json`), eventBody); writeFileSync(path.join(eventsRoot, "head.json"), serializeEventHead({ revision: 1, opId: flatEvent.opId, eventDigest: `sha256:${sha256Text(eventBody)}` })); git(rootDir, "add", "harness/events"); git(rootDir, "commit", "--quiet", "-m", "flat ledger fixture");
    cell = await openRepoCell({ repoId: workspaceId("ledger-layout-migrate"), rootDir: canonicalRoot(rootDir), ownerId: "ledger-layout-migrate", now: () => "2026-08-16T00:00:01.000Z" }); const receipt = await cell.run({ kind: "ledger-migrate" }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(receipt.outcome, "applied", JSON.stringify(receipt)); assert.equal(receipt.revision, 2); assert.equal(receipt.commitSha, git(rootDir, "rev-parse", "HEAD")); assert.deepEqual(git(rootDir, "ls-tree", "--name-only", "HEAD:harness/events").split("\n").filter((name) => name.endsWith(".json")), ["head.json"]); const projected = await cell.read("repo.tasks.list"); assert.equal(projected.status, "ready"); assert.equal(projected.watermark, 2); assert.equal(projected.rows.some(({ taskId }) => taskId === flatEvent.taskId), true);
    const repeated = await cell.run({ kind: "ledger-migrate" }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(repeated.commitSha, receipt.commitSha); assert.equal(git(rootDir, "rev-list", "--count", "HEAD"), "3");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("explicit projection rebuild is a local repair action with a source-complete digest", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-projection-rebuild-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("projection-rebuild"), rootDir: canonicalRoot(rootDir), ownerId: "projection-rebuild" });
    await cell.run({ kind: "task-create", taskId: "task_projection_rebuild", title: "Projection rebuild" }, { actor, source: "local" });
    const receipt = await cell.run({ kind: "projection-rebuild" }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt)); assert.equal(receipt.revision, 1); assert.equal((receipt.proof as { readonly committedRevision: number; readonly appliedCut: number }).appliedCut, 1);
    const evidence = JSON.parse(String(receipt.evidence)) as { readonly stateDigest: string; readonly metrics: { readonly reducedItems: number } };
    assert.match(evidence.stateDigest, /^sha256:[0-9a-f]{64}$/u); assert.equal(evidence.metrics.reducedItems, 1);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("replay receipts report the current canonical cut instead of scanning for first publication", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-replay-current-cut-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("replay-current-cut"), rootDir: canonicalRoot(rootDir), ownerId: "replay-current-cut" }); const binding = { actor, source: "local" as const }; await cell.run({ kind: "task-create", taskId: "task_replay_first", title: "First" }, binding); const first = await cell.run({ kind: "task-start", taskId: "task_replay_first", executionId: "execution_replay_first" }, binding) as Record<string, unknown>, second = await cell.run({ kind: "task-create", taskId: "task_replay_second", title: "Second" }, binding) as Record<string, unknown>, replay = await cell.run({ kind: "receipt-show", opId: first.opId }, binding) as Record<string, unknown>; assert.notEqual(first.commitSha, second.commitSha); assert.equal(replay.commitSha, second.commitSha); assert.equal(replay.commitSha, git(rootDir, "rev-parse", "HEAD")); }
  finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("relation graph contract accepts the materialized ledger row schema and rejects malformed rows", () => {
  const payload = { ok: true, edges: [{ relationId: "rel_real", sourceRef: "decision/dec_REAL/C1", targetRef: "fact/task_REAL/F-REAL", relationType: "evidenced-by", direction: "directed", strength: "strong", origin: "declared", state: "active", rationale: "Observed.", ownerRef: "decision/dec_REAL", sourcePath: "harness/decisions/decision-dec_REAL/decision.md", recordIndex: 0 }], coverageRows: [{ decisionRef: "decision/dec_REAL", claimRef: "decision/dec_REAL/C1", status: "covered", fulfillment: "standing-policy", relationPath: ["rel_real"] }], factAnchors: [{ factRef: "fact/task_REAL/F-REAL", taskId: "task_REAL", factId: "F-REAL", sourcePath: "harness/tasks/task_REAL/facts.md" }], facts: [{ schema: "task-fact-row/v1", ref: "fact/task_REAL/F-REAL", taskId: "task_REAL", factId: "F-REAL", statement: "Real observation.", source: "harness/tasks/task_REAL/facts.md", observedAt: "2026-08-14T00:00:00.000Z", confidence: "high", memoryClass: "semantic", memoryTags: [], provenance: [], liveness: "standing" }], warnings: [] };
  assert.deepEqual(validateDaemonRelationGraph(payload), []);
  assert.deepEqual(validateDaemonRelationGraph({ ...payload, coverageRows: [{ ...payload.coverageRows[0], fulfillment: "standing_policy" }] }), ["daemon relation graph is invalid"]);
  const { observedAt: _observedAt, ...missingObservedAt } = payload.facts[0]; assert.deepEqual(validateDaemonRelationGraph({ ...payload, facts: [missingObservedAt] }), ["daemon relation graph is invalid"]);
});

test("preset process RPC enforces object inputs and keeps status closed", () => {
  const start = { repo: { repoId: "alpha" }, payload: { presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "once" } }, status = { repo: { repoId: "alpha" }, payload: { runId: "run_1" } };
  assert.equal(parseDaemonRpcParams("repo.preset.run.start", start).ok, true); assert.equal(parseDaemonRpcParams("repo.preset.run.start", { ...start, payload: { ...start.payload, allowScripts: true } }).ok, false); assert.equal(parseDaemonRpcParams("repo.preset.run.start", { ...start, payload: { ...start.payload, inputs: "open" } }).ok, false); assert.equal(parseDaemonRpcParams("repo.preset.run.status", status).ok, true); assert.equal(parseDaemonRpcParams("repo.preset.run.status", { ...status, payload: { ...status.payload, retry: true } }).ok, false);
});

test("GUI action facets are exact, typed, and exclude the generic runner", () => {
  const submission = { completionClaim: "Ready.", deliverables: ["code"], outputs: ["packages/daemon/src/repo-cell.ts"], verificationNotes: ["tests"], knownGaps: [], residualRisks: [], commitSha: "a".repeat(40) }, proposal = { title: "Typed actions", question: "Ship?", riskTier: "medium", urgency: "high", vertical: "software/coding", preset: "standard-task", appliesTo: { modules: ["daemon"], productLines: ["gui"] }, decisionClass: "ordinary", chosen: [{ id: "CH1", text: "Ship" }], rejected: [{ id: "RJ1", text: "Wait", whyNot: "No need" }], body: "# Typed actions\n", claims: [], fulfillments: [], relations: [] };
  const cases = new Map<string, Record<string, unknown>>([
    ["daemon.gui.control.request", { kind: "refresh", authorityRepoId: "alpha", reason: "Refresh catalog" }],
    ["repo.task.start", { taskId: "task-a", executionId: "execution-a" }],
    ["repo.task.progress.append", { taskId: "task-a", executionId: "execution-a", text: "Progress", evidence: [{ type: "test", path: "report.txt", summary: "Passed" }] }],
    ["repo.task.submit", { taskId: "task-a", executionId: "execution-a", submission }],
    ["repo.decision.list", { state: "proposed", legacyRange: { start: 1, end: 4 } }],
    ["repo.decision.show", { decisionId: "dec_A", includeBody: true }],
    ["repo.decision.propose", proposal],
    ["repo.decision.accept", { decisionId: "dec_A", rationale: "Approved", judgmentOnlyRationale: "Judgment" }],
    ["repo.decision.reject", { decisionId: "dec_A", reason: "Rejected" }],
    ["repo.decision.defer", { decisionId: "dec_A", reason: "Deferred" }],
    ["repo.receipt.show", { opId: "op_A" }],
    ["repo.gui.catalog.reread", {}],
    ["repo.agentRuntime.spawn", { runtimeInstanceId: "instance-codex", cwd: { scope: "repo-root" }, prompt: "Inspect", taskId: null, idempotencyKey: "runtime-once" }],
    ["repo.agent.entity.write", { declaration: { schema: "agent-declaration/v1", id: "gui-created-agent", name: "GUI Created Agent", instructions: "Keep the roster intact.\nSecond line.", runtime_type: "any", model: "gpt-5.6-terra", skills: [{ id: "review", path: "skills/review" }], prompts: ["prompt://gui"], preset: "standard-task" } }],
    ["repo.squad.entity.write", { declaration: { schema: "squad-declaration/v1", id: "gui-created-squad", name: "GUI Created Squad", leader: "gui-created-agent", workers: ["gui-created-agent"], roster: "## GUI Squad\n\n  GUI Created Agent\n\n" } }],
    ["repo.agentRuntime.cancel", { runtimeSessionId: "runtime-session-a" }],
    ["repo.terminal.spawn", { idempotencyKey: "terminal-once", name: "Shell", cwd: { scope: "repo-root" }, shellProfileId: "default" }],
    ["repo.terminal.input", { sessionId: "terminal-a", clientSeq: 1, utf8: "pwd\n" }],
    ["repo.terminal.resize", { sessionId: "terminal-a", cols: 100, rows: 30 }],
    ["repo.terminal.detach", { sessionId: "terminal-a", attachmentId: "attachment-a" }],
    ["repo.terminal.terminate", { sessionId: "terminal-a", confirmed: true }]
  ]);
  assert.deepEqual(daemonGuiActionMethods.map(({ method }) => method), [...cases.keys()]); assert.equal(daemonGuiActionMethods.some(({ method }) => method === "repo.task.run"), false);
  for (const [method, payload] of cases) { const params = method.startsWith("daemon.") ? { payload } : { repo: { repoId: "alpha" }, payload }; assert.equal(parseDaemonRpcParams(method, params).ok, true, method); assert.equal(parseDaemonRpcParams(method, { ...params, payload: { ...payload, unexpected: true } }).ok, false, `${method}: unknown`); }
  assert.equal(parseDaemonRpcParams("repo.task.submit", { repo: { repoId: "alpha" }, payload: { taskId: "task-a", executionId: "execution-a", submission: { ...submission, outputs: "wrong" } } }).ok, false);
  assert.equal(parseDaemonRpcParams("repo.decision.propose", { repo: { repoId: "alpha" }, payload: { ...proposal, appliesTo: { ...proposal.appliesTo, extra: [] } } }).ok, false);
  assert.deepEqual(actionForDaemonMethod("repo.task.submit", cases.get("repo.task.submit")!), { kind: "task-submit", ...cases.get("repo.task.submit")! });
});

test("GUI command receipts and task supplements reject unknown, missing, and mistyped fields", () => {
  const proof = { committedRevision: 0, appliedCut: 0, durable: true, canonicalVisible: true, worktreeVisible: null }, receipt = { schema: "command-receipt/v2", ok: true, command: "decision-list", outcome: "applied", opId: "read:decision-list", revision: 0, evidence: "{}", visibility: "center", proof };
  assert.deepEqual(validateDaemonGuiCommandReceipt(receipt), []); assert.notDeepEqual(validateDaemonGuiCommandReceipt({ ...receipt, extra: true }), []); const { schema: _schema, ...missing } = receipt; assert.notDeepEqual(validateDaemonGuiCommandReceipt(missing), []); assert.notDeepEqual(validateDaemonGuiCommandReceipt({ ...receipt, revision: "0" }), []);
  const availability = { consents: "unknown", codeDocWitnesses: "unknown", gateWitnesses: "unknown" }, placement = { moduleKeys: [], productLines: [], parentTaskId: null, origin: "native", engine: "kernel/task-lifecycle/v1", packageDisposition: "active", provenance: [{ kind: "canonical-event", ref: "task/task-old" }] }, old = { ok: true, status: "ready", watermark: 0, sourceRevision: 0, warnings: [], rows: [{ taskId: "task-old", packagePath: null, generation: "v1", workspaceRevision: 0, updatedAt: "2026-08-14T00:00:00.000Z", snapshot: { revision: 0, task: null, executions: [], reviews: [], edgesTaken: [], lease: null, decisionRelations: [] }, snapshotAvailability: availability, closeoutAssessment: { readiness: "missing", blocker: "execution", gates: [] }, blockingAssessment: { taskId: "task-old", state: "clear", blockers: [], warnings: [] }, placement, executionEvidence: [] }] };
  assert.deepEqual(validateDaemonTaskSnapshotList(old), []); assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...old, rows: [{ ...old.rows[0]!, unknown: true }] }), []); const { placement: _placement, ...withoutPlacement } = old.rows[0]!; assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...old, rows: [withoutPlacement] }), []); assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...old, rows: [{ ...old.rows[0]!, executionEvidence: [{ executionId: 1, origin: "native", outputs: [] }] }] }), []);
  const metadata = { idempotencyKey: null, parentTaskId: null, workKind: "feat", riskTier: "medium", urgency: "high", verticalId: "software/coding", presetId: "standard-task", profileId: "default", moduleKey: "daemon", slug: "current-task", surfaces: ["cli"], longRunning: false, fromLegacyId: null }, relation = { relation_id: "rel_0123456789abcdef", source: "task/task-current", target: "task/task-old", type: "depends-on", strength: "strong", direction: "directed", origin: "declared", rationale: "Required first", state: "active" }, currentTask = { schema: "task/v1", taskId: "task-current", title: "Current task", taskClass: "standard", status: "blocked", graph: {}, currentNode: "implementation", iteration: 0, createdBy: { principal: { personId: "person-owner" }, executor: null }, completionGateIds: [], presetSnapshotDigest: null, metadata, relations: [relation], packageDisposition: "archived", supersededBy: "task-next", contractVersion: 1 }, current = { ...old, rows: [{ ...old.rows[0]!, taskId: "task-current", snapshot: { ...old.rows[0]!.snapshot, task: currentTask } }] };
  assert.deepEqual(validateDaemonTaskSnapshotList(current), []); assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...current, rows: [{ ...current.rows[0]!, snapshot: { ...current.rows[0]!.snapshot, task: { ...currentTask, metadata: { ...metadata, unknown: true } } } }] }), []);
});

test("repo-bound ledger commit rejects cross-repo SHA", () => {
  const roots = ["a", "b"].map((name) => mkdtempSync(path.join(tmpdir(), `ha-ledger-${name}-`)));
  try { roots.forEach(initRepo); const left = makeTaskEventStore({ rootDir: roots[0]!, repoId: "repo-a" }), right = makeTaskEventStore({ rootDir: roots[1]!, repoId: "repo-b" });
    assert.match(left.currentCommit().sha, /^[0-9a-f]{40}$/u); assert.throws(() => right.revisionAt(left.currentCommit()), /repo/iu);
  } finally { roots.forEach((root) => rmSync(root, { recursive: true, force: true })); }
});

test("task create dry-run validates the exact package without event, revision, commit, or authored writes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-create-preview-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); mkdirSync(path.join(rootDir, "harness/custom"), { recursive: true }); mkdirSync(path.join(rootDir, "harness/templates"), { recursive: true }); writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n  scaffolds:\n    task: custom/task-scaffold.json\n"); writeFileSync(path.join(rootDir, "harness/templates/notes.md"), "# Notes\n\n## Project Notes\n\nCustom.\n"); writeFileSync(path.join(rootDir, "harness/custom/task-scaffold.json"), `${JSON.stringify({ schema: "task-scaffold/v1", replaceTemplate: [], addDocument: [{ slot: "project.notes", path: "notes.md", template: "templates/notes.md", requiredAnchors: ["## Project Notes"] }] })}\n`); cell = await openRepoCell({ repoId: workspaceId("preview"), rootDir: canonicalRoot(rootDir), ownerId: "preview-daemon" }); const action = { kind: "task-create", taskId: "task-preview", title: "Preview Package" } as const, before = git(rootDir, "rev-parse", "HEAD"), preview = await cell.run({ ...action, dryRun: true }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(preview.outcome, "applied"); assert.equal(preview.packagePath, "tasks/task-preview-preview-package"); assert.equal(preview.commitSha, null); assert.equal(preview.dryRun, true); assert.equal((preview.generatedPaths as string[]).length, 7); assert.equal((preview.generatedPaths as string[]).includes("tasks/task-preview-preview-package/notes.md"), true); assert.equal(makeTaskEventStore({ repoId: "preview", rootDir }).read().revision, 0); assert.equal(git(rootDir, "rev-parse", "HEAD"), before); assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-preview-preview-package")), false);
    const created = await cell.run(action, { actor, source: "local" }) as Record<string, unknown>; assert.equal(created.packagePath, preview.packagePath); assert.equal(created.presetDigest, preview.presetDigest); assert.equal(created.scaffoldDigest, preview.scaffoldDigest); assert.match(String(created.commitSha), /^[0-9a-f]{40}$/u); assert.match(String(created.nextAction), /task_plan\.md.*task start/u); assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-preview-preview-package/notes.md"), "utf8"), "# Notes\n\n## Project Notes\n\nCustom.\n"); assert.equal(makeTaskEventStore({ repoId: "preview", rootDir }).read().revision, 1); const duplicate = await cell.run({ ...action, title: "Different title" }, { actor, source: "local" }); assert.equal(duplicate.outcome, "op_rejected"); assert.equal(duplicate.code, "task_exists"); assert.equal(makeTaskEventStore({ repoId: "preview", rootDir }).read().revision, 1); writeFileSync(path.join(rootDir, "harness/tasks/task-preview-preview-package/INDEX.md"), "corrupt markdown\n"); const shown = await cell.run({ kind: "task-show", taskId: "task-preview" }, { actor, source: "local" }); const evidence = JSON.parse(String(shown.evidence)) as { packagePath: string; task: { title: string } }; assert.equal(evidence.packagePath, preview.packagePath); assert.equal(evidence.task.title, "Preview Package");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("RepoCell rejects completion on snapshot drift and preset upgrade publishes one canonical replacement", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-upgrade-cell-")), source = path.join(rootDir, "source/upgrade-task"), taskId = "task-upgrade-cell", binding = { actor, source: "local" as const }; let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const packageBody = (version: string) => JSON.stringify({ schema: "preset-manifest/v3", id: "upgrade-task", title: "Upgrade Task", vertical: "software/coding", version, kind: "template-content", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" }, capabilityImports: [], profiles: [{ id: "baseline", title: "Baseline", completionGates: ["ci", "code-doc-reconciliation"], templateSelections: [] }], defaultProfile: "baseline" });
  try {
    initRepo(rootDir); mkdirSync(source, { recursive: true }); writeFileSync(path.join(source, "preset.json"), packageBody("3.1.0")); writeFileSync(path.join(source, "PRESET.md"), "---\nschema: preset-document/v1\ndescription: Upgrade fixture.\nwhenToUse: Test upgrade.\n---\n# Upgrade\n"); cell = await openRepoCell({ repoId: workspaceId("preset-upgrade-cell"), rootDir: canonicalRoot(rootDir), ownerId: "preset-upgrade-daemon" }); assert.equal((await cell.run({ kind: "preset-install", packageSource: "source/upgrade-task" }, binding)).outcome, "applied"); const created = await cell.run({ kind: "task-create", taskId, title: "Upgrade Cell", presetId: "upgrade-task" }, binding) as Record<string, unknown>, previousDigest = String(created.presetDigest); writeFileSync(path.join(source, "preset.json"), packageBody("3.2.0")); assert.equal((await cell.run({ kind: "preset-install", packageSource: "source/upgrade-task" }, binding)).outcome, "applied");
    const blocked = await cell.run({ kind: "task-complete", taskId, executionId: "execution-missing" }, binding); assert.equal(blocked.code, "preset_snapshot_mismatch"); const upgraded = await cell.run({ kind: "preset-upgrade", taskId }, binding) as Record<string, unknown>; assert.equal(upgraded.outcome, "applied"); const evidence = JSON.parse(String(upgraded.evidence)) as { previousDigest: string; digest: string }; assert.equal(evidence.previousDigest, previousDigest); assert.notEqual(evidence.digest, previousDigest); const event = makeTaskEventStore({ repoId: "preset-upgrade-cell", rootDir }).readEvent(String(upgraded.opId)); assert.equal(event?.schema, "preset-snapshot-upgrade-event/v1"); assert.equal((await cell.run({ kind: "task-complete", taskId, executionId: "execution-missing" }, binding)).code, "not_in_review");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("RepoCell serializes identical lifecycle intents into one Git publication and one applied receipt", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId: workspaceId("alpha"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" });
    const action = { kind: "task-create", verb: "create", commandType: "CreateReplayTask", taskId: "task-alpha",
      title: "Alpha task" } as const;

    const [left, right] = await Promise.all([
      cell.run(action, { actor, source: "local" }),
      cell.run(action, { actor, source: "local" })
    ]);

    assert.deepEqual([left.outcome, right.outcome], ["applied", "applied"], JSON.stringify([left, right]));
    assert.equal(left.opId, right.opId);
    assert.equal(left.revision, 1);
    assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical"), "2");
    const shown = await cell.run({ kind: "task-show", verb: "show", taskId: "task-alpha" }, { actor, source: "local" });
    assert.equal(shown.outcome, "applied");
    assert.match(String(shown.evidence), /Alpha task/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("structured GUI submit and CLI packet submit publish the same canonical event", async () => {
  const roots = ["packet", "structured"].map((name) => mkdtempSync(path.join(tmpdir(), `ha-submit-ab-${name}-`)));
  const cells: Awaited<ReturnType<typeof openRepoCell>>[] = [];
  const now = () => "2026-08-14T01:02:03.000Z", taskId = "task-submit-ab", executionId = "execution-submit-ab", binding = { actor, source: "local" as const };
  try {
    roots.forEach(initDeterministicRepo);
    for (const [index, rootDir] of roots.entries()) cells.push(await openRepoCell({ repoId: workspaceId("submit-ab"), rootDir: canonicalRoot(rootDir), ownerId: `submit-ab-${index}`, now }));
    for (const cell of cells) { assert.equal((await cell.run({ kind: "task-create", taskId, title: "Submit A B" }, binding)).outcome, "applied"); assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied"); }
    const commitSha = git(roots[0]!, "rev-parse", "HEAD"); assert.equal(git(roots[1]!, "rev-parse", "HEAD"), commitSha);
    const submission = { completionClaim: "Typed GUI submit is equivalent.", deliverables: ["canonical event"], outputs: ["harness/tasks/task-submit-ab-submit-a-b/INDEX.md"], verificationNotes: ["A/B"], knownGaps: [], residualRisks: [], commitSha };
    writeFileSync(path.join(roots[0]!, "submission.json"), JSON.stringify(submission));
    assert.equal((await cells[0]!.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, binding)).outcome, "applied");
    const server = createJsonRpcProtocolServer({ host: { run: async (_repoId: string, action: Record<string, unknown>) => cells[1]!.run(action as { readonly kind: string }, binding) } as never, authContext: {} as never, emit: async () => undefined }); await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } }); const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "repo.task.submit", params: { repo: { repoId: "submit-ab" }, payload: { taskId, executionId, submission } } }); assert.ok(response && !Array.isArray(response) && "result" in response); assert.equal((response as { result: { outcome: string } }).result.outcome, "applied"); server.close();
    const events = roots.map((rootDir) => makeTaskEventStore({ repoId: "submit-ab", rootDir }).read().events.at(-1));
    assert.deepEqual(events[1], events[0]);
    const projected = await cells[1]!.read("repo.tasks.list"), row = projected.rows[0]!, output = row.executionEvidence[0]!.outputs[0]!; assert.deepEqual(row.snapshotAvailability, { consents: "known", codeDocWitnesses: "known", gateWitnesses: "known" }); assert.deepEqual({ parentTaskId: row.placement.parentTaskId, origin: row.placement.origin, packageDisposition: row.placement.packageDisposition }, { parentTaskId: null, origin: "native", packageDisposition: "active" }); assert.equal(row.placement.provenance.length > 0, true); assert.deepEqual({ executionId: row.executionEvidence[0]!.executionId, origin: row.executionEvidence[0]!.origin, locator: output.locator, substrate: output.substrate, checkerReceiptRef: output.checkerReceiptRef, checkerResult: output.checkerResult }, { executionId, origin: "native", locator: submission.outputs[0], substrate: "repository-path", checkerReceiptRef: null, checkerResult: "unknown" }); assert.match(output.evidenceId, /^evidence_[0-9a-f]{24}$/u); assert.deepEqual(validateDaemonTaskSnapshotList(projected), []);
  } finally { await Promise.all(cells.map((cell) => cell.close())); roots.forEach((root) => rmSync(root, { recursive: true, force: true })); }
});

test("lifecycle commands publish typed events, machine files, rebuildable L2, and complete receipts in one cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-files-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const taskId = "task-life", executionId = "execution-life", packagePath = "tasks/task-life-lifecycle-files", binding = { actor, source: "local" as const };
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("lifecycle-files"), rootDir: canonicalRoot(rootDir), ownerId: "lifecycle-daemon" });
    assert.equal((await cell.run({ kind: "task-create", taskId, title: "Lifecycle files" }, binding)).outcome, "applied");
    const assertCut = (receipt: Record<string, unknown>, type: string, paths: readonly string[]) => { assert.equal(receipt.outcome, "applied", JSON.stringify(receipt)); assert.equal(receipt.taskId, taskId); assert.equal(receipt.executionId, executionId); assert.deepEqual(receipt.changedPaths, paths); assert.equal(receipt.worktreeVisible, true); assert.match(String(receipt.commitSha), /^[0-9a-f]{40}$/u); assert.equal(receipt.commitSha, git(rootDir, "rev-parse", "HEAD")); assert.equal(typeof receipt.transition, "object"); assert.equal(Array.isArray(receipt.next), true); const event = makeTaskEventStore({ repoId: "lifecycle-files", rootDir }).readEvent(String(receipt.opId)); assert.equal(event?.type, type); if (event?.schema !== "task-event/v1") throw new Error("lifecycle receipt requires a TaskEvent"); assert.deepEqual(event.payload.documentClaims?.map((claim) => claim.path), paths); const changed = git(rootDir, "diff-tree", "--no-commit-id", "--name-only", "-r", String(receipt.commitSha)).split("\n"); for (const target of paths) assert.equal(changed.includes(`harness/${target}`), true, target); };
    const indexPath = `${packagePath}/INDEX.md`, executionPath = `${packagePath}/executions/${executionId}.md`, reviewPath = `${packagePath}/reviews/review-life.md`, codeDocPath = `${packagePath}/code-doc-anchors.json`;
    const started = await cell.run({ kind: "task-start", taskId, executionId }, binding) as unknown as Record<string, unknown>; assertCut(started, "execution_started", [indexPath, executionPath]); assert.match(readFileSync(path.join(rootDir, "harness", executionPath), "utf8"), /State: active/u);
    const commitSha = git(rootDir, "rev-parse", "HEAD"), beforeInvalidSubmit = makeTaskEventStore({ repoId: "lifecycle-files", rootDir }).readHead()?.revision; writeFileSync(path.join(rootDir, "submission.json"), JSON.stringify({ completionClaim: "incomplete", deliverables: [], outputs: [], verificationNotes: [], knownGaps: [], commitSha })); const invalidSubmit = await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, binding); assert.equal(invalidSubmit.outcome, "op_rejected"); assert.equal(makeTaskEventStore({ repoId: "lifecycle-files", rootDir }).readHead()?.revision, beforeInvalidSubmit); assert.equal(git(rootDir, "rev-parse", "HEAD"), commitSha); writeFileSync(path.join(rootDir, "submission.json"), JSON.stringify({ completionClaim: "Lifecycle output is ready.", deliverables: ["typed lifecycle"], outputs: ["machine files"], verificationNotes: ["tests"], knownGaps: [], residualRisks: [], commitSha }));
    const submitted = await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, binding) as unknown as Record<string, unknown>; assertCut(submitted, "execution_submitted", [indexPath, executionPath]); assert.deepEqual(submitted.transition, { from: "active/implementation", to: "in_review/review" }); assert.match(readFileSync(path.join(rootDir, "harness", executionPath), "utf8"), /State: submitted[\s\S]*Lifecycle output is ready/u);
    writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "Independent review passed.", evidenceChecked: ["tests"], commitSha, iteration: 0 })); const reviewBinding = { actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "arbiter" } }, source: "local" as const, roles: ["$arbiter"] };
    const reviewed = await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "review-life", fromFile: "review.json" }, reviewBinding) as unknown as Record<string, unknown>; assertCut(reviewed, "review_recorded", [indexPath, executionPath, reviewPath]); assert.equal(reviewed.reviewId, "review-life"); assert.match(readFileSync(path.join(rootDir, "harness", reviewPath), "utf8"), /Verdict: approved[\s\S]*Consent: pending/u);
    const reviewEvent = makeTaskEventStore({ repoId: "lifecycle-files", rootDir }).readEvent(String(reviewed.opId)); if (reviewEvent?.type !== "review_recorded") throw new Error("review event missing"); assert.equal(reviewed.reviewDigest, reviewDigest(reviewEvent.payload.review)); assert.equal(reviewed.contentDigest, reviewEvent.payload.review.contentDigest); writeFileSync(path.join(rootDir, "consent.json"), JSON.stringify({ reviewDigest: reviewed.reviewDigest, contentDigest: reviewed.contentDigest }));
    const consented = await cell.run({ kind: "task-review-consent", taskId, executionId, reviewId: "review-life", consentId: "consent-life", fromFile: "consent.json" }, binding) as unknown as Record<string, unknown>; assertCut(consented, "review_consent_recorded", [indexPath, executionPath, reviewPath]); assert.match(readFileSync(path.join(rootDir, "harness", reviewPath), "utf8"), /Consent: consent-life[\s\S]*Consent actor: person-owner/u);
    const beforeInvalidWitness = makeTaskEventStore({ repoId: "lifecycle-files", rootDir }).readHead()?.revision; for (const invalid of [{ commitSha: "f".repeat(40), paths: ["packages/kernel/src/domain/task.ts"] }, { commitSha, paths: ["../escape.md"] }]) assert.equal((await cell.run({ kind: "task-code-doc-reconcile", taskId, executionId, iteration: 0, ...invalid }, binding)).outcome, "op_rejected"); assert.equal(makeTaskEventStore({ repoId: "lifecycle-files", rootDir }).readHead()?.revision, beforeInvalidWitness); const reconciled = await cell.run({ kind: "task-code-doc-reconcile", taskId, executionId, commitSha, iteration: 0, paths: ["packages/kernel/src/domain/task.ts"] }, binding) as unknown as Record<string, unknown>; assertCut(reconciled, "code_doc_reconciled", [indexPath, executionPath, codeDocPath]); assert.deepEqual(JSON.parse(readFileSync(path.join(rootDir, "harness", codeDocPath), "utf8")), { schema: "code-doc-witness/v1", witnessId: String((makeTaskEventStore({ repoId: "lifecycle-files", rootDir }).readEvent(String(reconciled.opId)) as { payload: { witness: { witnessId: string } } }).payload.witness.witnessId), taskId, executionId, commitSha, iteration: 0, paths: ["packages/kernel/src/domain/task.ts"], actor, source: "local", reconciledAt: (makeTaskEventStore({ repoId: "lifecycle-files", rootDir }).readEvent(String(reconciled.opId)) as { occurredAt: string }).occurredAt });
    const lookedUp = await cell.run({ kind: "receipt-show", opId: reconciled.opId }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ taskId: lookedUp.taskId, executionId: lookedUp.executionId, transition: lookedUp.transition, changedPaths: lookedUp.changedPaths }, { taskId, executionId, transition: reconciled.transition, changedPaths: reconciled.changedPaths });
    await cell.close(); cell = undefined; const store = makeTaskEventStore({ repoId: "lifecycle-files", rootDir }); for (const target of [indexPath, executionPath, reviewPath, codeDocPath]) rmSync(path.join(rootDir, "harness", target)); assert.deepEqual(new Set(store.materialize().changed), new Set([indexPath, codeDocPath, executionPath, reviewPath]));
    const projection = makeTaskProjection({ rootDir, eventStore: store }); projection.close(); rmSync(projection.path, { force: true }); assert.equal(projection.rebuild().watermark, 6); assert.equal(projection.read(taskId).snapshot.codeDocWitnesses.length, 1); for (const target of [indexPath, executionPath, reviewPath, codeDocPath]) assert.equal(projection.readDocument(target).document?.body, readFileSync(path.join(rootDir, "harness", target), "utf8")); projection.close();
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("review-consent derives the recorded Review digests without a packet and still rejects mismatched ones", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-consent-derived-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const repoId = workspaceId("consent-derived"), taskId = "task-derived", executionId = "execution-derived", binding = { actor, source: "local" as const };
  const reviewBinding = { actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "arbiter" } }, source: "local" as const, roles: ["$arbiter"] };
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "consent-derived" }); const store = () => makeTaskEventStore({ repoId, rootDir });
    await cell.run({ kind: "task-create", taskId, title: "Derived consent" }, binding); await cell.run({ kind: "task-start", taskId, executionId }, binding);
    const commitSha = git(rootDir, "rev-parse", "HEAD"); writeFileSync(path.join(rootDir, "submission.json"), JSON.stringify({ completionClaim: "Derived consent output is ready.", deliverables: ["derived consent"], outputs: ["machine files"], verificationNotes: ["tests"], knownGaps: [], residualRisks: [], commitSha }));
    await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, binding);
    writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "Independent review passed.", evidenceChecked: ["tests"], commitSha, iteration: 0 }));
    const reviewed = await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "review-derived", fromFile: "review.json" }, reviewBinding) as unknown as Record<string, unknown>;
    const reviewEvent = store().readEvent(String(reviewed.opId)); if (reviewEvent?.type !== "review_recorded") throw new Error("review event missing");

    const beforeTypo = store().readHead()?.revision, typo = await cell.run({ kind: "task-review-consent", taskId, executionId, reviewId: "review-typo", consentId: "consent-typo" }, binding) as unknown as Record<string, unknown>;
    assert.deepEqual({ outcome: typo.outcome, code: typo.code }, { outcome: "op_rejected", code: "invalid_command" }); assert.match(String(typo.nextAction), /recorded Review id is review-derived/u); assert.equal(store().readHead()?.revision, beforeTypo);

    const consented = await cell.run({ kind: "task-review-consent", taskId, executionId, reviewId: "review-derived", consentId: "consent-derived" }, binding) as unknown as Record<string, unknown>;
    assert.equal(consented.outcome, "applied", JSON.stringify(consented));
    const consentEvent = store().readEvent(String(consented.opId)); if (consentEvent?.type !== "review_consent_recorded") throw new Error("consent event missing");
    assert.equal(consentEvent.payload.consent.reviewDigest, reviewDigest(reviewEvent.payload.review));
    assert.equal(consentEvent.payload.consent.contentDigest, reviewEvent.payload.review.contentDigest);
    assert.deepEqual({ reviewDigest: consented.reviewDigest, contentDigest: consented.contentDigest }, { reviewDigest: reviewDigest(reviewEvent.payload.review), contentDigest: reviewEvent.payload.review.contentDigest });

    // Negative control: an operator-supplied packet with a well-formed but wrong digest must still be rejected.
    const mismatchTaskId = "task-mismatch", mismatchExecutionId = "execution-mismatch";
    await cell.run({ kind: "task-create", taskId: mismatchTaskId, title: "Mismatch consent" }, binding); await cell.run({ kind: "task-start", taskId: mismatchTaskId, executionId: mismatchExecutionId }, binding);
    writeFileSync(path.join(rootDir, "submission.json"), JSON.stringify({ completionClaim: "Mismatch consent output is ready.", deliverables: ["mismatch consent"], outputs: ["machine files"], verificationNotes: ["tests"], knownGaps: [], residualRisks: [], commitSha }));
    await cell.run({ kind: "task-submit", taskId: mismatchTaskId, executionId: mismatchExecutionId, fromFile: "submission.json" }, binding);
    const mismatchReviewed = await cell.run({ kind: "task-review-execution", taskId: mismatchTaskId, executionId: mismatchExecutionId, reviewId: "review-mismatch", fromFile: "review.json" }, reviewBinding) as unknown as Record<string, unknown>;
    const real = String(mismatchReviewed.reviewDigest), flipped = `sha256:${real[7] === "0" ? "1" : "0"}${real.slice(8)}`;
    writeFileSync(path.join(rootDir, "consent.json"), JSON.stringify({ reviewDigest: flipped, contentDigest: mismatchReviewed.contentDigest }));
    const beforeMismatch = store().readHead()?.revision, mismatch = await cell.run({ kind: "task-review-consent", taskId: mismatchTaskId, executionId: mismatchExecutionId, reviewId: "review-mismatch", consentId: "consent-mismatch", fromFile: "consent.json" }, binding) as unknown as Record<string, unknown>;
    assert.deepEqual({ outcome: mismatch.outcome, code: mismatch.code }, { outcome: "op_rejected", code: "invalid_proof" }); assert.match(String(mismatch.nextAction), /bind the Review and reviewed content digests/u); assert.equal(store().readHead()?.revision, beforeMismatch);

    const reviewlessTaskId = "task-reviewless", reviewlessExecutionId = "execution-reviewless";
    await cell.run({ kind: "task-create", taskId: reviewlessTaskId, title: "Reviewless consent" }, binding); await cell.run({ kind: "task-start", taskId: reviewlessTaskId, executionId: reviewlessExecutionId }, binding);
    await cell.run({ kind: "task-submit", taskId: reviewlessTaskId, executionId: reviewlessExecutionId, fromFile: "submission.json" }, binding);
    const reviewless = await cell.run({ kind: "task-review-consent", taskId: reviewlessTaskId, executionId: reviewlessExecutionId, reviewId: "review-none", consentId: "consent-none" }, binding) as unknown as Record<string, unknown>;
    assert.deepEqual({ outcome: reviewless.outcome, code: reviewless.code }, { outcome: "op_rejected", code: "invalid_transition" }); assert.match(String(reviewless.nextAction), /ha task review-execution/u);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("milestone-closeout uses the normal completion facade, review, and gates exactly once", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-completion-facade-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const taskId = "task-complete", executionId = "execution-complete", packagePath = "tasks/task-complete-completion-facade", binding = { actor, source: "local" as const };
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("completion-facade"), rootDir: canonicalRoot(rootDir), ownerId: "completion-daemon" }); const store = () => makeTaskEventStore({ repoId: "completion-facade", rootDir });
    await cell.run({ kind: "task-create", taskId, title: "Completion facade", presetId: "milestone-closeout" }, binding); await cell.run({ kind: "task-start", taskId, executionId }, binding);
    const activeRevision = store().read().revision, active = await cell.run({ kind: "task-complete", taskId, executionId, ci: "passed" }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: active.outcome, code: active.code, stoppedAt: active.stoppedAt, next: active.next }, { outcome: "op_rejected", code: "not_in_review", stoppedAt: "not_in_review", next: [{ command: `ha task submit ${taskId} --execution-id ${executionId} --from-file <submission.json>`, reason: "Complete never submits or starts an execution; reach in_review first." }] }); assert.equal(store().read().revision, activeRevision);
    await cell.run({ kind: "task-progress-append", taskId, text: "implementation complete", evidence: [] }, binding); await cell.run({ kind: "fact-record", taskId, statement: "Completion uses canonical witnesses.", evidenceSource: "test:completion", confidence: "high", memoryClass: "semantic", memoryTags: ["completion"] }, binding);
    const closeoutPath = `${packagePath}/closeout.md`, artifactPath = `${packagePath}/artifacts/evidence.md`; writeFileSync(path.join(rootDir, "harness", closeoutPath), "# Closeout\n\n## Summary\n\nComplete.\n\n## Verification\n\nAll checks passed.\n\n## Residual Risk\n\nNone.\n"); writeFileSync(path.join(rootDir, "harness", artifactPath), "# Evidence\n\nCanonical flow.\n");
    const commitSha = git(rootDir, "rev-parse", "HEAD"); writeFileSync(path.join(rootDir, "submission.json"), JSON.stringify({ completionClaim: "All required outputs are complete.", deliverables: ["completion facade"], outputs: [artifactPath], verificationNotes: ["tests"], knownGaps: [], residualRisks: [], commitSha })); await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, binding);
    const beforeReviewBlock = store().read().revision, missingReview = await cell.run({ kind: "task-complete", taskId, executionId, ci: "passed" }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: missingReview.outcome, code: missingReview.code, steps: missingReview.steps }, { outcome: "op_rejected", code: "review_missing", steps: [] }); assert.equal(store().read().revision, beforeReviewBlock);
    writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "Independent review passed.", evidenceChecked: ["tests"], commitSha, iteration: 0 })); const reviewBinding = { actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "arbiter" } }, source: "local" as const, roles: ["$arbiter"] }; await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "review-complete", fromFile: "review.json" }, reviewBinding);
    const missingConsent = await cell.run({ kind: "task-complete", taskId, executionId, ci: "passed" }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: missingConsent.outcome, code: missingConsent.code, steps: missingConsent.steps }, { outcome: "op_rejected", code: "consent_missing", steps: [] }); await cell.run({ kind: "task-review-consent", taskId, executionId, reviewId: "review-complete", consentId: "consent-complete" }, binding);
    const missingCi = await cell.run({ kind: "task-complete", taskId, executionId }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: missingCi.outcome, code: missingCi.code, steps: missingCi.steps }, { outcome: "op_rejected", code: "ci_missing", steps: [] }); const beforeCi = store().read().revision, partial = await cell.run({ kind: "task-complete", taskId, executionId, ci: "passed" }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: partial.outcome, code: partial.code, stoppedAt: partial.stoppedAt, stepTypes: (partial.steps as { eventId?: string }[]).map((step) => store().readEvent(String(step.opId))?.type) }, { outcome: "op_rejected", code: "code_doc_missing", stoppedAt: "code_doc_missing", stepTypes: ["completion_gate_verified"] }); assert.equal(store().read().revision, beforeCi + 1); assert.equal((await cell.run({ kind: "task-show", taskId }, binding)).evidence.includes('"gateWitnesses"'), true);
    const beforeDenied = store().read().revision, denied = await cell.run({ kind: "task-complete", taskId, executionId, commitSha, iteration: 0, paths: ["packages/kernel/src/domain/task.ts"] }, { ...binding, docWriteAllowed: false }) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: denied.outcome, code: denied.code, stoppedAt: denied.stoppedAt, stepTypes: (denied.steps as { opId: string }[]).map((step) => store().readEvent(step.opId)?.type) }, { outcome: "op_rejected", code: "rbac_forbidden", stoppedAt: "doc-sync-settlement", stepTypes: ["code_doc_reconciled", undefined] }); assert.equal(store().read().revision, beforeDenied + 1); const completed = await cell.run({ kind: "task-complete", taskId, executionId }, binding) as unknown as Record<string, unknown>; assert.equal(completed.outcome, "applied", JSON.stringify(completed)); assert.equal(completed.stoppedAt, undefined); assert.deepEqual((completed.steps as { opId: string }[]).map((step) => store().readEvent(step.opId)?.type), ["documents_written", "task_completed"]); assert.deepEqual(completed.gateChecks, [{ gate: "ci", status: "pass", witnessRef: (completed.gateChecks as { witnessRef: string }[])[0]!.witnessRef }, { gate: "code-doc-reconciliation", status: "pass", witnessRef: (completed.gateChecks as { witnessRef: string }[])[1]!.witnessRef }]); assert.deepEqual(completed.next, []); assert.equal(readFileSync(path.join(rootDir, "harness", closeoutPath), "utf8").includes("All checks passed"), true); assert.equal(readFileSync(path.join(rootDir, "harness", artifactPath), "utf8").includes("Canonical flow"), true);
    const completeEvent = store().readEvent(String(completed.opId)); assert.equal(completeEvent?.type, "task_completed"); assert.equal(store().read().events.filter((event) => event.type === "task_completed").length, 1); assert.equal(store().read().events.filter((event) => event.type !== "task_completed").every((event) => event.schema !== "task-event/v1" || event.payload.task.status !== "done"), true); const revision = store().read().revision, repeated = await cell.run({ kind: "task-complete", taskId, executionId }, binding); assert.equal(repeated.opId, completed.opId); assert.equal(store().read().revision, revision);
    await cell.close(); cell = undefined; const rebuilt = makeTaskProjection({ rootDir, eventStore: store() }); rebuilt.close(); rmSync(rebuilt.path, { force: true }); rebuilt.rebuild(); assert.equal(rebuilt.read(taskId).snapshot.task?.status, "done"); assert.equal(rebuilt.read(taskId).snapshot.gateWitnesses.length, 1); rebuilt.close();
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("CompleteTask response loss settles by stable receipt and never publishes a second completion", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-complete-unknown-")), taskId = "task-unknown-complete", executionId = "execution-unknown-complete", repoId = workspaceId("complete-unknown"); let armed = false, cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "complete-unknown-one", killpoint: (point) => { if (armed && point === "before_response_write") { armed = false; throw new Error("response lost"); } } }); await prepareReadyCompletion(cell, rootDir, taskId, executionId, "Unknown complete"); const store = () => makeTaskEventStore({ repoId, rootDir }), before = store().read().revision; armed = true;
    const unknown = await cell.run({ kind: "task-complete", taskId, executionId }, { actor, source: "local" }) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: unknown.outcome, code: unknown.code, stoppedAt: unknown.stoppedAt }, { outcome: "indeterminate", code: "publication_indeterminate", stoppedAt: "complete-settlement" }); assert.match(String((unknown.next as { command: string }[])[0]?.command), new RegExp(`receipt show ${unknown.opId}`, "u")); assert.equal(store().read().revision, before + 1); assert.equal(store().read().events.filter((event) => event.type === "task_completed").length, 1); assert.equal(cell.status().state, "attached"); await cell.close(); cell = undefined;
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "complete-unknown-two" }); const settled = await cell.run({ kind: "receipt-show", opId: String(unknown.opId) }, { actor, source: "local" }), retried = await cell.run({ kind: "task-complete", taskId, executionId }, { actor, source: "local" }); assert.equal(settled.outcome, "applied", JSON.stringify(settled)); assert.equal(retried.outcome, "applied", JSON.stringify(retried)); assert.equal(retried.opId, unknown.opId); assert.equal(store().read().revision, before + 1); assert.equal(store().read().events.filter((event) => event.type === "task_completed").length, 1);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("Fact record publishes one event, L2 row, authored facts document, and supersession history", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-invalid-fact-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("invalid-fact"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" });
    const receipt = await cell.run({ kind: "fact-record", taskId: "task-fact", statement: "Observed", evidenceSource: "test", confidence: "high", memoryClass: "semantic", memoryTags: [],
      supersedes: { factRef: "fact/task-fact/F-ABCDEFGH", rationale: "x".repeat(200) } }, { actor, source: "local" });
    assert.deepEqual({ outcome: receipt.outcome, code: receipt.code, state: cell.status().state }, { outcome: "op_rejected", code: "invalid_command", state: "attached" });
    assert.equal(makeTaskEventStore({ repoId: "invalid-fact", rootDir }).readHead(), null);
    const binding = { actor, source: "local" as const }; assert.equal((await cell.run({ kind: "task-create", taskId: "task-fact", title: "Fact History" }, binding)).outcome, "applied"); const factsPath = "tasks/task-fact-fact-history/facts.md", factsFile = path.join(rootDir, "harness", factsPath); assert.equal(readFileSync(factsFile, "utf8"), "# Facts\n\nManaged by `ha fact record`; hand edits are rejected.\n\n## Records\n\n");
    const firstAction = { kind: "fact-record", taskId: "task-fact", statement: "Canonical facts are event-backed.", evidenceSource: "test:first", confidence: "high", memoryClass: "semantic", memoryTags: ["pattern"] }, first = await cell.run(firstAction, binding) as Record<string, unknown>; assert.equal(first.outcome, "applied", JSON.stringify(first)); assert.equal(first.path, factsPath); assert.equal(first.worktreeVisible, true); assert.equal(first.commitSha, git(rootDir, "rev-parse", "HEAD")); const replay = await cell.run(firstAction, binding); assert.deepEqual({ opId: replay.opId, revision: replay.revision, head: git(rootDir, "rev-parse", "HEAD") }, { opId: first.opId, revision: first.revision, head: first.commitSha }); const firstId = String(first.factId), firstEvent = makeTaskEventStore({ repoId: "invalid-fact", rootDir }).readEvent(String(first.opId)); assert.equal(firstEvent?.schema, "fact-event/v1"); if (firstEvent?.schema === "fact-event/v1") { assert.equal(firstEvent.payload.factsDocumentClaim.path, factsPath); assert.equal(firstEvent.workspaceRevision, first.revision); }
    const second = await cell.run({ kind: "fact-record", taskId: "task-fact", statement: "Canonical facts also backwrite Markdown.", evidenceSource: "test:second", confidence: "high", memoryClass: "semantic", memoryTags: ["pattern"], supersedes: { factRef: `fact/task-fact/${firstId}`, rationale: "The stronger observation supersedes the first." } }, binding) as Record<string, unknown>; assert.equal(second.outcome, "applied", JSON.stringify(second)); const body = readFileSync(factsFile, "utf8"); assert.match(body, new RegExp(`### ${firstId}[\\s\\S]*State: superseded_fact`, "u")); assert.match(body, new RegExp(`### ${String(second.factId)}[\\s\\S]*State: standing`, "u")); const shown = await cell.run({ kind: "fact-show", taskId: "task-fact", factId: firstId }, binding); assert.equal((JSON.parse(String(shown.evidence)) as { fact: { state: string } }).fact.state, "superseded_fact"); assert.equal(makeTaskEventStore({ repoId: "invalid-fact", rootDir }).readHead()?.revision, 3);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("invalid Decision payload stays invalid_command and reckon records exact projected basis", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-decision-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("decision-cell"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" }); const binding = { actor, source: "local" as const };
    assert.equal((await cell.run({ kind: "task-create", taskId: "task-decision", title: "Decision evidence" }, binding)).outcome, "applied");
    const beforeMissing = makeTaskEventStore({ repoId: "decision-cell", rootDir }).readHead()!.revision, missing = await cell.run({ kind: "decision-reckon", decisionId: "dec_MISSING", taskId: "task-decision" }, binding);
    assert.deepEqual({ outcome: missing.outcome, code: missing.code, state: cell.status().state }, { outcome: "op_rejected", code: "entity_not_found", state: "attached" }); assert.equal(makeTaskEventStore({ repoId: "decision-cell", rootDir }).readHead()?.revision, beforeMissing);
    const proposal = decisionProposal("Canonical", "Should reckon use the exact basis?"), packet = JSON.parse(proposal.jsonInput) as Record<string, unknown>, proposed = await cell.run({ ...proposal, jsonInput: JSON.stringify({ ...packet, relations: [{ anchor: "CH1", type: "derives", target: "task/task-decision", rationale: "Decision creates this task." }] }) }, binding);
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed)); const decisionId = (JSON.parse(proposed.evidence) as { decisionId: string }).decisionId, decisionPath = `decisions/decision-${decisionId}/decision.md`, decisionFile = path.join(rootDir, "harness", decisionPath), beforeInvalid = makeTaskEventStore({ repoId: "decision-cell", rootDir }).readHead()!.revision;
    assert.deepEqual({ path: (proposed as Record<string, unknown>).path, worktreeVisible: (proposed as Record<string, unknown>).worktreeVisible, commitSha: (proposed as Record<string, unknown>).commitSha }, { path: decisionPath, worktreeVisible: true, commitSha: git(rootDir, "rev-parse", "HEAD") });
    const placement = (await cell.read("repo.tasks.list")).rows.find((row) => row.taskId === "task-decision")!.placement; assert.equal(placement.moduleKeys.includes("daemon"), true, JSON.stringify(placement)); assert.equal(placement.provenance.some(({ kind }) => kind === "decision-relation"), true, JSON.stringify(placement));
    const decisionBody = readFileSync(decisionFile, "utf8"); assert.match(decisionBody, /^---\nschema: decision-package\/v1[\s\S]*\nstate: proposed[\s\S]*\n---\n\n# Canonical\n$/u); const decisionEvent = makeTaskEventStore({ repoId: "decision-cell", rootDir }).readEvent(proposed.opId); assert.equal(decisionEvent?.schema, "decision-event/v1"); if (decisionEvent?.schema === "decision-event/v1") { assert.equal(decisionEvent.payload.decisionDocumentClaim.path, decisionPath); assert.equal(decisionEvent.payload.decisionDocumentClaim.sha256, String((proposed as Record<string, unknown>).documentSha256)); }
    const invalid = await cell.run({ kind: "decision-accept", decisionId, rationale: "x".repeat(200) }, { actor: { principal: { personId: "person-arbiter" }, executor: null }, source: "local", roles: ["$arbiter"] });
    assert.deepEqual({ outcome: invalid.outcome, code: invalid.code, state: cell.status().state }, { outcome: "op_rejected", code: "invalid_command", state: "attached" }); assert.equal(makeTaskEventStore({ repoId: "decision-cell", rootDir }).readHead()?.revision, beforeInvalid);
    const reckon = await cell.run({ kind: "decision-reckon", decisionId, taskId: "task-decision" }, binding); assert.equal(reckon.outcome, "applied", JSON.stringify(reckon)); const fact = JSON.parse(reckon.evidence) as { evidenceSource: string; statement: string; workspaceRevision: number };
    assert.equal(fact.evidenceSource, `decision/${decisionId}@${beforeInvalid}`); assert.match(fact.statement, new RegExp(`basisRevision ${beforeInvalid}`, "u")); assert.equal(fact.workspaceRevision, beforeInvalid + 1);
    const stable = await cell.run({ kind: "receipt-show", opId: proposed.opId }, binding) as Record<string, unknown>, currentCut = git(rootDir, "rev-parse", "HEAD"); assert.deepEqual({ consentId: stable.consentId, path: stable.path, commitSha: stable.commitSha, documentSha256: stable.documentSha256, worktreeVisible: stable.worktreeVisible }, { consentId: (proposed as Record<string, unknown>).consentId, path: (proposed as Record<string, unknown>).path, commitSha: currentCut, documentSha256: (proposed as Record<string, unknown>).documentSha256, worktreeVisible: true }); assert.equal(stable.commitSha, currentCut);
    const event = makeTaskEventStore({ repoId: "decision-cell", rootDir }).readEvent(reckon.opId); assert.equal(event?.schema, "fact-event/v1"); if (event?.schema === "fact-event/v1") assert.equal(event.payload.evidenceSource, fact.evidenceSource);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("Decision proposal packet is closed, UTF-8, atomic, and leaves the related Task INDEX untouched", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-packet-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("decision-packet"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" }); const binding = { actor, source: "local" as const }, created = await cell.run({ kind: "task-create", taskId: "task-related", title: "Related Task" }, binding) as Record<string, unknown>, index = path.join(rootDir, "harness", String(created.packagePath), "INDEX.md"), indexBefore = readFileSync(index); const packet = { title: "Atomic proposal", question: "Can one event publish the whole proposal?", riskTier: "medium", urgency: "high", vertical: "default", preset: "default", decisionClass: "ordinary", appliesTo: { modules: ["daemon"], productLines: [] }, chosen: [{ id: "CH1", text: "Publish once" }], rejected: [{ id: "RJ1", text: "Patch later", whyNot: "It exposes partial state" }], claims: [{ id: "C1", text: "The packet is atomic.", loadBearing: true }], fulfillments: [{ claimId: "C1", mode: "delivered" }], relations: [{ anchor: "C1", type: "derives", target: "task/task-related", rationale: "The Decision creates this delivery." }] }, missingPacket = (({ relations: _relations, ...missing }) => missing)(packet), before = makeTaskEventStore({ repoId: "decision-packet", rootDir }).readHead()!.revision;
    for (const action of [{ kind: "decision-propose", jsonInput: JSON.stringify({ ...packet, unknown: true }) }, { kind: "decision-propose", jsonInput: JSON.stringify(missingPacket) }, { kind: "decision-propose", jsonInput: JSON.stringify(packet), body: "inline", bodyFile: "body.md" }] as const) { const rejected = await cell.run(action, binding); assert.equal(rejected.outcome, "op_rejected"); assert.equal(rejected.code, "invalid_command"); assert.equal(makeTaskEventStore({ repoId: "decision-packet", rootDir }).readHead()?.revision, before); }
    writeFileSync(path.join(rootDir, "proposal.json"), JSON.stringify(packet)); writeFileSync(path.join(rootDir, "bad.md"), Buffer.from([0xff])); const invalidUtf8 = await cell.run({ kind: "decision-propose", fromFile: "proposal.json", bodyFile: "bad.md" }, binding); assert.equal(invalidUtf8.code, "invalid_command"); assert.equal(makeTaskEventStore({ repoId: "decision-packet", rootDir }).readHead()?.revision, before);
    const prose = "# Atomic proposal\n\n初始正文。\n"; writeFileSync(path.join(rootDir, "body.md"), prose); const proposed = await cell.run({ kind: "decision-propose", fromFile: "proposal.json", bodyFile: "body.md" }, binding) as Record<string, unknown>; assert.equal(proposed.outcome, "applied", JSON.stringify(proposed)); assert.equal(proposed.revision, before + 1); const event = makeTaskEventStore({ repoId: "decision-packet", rootDir }).readEvent(String(proposed.opId)); assert.equal(event?.schema, "decision-event/v1"); if (event?.schema === "decision-event/v1" && event.type === "decision_proposed") { assert.deepEqual(event.payload.claims, packet.claims); assert.deepEqual(event.payload.fulfillments, packet.fulfillments); assert.equal(event.payload.relations.length, 1); assert.equal(event.payload.relations[0]?.source.endsWith("/C1"), true); assert.match(event.payload.relations[0]?.relation_id ?? "", /^rel_[0-9a-f]{16}$/u); assert.equal(event.payload.body, prose); }
    const decisionId = (JSON.parse(String(proposed.evidence)) as { decisionId: string }).decisionId, document = readFileSync(path.join(rootDir, "harness", `decisions/decision-${decisionId}/decision.md`), "utf8"), projection = makeTaskProjection({ rootDir, eventStore: makeTaskEventStore({ repoId: "decision-packet", rootDir }) }), projected = projection.readDecision(decisionId).decision; assert.equal(document.endsWith(`---\n${prose}`), true); assert.deepEqual(projected?.claims, [{ ...packet.claims[0], fulfillment: "delivered" }]); assert.deepEqual(readFileSync(index), indexBefore); assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical"), "3"); projection.close();
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("Decision judgment keeps the transport arbiter gate and returns the embedded consent identity", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-decision-consent-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("decision-consent"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" }); const human = { principal: { personId: "person-ceo" }, executor: null } as const, binding = { actor: human, source: "local" as const }, proposed = await cell.run(decisionProposal("Consent", "May the CEO judge this proposal?"), binding), decisionId = (JSON.parse(proposed.evidence) as { decisionId: string }).decisionId, before = makeTaskEventStore({ repoId: "decision-consent", rootDir }).readHead()!.revision;
    const denied = await cell.run({ kind: "decision-accept", decisionId, rationale: "CEO approval", judgmentOnlyRationale: "Explicit CEO judgment." }, binding); assert.deepEqual({ outcome: denied.outcome, code: denied.code }, { outcome: "op_rejected", code: "actor_unauthorized" }); assert.equal(makeTaskEventStore({ repoId: "decision-consent", rootDir }).readHead()?.revision, before);
    const accepted = await cell.run({ kind: "decision-accept", decisionId, rationale: "CEO approval", judgmentOnlyRationale: "Explicit CEO judgment." }, { ...binding, roles: ["$arbiter"] }); assert.equal(accepted.outcome, "applied", JSON.stringify(accepted)); assert.match(String((accepted as Record<string, unknown>).consentId), /^djc_[0-9a-f]{26}$/u); const event = makeTaskEventStore({ repoId: "decision-consent", rootDir }).readEvent(accepted.opId); assert.equal(event?.schema, "decision-event/v1"); if (event?.schema === "decision-event/v1" && event.type === "decision_accepted") assert.equal(event.payload.judgmentConsent.consentId, (accepted as Record<string, unknown>).consentId);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("Decision full vertical golden rebuilds proposal, prose, claim, relation, consent, list, and show", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-vertical-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); mkdirSync(path.join(rootDir, "packages/daemon"), { recursive: true }); writeFileSync(path.join(rootDir, "packages/daemon/index.ts"), "export const daemon = true;\n"); git(rootDir, "add", "."); git(rootDir, "commit", "--quiet", "-m", "add daemon scope"); cell = await openRepoCell({ repoId: workspaceId("decision-vertical"), rootDir: canonicalRoot(rootDir), ownerId: "decision-vertical" }); const binding = { actor, source: "local" as const }, proposal = await cell.run(decisionProposal("Vertical Decision", "Does the full Decision flow rebuild?"), binding), decisionId = (JSON.parse(String(proposal.evidence)) as { decisionId: string }).decisionId, logical = `decisions/decision-${decisionId}/decision.md`, target = path.join(rootDir, "harness", logical), canonical = readFileSync(target, "utf8"), split = canonical.indexOf("\n---\n", 4) + 5, prose = "\n# Vertical Decision\n\nCanonical body from doc-sync.\n"; writeFileSync(target, `${canonical.slice(0, split)}${prose}`);
    const synced = await cell.run({ kind: "doc-submit", paths: [logical] }, binding); assert.equal(synced.outcome, "applied", JSON.stringify(synced)); assert.equal((await cell.run({ kind: "decision-claim-add", decisionId, claimId: "C1", text: "The vertical flow is event-derived.", loadBearing: true }, binding)).outcome, "applied"); assert.equal((await cell.run({ kind: "decision-relate", decisionId, anchor: "C1", relationType: "supports", target: `decision/${decisionId}/CH1`, rationale: "The chosen option demonstrates the claim." }, binding)).outcome, "applied"); const accepted = await cell.run({ kind: "decision-accept", decisionId, rationale: "Evidence relation reviewed.", judgmentOnlyRationale: null }, { actor: { principal: { personId: "person-ceo" }, executor: null }, source: "local", roles: ["$arbiter"] }); assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    const invalidList = await cell.run({ kind: "decision-list", legacyRange: { start: 10, end: 2 }, authoredFallback: true }, binding); assert.equal(invalidList.code, "invalid_command"); const listed = JSON.parse(String((await cell.run({ kind: "decision-list", search: "Canonical body" }, binding)).evidence)) as { decisions: readonly Record<string, unknown>[] }, shown = JSON.parse(String((await cell.run({ kind: "decision-show", decisionId, includeBody: true }, binding)).evidence)) as { decision: { state: string; body: { body: string }; claims: readonly unknown[]; judgmentConsents: readonly unknown[] } }; assert.deepEqual(listed.decisions.map(({ decisionId: id }) => id), [decisionId]); assert.equal(Object.hasOwn(listed.decisions[0]!, "body"), false); assert.deepEqual({ state: shown.decision.state, body: shown.decision.body.body, claims: shown.decision.claims.length, consents: shown.decision.judgmentConsents.length }, { state: "in_effect", body: prose, claims: 1, consents: 1 }); const gui = await cell.read("repo.decisions.list"), graph = await cell.read("repo.triadic.relationGraph"); assert.deepEqual(gui.decisions.map(({ decisionId: id }) => id), listed.decisions.map(({ decisionId: id }) => id)); assert.equal(gui.decisions[0]?.readiness?.conflictMarker.state, "clear"); assert.deepEqual(validateDaemonDecisionList(gui), []); assert.equal(graph.edges.some((edge) => edge.sourceRef === `decision/${decisionId}/C1` && edge.targetRef === `decision/${decisionId}/CH1`), true); // #1542: event-backed truth already answers this read (all three projections are ready),
    // so an unmaterialized generated cache is not a gap in what was served and must not
    // leak through as a permanent hard-fail warning on an otherwise fully-answered read.
    assert.deepEqual(graph.warnings, []);
    const store = makeTaskEventStore({ repoId: "decision-vertical", rootDir }), projection = makeTaskProjection({ rootDir, eventStore: store }), before = { decision: projection.readDecision(decisionId).decision, document: projection.readDocument(logical).document, graph: projection.readDecisionGraph() }; projection.close(); rmSync(projection.path); projection.rebuild(); assert.deepEqual({ decision: projection.readDecision(decisionId).decision, document: projection.readDocument(logical).document, graph: projection.readDecisionGraph() }, before); projection.close();
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("receipt lookup reports Git object-store failure as indeterminate and marks the RepoCell unavailable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-corrupt-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("corrupt"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" });
    const applied = await cell.run({ kind: "task-create", taskId: "task-corrupt", title: "Corrupt" }, { actor, source: "local" }); assert.equal(applied.outcome, "applied");
    rmSync(path.join(rootDir, ".git/objects"), { recursive: true, force: true });
    const receipt = await cell.run({ kind: "receipt-show", opId: applied.opId }, { actor, source: "local" });
    assert.deepEqual({ outcome: receipt.outcome, code: receipt.code, origin: receipt.origin }, { outcome: "indeterminate", code: "vcs_command_failed", origin: "git" });
    assert.match(receipt.nextAction ?? "", /repair.*object.*retry/iu); assert.equal(cell.status().state, "unavailable");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

for (const killpoint of ["before_event_write", "after_event_write", "after_head_write", "after_git_commit", "before_worktree_rename", "after_worktree_rename",
  "after_sqlite_commit", "before_response_write", "after_response_write"] as const) {
  test(`RepoCell new generation recovers ${killpoint} without a duplicate publication`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-crash-"));
    const action = { kind: "task-create", taskId: `task-${killpoint}`, title: killpoint } as const;
    let crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined, recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initRepo(rootDir); crashed = await openRepoCell({ repoId: workspaceId("crash"), rootDir: canonicalRoot(rootDir), ownerId: "generation-one",
        killpoint: (point) => { if (point === killpoint) throw new Error(`crash:${point}`); } });
      const first = await crashed.run(action, { actor, source: "local" });
      assert.equal(first.outcome, "op_rejected"); assert.equal(crashed.status().state, "unavailable");
      const prePublicationCrash = ["before_event_write", "after_event_write"].includes(killpoint); assert.equal(makeTaskEventStore({ repoId: "crash", rootDir }).read().revision, ["before_event_write", "after_event_write", "after_head_write"].includes(killpoint) ? 0 : 1);
      await crashed.close(); crashed = undefined;
      recovered = await openRepoCell({ repoId: workspaceId("crash"), rootDir: canonicalRoot(rootDir), ownerId: "generation-two" });
      const settled = await recovered.run({ kind: "receipt-show", opId: first.opId }, { actor, source: "local" });
      assert.equal(settled.outcome, prePublicationCrash ? "op_rejected" : "applied", JSON.stringify(settled));
      if (prePublicationCrash) {
        const retried = await recovered.run(action, { actor, source: "local" });
        assert.equal(retried.outcome, "applied", JSON.stringify(retried));
      }
      assert.equal(makeTaskEventStore({ repoId: "crash", rootDir }).read().events.filter((event) => event.opId === first.opId).length, 1);
      assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical"), "2");
    } finally { await crashed?.close(); await recovered?.close(); rmSync(rootDir, { recursive: true, force: true }); }
  });
}

test("every latched RepoCell exit declares the latch and the cause identically while the fault persists", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-latch-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("latch"), rootDir: canonicalRoot(rootDir), ownerId: "latch-one" }); const binding = { actor, source: "local" as const };
    await cell.run({ kind: "task-create", taskId: "task-latch", title: "Latch" }, binding);
    await cell.close(); cell = undefined;
    // A lagging append plus a flat entry in the sharded events root latches the first ledger read
    // (see repo-cell-latch-recovery.test.ts); the fault persists, so the latch must keep declaring.
    const lagging: TaskEventV1 = { schema: "task-event/v1", eventId: "event-task-lagging", workspaceRevision: 2, opId: "op-task-lagging", taskId: "task-lagging", type: "task_created", actor, source: "local", occurredAt: "2026-08-18T00:00:00.000Z", payload: { task: { schema: "task/v1", taskId: "task-lagging", title: "Lagging", taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0, createdBy: actor, completionGateIds: [], presetSnapshotDigest: null } } };
    makeTaskEventStore({ repoId: "latch", rootDir }).append({ event: lagging, plan: taskLifecycleWritePlan(lagging), blobs: [] });
    writeFileSync(path.join(rootDir, "harness/events/migration-stray.json"), "{}\n"); git(rootDir, "add", "harness/events/migration-stray.json"); git(rootDir, "commit", "-qm", "corrupt: flat entry in sharded events root"); git(rootDir, "update-ref", "refs/ha/canonical", "HEAD");
    cell = await openRepoCell({ repoId: workspaceId("latch"), rootDir: canonicalRoot(rootDir), ownerId: "latch-two" });
    const first = await cell.run({ kind: "task-list" }, binding);
    assert.equal(first.outcome, "op_rejected"); assert.equal(first.code, "invalid_store"); assert.equal(cell.status().state, "unavailable");
    assert.match(String(first.nextAction ?? ""), /events root mixes .* flat\/v1 .* sharded entries; run ha migrate ledger/u);
    const write = await cell.run({ kind: "task-create", taskId: "task-after-latch", title: "After latch" }, binding);
    const declared = String(write.nextAction ?? ""), latched = cell;
    const reads = await Promise.all([latched.read("repo.tasks.list"), latched.spawnRuntime({}, binding), latched.attach("runtime-session", ""), latched.verifyReadiness()].map((pending) => pending.then(() => "resolved without reporting the latch", reason)));
    for (const observed of reads) assert.equal(observed, declared);
    assert.match(declared, /stays latched until its ledger data verifies/u);
    assert.match(declared, /re-probes the ledger and re-attaches automatically/u);
    assert.match(declared, /Cause: events root mixes \d+ flat\/v1 and \d+ sharded entries; run ha migrate ledger to normalize and migrate the ledger$/u);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

for (const killpoint of ["after_sqlite_commit", "before_response_write", "after_response_write"] as const) {
  test(`Decision response recovery handles ${killpoint} without a duplicate authored event`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-response-crash-")), action = decisionProposal("Recover Decision", "Does the receipt settle once?"), binding = { actor, source: "local" as const };
    let crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined, recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try { initRepo(rootDir); crashed = await openRepoCell({ repoId: workspaceId("decision-response-crash"), rootDir: canonicalRoot(rootDir), ownerId: "decision-generation-one", killpoint: (point) => { if (point === killpoint) throw new Error(`crash:${point}`); } }); const first = await crashed.run(action, binding); assert.equal(first.outcome, "op_rejected"); assert.equal(crashed.status().state, "unavailable"); assert.equal(makeTaskEventStore({ repoId: "decision-response-crash", rootDir }).read().events.filter((event) => event.schema === "decision-event/v1").length, 1); await crashed.close(); crashed = undefined;
      recovered = await openRepoCell({ repoId: workspaceId("decision-response-crash"), rootDir: canonicalRoot(rootDir), ownerId: "decision-generation-two" }); const retried = await recovered.run(action, binding) as Record<string, unknown>; assert.equal(retried.outcome, "applied", JSON.stringify(retried)); assert.equal(retried.worktreeVisible, true); assert.equal(makeTaskEventStore({ repoId: "decision-response-crash", rootDir }).read().events.filter((event) => event.schema === "decision-event/v1").length, 1); assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical"), "2");
    } finally { await crashed?.close(); await recovered?.close(); rmSync(rootDir, { recursive: true, force: true }); }
  });
}

test("RepoCell doc mapping enforces strict dual CAS, holder receipts, deletion rejection, and worktree preservation", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-cell-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("docs"), rootDir: canonicalRoot(rootDir), ownerId: "doc-daemon" });
    assert.equal((await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs" }, { actor, source: "local" })).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, { actor, source: "local" })).outcome, "applied");
    const claims = path.join(rootDir, ".harness/doc-sync-claims"), authored = path.join(rootDir, "harness/context/notes.md"); mkdirSync(claims, { recursive: true }); mkdirSync(path.dirname(authored), { recursive: true });
    let body = "# Notes\nA\n"; writeFileSync(authored, body);
    const statusBefore = await cell.run({ kind: "doc-status", paths: ["context/notes.md"] }, { actor, source: "local" }); assert.equal(statusBefore.outcome, "applied"); assert.equal(statusBefore.proof?.worktreeVisible, false);
    const action = { kind: "doc-submit", executionId: "execution-doc", paths: ["context/notes.md"] } as const;
    const before = { head: git(rootDir, "rev-parse", "HEAD"), bytes: readFileSync(authored).toString("hex") }, applied = await cell.run(action, { actor, source: "local" });
    assert.equal(applied.outcome, "applied", JSON.stringify(applied)); assert.equal(applied.detail?.kind, "doc_sync"); assert.equal(applied.proof?.worktreeVisible, true); assert.notEqual(git(rootDir, "rev-parse", "HEAD"), before.head); assert.equal(git(rootDir, "rev-parse", "HEAD"), git(rootDir, "rev-parse", "refs/ha/canonical")); assert.equal(readFileSync(authored).toString("hex"), before.bytes); assert.equal(git(rootDir, "status", "--porcelain", "-uall").includes("harness/context/notes.md"), false);
    const shown = await cell.run({ kind: "receipt-show", opId: applied.opId }, { actor, source: "local" }); assert.equal(shown.outcome, "applied"); assert.equal(shown.detail?.kind, "doc_sync"); assert.equal(shown.proof?.canonicalVisible, true);
    const commits = git(rootDir, "rev-list", "--count", "refs/ha/canonical"), retried = await cell.run(action, { actor, source: "local" }); assert.equal(retried.outcome, "applied"); assert.match(retried.opId, /^noop:/u); assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical"), commits);
    const next = `${body}B\n`; writeFileSync(authored, next);
    const updated = await cell.run(action, { actor, source: "local" }); assert.equal(updated.outcome, "applied", JSON.stringify(updated)); body = next;
    rmSync(authored); const deletion = await cell.run(action, { actor, source: "local" }); assert.equal(deletion.code, "deletion_forbidden"); writeFileSync(authored, body);
    const samples: number[] = [], baselineSamples: number[] = []; for (let index = 0; index < 7; index += 1) { const baselineStarted = performance.now(); await cell.run({ kind: "task-create", taskId: `task-doc-baseline-${index}`, title: `Doc baseline ${index}` }, { actor, source: "local" }); baselineSamples.push(performance.now() - baselineStarted); const candidate = `${body}${Array.from({ length: index + 1 }, (_, n) => `line-${n}\n`).join("")}`; writeFileSync(authored, candidate); const started = performance.now(), result = await cell.run(action, { actor, source: "local" }); samples.push(performance.now() - started); assert.equal(result.outcome, "applied", JSON.stringify(result)); body = candidate; }
    const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!; const p50 = median(samples), baselineP50 = median(baselineSamples), ratio = p50 / baselineP50; context.diagnostic(`doc-single-write-relative-p50=${p50.toFixed(3)}ms baseline-p50=${baselineP50.toFixed(3)}ms ratio=${ratio.toFixed(3)}x samples=${samples.map((sample) => sample.toFixed(3)).join(",")}`); assert.equal(ratio < 4, true, `doc write p50 was ${ratio.toFixed(3)}x the paired canonical write baseline`);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("doc ingress rejects symbolic links in claim and authored path chains", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-claim-link-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("claim-link"), rootDir: canonicalRoot(rootDir), ownerId: "doc-daemon" }); const source = { kind: "assignment", nodeId: "node", assignmentId: "assignment" } as const;
    await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs" }, { actor, source }); await cell.run({ kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, { actor, source });
    const body = "# Outside\n", hash = createHash("sha256").update(body).digest("hex"), claims = path.join(rootDir, ".harness/doc-sync-claims"); mkdirSync(claims, { recursive: true }); writeFileSync(path.join(rootDir, "outside.md"), body); symlinkSync("../../outside.md", path.join(claims, "linked"));
    const binding = { actor, source, assignmentScope: { repoId: "claim-link", taskId: "task-doc", executionId: "execution-doc", paths: ["context/link.md"] } }, base = git(rootDir, "rev-parse", "refs/ha/canonical"), result = await cell.run({ kind: "doc-submit", executionId: "execution-doc", baseLedgerSha: base, changes: [{ path: "context/link.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { ref: "doc-sync-claims/linked", sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" } }] }, binding);
    assert.equal(result.code, "content_claim_mismatch"); assert.equal(git(rootDir, "rev-parse", "refs/ha/canonical"), base);
    writeFileSync(path.join(claims, "plain"), body); mkdirSync(path.join(rootDir, "harness/context"), { recursive: true }); symlinkSync("../../outside.md", path.join(rootDir, "harness/context/link.md"));
    const authoredLink = await cell.run({ kind: "doc-submit", executionId: "execution-doc", baseLedgerSha: base, changes: [{ path: "context/link.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { ref: "doc-sync-claims/plain", sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" } }] }, binding);
    assert.equal(authoredLink.code, "invalid_command"); assert.equal(git(rootDir, "rev-parse", "refs/ha/canonical"), base);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("bootstrap concurrent writer admission commits one complete workspace", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-writer-")), rootDir = path.join(parent, "repo");
  const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0,
    source: "unix-socket-filesystem-owner-boundary" } } as const;
  const hosts = await Promise.all(["one", "two"].map((daemonId) => openDaemonHost({ daemonId, userRoot: path.join(parent, daemonId) })));
  try { const results = await Promise.allSettled(hosts.map((host) => host.bootstrap({ rootDir, repoId: "fresh", personId: "owner", displayName: "Owner" }, auth)));
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1); assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    const ledgerRoot = path.join(rootDir, "harness"); assert.equal(git(ledgerRoot, "rev-list", "--count", "HEAD"), "1"); assert.equal(git(rootDir, "check-ignore", "harness"), "harness"); assert.equal(git(rootDir, "check-ignore", ".harness"), ".harness"); }
  finally { await Promise.all(hosts.map((host) => host.close())); rmSync(parent, { recursive: true, force: true }); }
});

test("bootstrap binds the ledger repository branch independently of the project branch", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-branch-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0,
    source: "unix-socket-filesystem-owner-boundary" } } as const;
  mkdirSync(rootDir, { recursive: true }); initRepo(rootDir); git(rootDir, "branch", "-M", "main"); git(rootDir, "branch", "feature"); git(rootDir, "checkout", "--quiet", "feature");
  git(rootDir, "update-ref", "refs/remotes/origin/main", "refs/heads/main"); git(rootDir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  let host = await openDaemonHost({ daemonId: "bootstrap-one", userRoot });
  try {
    const initialized = await host.bootstrap({ rootDir, repoId: "branch-bound", personId: "owner", displayName: "Owner" }, auth); assert.equal(initialized.outcome, "applied");
    const ledgerRoot = path.join(rootDir, "harness"), registered = readDaemonRegistry({ userRoot }).repos.find((repo) => repo.repoId === "branch-bound"), ledgerBranch = git(ledgerRoot, "branch", "--show-current"); assert.equal(registered?.authoredBranch, ledgerBranch);
    assert.equal(git(ledgerRoot, "rev-parse", "refs/ha/canonical"), git(ledgerRoot, "rev-parse", `refs/heads/${ledgerBranch}`)); assert.equal(git(rootDir, "branch", "--show-current"), "feature");
    await host.close(); host = await openDaemonHost({ daemonId: "bootstrap-two", userRoot }); await host.attachmentsSettled();
    const afterRestart = await host.run("branch-bound", { kind: "task-create", taskId: "task-after-restart", title: "After restart" }, auth); assert.equal(afterRestart.outcome, "applied", JSON.stringify(afterRestart));
    assert.equal(git(ledgerRoot, "rev-parse", "refs/ha/canonical"), git(ledgerRoot, "rev-parse", `refs/heads/${ledgerBranch}`)); assert.equal(git(rootDir, "branch", "--show-current"), "feature");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("bootstrap validates local identity before repository initialization", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-identity-")), rootDir = path.join(parent, "repo"), host = await openDaemonHost({ daemonId: "bootstrap-identity", userRoot: path.join(parent, "user") });
  try { await assert.rejects(host.bootstrap({ rootDir, repoId: "identity", personId: "owner", displayName: "Owner" }, { transportKind: "unix-socket" }), hasCode("bootstrap_identity_unavailable")); assert.equal(existsSync(path.join(rootDir, ".git")), false); }
  finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("unrelated workspace lock collision does not block either workspace", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-lock-collision-")), owners = new Map<number, string>(); let roots: string[] | undefined;
  for (let index = 0; index < 1_000 && !roots; index += 1) { const root = path.join(parent, `repo-${index}`), port = 40_000 + Number.parseInt(createHash("sha256").update(root).digest("hex").slice(0, 4), 16) % 20_000;
    const prior = owners.get(port); if (prior) roots = [prior, root]; else owners.set(port, root); }
  assert.ok(roots, "fixture must find roots that collide under the retired 16-bit TCP-port lock");
  roots.forEach((root) => { mkdirSync(root); initRepo(root); }); const cells = await Promise.all(roots.map((rootDir, index) => openRepoCell({ repoId: workspaceId(`repo-${index}`),
    rootDir: canonicalRoot(rootDir), ownerId: `daemon-${index}` })));
  try { assert.deepEqual(cells.map((cell) => cell.status().state), ["attached", "attached"]); }
  finally { await Promise.all(cells.map((cell) => cell.close())); rmSync(parent, { recursive: true, force: true }); }
});

test("JSON-RPC failure receipt carries formal operation identity and origin", async () => {
  const host = { run: async () => { throw new Error("unused"); }, read: async () => { throw new Error("unused"); }, attach: async () => { throw new Error("unused"); }, issueRuntimeWitness: async () => { throw new Error("unused"); }, bindRuntimeWitness: () => { throw new Error("unused"); }, publishRuntimeWitness: () => { throw new Error("unused"); }, bootstrap: async () => ({}), admin: async () => ({}),
    status: () => ({ daemonId: "test", pid: process.pid, repos: [] }), close: async () => undefined };
  const server = createJsonRpcProtocolServer({ host, authContext: { transportKind: "unix-socket" }, emit: async () => undefined });
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: -1 } });
  assert.ok(response && !Array.isArray(response) && "result" in response); if (response && !Array.isArray(response) && "result" in response) {
    const receipt = response.result as Record<string, unknown>; assert.equal(receipt.outcome, "op_rejected"); assert.equal(receipt.opId, "N/A"); assert.equal(receipt.origin, "daemon"); }
  await server.handle({ jsonrpc: "2.0", id: 2, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });
  const malformed = await server.handle({ jsonrpc: "2.0", id: 3, method: "daemon.status", params: "not-an-object" });
  assert.ok(malformed && !Array.isArray(malformed) && "result" in malformed); if (malformed && !Array.isArray(malformed) && "result" in malformed) assert.equal((malformed.result as Record<string, unknown>).code, "invalid_request");
});

test("local daemon stop acknowledges the control request and triggers shutdown", async () => {
  let shutdowns = 0;
  const host = { status: () => ({ daemonId: "stop-test", pid: process.pid, repos: [] }) } as never;
  const server = createJsonRpcProtocolServer({ host, authContext: { transportKind: "unix-socket" }, emit: async () => undefined, requestShutdown: () => { shutdowns += 1; } });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "daemon.stop", params: {} });
  assert.ok(response && !Array.isArray(response) && "result" in response); if (response && !Array.isArray(response) && "result" in response) assert.deepEqual(response.result, { ok: true, command: "daemon-stop", pid: process.pid });
  assert.equal(shutdowns, 1);
});

test("read-only principal cannot write or admin while semantic capabilities pass", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-rbac-surfaces-")), root = path.join(parent, "repo"), second = path.join(parent, "second"), userRoot = path.join(parent, "user");
  const ids = { reader: 4101, writer: 4102, arbiter: 4103, admin: 4104 }; [root, second].forEach((repo) => rbacRepo(repo, ids));
  const auth = (ownerUid: number) => ({ transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" } } as const);
  const host = await openDaemonHost({ daemonId: "rbac", userRoot });
  try {
    assert.equal((await rpc(host, auth(ids.admin), "daemon.repo.register", { rootDir: root, repoId: "rbac" })).outcome, "applied");
    const created = await host.run("rbac", { kind: "task-create", taskId: "task-rbac", title: "RBAC" }, auth(ids.writer)); assert.equal(created.outcome, "applied");
    const executionId = "exec-rbac", commitSha = "a".repeat(40); assert.equal((await host.run("rbac", { kind: "task-start", taskId: "task-rbac", executionId }, auth(ids.writer))).outcome, "applied");
    assert.equal((await host.run("rbac", { kind: "task-show", taskId: "task-rbac" }, auth(ids.reader))).outcome, "applied");
    const deniedWrite = await host.run("rbac", { kind: "task-create", taskId: "task-denied", title: "Denied" }, auth(ids.reader));
    assert.equal(deniedWrite.outcome, "op_rejected"); assert.equal(deniedWrite.code, "rbac_forbidden");
    const deniedPresetRun = await host.presetRun("rbac", { kind: "preset-run-start", presetId: "missing", entrypoint: "run", idempotencyKey: "denied" }, auth(ids.reader)), readableStatus = await host.presetRun("rbac", { kind: "preset-run-status", runId: "run_missing" }, auth(ids.reader)); assert.equal(deniedPresetRun.code, "rbac_forbidden"); assert.equal(readableStatus.code, "run_not_found");
    assert.equal((await host.run("rbac", { kind: "doc-status", paths: ["context/notes.md"] }, auth(ids.reader))).outcome, "applied");
    mkdirSync(path.join(root, "harness/context"), { recursive: true }); writeFileSync(path.join(root, "harness/context/notes.md"), "# Reader denied\n");
    const readerDoc = await host.run("rbac", { kind: "doc-submit", executionId, paths: ["context/notes.md"] }, auth(ids.reader));
    assert.equal(readerDoc.code, "rbac_forbidden"); assert.equal(readerDoc.detail?.holder?.personId, "writer");
    const deniedReview = await host.run("rbac", { kind: "task-review-execution", taskId: "task-rbac" }, auth(ids.reader));
    assert.equal(deniedReview.outcome, "op_rejected"); assert.equal(deniedReview.code, "rbac_forbidden");
    const deniedAdmin = await rpc(host, auth(ids.reader), "daemon.repo.register", { rootDir: second, repoId: "second" });
    assert.equal(deniedAdmin.outcome, "op_rejected"); assert.equal(deniedAdmin.code, "rbac_forbidden");
    writeFileSync(path.join(root, "submission.json"), JSON.stringify({ completionClaim: "done", deliverables: [], outputs: [], verificationNotes: ["tests"], knownGaps: [], residualRisks: [], commitSha }));
    assert.equal((await host.run("rbac", { kind: "task-submit", taskId: "task-rbac", executionId, fromFile: "submission.json" }, auth(ids.writer))).outcome, "applied");
    writeFileSync(path.join(root, "review.json"), JSON.stringify({ verdict: "approved", reason: "checked", evidenceChecked: [], commitSha, iteration: 0 }));
    const review = await host.run("rbac", { kind: "task-review-execution", taskId: "task-rbac", executionId, reviewId: "review-rbac", fromFile: "review.json" }, auth(ids.arbiter)); assert.equal(review.outcome, "applied", JSON.stringify(review));
    const attached = await rpc(host, auth(ids.admin), "daemon.repo.register", { rootDir: second, repoId: "second", mode: "remote-edge" }); assert.equal(attached.outcome, "applied"); assert.equal((attached.repo as Record<string, unknown>).mode, "remote-edge");
    const deniedEdgePreset = await rpc(host, auth(ids.writer), "repo.preset.run.start", { repo: { repoId: "second" }, payload: { presetId: "standard-task", entrypoint: "run", idempotencyKey: "edge-preset" } }); assert.equal(deniedEdgePreset.outcome, "op_rejected"); assert.equal(deniedEdgePreset.code, "repo_mode_read_only");
    assert.equal((await rpc(host, auth(ids.reader), "daemon.repo.unregister", { repoId: "second" })).outcome, "applied", "local daemon ownership, not a repo Cell/roster, authorizes unregister");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("runtime witness issuance uses the server principal and rejects admin or arbiter authority", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-witness-rbac-")), root = path.join(parent, "repo"), userRoot = path.join(parent, "user"), ids = { writer: 4201, admin: 4202, dualAdmin: 4203, dualArbiter: 4204 }; rbacRepo(root, ids); const auth = (ownerUid: number) => ({ transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" } } as const);
  const runtimeActor = { principal: { personId: "fixture" }, executor: null } as const, definition = { schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "instance-runtime", installationId: "installation-runtime", kindId: "codex", providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", baseUrl: null, authMode: "subscription" } as const, store = makeTaskEventStore({ repoId: "runtime-witness", rootDir: root }), events = [{ schema: "agent-runtime-event/v1", eventId: "runtime-installation", workspaceRevision: 1, opId: "runtime-installation", actor: runtimeActor, source: "local", occurredAt: "2026-08-13T00:00:00.000Z", type: "runtime_installation_observed", payload: { installationId: "installation-runtime", kindId: "codex", protocolFamily: "codex", hostRef: "host:local", version: "1.0.0", discoverySource: "wrapper", capabilities: ["structured_witness", "attach"] } }, { schema: "agent-runtime-event/v1", eventId: "runtime-dispatch", workspaceRevision: 2, opId: "runtime-dispatch", actor: runtimeActor, source: "local", occurredAt: "2026-08-13T00:00:01.000Z", type: "runtime_dispatch_requested", payload: { dispatchId: "dispatch-runtime", runtimeSessionId: "session-runtime", instanceId: definition.instanceId, installationId: definition.installationId, kindId: definition.kindId, idempotencyKey: "runtime-witness", definitionSnapshotRef: "artifact:runtime-definition/test", definitionSnapshot: definition } }, { schema: "agent-runtime-event/v1", eventId: "runtime-session", workspaceRevision: 3, opId: "runtime-session", actor: runtimeActor, source: "local", occurredAt: "2026-08-13T00:00:02.000Z", type: "runtime_session_started", payload: { runtimeSessionId: "session-runtime", instanceId: definition.instanceId, installationId: definition.installationId, kindId: definition.kindId, definitionSnapshotRef: "artifact:runtime-definition/test", launchGeneration: 1, attachable: true } }] as const satisfies readonly AgentRuntimeEventV1[]; for (const event of events) store.append({ event, plan: runtimeWritePlan(event), blobs: [] });
  const host = await openDaemonHost({ daemonId: "runtime-witness", userRoot }); try { await host.admin({ kind: "register", rootDir: root, repoId: "runtime-witness" }, auth(ids.admin)); const issued = await host.issueRuntimeWitness("runtime-witness", "session-runtime", auth(ids.writer)), bound = host.bindRuntimeWitness("runtime-witness", issued.token); assert.equal(bound.actor.principal.personId, "writer"); assert.deepEqual(bound.actor.executor, { kind: "agent", id: "runtime-session:session-runtime" }); assert.equal(host.publishRuntimeWitness("runtime-witness", issued.token, { type: "activity", activity: "tool" }).type, "activity"); assert.throws(() => host.publishRuntimeWitness("runtime-witness", issued.token, { type: "heartbeat", actor: "provider-supplied" } as never), hasCode("invalid_provider_frame")); const assignment = { transportKind: "unix-socket", assignmentBinding: { nodeId: "node-runtime", repoId: "runtime-witness", taskId: "task-runtime", executionId: "execution-runtime", assignmentId: "assignment-runtime", paths: [], actor: { principal: { personId: "worker" }, executor: null } } } as const, assignmentToken = await host.issueRuntimeWitness("runtime-witness", "session-runtime", assignment), assignmentBound = host.bindRuntimeWitness("runtime-witness", assignmentToken.token); assert.deepEqual(assignmentBound.source, { kind: "assignment", nodeId: "node-runtime", assignmentId: "assignment-runtime" }); assert.deepEqual(assignmentBound.actor.executor, { kind: "agent", id: "runtime-session:session-runtime" }); await assert.rejects(host.issueRuntimeWitness("runtime-witness", "session-runtime", auth(ids.dualAdmin)), hasCode("rbac_forbidden")); await assert.rejects(host.issueRuntimeWitness("runtime-witness", "session-runtime", auth(ids.dualArbiter)), hasCode("rbac_forbidden")); } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}
function initDeterministicRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet"); git(rootDir, "config", "user.name", "RepoCell Test"); git(rootDir, "config", "user.email", "repo-cell@example.invalid"); git(rootDir, "config", "gc.auto", "0"); git(rootDir, "config", "maintenance.auto", "false");
  execFileSync("git", ["-C", rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base"], { env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-14T00:00:00Z", GIT_COMMITTER_DATE: "2026-08-14T00:00:00Z" }, stdio: ["ignore", "pipe", "pipe"] });
}
function decisionProposal(title: string, question: string) { return { kind: "decision-propose", jsonInput: JSON.stringify({ title, question, riskTier: "medium", urgency: "medium", vertical: "default", preset: "default", decisionClass: "ordinary", appliesTo: { modules: ["daemon"], productLines: [] }, chosen: [{ id: "CH1", text: "Use events" }], rejected: [{ id: "RJ1", text: "Use files", whyNot: "They are not canonical" }], claims: [], fulfillments: [], relations: [] }) } as const; }
async function prepareReadyCompletion(cell: Awaited<ReturnType<typeof openRepoCell>>, rootDir: string, taskId: string, executionId: string, title: string): Promise<void> { const binding = { actor, source: "local" as const }; await cell.run({ kind: "task-create", taskId, title }, binding); await cell.run({ kind: "task-start", taskId, executionId }, binding); const packagePath = `tasks/${taskId}-${title.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "")}`, closeoutPath = `${packagePath}/closeout.md`; writeFileSync(path.join(rootDir, "harness", closeoutPath), "# Closeout\n\n## Summary\n\nDone.\n\n## Verification\n\nVerified.\n\n## Residual Risk\n\nNone.\n"); assert.equal((await cell.run({ kind: "doc-submit", paths: [closeoutPath] }, binding)).outcome, "applied"); const commitSha = git(rootDir, "rev-parse", "HEAD"); writeFileSync(path.join(rootDir, "submission.json"), JSON.stringify({ completionClaim: "Ready.", deliverables: ["completion"], outputs: [closeoutPath], verificationNotes: ["verified"], knownGaps: [], residualRisks: [], commitSha })); await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, binding); writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "Approved.", evidenceChecked: ["verified"], commitSha, iteration: 0 })); await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "review-ready", fromFile: "review.json" }, { actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent", id: "arbiter" } }, source: "local", roles: ["$arbiter"] }); await cell.run({ kind: "task-review-consent", taskId, executionId, reviewId: "review-ready", consentId: "consent-ready" }, binding); await cell.run({ kind: "task-complete", taskId, executionId, ci: "passed" }, binding); await cell.run({ kind: "task-code-doc-reconcile", taskId, executionId, commitSha, iteration: 0, paths: ["packages/kernel/src/domain/task.ts"] }, binding); }
function rbacRepo(rootDir: string, ids: Readonly<Record<string, number>>): void { mkdirSync(rootDir, { recursive: true }); initRepo(rootDir); mkdirSync(path.join(rootDir, "harness"));
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), "schema: harness-anything/v1\nname: rbac\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n");
  const people = Object.entries(ids).map(([role, uid]) => ({ personId: role, displayName: role, roles: [role], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }] }));
  const commands: Readonly<Record<string, readonly string[]>> = { reader: ["repo-read"], writer: ["repo-write"], arbiter: ["arbiter"], admin: ["admin"], dualAdmin: ["repo-write", "admin"], dualArbiter: ["repo-write", "arbiter"] }, roles = Object.keys(ids).map((roleId) => ({ roleId, commandClasses: commands[roleId] }));
  writeFileSync(path.join(rootDir, "harness/people.yaml"), `${JSON.stringify({ schema: "harness-people/v1", people, roles }, null, 2)}\n`); git(rootDir, "add", "harness"); git(rootDir, "commit", "--quiet", "-m", "add RBAC fixture"); }
async function rpc(host: Awaited<ReturnType<typeof openDaemonHost>>, auth: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2], method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = createJsonRpcProtocolServer({ host, authContext: auth, emit: async () => undefined }); await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method, params }); assert.ok(response && !Array.isArray(response) && "result" in response); return (response as { result: Record<string, unknown> }).result; }
// The readiness projection reports an unavailable canonical Git cut with no basis commit. Before the
// ledger owned its own repository the outer repository always had a HEAD, so that branch was
// unreachable and the wire validator was free to demand a sha; once it became reachable the producer
// was emitting a value its own validator rejected. This pins producer and validator to each other.
test("decision readiness survives the wire when the canonical Git cut is unavailable", () => {
  const decision = { decisionId: "dec_1", proposedAt: "2026-01-01T00:00:00Z", appliesTo: { modules: ["packages/kernel"], productLines: [] } };
  const noCut = projectDecisionReadiness({ rootDir: "/nonexistent", commitSha: "", decisions: [decision] }, { run: () => ({ ok: false, stdout: "" }) });
  assert.equal(noCut[0]?.basisCommitSha, "");
  assert.equal(noCut[0]?.appliesToDrift.state, "unknown");
  assert.deepEqual(validateDaemonDecisionList(decisionList(noCut[0]!)), []);

  const verdictWithoutBasis = { ...noCut[0]!, appliesToDrift: { ...noCut[0]!.appliesToDrift, state: "clear" as const } };
  assert.deepEqual(validateDaemonDecisionList(decisionList(verdictWithoutBasis)), ["daemon decision list is invalid"]);
});

// A flag can be declared on the init command, parsed by the CLI, and honored by the bootstrap
// implementation while the wire shape still rejects it — the CLI and the RPC params are two
// separate declarations of the same request. This walks the declared flags so the next one added
// to init cannot repeat that.
test("every declared ha init flag survives the daemon.repo.bootstrap wire params", () => {
  const command = daemonProtocolCommands.find((candidate) => candidate.id === "repo-bootstrap");
  assert.ok(command, "the init command must stay declared as repo-bootstrap");
  const base = { rootDir: "/tmp/workspace", repoId: "alpha", personId: "owner", displayName: "Owner" };
  for (const input of command.inputs) {
    const field = (input as { readonly field?: string }).field ?? input.name.slice(2).replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
    const parsed = parseDaemonRpcParams("daemon.repo.bootstrap", { ...base, [field]: input.kind === "boolean" ? true : "value" });
    assert.equal(parsed.ok, true, `${input.name} reaches the daemon as params.${field}, which the wire shape rejects`);
  }
});

function decisionList(readiness: unknown): Record<string, unknown> {
  return { ok: true, warnings: [], decisions: [{ schema: "decision-row/v1", decisionId: "dec_1", path: "harness/decisions/decision-dec_1/decision.md", state: "in_effect",
    title: "t", question: "q", riskTier: "low", urgency: "low", vertical: "v", preset: "p", decisionClass: "c", proposedAt: "2026-01-01T00:00:00Z", decidedAt: null,
    workspaceRevision: 1, appliesTo: {}, proposer: {}, arbiter: null, body: null, chosen: [], rejected: [], claims: [], judgmentConsents: [], readiness }] };
}


function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function hasCode(expected: string): (error: unknown) => boolean { return (error) => typeof error === "object" && error !== null && "code" in error && error.code === expected; }
function runtimeWritePlan(event: AgentRuntimeEventV1): FrozenWritePlan { return Object.freeze({ commandType: event.type, targets: Object.freeze([{ kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" }, { kind: "event_head", path: "harness/events/head.json", operation: "replace" }, { kind: "projection_invalidation", projection: "agent-runtime/v1", key: event.opId }].map((target) => Object.freeze(target))) }) as FrozenWritePlan; }
