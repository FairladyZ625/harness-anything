// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  actionDeclarations,
  effectivePolicyGroupScopes,
  resolveHarnessLayout,
  runtimeDefinitionSnapshotArtifact,
  sha256Bytes,
  submissionDigest,
} from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import { daemonBuildStamp } from "../src/daemon-host/build-identity.ts";
import type { FleetDescriptor } from "../src/daemon-host/fleet/command-protocol.ts";
import { openPeer } from "../src/daemon-host/fleet/peer.ts";
import { currentDaemonProtocolVersion } from "../src/daemon-host/protocol/version.ts";
import { readRuntimeExecutionPrincipal } from "../src/daemon-host/runtime-execution-principal-store.ts";
import { definition as fixtureRuntimeDefinition } from "./fixtures/runtime-ingress.ts";
import { registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";

function fixtureProbeExecutable(rootDir: string): string {
  if (process.platform !== "win32") return "/usr/bin/true";
  const binDir = path.join(rootDir, "fixture-bin");
  mkdirSync(binDir, { recursive: true });
  const stub = path.join(binDir, "codex-probe-ok.cmd");
  writeFileSync(stub, "@exit /b 0\r\n", "utf8");
  return stub;
}

test(
  "remote-edge owner rework authorizes manual dispatch-review while refusing another implementation process",
  { timeout: 120_000 },
  async (t) => {
    let probeExecutable = "/usr/bin/true";
    const installation = () => ({
      installationId: "edge-review-forward-install",
      kindId: "codex" as const,
      executablePath: probeExecutable,
      version: "1.0.0",
      observedAt: "2026-11-07T00:00:00.000Z",
    });
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, false, {
      runtimeDiscover: () => [installation()],
    });
    probeExecutable = fixtureProbeExecutable(f.root);
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
      instanceId: installation().installationId,
      name: "Edge review forward runtime",
      kindId: installation().kindId,
      installationId: installation().installationId,
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
      runtimeDiscover: () => [installation()],
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
      instanceId: installation().installationId,
      name: "Edge review forward runtime",
      kindId: installation().kindId,
      installationId: installation().installationId,
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
    const firstCut = makeTaskEventReader({ repoId: "lease-repo", rootDir: f.repo })
      .read()
      .events.findLast(
        (event) => event.type === "execution_submitted" && event.payload.execution.executionId === firstExecution,
      );
    assert.ok(firstCut?.type === "execution_submitted" && firstCut.payload.execution.submission);
    const reserved = await edge.command({
      kind: "task-rework",
      taskId,
      takeover: true,
      executionId: firstExecution,
      submissionDigest: submissionDigest(firstCut.payload.execution.submission),
      reason: "The owner requests another implementation pass.",
    });
    assert.equal(reserved.outcome, "applied", JSON.stringify(reserved));
    const returned = await edge.command({
      kind: "task-rework",
      taskId,
      reason: "Return the reserved cut for the owner's manual implementation.",
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
    const launchCount = launches.length;
    await assert.rejects(
      edge.host.spawnRuntime(
        "lease-repo",
        {
          agentId: "edge-review-forward-worker",
          taskId,
          prompt: "This duplicate rework worker must not launch.",
          dispatchKey: "edge-review-forward-duplicate-worker",
        },
        localAuthFixture(),
      ),
      { code: "runtime_task_writer_conflict", message: new RegExp(String(spawned.runtimeSessionId), "u") },
    );
    assert.equal(launches.length, launchCount);
    assert.ok(
      launches.some((launch) => launch.dispatchId === spawned.dispatchId),
      JSON.stringify(launches),
    );
    const workerCredential = launches.find((launch) => launch.dispatchId === spawned.dispatchId)?.env
      .HARNESS_EXECUTION_CREDENTIAL;
    assert.ok(workerCredential, "the rework worker must receive an execution credential");
    // Select the intended reviewer before submit can automatically claim its review seat.
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
    assert.ok(
      manual.outcome === "pending" ||
        (manual.outcome === "applied" &&
          (manual.dispatches as { readonly taskId: string; readonly outcome: string }[] | undefined)?.some(
            (step) => step.taskId === taskId && step.outcome === "already_dispatched",
          )),
      JSON.stringify(manual),
    );
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
    assert.ok(
      taskSnapshot.task?.reviewDispatchIntent?.executionId === secondExecution ||
        (taskSnapshot.task?.reviewDispatchIntent == null &&
          makeTaskEventReader({ repoId: "lease-repo", rootDir: f.repo })
            .read()
            .events.some(
              (event) =>
                event.type === "runtime_dispatch_requested" &&
                event.payload.taskId === taskId &&
                event.payload.executionId === secondExecution &&
                event.payload.role === "reviewer",
            )),
      JSON.stringify(taskSnapshot),
    );
  },
);

test(
  "staged runtime result claims survive overlapping retry re-finish and descriptor key order while rejecting unauthorized nodes with claim_not_owned",
  { timeout: 120_000 },
  async (t) => {
    let holdVerifyHuman: {
      readonly entered: () => void;
      readonly release: () => void;
      readonly wait: Promise<void>;
    } | null = null;
    let verifyHumanHookActive = false;
    const f = await fleetNodeClaimFixture(t, undefined, async (authContext) => {
      if (verifyHumanHookActive && holdVerifyHuman) {
        verifyHumanHookActive = false;
        holdVerifyHuman.entered();
        await holdVerifyHuman.wait;
      }
      return f.owners.verifyHuman(authContext);
    });
    await f.center.close();

    let ingressEntered!: () => void;
    let releaseIngress!: () => void;
    const ingressPaused = new Promise<void>((resolve) => {
      ingressEntered = resolve;
    });
    const ingressGate = new Promise<void>((resolve) => {
      releaseIngress = resolve;
    });
    let pauseFirstRuntimeDispatch = false;

    const wrappedHost: typeof f.host = {
      ...f.host,
      runtimeIngress: async (repoId, action, auth) => {
        if (pauseFirstRuntimeDispatch && action.kind === "event" && action.type === "runtime_dispatch_requested") {
          pauseFirstRuntimeDispatch = false;
          ingressEntered();
          await ingressGate;
        }
        return f.host.runtimeIngress(repoId, action, auth);
      },
    };
    const center = await f.openCenter(wrappedHost);
    const openNodePeer = async (nodeId: string) => {
      const base = f.peer(nodeId);
      const peer = await openPeer({
        port: center.port,
        ca: base.ca,
        servername: base.servername,
        nodeId: base.nodeId,
        credential: base.credential,
        readAccessToken: base.readAccessToken,
        timeoutMs: 15_000,
      });
      t.after(() => peer.close());
      return peer;
    };

    const makeDispatchEvent = (dispatchKey: string, suffix: string) => {
      const digest = createHash("sha256").update(`lease-repo\0${dispatchKey}`).digest("hex"),
        snapshot = { ...fixtureRuntimeDefinition, instanceId: `${fixtureRuntimeDefinition.instanceId}-${suffix}` },
        artifact = runtimeDefinitionSnapshotArtifact(snapshot);
      return {
        body: artifact.body,
        payload: {
          dispatchId: `dispatch_${digest.slice(0, 24)}`,
          runtimeSessionId: `runtime_${digest.slice(24, 48)}`,
          instanceId: snapshot.instanceId,
          installationId: snapshot.installationId,
          kindId: snapshot.kindId,
          dispatchKey,
          definitionSnapshotRef: artifact.ref,
          definitionSnapshot: snapshot,
          startedAt: "2026-11-25T00:00:00.000Z",
          attemptGroupId: `dispatch_${digest.slice(0, 24)}`,
          attemptIndex: 0,
        },
      };
    };

    const stageBytes = async (
      peer: Awaited<ReturnType<typeof openPeer>>,
      opId: string,
      body: string,
    ): Promise<{ readonly uploadId: string; readonly descriptor: FleetDescriptor }> => {
      const bytes = Buffer.from(body, "utf8"),
        content = { sha256: sha256Bytes(bytes), size: bytes.byteLength, mediaType: "text/plain; charset=utf-8" },
        ready = await peer.request({
          schema: "fleet.upload.begin/v1",
          messageId: peer.messageId(),
          opId,
          repoId: "lease-repo",
          content,
        });
      assert.equal(ready.schema, "fleet.upload.ready/v1", JSON.stringify(ready));
      if (ready.schema !== "fleet.upload.ready/v1") throw new Error("upload ready expected");
      if (ready.resumeOffset < bytes.byteLength) {
        const chunk = await peer.request({
          schema: "fleet.upload.chunk/v1",
          messageId: peer.messageId(),
          opId,
          uploadId: ready.uploadId,
          offset: ready.resumeOffset,
          dataBase64: bytes.subarray(ready.resumeOffset).toString("base64"),
        });
        assert.equal(chunk.schema, "fleet.upload.ready/v1", JSON.stringify(chunk));
      }
      const finished = await peer.request({
        schema: "fleet.upload.finish/v1",
        messageId: peer.messageId(),
        opId,
        uploadId: ready.uploadId,
      });
      assert.equal(finished.schema, "fleet.upload.result/v1", JSON.stringify(finished));
      if (finished.schema !== "fleet.upload.result/v1") throw new Error("upload result expected");
      return { uploadId: ready.uploadId, descriptor: finished.descriptor };
    };

    const nodeOne = await openNodePeer("node-one");
    const nodeOneRetry = await openNodePeer("node-one");
    const nodeTwo = await openNodePeer("node-two");
    const meta = await nodeOne.request({
      schema: "fleet.repo.metadata.get/v1",
      messageId: nodeOne.messageId(),
      repoId: "lease-repo",
    });
    assert.equal(meta.schema, "fleet.repo.metadata.result/v1", JSON.stringify(meta));
    if (meta.schema !== "fleet.repo.metadata.result/v1") throw new Error("metadata expected");

    // Scenario A: Attempt 1 is paused inside runtimeIngress while Attempt 2 (same opId) re-finishes
    // the staged claim ("already_staged"). Attempt 1 must not discard the re-issued claim before
    // Attempt 2 presents it — even if descriptor JSON keys arrive in a different order.
    const { body: overlapBody, payload: overlapPayload } = makeDispatchEvent("claim-race-overlap-key", "overlap");
    const overlapOpId = "op-runtime-overlap-retry";
    const { uploadId: overlapUploadId, descriptor: overlapDescriptor } = await stageBytes(
      nodeOne,
      overlapOpId,
      overlapBody,
    );
    pauseFirstRuntimeDispatch = true;
    const firstEventPromise = nodeOne.request({
      schema: "fleet.runtime.event/v1",
      messageId: nodeOne.messageId(),
      writerEpoch: meta.writerEpoch,
      repoId: "lease-repo",
      opId: overlapOpId,
      eventType: "runtime_dispatch_requested",
      payload: overlapPayload,
      result: overlapDescriptor,
      dispatchContext: { role: null, taskId: null, executionId: null, launchGeneration: 1 },
    });
    await ingressPaused;
    const reissued = await stageBytes(nodeOneRetry, overlapOpId, overlapBody);
    assert.equal(reissued.uploadId, overlapUploadId);
    releaseIngress();
    const firstEventResult = await firstEventPromise;
    assert.equal(firstEventResult.schema, "fleet.runtime.event.result/v1", JSON.stringify(firstEventResult));

    // Reorder JSON property insertion order to prove structural (key-order-independent) ownership lookup.
    const reorderedDescriptor: FleetDescriptor = {
      sha256: reissued.descriptor.sha256,
      size: reissued.descriptor.size,
      mediaType: reissued.descriptor.mediaType,
      ref: reissued.descriptor.ref,
    };
    const retryEventResult = await nodeOneRetry.request({
      schema: "fleet.runtime.event/v1",
      messageId: nodeOneRetry.messageId(),
      writerEpoch: meta.writerEpoch,
      repoId: "lease-repo",
      opId: overlapOpId,
      eventType: "runtime_dispatch_requested",
      payload: overlapPayload,
      result: reorderedDescriptor,
      dispatchContext: { role: null, taskId: null, executionId: null, launchGeneration: 1 },
    });
    assert.equal(retryEventResult.schema, "fleet.runtime.event.result/v1", JSON.stringify(retryEventResult));
    const overlapClaimFile = path.join(resolveHarnessLayout(f.repo).localRoot, "doc-sync-claims", overlapUploadId);
    assert.equal(existsSync(overlapClaimFile), false, "claim file must be discarded once the latest holder completes");

    // Scenario B: A concurrent finish paused across await readerAuth must not return a stale
    // already_staged descriptor after another request consumes and deletes the claim.
    const { body: staleBody, payload: stalePayload } = makeDispatchEvent("claim-race-stale-finish-key", "stale");
    const staleOpId = "op-runtime-stale-finish";
    const { uploadId: staleUploadId, descriptor: staleDescriptor } = await stageBytes(nodeOne, staleOpId, staleBody);
    let finishAuthEntered!: () => void;
    let releaseFinishAuth!: () => void;
    const finishAuthPaused = new Promise<void>((resolve) => {
      finishAuthEntered = resolve;
    });
    holdVerifyHuman = {
      entered: finishAuthEntered,
      release: () => releaseFinishAuth(),
      wait: new Promise<void>((resolve) => {
        releaseFinishAuth = resolve;
      }),
    };
    verifyHumanHookActive = true;
    const racingFinishPromise = nodeOneRetry
      .request({
        schema: "fleet.upload.finish/v1",
        messageId: nodeOneRetry.messageId(),
        opId: staleOpId,
        uploadId: staleUploadId,
      })
      .then(
        (frame) => ({ ok: true as const, frame }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await finishAuthPaused;
    const consumeResult = await nodeOne.request({
      schema: "fleet.runtime.event/v1",
      messageId: nodeOne.messageId(),
      writerEpoch: meta.writerEpoch,
      repoId: "lease-repo",
      opId: staleOpId,
      eventType: "runtime_dispatch_requested",
      payload: stalePayload,
      result: staleDescriptor,
      dispatchContext: { role: null, taskId: null, executionId: null, launchGeneration: 1 },
    });
    assert.equal(consumeResult.schema, "fleet.runtime.event.result/v1", JSON.stringify(consumeResult));
    holdVerifyHuman.release();
    const racingFinishOutcome = await racingFinishPromise;
    assert.equal(
      racingFinishOutcome.ok,
      false,
      `stale finish must not issue a deleted descriptor: ${JSON.stringify(racingFinishOutcome)}`,
    );
    if (!racingFinishOutcome.ok) {
      const fault = racingFinishOutcome.error as { code?: unknown; retryable?: unknown };
      assert.equal(fault.code, "upload_unknown");
      assert.equal(fault.retryable, true, "racing finish against consumed upload must be retryable");
    }

    // Scenario C (Negative ownership control): node-two presenting node-one's live staged
    // descriptor must be strictly rejected with non-retryable claim_not_owned, leaving node-one's
    // claim intact.
    const { body: ownedBody, payload: ownedPayload } = makeDispatchEvent("claim-race-ownership-control-key", "owner");
    const ownedOpId = "op-runtime-ownership-control";
    const { descriptor: nodeOneDescriptor } = await stageBytes(nodeOne, ownedOpId, ownedBody);
    await assert.rejects(
      nodeTwo.request({
        schema: "fleet.runtime.event/v1",
        messageId: nodeTwo.messageId(),
        writerEpoch: meta.writerEpoch,
        repoId: "lease-repo",
        opId: "op-node-two-hijack",
        eventType: "runtime_dispatch_requested",
        payload: ownedPayload,
        result: nodeOneDescriptor,
        dispatchContext: { role: null, taskId: null, executionId: null, launchGeneration: 1 },
      }),
      (error: unknown) => {
        const fault = error as { code?: unknown; retryable?: unknown; message?: unknown };
        assert.equal(fault.code, "claim_not_owned", String(fault.message));
        assert.equal(fault.retryable, false, "unauthorized-node claim_not_owned must never be retryable");
        return true;
      },
    );
    const ownerAccepted = await nodeOne.request({
      schema: "fleet.runtime.event/v1",
      messageId: nodeOne.messageId(),
      writerEpoch: meta.writerEpoch,
      repoId: "lease-repo",
      opId: ownedOpId,
      eventType: "runtime_dispatch_requested",
      payload: ownedPayload,
      result: nodeOneDescriptor,
      dispatchContext: { role: null, taskId: null, executionId: null, launchGeneration: 1 },
    });
    assert.equal(ownerAccepted.schema, "fleet.runtime.event.result/v1", JSON.stringify(ownerAccepted));
  },
);
