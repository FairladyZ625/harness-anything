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
import { makeTaskEventStore, type AgentRuntimeEventV1, type FrozenWritePlan } from "../../kernel/src/index.ts";
import { streamAgentRuntimeAt } from "../src/main/agent-runtime-stream-client.ts";

test("GUI client reaches every shipped read through a real resident daemon", async () => {
  const fixture = await startGuiResidentDaemonFixture({ task: { taskId: "task-gui-smoke", title: "Resident GUI task" }, beforeRestart: seedRuntime });
  const previous = { userRoot: process.env.HARNESS_DAEMON_USER_ROOT, daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID };
  Object.assign(process.env, fixture.env);
  try {
    writeTriadicLedger(fixture.rootDir);
    const bridge = createLocalGuiServiceBridge(fixture.rootDir), executionId = "execution-gui-bridge";
    const started = parseDaemonGuiActionResponse("repo.task.start", await bridge.invoke("startTask", { taskId: "task-gui-smoke", executionId }));
    assert.equal(started.ok, true, JSON.stringify(started)); assert.equal(started.outcome, "applied");
    const documentBody = "# Canonical GUI document\n", documentPath = "tasks/task-gui-smoke-resident-gui-task/notes.md", authored = path.join(fixture.rootDir, "harness", documentPath);
    mkdirSync(path.dirname(authored), { recursive: true }); writeFileSync(authored, documentBody);
    const status = await requestDaemonJsonRpcAt(fixture.endpoint, "repo.task.run", { repo: { repoId: fixture.repoId },
      payload: { action: { kind: "doc-status", paths: [documentPath] } } }, 1_000);
    assert.equal(status.ok, true, JSON.stringify(status)); const synced = await requestDaemonJsonRpcAt(fixture.endpoint, "repo.task.run", { repo: { repoId: fixture.repoId }, payload: { action: { kind: "doc-submit",
      executionId, paths: [documentPath] } } }, 1_000);
    assert.equal(synced.ok, true, JSON.stringify(synced)); writeFileSync(authored, "# Uncommitted filesystem edit\n");
    const results = new Map<DaemonGuiReadMethod, unknown>();
    for (const contract of daemonGuiReadMethods) {
      const payload = contract.id === "tasks.document.read" ? { taskId: "task-gui-smoke", path: "notes.md" } : contract.id === "agentRuntime.sessions.read" ? { runtimeSessionId: "runtime-gui" } : contract.id === "agentRuntime.events.read" ? { runtimeSessionId: "runtime-gui", afterCursor: "lifecycle:0" } : null;
      const result = await bridge.invoke(contract.guiBridgeMethod, payload);
      assert.equal(parseDaemonGuiReadResponse(contract.method, result).ok, true, contract.method);
      results.set(contract.method, result);
    }
    assert.deepEqual([...results.keys()], daemonGuiReadMethods.map(({ method }) => method));
    const tasks = parseDaemonGuiReadResult("repo.tasks.list", results.get("repo.tasks.list"));
    assert.deepEqual(tasks.rows.map(({ taskId }) => taskId), ["task-gui-smoke"]);
    assert.equal(tasks.rows[0]?.snapshot.task?.title, "Resident GUI task");
    assert.equal(tasks.rows[0]?.snapshot.task?.status, "active"); assert.equal(tasks.rows[0]?.snapshot.lease?.executionId, executionId);
    assert.deepEqual(tasks.rows[0]?.placement.moduleKeys, ["gui"]); assert.equal(tasks.rows[0]?.placement.origin, "native");
    const graph = parseDaemonGuiReadResult("repo.triadic.relationGraph", results.get("repo.triadic.relationGraph"));
    assert.equal(graph.edges.length, 3); assert.equal(graph.factAnchors.length, 1); assert.equal(graph.facts.length, 1);
    assert.equal(graph.facts[0]?.statement, "The GUI renderer received event-backed triadic rows.");
    const decisions = parseDaemonGuiReadResult("repo.decisions.list", results.get("repo.decisions.list"));
    assert.deepEqual(decisions.decisions.map(({ decisionId }) => decisionId), ["dec_gui_smoke"]);
    const controlled = parseDaemonGuiActionResponse("repo.decision.list", await bridge.invoke("listDecisions", {})); assert.equal(controlled.ok, true); assert.match(String(controlled.evidence), /dec_gui_smoke/u);
    const document = parseDaemonGuiReadResult("repo.tasks.document.read", results.get("repo.tasks.document.read"));
    assert.equal(document.body, documentBody); assert.equal(document.path, "notes.md"); assert.equal(document.status, "ready");
    const progress = parseDaemonGuiActionResponse("repo.task.progress.append", await bridge.invoke("appendTaskProgress", { taskId: "task-gui-smoke", executionId, text: "Renderer sent typed progress.", evidence: [{ type: "test", path: "packages/gui/test/service-bridge.test.ts", summary: "resident daemon bridge" }], baseDocumentSha256: null }));
    assert.equal(progress.ok, true, JSON.stringify(progress)); assert.equal(progress.outcome, "applied");
    const commitSha = String(progress.commitSha); assert.match(commitSha, /^[0-9a-f]{40}$/u);
    const submitted = parseDaemonGuiActionResponse("repo.task.submit", await bridge.invoke("submitTask", { taskId: "task-gui-smoke", executionId, submission: {
      completionClaim: "GUI task mutation bridge is exercised.", deliverables: ["Task action bridge"], outputs: ["packages/gui/test/service-bridge.test.ts"],
      verificationNotes: ["resident daemon"], knownGaps: ["Electron E2E unverified"], residualRisks: ["manual desktop verification pending"], commitSha
    } }));
    assert.equal(submitted.ok, true, JSON.stringify(submitted)); assert.equal(submitted.outcome, "applied");
    const afterSubmit = parseDaemonGuiReadResult("repo.tasks.list", await bridge.invoke("getTasks", null));
    assert.equal(afterSubmit.rows[0]?.snapshot.task?.status, "in_review"); assert.equal(afterSubmit.rows[0]?.snapshot.lease, null);
  } finally {
    await fixture.stop();
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot); restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
    restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
  }
});

