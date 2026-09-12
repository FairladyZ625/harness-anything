// harness-test-tier: integration
import { readDispatchStreamHeaders } from "../src/dispatch-stream.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { fetchCiObservations, ingestCiObservations } from "../src/ci-observation-actions.ts";
import {
  canonicalEventWritePlan,
  makeTaskEventReader,
  makeTaskEventStore,
  makeTaskProjection,
  activateEmptyCanonicalGeneration,
  readDaemonRegistry,
  type AgentRuntimeEventV1,
  type FrozenWritePlan,
} from "../../kernel/src/index.ts";
import { WRITE_RECEIPT_SCHEMA } from "../../kernel/src/index.ts";
import { validateWriteReceipt } from "../../kernel/test/contracts/receipt-acceptance.fixtures.ts";
import { projectDecisionReadiness, reviewDigest } from "../../kernel/src/index.ts";
import {
  actionForDaemonMethod,
  canonicalRoot,
  daemonGuiActionMethods,
  daemonProtocolCommands,
  parseDaemonRpcParams,
  serializeDaemonRpcCall,
  validateDaemonDecisionList,
  validateDaemonGuiCommandReceipt,
  validateDaemonRelationGraph,
  validateDaemonTaskSnapshotList,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { realizedDecisionBody, realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { openRepoCell as openProductRepoCell } from "../src/repo-cell.ts";
import { openBootstrappedRepoCell as openRepoCell, seedSettingsEvent } from "./repo-settings.fixture.ts";
import { decisionSummaryRead } from "./fixtures/decision-summary-read.ts";
const DOC_POLICY_ID = "markdown-body-replaceable/v1";
const ciBin = mkdtempSync(path.join(tmpdir(), "ha-protocol-ci-")),
  originalPath = process.env.PATH;
before(() => {
  writeFileSync(path.join(ciBin, "gh"), "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });
  process.env.PATH = `${ciBin}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  process.env.PATH = originalPath;
  rmSync(ciBin, { recursive: true, force: true });
});

function assertValidationDiagnostic(errors: readonly string[], entity: RegExp, field: string): void {
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, entity);
  assert.match(errors[0]!, new RegExp(`field=${field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?: |$)`, "u"));
  assert.match(errors[0]!, /actual=/u);
}

function assertValidWriteReceipt(value: unknown): void {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const allowed = new Set([...WRITE_RECEIPT_SCHEMA.required, ...WRITE_RECEIPT_SCHEMA.optional]),
    receipt = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => allowed.has(key)));
  assert.deepEqual(validateWriteReceipt(receipt), []);
}

async function waitForAcceptedReceipt(
  cell: Awaited<ReturnType<typeof openProductRepoCell>>,
  accepted: { readonly opId: string; readonly acceptance?: { readonly revisionTo?: number } | null },
  binding = repoWriteBinding,
  waitFor: readonly ("accepted_durable" | "projection_visible" | "git_verified" | "worktree_visible")[] = [
    "accepted_durable",
    "projection_visible",
    "git_verified",
    "worktree_visible",
  ],
): Promise<Awaited<ReturnType<typeof cell.run>>> {
  const shown = await cell.run({ kind: "receipt-show", opId: accepted.opId, waitFor, timeoutMs: 5_000 }, binding);
  assert.equal(shown.status, "accepted_durable", JSON.stringify(shown));
  assert.equal(shown.acceptance?.revisionTo, accepted.acceptance?.revisionTo);
  return shown;
}

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;
const repoWriteBinding = withRoleBinding({ actor, source: "local" as const }, "repo-write");

// prettier-ignore

test("daemon repo registration derives its closed mode enum at the wire boundary", () => {
  const base = { rootDir: "/tmp/workspace", repoId: "alpha" };
  for (const mode of [undefined, "local", "remote-proxy", "remote-center", "remote-edge"]) assert.equal(parseDaemonRpcParams("daemon.repo.register", { ...base, ...(mode ? { mode } : {}) }).ok, true, String(mode));
  const invalid = parseDaemonRpcParams("daemon.repo.register", { ...base, mode: "invalid" }); assert.equal(invalid.ok, false); if (!invalid.ok) assert.deepEqual(invalid.errors, ["params.mode must be one of local, remote-proxy, remote-center, remote-edge"]);
});

// prettier-ignore

test("local Fleet runtime envelope admits the paged overview read", async () => {
  let observed: Record<string, unknown> | null = null;
  const host = { fleet: { edgeRuntime: async (payload: Record<string, unknown>) => { observed = payload; return { ok: true, command: "fleet-runtime-overview" }; } }, status: () => ({ daemonId: "fleet-overview", pid: process.pid, repos: [] }) } as never,
    server = createJsonRpcProtocolServer({ host, build: { commit: null }, authContext: { transportKind: "unix-socket" }, emit: async () => undefined });
  try {
    await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });
    const payload = { host: "center", port: 7443, caPath: "/fleet/ca.pem", nodeId: "edge-one", credential: "secret", assignmentId: "assignment-one", repoId: "repo", viewRoot: "/view", quotaBytes: 1_048_576, workspaceRoot: "/workspace", action: { kind: "fleet-runtime", method: "repo.agentRuntime.overview", payload: { limit: 16 } } },
      response = await server.handle({ jsonrpc: "2.0", id: 2, method: "daemon.fleet.task.run", params: { payload } });
    assert.ok(response && !Array.isArray(response) && "result" in response); assert.equal(response && !Array.isArray(response) && "result" in response && (response.result as Record<string, unknown>).ok, true);
    assert.deepEqual(observed, { ...payload, method: "repo.agentRuntime.overview", action: { limit: 16 } });
  } finally { server.close(); }
});

// prettier-ignore

test("protocol hello accepts only runtime identity and executor-attribution variables", () => {
  const hello = (sessionEnvironment?: Record<string, unknown>) => parseDaemonRpcParams("protocol.hello", { protocolVersion: currentDaemonProtocolVersion, ...(sessionEnvironment ? { sessionEnvironment } : {}) });
  assert.equal(hello().ok, true);
  assert.equal(hello({ CLAUDE_CODE_SESSION_ID: "claude-session", CODEX_THREAD_ID: "codex-thread", CODEX_SESSION_ID: "codex-thread", HARNESS_ACTOR: "agent:worker" }).ok, true);
  for (const [input, field] of [
    [{ CLAUDE_CODE_HOST_SESSION_ID: "local-wrong" }, "sessionEnvironment.CLAUDE_CODE_HOST_SESSION_ID"],
    [{ CODEX_THREAD_ID: " " }, "sessionEnvironment.CODEX_THREAD_ID"],
    [{ HARNESS_ACTOR: "person:spoof" }, "sessionEnvironment.HARNESS_ACTOR"],
  ] as const) {
    const result = hello(input);
    assert.equal(result.ok, false);
    if (!result.ok) assertValidationDiagnostic(result.errors, /entity=/u, field);
  }
});

// prettier-ignore

test("projection rebuild repairs a repository that has no authored settings document", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-projection-rebuild-bare-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openProductRepoCell({ repoId: workspaceId("projection-rebuild-bare"), rootDir: canonicalRoot(rootDir), ownerId: "projection-rebuild-bare" });
    const repaired = await cell.run({ kind: "projection-rebuild" }, repoWriteBinding) as Record<string, unknown>;
    assert.equal(repaired.outcome, "applied", JSON.stringify(repaired)); assert.equal(repaired.revision, 0); assert.deepEqual(makeTaskEventReader({ repoId: "projection-rebuild-bare", rootDir }).read().events, []);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// prettier-ignore

test("replay receipts retain their SQLite cut while Git identity settles independently", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-replay-current-cut-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("replay-current-cut"), rootDir: canonicalRoot(rootDir), ownerId: "replay-current-cut" }); const binding = repoWriteBinding; const created = await cell.run({ kind: "task-create", taskId: "task_replay_first", title: "First" }, binding); const createdVisible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding)); const first = await cell.run({ kind: "task-start", taskId: "task_replay_first", executionId: "execution_replay_first" }, binding) as Record<string, unknown>, second = await cell.run({ kind: "task-create", taskId: "task_replay_second", title: "Second" }, binding) as Record<string, unknown>, replay = await cell.run({ kind: "receipt-show", opId: first.opId }, binding) as Record<string, unknown>; assert.notDeepEqual(first.cut, second.cut); assert.deepEqual(replay.cut, first.cut); assert.equal(replay.status, "accepted_durable"); await cell.close(); cell = await openRepoCell({ repoId: workspaceId("replay-current-cut"), rootDir: canonicalRoot(rootDir), ownerId: "replay-current-cut-reopened" }); const materialized = await waitForAcceptedReceipt(cell, first as { opId: string; acceptance?: { revisionTo?: number } | null }, binding, ["accepted_durable", "projection_visible", "git_verified"]); assert.equal(materialized.git.state, "verified"); assert.deepEqual(materialized.cut, first.cut); }
  finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// prettier-ignore

test("relation graph contract accepts the materialized ledger row schema and rejects malformed rows", () => {
  const cut = { status: "ready", watermark: 7, sourceRevision: 7 }, payload = { ok: true, ...cut, edges: [{ relationId: "rel_real", sourceRef: "decision/dec_REAL/C1", targetRef: "fact/F-REAL", relationType: "evidenced-by", direction: "directed", strength: "strong", origin: "declared", state: "active", targetObservedVersion: 6, currentTargetVersion: 6, freshness: "current", rationale: "Observed.", ownerRef: "decision/dec_REAL", sourcePath: "harness/decisions/decision-dec_REAL/decision.md", recordIndex: 0, current: true }], coverageRows: [{ decisionRef: "decision/dec_REAL", claimRef: "decision/dec_REAL/C1", status: "covered", covered: true, fulfillment: "standing-policy", relationPath: ["rel_real"] }], factAnchors: [{ factRef: "fact/F-REAL", taskId: "task_REAL", factId: "F-REAL", sourcePath: "harness/facts/F-REAL.md" }], facts: [{ schema: "task-fact-row/v1", ref: "fact/F-REAL", taskId: "task_REAL", factId: "F-REAL", statement: "Real observation.", source: "harness/facts/F-REAL.md", observedAt: "2026-08-14T00:00:00.000Z", confidence: "high", memoryClass: "semantic", memoryTags: [], provenance: [], liveness: "standing", invalidated: false }], warnings: [] };
  assert.deepEqual(validateDaemonRelationGraph(payload), []);
  assert.deepEqual(validateDaemonRelationGraph({ ...payload, page: { limit: 25, cursor: null, nextCursor: "WyJyZWxfcmVhbCJd" } }), []);
  assertValidationDiagnostic(validateDaemonRelationGraph({ ...payload, page: { limit: 0, cursor: null, nextCursor: null } }), /relation-graph:full/u, "page");
  assertValidationDiagnostic(validateDaemonRelationGraph({ ...payload, coverageRows: [{ ...payload.coverageRows[0], fulfillment: "standing_policy" }] }), /decision\/dec_REAL/u, "coverageRows[0]");
  // The optional uncovered-cause classification is accepted per registered word and
  // rejected on garbage; absence (older daemons, covered rows) stays valid.
  assert.deepEqual(validateDaemonRelationGraph({ ...payload, coverageRows: [{ ...payload.coverageRows[0], status: "uncovered", covered: false, fulfillment: null, freshnessReason: "fulfillment-undeclared" }] }), []);
  assert.deepEqual(validateDaemonRelationGraph({ ...payload, coverageRows: [{ ...payload.coverageRows[0], status: "uncovered", covered: false, fulfillment: null, freshnessReason: "no-live-evidence" }] }), []);
  assert.deepEqual(validateDaemonRelationGraph({ ...payload, coverageRows: [{ ...payload.coverageRows[0], status: "uncovered", covered: false, fulfillment: null, freshnessReason: "refuted", refutingFactRefs: ["fact/F-REAL"] }] }), []);
  assertValidationDiagnostic(validateDaemonRelationGraph({ ...payload, coverageRows: [{ ...payload.coverageRows[0], status: "uncovered", covered: false, fulfillment: null, freshnessReason: "stale" }] }), /decision\/dec_REAL/u, "coverageRows[0]");
  const { observedAt: _observedAt, ...missingObservedAt } = payload.facts[0]; assertValidationDiagnostic(validateDaemonRelationGraph({ ...payload, facts: [missingObservedAt] }), /F-REAL/u, "facts[0]");
  // dec_6B963E9B83AE4AC73FB0A61E81 CH1: the derived `invalidated` boolean is required, not optional prose.
  const { invalidated: _invalidated, ...missingInvalidated } = payload.facts[0]; assertValidationDiagnostic(validateDaemonRelationGraph({ ...payload, facts: [missingInvalidated] }), /F-REAL/u, "facts[0]");
  assertValidationDiagnostic(validateDaemonRelationGraph({ ...payload, facts: [{ ...payload.facts[0], invalidated: "superseded_fact" }] }), /F-REAL/u, "facts[0]");
  const empty = { edges: [], coverageRows: [], factAnchors: [], facts: [] };
  const facets = [
    { ok: true, ...cut, facet: "edges", page: { limit: 500, cursor: null, nextCursor: null }, ...empty, edges: payload.edges, warnings: [] },
    { ok: true, ...cut, facet: "facts", page: { limit: 500, cursor: null, nextCursor: null }, ...empty, facts: [{ anchor: "fact/F-REAL", text: "Real observation.", category: "lesson", taskId: "task_REAL" }], warnings: [] },
    { ok: true, ...cut, facet: "coverageRows", ...empty, coverageRows: payload.coverageRows, warnings: [] },
  ];
  for (const facet of facets) assert.deepEqual(validateDaemonRelationGraph(facet), [], String(facet.facet));
  assert.ok(validateDaemonRelationGraph({ ...facets[0], page: undefined }).length > 0);
  assert.ok(validateDaemonRelationGraph({ ...facets[1], page: { limit: 0, cursor: null, nextCursor: null } }).length > 0);
  // Every facet echoes the fact-type vocabulary (empty outside `facts`); it is declared, not required.
  for (const facet of facets) assert.deepEqual(validateDaemonRelationGraph({ ...facet, domainTypes: [] }), [], `${facet.facet}+domainTypes`);
  assert.deepEqual(validateDaemonRelationGraph({ ...payload, domainTypes: ["lesson"] }), []);
  assertValidationDiagnostic(validateDaemonRelationGraph({ ...facets[2], facet: "unknown" }), /relation-graph:unknown/u, "facet");
  assertValidationDiagnostic(validateDaemonRelationGraph({ ...facets[1], extra: true }), /relation-graph:facts/u, "extra");
  assertValidationDiagnostic(validateDaemonRelationGraph({ ...facets[2], facts: facets[1]!.facts }), /relation-graph:coverageRows/u, "facts");
  assertValidationDiagnostic(validateDaemonRelationGraph({ ...facets[1], facts: [{ ...facets[1]!.facts[0], category: "semantic" }] }), /F-REAL/u, "facts[0]");
});

// prettier-ignore

test("wide GUI read contracts accept only their explicit narrow and page facets", () => {
  const task = (payload: Record<string, unknown>) => parseDaemonRpcParams("repo.tasks.list", { repo: { repoId: "alpha" }, payload });
  const graph = (payload: Record<string, unknown>) => parseDaemonRpcParams("repo.triadic.relationGraph", { repo: { repoId: "alpha" }, payload });
  const decisions = (payload: Record<string, unknown>) => parseDaemonRpcParams("repo.decisions.list", { repo: { repoId: "alpha" }, payload });
  assert.equal(task({ status: "blocked", updatedAfter: "2026-08-01T00:00:00.000Z", updatedBefore: "2026-08-31T00:00:00.000Z", limit: 25, cursor: "WyJ0YXNrLTEiXQ" }).ok, true);
  assert.equal(graph({ status: "retired", limit: 25 }).ok, true);
  assert.equal(graph({ entity: "task/task-1", hops: { direction: "both", relationTypes: ["relates"], maxDepth: 2, maxNodes: 2000 }, status: "active" }).ok, true);
  assert.equal(graph({ entity: "task/task-1", hops: { direction: "both", relationTypes: [], maxDepth: 2, maxNodes: 2000 } }).ok, false);
  assert.equal(graph({ entity: "task/task-1", hops: { direction: "both", relationTypes: ["relates"], maxDepth: 0, maxNodes: 2000 } }).ok, false);
  assert.equal(task({ status: "retired" }).ok, false);
  assert.equal(graph({ status: "blocked" }).ok, false);
  assert.equal(task({ limit: 0 }).ok, false);
  assert.equal(graph({ updatedAfter: "later", updatedBefore: "earlier" }).ok, false);
  assert.equal(task({ unexpected: true }).ok, false);
  assert.equal(graph({ facet: "edges", relationType: "derives", state: "active", direction: "directed" }).ok, true);
  for (const facet of ["facts", "coverageRows"]) assert.equal(graph({ facet }).ok, true, facet);
  assert.equal(graph({ facet: "unknown" }).ok, false);
  assert.equal(graph({ facet: "factAnchors" }).ok, false);
  for (const facet of ["edges", "facts"]) {
    assert.equal(graph({ facet, limit: 500, cursor: "next" }).ok, true);
    for (const limit of [0, 501, 1.5, "5"]) assert.equal(graph({ facet, limit }).ok, false);
    assert.equal(graph({ facet, cursor: "" }).ok, false);
  }
  assert.equal(graph({ facet: "coverageRows", limit: 5 }).ok, false);
  assert.equal(graph({ facet: "facts", relationType: "derives" }).ok, false);
  assert.equal(graph({ relationType: "derives" }).ok, false);
  assert.equal(decisions({ projection: "summary" }).ok, true);
  assert.equal(decisions({ projection: "full" }).ok, true);
  assert.equal(decisions({ projection: "compact" }).ok, false);
  assert.equal(decisions({ projection: "summary", extra: true }).ok, false);
});

// prettier-ignore

test("preset process RPC enforces object inputs and keeps status closed", () => {
  const start = { repo: { repoId: "alpha" }, payload: { presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "once" } }, status = { repo: { repoId: "alpha" }, payload: { runId: "run_1" } };
  assert.equal(parseDaemonRpcParams("repo.preset.run.start", start).ok, true); assert.equal(parseDaemonRpcParams("repo.preset.run.start", { ...start, payload: { ...start.payload, allowScripts: true } }).ok, false); assert.equal(parseDaemonRpcParams("repo.preset.run.start", { ...start, payload: { ...start.payload, inputs: "open" } }).ok, false); assert.equal(parseDaemonRpcParams("repo.preset.run.status", status).ok, true); assert.equal(parseDaemonRpcParams("repo.preset.run.status", { ...status, payload: { ...status.payload, retry: true } }).ok, false);
});

// prettier-ignore

test("GUI action facets are exact, typed, and exclude the generic runner", () => {
  const submission = { completionClaim: "Ready.", deliverables: ["code"], outputs: ["packages/daemon/src/repo-cell.ts"], verificationNotes: ["tests"], knownGaps: [], residualRisks: [], commitSha: "a".repeat(40) }, proposal = { title: "Typed actions", question: "Ship?", riskTier: "medium", urgency: "high", vertical: "software/coding", preset: "standard-task", appliesTo: { modules: ["daemon"], productLines: ["gui"] }, decisionClass: "ordinary", chosen: [{ id: "CH1", text: "Ship" }], rejected: [{ id: "RJ1", text: "Wait", whyNot: "No need" }], body: "# Typed actions\n", claims: [], fulfillments: [] };
  const cases = new Map<string, Record<string, unknown>>([
    ["daemon.gui.control.request", { kind: "refresh", authorityRepoId: "alpha", reason: "Refresh catalog" }],
    ["repo.task.start", { taskId: "task-a", executionId: "execution-a" }],
    ["repo.task.progress.append", { taskId: "task-a", executionId: "execution-a", text: "Progress", evidence: [{ type: "test", path: "report.txt", summary: "Passed" }] }],
    ["repo.task.submit", { taskId: "task-a", executionId: "execution-a" }],
    ["repo.task.pin", { taskId: "task-a" }],
    ["repo.task.unpin", { taskId: "task-a" }],
    ["repo.decision.list", { state: "proposed", legacyRange: { start: 1, end: 4 }, limit: 25, cursor: "WyJkZWNfQSJd" }],
    ["repo.decision.show", { decisionId: "dec_A", includeBody: true }],
    ["repo.decision.propose", proposal],
    ["repo.decision.accept", { decisionId: "dec_A", rationale: "Approved", judgmentOnlyRationale: "Judgment" }],
    ["repo.decision.reject", { decisionId: "dec_A", reason: "Rejected" }],
    ["repo.decision.defer", { decisionId: "dec_A", reason: "Deferred" }],
    ["repo.vertical.kind.upsert", { kindId: "runbook", declaration: { id: "runbook" }, expectedVersion: 2 }],
    ["repo.vertical.kind.publishSchema", { kindId: "runbook", attributes: { owner: { type: "string" } }, expectedVersion: 3 }],
    ["repo.vertical.kind.retire", { kindId: "runbook", reason: "Superseded", expectedVersion: 4 }],
    ["repo.entity.import", { entityKind: "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94", locator: "harness/adr/ADR-0001-example.md", expectedVersion: 0, title: "Example ADR" }],
    ["repo.entity.update", { entityKind: "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94", entityId: "ADR-abc", expectedVersion: 7, title: "Updated", locator: "harness/adr/ADR-0002.md", contentVersion: "git:abc", attributes: { region: "north", fiscalYear: 2026 } }],
    ["repo.entity.archive", { entityKind: "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94", entityId: "ADR-abc", expectedVersion: 8, reason: "Superseded" }],
    ["repo.entity.delete", { entityKind: "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94", entityId: "ADR-abc", expectedVersion: 8, reason: "Retired with its content" }],
    ["repo.receipt.show", { opId: "op_A" }],
    ["repo.settings.update", { defaultPreset: "strict-task", locale: "zh-CN", idempotencyKey: "settings-once" }],
    ["repo.gui.catalog.reread", {}],
    ["repo.agentRuntime.spawn", { runtimeInstanceId: "instance-codex", cwd: { scope: "repo-root" }, prompt: "Inspect", taskId: null, idempotencyKey: "runtime-once" }],
    ["repo.agent.entity.write", { declaration: { schema: "agent-declaration/v1", id: "gui-created-agent", name: "GUI Created Agent", instructions: "Keep the roster intact.\nSecond line.", runtime_type: "any", role: "worker", model: "gpt-5.6-terra", skills: [{ id: "review", path: "skills/review" }], prompts: ["prompt://gui"], preset: "standard-task" } }],
    ["repo.squad.entity.write", { declaration: { schema: "squad-declaration/v1", id: "gui-created-squad", name: "GUI Created Squad", leader: "gui-created-agent", workers: ["gui-created-agent"], leaderTurnBudget: 8, roster: "## GUI Squad\n\n  GUI Created Agent\n\n" } }],
    ["repo.schedule.create", { scheduleId: "schedule-a", name: "Schedule A", mode: "detect", everyMs: 300000, agentId: "agent-a", runtimeInstanceId: "instance-a", mission: "Run A.", idempotencyKey: "schedule-create-once" }],
    ["repo.schedule.update", { scheduleId: "schedule-a", name: "Updated A", mode: "remediate", everyMs: 600000, agentId: "agent-a", runtimeInstanceId: "instance-a", mission: "Run updated A.", model: null, reasoningEffort: null, idempotencyKey: "schedule-update-once" }],
    ["repo.schedule.delete", { scheduleId: "schedule-a", reason: "retired", idempotencyKey: "schedule-delete-once" }],
    ["repo.schedule.enable", { scheduleId: "schedule-a", idempotencyKey: "schedule-enable-once" }],
    ["repo.schedule.disable", { scheduleId: "schedule-a", idempotencyKey: "schedule-disable-once" }],
    ["repo.schedule.runNow", { scheduleId: "schedule-a", idempotencyKey: "schedule-run-once" }],
    ["repo.agentRuntime.cancel", { runtimeSessionId: "runtime-session-a" }],
    ["repo.terminal.spawn", { idempotencyKey: "terminal-once", backend: "direct-pty", name: "Shell", cwd: { scope: "repo-root" }, shellProfileId: "default" }],
    ["repo.terminal.input", { sessionId: "terminal-a", clientSeq: 1, utf8: "pwd\n" }],
    ["repo.terminal.resize", { sessionId: "terminal-a", cols: 100, rows: 30 }],
    ["repo.terminal.detach", { sessionId: "terminal-a", attachmentId: "attachment-a" }],
    ["repo.terminal.terminate", { sessionId: "terminal-a", confirmed: true }]
  ]);
  assert.deepEqual(daemonGuiActionMethods.map(({ method }) => method), [...cases.keys()]); assert.equal(daemonGuiActionMethods.some(({ method }) => method === "repo.task.run"), false);
  for (const [method, payload] of cases) { const params = method.startsWith("daemon.") ? { payload } : { repo: { repoId: "alpha" }, payload }; assert.equal(parseDaemonRpcParams(method, params).ok, true, method); assert.equal(parseDaemonRpcParams(method, { ...params, payload: { ...payload, unexpected: true } }).ok, false, `${method}: unknown`); }
  const terminalSpawn = cases.get("repo.terminal.spawn")!; assert.equal(parseDaemonRpcParams("repo.terminal.spawn", { repo: { repoId: "alpha" }, payload: { ...terminalSpawn, backend: "tmux" } }).ok, true); assert.equal(parseDaemonRpcParams("repo.terminal.spawn", { repo: { repoId: "alpha" }, payload: { ...terminalSpawn, backend: "remote" } }).ok, false); const { backend: _backend, ...missingBackend } = terminalSpawn; assert.equal(parseDaemonRpcParams("repo.terminal.spawn", { repo: { repoId: "alpha" }, payload: missingBackend }).ok, false);
  assert.equal(parseDaemonRpcParams("repo.decision.list", { repo: { repoId: "alpha" }, payload: { limit: 0 } }).ok, false);
  assert.equal(parseDaemonRpcParams("repo.decision.list", { repo: { repoId: "alpha" }, payload: { limit: 501 } }).ok, false);
  assert.equal(parseDaemonRpcParams("repo.decision.list", { repo: { repoId: "alpha" }, payload: { cursor: "" } }).ok, false);
  assert.equal(parseDaemonRpcParams("repo.agentRuntime.spawn", { repo: { repoId: "alpha" }, payload: { runtimeInstanceId: "instance-codex", cwd: { scope: "repo-root" }, taskId: "task-a", idempotencyKey: "task-derived" } }).ok, true);
  assert.equal(parseDaemonRpcParams("repo.agentRuntime.spawn", { repo: { repoId: "alpha" }, payload: { runtimeInstanceId: "instance-codex", cwd: { scope: "repo-root" }, taskId: null, idempotencyKey: "missing-mission" } }).ok, false);
  assert.equal(parseDaemonRpcParams("repo.task.submit", { repo: { repoId: "alpha" }, payload: { taskId: "task-a", executionId: "execution-a", submission } }).ok, false);
  assert.equal(parseDaemonRpcParams("repo.decision.propose", { repo: { repoId: "alpha" }, payload: { ...proposal, appliesTo: { ...proposal.appliesTo, extra: [] } } }).ok, false);
  for (const payload of [{ taskId: "task-a" }, { taskId: "task-a", executionId: "execution-a", amend: true }]) {
    const call = { method: "repo.task.submit", params: { repo: { repoId: "alpha" }, payload } };
    assert.deepEqual(JSON.parse(serializeDaemonRpcCall(call)), call);
    assert.equal(parseDaemonRpcParams(call.method, call.params).ok, true);
  }
  const retiredPacket = JSON.parse(readFileSync("packages/daemon/fixtures/contracts/gui-task-submit-packet-invalid.json", "utf8"));
  assert.equal(parseDaemonRpcParams(retiredPacket.method, retiredPacket.params).ok, false);
  assert.throws(() => serializeDaemonRpcCall(retiredPacket), /submission/u);
  assert.equal(parseDaemonRpcParams("repo.task.submit", { repo: { repoId: "alpha" }, payload: { taskId: "task-a", amend: "true" } }).ok, false);
  assert.deepEqual(actionForDaemonMethod("repo.task.submit", cases.get("repo.task.submit")!), { kind: "task-submit", ...cases.get("repo.task.submit")! });
});

// prettier-ignore

test("GUI command receipts and task supplements reject unknown, missing, and mistyped fields", () => {
  const proof = { committedRevision: 0, appliedCut: 0, durable: true, canonicalVisible: true, worktreeVisible: null }, receipt = { schema: "command-receipt/v2", ok: true, command: "decision-list", outcome: "applied", opId: "read:decision-list", revision: 0, evidence: "{}", visibility: "center", proof };
  assert.deepEqual(validateDaemonGuiCommandReceipt(receipt), []); assert.notDeepEqual(validateDaemonGuiCommandReceipt({ ...receipt, extra: true }), []); const { schema: _schema, ...missing } = receipt; assert.notDeepEqual(validateDaemonGuiCommandReceipt(missing), []); assert.notDeepEqual(validateDaemonGuiCommandReceipt({ ...receipt, revision: "0" }), []);
const availability = { consents: "unknown", codeDocWitnesses: "unknown", gateWitnesses: "unknown" }, placement = { moduleKeys: [], productLines: [], spawningDecisionIds: [], parentTaskId: null, origin: "native", engine: "kernel/task-lifecycle/v1", packageDisposition: "active", provenance: [{ kind: "canonical-event", ref: "task/task-old" }] }, old = { ok: true, status: "ready", watermark: 0, sourceRevision: 0, warnings: [], invalidRows: [], rows: [{ taskId: "task-old", packagePath: null, generation: "v1", workspaceRevision: 0, createdAt: null, updatedAt: "2026-08-14T00:00:00.000Z", snapshot: { revision: 0, task: null, executions: [], reviews: [], edgesTaken: [], lease: null, decisionRelations: [] }, coordinationStatus: "unknown", snapshotAvailability: availability, closeoutAssessment: { readiness: "missing", blocker: "execution", gates: [] }, blockingAssessment: { taskId: "task-old", state: "clear", label: "none", blockers: [], warnings: [] }, placement, board: { columnId: null, rank: 5 }, visibility: { archived: false, noise: false }, capabilities: [{ id: "start", available: false, reason: "unknown" }, { id: "progress", available: false, reason: "unknown" }, { id: "submit", available: false, reason: "unknown" }, { id: "review", available: false, reason: "unknown" }, { id: "complete", available: false, reason: "unknown" }], phase: { index: null, reason: "phase_unresolved", steps: ["planned", "active", "in_review", "done"] }, risk: { flagged: true }, executionEvidence: [] }] };
  assert.deepEqual(validateDaemonTaskSnapshotList(old), []); assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...old, rows: [{ ...old.rows[0]!, unknown: true }] }), []); const { placement: _placement, ...withoutPlacement } = old.rows[0]!; assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...old, rows: [withoutPlacement] }), []); assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...old, rows: [{ ...old.rows[0]!, executionEvidence: [{ executionId: 1, origin: "native", outputs: [] }] }] }), []);
  const metadata = { idempotencyKey: null, parentTaskId: null, workKind: "feat", riskTier: "medium", urgency: "high", verticalId: "software/coding", presetId: "standard-task", profileId: "default", moduleKey: "daemon", slug: "current-task", surfaces: ["cli"], longRunning: false, fromLegacyId: null }, provenance = [{ runtime: "unavailable", sessionId: null, transcriptReachability: "unavailable", boundAt: "2026-08-14T00:00:00.000Z" }], currentTask = { schema: "task/v2", taskId: "task-current", title: "Current task", taskClass: "standard", status: "blocked", graph: {}, currentNode: "implementation", iteration: 0, createdBy: { principal: { personId: "person-owner" }, executor: null }, completionGateIds: [], presetSnapshotDigest: null, provenance, pinned: true, metadata, packageDisposition: "archived", supersededBy: "task-next", contractVersion: 1 }, current = { ...old, rows: [{ ...old.rows[0]!, taskId: "task-current", coordinationStatus: "blocked", snapshot: { ...old.rows[0]!.snapshot, task: currentTask } }] };
  assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...old, rows: [{ ...old.rows[0]!, coordinationStatus: "weird" }] }), []);
  assert.deepEqual(validateDaemonTaskSnapshotList(current), []); assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...current, rows: [{ ...current.rows[0]!, snapshot: { ...current.rows[0]!.snapshot, task: { ...currentTask, metadata: { ...metadata, unknown: true } } } }] }), []);
  assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...current, rows: [{ ...current.rows[0]!, snapshot: { ...current.rows[0]!.snapshot, task: { ...currentTask, provenance: [{ runtime: "unavailable", sessionId: null, boundAt: "2026-08-14T00:00:00.000Z" }] } } }] }), []);
  assert.deepEqual(validateDaemonTaskSnapshotList({ ...current, page: { limit: 25, cursor: null, nextCursor: "WyJ0YXNrLWN1cnJlbnQiXQ" } }), []);
  assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...current, page: { limit: 501, cursor: null, nextCursor: null } }), []);
  const { pinned: _pinned, ...withoutPinned } = currentTask; assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...current, rows: [{ ...current.rows[0]!, snapshot: { ...current.rows[0]!.snapshot, task: withoutPinned } }] }), []); assert.notDeepEqual(validateDaemonTaskSnapshotList({ ...current, rows: [{ ...current.rows[0]!, snapshot: { ...current.rows[0]!.snapshot, task: { ...currentTask, pinned: "true" } } }] }), []);
});

// prettier-ignore

test("task create dry-run validates the exact package without event, revision, commit, or authored writes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-create-preview-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); mkdirSync(path.join(rootDir, "harness/custom"), { recursive: true }); mkdirSync(path.join(rootDir, "harness/templates"), { recursive: true }); writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n  scaffolds:\n    task: custom/task-scaffold.json\n"); writeFileSync(path.join(rootDir, "harness/templates/notes.md"), "# Notes\n\n## Project Notes\n\nCustom.\n"); writeFileSync(path.join(rootDir, "harness/custom/task-scaffold.json"), `${JSON.stringify({ schema: "task-scaffold/v1", replaceTemplate: [], addDocument: [{ slot: "project.notes", path: "notes.md", template: "templates/notes.md", requiredAnchors: ["## Project Notes"] }] })}\n`); cell = await openRepoCell({ repoId: workspaceId("preview"), rootDir: canonicalRoot(rootDir), ownerId: "preview-daemon" }); const action = { kind: "task-create", taskId: "task-preview", title: "Preview Package" } as const, baselineRevision = makeTaskEventReader({ repoId: "preview", rootDir }).read().revision, before = git(rootDir, "rev-parse", "HEAD"), preview = await cell.run({ ...action, dryRun: true }, repoWriteBinding) as Record<string, unknown>; assert.equal(preview.outcome, "pending"); assert.equal(preview.packagePath, "tasks/task-preview-preview-package"); assert.equal(preview.dryRun, true); assert.equal((preview.generatedPaths as string[]).length, 6); assert.equal((preview.generatedPaths as string[]).includes("tasks/task-preview-preview-package/notes.md"), true); assert.equal(makeTaskEventReader({ repoId: "preview", rootDir }).read().revision, baselineRevision); assert.equal(git(rootDir, "rev-parse", "HEAD"), before); assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-preview-preview-package")), false);
    const created = await cell.run(action, repoWriteBinding) as Record<string, unknown>; assert.equal(created.packagePath, preview.packagePath); assert.equal(created.presetDigest, preview.presetDigest); assert.equal(created.scaffoldDigest, preview.scaffoldDigest); assert.equal(typeof created.cut, "object"); assert.equal((created.guidance as { kind: string }[]).some(({ kind }) => kind === "task-create-start"), true); const settled = await waitForAcceptedReceipt(cell, created as { opId: string; acceptance?: { revisionTo?: number } | null }, repoWriteBinding); assert.deepEqual(settled.wait, { state: "satisfied", unsatisfied: [] }); assert.equal(settled.worktree.state, "verified"); assert.equal(execFileSync("git", ["show", "HEAD:harness/tasks/task-preview-preview-package/notes.md"], { cwd: rootDir, encoding: "utf8" }), "# Notes\n\n## Project Notes\n\nCustom.\n"); assert.equal(readFileSync(path.join(rootDir, "harness/custom/task-scaffold.json"), "utf8").includes('"project.notes"'), true); assert.equal(makeTaskEventReader({ repoId: "preview", rootDir }).read().revision, baselineRevision + 1); const duplicate = await cell.run({ ...action, title: "Different title" }, repoWriteBinding); assert.equal(duplicate.outcome, "op_rejected"); assert.equal(duplicate.code, "task_exists"); assert.equal(makeTaskEventReader({ repoId: "preview", rootDir }).read().revision, baselineRevision + 1); const shown = await cell.run({ kind: "task-show", taskId: "task-preview" }, repoWriteBinding); const evidence = JSON.parse(String(shown.evidence)) as { packagePath: string; task: { title: string } }; assert.equal(evidence.packagePath, preview.packagePath); assert.equal(evidence.task.title, "Preview Package");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// prettier-ignore

test("RepoCell rejects completion on snapshot drift and preset upgrade publishes one canonical replacement", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-upgrade-cell-")), source = path.join(rootDir, "source/upgrade-task"), taskId = "task-upgrade-cell", binding = repoWriteBinding; let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const packageBody = (version: string) => JSON.stringify({ schema: "preset-manifest/v3", id: "upgrade-task", title: "Upgrade Task", vertical: "software/coding", version, kind: "template-content", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" }, capabilityImports: [], profiles: [{ id: "baseline", title: "Baseline", completionGates: ["ci", "code-doc-reconciliation"], templateSelections: [] }], defaultProfile: "baseline" });
  try {
    initRepo(rootDir); mkdirSync(source, { recursive: true }); writeFileSync(path.join(source, "preset.json"), packageBody("3.1.0")); writeFileSync(path.join(source, "PRESET.md"), "---\nschema: preset-document/v1\ndescription: Upgrade fixture.\nwhenToUse: Test upgrade.\n---\n# Upgrade\n"); cell = await openRepoCell({ repoId: workspaceId("preset-upgrade-cell"), rootDir: canonicalRoot(rootDir), ownerId: "preset-upgrade-daemon" }); const installed = await cell.run({ kind: "preset-install", packageSource: "source/upgrade-task" }, binding); assert.equal(installed.outcome, "pending"); assert.equal(installed.acceptance, null); const created = await cell.run({ kind: "task-create", taskId, title: "Upgrade Cell", presetId: "upgrade-task" }, binding) as Record<string, unknown>, previousDigest = String(created.presetDigest); const createdVisible = await waitForAcceptedReceipt(cell, created as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); writeFileSync(path.join(source, "preset.json"), packageBody("3.2.0")); const reinstalled = await cell.run({ kind: "preset-install", packageSource: "source/upgrade-task" }, binding); assert.equal(reinstalled.outcome, "pending"); assert.equal(reinstalled.acceptance, null);
    const blocked = await cell.run({ kind: "task-complete", taskId, executionId: "execution-missing" }, binding); assert.equal(blocked.code, "preset_snapshot_mismatch"); const upgraded = await cell.run({ kind: "preset-upgrade", taskId }, binding) as Record<string, unknown>; assert.equal(upgraded.outcome, "applied"); const evidence = JSON.parse(String(upgraded.evidence)) as { previousDigest: string; digest: string }; assert.equal(evidence.previousDigest, previousDigest); assert.notEqual(evidence.digest, previousDigest); const event = makeTaskEventReader({ repoId: "preset-upgrade-cell", rootDir }).readEvent(String(upgraded.opId)); assert.equal(event?.schema, "preset-snapshot-upgrade-event/v1"); assert.equal((await cell.run({ kind: "task-complete", taskId, executionId: "execution-missing" }, binding)).code, "not_in_review");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// prettier-ignore

test("RepoCell serializes identical lifecycle intents into one accepted SQLite outcome", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId: workspaceId("alpha"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" });
    const baselineRevision = makeTaskEventReader({ repoId: "alpha", rootDir }).read().revision;
    const action = { kind: "task-create", taskId: "task-alpha", title: "Alpha task" } as const;

    const [left, right] = await Promise.all([
      cell.run(action, repoWriteBinding),
      cell.run(action, repoWriteBinding)
    ]);

    assert.deepEqual([left.outcome, right.outcome], ["applied", "applied"], JSON.stringify([left, right]));
    assert.equal(left.opId, right.opId);
    assert.equal(left.revision, baselineRevision + 1);
    assert.deepEqual(left.cut, right.cut);
    assert.equal(left.status, "accepted_durable");
    assert.equal(right.status, "accepted_durable");
    assertValidWriteReceipt(left);
    assertValidWriteReceipt(right);
    const reader = makeTaskEventReader({ repoId: "alpha", rootDir });
    assert.equal(reader.read().events.filter((event) => event.opId === left.opId).length, 1);
    assert.equal(reader.readCommandOutcome(left.opId)?.status, "accepted_durable");
    await reader.drain();
    const shown = await cell.run({ kind: "task-show", verb: "show", taskId: "task-alpha" }, repoWriteBinding);
    assert.equal(shown.outcome, "applied");
    assert.match(String(shown.evidence), /Alpha task/u);
    const settled = await cell.run({ kind: "receipt-show", opId: left.opId,
      waitFor: ["accepted_durable", "projection_visible", "git_verified"], timeoutMs: 5_000 }, repoWriteBinding);
    assert.equal(settled.wait?.state, "satisfied", JSON.stringify(settled));
    await cell.close(); cell = undefined;
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// prettier-ignore

test("GUI and CLI submit derive the same canonical event from closeout", async () => {
  const roots = ["packet", "structured"].map((name) => mkdtempSync(path.join(tmpdir(), `ha-submit-ab-${name}-`)));
  const cells: Awaited<ReturnType<typeof openRepoCell>>[] = [];
  const now = () => "2026-08-14T01:02:03.000Z", taskId = "task-submit-ab", executionId = "execution-submit-ab", binding = repoWriteBinding;
  try {
    roots.forEach(initDeterministicRepo);
    for (const [index, rootDir] of roots.entries()) cells.push(await openRepoCell({ repoId: workspaceId("submit-ab"), rootDir: canonicalRoot(rootDir), ownerId: `submit-ab-${index}`, now }));
    for (const [index, cell] of cells.entries()) { const created = await cell.run({ kind: "task-create", taskId, title: "Submit A B" }, binding); assert.equal(created.outcome, "applied"); const visible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(visible.wait?.state, "satisfied", JSON.stringify(visible)); await realizeTaskPlanFixture(roots[index]!, String((created as Record<string, unknown>).packagePath), (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding)); assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied"); }
    for (const [index, rootDir] of roots.entries())
      await writeCloseout(
        () => cells[index]!.settlePendingMaterialization("closeout git commit"),
        rootDir,
        "tasks/task-submit-ab-submit-a-b",
        "Typed GUI submit is equivalent.",
      );
    assert.equal((await cells[0]!.run({ kind: "task-submit", taskId, executionId }, binding)).outcome, "applied");
    const server = createJsonRpcProtocolServer({ host: { remoteProxy: { route: () => false }, run: async (_repoId: string, action: Record<string, unknown>) => cells[1]!.run(action as { readonly kind: string }, binding) } as never, build: { commit: null }, authContext: {} as never, emit: async () => undefined }); await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } }); const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "repo.task.submit", params: { repo: { repoId: "submit-ab" }, payload: { taskId, executionId } } }); assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response)); assert.equal((response as { result: { outcome: string } }).result.outcome, "applied", JSON.stringify(response)); server.close();
    const events = roots.map((rootDir) => makeTaskEventReader({ repoId: "submit-ab", rootDir }).read().events.find((event) => event.type === "execution_submitted"));
    assert.equal(events[0]?.schema, "task-event/v1"); assert.equal(events[1]?.schema, "task-event/v1"); assert.equal(events[0]?.type, "execution_submitted"); assert.equal(events[1]?.type, "execution_submitted"); if (events[0]?.schema === "task-event/v1" && events[1]?.schema === "task-event/v1" && events[0].type === "execution_submitted" && events[1].type === "execution_submitted") { assert.deepEqual({ taskId: events[1].taskId, actor: events[1].actor, source: events[1].source, submission: { ...events[1].payload.submission, commitSha: "<repo-cut>" } }, { taskId: events[0].taskId, actor: events[0].actor, source: events[0].source, submission: { ...events[0].payload.submission, commitSha: "<repo-cut>" } }); }
    const projected = await cells[1]!.read("repo.tasks.list"), row = projected.rows[0]!;
    assert.deepEqual(row.snapshotAvailability, { consents: "known", codeDocWitnesses: "known", gateWitnesses: "known" });
    assert.deepEqual({ parentTaskId: row.placement.parentTaskId, origin: row.placement.origin, packageDisposition: row.placement.packageDisposition }, { parentTaskId: null, origin: "native", packageDisposition: "active" });
    assert.equal(row.placement.provenance.length > 0, true);
    assert.equal(row.executionEvidence[0]!.executionId, executionId);
    assert.deepEqual(row.executionEvidence[0]!.outputs, []);
    assert.deepEqual(validateDaemonTaskSnapshotList(projected), []);
  } finally { await Promise.all(cells.map((cell) => cell.close())); roots.forEach((root) => rmSync(root, { recursive: true, force: true })); }
});

// prettier-ignore

test("lifecycle commands publish typed events, machine files, rebuildable L2, and complete receipts in one cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-files-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const taskId = "task-life", executionId = "execution-life", packagePath = "tasks/task-life-lifecycle-files", binding = repoWriteBinding;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("lifecycle-files"), rootDir: canonicalRoot(rootDir), ownerId: "lifecycle-daemon" });
    const created = await cell.run({ kind: "task-create", taskId, title: "Lifecycle files" }, binding); assert.equal(created.outcome, "applied"); const createdVisible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding));
    const assertCut = async (receipt: Record<string, unknown>, type: string, paths: readonly string[]) => { assert.equal(receipt.outcome, "applied", JSON.stringify(receipt)); assert.equal(receipt.status, "accepted_durable"); assert.equal(receipt.taskId, taskId); assert.equal(receipt.executionId, executionId); assert.deepEqual(receipt.changedPaths, paths); assert.equal(typeof receipt.cut, "object"); assert.equal(typeof receipt.transition, "object"); assert.equal(Array.isArray(receipt.next), true); const event = makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readEvent(String(receipt.opId)); assert.equal(event?.type, type); if (event?.schema !== "task-event/v1") throw new Error("lifecycle receipt requires a TaskEvent"); assert.deepEqual(event.payload.documentClaims?.map((claim) => claim.path), paths); const visible = await waitForAcceptedReceipt(cell!, receipt as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(visible.wait?.state, "satisfied", JSON.stringify(visible)); for (const target of paths) assert.equal(existsSync(path.join(rootDir, "harness", target)), true, target); };
    const indexPath = `${packagePath}/INDEX.md`, executionPath = `${packagePath}/executions/${executionId}.md`, reviewPath = `${packagePath}/reviews/review-life.md`, codeDocPath = `${packagePath}/code-doc-anchors.json`;
    const started = await cell.run({ kind: "task-start", taskId, executionId }, binding) as unknown as Record<string, unknown>; await assertCut(started, "execution_started", [indexPath, executionPath]); assert.match(readFileSync(path.join(rootDir, "harness", executionPath), "utf8"), /State: active/u);
    assert.equal((started.authorizationDecision as Record<string, unknown>).policyRef, "default@5");
    assert.equal((started.authorizationDecision as Record<string, unknown>).outcome, "allowed");
    const beforeInvalidSubmit = makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readHead()?.revision;
    writeFileSync(path.join(rootDir, "harness", packagePath, "closeout.md"), "# Closeout\n\n## Summary\n\nIncomplete.\n");
    const invalidSubmit = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
    assert.equal(invalidSubmit.outcome, "op_rejected");
    assert.equal(makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readHead()?.revision, Number(beforeInvalidSubmit) + 1);
    assert.equal(makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).read().events.some((event) => event.type === "execution_submitted"), false);
    const commitSha = await writeCloseout(
      () => cell!.settlePendingMaterialization("closeout git commit"),
      rootDir,
      packagePath,
      "Lifecycle output is ready.",
    );
    const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding) as unknown as Record<string, unknown>; await assertCut(submitted, "execution_submitted", [indexPath, executionPath]); assert.deepEqual(submitted.transition, { from: "active/implementation", to: "in_review/review" }); assert.match(readFileSync(path.join(rootDir, "harness", executionPath), "utf8"), /State: submitted[\s\S]*Lifecycle output is ready/u);
    writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "Independent review passed.", evidenceChecked: ["tests"] })); const reviewBinding = withRoleBinding({ actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "arbiter" } }, source: "local" as const }, "arbiter");
    const reviewed = await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "review-life", fromFile: "review.json" }, reviewBinding) as unknown as Record<string, unknown>; await assertCut(reviewed, "review_recorded", [indexPath, executionPath, reviewPath]); assert.equal(reviewed.reviewId, "review-life"); assert.match(readFileSync(path.join(rootDir, "harness", reviewPath), "utf8"), /Verdict: approved[\s\S]*Consent: pending/u);
    assert.equal((reviewed.authorizationDecision as Record<string, unknown>).policyRef, "default@5");
    assert.equal((reviewed.authorizationDecision as Record<string, unknown>).outcome, "allowed");
    const reviewEvent = makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readEvent(String(reviewed.opId)); if (reviewEvent?.type !== "review_recorded") throw new Error("review event missing"); assert.equal(reviewed.reviewDigest, reviewDigest(reviewEvent.payload.review)); assert.equal(reviewed.contentDigest, reviewEvent.payload.review.contentDigest);
    const consented = await cell.run({ kind: "task-review-consent", taskId, executionId, reviewId: "review-life" }, binding) as unknown as Record<string, unknown>; await assertCut(consented, "review_consent_recorded", [indexPath, executionPath, reviewPath]); assert.match(readFileSync(path.join(rootDir, "harness", reviewPath), "utf8"), /Consent: consent-[0-9a-f]+[\s\S]*Consent actor: person-owner/u);
    assert.equal((consented.authorizationDecision as Record<string, unknown>).policyRef, "default@5");
    assert.equal((consented.authorizationDecision as Record<string, unknown>).outcome, "allowed");
    const witnessedPath = "README.md", beforeInvalidWitness = makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readHead()?.revision; assert.equal((await cell.run({ kind: "task-code-doc-reconcile", taskId, executionId, commitSha, iteration: 0, paths: [witnessedPath] }, binding)).outcome, "op_rejected"); assert.equal(makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readHead()?.revision, beforeInvalidWitness); const reconciled = await cell.run({ kind: "task-code-doc-reconcile", taskId, paths: [witnessedPath] }, binding) as unknown as Record<string, unknown>; await assertCut(reconciled, "code_doc_reconciled", [indexPath, executionPath, codeDocPath]); assert.deepEqual(JSON.parse(readFileSync(path.join(rootDir, "harness", codeDocPath), "utf8")), { schema: "code-doc-witness/v1", witnessId: String((makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readEvent(String(reconciled.opId)) as { payload: { witness: { witnessId: string } } }).payload.witness.witnessId), taskId, executionId, commitSha, iteration: 0, paths: [witnessedPath], actor, source: "local", reconciledAt: (makeTaskEventReader({ repoId: "lifecycle-files", rootDir }).readEvent(String(reconciled.opId)) as { occurredAt: string }).occurredAt });
    const lookedUp = await cell.run({ kind: "receipt-show", opId: reconciled.opId }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ taskId: lookedUp.taskId, executionId: lookedUp.executionId, transition: lookedUp.transition, changedPaths: lookedUp.changedPaths }, { taskId, executionId, transition: reconciled.transition, changedPaths: reconciled.changedPaths });
    await cell.close(); cell = undefined; const store = makeTaskEventReader({ repoId: "lifecycle-files", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore: store }); projection.close(); rmSync(projection.path, { force: true }); assert.equal(projection.rebuild().watermark, store.read().revision); assert.equal(projection.read(taskId).snapshot.codeDocWitnesses.length, 1); for (const target of [indexPath, executionPath, reviewPath, codeDocPath]) assert.equal(projection.readDocument(target).document?.body, readFileSync(path.join(rootDir, "harness", target), "utf8")); projection.close(); await store.drain();
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// prettier-ignore

test("code-doc repoint appends a replacement witness and rejects stale or unknown records", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-code-doc-repoint-")),
    taskId = "task-code-doc-repoint",
    executionId = "execution-code-doc-repoint",
    repoId = workspaceId("code-doc-repoint");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "code-doc-repoint" });
    await prepareReadyCompletion(cell, rootDir, repoId, taskId, executionId, "Repoint Ledger");
    const anchorPath = path.join(
        rootDir,
        "harness",
        "tasks/task-code-doc-repoint-repoint-ledger/code-doc-anchors.json",
      ),
      originalBytes = readFileSync(anchorPath),
      original = JSON.parse(originalBytes.toString("utf8")) as { witnessId: string; commitSha: string };
    const completed = await cell.run(
      { kind: "task-complete", taskId, executionId },
      repoWriteBinding,
    );
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    const missingBefore = makeTaskEventReader({ repoId, rootDir }).read().revision,
      unknown = await cell.run(
        {
          kind: "task-code-doc-repoint",
          taskId,
          record: "code-doc-missing",
          paths: ["README.md"],
          reason: "Unknown anchor",
        },
        repoWriteBinding,
      );
    assert.equal(unknown.outcome, "op_rejected");
    assert.equal(makeTaskEventReader({ repoId, rootDir }).read().revision, missingBefore);
    const action = {
        kind: "task-code-doc-repoint",
        taskId,
        record: original.witnessId,
        paths: ["README.md"],
        reason: "Correct archive root",
      } as const,
      repointed = (await cell.run(action, repoWriteBinding)) as Record<string, unknown>;
    assert.equal(repointed.outcome, "applied", JSON.stringify(repointed));
    const repointedVisible = await waitForAcceptedReceipt(cell, repointed as { opId: string; acceptance?: { revisionTo?: number } | null });
    assert.equal(repointedVisible.wait?.state, "satisfied", JSON.stringify(repointedVisible));
    const afterBytes = readFileSync(anchorPath),
      lines = afterBytes
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(afterBytes.subarray(0, originalBytes.length), originalBytes);
    assert.equal(lines.length, 2);
    assert.equal(lines[1]!.supersedes, original.witnessId);
    assert.equal(lines[1]!.disposition, "repointed");
    const projection = await cell.read("repo.tasks.list"),
      row = projection.rows.find((value) => value.taskId === taskId);
    assert.ok(row, JSON.stringify(projection));
    assert.deepEqual(validateDaemonTaskSnapshotList(projection), []);
    assert.equal(
      row.closeoutAssessment.gates.find((gate) => gate.gateId === "code-doc-reconciliation")?.status,
      "passed",
    );
    assert.deepEqual(
      row.snapshot.codeDocWitnesses.map((witness) =>
        witness.schema === "code-doc-witness/v1" ? witness.witnessId : witness.recordId,
      ),
      [original.witnessId, lines[1]!.recordId],
    );
    const duplicate = await cell.run(action, repoWriteBinding);
    assert.equal(duplicate.outcome, "op_rejected");
    assert.deepEqual(readFileSync(anchorPath), afterBytes);
    const knownInvalid = (await cell.run(
      {
        ...action,
        record: String(lines[1]!.recordId),
        paths: [],
        reason: "Commit unresolvable after rebuild line reset",
      },
      repoWriteBinding,
    )) as Record<string, unknown>;
    assert.equal(knownInvalid.outcome, "applied", JSON.stringify(knownInvalid));
    const invalidVisible = await waitForAcceptedReceipt(cell, knownInvalid as { opId: string; acceptance?: { revisionTo?: number } | null });
    assert.equal(invalidVisible.wait?.state, "satisfied", JSON.stringify(invalidVisible));
    const afterKnownInvalid = readFileSync(anchorPath),
      invalidLines = afterKnownInvalid
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(afterKnownInvalid.subarray(0, afterBytes.length), afterBytes);
    assert.equal(invalidLines[2]!.supersedes, lines[1]!.recordId);
    assert.equal(invalidLines[2]!.disposition, "known-invalid");
    const invalidProjection = await cell.read("repo.tasks.list"),
      invalidRow = invalidProjection.rows.find((value) => value.taskId === taskId)!;
    assert.deepEqual(validateDaemonTaskSnapshotList(invalidProjection), []);
    assert.equal(
      invalidRow.closeoutAssessment.gates.find((gate) => gate.gateId === "code-doc-reconciliation")?.status,
      "missing",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// prettier-ignore

test("milestone-closeout uses the normal completion facade, review, and gates exactly once", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-completion-facade-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const taskId = "task-complete",
    executionId = "execution-complete",
    packagePath = "tasks/task-complete-completion-facade",
    binding = repoWriteBinding,
    ownerFromAnotherAgent = withRoleBinding({
      actor: {
        principal: actor.principal,
        executor: { kind: "agent" as const, id: "other-owner-agent" },
      },
      source: "local" as const,
    }, "repo-write");
  try {
    initRepo(rootDir); mkdirSync(path.join(rootDir, "harness"), { recursive: true }); writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n  ci:\n    workflows: [rewrite-ci]\n  closeout:\n    profile: strict\n"); /* The completion facade is a strict-profile closeout gate. */ cell = await openRepoCell({ repoId: workspaceId("completion-facade"), rootDir: canonicalRoot(rootDir), ownerId: "completion-daemon" }); const store = () => makeTaskEventReader({ repoId: "completion-facade", rootDir });
    const created = await cell.run({ kind: "task-create", taskId, title: "Completion facade", presetId: "milestone-closeout" }, binding); const createdVisible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding)); await cell.run({ kind: "task-start", taskId, executionId }, binding);
    const activeRow = (await cell.read("repo.tasks.list")).rows.find((row) => row.taskId === taskId)!,
      guiActive = (await cell.read("repo.tasks.completion.read", { taskId })).completionNext, eventsBefore = store().read().events,
      dispatchesBefore = readDispatchStreamHeaders(rootDir).length;
    const shown = await cell.run({ kind: "task-show", taskId }, binding);
    assert.deepEqual(JSON.parse(shown.evidence!).completionNext, guiActive);
    assert.equal(Object.hasOwn(activeRow, "completionNext"), false);
    const activeRevision = store().read().revision, active = await cell.run({ kind: "task-complete", taskId, executionId }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: active.outcome, code: active.code, stoppedAt: active.stoppedAt, next: active.next }, { outcome: "op_rejected", code: "not_in_review", stoppedAt: "not_in_review", next: [{ action: `Fill harness/${packagePath}/closeout.md with the verified delivery, then submit execution ${executionId}.`, reason: `Execution is held by ${actor.executor!.id}.`, authority: actor.executor!.id, readCut: { revision: (active.next as { readCut: { revision: number } }[])[0]!.readCut.revision, iteration: 0, executionId } }] }); assert.equal(store().read().revision, activeRevision); assert.deepEqual((active.next as unknown[])[0], guiActive);
    const carriedActive = await cell.run({ kind: "task-complete", taskId, docChanges: [] }, binding) as unknown as Record<string, unknown>;
    assert.deepEqual(carriedActive.next, active.next);
    assert.deepEqual(store().read().events, eventsBefore);
    assert.deepEqual((await cell.read("repo.tasks.list")).rows.find((row) => row.taskId === taskId)!.snapshot.lease, activeRow.snapshot.lease);
    assert.equal(readDispatchStreamHeaders(rootDir).length, dispatchesBefore);

    await cell.run({ kind: "task-progress-append", taskId, text: "implementation complete", evidence: [] }, binding); await cell.run({ kind: "fact-record", taskId, statement: "Completion uses canonical witnesses.", evidenceSource: "test:completion", confidence: "high", memoryClass: "semantic", memoryTags: [] }, binding);
    const closeoutPath = `${packagePath}/closeout.md`, artifactPath = `${packagePath}/artifacts/evidence.md`; writeFileSync(path.join(rootDir, "harness", closeoutPath), "# Closeout\n\n## Summary\n\nComplete.\n\n## Verification\n\nAll checks passed.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n"); writeFileSync(path.join(rootDir, "harness", artifactPath), "# Evidence\n\nCanonical flow.\n");
    const commitSha = await writeCloseout(
      () => cell!.settlePendingMaterialization("closeout git commit"),
      rootDir,
      packagePath,
      "All required outputs are complete.",
      "All checks passed.",
    );
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, binding)).outcome, "applied");
    const missingCi = await cell.run({ kind: "task-complete", taskId, executionId }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: missingCi.outcome, code: missingCi.code, steps: missingCi.steps }, { outcome: "op_rejected", code: "ci_missing", steps: [] }); await publishCiObservation("completion-facade", rootDir, executionId, commitSha, "run-completion-facade");
    const beforeReviewBlock = store().read().revision,
      missingReview = await cell.run({ kind: "task-complete", taskId, executionId }, binding) as unknown as Record<string, unknown>;
    assert.deepEqual({ outcome: missingReview.outcome, code: missingReview.code }, { outcome: "op_rejected", code: "review_missing" });
    assert.deepEqual((missingReview.steps as { opId: string }[]).map((step) => store().readEvent(step.opId)?.type), ["completion_gate_verified"]);
    assert.equal(store().read().revision, beforeReviewBlock + 1);
    const reviewBinding = (id: string) => withRoleBinding({ actor: { principal: { personId: `person-${id}` }, executor: { kind: "agent" as const, id } }, source: "local" as const }, "arbiter");
    const recordReview = async (reviewId: string, verdict: "approved" | "dismissed") => { writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict, reason: `${reviewId} ${verdict}.`, evidenceChecked: ["tests"] })); const receipt = await cell!.run({ kind: "task-review-execution", taskId, executionId, reviewId, fromFile: "review.json" }, reviewBinding(reviewId)); assert.equal(receipt.outcome, "applied", JSON.stringify(receipt)); const visible = await waitForAcceptedReceipt(cell!, receipt, binding); assert.equal(visible.wait?.state, "satisfied", JSON.stringify(visible)); return receipt; };
    await recordReview("review-dismissed", "dismissed");
    assert.match(readFileSync(path.join(rootDir, "harness", `${packagePath}/INDEX.md`), "utf8"), /ha task complete/u, "a dismissed Review must leave the execution awaiting review");
    await recordReview("review-unselected", "approved");
    await recordReview("review-complete", "approved");
    const reviewEvents = store().read().events.filter((event) => event.type === "review_recorded"); assert.deepEqual(reviewEvents.map((event) => event.payload.review.reviewId), ["review-dismissed", "review-unselected", "review-complete"]);
    const executionPath = path.join(rootDir, "harness", `${packagePath}/executions/${executionId}.md`); assert.match(readFileSync(executionPath, "utf8"), /Reviews: review-dismissed\/dismissed, review-unselected\/approved, review-complete\/approved[\s\S]*Selected review: pending/u);
    writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "duplicate id", evidenceChecked: ["tests"] })); const duplicateReview = await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "review-complete", fromFile: "review.json" }, reviewBinding("duplicate-reviewer")); assert.equal(duplicateReview.outcome, "op_rejected"); assert.equal(duplicateReview.code, "invalid_transition"); assert.deepEqual(duplicateReview.diagnostic, { kind: "failure", code: "invalid_transition" });
    const missingConsent = await cell.run({ kind: "task-complete", taskId, executionId }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: missingConsent.outcome, code: missingConsent.code, steps: missingConsent.steps }, { outcome: "op_rejected", code: "consent_missing", steps: [] }); const rejectedShow = JSON.parse(String((await cell.run({ kind: "task-show", taskId }, binding)).evidence)) as { task: { status: string; currentNode: string } }; assert.deepEqual({ status: rejectedShow.task.status, currentNode: rejectedShow.task.currentNode }, { status: "in_review", currentNode: "review" });
    const consented = await cell.run(
      {
        kind: "task-review-consent",
        taskId,
        executionId,
        reviewId: "review-complete",
      },
      ownerFromAnotherAgent,
    ) as unknown as Record<string, unknown>;
    assert.equal(consented.outcome, "applied", JSON.stringify(consented));
    assert.equal(consented.reviewId, "review-complete");
    const consentVisible = await waitForAcceptedReceipt(cell, consented as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(consentVisible.wait?.state, "satisfied", JSON.stringify(consentVisible));
    assert.match(readFileSync(executionPath, "utf8"), /Selected review: review-complete[\s\S]*Consent: consent-[0-9a-f]+/u); assert.match(readFileSync(path.join(rootDir, "harness", `${packagePath}/reviews/review-unselected.md`), "utf8"), /Consent: pending/u); assert.match(readFileSync(path.join(rootDir, "harness", `${packagePath}/reviews/review-complete.md`), "utf8"), /Consent: consent-[0-9a-f]+/u);

    const completed = await cell.run(
      { kind: "task-complete", taskId, executionId },
      ownerFromAnotherAgent,
    ) as unknown as Record<string, unknown>;
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    assert.equal(completed.reviewId, "review-complete");
    assert.equal(completed.stoppedAt, undefined);
    assert.deepEqual(
      (completed.steps as { opId: string }[]).map((step) => store().readEvent(step.opId)?.type),
      ["task_completed"],
    );
    assert.deepEqual(completed.gateChecks, [
      {
        gate: "ci",
        status: "pass",
        witnessRef: (completed.gateChecks as { witnessRef: string }[])[0]!.witnessRef,
      },
      {
        gate: "code-doc-reconciliation",
        status: "pass",
        witnessRef: (completed.gateChecks as { witnessRef: string }[])[1]!.witnessRef,
      },
    ]);
    assert.deepEqual(completed.next, []);
    assert.equal(readFileSync(path.join(rootDir, "harness", closeoutPath), "utf8").includes("All checks passed"), true);
    assert.equal(readFileSync(path.join(rootDir, "harness", artifactPath), "utf8").includes("Canonical flow"), true);
    assert.equal((completed.authorizationDecision as Record<string, unknown>).policyRef, "default@5");
    assert.equal((completed.authorizationDecision as Record<string, unknown>).outcome, "allowed");
    assert.deepEqual(
      (completed.authorizationDecision as { bindingsUsed: readonly Readonly<Record<string, unknown>>[] }).bindingsUsed,
      [
        {
          predicate: "hasRoleBinding",
          satisfied: true,
          role: "repo-write",
          matched: {
            actor: { kind: "person", id: actor.principal.personId },
            role: "repo-write",
            target: "settings/repository",
            source: "declared",
            expiresAt: null,
          },
        },
      ],
    );
    const completeEvent = store().readEvent(String(completed.opId)); assert.equal(completeEvent?.type, "task_completed"); assert.equal(store().read().events.filter((event) => event.type === "task_completed").length, 1); assert.equal(store().read().events.filter((event) => event.type !== "task_completed").every((event) => event.schema !== "task-event/v1" || event.payload.task.status !== "done"), true); const revision = store().read().revision, repeated = await cell.run({ kind: "task-complete", taskId, executionId }, binding); assert.equal(repeated.opId, completed.opId); assert.equal(store().read().revision, revision);
    const completedShow = JSON.parse(String((await cell.run({ kind: "task-show", taskId }, binding)).evidence)) as { task: { status: string; currentNode: string } }, completedList = JSON.parse(String((await cell.run({ kind: "task-list" }, binding)).evidence)) as { rows: { taskId: string; status: string }[] }; assert.deepEqual({ status: completedShow.task.status, currentNode: completedShow.task.currentNode }, { status: "done", currentNode: "review" }); assert.equal(completedList.rows.find((row) => row.taskId === taskId)?.status, "done");
    await cell.close(); cell = undefined; const rebuilt = makeTaskProjection({ rootDir, eventStore: store() }); rebuilt.close(); rmSync(rebuilt.path, { force: true }); rebuilt.rebuild(); assert.equal(rebuilt.read(taskId).snapshot.task?.status, "done"); assert.equal(rebuilt.read(taskId).snapshot.task?.currentNode, "review"); assert.equal(rebuilt.read(taskId).snapshot.gateWitnesses.length, 1); rebuilt.close();
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// prettier-ignore

test("CompleteTask response loss settles by stable receipt and never publishes a second completion", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-complete-unknown-")), taskId = "task-unknown-complete", executionId = "execution-unknown-complete", repoId = workspaceId("complete-unknown"); let armed = false, cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); mkdirSync(path.join(rootDir, "harness"), { recursive: true }); writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n  ci:\n    workflows: [rewrite-ci]\n"); /* CI witnessing is opt-in per repository */ cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "complete-unknown-one", killpoint: (point) => { if (armed && point === "before_response_write" && makeTaskEventReader({ repoId, rootDir }).read().events.some((event) => event.type === "task_completed")) { armed = false; throw new Error("response lost"); } } }); await prepareReadyCompletion(cell, rootDir, repoId, taskId, executionId, "Unknown complete"); const store = () => makeTaskEventReader({ repoId, rootDir }), before = store().read().revision; armed = true;
    const unknown = await cell.run({ kind: "task-complete", taskId, executionId }, repoWriteBinding) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: unknown.outcome, status: unknown.status, code: unknown.code, stoppedAt: unknown.stoppedAt }, { outcome: "applied", status: "accepted_durable", code: "publication_indeterminate", stoppedAt: "complete-settlement" }); assert.match(String((unknown.next as { command: string }[])[0]?.command), new RegExp(`receipt show ${unknown.opId}`, "u")); assert.equal(store().read().revision, before + 2); assert.equal(store().read().events.filter((event) => event.type === "task_completed").length, 1); assert.equal(cell.status().state, "attached"); await cell.close(); cell = undefined;
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "complete-unknown-two" }); const settled = await cell.run({ kind: "receipt-show", opId: String(unknown.opId) }, repoWriteBinding), retried = await cell.run({ kind: "task-complete", taskId, executionId }, repoWriteBinding); assert.equal(settled.outcome, "applied", JSON.stringify(settled)); assert.equal(retried.outcome, "applied", JSON.stringify(retried)); assert.equal(retried.opId, unknown.opId); assert.equal(store().read().revision, before + 2); assert.equal(store().read().events.filter((event) => event.type === "task_completed").length, 1);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// prettier-ignore

test("Fact record publishes one event, L2 row, authored facts document, and supersession history", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-invalid-fact-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("invalid-fact"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" }); const baselineHead = makeTaskEventReader({ repoId: "invalid-fact", rootDir }).readHead(), baselineRevision = baselineHead?.revision ?? 0;
    const receipt = await cell.run({ kind: "fact-record", taskId: "task-fact", statement: "Observed", evidenceSource: "test", confidence: "high", memoryClass: "semantic", memoryTags: [],
      supersedes: { factRef: "fact/F-ABCDEFGH", rationale: "x".repeat(200) } }, repoWriteBinding);
    assert.deepEqual({ outcome: receipt.outcome, code: receipt.code, state: cell.status().state }, { outcome: "op_rejected", code: "task_not_found", state: "attached" });
    assert.deepEqual(makeTaskEventReader({ repoId: "invalid-fact", rootDir }).readHead(), baselineHead);
    const binding = repoWriteBinding, created = await cell.run({ kind: "task-create", taskId: "task-fact", title: "Fact History" }, binding); assert.equal(created.outcome, "applied"); const taskVisible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(taskVisible.wait?.state, "satisfied", JSON.stringify(taskVisible));
    const firstAction = { kind: "fact-record", taskId: "task-fact", statement: "Canonical facts are event-backed.", evidenceSource: "test:first", confidence: "high", memoryClass: "semantic", memoryTags: ["pattern"] }, first = await cell.run(firstAction, binding) as Record<string, unknown>; assert.equal(first.outcome, "applied", JSON.stringify(first)); assert.match(String(first.path), /^facts\/F-[0-9A-HJKMNP-TV-Z]{8}\.md$/u); assert.equal(first.status, "accepted_durable"); assert.equal(typeof first.cut, "object"); const firstVisible = await waitForAcceptedReceipt(cell, first as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(firstVisible.wait?.state, "satisfied", JSON.stringify(firstVisible)); const firstId = String(first.factId), factsPath = `facts/${firstId}.md`, factsFile = path.join(rootDir, "harness", factsPath); assert.equal(readFileSync(factsFile, "utf8").includes(`### ${firstId}`), true); const replay = await cell.run(firstAction, binding); assert.equal(replay.outcome, "applied", JSON.stringify(replay)); assert.equal(replay.status, "accepted_durable"); assert.equal(replay.opId, first.opId); assert.deepEqual(replay.acceptance, first.acceptance); const firstEvent = makeTaskEventReader({ repoId: "invalid-fact", rootDir }).readEvent(String(first.opId)); assert.equal(firstEvent?.schema, "fact-event/v1"); if (firstEvent?.schema === "fact-event/v1") { assert.equal(firstEvent.payload.factsDocumentClaim.path, factsPath); assert.equal(firstEvent.workspaceRevision, first.revision); }
    const second = await cell.run({ kind: "fact-record", taskId: "task-fact", statement: "Canonical facts also have per-fact documents.", evidenceSource: "test:second", confidence: "high", memoryClass: "semantic", memoryTags: ["pattern"], supersedes: { factRef: `fact/${firstId}`, rationale: "The stronger observation supersedes the first." } }, binding) as Record<string, unknown>; assert.equal(second.outcome, "applied", JSON.stringify(second)); const secondVisible = await waitForAcceptedReceipt(cell, second as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(secondVisible.wait?.state, "satisfied", JSON.stringify(secondVisible)); const secondId = String(second.factId), secondPath = `facts/${secondId}.md`; assert.equal(readFileSync(path.join(rootDir, "harness", secondPath), "utf8").includes(`### ${secondId}`), true); const shown = await cell.run({ kind: "fact-show", factId: firstId }, binding); assert.equal((JSON.parse(String(shown.evidence)) as { fact: { state: string } }).fact.state, "superseded_fact"); assert.equal(makeTaskEventReader({ repoId: "invalid-fact", rootDir }).readHead()?.revision, baselineRevision + 3);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// prettier-ignore

test("invalid Decision payload stays invalid_command and reckon records exact projected basis", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-decision-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("decision-cell"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" }); const binding = repoWriteBinding;
    const created = await cell.run({ kind: "task-create", taskId: "task-decision", title: "Decision evidence" }, binding); assert.equal(created.outcome, "applied"); const taskVisible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(taskVisible.wait?.state, "satisfied", JSON.stringify(taskVisible));
    const beforeMissing = makeTaskEventReader({ repoId: "decision-cell", rootDir }).readHead()!.revision, missing = await cell.run({ kind: "decision-reckon", decisionId: "dec_MISSING", taskId: "task-decision" }, binding);
    assert.deepEqual({ outcome: missing.outcome, code: missing.code, state: cell.status().state }, { outcome: "op_rejected", code: "entity_not_found", state: "attached" }); assert.equal(makeTaskEventReader({ repoId: "decision-cell", rootDir }).readHead()?.revision, beforeMissing);
    const proposal = decisionProposal("Canonical", "Should reckon use the exact basis?"), proposed = await cell.run(proposal, binding);
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed)); const proposedVisible = await waitForAcceptedReceipt(cell, proposed, binding); assert.equal(proposedVisible.wait?.state, "satisfied", JSON.stringify(proposedVisible)); const decisionId = (JSON.parse(proposed.evidence) as { decisionId: string }).decisionId, related = await cell.run({ kind: "relation-relate", sourceRef: `decision/${decisionId}/CH1`, targetRef: "task/task-decision", relationType: "derives", rationale: "Decision creates this task.", expectedVersion: 0 }, binding); assert.equal(related.outcome, "applied", JSON.stringify(related)); const decisionPath = `decisions/decision-${decisionId}/decision.md`, decisionFile = path.join(rootDir, "harness", decisionPath), beforeInvalid = makeTaskEventReader({ repoId: "decision-cell", rootDir }).readHead()!.revision;
    assert.equal((proposed as Record<string, unknown>).path, decisionPath); assert.equal(proposed.status, "accepted_durable");
    const placement = (await cell.read("repo.tasks.list")).rows.find((row) => row.taskId === "task-decision")!.placement; assert.equal(placement.moduleKeys.includes("daemon"), true, JSON.stringify(placement)); assert.equal(placement.provenance.some(({ kind }) => kind === "decision-relation"), true, JSON.stringify(placement));
    const decisionBody = readFileSync(decisionFile, "utf8"); assert.match(decisionBody, /^---\nschema: decision-package\/v1[\s\S]*\nstate: proposed[\s\S]*\n---\n# Canonical\n\nUse the canonical event-backed flow for this fixture\.\n$/u); const decisionEvent = makeTaskEventReader({ repoId: "decision-cell", rootDir }).readEvent(proposed.opId); assert.equal(decisionEvent?.schema, "decision-event/v1"); if (decisionEvent?.schema === "decision-event/v1") { assert.equal(decisionEvent.payload.decisionDocumentClaim.path, decisionPath); assert.equal(decisionEvent.payload.decisionDocumentClaim.sha256, String((proposed as Record<string, unknown>).documentSha256)); }
    const invalid = await cell.run({ kind: "decision-accept", decisionId, rationale: "x".repeat(200) }, withRoleBinding({ actor: { principal: { personId: "person-arbiter" }, executor: null }, source: "local" }, "arbiter"));
    assert.deepEqual({ outcome: invalid.outcome, code: invalid.code, state: cell.status().state }, { outcome: "op_rejected", code: "invalid_command", state: "attached" }); assert.equal(makeTaskEventReader({ repoId: "decision-cell", rootDir }).readHead()?.revision, beforeInvalid);
    const reckon = await cell.run({ kind: "decision-reckon", decisionId, taskId: "task-decision" }, binding); assert.equal(reckon.outcome, "applied", JSON.stringify(reckon)); const fact = JSON.parse(reckon.evidence) as { evidenceSource: string; statement: string; workspaceRevision: number };
    assert.equal(fact.evidenceSource, `decision/${decisionId}@${beforeInvalid}`); assert.match(fact.statement, new RegExp(`basisRevision ${beforeInvalid}`, "u")); assert.equal(fact.workspaceRevision, beforeInvalid + 1);
    const stable = await cell.run({ kind: "receipt-show", opId: proposed.opId }, binding) as Record<string, unknown>; assert.deepEqual({ consentId: stable.consentId, path: stable.path, cut: stable.cut, documentSha256: stable.documentSha256 }, { consentId: (proposed as Record<string, unknown>).consentId, path: (proposed as Record<string, unknown>).path, cut: (proposed as Record<string, unknown>).cut, documentSha256: (proposed as Record<string, unknown>).documentSha256 }); assert.equal((stable.git as { state: string }).state, "verified"); assert.equal((stable.worktree as { state: string }).state, "verified");
    const event = makeTaskEventReader({ repoId: "decision-cell", rootDir }).readEvent(reckon.opId); assert.equal(event?.schema, "fact-event/v1"); if (event?.schema === "fact-event/v1") assert.equal(event.payload.evidenceSource, fact.evidenceSource);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// prettier-ignore

test("Decision proposal packet defaults optional fields, checks boundaries before reads, and leaves the Task INDEX untouched", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-packet-")), outside = `${rootDir}-outside.json`; let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("decision-packet"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" }); const binding = repoWriteBinding, created = await cell.run({ kind: "task-create", taskId: "task-related", title: "Related Task" }, binding) as Record<string, unknown>, createdVisible = await waitForAcceptedReceipt(cell, created as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); const index = path.join(rootDir, "harness", String(created.packagePath), "INDEX.md"), indexBefore = readFileSync(index); const packet = { title: "Atomic proposal", question: "Can one event publish the whole proposal?", riskTier: "medium", urgency: "high", vertical: "default", preset: "default", decisionClass: "ordinary", appliesTo: { modules: ["daemon"], productLines: [] }, chosen: [{ id: "CH1", text: "Publish once" }], rejected: [{ id: "RJ1", text: "Patch later", whyNot: "It exposes partial state" }], claims: [{ id: "C1", text: "The packet is atomic.", loadBearing: true }], fulfillments: [{ claimId: "C1", mode: "delivered" }] }, minimalPacket = (({ vertical: _vertical, preset: _preset, appliesTo: _appliesTo, fulfillments: _fulfillments, ...minimal }) => minimal)(packet), before = makeTaskEventReader({ repoId: "decision-packet", rootDir }).readHead()!.revision;
    // Unknown fields and missing substantive fields remain rejected.
    for (const { action, code, field } of [
      { action: { kind: "decision-propose", jsonInput: JSON.stringify({ ...packet, unknown: true }) }, code: "invalid_command", field: undefined },
      { action: { kind: "decision-propose", jsonInput: JSON.stringify({ title: packet.title }) }, code: "missing_field", field: "question" },
      { action: { kind: "decision-propose", jsonInput: JSON.stringify(packet), body: "inline", bodyFile: "body.md" }, code: "invalid_command", field: undefined },
    ] as const) {
      const rejected = await cell.run(action, binding);
      assert.equal(rejected.outcome, "op_rejected");
      assert.equal(rejected.code, code);
      if (field !== undefined) {
        assert.equal((rejected.diagnostic as { readonly field?: string } | undefined)?.field, field);
      }
      assert.equal(makeTaskEventReader({ repoId: "decision-packet", rootDir }).readHead()?.revision, before);
    }
    const defaulted = await cell.run({ kind: "decision-propose", jsonInput: JSON.stringify(minimalPacket) }, binding) as Record<string, unknown>;
    assert.equal(defaulted.outcome, "applied", JSON.stringify(defaulted));
    assert.deepEqual(JSON.parse(String(defaulted.evidence)).defaultedFields, ["vertical", "preset", "appliesTo", "fulfillments", "relations"]);
    const defaultedEvent = makeTaskEventReader({ repoId: "decision-packet", rootDir }).readEvent(String(defaulted.opId));
    if (defaultedEvent?.schema === "decision-event/v1" && defaultedEvent.type === "decision_proposed") {
      assert.equal(defaultedEvent.payload.vertical, "software/coding"); assert.equal(defaultedEvent.payload.preset, "decision-conformance"); assert.deepEqual(defaultedEvent.payload.appliesTo, { modules: [], productLines: [] }); assert.deepEqual(defaultedEvent.payload.fulfillments, []); assert.deepEqual(defaultedEvent.payload.relations, []);
    } else assert.fail("defaulted decision proposal event was not recorded");
    const afterDefault = makeTaskEventReader({ repoId: "decision-packet", rootDir }).readHead()!.revision;
    const badJson = await cell.run({ kind: "decision-propose", jsonInput: "{" }, binding); assert.equal(badJson.code, "invalid_command"); assert.deepEqual(badJson.diagnostic, { kind: "failure", code: "invalid_command" });
    writeFileSync(path.join(rootDir, "proposal.json"), JSON.stringify(minimalPacket)); const outsidePacket = await cell.run({ kind: "decision-propose", fromFile: outside }, binding); assert.equal(outsidePacket.code, "invalid_command"); assert.deepEqual(outsidePacket.diagnostic, { kind: "workspace-boundary", field: "fromFile", workspaceRoot: realpathSync(rootDir) });
    writeFileSync(path.join(rootDir, "bad.md"), Buffer.from([0xff])); const invalidUtf8 = await cell.run({ kind: "decision-propose", fromFile: "proposal.json", bodyFile: "bad.md" }, binding); assert.equal(invalidUtf8.code, "invalid_command"); assert.equal(makeTaskEventReader({ repoId: "decision-packet", rootDir }).readHead()?.revision, afterDefault);
    const prose = `${realizedDecisionBody("Atomic proposal")}\n初始正文。\n`; writeFileSync(path.join(rootDir, "body.md"), prose); const proposed = await cell.run({ kind: "decision-propose", fromFile: "proposal.json", bodyFile: "body.md" }, binding) as Record<string, unknown>; assert.equal(proposed.outcome, "applied", JSON.stringify(proposed)); assert.equal(proposed.revision, afterDefault + 1); const event = makeTaskEventReader({ repoId: "decision-packet", rootDir }).readEvent(String(proposed.opId)); assert.equal(event?.schema, "decision-event/v1"); if (event?.schema === "decision-event/v1" && event.type === "decision_proposed") { assert.deepEqual(event.payload.claims, packet.claims); assert.deepEqual(event.payload.fulfillments, []); assert.deepEqual(event.payload.relations, []); assert.equal(event.payload.body, prose); }
    const settled = await waitForAcceptedReceipt(cell, proposed as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(settled.wait?.state, "satisfied", JSON.stringify(settled)); const decisionId = (JSON.parse(String(proposed.evidence)) as { decisionId: string }).decisionId, document = readFileSync(path.join(rootDir, "harness", `decisions/decision-${decisionId}/decision.md`), "utf8"), projection = makeTaskProjection({ rootDir, eventStore: makeTaskEventReader({ repoId: "decision-packet", rootDir }) }), projected = projection.readDecision(decisionId).decision; assert.equal(document.endsWith(`---\n${prose}`), true); assert.deepEqual(projected?.claims, [{ ...packet.claims[0], fulfillment: null }]); assert.deepEqual(readFileSync(index), indexBefore); projection.close(); await cell.close(); cell = undefined;
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); rmSync(outside, { force: true }); }
});

// prettier-ignore

test("Decision judgment keeps the transport arbiter gate and returns the embedded consent identity", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-decision-consent-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("decision-consent"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" }); const human = { principal: { personId: "person-ceo" }, executor: null } as const, binding = withRoleBinding({ actor: human, source: "local" as const, authorizationBindingMode: "declared" as const }, "repo-write"), proposed = await cell.run(decisionProposal("Consent", "May the CEO judge this proposal?"), binding), decisionId = (JSON.parse(proposed.evidence) as { decisionId: string }).decisionId, before = makeTaskEventReader({ repoId: "decision-consent", rootDir }).readHead()!.revision;
    const denied = await cell.run({ kind: "decision-accept", decisionId, rationale: "CEO approval", judgmentOnlyRationale: "Explicit CEO judgment." }, binding); assert.deepEqual({ outcome: denied.outcome, code: denied.code }, { outcome: "op_rejected", code: "authorization_denied" }); assert.equal(makeTaskEventReader({ repoId: "decision-consent", rootDir }).readHead()?.revision, before);
    const accepted = await cell.run({ kind: "decision-accept", decisionId, rationale: "CEO approval", judgmentOnlyRationale: "Explicit CEO judgment." }, withRoleBinding(binding, "arbiter")); assert.equal(accepted.outcome, "applied", JSON.stringify(accepted)); assert.match(String((accepted as Record<string, unknown>).consentId), /^djc_[0-9a-f]{26}$/u); const event = makeTaskEventReader({ repoId: "decision-consent", rootDir }).readEvent(accepted.opId); assert.equal(event?.schema, "decision-event/v1"); if (event?.schema === "decision-event/v1" && event.type === "decision_accepted") assert.equal(event.payload.judgmentConsent.consentId, (accepted as Record<string, unknown>).consentId);
    assert.equal(accepted.authorizationDecision?.policyRef, "default@5");
    assert.equal(accepted.authorizationDecision?.outcome, "allowed");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// prettier-ignore

test("Decision full vertical golden rebuilds proposal, prose, claim, relation, consent, list, and show", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-vertical-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); mkdirSync(path.join(rootDir, "packages/daemon"), { recursive: true }); writeFileSync(path.join(rootDir, "packages/daemon/index.ts"), "export const daemon = true;\n"); git(rootDir, "add", "."); git(rootDir, "commit", "--quiet", "-m", "add daemon scope"); cell = await openRepoCell({ repoId: workspaceId("decision-vertical"), rootDir: canonicalRoot(rootDir), ownerId: "decision-vertical" }); const binding = repoWriteBinding, proposal = await cell.run(decisionProposal("Vertical Decision", "Does the full Decision flow rebuild?"), binding), proposalVisible = await waitForAcceptedReceipt(cell, proposal, binding); assert.equal(proposalVisible.wait?.state, "satisfied", JSON.stringify(proposalVisible)); const decisionId = (JSON.parse(String(proposal.evidence)) as { decisionId: string }).decisionId, logical = `decisions/decision-${decisionId}/decision.md`, target = path.join(rootDir, "harness", logical), canonical = readFileSync(target, "utf8"), split = canonical.indexOf("\n---\n", 4) + 5, prose = `${realizedDecisionBody("Vertical Decision")}\nCanonical body from doc-sync.\n`; writeFileSync(target, `${canonical.slice(0, split)}${prose}`);
    const synced = await cell.run({ kind: "doc-submit", paths: [logical] }, binding); assert.equal(synced.outcome, "applied", JSON.stringify(synced)); assert.equal((await cell.run({ kind: "decision-claim-add", decisionId, claimId: "C1", text: "The vertical flow is event-derived.", loadBearing: true }, binding)).outcome, "applied"); assert.equal((await cell.run({ kind: "relation-relate", sourceRef: `decision/${decisionId}/C1`, relationType: "supports", targetRef: `decision/${decisionId}/CH1`, rationale: "The chosen option demonstrates the claim.", expectedVersion: 0 }, binding)).outcome, "applied"); const accepted = await cell.run({ kind: "decision-accept", decisionId, rationale: "Evidence relation reviewed.", judgmentOnlyRationale: null }, withRoleBinding({ actor: { principal: { personId: "person-ceo" }, executor: null }, source: "local" }, "arbiter")); assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    const invalidList = await cell.run({ kind: "decision-list", legacyRange: { start: 10, end: 2 }, authoredFallback: true }, binding); assert.equal(invalidList.code, "invalid_command"); const listed = JSON.parse(String((await cell.run({ kind: "decision-list", search: "Canonical body" }, binding)).evidence)) as { decisions: readonly Record<string, unknown>[] }, shown = JSON.parse(String((await cell.run({ kind: "decision-show", decisionId, includeBody: true }, binding)).evidence)) as { decision: { state: string; body: { body: string }; claims: readonly unknown[]; judgmentConsents: readonly unknown[] } }; assert.deepEqual(listed.decisions.map(({ decisionId: id }) => id), [decisionId]); const pagedList = JSON.parse(String((await cell.run({ kind: "decision-list", limit: 1 }, binding)).evidence)) as { decisions: readonly { decisionId: string }[]; page?: { limit: number; cursor: string | null; nextCursor: string | null } }; assert.deepEqual(pagedList.decisions.map(({ decisionId: id }) => id), [decisionId]); assert.deepEqual(pagedList.page, { limit: 1, cursor: null, nextCursor: null }); assert.equal(Object.hasOwn(listed.decisions[0]!, "body"), false); assert.deepEqual({ state: shown.decision.state, body: shown.decision.body.body, claims: shown.decision.claims.length, consents: shown.decision.judgmentConsents.length }, { state: "in_effect", body: prose, claims: 1, consents: 1 }); const gui = await cell.read("repo.decisions.list"), graph = await cell.read("repo.triadic.relationGraph", { limit: 500 }); assert.deepEqual(gui.decisions.map(({ decisionId: id }) => id), listed.decisions.map(({ decisionId: id }) => id)); assert.equal(gui.decisions[0]?.readiness?.conflictMarker.state, "clear"); assert.deepEqual(gui.decisions[0]?.capabilities.filter(({ available }) => available).map(({ id }) => id), ["supersede", "retire"]); assert.equal(gui.decisions[0]?.claimsOpen, true); assert.deepEqual(validateDaemonDecisionList(gui), []); const support = graph.edges.find((edge) => edge.sourceRef === `decision/${decisionId}/C1` && edge.targetRef === `decision/${decisionId}/CH1`); assert.deepEqual({ state: support?.state, freshness: support?.freshness, strength: support?.strength, current: support?.current }, { state: "active", freshness: "suspect", strength: "strong", current: false }); process.stdout.write(`[RELATION-CURRENT-DIVERGENCE] state=${support?.state} freshness=${support?.freshness} strength=${support?.strength} current=${support?.current}\n`); assert.deepEqual(validateDaemonRelationGraph(graph), []); // the read carries the kernel's uncovered-cause classification on every uncovered row
    // (here: claim C1 declares no fulfillment mode), so consumers never re-derive the judgment;
    assert.deepEqual(graph.coverageRows.map((row) => ({ claimRef: row.claimRef, status: row.status, covered: row.covered, freshnessReason: row.freshnessReason })), [{ claimRef: `decision/${decisionId}/C1`, status: "uncovered", covered: false, freshnessReason: "fulfillment-undeclared" }]); // #1542: event-backed truth already answers this read (all three projections are ready),
    // so an unmaterialized generated cache is not a gap in what was served and must not
    // leak through as a permanent hard-fail warning on an otherwise fully-answered read.
    assert.deepEqual(graph.warnings, []);
    const store = makeTaskEventReader({ repoId: "decision-vertical", rootDir }), projection = makeTaskProjection({ rootDir, eventStore: store }), before = { decision: projection.readDecision(decisionId).decision, document: projection.readDocument(logical).document, graph: projection.readDecisionGraph() }; projection.close(); rmSync(projection.path); projection.rebuild(); assert.deepEqual({ decision: projection.readDecision(decisionId).decision, document: projection.readDocument(logical).document, graph: projection.readDecisionGraph() }, before); projection.close();
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

for (const killpoint of ["before_event_write", "after_event_write"] as const) {
  test(`RepoCell rolls back event and outcome together at ${killpoint}`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-preaccept-crash-")),
      repoId = workspaceId("preaccept-crash"),
      action = { kind: "task-create", taskId: `task-${killpoint}`, title: killpoint } as const;
    let crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined,
      recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initRepo(rootDir);
      crashed = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "generation-one",
        killpoint: (point) => {
          if (point === killpoint) throw new Error(`crash:${point}`);
        },
      });
      const baselineRevision = makeTaskEventReader({ repoId, rootDir }).read().revision,
        first = await crashed.run(action, repoWriteBinding);
      assert.equal(first.outcome, "op_rejected", JSON.stringify(first));
      assert.equal(first.status, "rejected");
      assert.equal(first.acceptance, null);
      assertValidWriteReceipt(first);
      const rolledBack = makeTaskEventReader({ repoId, rootDir });
      assert.equal(rolledBack.read().revision, baselineRevision);
      assert.equal(rolledBack.readCommandOutcome(first.opId), null);
      await rolledBack.drain();

      await crashed.close();
      crashed = undefined;
      recovered = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "generation-two",
      });
      const missing = await recovered.run({ kind: "receipt-show", opId: first.opId }, repoWriteBinding);
      assert.equal(missing.status, "rejected");
      assert.equal(missing.acceptance, null);
      const retried = await recovered.run(action, repoWriteBinding);
      assert.equal(retried.status, "accepted_durable", JSON.stringify(retried));
      assertValidWriteReceipt(retried);
      const reader = makeTaskEventReader({ repoId, rootDir });
      assert.equal(reader.read().events.filter((event) => event.opId === first.opId).length, 1);
      assert.equal(reader.readCommandOutcome(first.opId)?.status, "accepted_durable");
      await reader.drain();
    } finally {
      await crashed?.close();
      await recovered?.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

for (const killpoint of ["after_sqlite_commit", "before_response_write", "after_response_write"] as const) {
  test(`RepoCell records durable acceptance before the ${killpoint} failure`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-postaccept-crash-")),
      repoId = workspaceId("postaccept-crash"),
      action = { kind: "task-create", taskId: `task-${killpoint}`, title: killpoint } as const;
    let crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined,
      recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initRepo(rootDir);
      crashed = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "generation-one",
        killpoint: (point) => {
          if (point === killpoint) throw new Error(`crash:${point}`);
        },
      });
      const baselineRevision = makeTaskEventReader({ repoId, rootDir }).read().revision,
        first = await crashed.run(action, repoWriteBinding);
      assert.equal(first.status, "accepted_durable", JSON.stringify(first));
      assert.equal(first.acceptance?.revisionFrom, baselineRevision + 1);
      assert.equal(first.acceptance?.revisionTo, baselineRevision + 1);
      assertValidWriteReceipt(first);
      const committed = makeTaskEventReader({ repoId, rootDir });
      assert.equal(committed.read().revision, baselineRevision + 1);
      assert.equal(committed.readCommandOutcome(first.opId)?.status, "accepted_durable");
      await committed.drain();

      await crashed.close();
      crashed = undefined;
      recovered = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "generation-two",
      });
      const settled = await recovered.run(
        {
          kind: "receipt-show",
          opId: first.opId,
          waitFor: ["accepted_durable", "projection_visible", "git_verified"],
          timeoutMs: 5_000,
        },
        repoWriteBinding,
      );
      assert.equal(settled.outcome, "applied", JSON.stringify(settled));
      assert.equal(settled.wait?.state, "satisfied");
      const retried = await recovered.run(action, repoWriteBinding);
      assert.equal(retried.status, "accepted_durable", JSON.stringify(retried));
      const reader = makeTaskEventReader({ repoId, rootDir });
      assert.equal(reader.read().events.filter((event) => event.opId === first.opId).length, 1);
      await reader.drain();
    } finally {
      await crashed?.close();
      await recovered?.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

test("a post-accept Git failure leaves SQLite writable and the receipt independently recoverable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-git-follower-failure-")),
    repoId = workspaceId("git-follower-failure");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    failGit = true;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "git-follower-writer",
      killpoint: (point) => {
        if (failGit && point === "after_git_commit") throw new Error("simulated Git follower failure");
      },
    });
    const first = await cell.run(
      { kind: "task-create", taskId: "task-git-follower-one", title: "Accepted before Git" },
      repoWriteBinding,
    );
    assert.equal(first.status, "accepted_durable", JSON.stringify(first));
    assertValidWriteReceipt(first);
    const pending = await cell.run(
      { kind: "receipt-show", opId: first.opId, waitFor: ["git_verified"], timeoutMs: 0 },
      repoWriteBinding,
    );
    assert.equal(pending.status, "accepted_durable");
    assert.equal(pending.git.state, "pending");
    assert.deepEqual(pending.wait, { state: "timed_out", unsatisfied: ["git_verified"] });

    const second = await cell.run(
      { kind: "task-create", taskId: "task-git-follower-two", title: "Accepted while Git is pending" },
      repoWriteBinding,
    );
    assert.equal(second.status, "accepted_durable", JSON.stringify(second));
    assert.notEqual(second.outcome, "op_rejected");

    failGit = false;
    await cell.settlePendingMaterialization("recover Git follower");
    const settled = await cell.run(
      {
        kind: "receipt-show",
        opId: first.opId,
        waitFor: ["accepted_durable", "projection_visible", "git_verified"],
        timeoutMs: 5_000,
      },
      repoWriteBinding,
    );
    assert.equal(settled.wait?.state, "satisfied", JSON.stringify(settled));
    assert.equal(settled.git.state, "verified");
    assert.equal(settled.worktree.state, "verified");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const killpoint of ["after_sqlite_commit", "before_response_write", "after_response_write"] as const) {
  // harness-contract: daemon.recovery-publishes-once
  test(`Decision response recovery handles ${killpoint} without a duplicate publication`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-response-crash-")),
      repoId = workspaceId("decision-response-crash"),
      action = decisionProposal("Recover Decision", "Does the receipt settle once?");
    let crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined,
      recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initRepo(rootDir);
      crashed = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "decision-generation-one",
        killpoint: (point) => {
          if (point === killpoint) throw new Error(`crash:${point}`);
        },
      });
      const first = await crashed.run(action, repoWriteBinding);
      assert.equal(first.status, "accepted_durable", JSON.stringify(first));
      assert.equal(first.outcome, first.projection.state === "verified" ? "applied" : "pending");
      assert.equal(first.code, "publication_indeterminate");
      assert.equal(first.rejectionExplanation, undefined);
      assertValidWriteReceipt(first);
      const acceptedReader = makeTaskEventReader({ repoId, rootDir }),
        acceptedEvents = acceptedReader.read().events.filter((event) => event.schema === "decision-event/v1");
      assert.equal(acceptedEvents.length, 1);
      const acceptedOpId = acceptedEvents[0]!.opId;
      assert.equal(first.opId, acceptedOpId);
      assert.deepEqual(first.acceptance?.memberOpIds, [acceptedOpId]);
      assert.equal(acceptedReader.readCommandOutcome(acceptedOpId)?.status, "accepted_durable");
      await acceptedReader.drain();
      await crashed.close();
      crashed = undefined;

      recovered = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "decision-generation-two",
      });
      const settled = await recovered.run(
        {
          kind: "receipt-show",
          opId: acceptedOpId,
          waitFor: ["accepted_durable", "projection_visible", "git_verified"],
          timeoutMs: 5_000,
        },
        repoWriteBinding,
      );
      assert.equal(settled.wait?.state, "satisfied", JSON.stringify(settled));
      const retried = await recovered.run(action, repoWriteBinding);
      assert.equal(retried.status, "accepted_durable", JSON.stringify(retried));
      assert.equal(retried.outcome, "applied");
      assert.equal(retried.opId, acceptedOpId);
      assert.deepEqual(retried.acceptance, first.acceptance);
      const reader = makeTaskEventReader({ repoId, rootDir });
      assert.equal(reader.read().events.filter((event) => event.schema === "decision-event/v1").length, 1);
      await reader.drain();
    } finally {
      await crashed?.close();
      await recovered?.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

// prettier-ignore

test("RepoCell doc mapping enforces strict dual CAS, holder receipts, deletion rejection, and worktree preservation", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-cell-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("docs"), rootDir: canonicalRoot(rootDir), ownerId: "doc-daemon" });
    const binding = repoWriteBinding, created = await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs" }, binding); assert.equal(created.outcome, "applied"); const createdVisible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding));
    assert.equal((await cell.run({ kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, repoWriteBinding)).outcome, "applied");
    const claims = path.join(rootDir, ".harness/doc-sync-claims"), authored = path.join(rootDir, "harness/context/notes.md"); mkdirSync(claims, { recursive: true }); mkdirSync(path.dirname(authored), { recursive: true });
    let body = "# Notes\nA\n"; writeFileSync(authored, body);
    const statusBefore = await cell.run({ kind: "doc-status", paths: ["context/notes.md"] }, repoWriteBinding); assert.equal(statusBefore.outcome, "applied"); assert.equal(statusBefore.proof?.worktreeVisible, false);
    const action = { kind: "doc-submit", executionId: "execution-doc", paths: ["context/notes.md"] } as const;
    const before = { revision: makeTaskEventReader({ repoId: "docs", rootDir }).read().revision, bytes: readFileSync(authored).toString("hex") }, applied = await cell.run(action, repoWriteBinding);
    assert.equal(applied.outcome, "applied", JSON.stringify(applied)); assert.equal(applied.detail?.kind, "doc_sync"); assert.equal(applied.status, "accepted_durable"); assert.ok(applied.cut); assert.equal(readFileSync(authored).toString("hex"), before.bytes); assertValidWriteReceipt(applied);
    const shown = await cell.run({ kind: "receipt-show", opId: applied.opId, waitFor: ["git_verified", "worktree_visible"], timeoutMs: 5_000 }, repoWriteBinding); assert.equal(shown.outcome, "applied"); assert.equal(shown.detail?.kind, "doc_sync"); assert.equal(shown.wait?.state, "satisfied", JSON.stringify(shown));
    const retried = await cell.run(action, repoWriteBinding); assert.equal(retried.outcome, "no_changes"); assert.equal(retried.code, "no_changes"); assert.match(retried.opId, /^noop:/u); assert.equal(makeTaskEventReader({ repoId: "docs", rootDir }).read().revision, before.revision + 1);
    const next = `${body}B\n`; writeFileSync(authored, next);
    const updated = await cell.run(action, repoWriteBinding); assert.equal(updated.outcome, "applied", JSON.stringify(updated)); body = next;
    rmSync(authored); const deletion = await cell.run(action, repoWriteBinding); assert.equal(deletion.code, "deletion_forbidden"); writeFileSync(authored, body);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// prettier-ignore

test("doc ingress rejects symbolic links in claim and authored path chains", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-claim-link-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("claim-link"), rootDir: canonicalRoot(rootDir), ownerId: "doc-daemon" }); const source = { kind: "assignment", nodeId: "node", assignmentId: "assignment" } as const, sourceBinding = withRoleBinding({ actor, source }, "repo-write");
    const created = await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs" }, repoWriteBinding); const createdVisible = await waitForAcceptedReceipt(cell, created, repoWriteBinding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, repoWriteBinding)); await cell.run({ kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, sourceBinding);
    const body = "# Outside\n", hash = createHash("sha256").update(body).digest("hex"), claims = path.join(rootDir, ".harness/doc-sync-claims"); mkdirSync(claims, { recursive: true }); writeFileSync(path.join(rootDir, "outside.md"), body); symlinkSync("../../outside.md", path.join(claims, "linked"));
    const binding = { actor, source, assignmentScope: { repoId: "claim-link", scope: { kind: "task" as const, taskId: "task-doc", executionId: "execution-doc", paths: ["context/link.md"] } } }, base = makeTaskEventReader({ repoId: "claim-link", rootDir }).currentCut(), beforeRevision = makeTaskEventReader({ repoId: "claim-link", rootDir }).read().revision, result = await cell.run({ kind: "doc-submit", executionId: "execution-doc", baseLedgerSha: base, changes: [{ path: "context/link.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { ref: "doc-sync-claims/linked", sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" } }] }, binding);
    assert.equal(result.code, "content_claim_mismatch"); assert.equal(makeTaskEventReader({ repoId: "claim-link", rootDir }).read().revision, beforeRevision);
    writeFileSync(path.join(claims, "plain"), body); mkdirSync(path.join(rootDir, "harness/context"), { recursive: true }); symlinkSync("../../outside.md", path.join(rootDir, "harness/context/link.md"));
    const authoredLink = await cell.run({ kind: "doc-submit", executionId: "execution-doc", baseLedgerSha: base, changes: [{ path: "context/link.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { ref: "doc-sync-claims/plain", sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" } }] }, binding);
    assert.equal(authoredLink.code, "invalid_command"); assert.equal(makeTaskEventReader({ repoId: "claim-link", rootDir }).read().revision, beforeRevision);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

