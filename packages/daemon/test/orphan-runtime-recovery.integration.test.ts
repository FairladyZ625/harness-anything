// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BuiltinPolicyAdapter, builtinAuthorityUrl } from "@harness-anything/authorization/builtin";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { appendRuntimeWorkerRecord } from "../src/daemon-host/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import type { RepoCellBinding } from "../src/daemon-host/repo-cell-types.ts";
import { policyTestRealm, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import type { RuntimeOperatorSession } from "../src/daemon-host/runtime-online-binding.ts";
import type { KeycloakCenterAuthority } from "../src/daemon-host/transport/auth-context.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { definition, initHarnessRepo, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test(
  "a rebuilt built-in RBAC can recover a stopped orphan runtime and release its exact lease",
  { timeout: 60_000 },
  async (t) => {
    const fixture = mkdtempSync(path.join(tmpdir(), "ha-orphan-runtime-")),
      repoPath = path.join(fixture, "repo"),
      repoId = workspaceId("orphan-runtime-recovery"),
      taskId = "task-orphan-runtime",
      reason = "Built-in RBAC was rebuilt during this dispatch";
    const cleanups: (() => void | Promise<void>)[] = [];
    t.after(async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
      removeTempRepository(fixture);
    });
    mkdirSync(repoPath);
    const rootDir = canonicalRoot(repoPath);
    initHarnessRepo(rootDir, repoId);
    async function createIdentity(personId: string) {
      const userRoot = path.join(fixture, personId),
        provider = new BuiltinPolicyAdapter({ userRoot }),
        owner = provider.addUser({
          personId,
          username: personId,
          email: `${personId}@example.invalid`,
          displayName: personId,
          password: "fixture-password",
        }),
        accessToken = `fixture-session-${personId}`,
        centerToken = provider.issueCenterToken(),
        authority = { url: builtinAuthorityUrl(userRoot), realm: "local", clientId: "harness-center", provider };
      provider.registerSession(accessToken, {
        personId,
        subject: owner.userId,
        expiresAt: Date.now() + 3_600_000,
        sessionExpiresAt: null,
        roles: [],
      });
      await provider.claimRepositoryOwner(centerToken, repoId, personId);
      return {
        session: { ...authority, personId, accessToken },
        center: async () => ({ ...authority, accessToken: centerToken }),
        grant: async (groupId: "maintainer" | "admin") => {
          for (const id of ["admin", "maintainer"] as const)
            await provider.writeGrant(
              centerToken,
              { groupId: id, resource: repoId, userIds: id === groupId ? [owner.userId] : [] },
              effectivePolicyGroupScopes(deriveBasePolicyGroups(), id),
            );
        },
      };
    }
    const original = await createIdentity("person-original"),
      rebuilt = await createIdentity("person-rebuilt");
    let current: { session: RuntimeOperatorSession; center: KeycloakCenterAuthority } = original;
    let child: ReturnType<typeof spawn> | undefined,
      stopped: Promise<unknown> | undefined,
      containment: Promise<unknown[]> | undefined,
      notifyExit: ((code: number) => void) | undefined;
    const actorBinding = (): RepoCellBinding => ({
      actor: { principal: { personId: current.session.personId }, executor: null },
      source: "local",
      keycloakAuthorization: { session: current.session, center: current.center },
    });
    const failedSettlement = Promise.withResolvers<void>();
    const cell = await openBootstrappedRepoCell({
      repoId,
      rootDir,
      ownerId: "orphan-runtime-test",
      ...scheduleRuntimePorts(),
      keycloakCenter: () => current.center(),
      keycloakSession: async () => current.session,
      runtimeDaemonRoute: { userRoot: fixture, daemonId: "fixture", endpoint: path.join(fixture, "daemon.sock") },
      onRuntimeSignal: (_session, signal) => {
        if (signal.type === "exit" && signal.outcome === "unknown") failedSettlement.resolve();
      },
      runtimeLaunch: () => {
        const probeModule = new URL("../src/daemon-host/runtime/process-group-reconciler.ts", import.meta.url).href,
          worker = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `import { establishRuntimeProcessGroup } from ${JSON.stringify(probeModule)};
              process.send((await establishRuntimeProcessGroup()) ?? null);
              process.stdin.resume();`,
            ],
            { detached: true, stdio: ["pipe", "ignore", "inherit", "ipc"] },
          );
        assert.ok(worker.pid);
        child = worker;
        stopped = once(worker, "exit");
        containment = once(worker, "message");
        return {
          pid: worker.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            notifyExit = listener;
          },
          terminate: () => assert.fail("administrator recovery must never signal the foreign process"),
        };
      },
    });
    cleanups.push(
      async () => cell.close(),
      async () => {
        child?.stdin?.end();
        await stopped;
      },
    );
    const created = await cell.run(
      { kind: "task-create", taskId, title: "Recover orphan lease", presetId: "docs-task" },
      actorBinding(),
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, actorBinding());
    await realizeTaskPlanFixture(
      rootDir,
      String((created as Record<string, unknown>).packagePath),
      (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, actorBinding()),
      "Recover orphan lease",
    );
    const started = await cell.run({ kind: "task-start", taskId }, actorBinding());
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const dispatched = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Wait for the fixture process to finish",
        taskId,
        dispatchKey: "orphan-runtime",
      },
      actorBinding(),
    );
    const runtimeSessionId = String(dispatched.runtimeSessionId),
      dispatchId = String(dispatched.dispatchId),
      reader = makeTaskEventReader({ repoId, rootDir }),
      cancel = (options: Record<string, string>) =>
        cell.cancelRuntime({ runtimeSessionId, ...options }, actorBinding()),
      release = (options: Record<string, unknown>) =>
        cell.run({ kind: "task-release", taskId, ...options }, actorBinding()),
      outcomes = () =>
        reader
          .read()
          .events.filter(
            (event) =>
              event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
          );
    assert.ok(child?.pid && notifyExit && stopped && containment, JSON.stringify(dispatched));
    const [containmentId] = await Promise.race([
      containment,
      stopped.then(() => assert.fail("Worker exited before reporting process-group containment.")),
    ]);
    if (process.platform === "win32") {
      assert.equal(typeof containmentId, "string");
      appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_containment", pid: child.pid, containmentId });
    }
    const originalDispatch = reader
      .read()
      .events.find((event) => event.type === "runtime_dispatch_requested" && event.payload.dispatchId === dispatchId);
    assert.equal(originalDispatch?.actor.principal.personId, original.session.personId);

    current = rebuilt;
    const [liveCancellation] = await Promise.allSettled([cancel({ reason, ruling: "Worker unreachable" })]);
    const releaseWhileLive = await release({ forceTakeover: true, reason });
    // Stop by normal child exit, then deliver the exit callback under the rebuilt identity.
    child.stdin!.end();
    await stopped;
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "process_exit",
      occurredAt: new Date().toISOString(),
      exitCode: 0,
      signal: null,
    });
    notifyExit(0);
    await failedSettlement.promise;
    assert.deepEqual(outcomes(), []);
    const before = await cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId }, actorBinding());
    assert.equal(before.session.liveness, "live");
    assert.equal(before.result, null);
    await assert.rejects(cancel({}), { code: "execution_scope_mismatch" });
    assert.equal((await release({ forceTakeover: true, reason })).code, "lease_conflict");
    assert.equal((await release({ forceTakeover: true })).code, "invalid_command");

    policyTestRealm.keycloak.account(original.session.personId);
    const bothPeople = withPolicyGroup(actorBinding(), "admin").keycloakAuthorization,
      coexistenceCenter = await bothPeople.center();
    await coexistenceCenter.provider.claimRepositoryOwner(
      coexistenceCenter.accessToken,
      repoId,
      rebuilt.session.personId,
    );
    current = bothPeople;
    const [existingOwnerCancellation] = await Promise.allSettled([cancel({ reason })]);
    current = rebuilt;
    await rebuilt.grant("maintainer");
    const [nonAdminCancellation] = await Promise.allSettled([cancel({ reason })]);
    await rebuilt.grant("admin");
    const settled = await cancel({ reason });
    assert.equal(settled.outcome, "applied", JSON.stringify(settled));
    assert.equal(releaseWhileLive.code, "lease_conflict");
    assert.equal(liveCancellation?.status, "rejected");
    if (liveCancellation?.status === "rejected")
      assert.equal(liveCancellation.reason.code, "runtime_ruling_not_allowed");
    assert.equal(existingOwnerCancellation?.status, "rejected");
    if (existingOwnerCancellation?.status === "rejected")
      assert.equal(existingOwnerCancellation.reason.code, "execution_scope_mismatch");
    assert.equal(nonAdminCancellation?.status, "rejected");
    if (nonAdminCancellation?.status === "rejected")
      assert.equal(nonAdminCancellation.reason.code, "execution_scope_mismatch");
    const [outcome] = outcomes();
    assert.ok(outcome?.type === "runtime_session_outcome_observed");
    assert.deepEqual(outcome.actor, actorBinding().actor);
    const result = outcome.payload.result;
    assert.ok(result);
    const resultBytes = reader.readContentBlob(result.sha256);
    assert.ok(resultBytes);
    assert.match(Buffer.from(resultBytes).toString("utf8"), /Built-in RBAC was rebuilt during this dispatch/u);
    const after = await cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId }, actorBinding());
    assert.equal(after.session.liveness, "exited");
    assert.equal(after.result?.ref, outcome.payload.resultRef);
    assert.deepEqual(outcome.payload.orphanRecovery, {
      originalPersonId: original.session.personId,
      adminPersonId: rebuilt.session.personId,
      reason,
    });

    assert.equal((await release({ reason })).code, "lease_conflict");
    current = bothPeople;
    assert.equal((await release({ forceTakeover: true, reason })).code, "lease_conflict");
    current = rebuilt;
    await rebuilt.grant("maintainer");
    assert.equal((await release({ forceTakeover: true, reason })).code, "lease_conflict");
    await rebuilt.grant("admin");
    const released = await release({ forceTakeover: true, reason });
    assert.equal(released.outcome, "applied", JSON.stringify(released));
    const leaseEvent = reader.read().events.find((event) => event.opId === released.opId);
    assert.ok(leaseEvent?.type === "lease_released");
    assert.deepEqual(leaseEvent.actor, actorBinding().actor);
    assert.equal(leaseEvent.payload.releasedLease.actor.principal.personId, original.session.personId);
    assert.equal(leaseEvent.payload.releasedLease.executionId, started.executionId);
    assert.match(leaseEvent.payload.mutation.reason, /Built-in RBAC was rebuilt during this dispatch/u);
    assert.equal((await cancel({ reason })).outcome, "applied");
    assert.equal(outcomes().length, 1, "a repeated cancellation must leave the accepted audit unchanged");
  },
);
