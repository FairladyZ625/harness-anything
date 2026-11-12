// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { runtimeDefinitionSnapshotArtifact, type AgentRuntimeEventV1 } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { readDispatchStream } from "../src/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { runtimeDispatchIdentity } from "../src/task-dispatch-recovery.ts";
import { makeRuntimeSpawner } from "../src/runtime-spawner.ts";
import { definition, installation, initIngressRepo } from "./fixtures/runtime-ingress.ts";
import { policyTestRealm, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";

for (const taskBound of [false, true])
  for (const fault of ["credential issuance", "lost receipt", "unavailable acceptance"] as const)
    test(`an accepted ${taskBound ? "task" : "session"} launch handles ${fault} failure`, async (t) => {
      const root = mkdtempSync(path.join(tmpdir(), "ha-admission-failure-")),
        repoId = taskBound ? "admission-task-failure" : "admission-session-failure",
        binding = withPolicyGroup(
          {
            actor: { principal: { personId: "person-admission" }, executor: null },
            source: { kind: "node" as const, nodeId: "edge-admission" },
          },
          "admin",
        );
      policyTestRealm.keycloak.node("edge-admission", "person-admission");
      let injected = false,
        launches = 0,
        claimReleases = 0;
      const fetch = policyTestRealm.keycloak.fetch;
      t.mock.method(policyTestRealm.keycloak, "fetch", async (input, init) => {
        const url = new URL(String(input));
        if (
          fault === "credential issuance" &&
          !injected &&
          init?.method === "POST" &&
          url.pathname.endsWith("/clients") &&
          typeof init.body === "string" &&
          String(JSON.parse(init.body).clientId).startsWith("harness-execution-")
        ) {
          assert.ok(
            makeTaskEventReader({ rootDir: root, repoId })
              .read()
              .events.some((e) => e.type === "runtime_dispatch_requested"),
            "identity failure occurs after the center accepts admission",
          );
          injected = true;
          return new Response(JSON.stringify({ error: "injected_execution_issuance_failure" }), { status: 503 });
        }
        return fetch(input, init);
      });
      initIngressRepo(root, 0);
      const cell = await openBootstrappedRepoCell({
        repoId: workspaceId(repoId),
        rootDir: canonicalRoot(root),
        ownerId: repoId,
      });
      const resources: { spawner?: ReturnType<typeof makeRuntimeSpawner> } = {};
      t.after(async () => {
        await resources.spawner?.close();
        await cell.close();
        rmSync(root, { recursive: true, force: true });
      });
      let task: { taskId: string; executionId: string; packageRoot: string; claimOpId: string } | null = null;
      if (taskBound) {
        const taskId = "task-admission",
          created = await cell.run(
            { kind: "task-create", taskId, title: "Admission failure", presetId: "docs-task" },
            binding,
          );
        assert.equal(created.outcome, "applied", JSON.stringify(created));
        await waitForFixturePublication(cell, created.opId, binding);
        await realizeTaskPlanFixture(
          root,
          String(created.packagePath),
          (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, { ...binding, source: "local" }),
          "Admission failure",
        );
        const started = await cell.run({ kind: "task-start", taskId }, binding);
        assert.equal(started.outcome, "applied", JSON.stringify(started));
        task = {
          taskId,
          executionId: String(started.executionId),
          claimOpId: started.opId,
          packageRoot: path.join(root, "harness", String(created.packagePath)),
        };
      }
      const spawner = makeRuntimeSpawner({
        repoId,
        rootDir: root,
        daemonGeneration: 1,
        runtimeNode: { nodeId: "edge-admission" },
        runtimeDaemonRoute: {
          userRoot: path.join(root, ".daemon-user"),
          daemonId: repoId,
          endpoint: path.join(root, "daemon.sock"),
        },
        stream: { publish: () => undefined },
        now: () => new Date().toISOString(),
        readSettings: () => ({ runtime: { allowedInstances: [definition.instanceId] } }) as never,
        runtimeInstances: () => [
          {
            schemaVersion: 2,
            instanceId: definition.instanceId,
            name: "Admission worker",
            kindId: definition.kindId,
            installationId: definition.installationId,
            providerId: definition.providerId,
            models: [definition.model],
            defaultModel: definition.model,
            enabled: true,
            permissionMode: "workspace-write",
            codex: {},
            authMode: definition.authMode,
            authState: "configured",
            authReadiness: { status: "ready", code: null, hint: null },
            isolationState: "enforced",
          },
        ],
        prepareLaunch: async (_instance, request) => ({
          definition,
          installation,
          executablePath: installation.executablePath,
          args: [],
          env: process.env,
          cwd: request.cwd,
          prompt: request.prompt,
        }),
        launch: () => {
          launches++;
          assert.fail("an unacknowledged launch must not start a provider");
        },
        schedule: () => assert.fail("launch cleanup settles in its current turn"),
        remote: {
          executionCredential: () => assert.fail("no credential was delivered"),
          taskContext: async (_taskId, _mission, _review, onClaimed) => {
            assert.ok(task);
            onClaimed?.(async () => {
              claimReleases++;
              const released = await cell.run(
                {
                  kind: "task-release",
                  taskId: task!.taskId,
                  claimOpId: task!.claimOpId,
                  reason: "Release unadmitted test claim.",
                },
                binding,
              );
              assert.ok(["applied", "no_changes"].includes(released.outcome), JSON.stringify(released));
            });
            return {
              ...task,
              mission: () => "Handle admission failure.",
              planBody: null,
              riskTier: "low",
              riskTierFlowVersion: null,
              profileId: null,
              taskClass: "standard",
              causalContext: null,
              ownerReturnBody: null,
              continuationContext: null,
              reviewerNote: null,
              worktree: null,
            };
          },
          readRuntimeSession: async () => null,
          readRuntimeSessions: async () => [],
          readRuntimeDispatch: async () => assert.fail("a stale edge replica cannot prove admission"),
          readDispatchLifecycle: (query) => {
            if (injected && fault === "unavailable acceptance") throw new Error("injected acceptance read failure");
            return cell.readDispatchLifecycle(query);
          },
          publish: async (draft) => {
            const receipt = await cell.runtimeIngress({ kind: "event", ...draft }, binding);
            if (draft.type === "runtime_dispatch_requested" && fault !== "credential issuance") {
              injected = true;
              throw new Error("injected receipt loss after commit");
            }
            return { event: (receipt.event as unknown as AgentRuntimeEventV1) ?? null, receipt };
          },
          archive: async () => assert.fail("failed preparation is not an archive"),
        },
      });
      resources.spawner = spawner;
      await assert.rejects(
        spawner.spawn(
          {
            runtimeInstanceId: definition.instanceId,
            prompt: "Never launch",
            dispatchKey: fault,
            ...(task ? { taskId: task.taskId } : {}),
            cwd: { scope: "repo-root" },
          },
          binding,
        ),
        (error) => {
          assert.equal(injected, true, `failure reached the intended post-commit boundary: ${String(error)}`);
          return true;
        },
      );
      assert.equal(injected, true, "fault reached the post-commit boundary");
      assert.equal(launches, 0);
      const events = makeTaskEventReader({ rootDir: root, repoId }).read().events,
        dispatches = events.filter((event) => event.type === "runtime_dispatch_requested"),
        starts = events.filter((event) => event.type === "runtime_session_started"),
        outcomes = events.filter((event) => event.type === "runtime_session_outcome_observed");
      assert.equal(dispatches.length, 1, "cleanup must not invent another dispatch");
      assert.equal(starts.length, 1, "the center already accepted its session");
      if (fault === "unavailable acceptance") {
        assert.equal(outcomes.length, 0, "an unavailable center read cannot invent a settlement");
        assert.ok(readDispatchStream(root, dispatches[0]!.payload.dispatchId), "keep the accepted attempt recoverable");
        assert.equal(claimReleases, 0, "an unknown acceptance cannot release an acquired claim");
        if (task) {
          const shown = await cell.run({ kind: "task-show", taskId: task.taskId }, binding);
          assert.ok(JSON.parse(String(shown.evidence)).lease);
        }
        return;
      }
      assert.equal(outcomes.length, 1, "the admitted attempt must settle despite the missing reply");
      assert.equal(claimReleases, 0, "canonical settlement owns accepted claim release");
      if (task) {
        const shown = await cell.run({ kind: "task-show", taskId: task.taskId }, binding);
        assert.equal(JSON.parse(String(shown.evidence)).lease, null);
      }
      const lifecycle = await cell.readDispatchLifecycle({
        by: "dispatch",
        dispatchIds: [dispatches[0]!.payload.dispatchId],
      });
      assert.equal(lifecycle.status, "ready");
      if (lifecycle.status === "ready") {
        assert.equal(lifecycle.rows[0]!.attempt.stopProof, "proven_stopped");
        assert.equal(lifecycle.rows[0]!.groupPhase, "closed");
      }
    });

for (const sameOperation of [true, false])
  test(`failed issuance on reused admission keeps its provider (same op=${sameOperation})`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-reused-admission-")),
      repoId = `reused-admission-${sameOperation}`,
      binding = withPolicyGroup(
        {
          actor: { principal: { personId: "person-admission" }, executor: null },
          source: { kind: "node" as const, nodeId: "edge-admission" },
        },
        "admin",
      );
    initIngressRepo(root, 0);
    const cell = await openBootstrappedRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(root),
      ownerId: repoId,
    });
    t.after(async () => {
      await cell.close();
      rmSync(root, { recursive: true, force: true });
    });
    const artifact = runtimeDefinitionSnapshotArtifact(definition),
      identity = runtimeDispatchIdentity(repoId, "existing"),
      ingress = (opId: string) =>
        cell.runtimeIngress(
          {
            kind: "event",
            type: "runtime_dispatch_requested",
            opId,
            payload: {
              ...identity,
              instanceId: definition.instanceId,
              installationId: installation.installationId,
              kindId: definition.kindId,
              dispatchKey: "existing",
              definitionSnapshot: definition,
              definitionSnapshotRef: artifact.ref,
            },
            resultBody: artifact.body,
            dispatchContext: { role: null, taskId: null, executionId: null, launchGeneration: 1 },
          },
          binding,
        );
    assert.equal((await ingress("first-admission")).outcome, "applied");
    const bound = await cell.runtimeIngress(
      {
        kind: "event",
        type: "runtime_session_provider_bound",
        opId: "provider-bound",
        payload: {
          runtimeSessionId: identity.runtimeSessionId,
          providerSessionId: "existing-provider",
          transcriptRef: "provider:codex/existing-provider",
        },
      },
      binding,
    );
    assert.equal(bound.outcome, "applied", JSON.stringify(bound));
    let injected = false;
    const fetch = policyTestRealm.keycloak.fetch;
    t.mock.method(policyTestRealm.keycloak, "fetch", async (input, init) => {
      if (
        init?.method === "POST" &&
        new URL(String(input)).pathname.endsWith("/clients") &&
        typeof init.body === "string" &&
        String(JSON.parse(init.body).clientId).startsWith("harness-execution-")
      ) {
        injected = true;
        return new Response(JSON.stringify({ error: "injected_execution_issuance_failure" }), { status: 503 });
      }
      return fetch(input, init);
    });
    await assert.rejects(ingress(sameOperation ? "first-admission" : "another-admission"));
    assert.equal(injected, true);
    const events = makeTaskEventReader({ rootDir: root, repoId }).read().events;
    assert.equal(events.filter((event) => event.type === "runtime_dispatch_requested").length, 1);
    assert.equal(
      events.filter(
        (event) => event.type === "runtime_session_exited" || event.type === "runtime_session_outcome_observed",
      ).length,
      0,
      "an existing provider must not be settled as an unlaunched process",
    );
    const read = await cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId: identity.runtimeSessionId });
    assert.equal(read.session.providerSessionId, "existing-provider");
  });