// prettier-ignore

test("bootstrap concurrent writer admission commits one complete workspace", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-writer-")), rootDir = path.join(parent, "repo");
  const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0,
    source: "unix-socket-filesystem-owner-boundary" } } as const;
  const hosts = await Promise.all(["one", "two"].map((daemonId) => openDaemonHost({ daemonId, userRoot: path.join(parent, daemonId) })));
  try { const results = await Promise.allSettled(hosts.map((host) => host.bootstrap({ rootDir, repoId: "fresh", personId: "owner", displayName: "Owner" }, auth)));
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1); assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    const ledgerRoot = path.join(rootDir, "harness"); assert.equal(git(ledgerRoot, "rev-list", "--count", "HEAD"), "2"); assert.equal(git(rootDir, "check-ignore", "harness"), "harness"); assert.equal(git(rootDir, "check-ignore", ".harness"), ".harness"); }
  finally { await Promise.all(hosts.map((host) => host.close())); rmSync(parent, { recursive: true, force: true }); }
});

// prettier-ignore

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
    assert.equal(git(ledgerRoot, "rev-parse", "HEAD"), git(ledgerRoot, "rev-parse", `refs/heads/${ledgerBranch}`)); assert.equal(git(rootDir, "branch", "--show-current"), "feature");
    await host.close(); host = await openDaemonHost({ daemonId: "bootstrap-two", userRoot }); await host.attachmentsSettled();
    const afterRestart = await host.run("branch-bound", { kind: "task-create", taskId: "task-after-restart", title: "After restart" }, auth); assert.equal(afterRestart.outcome, "applied", JSON.stringify(afterRestart)); const settled = await host.run("branch-bound", { kind: "receipt-show", opId: afterRestart.opId, waitFor: ["accepted_durable", "projection_visible", "git_verified"], timeoutMs: 5_000 }, auth); assert.equal(settled.wait?.state, "satisfied", JSON.stringify(settled));
    assert.equal(git(ledgerRoot, "rev-parse", "HEAD"), git(ledgerRoot, "rev-parse", `refs/heads/${ledgerBranch}`)); assert.equal(git(rootDir, "branch", "--show-current"), "feature");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

