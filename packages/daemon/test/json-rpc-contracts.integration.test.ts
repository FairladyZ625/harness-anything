// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { projectDecisionReadiness, settingsUpdateInputFields } from "../../kernel/src/index.ts";
import {
  actionForDaemonMethod,
  daemonGuiActionMethods,
  daemonProtocolCommands,
  parseDaemonRpcParams,
  serializeDaemonRpcCall,
  validateDaemonDecisionList,
  validateDaemonGuiCommandReceipt,
  validateDaemonRelationGraph,
  validateDaemonTaskSnapshotList,
} from "../src/protocol/daemon-protocol.contract.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { decisionSummaryRead } from "./fixtures/decision-summary-read.ts";
function assertValidationDiagnostic(errors: readonly string[], entity: RegExp, field: string): void {
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, entity);
  assert.match(errors[0]!, new RegExp(`field=${field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?: |$)`, "u"));
  assert.match(errors[0]!, /actual=/u);
}
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

test("relation graph contract accepts the materialized ledger row schema and rejects malformed rows", () => {
  const cut = { status: "ready", watermark: 7, sourceRevision: 7 }, payload = { ok: true, ...cut, edges: [{ relationId: "rel_real", sourceRef: "decision/dec_REAL/C1", targetRef: "fact/F-REAL", relationType: "evidenced-by", direction: "directed", strength: "strong", origin: "declared", state: "active", targetObservedVersion: 6, currentTargetVersion: 6, freshness: "current", rationale: "Observed.", ownerRef: "decision/dec_REAL", sourcePath: "harness/decisions/decision-dec_REAL/decision.md", recordIndex: 0, current: true }], coverageRows: [{ decisionRef: "decision/dec_REAL", claimRef: "decision/dec_REAL/C1", status: "covered", covered: true, fulfillment: "standing-policy", relationPath: ["rel_real"] }], factAnchors: [{ factRef: "fact/F-REAL", taskId: "task_REAL", factId: "F-REAL", sourcePath: "harness/facts/F-REAL.md" }], facts: [{ schema: "task-fact-row/v1", ref: "fact/F-REAL", taskId: "task_REAL", factId: "F-REAL", statement: "Real observation.", source: "harness/facts/F-REAL.md", observedAt: "2026-08-14T00:00:00.000Z", confidence: "high", memoryClass: "semantic", memoryTags: [], provenance: [], liveness: "standing", invalidated: false, archived: false }], warnings: [] };
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
    ["repo.task.submit", { taskId: "task-a", executionId: "execution-a" }], ["repo.task.complete", { taskId: "task-a", consent: true }],
    ["repo.task.attest", { taskId: "task-a", gateId: "ci", result: "pass", mode: "override", rationale: "Upstream runner outage" }],
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
    ["repo.agent.entity.write", { declaration: { schema: "agent-declaration/v1", id: "gui-created-agent", name: "GUI Created Agent", instructions: "Keep the roster intact.\nSecond line.", runtimes: [{ type: "codex", model: "gpt-5.6-terra" }], role: "worker", skills: [{ id: "review", path: "skills/review" }], prompts: ["prompt://gui"], preset: "standard-task" } }],
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
  assert.deepEqual(actionForDaemonMethod("repo.task.submit", cases.get("repo.task.submit")!), { kind: "task-submit", ...cases.get("repo.task.submit")! }); assert.deepEqual(actionForDaemonMethod("repo.task.complete", cases.get("repo.task.complete")!), { kind: "task-complete", ...cases.get("repo.task.complete")! });
  // The GUI attest facet is the same closed task-attest action the CLI builds; admission stays in the daemon handler.
  assert.deepEqual(actionForDaemonMethod("repo.task.attest", cases.get("repo.task.attest")!), { kind: "task-attest", ...cases.get("repo.task.attest")! });
  assert.equal(parseDaemonRpcParams("repo.task.attest", { repo: { repoId: "alpha" }, payload: { taskId: "task-a", gateId: "ci" } }).ok, false);
  assert.equal(parseDaemonRpcParams("repo.task.attest", { repo: { repoId: "alpha" }, payload: { taskId: "task-a", gateId: "ci", result: "pass", executor: { kind: "agent", id: "runtime" } } }).ok, false);
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

test("JSON-RPC failure receipt carries formal operation identity and origin", async () => {
  const host = { run: async () => { throw new Error("unused"); }, read: async () => { throw new Error("unused"); }, attach: async () => { throw new Error("unused"); }, issueRuntimeWitness: async () => { throw new Error("unused"); }, bindRuntimeWitness: () => { throw new Error("unused"); }, publishRuntimeWitness: () => { throw new Error("unused"); }, bootstrap: async () => ({}), admin: async () => ({}),
    status: () => ({ daemonId: "test", pid: process.pid, repos: [] }), close: async () => undefined };
  const server = createJsonRpcProtocolServer({ host, build: { commit: null }, authContext: { transportKind: "unix-socket" }, emit: async () => undefined });
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: { major: 2, minor: 0 } } });
  assert.ok(response && !Array.isArray(response) && "result" in response); if (response && !Array.isArray(response) && "result" in response) {
    const receipt = response.result as Record<string, unknown>; assert.deepEqual(receipt, { schema: "command-receipt/v2", ok: false, command: "protocol.hello", outcome: "op_rejected", opId: "N/A", origin: "daemon", code: "incompatible_protocol_version", evidence: "rejection:incompatible_protocol_version", rejectionExplanation: "Use the daemon protocol version reported by this binary.", error: { code: "incompatible_protocol_version" } }); }
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

test("repo.settings.update accepts every settings-contract field and nothing else", () => {
  // 契约(kernel 单源)加字段而 wire 白名单没跟上时,GUI 整表提交会被 unknown_field 静默拒收
  // (2026-09-18 实测:restoreDrillRetention/gatesFromDocument 漂移让每次提交都 op_rejected)。
  const route = daemonGuiActionMethods.find((candidate) => candidate.method === "repo.settings.update");
  assert.ok(route, "the settings update route must stay declared");
  const allowed = new Set(Object.keys(route.params.fields.payload!.fields)),
    expected = new Set([...settingsUpdateInputFields.map(({ field }) => field), "idempotencyKey"]);
  assert.deepEqual(
    [...allowed].sort(),
    [...expected].sort(),
    "wire whitelist must equal the kernel contract fields plus the transport key",
  );
  const sample = (descriptor: { readonly type: string; readonly enum?: readonly string[] }): unknown =>
    descriptor.enum?.[0] ??
    (descriptor.type === "boolean"
      ? true
      : descriptor.type === "number"
        ? 3
        : descriptor.type === "string-array" || descriptor.type === "json-object-array"
          ? []
          : "value");
  for (const descriptor of settingsUpdateInputFields) {
    // 基础字段保证「至少一个真实设置字段」语义成立;transport 字段(expectedVersion)单独发
    // 本就应当被拒。
    const parsed = parseDaemonRpcParams("repo.settings.update", {
      repo: { repoId: "alpha" },
      payload: { defaultReviewer: "probe", [descriptor.field]: sample(descriptor), idempotencyKey: "probe" },
    });
    assert.equal(parsed.ok, true, `contract field ${descriptor.field} must survive the wire shape`);
  }
  const rejected = parseDaemonRpcParams("repo.settings.update", {
    repo: { repoId: "alpha" },
    payload: { notASettingsField: true, idempotencyKey: "probe" },
  });
  assert.equal(rejected.ok, false);
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
