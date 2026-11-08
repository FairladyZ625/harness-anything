// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { actionDeclarations, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { createIdentitySession } from "../src/authorization-provider.ts";
import { daemonBuildStamp } from "../src/build-identity.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { readRuntimeExecutionPrincipal } from "../src/runtime-execution-principal-store.ts";
import { registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";

test(
  "remote-edge rework with an agent authorizes and records manual dispatch-review",
  { timeout: 120_000 },
  async (t) => {
    const installation = {
      installationId: "edge-review-forward-install",
      kindId: "codex" as const,
      executablePath: "/usr/bin/true",
      version: "1.0.0",
      observedAt: "2026-11-07T00:00:00.000Z",
    };
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, false, {
      runtimeDiscover: () => [installation],
    });
    const identity = createIdentitySession(f.userRoot),
      centerIdentity = await identity.center();
    await centerIdentity.provider.syncBasePolicy(centerIdentity.accessToken);
    const policyGroups = await centerIdentity.provider.readPolicyGroups(centerIdentity.accessToken),
      adminUserId = await centerIdentity.provider.findUserId(centerIdentity.accessToken, "person-one");
    assert.ok(adminUserId, "the edge operator must have a Keycloak user account");
    f.owners.keycloak.revoke(
      "person-one",
      "lease-repo",
      actionDeclarations.map((declaration) => declaration.kind),
    );
    await f.owners.keycloak.permit("person-one", "lease-repo", effectivePolicyGroupScopes(policyGroups, "contributor"));
    await centerIdentity.provider.writeGrant(
      centerIdentity.accessToken,
      { groupId: "maintainer", resource: "lease-repo", userIds: [adminUserId] },
      effectivePolicyGroupScopes(policyGroups, "maintainer"),
    );
    await centerIdentity.provider.writeGrant(
      centerIdentity.accessToken,
      { groupId: "admin", resource: "@fleet", userIds: [adminUserId] },
      effectivePolicyGroupScopes(policyGroups, "admin"),
    );
    const vertical = await f.host.run("lease-repo", { kind: "vertical-declaration-migrate" }, localAuthFixture());
    assert.equal(vertical.outcome, "applied", JSON.stringify(vertical));
    await registerFixtureRuntimeInstance(f.host, "lease-repo", localAuthFixture(), {
      instanceId: installation.installationId,
      name: "Edge review forward runtime",
      kindId: installation.kindId,
      installationId: installation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    });
    const installed = await f.host.run(
      "lease-repo",
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "edge-review-forward-worker",
          name: "Edge review forward worker",
          instructions: "Implement the edge task and record evidence.",
          runtimes: [{ type: "codex", model: "gpt-5.6-sol" }],
          instance: installation.installationId,
          role: "worker",
        },
      },
      localAuthFixture(),
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    const operatorAgent = await f.host.run(
      "lease-repo",
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "edge-review-forward-operator",
          name: "Edge review forward operator",
          instructions: "Keep the authenticated operator session available for the manual review request.",
          runtimes: [{ type: "codex", model: "gpt-5.6-sol" }],
          instance: installation.installationId,
          role: "worker",
        },
      },
      localAuthFixture(),
    );
    assert.equal(operatorAgent.outcome, "applied", JSON.stringify(operatorAgent));
    const launches: {
      readonly dispatchId: string;
      readonly env: NodeJS.ProcessEnv;
      exit?: (code: number | null) => void;
    }[] = [];
    const edge = await fleetEdgeHostFixture(t, f, {
      name: "review-forward-edge",
      runtimeDiscover: () => [installation],
      personId: "person-one",
      runtimeLaunch: (prepared, persistence) => {
        const launched = { dispatchId: persistence.dispatchId, env: prepared.env };
        launches.push(launched);
        return {
          pid: 93000 + launches.length,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            launched.exit = listener;
          },
          terminate: () => launched.exit?.(0),
        };
      },
    });
    const syncEdgeReplica = () =>
      catchUpReplica({
        ...f.peer("node-one"),
        viewRoot: edge.viewRoot,
        diskQuotaBytes: 64 * 1024 * 1024,
      });
    await syncEdgeReplica();
    await registerFixtureRuntimeInstance(edge.host, "lease-repo", localAuthFixture(), {
      instanceId: installation.installationId,
      name: "Edge review forward runtime",
      kindId: installation.kindId,
      installationId: installation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    });
    const taskId = "task-edge-review-forward",
      created = await edge.command({
        kind: "task-create",
        taskId,
        title: "Edge review forwarding",
        presetId: "docs-task",
      });
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String(
      created.packagePath ?? (created.receipt as Record<string, unknown> | undefined)?.packagePath,
    );
    assert.ok(packagePath && packagePath !== "undefined", JSON.stringify(created));
    await realizeTaskPlanFixture(
      f.repo,
      packagePath,
      (planPath) => f.host.run("lease-repo", { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
      "Edge review forwarding",
    );
    const firstExecution = "execution-edge-review-forward-0",
      started = await edge.command({ kind: "task-start", taskId, executionId: firstExecution });
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await syncEdgeReplica();
    mkdirSync(path.dirname(path.join(edge.edgeRoot, "harness", packagePath, "closeout.md")), { recursive: true });
    writeFileSync(
      path.join(edge.edgeRoot, "harness", packagePath, "closeout.md"),
      "## Summary\nFirst edge delivery.\n## Verification\nEdge fixture.\n## Residual Risk\nNone.\n## Same Mechanism Elsewhere\nReview forwarding.\n",
    );
    const firstSubmit = await edge.command({ kind: "task-submit", taskId, executionId: firstExecution });
    assert.equal(firstSubmit.outcome, "applied", JSON.stringify(firstSubmit));
    await syncEdgeReplica();
    const returned = await edge.command({
      kind: "task-rework",
      taskId,
      reason: "The owner requests another implementation pass.",
      agentId: "edge-review-forward-worker",
    });
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    await syncEdgeReplica();
    const secondExecution = "execution-edge-review-forward-1",
      secondStarted = await edge.command({ kind: "task-start", taskId, executionId: secondExecution });
    assert.equal(secondStarted.outcome, "applied", JSON.stringify(secondStarted));
    await syncEdgeReplica();
    const spawned = await edge.host.spawnRuntime(
      "lease-repo",
      {
        agentId: "edge-review-forward-worker",
        taskId,
        prompt: "Complete the rework and submit the task.",
        dispatchKey: "edge-review-forward-rework-worker",
      },
      localAuthFixture(),
    );
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    assert.ok(
      launches.some((launch) => launch.dispatchId === spawned.dispatchId),
      JSON.stringify(launches),
    );
    const workerCredential = launches.find((launch) => launch.dispatchId === spawned.dispatchId)?.env
      .HARNESS_EXECUTION_CREDENTIAL;
    assert.ok(workerCredential, "the rework worker must receive an execution credential");
    writeFileSync(
      path.join(edge.edgeRoot, "harness", packagePath, "closeout.md"),
      "## Summary\nSecond edge delivery.\n## Verification\nRework agent was selected.\n## Residual Risk\nNone.\n## Same Mechanism Elsewhere\nReview forwarding.\n",
    );
    const secondSubmit = await edge.command(
      { kind: "task-submit", taskId, executionId: secondExecution },
      workerCredential,
    );
    assert.equal(secondSubmit.outcome, "applied", JSON.stringify(secondSubmit));
    await syncEdgeReplica();
    const edgeReviewer = await f.host.run(
      "lease-repo",
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "edge-review-forward-reviewer",
          name: "Edge review forward reviewer",
          instructions: "Review the submitted edge cut.",
          runtimes: [{ type: "codex", model: "gpt-5.6-sol" }],
          instance: installation.installationId,
          role: "reviewer",
        },
      },
      localAuthFixture(),
    );
    assert.equal(edgeReviewer.outcome, "applied", JSON.stringify(edgeReviewer));
    const reviewerDefault = await f.host.run(
      "lease-repo",
      { kind: "settings-update", roles: { defaultReviewer: "edge-review-forward-reviewer" } },
      localAuthFixture(),
    );
    assert.equal(reviewerDefault.outcome, "applied", JSON.stringify(reviewerDefault));
    await syncEdgeReplica();
    const operatorSession = await edge.host.spawnRuntime(
        "lease-repo",
        {
          agentId: "edge-review-forward-operator",
          prompt: "Operator session for dispatch-review authorization.",
          dispatchKey: "edge-review-forward-operator-session",
        },
        localAuthFixture(),
      ),
      operatorSessionLaunch = launches.find((launch) => launch.dispatchId === operatorSession.dispatchId),
      operatorCredential = operatorSessionLaunch?.env.HARNESS_EXECUTION_CREDENTIAL;
    assert.equal(operatorSession.outcome, "applied", JSON.stringify(operatorSession));
    assert.ok(operatorCredential, "the logged-in operator session must retain its scoped credential");
    assert.equal(
      readRuntimeExecutionPrincipal(edge.edgeRoot, operatorCredential)?.role,
      "session",
      "the CEO request must not borrow the rework worker's implementation credential",
    );
    const operatorRpc = edge.createRpc();
    t.after(() => operatorRpc.close());
    const hello = await operatorRpc.handle({
      jsonrpc: "2.0",
      id: 30,
      method: "protocol.hello",
      params: {
        protocolVersion: currentDaemonProtocolVersion,
        buildCommit: daemonBuildStamp().commit,
        executionCredential: operatorCredential,
      },
    });
    assert.ok(hello && !Array.isArray(hello) && "result" in hello, JSON.stringify(hello));
    const manualResponse = await operatorRpc.handle({
      jsonrpc: "2.0",
      id: 31,
      method: "repo.task.run",
      params: {
        repo: { repoId: "lease-repo" },
        payload: {
          action: {
            kind: "task-dispatch-review",
            taskIds: [taskId],
            agentId: "edge-review-forward-reviewer",
          },
        },
      },
    });
    assert.ok(
      manualResponse && !Array.isArray(manualResponse) && "result" in manualResponse,
      JSON.stringify(manualResponse),
    );
    const manual = manualResponse.result as Record<string, unknown>;
    assert.ok(["pending", "already_dispatched"].includes(String(manual.outcome)), JSON.stringify(manual));
    assert.equal(
      (manual.authorizationDecision as Record<string, unknown> | undefined)?.outcome,
      "allowed",
      JSON.stringify(manual),
    );
    const taskState = await f.host.run("lease-repo", { kind: "task-show", taskId }, localAuthFixture()),
      taskSnapshot = JSON.parse(String(taskState.evidence)) as {
        readonly task?: {
          readonly reviewDispatchIntent?: { readonly executionId?: string };
        };
      };
    assert.equal(taskState.outcome, "applied", JSON.stringify(taskState));
    assert.equal(taskSnapshot.task?.reviewDispatchIntent?.executionId, secondExecution, JSON.stringify(taskSnapshot));
  },
);