// prettier-ignore

test("bootstrap validates local identity before repository initialization", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-identity-")), rootDir = path.join(parent, "repo"), host = await openDaemonHost({ daemonId: "bootstrap-identity", userRoot: path.join(parent, "user") });
  try { await assert.rejects(host.bootstrap({ rootDir, repoId: "identity", personId: "owner", displayName: "Owner" }, { transportKind: "unix-socket" }), hasCode("bootstrap_identity_unavailable")); assert.equal(existsSync(path.join(rootDir, ".git")), false); }
  finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

// prettier-ignore

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

// prettier-ignore

test("JSON-RPC failure receipt carries formal operation identity and origin", async () => {
  const host = { run: async () => { throw new Error("unused"); }, read: async () => { throw new Error("unused"); }, attach: async () => { throw new Error("unused"); }, issueRuntimeWitness: async () => { throw new Error("unused"); }, bindRuntimeWitness: () => { throw new Error("unused"); }, publishRuntimeWitness: () => { throw new Error("unused"); }, bootstrap: async () => ({}), admin: async () => ({}),
    status: () => ({ daemonId: "test", pid: process.pid, repos: [] }), close: async () => undefined };
  const server = createJsonRpcProtocolServer({ host, build: { commit: null }, authContext: { transportKind: "unix-socket" }, emit: async () => undefined });
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: { major: 2, minor: 0 } } });
  assert.ok(response && !Array.isArray(response) && "result" in response); if (response && !Array.isArray(response) && "result" in response) {
    const receipt = response.result as Record<string, unknown>; assert.deepEqual(receipt, { schema: "command-receipt/v2", ok: false, command: "protocol.hello", outcome: "op_rejected", opId: "N/A", origin: "daemon", code: "incompatible_protocol_version", evidence: "rejection:incompatible_protocol_version", error: { code: "incompatible_protocol_version" } }); }
  await server.handle({ jsonrpc: "2.0", id: 2, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });
  const unknown = await server.handle({ jsonrpc: "2.0", id: 3, method: "repo.agentRuntime.spawn", params: { repo: { repoId: "alpha" }, payload: { runtimeInstanceId: "codex", cwd: { scope: "repo-root" }, prompt: "Inspect", taskId: null, idempotencyKey: "unknown", permission_mode: "read-only" } } });
  assert.ok(unknown && !Array.isArray(unknown) && "result" in unknown); if (unknown && !Array.isArray(unknown) && "result" in unknown) { const receipt = unknown.result as Record<string, unknown>, diagnostic = receipt.diagnostic as Record<string, unknown>; assert.equal(receipt.code, "unknown_field"); assert.deepEqual({ kind: diagnostic.kind, entity: diagnostic.entity, field: diagnostic.field, actual: diagnostic.actual }, { kind: "validation", entity: "repo.agentRuntime.spawn", field: "permission_mode", actual: "unknown" }); assert.match(String(diagnostic.expectation), /Allowed fields:.*agentId.*permissionMode/u); }
  const malformed = await server.handle({ jsonrpc: "2.0", id: 4, method: "daemon.status", params: "not-an-object" });
  assert.ok(malformed && !Array.isArray(malformed) && "result" in malformed); if (malformed && !Array.isArray(malformed) && "result" in malformed) assert.equal((malformed.result as Record<string, unknown>).code, "invalid_request");
});

