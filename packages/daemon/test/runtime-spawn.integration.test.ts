// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, type AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

const definition: AgentDefinitionSnapshot = { schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "codex-review", installationId: "installation-codex", kindId: "codex", providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", baseUrl: "https://api.example.test/", authMode: "api-key" };
const installation: RuntimeInstallationWitness = { installationId: definition.installationId, kindId: definition.kindId, executablePath: "/opt/witnessed/codex", version: "1.0.0", observedAt: "2026-08-14T00:00:00.000Z" };

test("runtime spawn publishes a canonical session and makes it visible in overview", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-spawn-"));
    try {
      git(root, "init", "-q"); git(root, "config", "user.name", "Spawn Test"); git(root, "config", "user.email", "spawn@example.invalid"); git(root, "commit", "--allow-empty", "-qm", "base");
      let launched: unknown, intentWasDurable = false;
      const cell = await openRepoCell({ repoId: workspaceId("runtime-spawn"), rootDir: canonicalRoot(root), ownerId: "spawn-test", runtimeInstances: () => [{ schemaVersion: 1, instanceId: definition.instanceId, name: "Codex Review", kindId: "codex", installationId: definition.installationId, providerId: definition.providerId, model: definition.model, reasoningEffort: definition.reasoningEffort, baseUrl: definition.baseUrl, authMode: definition.authMode, authState: "configured", baseUrlConfigured: true, isolationState: "enforced" }], prepareRuntimeLaunch: (instanceId, request) => ({ definition, installation, executablePath: installation.executablePath, args: ["exec", "--model", definition.model, "-"], env: { HOME: "/isolated/codex-review/home", OPENAI_API_KEY: "resolved-only-in-daemon" }, cwd: request.cwd, prompt: request.prompt }), runtimeLaunch: (input) => { intentWasDurable = makeTaskEventStore({ repoId: "runtime-spawn", rootDir: root }).read().events.some((candidate) => candidate.type === "runtime_dispatch_requested"); launched = input; return { pid: 123, onExit: () => undefined, terminate: () => undefined }; } });
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
function git(root: string, ...args: string[]): void { execFileSync("git", ["-C", root, ...args]); }
