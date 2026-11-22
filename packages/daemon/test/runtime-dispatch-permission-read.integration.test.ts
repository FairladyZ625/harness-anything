// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalEventWritePlan,
  resolveHarnessLayout,
  type AgentDefinitionSnapshot,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel";
import { makeTaskEventStore } from "@harness-anything/storage";
import { validateAgentRuntimeSession } from "../src/daemon-host/agent-runtime-contract.ts";
import type { RuntimeInstallationWitness, RuntimeInstanceSummary } from "../src/daemon-host/agent-runtime-instances.ts";
import { daemonBuildStamp } from "../src/daemon-host/build-identity.ts";
import { createJsonRpcProtocolServer } from "../src/daemon-host/protocol/json-rpc-server.ts";
import {
  canonicalRoot,
  validateDaemonTaskDispatches,
  workspaceId,
} from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import {
  validDispatchLifecycleSummary,
  validTaskDispatchAttempt,
} from "../src/daemon-host/protocol/daemon-protocol-validate-relation-query.ts";
import { currentDaemonProtocolVersion } from "../src/daemon-host/protocol/version.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import {
  fixtureFence,
  openBootstrappedRepoCell as openRepoCell,
  setFixtureAgentBinding,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args]);
}

function initGitRepo(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.name", "Permission Test");
  git(root, "config", "user.email", "perm-test@example.invalid");
  writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "base");
}

function makeInstance(
  instanceId: string,
  permissionMode: "read-only" | "workspace-write" | "bypass" | null,
): RuntimeInstanceSummary {
  return {
    schemaVersion: 2,
    instanceId,
    name: `Codex ${instanceId}`,
    kindId: "codex",
    installationId: "installation-codex",
    providerId: "openai",
    models: ["gpt-5.6-sol"],
    defaultModel: "gpt-5.6-sol",
    enabled: true,
    permissionMode,
    authMode: "subscription",
    authState: "authenticated",
    authReadiness: { status: "ready", code: null, hint: null },
    isolationState: "enforced",
    configuration: {},
  };
}

function makeDefinition(instanceId: string): AgentDefinitionSnapshot {
  return {
    schema: "agent-definition-snapshot/v1",
    configVersion: 1,
    instanceId,
    installationId: "installation-codex",
    kindId: "codex",
    providerId: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    endpointKind: "official",
    baseUrlHash: null,
    authMode: "subscription",
  };
}

async function installOrUpdateAgent(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  owner: ReturnType<typeof withPolicyGroup>,
  id: string,
  instanceId: string,
  permissionMode?: "read-only" | "workspace-write" | "bypass",
): Promise<void> {
  setFixtureAgentBinding(cell.status().rootDir, id, instanceId);
  const res = await cell.run(
    {
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id,
        name: `Agent ${id}`,
        instructions: "Follow task contract.",
        runtimes: [{ type: "codex", model: "gpt-5.6-sol" }],
        ...(permissionMode === undefined ? {} : { permissionMode }),
      },
    },
    owner,
  );
  assert.equal(res.outcome, "applied", JSON.stringify(res));
  await waitForFixturePublication(cell, res.opId, owner);
}

async function rpcCall(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  repoId: string,
  method: "repo.agentRuntime.sessions.read" | "repo.task.dispatches",
  payload: Record<string, unknown>,
  auth: {
    readonly transportKind: "unix-socket";
    readonly personId?: string;
    readonly policyGroups?: readonly string[];
  } = { transportKind: "unix-socket", personId: "person-owner", policyGroups: ["admin"] },
): Promise<Record<string, unknown>> {
  const server = createJsonRpcProtocolServer({
    host: {
      read: (
        requestedRepoId: string,
        requestedMethod: string,
        requestedPayload: Record<string, unknown>,
        binding: unknown,
      ) => {
        if (requestedRepoId !== repoId) {
          throw Object.assign(new Error(`Unknown repository ${requestedRepoId}`), { code: "unknown_repo" });
        }
        return cell.read(requestedMethod as never, requestedPayload as never, binding as never);
      },
      remoteProxy: { route: () => false },
    } as never,
    build: daemonBuildStamp(),
    authContext: auth as never,
    emit: async () => undefined,
  });
  try {
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion, buildCommit: daemonBuildStamp().commit },
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "protocol.dispatchLifecycle.enable",
      params: {},
    });
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method,
      params: { repo: { repoId }, payload },
    });
    assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
    return (response as { result: Record<string, unknown> }).result;
  } finally {
    server.close();
  }
}