test("JSON-RPC read failures retain native SQLite result details", async (t) => {
  const sqliteError = Object.assign(new Error("database is locked"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 5,
      errstr: "database is locked",
    }),
    host = {
      read: async () => {
        throw sqliteError;
      },
    } as never,
    server = createJsonRpcProtocolServer({
      host,
      build: { commit: null },
      authContext: { transportKind: "unix-socket" },
      emit: async () => undefined,
    });
  try {
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion },
    });
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "repo.tasks.list",
      params: { repo: { repoId: "sqlite-error" }, payload: { limit: 1 } },
    });
    assert.ok(response && !Array.isArray(response) && "result" in response);
    if (response && !Array.isArray(response) && "result" in response) {
      t.diagnostic(`SQLite rejection receipt: ${JSON.stringify(response.result)}`);
      assert.deepEqual((response.result as { error: unknown }).error, {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
        errstr: "database is locked",
      });
    }
  } finally {
    server.close();
  }
});

// prettier-ignore

test("local daemon stop acknowledges the control request and triggers shutdown", async () => {
  let shutdowns = 0;
  const host = { status: () => ({ daemonId: "stop-test", pid: process.pid, repos: [] }) } as never;
  const server = createJsonRpcProtocolServer({ host, build: { commit: null }, authContext: { transportKind: "unix-socket" }, emit: async () => undefined, requestShutdown: () => { shutdowns += 1; } });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "daemon.stop", params: {} });
  assert.ok(response && !Array.isArray(response) && "result" in response); if (response && !Array.isArray(response) && "result" in response) assert.deepEqual(response.result, { ok: true, command: "daemon-stop", pid: process.pid });
  assert.equal(shutdowns, 1);
});

