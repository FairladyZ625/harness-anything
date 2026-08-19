// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      const cell = await openRepoCell({ repoId: workspaceId("runtime-spawn"), rootDir: canonicalRoot(root), ownerId: "spawn-test", runtimeInstances: () => [{ schemaVersion: 2, instanceId: definition.instanceId, name: "Codex Review", kindId: "codex", installationId: definition.installationId, providerId: definition.providerId, models: [definition.model, "gpt-5.6-terra"], defaultModel: definition.model, enabled: true, codex: { reasoningEffort: definition.reasoningEffort, baseUrl: definition.baseUrl, baseUrlConfigured: true, wire_api: null, requires_openai_auth: null, http_headers: null }, authMode: definition.authMode, authState: "configured", authReadiness: { status: "ready", code: null, hint: null }, isolationState: "enforced" }], prepareRuntimeLaunch: (instanceId, request) => ({ definition: { ...definition, model: request.model ?? definition.model, reasoningEffort: request.effort ?? definition.reasoningEffort }, installation, executablePath: installation.executablePath, args: ["exec", "--json", "--model", request.model ?? definition.model, ...(request.effort ? ["--config", `model_reasoning_effort=${JSON.stringify(request.effort)}`] : []), "-"], env: { HOME: "/isolated/codex-review/home", OPENAI_API_KEY: "resolved-only-in-daemon" }, cwd: request.cwd, prompt: request.prompt }), runtimeLaunch: (input) => { intentWasDurable = makeTaskEventStore({ repoId: "runtime-spawn", rootDir: root }).read().events.some((candidate) => candidate.type === "runtime_dispatch_requested"); launched = input; return { pid: 123, onOutput: () => undefined, onExit: () => undefined, terminate: () => undefined }; } });
      try {
        const receipt = await cell.spawnRuntime({ runtimeInstanceId: "codex-review", cwd: { scope: "repo-root" }, prompt: "Inspect the repository", taskId: null, idempotencyKey: "spawn-once" }, { actor: { principal: { personId: "person-spawn" }, executor: null }, source: "local" });
        assert.equal(receipt.outcome, "applied");
        assert.equal(intentWasDurable, true); assert.deepEqual(launched, { definition, installation, executablePath: "/opt/witnessed/codex", args: ["exec", "--json", "--model", "gpt-5.6-sol", "-"], env: { HOME: "/isolated/codex-review/home", OPENAI_API_KEY: "resolved-only-in-daemon" }, cwd: canonicalRoot(root), prompt: "Inspect the repository" });
        const events = makeTaskEventStore({ repoId: "runtime-spawn", rootDir: root }).read().events, observed = events.find((candidate) => candidate.type === "runtime_installation_observed"), dispatch = events.find((candidate) => candidate.type === "runtime_dispatch_requested"), started = events.find((candidate) => candidate.type === "runtime_session_started");
        assert.equal(observed?.type === "runtime_installation_observed" && observed.payload.installationId, definition.installationId); assert.equal(observed?.type === "runtime_installation_observed" && observed.payload.version, installation.version); assert.equal(events.indexOf(observed!), 0); assert.equal(events.indexOf(dispatch!), 1);
        assert.equal(dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.instanceId, definition.instanceId); assert.equal(dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.installationId, definition.installationId); assert.deepEqual(dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.definitionSnapshot, definition);
        assert.equal(started?.type === "runtime_session_started" && started.payload.instanceId, definition.instanceId); assert.equal(started?.type === "runtime_session_started" && started.payload.installationId, definition.installationId); assert.equal(started?.type === "runtime_session_started" && started.payload.definitionSnapshotRef, dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.definitionSnapshotRef);
        const overview = await cell.read("repo.agentRuntime.overview", {});
        const session = overview.sessions.find((candidate) => candidate.runtimeSessionId === receipt.runtimeSessionId); assert.equal(session?.instanceId, definition.instanceId); assert.deepEqual(session?.definitionSnapshot, definition);
        const alternate = await cell.spawnRuntime({ runtimeInstanceId: "codex-review", model: "gpt-5.6-terra", cwd: { scope: "repo-root" }, prompt: "Inspect with alternate model", taskId: null, idempotencyKey: "spawn-terra" }, { actor: { principal: { personId: "person-spawn" }, executor: null }, source: "local" });
        assert.equal(alternate.outcome, "applied"); assert.deepEqual(launched, { definition: { ...definition, model: "gpt-5.6-terra" }, installation, executablePath: "/opt/witnessed/codex", args: ["exec", "--json", "--model", "gpt-5.6-terra", "-"], env: { HOME: "/isolated/codex-review/home", OPENAI_API_KEY: "resolved-only-in-daemon" }, cwd: canonicalRoot(root), prompt: "Inspect with alternate model" });
        const low = await cell.spawnRuntime({ runtimeInstanceId: "codex-review", effort: "low", cwd: { scope: "repo-root" }, prompt: "Mechanical task", taskId: null, idempotencyKey: "spawn-low" }, { actor: { principal: { personId: "person-spawn" }, executor: null }, source: "local" });
        assert.equal(low.outcome, "applied"); assert.deepEqual(launched, { definition: { ...definition, reasoningEffort: "low" }, installation, executablePath: "/opt/witnessed/codex", args: ["exec", "--json", "--model", "gpt-5.6-sol", "--config", "model_reasoning_effort=\"low\"", "-"], env: { HOME: "/isolated/codex-review/home", OPENAI_API_KEY: "resolved-only-in-daemon" }, cwd: canonicalRoot(root), prompt: "Mechanical task" });
        const xhigh = await cell.spawnRuntime({ runtimeInstanceId: "codex-review", effort: "xhigh", cwd: { scope: "repo-root" }, prompt: "Hard task", taskId: null, idempotencyKey: "spawn-xhigh" }, { actor: { principal: { personId: "person-spawn" }, executor: null }, source: "local" });
        assert.equal(xhigh.outcome, "applied"); assert.deepEqual(launched, { definition: { ...definition, reasoningEffort: "xhigh" }, installation, executablePath: "/opt/witnessed/codex", args: ["exec", "--json", "--model", "gpt-5.6-sol", "--config", "model_reasoning_effort=\"xhigh\"", "-"], env: { HOME: "/isolated/codex-review/home", OPENAI_API_KEY: "resolved-only-in-daemon" }, cwd: canonicalRoot(root), prompt: "Hard task" }); const current = (await cell.read("repo.agentRuntime.overview", {})).instances[0]; assert.equal(current?.kindId, "codex"); if (current?.kindId === "codex") assert.equal(current.codex.reasoningEffort, "high");
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
      const cell = await openRepoCell({ repoId: workspaceId("runtime-spawn-claude"), rootDir: canonicalRoot(root), ownerId: "spawn-test", runtimeInstances: () => [], prepareRuntimeLaunch: (_instanceId, request) => ({ definition: claudeDefinition, installation: claudeInstallation, executablePath: claudeInstallation.executablePath, args: ["-p", "--verbose", "--output-format", "stream-json", "--model", claudeDefinition.model], env: { HOME: "/isolated/claude-review/home" }, cwd: request.cwd, prompt: request.prompt }), runtimeLaunch: (input) => { executablePath = input.executablePath; return { pid: 124, onOutput: () => undefined, onExit: () => undefined, terminate: () => undefined }; } });
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
  const host = await openDaemonHost({ daemonId: "runtime-spawn-ingress", userRoot, runtimeDiscover: () => [ingressInstallation], runtimeLaunch: () => ({ pid: 4310, onOutput: (listener) => { queueMicrotask(() => listener(`${JSON.stringify({ type: "thread.started", thread_id: "provider-task-session" })}\n`)); }, onExit: () => undefined, terminate: () => undefined }) });
  await host.attachmentsSettled();
  try {
    host.runtimeInstance("daemon.runtimeInstance.create", { instanceId: ingressDefinition.instanceId, name: "Codex Review", kindId: ingressDefinition.kindId, installationId: ingressDefinition.installationId, providerId: ingressDefinition.providerId, model: ingressDefinition.model, codex: { reasoningEffort: ingressDefinition.reasoningEffort }, authMode: ingressDefinition.authMode }, auth);
    await t.test("matching agent executor writes the task and execution join", async () => {
      const taskId = "task-runtime-agent", executionId = "exec-runtime-agent", executor = { kind: "agent", id: "codex-worker" } as const;
      assert.equal((await host.run(repoId, { kind: "task-create", taskId, title: "Agent runtime" }, auth)).outcome, "applied");
      assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId, executor }, auth)).outcome, "applied");
      const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", { repo: { repoId }, payload: { runtimeInstanceId: ingressDefinition.instanceId, cwd: { scope: "repo-root" }, prompt: "Inspect the task", taskId, idempotencyKey: "agent-task-bound", executor } });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const bound = await eventuallyValue(async () => makeTaskEventStore({ repoId, rootDir: root }).read().events.find((event) => event.type === "runtime_session_task_bound" && event.payload.runtimeSessionId === receipt.runtimeSessionId) ?? null);
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
      const bound = await eventuallyValue(async () => makeTaskEventStore({ repoId, rootDir: root }).read().events.find((event) => event.type === "runtime_session_task_bound" && event.payload.runtimeSessionId === receipt.runtimeSessionId) ?? null);
      assert.equal(bound?.type, "runtime_session_task_bound"); assert.equal(bound?.actor.executor, null);
      assert.deepEqual(bound?.type === "runtime_session_task_bound" && { taskId: bound.payload.taskId, executionId: bound.payload.executionId }, { taskId, executionId });
    });
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("daemon ingress persists scrubbed provider JSONL while returning canonical results for both runtime kinds", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-provider-events-")), root = path.join(parent, "repo"), userRoot = path.join(parent, "user"), repoId = "runtime-provider-events", uid = 4302;
  initIngressRepo(root, uid); registerDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
  const installations = (["claude", "codex"] as const).map((kindId) => { const executablePath = path.join(parent, `${kindId}-stub.mjs`); writeProviderStub(executablePath, kindId); return { installationId: `installation-${kindId}`, kindId, executablePath, version: "1.0.0", observedAt: "2026-08-19T00:00:00.000Z" } as const; });
  const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: uid, source: "unix-socket-filesystem-owner-boundary" } } as const, host = await openDaemonHost({ daemonId: "runtime-provider-events", userRoot, runtimeDiscover: () => installations });
  await host.attachmentsSettled();
  try {
    for (const kindId of ["claude", "codex"] as const) host.runtimeInstance("daemon.runtimeInstance.create", { instanceId: `${kindId}-provider`, name: `${kindId} provider`, kindId, installationId: `installation-${kindId}`, providerId: kindId === "claude" ? "anthropic" : "openai", model: `${kindId}-model`, authMode: "subscription" }, auth);
    for (const kindId of ["claude", "codex"] as const) await t.test(kindId, async () => {
      const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", { repo: { repoId }, payload: { runtimeInstanceId: `${kindId}-provider`, cwd: { scope: "repo-root" }, prompt: `Run ${kindId}`, taskId: null, idempotencyKey: `${kindId}-provider-events` } });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt)); const frames: Record<string, unknown>[] = [], attached = await rpcAttach(host, auth, repoId, String(receipt.runtimeSessionId), frames);
      try { await eventually(async () => frames.some((frame) => frame.type === "activity" && frame.activity === "message" && frame.content === `${kindId} live content`));
        const read = await eventuallyValue(async () => { const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", { repo: { repoId }, payload: { runtimeSessionId: receipt.runtimeSessionId } }); return value.result ? value : null; });
        assert.equal((read.session as Record<string, unknown>).providerSessionId, `${kindId}-provider-session`); assert.deepEqual((read.session as { activity: unknown }).activity, { lastObservedAt: (read.session as { activity: { lastObservedAt: string } }).activity.lastObservedAt, outcome: "succeeded", exitCode: 0, resultRef: (read.result as Record<string, unknown>).ref });
        assert.deepEqual(read.result, { ref: (read.result as Record<string, unknown>).ref, text: `${kindId} final result` }); assert.match(String((read.result as Record<string, unknown>).ref), /^artifact:runtime-result\/sha256\/[0-9a-f]{64}$/u);
        const streamPath = path.join(root, ".harness", "runtime", "dispatches", `${receipt.dispatchId}.jsonl`), stream = await eventuallyValue(() => { try { return readFileSync(streamPath, "utf8"); } catch { return null; } });
        assert.match(stream, /"kind":"provider_event"/u); if (kindId === "codex") { assert.doesNotMatch(stream, /credentialRef|executablePath|apiToken|sk-provider-secret|\/provider\/private/u); }
        const outcome = makeTaskEventStore({ repoId, rootDir: root }).read().events.find((event) => event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === receipt.runtimeSessionId); assert.equal(outcome?.type, "runtime_session_outcome_observed");
        if (outcome?.type === "runtime_session_outcome_observed") assert.equal(Buffer.from(makeTaskEventStore({ repoId, rootDir: root }).readContentBlob(outcome.payload.result.sha256)!).toString("utf8"), `${kindId} final result`);
      } finally { attached.close(); }
    });
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("daemon ingress resumes the same provider session for Claude and Codex", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-resume-")), root = path.join(parent, "repo"), userRoot = path.join(parent, "user"), repoId = "runtime-resume", uid = 4303;
  initIngressRepo(root, uid); registerDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
  const launches: { readonly kindId: string; readonly args: readonly string[] }[] = [], installations = ( ["claude", "codex"] as const).map((kindId) => { const executablePath = path.join(parent, `${kindId}-resume-stub.mjs`); writeProviderStub(executablePath, kindId); return { installationId: `installation-${kindId}`, kindId, executablePath, version: "1.0.0", observedAt: "2026-08-19T00:00:00.000Z" } as const; });
  const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: uid, source: "unix-socket-filesystem-owner-boundary" } } as const, host = await openDaemonHost({ daemonId: "runtime-resume", userRoot, runtimeDiscover: () => installations, runtimeLaunch: (prepared) => { const kindId = prepared.definition.kindId, resumed = prepared.args.includes("--resume") || prepared.args.includes("resume"), providerSessionId = kindId === "claude" ? "claude-resume-session" : "codex-resume-session"; launches.push({ kindId, args: prepared.args }); const output = kindId === "claude" ? [{ type: "system", subtype: "init", session_id: providerSessionId }, { type: "assistant", session_id: providerSessionId, message: { content: [{ type: "text", text: resumed ? "claude second turn" : "claude first turn" }] } }, { type: "result", subtype: "success", is_error: false, session_id: providerSessionId, result: resumed ? "claude second result" : "claude first result" }] : [{ type: "thread.started", thread_id: providerSessionId }, { type: "item.completed", item: { id: "resume-item", type: "agent_message", text: resumed ? "codex second turn" : "codex first turn" } }, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]; return { pid: 4400 + launches.length, onOutput: (listener) => { queueMicrotask(() => output.forEach((frame) => listener(`${JSON.stringify(frame)}\n`))); }, onExit: (listener) => { queueMicrotask(() => listener(0)); }, terminate: () => undefined }; } });
  try {
    for (const kindId of ["claude", "codex"] as const) await t.test(kindId, async () => {
      const definition = { instanceId: `${kindId}-resume`, name: `${kindId} resume`, kindId, installationId: `installation-${kindId}`, providerId: kindId === "claude" ? "anthropic" : "openai", model: `${kindId}-model`, authMode: "subscription" };
      host.runtimeInstance("daemon.runtimeInstance.create", definition, auth);
      const first = await rpc(host, auth, "repo.agentRuntime.spawn", { repo: { repoId }, payload: { runtimeInstanceId: definition.instanceId, cwd: { scope: "repo-root" }, prompt: "First turn", taskId: null, idempotencyKey: `${kindId}-resume-first` } }); assert.equal(first.outcome, "applied", JSON.stringify(first));
      await eventually(async () => makeTaskEventStore({ repoId, rootDir: root }).read().events.some((event) => event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === first.runtimeSessionId));
      const providerSessionId = kindId === "claude" ? "claude-resume-session" : "codex-resume-session", second = await rpc(host, auth, "repo.agentRuntime.spawn", { repo: { repoId }, payload: { runtimeInstanceId: definition.instanceId, cwd: { scope: "repo-root" }, prompt: "Second turn", providerSessionId, taskId: null, idempotencyKey: `${kindId}-resume-second` } });
      await eventually(async () => makeTaskEventStore({ repoId, rootDir: root }).read().events.some((event) => event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === second.runtimeSessionId));
      const read = await rpc(host, auth, "repo.agentRuntime.sessions.read", { repo: { repoId }, payload: { runtimeSessionId: second.runtimeSessionId } });
      assert.equal((read.session as Record<string, unknown>).providerSessionId, providerSessionId); assert.equal((read.result as Record<string, unknown>).text, kindId === "claude" ? "claude second result" : "codex second turn");
      const secondLaunch = launches.findLast((launch) => launch.kindId === kindId)!; if (kindId === "claude") assert.deepEqual(secondLaunch.args.slice(-2), ["--resume", providerSessionId]); else { assert.deepEqual(secondLaunch.args.slice(0, 2), ["exec", "resume"]); assert.equal(secondLaunch.args.at(-2), providerSessionId); }
    });
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("daemon ingress cancellation is explicit and idempotent for an active runtime", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-cancel-")), root = path.join(parent, "repo"), userRoot = path.join(parent, "user"), executablePath = path.join(parent, "cancel-stub.mjs"), repoId = "runtime-cancel", uid = 4304;
  initIngressRepo(root, uid); registerDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false }); writeProviderStub(executablePath, "codex"); const installation = installationFixture("codex", executablePath);
  const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: uid, source: "unix-socket-filesystem-owner-boundary" } } as const, host = await openDaemonHost({ daemonId: "runtime-cancel", userRoot, runtimeDiscover: () => [installation], runtimeLaunch: () => ({ pid: 4501, onOutput: () => undefined, onExit: () => undefined, terminate: () => undefined }) });
  try {
    const definition = { instanceId: "codex-cancel", name: "codex cancel", kindId: "codex" as const, installationId: installation.installationId, providerId: "openai", model: "codex-model", authMode: "subscription" as const }; host.runtimeInstance("daemon.runtimeInstance.create", definition, auth);
    const spawned = await rpc(host, auth, "repo.agentRuntime.spawn", { repo: { repoId }, payload: { runtimeInstanceId: definition.instanceId, cwd: { scope: "repo-root" }, prompt: "Keep running", taskId: null, idempotencyKey: "cancel-active" } }); assert.equal(spawned.outcome, "applied", JSON.stringify(spawned)); const frames: Record<string, unknown>[] = [], attached = await rpcAttach(host, auth, repoId, String(spawned.runtimeSessionId), frames);
    try {
      const cancelled = await rpc(host, auth, "repo.agentRuntime.cancel", { repo: { repoId }, payload: { runtimeSessionId: spawned.runtimeSessionId } }); assert.equal(cancelled.outcome, "applied"); assert.equal(cancelled.command, "runtime-cancel");
      const read = await eventuallyValue(async () => { const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", { repo: { repoId }, payload: { runtimeSessionId: spawned.runtimeSessionId } }); return (value.session as Record<string, unknown>).liveness === "exited" ? value : null; }); assert.equal((read.session as Record<string, unknown>).activity && ((read.session as Record<string, unknown>).activity as Record<string, unknown>).outcome, "cancelled"); await eventually(() => frames.some((frame) => frame.type === "exit" && frame.outcome === "cancelled"));
      const events = makeTaskEventStore({ repoId, rootDir: root }).read().events.filter((event) => "runtimeSessionId" in event.payload && event.payload.runtimeSessionId === spawned.runtimeSessionId); assert.equal(events.some((event) => event.type === "runtime_session_cancelled"), true); const repeat = await rpc(host, auth, "repo.agentRuntime.cancel", { repo: { repoId }, payload: { runtimeSessionId: spawned.runtimeSessionId } }); assert.equal(repeat.outcome, "applied"); assert.equal(repeat.detail, "already-exited"); const missing = await rpc(host, auth, "repo.agentRuntime.cancel", { repo: { repoId }, payload: { runtimeSessionId: "runtime_missing" } }); assert.equal(missing.outcome, "applied");
    } finally { attached.close(); }
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
async function rpcAttach(host: Awaited<ReturnType<typeof openDaemonHost>>, auth: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2], repoId: string, runtimeSessionId: string, frames: Record<string, unknown>[]): Promise<{ readonly close: () => void }> {
  const server = createJsonRpcProtocolServer({ host, authContext: auth, emit: async (_method, params) => { frames.push(params); } });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } }); const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "repo.agentRuntime.attach", params: { repo: { repoId }, payload: { runtimeSessionId, afterCursor: "stream:0" } } }); assert.ok(response && !Array.isArray(response) && "result" in response); assert.equal((response as { result: { ok: boolean } }).result.ok, true, JSON.stringify(response)); return { close: server.close };
}
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> { await eventuallyValue(async () => await check() ? true : null); }
async function eventuallyValue<T>(read: () => T | null | Promise<T | null>): Promise<T> { for (let attempt = 0; attempt < 100; attempt += 1) { const value = await read(); if (value !== null) return value; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("runtime provider event did not arrive"); }
function writeProviderStub(target: string, kindId: "claude" | "codex"): void { const lines = kindId === "claude"
  ? [{ type: "system", subtype: "init", session_id: "claude-provider-session" }, { type: "assistant", session_id: "claude-provider-session", message: { content: [{ type: "text", text: "claude live content" }] } }, { type: "result", subtype: "success", is_error: false, session_id: "claude-provider-session", result: "claude final result" }]
  : [{ type: "thread.started", thread_id: "codex-provider-session" }, { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "codex live content", credentialRef: "credential-secret", executablePath: "/provider/private", apiToken: "sk-provider-secret" } }, { type: "item.completed", item: { id: "item-2", type: "agent_message", text: "codex final result" } }, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]; const structuredFlag = kindId === "claude" ? `process.argv.includes("--output-format") && process.argv.includes("stream-json") && process.argv.includes("--verbose")` : `process.argv[2] === "exec" && process.argv.includes("--json")`;
  writeFileSync(target, `#!${process.execPath}\nconst auth = process.argv[2] === "auth" || process.argv[2] === "login";\nif (auth) process.exit(0);\nif (!(${structuredFlag})) process.exit(9);\nconst lines = ${JSON.stringify(lines)};\nlines.forEach((line, index) => setTimeout(() => console.log(JSON.stringify(line)), index * 40));\n`); chmodSync(target, 0o755); }
function installationFixture(kindId: "claude" | "codex", executablePath: string): RuntimeInstallationWitness { return { installationId: `installation-${kindId}`, kindId, executablePath, version: "1.0.0", observedAt: "2026-08-19T00:00:00.000Z" }; }
function git(root: string, ...args: string[]): void { execFileSync("git", ["-C", root, ...args]); }
