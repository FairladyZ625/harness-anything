// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeDefinitionSnapshotArtifact } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { openRepoWriterCell } from "../src/daemon-host/repo-cell-open.ts";
import { createFleetEdgeRuntimeWorkQueue } from "../src/daemon-host/fleet-edge-runtime.ts";
import { runtimeDispatchIdentity } from "../src/daemon-host/task-dispatch-recovery.ts";
import type { DaemonLifecycleEntry } from "../src/daemon-host/lifecycle-log.ts";
import type { RuntimeOperatorSession } from "../src/daemon-host/runtime-online-binding.ts";
import { definition, initIngressRepo } from "./fixtures/runtime-ingress.ts";
import { policyTestCenter, provisionPolicyTestRepository, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { fixtureFence, seedSettingsEvent } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const operatorActor = { principal: { personId: "operator-drain" }, executor: null } as const;
const operatorBinding = { actor: operatorActor, source: "local" as const };
const authorizedOperator = withPolicyGroup(operatorBinding, "admin");

function fakeOperatorSession(): RuntimeOperatorSession {
  return {
    provider: {
      policyRef: "test-policy@1",
      authority: "test",
      deniedReasonCode: "actor_unauthorized",
      evaluate: async () => ({
        outcome: "allowed" as const,
        policyRef: "test-policy@1",
        evaluatedAtCut: "test-cut",
        reasonCode: "allowed",
      }),
      withFetchPort: function () {
        return this;
      },
    } as never,
    personId: operatorActor.principal.personId,
    accessToken: "test-access-token",
    url: "https://identity.example.invalid",
    realm: "harness",
    clientId: "harness-center",
  };
}

async function seedActiveDispatch(
  rootDir: string,
  repoId: string,
  dispatchKey: string,
): Promise<{ readonly dispatchId: string; readonly runtimeSessionId: string }> {
  provisionPolicyTestRepository(repoId);
  const identity = runtimeDispatchIdentity(repoId, dispatchKey);
  const artifact = runtimeDefinitionSnapshotArtifact(definition);
  const seedCell = await openRepoWriterCell(
    {
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(rootDir),
      ownerId: `seed-${repoId}`,
      keycloakCenter: policyTestCenter,
      defaultWriterEpochFence: fixtureFence(repoId, rootDir, path.join(rootDir, ".harness/fixture-writer-epochs")),
    },
    { close: async () => undefined } as never,
  );
  try {
    const receipt = await seedCell.runtimeIngress(
      {
        kind: "event",
        type: "runtime_dispatch_requested",
        opId: `seed-${dispatchKey}`,
        payload: {
          ...identity,
          instanceId: definition.instanceId,
          installationId: definition.installationId,
          kindId: definition.kindId,
          dispatchKey,
          definitionSnapshotRef: artifact.ref,
          definitionSnapshot: definition,
        },
        resultBody: artifact.body,
        dispatchContext: { role: null, taskId: null, executionId: null, launchGeneration: 1 },
      },
      authorizedOperator,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  } finally {
    await seedCell.close();
  }
  openDispatchStream(rootDir, {
    dispatchId: identity.dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId: identity.runtimeSessionId,
    instanceId: definition.instanceId,
    startedAt: "2026-11-23T15:00:00.000Z",
    dispatchOpId: `seed-${dispatchKey}`,
    kindId: definition.kindId,
    permissionMode: null,
    binding: operatorBinding,
    cwd: rootDir,
    prompt: "drain test",
    model: definition.model,
    reasoningEffort: null,
    fast: false,
  });
  appendRuntimeWorkerRecord(rootDir, identity.dispatchId, { kind: "process_started", pid: process.pid });
  return identity;
}

test("RepoCell.close() waits for in-flight runtime adoption recovery before closing projection (no database is not open)", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repocell-close-drain-"));
  const repoId = "repocell-close-drain";
  const unhandled: unknown[] = [];
  const lifecycleEntries: DaemonLifecycleEntry[] = [];
  const consoleErrors: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(
      args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack ?? ""}` : String(arg))).join(" "),
    );
  };
  process.on("unhandledRejection", onUnhandled);

  let releaseSession!: () => void;
  let markSessionEntered!: () => void;
  const sessionEntered = new Promise<void>((resolve) => {
    markSessionEntered = resolve;
  });
  const sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });

  try {
    initIngressRepo(rootDir, 0);
    await seedActiveDispatch(rootDir, repoId, "close-drain-key");

    const cell = await openRepoWriterCell(
      {
        repoId: workspaceId(repoId),
        rootDir: canonicalRoot(rootDir),
        ownerId: "close-drain-test",
        defaultWriterEpochFence: fixtureFence(repoId, rootDir, path.join(rootDir, ".harness/fixture-writer-epochs")),
        recordLifecycle: (entry) => lifecycleEntries.push(entry),
        keycloakSession: async () => {
          markSessionEntered();
          await sessionGate;
          return fakeOperatorSession();
        },
      },
      { close: async () => undefined } as never,
    );

    // Wait deterministically until startup setImmediate -> recoveryWork -> runtimeSpawner.adopt()
    // is mid-flight inside onlineBinding/keycloakSession, and settle initial follower work so
    // an unfixed close() cannot hide behind slow git drain before closing projection.
    await sessionEntered;
    await cell.settlePendingMaterialization?.("before-close");

    let closeResolved = false;
    const closing = cell.close().then(() => {
      closeResolved = true;
    });

    // Give the event loop a couple of turns so a buggy close() that ignores in-flight recovery finishes prematurely.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const closedBeforeRecoveryDrained = closeResolved;

    // Release the latch so the in-flight recovery attempt resumes and finishes.
    releaseSession();
    await closing;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const dbClosedLifecycleErrors = lifecycleEntries.filter(
      (entry) => "error" in entry && typeof entry.error === "string" && /database is not open/u.test(entry.error),
    );
    const dbClosedConsoleErrors = consoleErrors.filter((line) => /database is not open/u.test(line));

    assert.equal(
      closedBeforeRecoveryDrained,
      false,
      "RepoCell.close() must not close projection while startup runtime adoption recovery is still in flight",
    );
    assert.deepEqual(unhandled, [], `unexpected unhandledRejection: ${String(unhandled)}`);
    assert.deepEqual(
      dbClosedLifecycleErrors,
      [],
      `unexpected database is not open in lifecycle: ${JSON.stringify(dbClosedLifecycleErrors)}`,
    );
    assert.deepEqual(
      dbClosedConsoleErrors,
      [],
      `unexpected database is not open in console.error: ${dbClosedConsoleErrors.join("\n")}`,
    );
  } finally {
    releaseSession?.();
    console.error = originalConsoleError;
    process.off("unhandledRejection", onUnhandled);
    removeTempRepository(rootDir);
  }
});

test("RepoCell.close() drains without deadlock when in-flight recovery enters recoveryWork.write() during shutdown", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repocell-close-nodeadlock-"));
  const repoId = "repocell-close-nodeadlock";
  const unhandled: unknown[] = [];
  const consoleErrors: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  };
  process.on("unhandledRejection", onUnhandled);

  let releaseSession!: () => void;
  let markSessionEntered!: () => void;
  const sessionEntered = new Promise<void>((resolve) => {
    markSessionEntered = resolve;
  });
  const sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });

  try {
    initIngressRepo(rootDir, 0);
    await seedActiveDispatch(rootDir, repoId, "close-nodeadlock-key");

    const cell = await openRepoWriterCell(
      {
        repoId: workspaceId(repoId),
        rootDir: canonicalRoot(rootDir),
        ownerId: "close-nodeadlock-test",
        defaultWriterEpochFence: fixtureFence(repoId, rootDir, path.join(rootDir, ".harness/fixture-writer-epochs")),
        keycloakSession: async () => {
          markSessionEntered();
          await sessionGate;
          return fakeOperatorSession();
        },
      },
      { close: async () => undefined } as never,
    );

    await sessionEntered;
    const closing = cell.close();
    // Immediately release while close() is draining so recoveryWork proceeds to recoveryWork.write() -> schedule().
    releaseSession();
    await closing;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, [], `unexpected unhandledRejection: ${String(unhandled)}`);
    assert.deepEqual(
      consoleErrors.filter((line) => /database is not open/u.test(line)),
      [],
      `unexpected database is not open: ${consoleErrors.join("\n")}`,
    );
  } finally {
    releaseSession?.();
    console.error = originalConsoleError;
    process.off("unhandledRejection", onUnhandled);
    removeTempRepository(rootDir);
  }
});

test("rapid openRepoWriterCell -> close() across startup setImmediate never throws database is not open", async () => {
  const unhandled: unknown[] = [];
  const consoleErrors: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  };
  process.on("unhandledRejection", onUnhandled);

  const roots: string[] = [];
  try {
    for (let index = 0; index < 5; index += 1) {
      const rootDir = mkdtempSync(path.join(tmpdir(), `ha-repocell-rapid-${index}-`));
      roots.push(rootDir);
      initRepo(rootDir);
      const cell = await openRepoWriterCell(
        {
          repoId: workspaceId(`repocell-rapid-${index}`),
          rootDir: canonicalRoot(rootDir),
          ownerId: `rapid-${index}`,
        },
        { close: async () => undefined } as never,
      );
      if (index % 2 === 1) await new Promise<void>((resolve) => setImmediate(resolve));
      await cell.close();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], `unexpected unhandledRejection: ${String(unhandled)}`);
    assert.deepEqual(
      consoleErrors.filter((line) => /database is not open/u.test(line)),
      [],
      `unexpected database is not open: ${consoleErrors.join("\n")}`,
    );
  } finally {
    console.error = originalConsoleError;
    process.off("unhandledRejection", onUnhandled);
    for (const root of roots) removeTempRepository(root);
  }
});

test("fleet-edge workQueue.drain() awaits in-flight work after close() while skipping newly queued callbacks", async () => {
  let releaseInFlight!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseInFlight = resolve;
  });
  const ran: string[] = [];
  const queue = createFleetEdgeRuntimeWorkQueue((error) => {
    throw error;
  });

  void queue.schedule(async () => {
    ran.push("in-flight");
    markStarted();
    await gate;
    ran.push("in-flight-finished");
  });
  await started;
  void queue.schedule(() => {
    ran.push("post-close-skipped");
  });

  queue.close();
  let drained = false;
  const draining = queue.drain().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false, "drain() must wait until in-flight edge work finishes");

  releaseInFlight();
  await draining;
  assert.equal(drained, true);
  assert.deepEqual(ran, ["in-flight", "in-flight-finished"]);
});

test("seedSettingsEvent without keepOpen closes synchronously and never leaks background SQLite work into removeTempRepository", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-seed-settings-drain-"));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    initRepo(rootDir);
    seedSettingsEvent({ rootDir, repoId: "seed-settings-drain" });
    // Advance one immediate tick so any leaked detached gitFollower starts before teardown force-closes SQLite.
    await new Promise<void>((resolve) => setImmediate(resolve));
    removeTempRepository(rootDir);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, [], `unexpected unhandledRejection: ${String(unhandled)}`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    removeTempRepository(rootDir);
  }
});