// prettier-ignore

test("Policy rejects a principal without a durable-action RoleBinding", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-rbac-surfaces-")), root = path.join(parent, "repo"), second = path.join(parent, "second"), userRoot = path.join(parent, "user");
  const ids = { reader: 4101, writer: 4102, arbiter: 4103, admin: 4104 }; [root, second].forEach((repo) => rbacRepo(repo, ids)); const authority = openPersistentWriterEpoch({ stateRoot: path.join(userRoot, "fleet"), holderId: "rbac-seed" }), lease = authority.acquire("rbac"); seedSettingsEvent({ repoId: "rbac", rootDir: root, writerEpochFence: { schema: "harness-writer-epoch-fence/v1", stateRoot: path.join(userRoot, "fleet"), repoId: "rbac", holderId: lease.holderId, epoch: lease.epoch } }); authority.close();
  const auth = (ownerUid: number) => ({ transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" } } as const);
  const host = await openDaemonHost({ daemonId: "rbac", userRoot });
  try {
    assert.equal((await rpc(host, auth(ids.admin), "daemon.repo.register", { rootDir: root, repoId: "rbac" })).outcome, "applied");
    const created = await host.run("rbac", { kind: "task-create", taskId: "task-rbac", title: "RBAC" }, auth(ids.writer)); assert.equal(created.outcome, "applied", JSON.stringify(created)); const visible = await host.run("rbac", { kind: "receipt-show", opId: created.opId, waitFor: ["accepted_durable", "projection_visible", "git_verified", "worktree_visible"], timeoutMs: 5_000 }, auth(ids.writer)); assert.equal(visible.wait?.state, "satisfied", JSON.stringify(visible)); assert.equal(visible.status, "accepted_durable"); await realizeTaskPlanFixture(root, String((created as Record<string, unknown>).packagePath), (planPath) => host.run("rbac", { kind: "doc-submit", paths: [planPath] }, auth(ids.writer)));
    const executionId = "exec-rbac"; assert.equal((await host.run("rbac", { kind: "task-start", taskId: "task-rbac", executionId }, auth(ids.writer))).outcome, "applied");
    assert.equal((await host.run("rbac", { kind: "task-show", taskId: "task-rbac" }, auth(ids.reader))).outcome, "applied");
    const deniedWrite = await host.run("rbac", { kind: "task-create", taskId: "task-denied", title: "Denied" }, auth(ids.reader));
    assert.equal(deniedWrite.outcome, "op_rejected"); assert.equal(deniedWrite.code, "authorization_denied");
    const deniedPresetRun = await host.presetRun("rbac", { kind: "preset-run-start", presetId: "missing", entrypoint: "run", idempotencyKey: "denied" }, auth(ids.reader)), readableStatus = await host.presetRun("rbac", { kind: "preset-run-status", runId: "run_missing" }, auth(ids.reader)); assert.equal(deniedPresetRun.code, "authorization_denied"); assert.equal(readableStatus.code, "run_not_found");
    const missingStatus = await host.run("rbac", { kind: "doc-status", paths: ["context/notes.md"] }, auth(ids.reader)); assert.equal(missingStatus.outcome, "op_rejected"); assert.equal(missingStatus.code, "document_not_found");
    mkdirSync(path.join(root, "harness/context"), { recursive: true }); writeFileSync(path.join(root, "harness/context/notes.md"), "# Reader denied\n");
    const readerDoc = await host.run("rbac", { kind: "doc-submit", executionId, paths: ["context/notes.md"] }, auth(ids.reader));
    assert.equal(readerDoc.code, "authorization_denied"); assert.equal(readerDoc.authorizationDecision.outcome, "denied");
    const deniedReview = await host.run("rbac", { kind: "task-review-execution", taskId: "task-rbac" }, auth(ids.reader));
    assert.equal(deniedReview.outcome, "op_rejected"); assert.equal(deniedReview.code, "authorization_denied");
    const deniedAdmin = await rpc(host, auth(ids.reader), "daemon.repo.register", { rootDir: second, repoId: "second" });
    assert.equal(deniedAdmin.outcome, "op_rejected"); assert.equal(deniedAdmin.code, "authorization_denied");
    await writeCloseout(
      () => host.run("rbac", { kind: "doc-materialize" }, auth(ids.writer)),
      root,
      String((created as Record<string, unknown>).packagePath),
      "Role-bound delivery complete.",
    );
    assert.equal((await host.run("rbac", { kind: "task-submit", taskId: "task-rbac", executionId }, auth(ids.writer))).outcome, "applied");
    writeFileSync(path.join(root, "review.json"), JSON.stringify({ verdict: "approved", reason: "checked", evidenceChecked: [] }));
    const review = await host.run("rbac", { kind: "task-review-execution", taskId: "task-rbac", executionId, reviewId: "review-rbac", fromFile: "review.json" }, auth(ids.arbiter)); assert.equal(review.outcome, "applied", JSON.stringify(review));
    const attached = await rpc(host, auth(ids.admin), "daemon.repo.register", { rootDir: second, repoId: "second", mode: "remote-edge" }); assert.equal(attached.outcome, "applied"); assert.equal((attached.repo as Record<string, unknown>).mode, "remote-edge");
    const deniedEdgePreset = await rpc(host, auth(ids.writer), "repo.preset.run.start", { repo: { repoId: "second" }, payload: { presetId: "standard-task", entrypoint: "run", idempotencyKey: "edge-preset" } }); assert.equal(deniedEdgePreset.outcome, "op_rejected"); assert.equal(deniedEdgePreset.code, "repo_mode_read_only");
    const deniedUnregister = await rpc(host, auth(ids.reader), "daemon.repo.unregister", { repoId: "second" }); assert.equal(deniedUnregister.outcome, "op_rejected"); assert.equal(deniedUnregister.code, "authorization_denied");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

// prettier-ignore

test("runtime witness issuance binds the server principal without transport role authorization", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-witness-rbac-")), root = path.join(parent, "repo"), userRoot = path.join(parent, "user"), ids = { writer: 4201, admin: 4202, dualAdmin: 4203, dualArbiter: 4204 }; rbacRepo(root, ids); const auth = (ownerUid: number) => ({ transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" } } as const);
  const runtimeActor = { principal: { personId: "fixture" }, executor: null } as const, definition = { schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "instance-runtime", installationId: "installation-runtime", kindId: "codex", providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", baseUrl: null, authMode: "subscription" } as const, store = makeTaskEventStore({ repoId: "runtime-witness", rootDir: root, activationPreflight: activateEmptyCanonicalGeneration }), events = [{ schema: "agent-runtime-event/v1", eventId: "runtime-installation", workspaceRevision: 1, opId: "runtime-installation", actor: runtimeActor, source: "local", occurredAt: "2026-08-13T00:00:00.000Z", type: "runtime_installation_observed", payload: { installationId: "installation-runtime", kindId: "codex", protocolFamily: "codex", hostRef: "host:local", version: "1.0.0", discoverySource: "wrapper", capabilities: ["structured_witness", "attach"] } }, { schema: "agent-runtime-event/v1", eventId: "runtime-dispatch", workspaceRevision: 2, opId: "runtime-dispatch", actor: runtimeActor, source: "local", occurredAt: "2026-08-13T00:00:01.000Z", type: "runtime_dispatch_requested", payload: { dispatchId: "dispatch-runtime", runtimeSessionId: "session-runtime", instanceId: definition.instanceId, installationId: definition.installationId, kindId: definition.kindId, idempotencyKey: "runtime-witness", definitionSnapshotRef: "artifact:runtime-definition/test", definitionSnapshot: definition } }, { schema: "agent-runtime-event/v1", eventId: "runtime-session", workspaceRevision: 3, opId: "runtime-session", actor: runtimeActor, source: "local", occurredAt: "2026-08-13T00:00:02.000Z", type: "runtime_session_started", payload: { runtimeSessionId: "session-runtime", instanceId: definition.instanceId, installationId: definition.installationId, kindId: definition.kindId, definitionSnapshotRef: "artifact:runtime-definition/test", launchGeneration: 1, attachable: true } }] as const satisfies readonly AgentRuntimeEventV1[]; for (const event of events) store.append({ event, plan: runtimeWritePlan(event), blobs: [] }); await store.drain();
  const host = await openDaemonHost({ daemonId: "runtime-witness", userRoot }); try { await host.admin({ kind: "register", rootDir: root, repoId: "runtime-witness" }, auth(ids.admin)); const issued = await host.issueRuntimeWitness("runtime-witness", "session-runtime", auth(ids.writer)), bound = host.bindRuntimeWitness("runtime-witness", issued.token); assert.equal(bound.actor.principal.personId, "writer"); assert.deepEqual(bound.actor.executor, { kind: "agent", id: "runtime-session:session-runtime" }); assert.equal(host.publishRuntimeWitness("runtime-witness", issued.token, { type: "activity", activity: "tool" }).type, "activity"); assert.throws(() => host.publishRuntimeWitness("runtime-witness", issued.token, { type: "heartbeat", actor: "provider-supplied" } as never), hasCode("invalid_provider_frame")); const assignment = { transportKind: "unix-socket", assignmentBinding: { nodeId: "node-runtime", repoId: "runtime-witness", taskId: "task-runtime", executionId: "execution-runtime", assignmentId: "assignment-runtime", paths: [], actor: { principal: { personId: "worker" }, executor: null } } } as const, assignmentToken = await host.issueRuntimeWitness("runtime-witness", "session-runtime", assignment), assignmentBound = host.bindRuntimeWitness("runtime-witness", assignmentToken.token); assert.deepEqual(assignmentBound.source, { kind: "assignment", nodeId: "node-runtime", assignmentId: "assignment-runtime" }); assert.deepEqual(assignmentBound.actor.executor, { kind: "agent", id: "runtime-session:session-runtime" }); for (const [personId, ownerUid] of [["dualAdmin", ids.dualAdmin], ["dualArbiter", ids.dualArbiter]] as const) { const token = await host.issueRuntimeWitness("runtime-witness", "session-runtime", auth(ownerUid)); assert.equal(host.bindRuntimeWitness("runtime-witness", token.token).actor.principal.personId, personId); } } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("task mutation rejections name the missing field and current execution status", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-rejection-diagnostics-")),
    taskId = "task-rejection-diagnostics",
    executionId = "execution-rejection-diagnostics";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-rejection-diagnostics"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-rejection-diagnostics",
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Rejection diagnostics" }, repoWriteBinding);
    const createdVisible = await waitForAcceptedReceipt(cell, created, repoWriteBinding);
    assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible));
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, repoWriteBinding),
    );
    await cell.run({ kind: "task-start", taskId, executionId }, repoWriteBinding);
    writeFileSync(
      path.join(rootDir, "harness", String((created as Record<string, unknown>).packagePath), "closeout.md"),
      "# Closeout\n\n## Summary\n\nReady.\n",
    );
    const invalidSubmission = await cell.run({ kind: "task-submit", taskId, executionId }, repoWriteBinding);
    assert.equal(invalidSubmission.code, "closeout_placeholder", JSON.stringify(invalidSubmission));
    assert.match(JSON.stringify(invalidSubmission.next), /closeout.md/u);
    context.diagnostic(`invalid_submission receipt=${JSON.stringify(invalidSubmission)}`);
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Premature review.", evidenceChecked: ["fixture"] }),
    );
    const prematureReview = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId: "review-premature",
        fromFile: "review.json",
      },
      withRoleBinding(
        {
          actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent", id: "arbiter" } },
          source: "local",
        },
        "arbiter",
      ),
    );
    assert.equal(prematureReview.code, "invalid_transition", JSON.stringify(prematureReview));
    assert.deepEqual(prematureReview.diagnostic, {
      kind: "validation",
      entity: `execution ${executionId}`,
      field: "status",
      actual: "active",
      expectation: "Execution status must be submitted on the current task iteration before review",
    });
    const derivedPrematureReview = await cell.run(
      { kind: "task-review-execution", taskId, reviewId: "review-derived-premature", fromFile: "review.json" },
      withRoleBinding(
        {
          actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent", id: "arbiter" } },
          source: "local",
        },
        "arbiter",
      ),
    );
    assert.equal(derivedPrematureReview.code, "invalid_command", JSON.stringify(derivedPrematureReview));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task complete rejects a passing observation for another submitted commit", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-complete-ci-binding-")),
    taskId = "task-complete-ci-binding",
    executionId = "execution-complete-ci-binding",
    repoId = workspaceId("complete-ci-binding");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n  ci:\n    workflows: [rewrite-ci]\n"); // CI witnessing is opt-in
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "complete-ci-binding" });
    await prepareReadyCompletion(cell, rootDir, repoId, taskId, executionId, "CI Binding", false, "f".repeat(40));
    const store = makeTaskEventReader({ repoId, rootDir }),
      submitted = store
        .read()
        .events.find(
          (event) => event.type === "execution_submitted" && event.payload.execution.executionId === executionId,
        );
    assert.ok(submitted && submitted.type === "execution_submitted");
    const execution = submitted.payload.execution;
    const unrelatedCut = store.read().revision;
    const unrelated = await cell.run({ kind: "task-complete", taskId, executionId }, repoWriteBinding);
    assert.equal(unrelated.code, "ci_missing", JSON.stringify(unrelated));
    assert.equal(store.read().revision, unrelatedCut);
    await publishCiObservation(
      repoId,
      rootDir,
      executionId,
      execution.submission.commitSha,
      "unverified-matching-sha",
      false,
    );
    const unverifiedCut = store.read().revision;
    await assert.rejects(
      cell.run({ kind: "task-complete", taskId, executionId }, repoWriteBinding),
      { code: "invalid_proof" },
      "unverified matching observations cannot establish workflow verification",
    );
    assert.equal(
      store.read().revision,
      unverifiedCut,
      "unverified historical-style observations cannot append passing witnesses",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task complete accepts a verified main run on a commit that contains the submission", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-complete-ci-descendant-")),
    taskId = "task-complete-ci-descendant",
    executionId = "execution-complete-ci-descendant",
    repoId = workspaceId("complete-ci-descendant");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "complete-ci-descendant" });
    await prepareReadyCompletion(cell, rootDir, repoId, taskId, executionId, "CI Descendant", false);
    const submitted = makeTaskEventReader({ repoId, rootDir })
      .read()
      .events.find(
        (event) => event.type === "execution_submitted" && event.payload.execution.executionId === executionId,
      );
    assert.ok(submitted && submitted.type === "execution_submitted");
    const submittedSha = String(submitted.payload.execution.submission?.commitSha),
      laterMain = git(rootDir, "commit-tree", `${submittedSha}^{tree}`, "-p", submittedSha, "-m", "later main");
    await publishCiObservation(repoId, rootDir, executionId, laterMain, "run-later-main");
    const attempt = await cell.run({ kind: "task-complete", taskId, executionId }, repoWriteBinding);
    assert.equal(attempt.outcome, "applied", JSON.stringify(attempt));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function writeCloseout(
  drain: () => Promise<unknown>,
  rootDir: string,
  packagePath: string,
  summary: string,
  verification = "Verified.",
): Promise<string> {
  // The cell publishes ledger cuts to the same repo Git; drain its writer queue before this fixture
  // commit, or the two HEAD writers race and git dies with `cannot lock ref 'HEAD'`.
  await drain();
  writeFileSync(path.join(rootDir, "README.md"), "# Verified delivery\n");
  git(rootDir, "add", "README.md");
  execFileSync("git", ["-C", rootDir, "commit", "--quiet", "-m", "test: verified delivery"], {
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-14T00:01:00Z", GIT_COMMITTER_DATE: "2026-08-14T00:01:00Z" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const commitSha = git(rootDir, "rev-parse", "HEAD");
  writeFileSync(
    path.join(rootDir, "harness", packagePath, "closeout.md"),
    `# Closeout\n\n## Summary\n\n${summary} Commit ${commitSha}.\n\n## Verification\n\n${verification}\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n`,
  );
  return commitSha;
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "--quiet", "-m", "fixture base");
}
function initDeterministicRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  execFileSync("git", ["-C", rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base"], {
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-14T00:00:00Z", GIT_COMMITTER_DATE: "2026-08-14T00:00:00Z" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function decisionProposal(title: string, question: string) {
  return {
    kind: "decision-propose",
    body: `# ${title}\n\nUse the canonical event-backed flow for this fixture.\n`,
    jsonInput: JSON.stringify({
      title,
      question,
      riskTier: "medium",
      urgency: "medium",
      vertical: "default",
      preset: "default",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Use events" }],
      rejected: [{ id: "RJ1", text: "Use files", whyNot: "They are not canonical" }],
      claims: [],
      fulfillments: [],
    }),
  } as const;
}
async function prepareReadyCompletion(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  rootDir: string,
  repoId: string,
  taskId: string,
  executionId: string,
  title: string,
  publishObservation = true,
  observationCommitSha?: string,
): Promise<string> {
  const binding = repoWriteBinding;
  const created = await cell.run({ kind: "task-create", taskId, title }, binding);
  const createdVisible = await waitForAcceptedReceipt(cell, created, binding);
  assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible));
  await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
    cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
  );
  const started = await cell.run({ kind: "task-start", taskId, executionId }, binding);
  assert.equal((await waitForAcceptedReceipt(cell, started, binding)).wait?.state, "satisfied");
  const fact = await cell.run(
    {
      kind: "fact-record",
      taskId,
      statement: "Completion has a canonical task-owned observation.",
      evidenceSource: "test:completion",
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: [],
    },
    binding,
  );
  assert.equal((await waitForAcceptedReceipt(cell, fact, binding)).wait?.state, "satisfied");
  const packagePath = `tasks/${taskId}-${title
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")}`;
  const commitSha = await writeCloseout(
    () => cell.settlePendingMaterialization("closeout git commit"),
    rootDir,
    packagePath,
    "Ready.",
  );
  const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  assert.equal((await waitForAcceptedReceipt(cell, submitted, binding)).wait?.state, "satisfied");
  writeFileSync(
    path.join(rootDir, "review.json"),
    JSON.stringify({ verdict: "approved", reason: "Approved.", evidenceChecked: ["verified"] }),
  );
  const reviewed = await cell.run(
    { kind: "task-review-execution", taskId, executionId, reviewId: "review-ready", fromFile: "review.json" },
    withRoleBinding(
      {
        actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent", id: "arbiter" } },
        source: "local",
      },
      "arbiter",
    ),
  );
  assert.equal((await waitForAcceptedReceipt(cell, reviewed, binding)).wait?.state, "satisfied");
  const consented = await cell.run(
    { kind: "task-review-consent", taskId, executionId, reviewId: "review-ready" },
    binding,
  );
  assert.equal((await waitForAcceptedReceipt(cell, consented, binding)).wait?.state, "satisfied");
  if (!publishObservation && !observationCommitSha) return "";
  const ciReceipt = await publishCiObservation(
    repoId,
    rootDir,
    executionId,
    observationCommitSha ?? commitSha,
    `run-${taskId}`,
  );
  return ciReceipt;
}

