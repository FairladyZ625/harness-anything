// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, registerDaemonRepo, type AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { openRepoCell } from "../src/repo-cell.ts";

const definition: AgentDefinitionSnapshot = { schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "codex-review", installationId: "installation-codex", kindId: "codex", providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", baseUrl: "https://api.example.test/", authMode: "api-key" };
const installation: RuntimeInstallationWitness = { installationId: definition.installationId, kindId: definition.kindId, executablePath: "/opt/witnessed/codex", version: "1.0.0", observedAt: "2026-08-14T00:00:00.000Z" };

test("runtime spawn publishes a canonical session and makes it visible in overview", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-spawn-"));
    try {
      git(root, "init", "-q"); git(root, "config", "user.name", "Spawn Test"); git(root, "config", "user.email", "spawn@example.invalid"); git(root, "commit", "--allow-empty", "-qm", "base");
      let launched: unknown, intentWasDurable = false;
      const cell = await openRepoCell({ repoId: workspaceId("runtime-spawn"), rootDir: canonicalRoot(root), ownerId: "spawn-test", runtimeInstances: () => [{ schemaVersion: 1, instanceId: definition.instanceId, name: "Codex Review", kindId: "codex", installationId: definition.installationId, providerId: definition.providerId, model: definition.model, reasoningEffort: definition.reasoningEffort, baseUrl: definition.baseUrl, authMode: definition.authMode, authState: "configured", authReadiness: { status: "ready", code: null, hint: null }, baseUrlConfigured: true, isolationState: "enforced" }], prepareRuntimeLaunch: (instanceId, request) => ({ definition, installation, executablePath: installation.executablePath, args: ["exec", "--model", definition.model, "-"], env: { HOME: "/isolated/codex-review/home", OPENAI_API_KEY: "resolved-only-in-daemon" }, cwd: request.cwd, prompt: request.prompt }), runtimeLaunch: (input) => { intentWasDurable = makeTaskEventStore({ repoId: "runtime-spawn", rootDir: root }).read().events.some((candidate) => candidate.type === "runtime_dispatch_requested"); launched = input; return { pid: 123, onExit: () => undefined, terminate: () => undefined }; } });
      try {
        const receipt = await cell.spawnRuntime({ runtimeInstanceId: "codex-review", cwd: { scope: "repo-root" }, prompt: "Inspect the repository", taskId: null, idempotencyKey: "spawn-once" }, { actor: { principal: { personId: "person-spawn" }, executor: null }, source: "local" });
        assert.equal(receipt.outcome, "applied");
        assert.equal(intentWasDurable, true); assert.deepEqual(launched, { definition, installation, executablePath: "/opt/witnessed/codex", args: ["exec", "--model", "gpt-5.6-sol", "-"], env: { HOME: "/isolated/codex-review/home", OPENAI_API_KEY: "resolved-only-in-daemon" }, cwd: canonicalRoot(root), prompt: "Inspect the repository" });
        const events = makeTaskEventStore({ repoId: "runtime-spawn", rootDir: root }).read().events, observed = events.find((candidate) => candidate.type === "runtime_installation_observed"), dispatch = events.find((candidate) => candidate.type === "runtime_dispatch_requested"), started = events.find((candidate) => candidate.type === "runtime_session_started");
        assert.equal(observed?.type === "runtime_installation_observed" && observed.payload.installationId, definition.installationId); assert.equal(observed?.type === "runtime_installation_observed" && observed.payload.version, installation.version); assert.equal(events.indexOf(observed!), 0); assert.equal(events.indexOf(dispatch!), 1);
        assert.equal(dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.instanceId, definition.instanceId); assert.equal(dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.installationId, definition.installationId); assert.deepEqual(dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.definitionSnapshot, definition);
        assert.equal(started?.type === "runtime_session_started" && started.payload.instanceId, definition.instanceId); assert.equal(started?.type === "runtime_session_started" && started.payload.installationId, definition.installationId); assert.equal(started?.type === "runtime_session_started" && started.payload.definitionSnapshotRef, dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.definitionSnapshotRef);
        const overview = await cell.read("repo.agentRuntime.overview", {});
        const session = overview.sessions.find((candidate) => candidate.runtimeSessionId === receipt.runtimeSessionId); assert.equal(session?.instanceId, definition.instanceId); assert.deepEqual(session?.definitionSnapshot, definition);
        await assert.rejects(cell.spawnRuntime({ kindId: "codex", installationId: "installation-codex", profileId: "default", cwd: { scope: "repo-root" }, prompt: "Legacy", taskId: null, idempotencyKey: "legacy" }, { actor: { principal: { personId: "person-spawn" }, executor: null }, source: "local" }), (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_runtime_spawn");
      } finally { await cell.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
});
test("runtime spawn maps the GUI Claude kind to a canonical claude-compatible installation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-spawn-claude-"));
    try {
      git(root, "init", "-q"); git(root, "config", "user.name", "Spawn Test"); git(root, "config", "user.email", "spawn@example.invalid"); git(root, "commit", "--allow-empty", "-qm", "base");
      const claudeDefinition: AgentDefinitionSnapshot = { ...definition, instanceId: "claude-review", installationId: "installation-claude", kindId: "claude", providerId: "anthropic", model: "claude-fable-5", reasoningEffort: null, baseUrl: null, authMode: "subscription" };
      const claudeInstallation: RuntimeInstallationWitness = { installationId: claudeDefinition.installationId, kindId: claudeDefinition.kindId, executablePath: "/opt/witnessed/claude", version: "1.0.0", observedAt: "2026-08-14T00:00:00.000Z" }; let executablePath: string | undefined;
      const cell = await openRepoCell({ repoId: workspaceId("runtime-spawn-claude"), rootDir: canonicalRoot(root), ownerId: "spawn-test", runtimeInstances: () => [], prepareRuntimeLaunch: (_instanceId, request) => ({ definition: claudeDefinition, installation: claudeInstallation, executablePath: claudeInstallation.executablePath, args: ["-p", "--model", claudeDefinition.model], env: { HOME: "/isolated/claude-review/home" }, cwd: request.cwd, prompt: request.prompt }), runtimeLaunch: (input) => { executablePath = input.executablePath; return { pid: 124, onExit: () => undefined, terminate: () => undefined }; } });
      try {
        const receipt = await cell.spawnRuntime({ runtimeInstanceId: "claude-review", cwd: { scope: "repo-root" }, prompt: "Inspect the repository", taskId: null, idempotencyKey: "spawn-claude-once" }, { actor: { principal: { personId: "person-spawn" }, executor: null }, source: "local" });
        assert.equal(receipt.outcome, "applied"); assert.equal(executablePath, "/opt/witnessed/claude");
      } finally { await cell.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("daemon ingress preserves executor-scoped task-bound runtime spawn", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-spawn-ingress-")), root = path.join(parent, "repo"), userRoot = path.join(parent, "user"), executablePath = path.join(parent, "codex-stub.mjs"), repoId = "runtime-spawn-ingress", uid = 4301;
  initIngressRepo(root, uid); registerDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
  writeFileSync(executablePath, `#!${process.execPath}\nprocess.exit(0);\n`); chmodSync(executablePath, 0o755);
  const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: uid, source: "unix-socket-filesystem-owner-boundary" } } as const;
  const ingressDefinition = { ...definition, authMode: "subscription" as const }, ingressInstallation = { ...installation, executablePath };
  const host = await openDaemonHost({ daemonId: "runtime-spawn-ingress", userRoot, runtimeDiscover: () => [ingressInstallation], runtimeLaunch: () => ({ pid: 4310, onExit: () => undefined, terminate: () => undefined }) });
  try {
    host.runtimeInstance("daemon.runtimeInstance.create", { instanceId: ingressDefinition.instanceId, name: "Codex Review", kindId: ingressDefinition.kindId, installationId: ingressDefinition.installationId, providerId: ingressDefinition.providerId, model: ingressDefinition.model, reasoningEffort: ingressDefinition.reasoningEffort, authMode: ingressDefinition.authMode }, auth);
    await t.test("matching agent executor writes the task and execution join", async () => {
      const taskId = "task-runtime-agent", executionId = "exec-runtime-agent", executor = { kind: "agent", id: "codex-worker" } as const;
      assert.equal((await host.run(repoId, { kind: "task-create", taskId, title: "Agent runtime" }, auth)).outcome, "applied");
      assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId, executor }, auth)).outcome, "applied");
      const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", { repo: { repoId }, payload: { runtimeInstanceId: ingressDefinition.instanceId, cwd: { scope: "repo-root" }, prompt: "Inspect the task", taskId, idempotencyKey: "agent-task-bound", executor } });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const events = makeTaskEventStore({ repoId, rootDir: root }).read().events, bound = events.find((event) => event.type === "runtime_session_task_bound" && event.payload.runtimeSessionId === receipt.runtimeSessionId);
      assert.equal(bound?.type, "runtime_session_task_bound"); assert.deepEqual(bound?.actor.executor, executor);
      assert.deepEqual(bound?.type === "runtime_session_task_bound" && { taskId: bound.payload.taskId, executionId: bound.payload.executionId }, { taskId, executionId });
      const overview = await host.read(repoId, "repo.agentRuntime.overview", {}, auth), session = overview.sessions.find((candidate) => candidate.runtimeSessionId === receipt.runtimeSessionId);
      assert.equal(session?.associations.some((association) => association.taskId === taskId && association.executionId === executionId), true);
    });
    await t.test("mismatched agent executor remains rejected", async () => {
      const taskId = "task-runtime-mismatch", executionId = "exec-runtime-mismatch", holder = { kind: "agent", id: "codex-holder" } as const, caller = { kind: "agent", id: "codex-other" } as const;
      assert.equal((await host.run(repoId, { kind: "task-create", taskId, title: "Mismatched runtime" }, auth)).outcome, "applied");
      assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId, executor: holder }, auth)).outcome, "applied");
      const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", { repo: { repoId }, payload: { runtimeInstanceId: ingressDefinition.instanceId, cwd: { scope: "repo-root" }, prompt: "Wrong executor", taskId, idempotencyKey: "agent-task-mismatch", executor: caller } });
      assert.equal(receipt.outcome, "op_rejected"); assert.equal(receipt.code, "runtime_task_lease_required");
    });
    await t.test("human lease remains task-bindable without an executor", async () => {
      const taskId = "task-runtime-human", executionId = "exec-runtime-human";
      assert.equal((await host.run(repoId, { kind: "task-create", taskId, title: "Human runtime" }, auth)).outcome, "applied");
      assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId }, auth)).outcome, "applied");
      const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", { repo: { repoId }, payload: { runtimeInstanceId: ingressDefinition.instanceId, cwd: { scope: "repo-root" }, prompt: "Inspect the human task", taskId, idempotencyKey: "human-task-bound" } });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const events = makeTaskEventStore({ repoId, rootDir: root }).read().events, bound = events.find((event) => event.type === "runtime_session_task_bound" && event.payload.runtimeSessionId === receipt.runtimeSessionId);
      assert.equal(bound?.type, "runtime_session_task_bound"); assert.equal(bound?.actor.executor, null);
      assert.deepEqual(bound?.type === "runtime_session_task_bound" && { taskId: bound.payload.taskId, executionId: bound.payload.executionId }, { taskId, executionId });
    });
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

function initIngressRepo(root: string, uid: number): void {
  mkdirSync(path.join(root, "harness"), { recursive: true }); git(root, "init", "-q"); git(root, "config", "user.name", "Spawn Test"); git(root, "config", "user.email", "spawn@example.invalid");
  writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nname: runtime-spawn-ingress\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n");
  writeFileSync(path.join(root, "harness/people.yaml"), `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "owner", displayName: "Owner", roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }] }], roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write"] }] }, null, 2)}\n`);
  git(root, "add", "harness"); git(root, "commit", "-qm", "fixture");
}
async function rpc(host: Awaited<ReturnType<typeof openDaemonHost>>, auth: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2], method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = createJsonRpcProtocolServer({ host, authContext: auth, emit: async () => undefined });
  try { await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } }); const response = await server.handle({ jsonrpc: "2.0", id: 2, method, params }); assert.ok(response && !Array.isArray(response) && "result" in response); return (response as { result: Record<string, unknown> }).result; }
  finally { server.close(); }
}
function git(root: string, ...args: string[]): void { execFileSync("git", ["-C", root, ...args]); }
