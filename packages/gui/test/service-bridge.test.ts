// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { daemonGuiReadMethods, jsonRpcMethodContracts, type DaemonGuiReadMethod } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiActionResponse, parseDaemonGuiReadResponse, parseDaemonGuiReadResult } from "../../daemon/src/protocol/gui-result-validation.ts";
import { apiRouteContracts, createLocalGuiServiceBridge } from "../src/index.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import { seedTriadicEvents, writeTriadicLedger } from "../test-support/triadic-ledger.mjs";
import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { eventObjectTarget, makeTaskEventStore, type AgentRuntimeEventV1, type FrozenWritePlan } from "../../kernel/src/index.ts";
import { streamAgentRuntimeAt } from "../src/main/agent-runtime-stream-client.ts";

test("GUI client reaches every shipped read through a real resident daemon", async () => {
  const fixture = await startGuiResidentDaemonFixture({ task: { taskId: "task-gui-smoke", title: "Resident GUI task" }, beforeRestart: seedRuntime });
  const previous = { userRoot: process.env.HARNESS_DAEMON_USER_ROOT, daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID };
  Object.assign(process.env, fixture.env);
  try {
    writeTriadicLedger(fixture.rootDir); seedEntityDeclarations(fixture.rootDir);
    const bridge = createLocalGuiServiceBridge(fixture.rootDir), executionId = "execution-gui-bridge", scope = { repoId: fixture.repoId };
    const started = parseDaemonGuiActionResponse("repo.task.start", await bridge.invoke("startTask", { ...scope, taskId: "task-gui-smoke", executionId }));
    assert.equal(started.ok, true, JSON.stringify(started)); assert.equal(started.outcome, "applied");
    const documentBody = "# Canonical GUI document\n", documentPath = "tasks/task-gui-smoke-resident-gui-task/notes.md", authored = path.join(fixture.rootDir, "harness", documentPath);
    mkdirSync(path.dirname(authored), { recursive: true }); writeFileSync(authored, documentBody);
    const status = await requestDaemonJsonRpcAt(fixture.endpoint, "repo.task.run", { repo: { repoId: fixture.repoId },
      payload: { action: { kind: "doc-status", paths: [documentPath] } } }, 1_000);
    assert.equal(status.ok, true, JSON.stringify(status)); const synced = await requestDaemonJsonRpcAt(fixture.endpoint, "repo.task.run", { repo: { repoId: fixture.repoId }, payload: { action: { kind: "doc-submit",
      executionId, paths: [documentPath] } } }, 1_000);
    assert.equal(synced.ok, true, JSON.stringify(synced)); writeFileSync(authored, "# Uncommitted filesystem edit\n");
    const control = await bridge.invoke("requestDaemonControl", { kind: "restart", authorityRepoId: fixture.repoId }) as { operationId: string };
    const catalog = await bridge.invoke("getCatalogSnapshot", scope) as { defaults: { presetId: string } };
    const reread = await bridge.invoke("rereadCatalog", { ...scope, expectedDigest: (catalog as { catalogDigest: string }).catalogDigest }) as { schema: string; ok: boolean; operationId: string; repoId: string };
    assert.deepEqual({ schema: reread.schema, ok: reread.ok, repoId: reread.repoId }, { schema: "catalog-reread-receipt/v1", ok: true, repoId: fixture.repoId }); assert.match(reread.operationId, /^catalog-/u);
    const results = new Map<DaemonGuiReadMethod, unknown>();
    for (const contract of daemonGuiReadMethods) {
      const payload = contract.id === "gui.system.read" ? null : contract.id === "gui.control.receipt" ? { operationId: control.operationId }
        : contract.id === "tasks.document.read" ? { ...scope, taskId: "task-gui-smoke", path: "notes.md" }
        : contract.id === "tasks.documents.list" || contract.id === "task.dispatches" ? { ...scope, taskId: "task-gui-smoke" }
        : contract.id === "agentRuntime.sessions.read" ? { ...scope, runtimeSessionId: "runtime-gui" }
        : contract.id === "agentRuntime.events.read" ? { ...scope, runtimeSessionId: "runtime-gui", afterCursor: "lifecycle:0" }
        : contract.id === "agent.entity.read" ? { ...scope, agentId: "terra" }
        : contract.id === "squad.entity.read" ? { ...scope, squadId: "core-squad" }
        : contract.id === "gui.catalog.preset.read" ? { ...scope, presetId: catalog.defaults.presetId }
        : scope;
      const result = await bridge.invoke(contract.guiBridgeMethod, payload);
      const parsed = contract.id === "gui.control.receipt" ? parseDaemonGuiReadResult(contract.method, result) : parseDaemonGuiReadResponse(contract.method, result);
      if (contract.id === "gui.control.receipt") assert.equal(parsed.schema, "daemon-control-receipt/v1", contract.method);
      else assert.equal(parsed.ok, true, contract.method);
      results.set(contract.method, result);
    }
    assert.deepEqual([...results.keys()], daemonGuiReadMethods.map(({ method }) => method));
    const agentCatalog = parseDaemonGuiReadResult("repo.agent.entities.list", results.get("repo.agent.entities.list"));
    assert.equal(agentCatalog.ok, true); assert.deepEqual(agentCatalog.agents.map(({ id }) => id), ["terra"]);
    assert.deepEqual(agentCatalog.agents[0] && { runtimeType: agentCatalog.agents[0].runtimeType, layer: agentCatalog.agents[0].layer, validity: agentCatalog.agents[0].validity }, { runtimeType: "codex", layer: "user", validity: "valid" });
    const agentDetail = parseDaemonGuiReadResult("repo.agent.entity.read", results.get("repo.agent.entity.read"));
    assert.equal(agentDetail.ok, true); assert.deepEqual(agentDetail.agent && { id: agentDetail.agent.id, instructions: agentDetail.agent.instructions }, { id: "terra", instructions: "Review precisely." });
    const squadCatalog = parseDaemonGuiReadResult("repo.squad.entities.list", results.get("repo.squad.entities.list"));
    assert.equal(squadCatalog.ok, true); assert.deepEqual(squadCatalog.squads.map(({ id }) => id), ["core-squad"]);
    const squadDetail = parseDaemonGuiReadResult("repo.squad.entity.read", results.get("repo.squad.entity.read"));
    assert.equal(squadDetail.ok, true); assert.deepEqual(squadDetail.squad && { leader: squadDetail.squad.leader, workers: squadDetail.squad.workers }, { leader: "terra", workers: ["terra"] });
    const tasks = parseDaemonGuiReadResult("repo.tasks.list", results.get("repo.tasks.list"));
    assert.deepEqual(tasks.rows.map(({ taskId }) => taskId), ["task-gui-smoke"]);
    assert.equal(tasks.rows[0]?.snapshot.task?.title, "Resident GUI task");
    assert.equal(tasks.rows[0]?.snapshot.task?.status, "active"); assert.equal(tasks.rows[0]?.snapshot.lease?.executionId, executionId);
    assert.deepEqual(tasks.rows[0]?.placement.moduleKeys, ["gui"]); assert.equal(tasks.rows[0]?.placement.origin, "native");
    const graph = parseDaemonGuiReadResult("repo.triadic.relationGraph", results.get("repo.triadic.relationGraph"));
    assert.deepEqual(graph.edges.map(({ relationType }) => relationType).sort(), ["derives", "evidenced-by"]); assert.equal(graph.factAnchors.length, 1); assert.equal(graph.facts.length, 1);
    assert.equal(graph.facts[0]?.statement, "The GUI renderer received event-backed triadic rows.");
    const decisions = parseDaemonGuiReadResult("repo.decisions.list", results.get("repo.decisions.list"));
    assert.deepEqual(decisions.decisions.map(({ decisionId }) => decisionId), ["dec_gui_smoke"]);
    const controlled = parseDaemonGuiActionResponse("repo.decision.list", await bridge.invoke("listDecisions", scope)); assert.equal(controlled.ok, true); assert.match(String(controlled.evidence), /dec_gui_smoke/u);
    const proposed = parseDaemonGuiActionResponse("repo.decision.propose", await bridge.invoke("proposeDecision", { ...scope,
      title: "Exercise the GUI proposal bridge", question: "Can proposal and judgment settle through the resident daemon?", riskTier: "medium", urgency: "high",
      vertical: "software/coding", preset: "architecture-decision", decisionClass: "ordinary", appliesTo: { modules: ["gui"], productLines: ["harness"] },
      chosen: [{ id: "CH1", text: "Use typed GUI facets", rationale: "They preserve the canonical packet" }], rejected: [{ id: "RJ1", text: "Use optimistic history", whyNot: "It is not canonical" }],
      body: "## 背景\nResident bridge test.\n\n## 权衡\nTyped receipts over local optimism.\n\n## 结论\nUse daemon facets.\n", claims: [], fulfillments: [], relations: []
    }));
    assert.equal(proposed.ok, true, JSON.stringify(proposed)); assert.equal(proposed.outcome, "applied"); assert.equal(proposed.worktreeVisible, true); assert.equal(proposed.consentId, null);
    assert.match(String(proposed.path), /^decisions\/decision-dec_/u); assert.match(String(proposed.commitSha), /^[0-9a-f]{40}$/u); assert.match(String(proposed.documentSha256), /^(?:sha256:)?[0-9a-f]{64}$/u);
    const proposedEvidence = JSON.parse(String(proposed.evidence)) as { decisionId: string }; assert.match(proposedEvidence.decisionId, /^dec_[0-9A-F]{26}$/u);
    const accepted = parseDaemonGuiActionResponse("repo.decision.accept", await bridge.invoke("acceptDecision", { ...scope, decisionId: proposedEvidence.decisionId, rationale: "Independent resident-daemon acceptance.", judgmentOnlyRationale: "No load-bearing claim was declared; explicit human judgment is recorded." }));
    assert.equal(accepted.ok, true, JSON.stringify(accepted)); assert.equal(accepted.outcome, "applied"); assert.equal(accepted.worktreeVisible, true); assert.match(String(accepted.consentId), /^djc_[0-9a-f]{26}$/u);
    const acceptedReceipt = parseDaemonGuiActionResponse("repo.receipt.show", await bridge.invoke("showReceipt", { ...scope, opId: accepted.opId })); assert.equal(acceptedReceipt.outcome, "applied"); assert.equal(acceptedReceipt.consentId, accepted.consentId);
    const shown = parseDaemonGuiActionResponse("repo.decision.show", await bridge.invoke("showDecision", { ...scope, decisionId: proposedEvidence.decisionId, includeBody: true })); assert.equal(shown.ok, true); assert.match(String(shown.evidence), new RegExp(String(accepted.consentId), "u"));
    const afterJudgment = parseDaemonGuiReadResult("repo.decisions.list", await bridge.invoke("getDecisions", scope));
    const canonicalDecision = afterJudgment.decisions.find((decision) => decision.decisionId === proposedEvidence.decisionId); assert.equal(canonicalDecision?.state, "in_effect"); assert.equal(canonicalDecision?.judgmentConsents[0]?.consentId, accepted.consentId);
    const document = parseDaemonGuiReadResult("repo.tasks.document.read", results.get("repo.tasks.document.read"));
    assert.equal(document.body, documentBody); assert.equal(document.path, "notes.md"); assert.equal(document.status, "ready");
    const documents = parseDaemonGuiReadResult("repo.tasks.documents.list", results.get("repo.tasks.documents.list"));
    assert.equal(documents.status, "ready"); assert.ok(documents.documents.some((row) => row.path === "notes.md"), JSON.stringify(documents.documents));
    const progress = parseDaemonGuiActionResponse("repo.task.progress.append", await bridge.invoke("appendTaskProgress", { ...scope, taskId: "task-gui-smoke", executionId, text: "Renderer sent typed progress.", evidence: [{ type: "test", path: "packages/gui/test/service-bridge.test.ts", summary: "resident daemon bridge" }], baseDocumentSha256: null }));
    assert.equal(progress.ok, true, JSON.stringify(progress)); assert.equal(progress.outcome, "applied");
    const commitSha = String(progress.commitSha); assert.match(commitSha, /^[0-9a-f]{40}$/u);
    const submitted = parseDaemonGuiActionResponse("repo.task.submit", await bridge.invoke("submitTask", { ...scope, taskId: "task-gui-smoke", executionId, submission: {
      completionClaim: "GUI task mutation bridge is exercised.", deliverables: ["Task action bridge"], outputs: ["packages/gui/test/service-bridge.test.ts"],
      verificationNotes: ["resident daemon"], knownGaps: ["Electron E2E unverified"], residualRisks: ["manual desktop verification pending"], commitSha
    } }));
    assert.equal(submitted.ok, true, JSON.stringify(submitted)); assert.equal(submitted.outcome, "applied");
    const afterSubmit = parseDaemonGuiReadResult("repo.tasks.list", await bridge.invoke("getTasks", scope));
    assert.equal(afterSubmit.rows[0]?.snapshot.task?.status, "in_review"); assert.equal(afterSubmit.rows[0]?.snapshot.lease, null);
    const evidence = afterSubmit.rows[0]?.executionEvidence.find((item) => item.executionId === executionId), output = evidence?.outputs[0];
    assert.equal(evidence?.origin, "native"); assert.match(output?.evidenceId ?? "", /^evidence_[0-9a-f]{24}$/u);
    assert.deepEqual(output && { locator: output.locator, substrate: output.substrate, checkerReceiptRef: output.checkerReceiptRef, checkerResult: output.checkerResult }, {
      locator: "packages/gui/test/service-bridge.test.ts", substrate: "repository-path", checkerReceiptRef: null, checkerResult: "unknown"
    });
  } finally {
    await fixture.stop();
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot); restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
    restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
  }
});