async function publishCiObservation(
  repoId: string,
  rootDir: string,
  executionId: string,
  commitSha: string,
  runId: string,
  verified = true,
): Promise<string> {
  const stateRoot = path.join(rootDir, ".harness", "fixture-writer-epochs"),
    authority = openPersistentWriterEpoch({ stateRoot, holderId: "direct-store" }),
    lease = authority.current(repoId);
  assert.ok(lease, "the isolated repo cell owns a current writer epoch");
  const store = makeTaskEventStore({
      repoId,
      rootDir,
      writerFence: () => ({
        schema: "harness-writer-epoch-fence/v1",
        stateRoot,
        repoId,
        holderId: lease.holderId,
        epoch: lease.epoch,
      }),
    }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    databaseId = Number.parseInt(createHash("sha256").update(runId).digest("hex").slice(0, 8), 16) + 1,
    observedRunId = `${databaseId}.1`;
  try {
    const cell = {
      rootDir,
      settings: { read: () => ({ ci: { workflows: ["rewrite-ci", "rebuild-gates"] } }) },
      store,
      projection,
      now: () => "2026-09-09T00:00:00.000Z",
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    } as unknown as Parameters<typeof ingestCiObservations>[0];
    const fetched = await fetchCiObservations(cell, { kind: "ci-observe-pull", limit: 1 }, async (_command, args) => {
      if (args[1] === "list")
        return JSON.stringify([{ databaseId, headBranch: "main", createdAt: "2026-09-09T00:00:00.000Z" }]);
      if (args[1] === "view")
        return JSON.stringify({
          workflowName: verified ? "rewrite-ci" : "other-ci",
          headSha: commitSha,
          headBranch: "main",
          status: "completed",
          conclusion: "success",
          attempt: 1,
        });
      assert.equal(args[1], "download");
      const output = String(args[args.indexOf("--dir") + 1]);
      mkdirSync(output, { recursive: true });
      writeFileSync(
        path.join(output, "observation.json"),
        JSON.stringify({
          schema: "ci-run-artifact/v1",
          run: {
            runId: observedRunId,
            sha: commitSha,
            branch: "main",
            prNumber: null,
            job: "full-check (24)",
            wallclockMs: 25,
            runner: "fixture-runner",
          },
          tests: [],
          gates: [{ gate: "ci", result: "pass", metrics: { runAttempt: 1 } }],
        }),
      );
      return "";
    });
    const receipt = ingestCiObservations(cell, repoWriteBinding, fetched);
    assert.equal(JSON.parse(receipt.evidence).imported, 1);
    const event = store
      .read()
      .events.find(
        (candidate) => candidate.type === "ci_run_observed" && candidate.payload.run.runId === observedRunId,
      );
    assert.ok(event && event.type === "ci_run_observed");
    assert.equal(event.payload.verification?.conclusion, verified ? "success" : undefined);
    assert.ok(
      store
        .read()
        .events.some(
          (candidate) =>
            candidate.type === "execution_submitted" && candidate.payload.execution.executionId === executionId,
        ),
    );
    await store.drain();
    const eventRefs = JSON.parse(receipt.evidence).eventRefs;
    assert.deepEqual(eventRefs, [`event:${event.opId}`]);
    return eventRefs[0];
  } finally {
    projection.close();
    await store.drain();
    authority.close();
  }
}

function rbacRepo(rootDir: string, ids: Readonly<Record<string, number>>): void {
  mkdirSync(rootDir, { recursive: true });
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, "harness"));
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: rbac\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  const policyRoles: Readonly<Record<string, readonly string[]>> = {
      reader: ["reader"],
      writer: ["repo-write"],
      arbiter: ["arbiter"],
      admin: ["admin"],
      dualAdmin: ["repo-write", "admin"],
      dualArbiter: ["repo-write", "arbiter"],
    },
    people = Object.entries(ids).map(([role, uid]) => ({
      personId: role,
      displayName: role,
      roles: policyRoles[role],
      credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }],
    }));
  const commands: Readonly<Record<string, readonly string[]>> = {
      reader: ["repo-read"],
      "repo-write": ["repo-write"],
      arbiter: ["arbiter"],
      admin: ["admin"],
    },
    roles = Object.keys(commands).map((roleId) => ({ roleId, commandClasses: commands[roleId] }));
  writeFileSync(
    path.join(rootDir, "harness/people.yaml"),
    `${JSON.stringify({ schema: "harness-people/v1", people, roles }, null, 2)}\n`,
  );
  git(rootDir, "add", "harness");
  git(rootDir, "commit", "--quiet", "-m", "add RBAC fixture");
}
async function rpc(
  host: Awaited<ReturnType<typeof openDaemonHost>>,
  auth: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2],
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = createJsonRpcProtocolServer({
    host,
    build: { commit: null },
    authContext: auth,
    emit: async () => undefined,
  });
  await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion },
  });
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method, params });
  assert.ok(response && !Array.isArray(response) && "result" in response);
  return (response as { result: Record<string, unknown> }).result;
}
// The readiness projection reports an unavailable canonical Git cut with no basis commit. Before the
// ledger owned its own repository the outer repository always had a HEAD, so that branch was
// unreachable and the wire validator was free to demand a sha; once it became reachable the producer
// was emitting a value its own validator rejected. This pins producer and validator to each other.
// prettier-ignore
test("decision readiness survives the wire when the canonical Git cut is unavailable", () => {
  const decision = { decisionId: "dec_1", proposedAt: "2026-01-01T00:00:00Z", appliesTo: { modules: ["packages/kernel"], productLines: [] } };
  const noCut = projectDecisionReadiness({ rootDir: "/nonexistent", commitSha: "", decisions: [decision] }, { run: () => ({ ok: false, stdout: "" }) });
  assert.equal(noCut[0]?.basisCommitSha, "");
  assert.equal(noCut[0]?.appliesToDrift.state, "unknown");
  assert.deepEqual(validateDaemonDecisionList(decisionList(noCut[0]!)), []);
  assert.deepEqual(validateDaemonDecisionList({ ...decisionList(noCut[0]!), projection: "full" }), []);
  const summary = decisionSummaryRead();
  assert.deepEqual(validateDaemonDecisionList(summary), []);
  assertValidationDiagnostic(validateDaemonDecisionList({ ...summary, decisions: [{ ...summary.decisions[0]!, readiness: noCut[0] }] }), /dec_1/u, "decisions[0]");
  assertValidationDiagnostic(validateDaemonDecisionList({ ...summary, decisions: [{ ...summary.decisions[0]!, state: "unknown" }] }), /dec_1/u, "decisions[0]");

  const verdictWithoutBasis = { ...noCut[0]!, appliesToDrift: { ...noCut[0]!.appliesToDrift, state: "clear" as const } };
  assertValidationDiagnostic(validateDaemonDecisionList(decisionList(verdictWithoutBasis)), /dec_1/u, "decisions[0]");
});

