// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeSessionResult } from "../src/agent-runtime-contract.ts";
import { makeAgentRuntimeStreamHub } from "../src/agent-runtime-stream.ts";
import { makeRuntimeSpawner } from "../src/runtime-spawner.ts";
import { locallyObservedRuntimeSessions } from "../src/runtime-spawn-adoption.ts";
import { readObservedRuntimeSession } from "../src/agent-runtime-read.ts";
import { openDispatchStream, appendRuntimeWorkerRecord } from "../src/dispatch-stream.ts";
import type { RuntimeProcess } from "../src/runtime-spawn-types.ts";
import type { AgentDefinitionSnapshot, RuntimeSession } from "@harness-anything/kernel";
import type { RepoCellStatus } from "../src/repo-cell-types.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

test("the real writer relays completed runtime restorations before ready without relaunching models", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-adoption-ready-")),
    statuses: RepoCellStatus[] = [],
    restoredRuntimeHeartbeat = deferred<void>(),
    definition: AgentDefinitionSnapshot = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "adoption-ready-codex",
      installationId: "adoption-ready-installation",
      kindId: "codex",
      providerId: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      baseUrl: "https://api.example.test/",
      authMode: "api-key",
    },
    installation = {
      installationId: definition.installationId,
      kindId: definition.kindId,
      executablePath: "/opt/witnessed/codex",
      version: "1.0.0",
      observedAt: "2026-09-13T00:00:00.000Z",
    };
  let launches = 0,
    firstRestoringStatusAt: number | null = null,
    adoptionGate: Promise<void> | null = null,
    cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    mkdirSync(path.join(rootDir, "harness"));
    writeFileSync(
      path.join(rootDir, "harness/harness.yaml"),
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Adoption Test"],
      ["config", "user.email", "adoption@example.test"],
      ["add", "harness"],
      ["commit", "-qm", "fixture"],
    ])
      execFileSync("git", args, { cwd: rootDir, stdio: "pipe" });
    const binding = withPolicyGroup(
      { actor: { principal: { personId: "adoption-ready-operator" }, executor: null }, source: "local" as const },
      "admin",
    );
    const input = {
      repoId: workspaceId("adoption-ready"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "adoption-ready-test",
      keycloakSession: async () => {
        if (adoptionGate) await adoptionGate;
        return binding.keycloakAuthorization.session;
      },
      onStatus: (status: RepoCellStatus) => {
        statuses.push(status);
        if (status.attach?.phase === "restoring-runtimes" && status.attach.applied === 0) {
          firstRestoringStatusAt ??= Date.now();
          if (Date.now() - firstRestoringStatusAt >= 3_500) restoredRuntimeHeartbeat.resolve();
        } else if (firstRestoringStatusAt !== null && Date.now() - firstRestoringStatusAt >= 3_500)
          // Let the negative control reach the phase-order assertion instead of waiting for
          // the full watchdog window when a heartbeat regresses to opening.
          restoredRuntimeHeartbeat.resolve();
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2 as const,
          instanceId: definition.instanceId,
          name: "Adoption Ready",
          kindId: definition.kindId,
          installationId: definition.installationId,
          providerId: definition.providerId,
          models: [definition.model],
          defaultModel: definition.model,
          enabled: true,
          permissionMode: "workspace-write" as const,
          codex: {},
          authMode: definition.authMode,
          authState: "configured" as const,
          authReadiness: { status: "ready" as const, code: null, hint: null },
          isolationState: "enforced" as const,
        },
      ],
      prepareRuntimeLaunch: async (_instanceId: string, request: { cwd: string; prompt: string }) => ({
        definition,
        installation,
        executablePath: installation.executablePath,
        args: ["exec", "--json", "-"],
        env: process.env,
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      // No process record: reopening must settle the durable sessions as missing, through the real queue.
      runtimeLaunch: () => {
        launches += 1;
        return {
          pid: process.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    };
    cell = await openRepoCell(input);
    const sessions: string[] = [];
    for (const dispatchKey of ["first", "second"]) {
      const receipt = await cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "adoption ready",
          dispatchKey,
        },
        binding,
      );
      sessions.push(String(receipt.runtimeSessionId));
    }
    await cell.close();
    cell = undefined;
    statuses.length = 0;
    const releaseAdoption = deferred<void>();
    adoptionGate = releaseAdoption.promise;
    const opening = openRepoCell(input).then(
      (opened) => ({ opened }),
      (error: unknown) => ({ error }),
    );
    try {
      // The first runtime publication waits on a real worker capability. The worker's four-second
      // status heartbeat must remain in the same monotonic attach phase until that call settles.
      assert.equal(
        await Promise.race([restoredRuntimeHeartbeat.promise.then(() => "heartbeat"), opening.then(() => "ready")]),
        "heartbeat",
        "runtime adoption must remain pending while the live writer continues its startup heartbeat",
      );
    } finally {
      adoptionGate = null;
      releaseAdoption.resolve();
    }
    const result = await opening;
    if ("error" in result) throw result.error;
    cell = result.opened;
    assert.deepEqual(
      [
        ...new Set(
          statuses
            .filter((status) => status.attach?.phase === "restoring-runtimes")
            .map((status) => status.attach?.applied),
        ),
      ],
      [0, 1, 2],
    );
    const attachPhases = statuses.filter((status) => status.attach !== undefined).map((status) => status.attach!.phase),
      runtimeRestorationIndex = attachPhases.indexOf("restoring-runtimes");
    assert.ok(runtimeRestorationIndex >= 0);
    assert.ok(attachPhases.indexOf("opening") < attachPhases.indexOf("recovering"));
    assert.equal(
      attachPhases.slice(attachPhases.indexOf("recovering")).includes("opening"),
      false,
      "the real projection-complete transition must not regress to opening",
    );
    assert.equal(
      attachPhases.slice(runtimeRestorationIndex).includes("opening"),
      false,
      "projection completion must enter runtime restoration without a phase rollback",
    );
    assert.equal(cell.status().state, "attached");
    assert.equal(cell.status().attach, undefined);
    assert.equal(launches, 2);
    for (const runtimeSessionId of sessions) {
      const session = await cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId });
      // dec_614F7BBB18C8687E7EFC72173D/CH3: a missing process record has no exit evidence.
      assert.equal((session as AgentRuntimeSessionResult).session.activity.outcome, "unknown");
    }
    await cell.close();
    cell = undefined;
    statuses.length = 0;
    cell = await openRepoCell(input);
    assert.equal(
      statuses.some((status) => status.attach?.phase === "restoring-runtimes" && (status.attach.applied ?? 0) > 0),
      false,
      "terminal sessions do not settle twice",
    );
    assert.equal(launches, 2);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((settle) => (resolve = settle)), resolve };
}