test("GUI entity write channel validates then installs an Agent and preserves a Squad roster", async () => {
  const fixture = await startGuiResidentDaemonFixture({ task: { taskId: "task-gui-entity-write", title: "Entity write" } });
  const previous = { userRoot: process.env.HARNESS_DAEMON_USER_ROOT, daemonId: process.env.HARNESS_DAEMON_ID, repoId: process.env.HARNESS_DAEMON_REPO_ID };
  Object.assign(process.env, fixture.env);
  try {
    const bridge = createLocalGuiServiceBridge(fixture.rootDir), scope = { repoId: fixture.repoId }, agentDeclaration = { schema: "agent-declaration/v1", id: "gui-created-agent", name: "GUI Created Agent", instructions: "Keep the roster intact.\nSecond line.", runtime_type: "any", model: "gpt-5.6-terra", skills: ["review"], prompts: ["prompt://gui"], preset: "standard-task" };
    const agentReceipt = parseDaemonGuiActionResponse("repo.agent.entity.write", await bridge.invoke("saveAgent", { ...scope, declaration: agentDeclaration }));
    assert.equal(agentReceipt.ok, true, JSON.stringify(agentReceipt)); assert.equal(agentReceipt.outcome, "applied");
    const roster = "## GUI Squad\n\n  GUI Created Agent\n\n";
    const squadReceipt = parseDaemonGuiActionResponse("repo.squad.entity.write", await bridge.invoke("saveSquad", { ...scope, declaration: { schema: "squad-declaration/v1", id: "gui-created-squad", name: "GUI Created Squad", leader: "gui-created-agent", workers: ["gui-created-agent"], roster } }));
    assert.equal(squadReceipt.ok, true, JSON.stringify(squadReceipt)); assert.equal(squadReceipt.outcome, "applied");
    const listed = parseDaemonGuiReadResult("repo.agent.entities.list", await bridge.invoke("listAgents", scope)); assert.ok(listed.agents.some(({ id }) => id === "gui-created-agent"));
    const shownAgent = parseDaemonGuiReadResult("repo.agent.entity.read", await bridge.invoke("showAgent", { ...scope, agentId: "gui-created-agent" })); assert.equal(shownAgent.agent.model, "gpt-5.6-terra");
    const shown = parseDaemonGuiReadResult("repo.squad.entity.read", await bridge.invoke("showSquad", { ...scope, squadId: "gui-created-squad" })); assert.equal(shown.squad.roster, roster);
    const rejected = parseDaemonGuiActionResponse("repo.agent.entity.write", await bridge.invoke("saveAgent", { ...scope, declaration: { ...agentDeclaration, id: "Bad ID" } })); assert.equal(rejected.outcome, "op_rejected");
  } finally { await fixture.stop(); restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot); restoreEnv("HARNESS_DAEMON_ID", previous.daemonId); restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId); }
});