test("GUI contract rejects any shipped bridge method missing from the daemon protocol", () => {
  const daemonMethods = new Set(jsonRpcMethodContracts.map(({ method }) => method));
  const missing = apiRouteContracts.filter(({ guiBridgeMethod }) => guiBridgeMethod !== undefined)
    .map(({ rpcMethod }) => rpcMethod).filter((method) => method === undefined || !daemonMethods.has(method));
  assert.deepEqual(missing, []);
});

test("GUI attach reconnects after transport loss from the last delivered cursor and accepts restart gap", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-runtime-reconnect-")), socketPath = path.join(parent, "daemon.sock"), attempts: string[] = [], values: unknown[] = []; let resolveGap!: () => void; const gapSeen = new Promise<void>((resolve) => { resolveGap = resolve; }), server = net.createServer((socket) => { let input = ""; socket.on("data", (chunk) => { input += chunk.toString(); for (;;) { const newline = input.indexOf("\n"); if (newline < 0) return; const line = input.slice(0, newline); input = input.slice(newline + 1); const request = JSON.parse(line) as { id: number; method: string; params: { payload?: { afterCursor?: string } } }; if (request.method === "protocol.hello") { socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`); continue; } attempts.push(request.params.payload?.afterCursor ?? "missing"); if (attempts.length === 1) { socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, status: "attached", runtimeSessionId: "runtime-reconnect", cursor: "stream:0", events: [] } })}\n${JSON.stringify({ jsonrpc: "2.0", method: "repo.agentRuntime.attach.frame", params: { schema: "agent-runtime-attach-event/v1", type: "heartbeat", runtimeSessionId: "runtime-reconnect", cursor: "stream:1", occurredAt: "2026-08-13T00:00:00.000Z" } })}\n`, () => { socket.destroy(); server.close(() => setTimeout(() => server.listen(socketPath), 120)); }); } else { socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, status: "gap", runtimeSessionId: "runtime-reconnect", cursor: "stream:0", events: [{ schema: "agent-runtime-attach-event/v1", type: "gap", runtimeSessionId: "runtime-reconnect", cursor: "stream:0", occurredAt: "2026-08-13T00:00:01.000Z", required: "snapshot" }] } })}\n`); } } }); });
  try { server.listen(socketPath); await once(server, "listening"); const detach = await streamAgentRuntimeAt({ socketPath, repoId: "runtime-reconnect", payload: { runtimeSessionId: "runtime-reconnect", afterCursor: "stream:0" }, onValue: (value) => { values.push(value); if ("ok" in value && value.ok && value.status === "gap") resolveGap(); }, timeoutMs: 1_000 }); await gapSeen; assert.deepEqual(attempts, ["stream:0", "stream:1"]); assert.equal((values.at(-1) as { status?: string }).status, "gap"); detach(); } finally { server.close(); await once(server, "close"); rmSync(parent, { recursive: true, force: true }); }
});