test("owner adoption checks dead PID before publishing live and preserves live control when publication is offline", async () => {
  for (const alive of [false, true]) {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-adoption-owner-evidence-")),
      dispatchId = "dispatch_0123456789abcdef01234567",
      runtimeSessionId = "runtime-owner-evidence",
      pid = alive ? process.pid : 2_147_483_647,
      accepted = {
        runtimeSessionId,
        instanceId: "owner-instance",
        providerSessionId: null,
        outcome: null,
        liveness: "unknown",
        attachable: true,
        taskBindings: [],
        lastObservedAt: "2026-10-07T00:00:00Z",
      } as unknown as RuntimeSession,
      projection = {
        readRuntimeSession: () => accepted,
        readRuntimeDispatch: () => ({ payload: { dispatchId } }),
      } as never,
      hub = makeAgentRuntimeStreamHub({
        readSession: () => readObservedRuntimeSession(projection, rootDir, runtimeSessionId),
        canAttach: (session) => session.attachable && session.liveness === "live",
      }),
      published: string[] = [];
    openDispatchStream(rootDir, {
      dispatchId,
      runtimeSessionId,
      taskId: null,
      executionId: null,
      instanceId: accepted.instanceId,
      startedAt: accepted.lastObservedAt,
      dispatchOpId: "owner-dispatch",
      kindId: "codex",
      permissionMode: "read-only",
      binding: {
        actor: { principal: { personId: "owner" }, executor: null },
        source: { kind: "node", nodeId: "owner" },
      },
      cwd: rootDir,
      prompt: "Owner recovery",
      model: "test",
      reasoningEffort: null,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid });
    const runtime = makeRuntimeSpawner({
      repoId: "owner-evidence",
      rootDir,
      daemonGeneration: 2,
      runtimeNode: { nodeId: "owner" },
      now: () => accepted.lastObservedAt,
      stream: hub,
      prepareLaunch: async () => {
        throw new Error("adoption must not relaunch");
      },
      schedule: async (work) => {
        await work();
      },
      remote: {
        readRuntimeSessions: async () => [accepted],
        publish: async (draft) => {
          published.push(`${draft.type}:${String(draft.payload.liveness ?? "")}`);
          throw new Error("center unavailable");
        },
      } as never,
    });
    try {
      await assert.rejects(runtime.adopt(), /center unavailable/u);
      assert.equal(
        published.some((value) => value === "runtime_session_liveness_changed:live"),
        alive,
      );
      assert.equal(hub.attach(runtimeSessionId, "stream:0").initial.ok, alive);
      const selected = locallyObservedRuntimeSessions(
        [{ ...accepted, liveness: "live" }],
        new Map([[runtimeSessionId, { process: { pid } as RuntimeProcess }]]),
      );
      assert.equal(selected[0]!.liveness, alive ? "live" : "unknown");
      assert.equal(accepted.liveness, "unknown", "local evidence cannot mutate the canonical observation");
    } finally {
      runtime.close();
      hub.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});