test("GUI contract rejects any shipped bridge method missing from the daemon protocol", () => {
  const daemonMethods = new Set(jsonRpcMethodContracts.map(({ method }) => method));
  const missing = apiRouteContracts.filter(({ guiBridgeMethod }) => guiBridgeMethod !== undefined)
    .map(({ rpcMethod }) => rpcMethod).filter((method) => method === undefined || !daemonMethods.has(method));
  assert.deepEqual(missing, []);
});

test("GUI renderer bridge drives a resident PTY through spawn attach IO resize detach and terminate", async () => {
  const fixture = await startGuiResidentDaemonFixture({ task: { taskId: "task-terminal", title: "Terminal renderer chain" } });
  const previous = { userRoot: process.env.HARNESS_DAEMON_USER_ROOT, daemonId: process.env.HARNESS_DAEMON_ID, repoId: process.env.HARNESS_DAEMON_REPO_ID };
  Object.assign(process.env, fixture.env);
  try {
    const bridge = createLocalGuiServiceBridge(fixture.rootDir), scope = { repoId: fixture.repoId };
    const spawned = await bridge.invoke("spawnTerminal", { ...scope, idempotencyKey: "terminal-renderer-chain", name: "Renderer chain", cwd: { scope: "repo-root" }, shellProfileId: "default", taskId: "task-terminal" }) as Record<string, unknown>;
    assert.equal(spawned.schema, "terminal-control-receipt/v1", JSON.stringify(spawned)); assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const sessionId = String(spawned.sessionId), values: Array<Record<string, unknown>> = [];
    let resolveEcho!: () => void; const echoSeen = new Promise<void>((resolve) => { resolveEcho = resolve; });
    const stop = await bridge.stream("attachTerminal", { ...scope, sessionId, afterSeq: 0 }, (value) => {
      const frame = value as Record<string, unknown>; values.push(frame); if (frame.schema === "terminal-attach-event/v1" && String(frame.utf8).includes("GUI_S3_R2_PTY")) resolveEcho();
    });
    const initial = values.find((value) => value.schema === "terminal-attach/v1"); assert.equal(initial?.status, "attached"); assert.equal(typeof initial?.attachmentId, "string");
    const input = await bridge.invoke("sendTerminalInput", { ...scope, sessionId, clientSeq: 1, utf8: "printf 'GUI_S3_R2_PTY\\n'\r" }) as Record<string, unknown>;
    assert.deepEqual({ schema: input.schema, acceptedThrough: input.acceptedThrough }, { schema: "terminal-input-ack/v1", acceptedThrough: 1 });
    await Promise.race([echoSeen, new Promise((_, reject) => setTimeout(() => reject(new Error("resident PTY echo timeout")), 2_000))]);
    const resized = await bridge.invoke("resizeTerminal", { ...scope, sessionId, cols: 100, rows: 30 }) as Record<string, unknown>;
    assert.equal(resized.outcome, "applied", JSON.stringify(resized));
    const detached = await bridge.invoke("detachTerminal", { ...scope, sessionId, attachmentId: initial!.attachmentId }) as Record<string, unknown>;
    assert.deepEqual({ schema: detached.schema, state: detached.state }, { schema: "terminal-detach-ack/v1", state: "detached" }); stop();
    const rejected = await bridge.invoke("terminateTerminal", { ...scope, sessionId, confirmed: false }) as Record<string, unknown>;
    assert.equal(rejected.outcome, "op_rejected");
    const terminated = await bridge.invoke("terminateTerminal", { ...scope, sessionId, confirmed: true }) as Record<string, unknown>;
    assert.deepEqual({ outcome: terminated.outcome, state: terminated.state }, { outcome: "applied", state: "exited" });
  } finally {
    await fixture.stop(); restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot); restoreEnv("HARNESS_DAEMON_ID", previous.daemonId); restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
  }
});

