// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, type AgentRuntimeEventV1, type FrozenWritePlan } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";

const codexWitness: RuntimeInstallationWitness = { installationId: "installation-codex", kindId: "codex", executablePath: "/opt/witnessed/codex", version: "1.0.0", observedAt: "2026-08-14T00:00:00.000Z" }, claudeWitness: RuntimeInstallationWitness = { ...codexWitness, installationId: "installation-claude", kindId: "claude", executablePath: "/opt/witnessed/claude" };

test("runtime spawn publishes a canonical session and makes it visible in overview", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-spawn-"));
    try {
      git(root, "init", "-q"); git(root, "config", "user.name", "Spawn Test"); git(root, "config", "user.email", "spawn@example.invalid"); git(root, "commit", "--allow-empty", "-qm", "base");
      const store = makeTaskEventStore({ repoId: "runtime-spawn", rootDir: root }), installation = event(); store.append({ event: installation, plan: plan(installation), blobs: [] }); let launchedCredential: unknown;
      const cell = await openRepoCell({ repoId: workspaceId("runtime-spawn"), rootDir: canonicalRoot(root), ownerId: "spawn-test", runtimeCredential: () => ({ kindId: "codex", baseUrl: "https://api.example.test/", credentialRef: "keychain:harness/codex", configuredAt: "2026-08-14T00:00:00.000Z" }), runtimeInstallation: () => codexWitness, runtimeLaunch: (input) => { launchedCredential = { credential: input.credential, installation: input.installation }; return { pid: 123, onExit: () => undefined, terminate: () => undefined }; } });
      try {
        const receipt = await cell.spawnRuntime({ kindId: "codex", installationId: "installation-codex", profileId: "default", cwd: { scope: "repo-root" }, prompt: "Inspect the repository", taskId: null, idempotencyKey: "spawn-once" }, { actor: { principal: { personId: "person-spawn" }, executor: null }, source: "local" });
        assert.equal(receipt.outcome, "applied");
        assert.deepEqual(launchedCredential, { credential: { kindId: "codex", baseUrl: "https://api.example.test/", credentialRef: "keychain:harness/codex", configuredAt: "2026-08-14T00:00:00.000Z" }, installation: codexWitness });
        const overview = await cell.read("repo.agentRuntime.overview", {});
        assert.equal(overview.sessions.some((session) => session.runtimeSessionId === receipt.runtimeSessionId), true);
      } finally { await cell.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
});
test("runtime spawn maps the GUI Claude kind to a canonical claude-compatible installation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-spawn-claude-"));
    try {
      git(root, "init", "-q"); git(root, "config", "user.name", "Spawn Test"); git(root, "config", "user.email", "spawn@example.invalid"); git(root, "commit", "--allow-empty", "-qm", "base");
      const store = makeTaskEventStore({ repoId: "runtime-spawn-claude", rootDir: root }), installation = claudeEvent(); store.append({ event: installation, plan: plan(installation), blobs: [] }); let launchedKind: string | undefined;
      const cell = await openRepoCell({ repoId: workspaceId("runtime-spawn-claude"), rootDir: canonicalRoot(root), ownerId: "spawn-test", runtimeInstallation: () => claudeWitness, runtimeLaunch: (input) => { launchedKind = `${input.kindId}:${input.installation.executablePath}`; return { pid: 124, onExit: () => undefined, terminate: () => undefined }; } });
      try {
        const receipt = await cell.spawnRuntime({ kindId: "claude", installationId: "installation-claude", profileId: "default", cwd: { scope: "repo-root" }, prompt: "Inspect the repository", taskId: null, idempotencyKey: "spawn-claude-once" }, { actor: { principal: { personId: "person-spawn" }, executor: null }, source: "local" });
        assert.equal(receipt.outcome, "applied"); assert.equal(launchedKind, "claude:/opt/witnessed/claude");
      } finally { await cell.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
});
function event(): AgentRuntimeEventV1 { return { schema: "agent-runtime-event/v1", eventId: "event-install", workspaceRevision: 1, opId: "op-install", actor: { principal: { personId: "person-spawn" }, executor: null }, source: "local", occurredAt: "2026-08-14T00:00:00.000Z", type: "runtime_installation_observed", payload: { installationId: "installation-codex", kindId: "codex", protocolFamily: "codex", hostRef: "host:local", version: "1.0.0", discoverySource: "wrapper", capabilities: ["structured_witness"], authState: "configured" } }; }
function claudeEvent(): AgentRuntimeEventV1 { return { ...event(), eventId: "event-install-claude", opId: "op-install-claude", payload: { installationId: "installation-claude", kindId: "claude-compatible", protocolFamily: "claude-compatible", hostRef: "host:local", version: "1.0.0", discoverySource: "wrapper", capabilities: ["structured_witness"], authState: "configured" } }; }
function plan(value: AgentRuntimeEventV1): FrozenWritePlan { return Object.freeze({ commandType: value.type, targets: Object.freeze([{ kind: "event_file", path: `harness/events/${value.opId}.json`, operation: "create" }, { kind: "event_head", path: "harness/events/head.json", operation: "replace" }, { kind: "projection_invalidation", projection: "agent-runtime/v1", key: value.opId }].map(Object.freeze)) }) as FrozenWritePlan; }
function git(root: string, ...args: string[]): void { execFileSync("git", ["-C", root, ...args]); }