test("local GUI bridge fails closed without explicit daemon registration and never autostarts", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-explicit-daemon-")), userRoot = path.join(rootDir, "user-daemon");
  const previous = process.env.HARNESS_DAEMON_USER_ROOT; process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
  try {
    const result = await createLocalGuiServiceBridge(rootDir).invoke("getTasks", null) as Failure;
    assert.equal(result.ok, false); assert.equal(result.error?.code, "daemon_unavailable");
    assert.match(result.error?.hint ?? "", /workspace is not registered/u);
    assert.equal(existsSync(path.join(userRoot, "registry.json")), false);
  } finally { restoreEnv("HARNESS_DAEMON_USER_ROOT", previous); rmSync(rootDir, { recursive: true, force: true }); }
});

function restoreEnv(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
interface Failure { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } }
function seedRuntime(rootDir: string, repoId: string): void { const store = makeTaskEventStore({ rootDir, repoId }), base = store.read().revision, values = [
  ["runtime_installation_observed", { installationId: "installation-gui", kindId: "codex", protocolFamily: "codex", hostRef: "host:gui", version: "1.0.0", discoverySource: "wrapper", capabilities: ["structured_witness", "attach"], authState: "configured" }],
  ["runtime_session_started", { runtimeSessionId: "runtime-gui", installationId: "installation-gui", kindId: "codex", launchGeneration: 1, attachable: true }],
  ["runtime_session_task_bound", { runtimeSessionId: "runtime-gui", taskId: "task-gui", executionId: "execution-gui", providerSessionId: "provider-gui", transcriptRef: "file:runtime/gui.jsonl" }]
  ] as const; for (const [index, [type, payload]] of values.entries()) { const revision = base + index + 1, event = { schema: "agent-runtime-event/v1", eventId: `event-runtime-gui-${revision}`, workspaceRevision: revision, opId: `op-runtime-gui-${revision}`, actor: { principal: { personId: "person-gui" }, executor: null }, source: "local", occurredAt: `2026-08-13T00:00:0${index}.000Z`, type, payload } as AgentRuntimeEventV1; store.append({ event, plan: runtimeWritePlan(event), blobs: [] }); }
  seedTriadicEvents(rootDir, repoId); }
function runtimeWritePlan(event: AgentRuntimeEventV1): FrozenWritePlan { return Object.freeze({ commandType: event.type, targets: Object.freeze([{ kind: "event_file", path: `harness/events/${event.opId}.json`, operation: "create" }, { kind: "event_head", path: "harness/events/head.json", operation: "replace" }, { kind: "projection_invalidation", projection: "agent-runtime/v1", key: event.opId }].map((target) => Object.freeze(target))) }) as FrozenWritePlan; }