test("GUI bridge switches between two enabled RepoCells without leaking task rows", async () => {
  const fixture = await startGuiResidentDaemonFixture({ task: { taskId: "task-repo-a", title: "Repo A task" }, beforeStop: async (endpoint, repoId) => {
    const created = await requestDaemonJsonRpcAt(endpoint, "repo.task.create", { repo: { repoId }, payload: { taskId: "task-gui-smoke", title: "Repo A triadic task" } }, 1_000);
    assert.equal(created.ok, true, JSON.stringify(created));
  }, beforeRestart: seedTriadicEvents });
  const previous = { userRoot: process.env.HARNESS_DAEMON_USER_ROOT, daemonId: process.env.HARNESS_DAEMON_ID, repoId: process.env.HARNESS_DAEMON_REPO_ID };
  Object.assign(process.env, fixture.env);
  try {
    writeTriadicLedger(fixture.rootDir);
    const repoBRoot = path.join(path.dirname(fixture.rootDir), "repo-b"), repoBId = "gui-test-b";
    const bootstrapped = await requestDaemonJsonRpcAt(fixture.endpoint, "daemon.repo.bootstrap", { rootDir: repoBRoot, repoId: repoBId, personId: "person-gui", displayName: "GUI Test B" }, 1_000);
    assert.equal(bootstrapped.ok, true, JSON.stringify(bootstrapped));
    const created = await requestDaemonJsonRpcAt(fixture.endpoint, "repo.task.create", { repo: { repoId: repoBId }, payload: { taskId: "task-repo-b", title: "Repo B task" } }, 1_000);
    assert.equal(created.ok, true, JSON.stringify(created));
    const bridge = createLocalGuiServiceBridge(fixture.rootDir);
    const [repoA, repoB] = await Promise.all([
      bridge.invoke("getTasks", { repoId: fixture.repoId }), bridge.invoke("getTasks", { repoId: repoBId }),
    ]);
    assert.deepEqual(parseDaemonGuiReadResult("repo.tasks.list", repoA).rows.map(({ taskId }) => taskId), ["task-gui-smoke", "task-repo-a"]);
    assert.deepEqual(parseDaemonGuiReadResult("repo.tasks.list", repoB).rows.map(({ taskId }) => taskId), ["task-repo-b"]);
    const [graphA, graphB, catalogA, catalogB] = await Promise.all([
      bridge.invoke("getRelationGraph", { repoId: fixture.repoId }), bridge.invoke("getRelationGraph", { repoId: repoBId }),
      bridge.invoke("getCatalogSnapshot", { repoId: fixture.repoId }), bridge.invoke("getCatalogSnapshot", { repoId: repoBId }),
    ]);
    assert.equal(parseDaemonGuiReadResult("repo.triadic.relationGraph", graphA).edges.length > 0, true);
    assert.equal(parseDaemonGuiReadResult("repo.triadic.relationGraph", graphB).edges.length, 0);
    assert.deepEqual([(catalogA as { repoId: string }).repoId, (catalogB as { repoId: string }).repoId], [fixture.repoId, repoBId]);
    const system = parseDaemonGuiReadResult("daemon.gui.system.read", await bridge.invoke("getSystemStatus", null));
    assert.deepEqual(system.repos.map((repo) => [repo.repoId, repo.registrationState, repo.cellState]), [[fixture.repoId, "enabled", "attached"], [repoBId, "enabled", "attached"]]);
    const disabled = await requestDaemonJsonRpcAt(fixture.endpoint, "daemon.repo.unregister", { repoId: repoBId }, 1_000);
    assert.equal(disabled.ok, true, JSON.stringify(disabled));
    const afterDisable = parseDaemonGuiReadResult("daemon.gui.system.read", await bridge.invoke("getSystemStatus", null));
    assert.deepEqual(afterDisable.repos.find((repo) => repo.repoId === repoBId) && { registrationState: afterDisable.repos.find((repo) => repo.repoId === repoBId)?.registrationState, cellState: afterDisable.repos.find((repo) => repo.repoId === repoBId)?.cellState }, { registrationState: "disabled", cellState: "not_loaded" });
    const denied = await bridge.invoke("getTasks", { repoId: repoBId }) as Failure;
    assert.equal(denied.ok, false); assert.equal(denied.error?.code, "daemon_unavailable"); assert.match(denied.error?.hint ?? "", /workspace is not registered/u);
  } finally {
    await fixture.stop(); restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot); restoreEnv("HARNESS_DAEMON_ID", previous.daemonId); restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
  }
});