// A flag can be declared on the init command, parsed by the CLI, and honored by the bootstrap
// implementation while the wire shape still rejects it — the CLI and the RPC params are two
// separate declarations of the same request. This walks the declared flags so the next one added
// to init cannot repeat that.
// prettier-ignore
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
  return {
    ok: true,
    warnings: [],
    decisions: [
      {
        schema: "decision-row/v1",
        decisionId: "dec_1",
        path: "harness/decisions/decision-dec_1/decision.md",
        state: "in_effect",
        title: "t",
        question: "q",
        riskTier: "low",
        urgency: "low",
        vertical: "v",
        preset: "p",
        decisionClass: "c",
        proposedAt: "2026-01-01T00:00:00Z",
        decidedAt: null,
        workspaceRevision: 1,
        appliesTo: {},
        proposer: {},
        arbiter: null,
        body: null,
        chosen: [],
        rejected: [],
        claims: [],
        provenance: [
          {
            runtime: "unavailable",
            sessionId: null,
            transcriptReachability: "unavailable",
            boundAt: "2026-01-01T00:00:00Z",
          },
        ],
        judgmentConsents: [],
        capabilities: [
          { id: "accept", available: false, reason: "invalid_transition" },
          { id: "reject", available: false, reason: "invalid_transition" },
          { id: "defer", available: false, reason: "invalid_transition" },
          { id: "supersede", available: true, reason: null },
          { id: "retire", available: true, reason: null },
        ],
        claimsOpen: true,
        readiness,
      },
    ],
  };
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function hasCode(expected: string): (error: unknown) => boolean {
  return (error) => typeof error === "object" && error !== null && "code" in error && error.code === expected;
}
function runtimeWritePlan(event: AgentRuntimeEventV1): FrozenWritePlan {
  return canonicalEventWritePlan(event, "agent-runtime/v1", event.opId);
}