test("effective permission mode and source are snapshotted at admission across all 4 sources, survive config mutation and restart, and reject cross-scope reads", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-perm-read-"));
  const repoId = workspaceId("perm-read");
  const owner = withPolicyGroup(
    { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
    "admin",
  );
  const installation: RuntimeInstallationWitness = {
    installationId: "installation-codex",
    kindId: "codex",
    executablePath: "/opt/witnessed/codex",
    version: "1.0.0",
    observedAt: "2026-11-18T00:00:00.000Z",
  };

  let mutableInstanceModes: Record<string, "read-only" | "workspace-write" | "bypass" | null> = {
    "inst-dispatch": "bypass",
    "inst-agent": "bypass",
    "inst-instance": "read-only",
    "inst-default": null,
  };
  let mutableAgentModes: Record<string, "read-only" | "workspace-write" | "bypass" | undefined> = {
    "agent-dispatch": "workspace-write",
    "agent-agent": "workspace-write",
    "agent-instance": undefined,
    "agent-default": undefined,
  };

  const openConfiguredCell = () =>
    openRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: "perm-read-owner",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user-root"),
        daemonId: "perm-test",
        endpoint: path.join(root, ".daemon.sock"),
      },
      runtimeInstances: () => [
        makeInstance("inst-dispatch", mutableInstanceModes["inst-dispatch"]!),
        makeInstance("inst-agent", mutableInstanceModes["inst-agent"]!),
        makeInstance("inst-instance", mutableInstanceModes["inst-instance"]!),
        makeInstance("inst-default", mutableInstanceModes["inst-default"]!),
      ],
      prepareRuntimeLaunch: (instanceId, request) => ({
        definition: makeDefinition(instanceId),
        installation,
        protocolFamily: "codex",
        executablePath: installation.executablePath,
        args: ["exec", "--json", "-"],
        env: { OPENAI_API_KEY: "sk-secret-do-not-expose" },
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: () => ({
        pid: 124,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    });

  try {
    initGitRepo(root);
    let cell = await openConfiguredCell();
    try {
      await installOrUpdateAgent(cell, owner, "agent-dispatch", "inst-dispatch", mutableAgentModes["agent-dispatch"]);
      await installOrUpdateAgent(cell, owner, "agent-agent", "inst-agent", mutableAgentModes["agent-agent"]);
      await installOrUpdateAgent(cell, owner, "agent-instance", "inst-instance", mutableAgentModes["agent-instance"]);
      await installOrUpdateAgent(cell, owner, "agent-default", "inst-default", mutableAgentModes["agent-default"]);
      const cases = [
        {
          taskId: "task-perm-dispatch",
          agentId: "agent-dispatch",
          explicitPermissionMode: "read-only" as const,
          expectedEffective: "read-only" as const,
          expectedRequested: "read-only" as const,
          expectedSource: "dispatch" as const,
        },
        {
          taskId: "task-perm-agent",
          agentId: "agent-agent",
          explicitPermissionMode: undefined,
          expectedEffective: "workspace-write" as const,
          expectedRequested: null,
          expectedSource: "agent" as const,
        },
        {
          taskId: "task-perm-instance",
          agentId: "agent-instance",
          explicitPermissionMode: undefined,
          expectedEffective: "read-only" as const,
          expectedRequested: null,
          expectedSource: "instance" as const,
        },
        {
          taskId: "task-perm-default",
          agentId: "agent-default",
          explicitPermissionMode: undefined,
          expectedEffective: "bypass" as const,
          expectedRequested: null,
          expectedSource: "default" as const,
        },
      ];

      const dispatched: Array<(typeof cases)[number] & { dispatchId: string; runtimeSessionId: string }> = [];

      for (const entry of cases) {
        const created = await cell.run(
          { kind: "task-create", taskId: entry.taskId, title: `Task ${entry.taskId}` },
          owner,
        );
        assert.equal(created.outcome, "applied", JSON.stringify(created));
        await waitForFixturePublication(cell, created.opId, owner);
        await realizeTaskPlanFixture(
          canonicalRoot(root),
          String((created as Record<string, unknown>).packagePath),
          async (planPath: string) => {
            const sub = await cell.run({ kind: "doc-submit", paths: [planPath] }, owner);
            if (sub.outcome === "applied") await waitForFixturePublication(cell, sub.opId, owner);
            return sub;
          },
        );
        const started = await cell.run(
          { kind: "task-start", taskId: entry.taskId, executionId: `exe-${entry.taskId}` },
          owner,
        );
        assert.equal(started.outcome, "applied", JSON.stringify(started));
        await waitForFixturePublication(cell, started.opId, owner);

        const receipt = await cell.spawnRuntime(
          {
            agentId: entry.agentId,
            taskId: entry.taskId,
            cwd: { scope: "repo-root" },
            prompt: `Run ${entry.taskId}`,
            dispatchKey: `key-${entry.taskId}`,
            ...(entry.explicitPermissionMode === undefined ? {} : { permissionMode: entry.explicitPermissionMode }),
          },
          owner,
        );
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        dispatched.push({
          ...entry,
          dispatchId: String(receipt.dispatchId),
          runtimeSessionId: String(receipt.runtimeSessionId),
        });
      }

      const verifyReads = async (activeCell: Awaited<ReturnType<typeof openRepoCell>>, label: string) => {
        for (const item of dispatched) {
          const sessionRead = await rpcCall(activeCell, repoId, "repo.agentRuntime.sessions.read", {
            runtimeSessionId: item.runtimeSessionId,
          });
          assert.deepEqual(validateAgentRuntimeSession(sessionRead), [], `${label} session valid`);
          const sessionDto = sessionRead.session as Record<string, any>;
          assert.equal(sessionDto.runtimeSessionId, item.runtimeSessionId, label);
          assert.equal(sessionDto.effectivePermissionMode, item.expectedEffective, `${label} ${item.taskId} session`);
          assert.equal(
            sessionDto.requestedPermissionMode,
            item.expectedRequested,
            `${label} ${item.taskId} session req`,
          );
          assert.equal(sessionDto.permissionModeSource, item.expectedSource, `${label} ${item.taskId} session src`);
          assert.equal(sessionDto.lifecycle?.dispatchId, item.dispatchId, label);
          assert.equal(sessionDto.lifecycle?.effectivePermissionMode, item.expectedEffective, label);
          assert.equal(sessionDto.lifecycle?.requestedPermissionMode, item.expectedRequested, label);
          assert.equal(sessionDto.lifecycle?.permissionModeSource, item.expectedSource, label);
          assert.equal(validDispatchLifecycleSummary(sessionDto.lifecycle), true, label);
          assert.equal(sessionDto.attemptChain?.attempts?.[0]?.dispatchId, item.dispatchId, label);
          assert.equal(sessionDto.attemptChain?.attempts?.[0]?.runtimeSessionId, item.runtimeSessionId, label);
          assert.equal(sessionDto.attemptChain?.attempts?.[0]?.effectivePermissionMode, item.expectedEffective, label);
          assert.equal(sessionDto.attemptChain?.attempts?.[0]?.requestedPermissionMode, item.expectedRequested, label);
          assert.equal(sessionDto.attemptChain?.attempts?.[0]?.permissionModeSource, item.expectedSource, label);
          assert.equal(validTaskDispatchAttempt(sessionDto.attemptChain?.attempts?.[0]), true, label);
          assert.equal(JSON.stringify(sessionRead).includes("sk-secret-do-not-expose"), false, "no secrets in session");

          const dispatchesRead = await rpcCall(activeCell, repoId, "repo.task.dispatches", { taskId: item.taskId });
          assert.deepEqual(validateDaemonTaskDispatches(dispatchesRead), [], `${label} dispatches valid`);
          const row = (dispatchesRead.dispatches as Array<Record<string, any>>)[0]!;
          assert.equal(row.dispatchId, item.dispatchId, label);
          assert.equal(row.runtimeSessionId, item.runtimeSessionId, label);
          assert.equal(row.taskId, item.taskId, label);
          assert.equal(row.executionId, `exe-${item.taskId}`, label);
          assert.equal(row.effectivePermissionMode, item.expectedEffective, `${label} ${item.taskId} row`);
          assert.equal(row.requestedPermissionMode, item.expectedRequested, `${label} ${item.taskId} row req`);
          assert.equal(row.permissionModeSource, item.expectedSource, `${label} ${item.taskId} row src`);
          assert.equal(row.lifecycle?.effectivePermissionMode, item.expectedEffective, label);
          assert.equal(JSON.stringify(dispatchesRead).includes("sk-secret-do-not-expose"), false, "no secrets in row");
        }
      };

      await verifyReads(cell, "initial");

      // Mutate agent and instance permission configurations after admission: historical dispatches must not change.
      mutableInstanceModes = {
        "inst-dispatch": "read-only",
        "inst-agent": "read-only",
        "inst-instance": "bypass",
        "inst-default": "workspace-write",
      };
      mutableAgentModes = {
        "agent-dispatch": "bypass",
        "agent-agent": "bypass",
        "agent-instance": "bypass",
        "agent-default": "read-only",
      };
      await installOrUpdateAgent(cell, owner, "agent-dispatch", "inst-dispatch", mutableAgentModes["agent-dispatch"]);
      await installOrUpdateAgent(cell, owner, "agent-agent", "inst-agent", mutableAgentModes["agent-agent"]);
      await installOrUpdateAgent(cell, owner, "agent-instance", "inst-instance", mutableAgentModes["agent-instance"]);
      await installOrUpdateAgent(cell, owner, "agent-default", "inst-default", mutableAgentModes["agent-default"]);
      await verifyReads(cell, "after-config-mutation");

      // Cross-scope refusal check via RPC server.
      const unauthServer = createJsonRpcProtocolServer({
        host: {
          read: (
            requestedRepoId: string,
            requestedMethod: string,
            requestedPayload: Record<string, unknown>,
            binding: unknown,
          ) => {
            if (requestedRepoId !== repoId) {
              throw Object.assign(new Error(`Unknown repository ${requestedRepoId}`), { code: "unknown_repo" });
            }
            return cell.read(requestedMethod as never, requestedPayload as never, binding as never);
          },
          remoteProxy: { route: () => false },
        } as never,
        build: daemonBuildStamp(),
        authContext: { transportKind: "unix-socket", personId: "person-owner", policyGroups: ["admin"] } as never,
        emit: async () => undefined,
      });
      try {
        await unauthServer.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "protocol.hello",
          params: { protocolVersion: currentDaemonProtocolVersion, buildCommit: daemonBuildStamp().commit },
        });
        const crossScope = await unauthServer.handle({
          jsonrpc: "2.0",
          id: 2,
          method: "repo.task.dispatches",
          params: { repo: { repoId: "other-unauthorized-repo" }, payload: { taskId: "task-perm-agent" } },
        });
        assert.ok(crossScope && !Array.isArray(crossScope) && "result" in crossScope);
        assert.equal((crossScope.result as Record<string, unknown>).ok, false);
        assert.equal((crossScope.result as Record<string, unknown>).code, "unknown_repo");
      } finally {
        unauthServer.close();
      }

      // Close cell, wipe projection SQLite to force cold rebuild on restart, then reopen and verify immutability.
      await cell.close();
      rmSync(path.join(resolveHarnessLayout(root).localRoot, "projections"), { recursive: true, force: true });
      cell = await openConfiguredCell();
      await verifyReads(cell, "after-restart-cold-rebuild");
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("historical runtime_dispatch_requested without permission fields projects as unknown even when current config sets modes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-perm-historical-"));
  const repoId = workspaceId("perm-historical");
  try {
    initGitRepo(root);
    const fence = fixtureFence(
      repoId,
      canonicalRoot(root),
      path.join(resolveHarnessLayout(root).localRoot, "fixture-writer-epochs"),
    );
    const setupCell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: "perm-historical-owner",
      defaultWriterEpochFence: fence,
      runtimeInstances: () => [makeInstance("inst-hist", "workspace-write")],
    });
    const owner = withPolicyGroup(
      { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
      "admin",
    );
    try {
      await installOrUpdateAgent(setupCell, owner, "agent-hist", "inst-hist", "bypass");
      const createdHist = await setupCell.run({ kind: "task-create", taskId: "task-hist", title: "Historical" }, owner);
      assert.equal(createdHist.outcome, "applied", JSON.stringify(createdHist));
      await waitForFixturePublication(setupCell, createdHist.opId, owner);
      await realizeTaskPlanFixture(
        canonicalRoot(root),
        String((createdHist as Record<string, unknown>).packagePath),
        async (planPath: string) => {
          const sub = await setupCell.run({ kind: "doc-submit", paths: [planPath] }, owner);
          if (sub.outcome === "applied") await waitForFixturePublication(setupCell, sub.opId, owner);
          return sub;
        },
      );
      const startedHist = await setupCell.run(
        { kind: "task-start", taskId: "task-hist", executionId: "exe-hist" },
        owner,
      );
      assert.equal(startedHist.outcome, "applied", JSON.stringify(startedHist));
      await waitForFixturePublication(setupCell, startedHist.opId, owner);
    } finally {
      await setupCell.close();
    }

    const store = makeTaskEventStore({
      repoId,
      rootDir: canonicalRoot(root),
      writerFence: () => fence,
    });
    const stream = store.read();
    const def = makeDefinition("inst-hist");
    const historicalEvent: AgentRuntimeEventV1 = {
      schema: "agent-runtime-event/v1",
      eventId: "event-hist-dispatch-1",
      workspaceRevision: stream.revision + 1,
      opId: "op-hist-dispatch-1",
      actor: { principal: { personId: "person-owner" }, executor: null },
      source: "local",
      occurredAt: "2026-08-01T00:00:00.000Z",
      type: "runtime_dispatch_requested",
      payload: {
        dispatchId: "dispatch_a1b2c3d4e5f6a1b2c3d4e5f6",
        runtimeSessionId: "runtime_a1b2c3d4e5f6a1b2c3d4e5f6",
        instanceId: "inst-hist",
        installationId: "installation-codex",
        kindId: "codex",
        dispatchKey: "historical-key",
        definitionSnapshotRef: "artifact:runtime-definition/hist",
        definitionSnapshot: def,
        taskId: "task-hist",
        executionId: "exe-hist",
        attemptGroupId: "dispatch_a1b2c3d4e5f6a1b2c3d4e5f6",
        attemptIndex: 0,
        agentId: "agent-hist",
        agentName: "Agent agent-hist",
      },
    };
    const startedEvent: AgentRuntimeEventV1 = {
      schema: "agent-runtime-event/v1",
      eventId: "event-hist-start-1",
      workspaceRevision: stream.revision + 2,
      opId: "op-hist-start-1",
      actor: { principal: { personId: "person-owner" }, executor: null },
      source: "local",
      occurredAt: "2026-08-01T00:00:01.000Z",
      type: "runtime_session_started",
      payload: {
        runtimeSessionId: "runtime_a1b2c3d4e5f6a1b2c3d4e5f6",
        instanceId: "inst-hist",
        installationId: "installation-codex",
        kindId: "codex",
        definitionSnapshotRef: "artifact:runtime-definition/hist",
        launchGeneration: 1,
        attachable: false,
      },
    };
    store.append({
      event: historicalEvent,
      plan: canonicalEventWritePlan(historicalEvent, "agent-runtime/v1", historicalEvent.opId),
      blobs: [],
    });
    store.append({
      event: startedEvent,
      plan: canonicalEventWritePlan(startedEvent, "agent-runtime/v1", startedEvent.opId),
      blobs: [],
    });
    await store.drain();

    const cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: "perm-historical-owner-2",
      defaultWriterEpochFence: fence,
      runtimeInstances: () => [makeInstance("inst-hist", "workspace-write")],
    });
    try {
      const sessionRead = await rpcCall(cell, repoId, "repo.agentRuntime.sessions.read", {
        runtimeSessionId: "runtime_a1b2c3d4e5f6a1b2c3d4e5f6",
      });
      assert.deepEqual(validateAgentRuntimeSession(sessionRead), []);
      const sessionDto = sessionRead.session as Record<string, any>;
      assert.equal(sessionDto.effectivePermissionMode, "unknown");
      assert.equal(sessionDto.requestedPermissionMode, null);
      assert.equal(sessionDto.permissionModeSource, "unknown");
      assert.equal(sessionDto.lifecycle?.effectivePermissionMode, "unknown");
      assert.equal(sessionDto.attemptChain?.attempts?.[0]?.effectivePermissionMode, "unknown");
      assert.equal(sessionDto.attemptChain?.attempts?.[0]?.requestedPermissionMode, null);
      assert.equal(sessionDto.attemptChain?.attempts?.[0]?.permissionModeSource, "unknown");

      const dispatchesRead = await rpcCall(cell, repoId, "repo.task.dispatches", { taskId: "task-hist" });
      assert.equal(dispatchesRead.ok, true, JSON.stringify(dispatchesRead));
      assert.deepEqual(validateDaemonTaskDispatches(dispatchesRead), []);
      const row = (dispatchesRead.dispatches as Array<Record<string, any>>)[0]!;
      assert.equal(row.effectivePermissionMode, "unknown");
      assert.equal(row.requestedPermissionMode, null);
      assert.equal(row.permissionModeSource, "unknown");
      assert.equal(row.lifecycle?.effectivePermissionMode, "unknown");
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch overrides and scheduled Squads never exceed declared Agent permissionMode ceilings", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-perm-ceiling-"));
  const repoId = workspaceId("perm-ceiling");
  const owner = withPolicyGroup(
    { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
    "admin",
  );
  const installation: RuntimeInstallationWitness = {
    installationId: "installation-codex",
    kindId: "codex",
    executablePath: "/opt/witnessed/codex",
    version: "1.0.0",
    observedAt: "2026-11-18T00:00:00.000Z",
  };
  const preparedModes: Array<{ readonly prompt: string; readonly permissionMode: string | undefined }> = [];
  try {
    initGitRepo(root);
    const cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: "perm-ceiling-owner",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user-root"),
        daemonId: "perm-ceiling",
        endpoint: path.join(root, ".daemon.sock"),
      },
      runtimeInstances: () => [makeInstance("inst-bypass", "bypass")],
      prepareRuntimeLaunch: (instanceId, request) => {
        preparedModes.push({ prompt: request.prompt, permissionMode: request.permissionMode });
        return {
          definition: makeDefinition(instanceId),
          installation,
          protocolFamily: "codex",
          executablePath: installation.executablePath,
          args: ["exec", "--json", "-"],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      runtimeLaunch: () => ({
        pid: 125,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    });
    try {
      await installOrUpdateAgent(cell, owner, "ro-leader", "inst-bypass", "read-only");
      await installOrUpdateAgent(cell, owner, "ro-worker", "inst-bypass", "read-only");
      await installOrUpdateAgent(cell, owner, "bypass-leader", "inst-bypass", "bypass");

      const directClamped = await cell.spawnRuntime(
        {
          agentId: "ro-leader",
          cwd: { scope: "repo-root" },
          prompt: "Attempt bypass escalation on read-only agent.",
          permissionMode: "bypass",
          dispatchKey: "direct-clamped-bypass",
        },
        owner,
      );
      assert.equal(directClamped.outcome, "applied", JSON.stringify(directClamped));
      assert.equal(preparedModes.at(-1)?.permissionMode, "read-only");
      const directSession = await rpcCall(cell, repoId, "repo.agentRuntime.sessions.read", {
        runtimeSessionId: String(directClamped.runtimeSessionId),
      });
      assert.equal((directSession.session as Record<string, unknown>).effectivePermissionMode, "read-only");
      assert.equal((directSession.session as Record<string, unknown>).requestedPermissionMode, "bypass");
      assert.equal((directSession.session as Record<string, unknown>).permissionModeSource, "agent");

      for (const [squadId, leader, workers] of [
        ["ro-squad", "ro-leader", ["ro-worker"]],
        ["open-squad", "bypass-leader", ["ro-worker"]],
      ] as const) {
        const installedSquad = await cell.run(
          {
            kind: "squad-install",
            declaration: {
              schema: "squad-declaration/v1",
              id: squadId,
              name: squadId,
              leader,
              workers: [...workers],
              leaderTurnBudget: 2,
              roster: "Observe and report.",
            },
          },
          owner,
        );
        assert.equal(installedSquad.outcome, "applied", JSON.stringify(installedSquad));
      }

      const remediateSquadSchedule = await cell.run(
        {
          kind: "schedule-create",
          scheduleId: "squad-ro-remediate",
          name: "Squad RO Remediate",
          mode: "remediate",
          everyMs: 300_000,
          squadId: "ro-squad",
          mission: "Honor read-only leader ceiling in remediate.",
          idempotencyKey: "create-squad-ro-remediate",
        },
        owner,
      );
      assert.equal(remediateSquadSchedule.outcome, "applied", JSON.stringify(remediateSquadSchedule));
      const remediateStarted = await cell.run(
        { kind: "schedule-run-now", scheduleId: "squad-ro-remediate", idempotencyKey: "run-squad-ro-remediate" },
        owner,
      );
      assert.equal(remediateStarted.outcome, "applied", JSON.stringify(remediateStarted));
      assert.equal(preparedModes.at(-1)?.permissionMode, "read-only");

      const detectSquadSchedule = await cell.run(
        {
          kind: "schedule-create",
          scheduleId: "squad-bypass-detect",
          name: "Squad Bypass Detect",
          mode: "detect",
          everyMs: 300_000,
          squadId: "open-squad",
          mission: "Detect clamps bypass leader to read-only.",
          idempotencyKey: "create-squad-bypass-detect",
        },
        owner,
      );
      assert.equal(detectSquadSchedule.outcome, "applied", JSON.stringify(detectSquadSchedule));
      const detectStarted = await cell.run(
        { kind: "schedule-run-now", scheduleId: "squad-bypass-detect", idempotencyKey: "run-squad-bypass-detect" },
        owner,
      );
      assert.equal(detectStarted.outcome, "applied", JSON.stringify(detectStarted));
      assert.equal(preparedModes.at(-1)?.permissionMode, "read-only");
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