test("GUI attach reconnects after transport loss from the last delivered cursor and accepts restart gap", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-runtime-reconnect-")), socketPath = path.join(parent, "daemon.sock"), attempts: string[] = [], values: unknown[] = []; let resolveGap!: () => void; const gapSeen = new Promise<void>((resolve) => { resolveGap = resolve; }), server = net.createServer((socket) => { let input = ""; socket.on("data", (chunk) => { input += chunk.toString(); for (;;) { const newline = input.indexOf("\n"); if (newline < 0) return; const line = input.slice(0, newline); input = input.slice(newline + 1); const request = JSON.parse(line) as { id: number; method: string; params: { payload?: { afterCursor?: string } } }; if (request.method === "protocol.hello") { socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`); continue; } attempts.push(request.params.payload?.afterCursor ?? "missing"); if (attempts.length === 1) { socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, status: "attached", runtimeSessionId: "runtime-reconnect", cursor: "stream:0", events: [] } })}\n${JSON.stringify({ jsonrpc: "2.0", method: "repo.agentRuntime.attach.frame", params: { schema: "agent-runtime-attach-event/v1", type: "heartbeat", runtimeSessionId: "runtime-reconnect", cursor: "stream:1", occurredAt: "2026-08-13T00:00:00.000Z" } })}\n`, () => { socket.destroy(); server.close(() => setTimeout(() => server.listen(socketPath), 120)); }); } else { socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, status: "gap", runtimeSessionId: "runtime-reconnect", cursor: "stream:0", events: [{ schema: "agent-runtime-attach-event/v1", type: "gap", runtimeSessionId: "runtime-reconnect", cursor: "stream:0", occurredAt: "2026-08-13T00:00:01.000Z", required: "snapshot" }] } })}\n`); } } }); });
  try { server.listen(socketPath); await once(server, "listening"); const detach = await streamAgentRuntimeAt({ socketPath, repoId: "runtime-reconnect", payload: { runtimeSessionId: "runtime-reconnect", afterCursor: "stream:0" }, onValue: (value) => { values.push(value); if ("ok" in value && value.ok && value.status === "gap") resolveGap(); }, timeoutMs: 1_000 }); await gapSeen; assert.deepEqual(attempts, ["stream:0", "stream:1"]); assert.equal((values.at(-1) as { status?: string }).status, "gap"); detach(); } finally { server.close(); await once(server, "close"); rmSync(parent, { recursive: true, force: true }); }
});

test("local GUI bridge fails closed without explicit daemon registration and never autostarts", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-explicit-daemon-")), userRoot = path.join(rootDir, "user-daemon");
  const previous = process.env.HARNESS_DAEMON_USER_ROOT; process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
  try {
    const result = await createLocalGuiServiceBridge(rootDir).invoke("getTasks", { repoId: "missing-repo" }) as Failure;
    assert.equal(result.ok, false); assert.equal(result.error?.code, "daemon_unavailable");
    assert.match(result.error?.hint ?? "", /workspace is not registered/u);
    assert.equal(existsSync(path.join(userRoot, "registry.json")), false);
  } finally { restoreEnv("HARNESS_DAEMON_USER_ROOT", previous); rmSync(rootDir, { recursive: true, force: true }); }
});

function restoreEnv(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
interface Failure { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } }
function seedRuntime(rootDir: string, repoId: string): void { const store = makeTaskEventStore({ rootDir, repoId }), base = store.read().revision, values = [
  ["runtime_installation_observed", { installationId: "installation-gui", kindId: "codex", protocolFamily: "codex", hostRef: "host:gui", version: "1.0.0", discoverySource: "wrapper", capabilities: ["structured_witness", "attach"] }],
  ["runtime_dispatch_requested", { dispatchId: "dispatch-gui", runtimeSessionId: "runtime-gui", instanceId: "codex-gui", installationId: "installation-gui", kindId: "codex", idempotencyKey: "gui", definitionSnapshotRef: "artifact:runtime-definition/gui", definitionSnapshot: { schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "codex-gui", installationId: "installation-gui", kindId: "codex", providerId: "openai", model: "gpt-gui", reasoningEffort: null, baseUrl: null, authMode: "subscription" } }],
  ["runtime_session_started", { runtimeSessionId: "runtime-gui", instanceId: "codex-gui", installationId: "installation-gui", kindId: "codex", definitionSnapshotRef: "artifact:runtime-definition/gui", launchGeneration: 1, attachable: true }],
  ["runtime_session_task_bound", { runtimeSessionId: "runtime-gui", taskId: "task-gui", executionId: "execution-gui", providerSessionId: "provider-gui", transcriptRef: "file:runtime/gui.jsonl" }]
  ] as const; for (const [index, [type, payload]] of values.entries()) { const revision = base + index + 1, event = { schema: "agent-runtime-event/v1", eventId: `event-runtime-gui-${revision}`, workspaceRevision: revision, opId: `op-runtime-gui-${revision}`, actor: { principal: { personId: "person-gui" }, executor: null }, source: "local", occurredAt: `2026-08-13T00:00:0${index}.000Z`, type, payload } as AgentRuntimeEventV1; store.append({ event, plan: runtimeWritePlan(event), blobs: [] }); }
  seedTriadicEvents(rootDir, repoId); }
function runtimeWritePlan(event: AgentRuntimeEventV1): FrozenWritePlan { return Object.freeze({ commandType: event.type, targets: Object.freeze([{ kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" }, { kind: "event_head", path: "harness/events/head.json", operation: "replace" }, { kind: "projection_invalidation", projection: "agent-runtime/v1", key: event.opId }].map((target) => Object.freeze(target))) }) as FrozenWritePlan; }
function seedEntityDeclarations(rootDir: string): void { const agent = { schema: "agent-declaration/v1", id: "terra", name: "Terra", instructions: "Review precisely.", runtime_type: "codex", skills: [{ id: "review", path: "skills/review" }], prompts: ["prompt://review"], preset: "standard-task" }, squad = { schema: "squad-declaration/v1", id: "core-squad", name: "Core Squad", leader: "terra", workers: ["terra"], roster: "# Core Squad\n\nTerra leads review." }; for (const declaration of [agent, squad]) { const store = path.join(rootDir, ".harness", "schema" in declaration && declaration.schema === "agent-declaration/v1" ? "agents" : "squads"); mkdirSync(store, { recursive: true }); writeFileSync(path.join(store, `${declaration.id}.json`), `${JSON.stringify(declaration, null, 2)}\n`); } }
