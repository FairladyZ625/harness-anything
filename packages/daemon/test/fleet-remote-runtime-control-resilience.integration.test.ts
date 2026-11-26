// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { openSqliteEventStore } from "@harness-anything/storage";
import {
  reduceRuntimeSession,
  type AgentRuntimeEventV1,
  type RuntimeSession,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { daemonBuildStamp } from "../src/daemon-host/build-identity.ts";
import { localUserDaemonEndpoint } from "../src/daemon-host/client/local-daemon-target.ts";
import { steerReceiptOpId } from "../src/daemon-host/dispatch-steer-state.ts";
import { runFleetRuntimeEventClient } from "../src/daemon-host/fleet/peer.ts";
import { waitForFleetReplicaReady } from "../src/daemon-host/fleet/replica-sync.ts";
import { createJsonRpcProtocolServer } from "../src/daemon-host/protocol/json-rpc-server.ts";
import { readRuntimeExecutionPrincipal } from "../src/daemon-host/runtime-execution-principal-store.ts";
import { requireExecutionRequestScope } from "../src/daemon-host/runtime-execution-scope.ts";
import { createUnixSocketTransportServer } from "../src/daemon-host/transport/unix-socket.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { signInAt } from "./keycloak.fixtures.ts";
import { waitForDurableCondition } from "../../../tools/fixtures/event-arrival.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import {
  allowEdgeRuntimeInstances,
  createObservableCodexProviderScript,
  git,
  readProviderTrace,
  repoId,
  setupEdgeNode,
  waitForProviderBound,
} from "./fleet-remote-runtime-control.fixture.ts";

test(
  "F11/F14/F15: Center fences controlReceipt against persisted request, rejects conflicting terminal receipts, and accepts authorized late receipts on cancelled task-bound sessions without breaking N-1 reducer",
  { timeout: process.platform === "win32" ? 240_000 : 120_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    const originRemote = path.join(f.root, "origin.git");
    git(f.root, "clone", "--bare", "-q", f.repo, originRemote);
    git(f.repo, "remote", "add", "origin", originRemote);
    git(f.repo, "fetch", "-q", "origin");
    const branch = git(f.repo, "branch", "--show-current");

    await allowEdgeRuntimeInstances(f.host);
    signInAt(f.userRoot, "person-one");
    f.owners.keycloak.permit("person-one", repoId, [
      "runtime-cancel",
      "runtime-steer",
      "repository-read",
      "task-create",
      "task-start",
    ]);
    const tracePath = path.join(f.root, "provider-trace-f15.jsonl"),
      provider = createObservableCodexProviderScript(f.root, "provider-f15", tracePath, "thread-f15-1");
    const { edge: edgeA } = await setupEdgeNode(t, f, originRemote, branch, "node-one", "edge-f15", provider);
    const localAuth = localAuthFixture();
    const edgeAPeer = {
      ...f.peer("node-one"),
      ca: readFileSync(path.join(f.root, "tls.crt")),
      repoId,
      timeoutMs: 15_000,
    };

    // Spawn a live session on Edge A and issue one genuine steer request.
    const spawned = await edgeA.host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: "node-one-codex",
        cwd: { scope: "repo-root" },
        prompt: "Worker for F15 receipt fencing",
        dispatchKey: "g8-f15-receipt-fence",
      },
      localAuth,
    );
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const sessionId = String(spawned.runtimeSessionId);
    const dispatchId = String(spawned.dispatchId);
    await waitForProviderBound(f.host, sessionId, localAuth);
    t.diagnostic("F15: session1 provider bound");

    const steer = await f.host.steerRuntime(
      repoId,
      {
        runtimeSessionId: sessionId,
        prompt: "Genuine steer for F15",
        idempotencyKey: "ctrl-f15-genuine",
      },
      localAuth,
    );
    assert.equal(steer.outcome, "applied", JSON.stringify(steer));
    const requestOpId = String(steer.opId);

    // Wait for Edge A's genuine applied receipt to land.
    await waitForDurableCondition(async () => {
      const read = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: sessionId, includeControlReceipts: true },
        localAuth,
      );
      return Boolean(
        read.session?.controlReceipts?.some(
          (rcpt) => rcpt.controlRequestId === "ctrl-f15-genuine" && rcpt.status === "applied",
        ),
      );
    });

    // F15 Negative 1: Forged receipt referencing nonexistent requestOpId must be rejected!
    await assert.rejects(
      runFleetRuntimeEventClient({
        ...edgeAPeer,
        opId: steerReceiptOpId(repoId, sessionId, "op-nonexistent-request"),
        eventType: "runtime_session_liveness_changed",
        payload: {
          runtimeSessionId: sessionId,
          liveness: "live",
          controlReceipt: {
            action: "steer",
            controlRequestId: "ctrl-forged",
            requestOpId: "op-nonexistent-request",
            status: "applied",
            dispatchId,
            steerVersion: 99,
          },
        },
      }),
      { code: "control_request_not_found" },
    );

    // F15 Negative 2: Forged receipt with wrong controlRequestId for real requestOpId must be rejected!
    await assert.rejects(
      runFleetRuntimeEventClient({
        ...edgeAPeer,
        opId: steerReceiptOpId(repoId, sessionId, requestOpId),
        eventType: "runtime_session_liveness_changed",
        payload: {
          runtimeSessionId: sessionId,
          liveness: "live",
          controlReceipt: {
            action: "steer",
            controlRequestId: "ctrl-wrong-id",
            requestOpId,
            status: "applied",
            dispatchId,
            steerVersion: 1,
          },
        },
      }),
      { code: "invalid_control_receipt" },
    );

    // F15 Negative 3: Conflicting terminal receipt (rejected after applied) for the SAME requestOpId must be rejected!
    await assert.rejects(
      runFleetRuntimeEventClient({
        ...edgeAPeer,
        opId: steerReceiptOpId(repoId, sessionId, requestOpId),
        eventType: "runtime_session_liveness_changed",
        payload: {
          runtimeSessionId: sessionId,
          liveness: "live",
          controlReceipt: {
            action: "steer",
            controlRequestId: "ctrl-f15-genuine",
            requestOpId,
            status: "rejected",
            dispatchId,
            reasonCode: "steer_dropped",
          },
        },
      }),
      { code: "control_receipt_conflict" },
    );

    // F15 Positive: Identical replay of the recorded applied receipt settles idempotently as no_changes!
    const identicalReplay = await runFleetRuntimeEventClient({
      ...edgeAPeer,
      opId: steerReceiptOpId(repoId, sessionId, requestOpId),
      eventType: "runtime_session_liveness_changed",
      payload: {
        runtimeSessionId: sessionId,
        liveness: "live",
        controlReceipt: {
          action: "steer",
          controlRequestId: "ctrl-f15-genuine",
          requestOpId,
          status: "applied",
          dispatchId,
          steerVersion: 1,
        },
      },
    });
    assert.equal(identicalReplay.receipt.outcome, "no_changes", JSON.stringify(identicalReplay));

    // Cancel sessionA and wait for terminal exit, then issue a second persisted steer BEFORE exit on a
    // real task-bound session to verify F14 + F11 post-exit late receipt handling!
    await f.host.cancelRuntime(repoId, { runtimeSessionId: sessionId }, localAuth);
    await f.host.awaitRuntimeSessions(
      repoId,
      { runtimeSessionIds: [sessionId] },
      { ...localAuth, connectionSignal: AbortSignal.timeout(30_000) },
    );

    // F14 + F11: Real task-bound session steered, cancelled, and then receives an authorized late receipt!
    const taskId = "task_f14_late_receipt";
    const created = await f.host.run(
      repoId,
      { kind: "task-create", taskId, title: "F14 task-bound late receipt", presetId: "docs-task" },
      localAuth,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String(created.packagePath);
    await realizeTaskPlanFixture(f.repo, packagePath, (planPath) =>
      f.host.run(repoId, { kind: "doc-submit", paths: [planPath] }, localAuth),
    );
    const started = await f.command("node-one", { kind: "task-start", taskId });
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const taskSpawn = await edgeA.host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: "node-one-codex",
        cwd: { scope: "repo-root" },
        taskId,
        prompt: "Task-bound worker for F14",
        dispatchKey: "g8-f14-task-bound",
      },
      localAuth,
    );
    assert.equal(taskSpawn.outcome, "applied", JSON.stringify(taskSpawn));
    const taskSessionId = String(taskSpawn.runtimeSessionId);
    await waitForProviderBound(f.host, taskSessionId, localAuth);
    await waitForProviderBound(edgeA.host, taskSessionId, localAuth);
    t.diagnostic("F14: taskSession1 provider bound");

    // Disconnect Center TLS briefly while persisting TWO steers and a cancel on Center so Edge A
    // receives them together on reconnect:
    // - By F13, cancel executes FIRST and settles the task-bound session as cancelled;
    // - By F5, cancel-superseded `taskSteer` automatically records a durable `rejected`
    //   (`reasonCode: "runtime_cancelled"`) receipt on `runtime_session_provider_bound`!
    // - We also keep a second steer request (`taskSteerLate`) persisted before cancel so we can
    //   send an authorized late `applied` receipt over TLS AFTER exit and prove Center DURABLY
    //   persists it on `runtime_session_provider_bound` (queryable via `controlReceiptRequestOpId`)
    //   with zero `runtime_session_liveness_changed` after exit and 100% N-1 reducer compatibility!
    const f14CenterPort = f.center.port;
    await f.center.close();
    const taskSteer = await f.host.steerRuntime(
      repoId,
      {
        runtimeSessionId: taskSessionId,
        prompt: "Task-bound steer superseded by cancel",
        idempotencyKey: "ctrl-f14-task-bound-steer",
      },
      localAuth,
    );
    assert.equal(taskSteer.outcome, "applied", JSON.stringify(taskSteer));
    const taskSteerOpId = String(taskSteer.opId);

    const taskSteerLate = await f.host.steerRuntime(
      repoId,
      {
        runtimeSessionId: taskSessionId,
        prompt: "Task-bound steer with late post-exit receipt",
        idempotencyKey: "ctrl-f5-late-post-exit-steer",
      },
      localAuth,
    );
    assert.equal(taskSteerLate.outcome, "applied", JSON.stringify(taskSteerLate));
    const taskSteerLateOpId = String(taskSteerLate.opId);

    await f.host.cancelRuntime(repoId, { runtimeSessionId: taskSessionId }, localAuth);
    const reopenedCenter1 = await f.openCenter(f.host, f14CenterPort);
    t.diagnostic("F14: center1 reopened, awaiting taskSession1 exit");
    await f.host.awaitRuntimeSessions(
      repoId,
      { runtimeSessionIds: [taskSessionId] },
      { ...localAuth, connectionSignal: AbortSignal.timeout(30_000) },
    );
    t.diagnostic("F14: taskSession1 exited, waiting for taskSteerOpId rejected receipt");

    // F5: Cancel-superseded steer MUST durably record a `rejected` (`runtime_cancelled`) receipt on Center!
    await waitForDurableCondition(async () => {
      const read = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: taskSessionId, controlReceiptRequestOpId: taskSteerOpId },
        localAuth,
      );
      return Boolean(
        read.session?.controlReceipts?.some(
          (rcpt) =>
            rcpt.requestOpId === taskSteerOpId && rcpt.status === "rejected" && rcpt.reasonCode === "runtime_cancelled",
        ),
      );
    });

    // Now test a direct late authorized receipt AFTER session exit on a separate exited task-bound session
    // where Edge did NOT pre-emit a receipt for `ctrl-f5-post-exit-direct`:
    // Center MUST durably persist it (`outcome: "applied"`) on `runtime_session_provider_bound`!
    const directLateSteerKey = "ctrl-f5-late-direct-after-exit";
    const taskId2 = "task_f5_late_direct";
    const created2 = await f.host.run(
      repoId,
      { kind: "task-create", taskId: taskId2, title: "F5 post-exit durable receipt", presetId: "docs-task" },
      localAuth,
    );
    assert.equal(created2.outcome, "applied", JSON.stringify(created2));
    await realizeTaskPlanFixture(f.repo, String(created2.packagePath), (planPath) =>
      f.host.run(repoId, { kind: "doc-submit", paths: [planPath] }, localAuth),
    );
    const started2 = await f.command("node-one", { kind: "task-start", taskId: taskId2 });
    assert.equal(started2.outcome, "applied", JSON.stringify(started2));
    const taskSpawn2 = await edgeA.host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: "node-one-codex",
        cwd: { scope: "repo-root" },
        taskId: taskId2,
        prompt: "Task-bound worker for post-exit direct late receipt",
        dispatchKey: "g8-f5-late-direct",
      },
      localAuth,
    );
    assert.equal(taskSpawn2.outcome, "applied", JSON.stringify(taskSpawn2));
    const taskSessionId2 = String(taskSpawn2.runtimeSessionId);
    const taskDispatchId2 = String(taskSpawn2.dispatchId);
    await waitForProviderBound(f.host, taskSessionId2, localAuth);
    await waitForProviderBound(edgeA.host, taskSessionId2, localAuth);
    t.diagnostic("F5: taskSession2 provider bound");
    // Disconnect Center, record steer on Center, close Edge A so Edge A cannot emit an early receipt,
    // settle taskSessionId2 as cancelled/exited on Center via owner ruling, reopen Center, and then send
    // the authorized late receipt AFTER exit — proving Center durably persists it on runtime_session_provider_bound!
    const f5Port2 = reopenedCenter1.port;
    await reopenedCenter1.close();
    const directLateSteer = await f.host.steerRuntime(
      repoId,
      {
        runtimeSessionId: taskSessionId2,
        prompt: "Steer whose outcome arrives after session exited",
        idempotencyKey: directLateSteerKey,
      },
      localAuth,
    );
    assert.equal(directLateSteer.outcome, "applied", JSON.stringify(directLateSteer));
    const directLateSteerOpId = String(directLateSteer.opId);
    await edgeA.close();
    const rulingCancel = await f.host.cancelRuntime(
      repoId,
      { runtimeSessionId: taskSessionId2, ruling: "edge disconnected before steer receipt arrived" },
      localAuth,
    );
    assert.equal(rulingCancel.ok, true, JSON.stringify(rulingCancel));
    await f.openCenter(f.host, f5Port2);
    await f.host.awaitRuntimeSessions(
      repoId,
      { runtimeSessionIds: [taskSessionId2] },
      { ...localAuth, connectionSignal: AbortSignal.timeout(30_000) },
    );

    const lateReceiptResult = await runFleetRuntimeEventClient({
      ...edgeAPeer,
      opId: steerReceiptOpId(repoId, taskSessionId2, directLateSteerOpId),
      eventType: "runtime_session_liveness_changed",
      payload: {
        runtimeSessionId: taskSessionId2,
        liveness: "unknown",
        controlReceipt: {
          action: "steer",
          controlRequestId: directLateSteerKey,
          requestOpId: directLateSteerOpId,
          status: "rejected",
          dispatchId: taskDispatchId2,
          reasonCode: "steer_dropped",
          message: "runtime terminated before steer acceptance",
        },
      },
    });
    assert.equal(
      lateReceiptResult.receipt.outcome,
      "applied",
      `F5: valid late receipt after exit must durably persist on runtime_session_provider_bound, got: ${JSON.stringify(lateReceiptResult)}`,
    );
    assert.equal(
      (lateReceiptResult.event as { readonly type?: string } | null)?.type,
      "runtime_session_provider_bound",
    );
    const postExitRead = await f.host.read(
      repoId,
      "repo.agentRuntime.sessions.read",
      { runtimeSessionId: taskSessionId2, controlReceiptRequestOpId: directLateSteerOpId },
      localAuth,
    );
    assert.equal(postExitRead.session?.controlReceipts?.length, 1, JSON.stringify(postExitRead));
    assert.equal(postExitRead.session?.controlReceipts?.[0]?.status, "rejected");
    assert.equal(postExitRead.session?.controlReceipts?.[0]?.reasonCode, "steer_dropped");

    // Verify zero runtime_session_liveness_changed events appear after exit in the canonical ledger
    // and frozen N-1 (bb7e55c90) reduceRuntimeSession succeeds across BOTH task-bound session histories!
    const ledger = openSqliteEventStore({ rootInput: f.repo, repoId, readOnly: true });
    try {
      for (const sid of [taskSessionId, taskSessionId2]) {
        const taskSessionEvents = ledger
          .events()
          .filter(
            (e): e is AgentRuntimeEventV1 =>
              e.schema === "agent-runtime-event/v1" &&
              "runtimeSessionId" in e.payload &&
              e.payload.runtimeSessionId === sid,
          );
        let reduced: RuntimeSession | null = null;
        let sawExited = false;
        for (const event of taskSessionEvents) {
          if (sawExited)
            assert.notEqual(
              event.type,
              "runtime_session_liveness_changed",
              `F11: session ${sid} emitted runtime_session_liveness_changed after exit (breaks bb7e55c90 N-1 reducer)`,
            );
          reduced = reduceRuntimeSession(reduced, event);
          if (reduced?.liveness === "exited") sawExited = true;
        }
        assert.equal(reduced?.outcome, sid === taskSessionId ? "cancelled" : "unknown");
      }
      assert.ok(taskSteerLateOpId.length > 0);
    } finally {
      ledger.close();
    }
  },
);

test(
  "F6 & F13: paused Edge-B replica delays real CLI retry until catch-up AND hung receipt RPC on session 1 never delays cancel on session 2",
  { timeout: process.platform === "win32" ? 240_000 : 120_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    const originRemote = path.join(f.root, "origin.git");
    git(f.root, "clone", "--bare", "-q", f.repo, originRemote);
    git(f.repo, "remote", "add", "origin", originRemote);
    git(f.repo, "fetch", "-q", "origin");
    const branch = git(f.repo, "branch", "--show-current");

    await allowEdgeRuntimeInstances(f.host);
    signInAt(f.userRoot, "person-one");
    f.owners.keycloak.permit("person-one", repoId, ["runtime-cancel", "runtime-steer", "repository-read"]);
    const tracePath1 = path.join(f.root, "provider-trace-f13-s1.jsonl"),
      provider1 = createObservableCodexProviderScript(f.root, "provider-f13-s1", tracePath1, "thread-f13-1");
    const { edge: edgeA } = await setupEdgeNode(t, f, originRemote, branch, "node-one", "edge-f13-a", provider1);
    const localAuth = localAuthFixture();

    // Spawn TWO live sessions on Edge A.
    const s1 = await edgeA.host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: "node-one-codex",
        cwd: { scope: "repo-root" },
        prompt: "Session 1 for hung receipt RPC test",
        dispatchKey: "g8-f13-session-1",
      },
      localAuth,
    );
    const s2 = await edgeA.host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: "node-one-codex",
        cwd: { scope: "repo-root" },
        prompt: "Session 2 must cancel immediately while session 1 receipt RPC hangs",
        dispatchKey: "g8-f13-session-2",
      },
      localAuth,
    );
    assert.equal(s1.outcome, "applied", JSON.stringify(s1));
    assert.equal(s2.outcome, "applied", JSON.stringify(s2));
    const session1 = String(s1.runtimeSessionId);
    const session2 = String(s2.runtimeSessionId);
    const lostRespKey = "ctrl-f6-paused-replica-retry";
    const lostRespPrompt = "F6 real CLI retry waits for paused Edge-B replica catch-up";
    await waitForProviderBound(f.host, session1, localAuth);
    await waitForProviderBound(f.host, session2, localAuth);

    // Part 1 (F13): Intercept Center `runtimeIngress` so session1's steer controlReceipt RPC HANGS on a gate!
    const origRuntimeIngress = f.host.runtimeIngress.bind(f.host);
    const origSteerRuntime = f.host.steerRuntime.bind(f.host);
    let receipt1ArrivedResolve!: () => void;
    const receipt1Arrived = new Promise<void>((resolve) => {
      receipt1ArrivedResolve = resolve;
    });
    let releaseHungReceipt1!: () => void;
    const hungReceipt1Gate = new Promise<void>((resolve) => {
      releaseHungReceipt1 = resolve;
    });
    let releaseLostFirstResponse!: () => void;
    const lostFirstResponseGate = new Promise<void>((resolve) => {
      releaseLostFirstResponse = resolve;
    });
    let firstControlRequestCommittedResolve!: () => void;
    const firstControlRequestCommitted = new Promise<void>((resolve) => {
      firstControlRequestCommittedResolve = resolve;
    });
    let retryControlRequestCommittedResolve!: () => void;
    const retryControlRequestCommitted = new Promise<void>((resolve) => {
      retryControlRequestCommittedResolve = resolve;
    });
    let retryResponseExpected = false;
    let retryResponseReceivedResolve!: () => void;
    const retryResponseReceived = new Promise<void>((resolve) => {
      retryResponseReceivedResolve = resolve;
    });
    let controlRequestCount = 0;
    let firstControlRequestReceipt: Record<string, unknown> | null = null;
    let retryControlRequestReceipt: Record<string, unknown> | null = null;
    let receipt1StillHung = true;
    (f.host as { runtimeIngress: typeof f.host.runtimeIngress }).runtimeIngress = async (
      targetRepoId,
      action,
      auth,
    ) => {
      if (
        action.kind === "event" &&
        action.payload.runtimeSessionId === session1 &&
        action.payload.controlReceipt !== undefined
      ) {
        receipt1ArrivedResolve();
        await hungReceipt1Gate;
        receipt1StillHung = false;
      }
      return origRuntimeIngress(targetRepoId, action, auth);
    };
    (f.host as { steerRuntime: typeof f.host.steerRuntime }).steerRuntime = async (targetRepoId, action, auth) => {
      const receipt = await origSteerRuntime(targetRepoId, action, auth);
      if (action.idempotencyKey === lostRespKey) {
        controlRequestCount += 1;
        if (controlRequestCount === 1) {
          firstControlRequestReceipt = receipt;
          firstControlRequestCommittedResolve();
          await lostFirstResponseGate;
        } else if (controlRequestCount === 2) {
          retryControlRequestReceipt = receipt;
          retryResponseExpected = true;
          retryControlRequestCommittedResolve();
        }
      }
      return receipt;
    };
    t.after(() => {
      releaseHungReceipt1();
      releaseLostFirstResponse();
      (f.host as { runtimeIngress: typeof f.host.runtimeIngress }).runtimeIngress = origRuntimeIngress;
      (f.host as { steerRuntime: typeof f.host.steerRuntime }).steerRuntime = origSteerRuntime;
    });

    // Steer session1 -> Edge A applies steer -> background receipt pump hits our hung Center gate!
    const steer1 = await f.host.steerRuntime(
      repoId,
      { runtimeSessionId: session1, prompt: "Trigger hung receipt RPC on s1", idempotencyKey: "ctrl-f13-s1-hung" },
      localAuth,
    );
    assert.equal(steer1.outcome, "applied", JSON.stringify(steer1));
    await receipt1Arrived;
    assert.equal(receipt1StillHung, true, "session1 receipt RPC must be actively hung on Center");
    t.diagnostic("F13: session 1 receipt RPC is gated");

    // While session1's receipt RPC is actively HUNG, cancel session2 and prove it settles structurally!
    const cancel2 = await f.host.cancelRuntime(
      repoId,
      { runtimeSessionId: session2, idempotencyKey: "ctrl-f13-s2-fast-cancel" },
      localAuth,
    );
    assert.equal(cancel2.detail, "cancel_requested", JSON.stringify(cancel2));
    await f.host.awaitRuntimeSessions(
      repoId,
      { runtimeSessionIds: [session2] },
      { ...localAuth, connectionSignal: AbortSignal.timeout(25_000) },
    );
    assert.equal(receipt1StillHung, true, "session2 cancelled while session1 receipt RPC was STILL hung!");
    t.diagnostic("F13: session 2 cancelled while session 1 receipt RPC remains gated");

    // Release session1's hung receipt gate and confirm session1's applied receipt lands cleanly!
    releaseHungReceipt1();
    await waitForDurableCondition(async () => {
      const read = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: session1, includeControlReceipts: true },
        localAuth,
      );
      return Boolean(
        read.session?.controlReceipts?.some(
          (rcpt) => rcpt.controlRequestId === "ctrl-f13-s1-hung" && rcpt.status === "applied",
        ),
      );
    });
    t.diagnostic("F13: session 1 receipt is durable");

    // Part 2 (F6): Real CLI lost-first-Center-response retry while Edge B's replica lags behind `persistedRev`!
    // Route Edge B through a transparent local TCP pass-through proxy to Center so we can pause ONLY Edge B's
    // already-established resident replication TCP socket while letting the CLI's new command RPC flow through
    // unimpeded — proving the real CLI blocks on waitForFleetReplicaRevision until replication resumes!
    const openUpstreams = new Set<net.Socket>();
    const allProxySockets = new Set<net.Socket>();
    const cliCommandUpstreams: net.Socket[] = [];
    let captureCliConnections = false;
    let firstCliConnectionResolve!: (socket: net.Socket) => void;
    const firstCliConnection = new Promise<net.Socket>((resolve) => {
      firstCliConnectionResolve = resolve;
    });
    let retryCliConnectionResolve!: (socket: net.Socket) => void;
    const retryCliConnection = new Promise<net.Socket>((resolve) => {
      retryCliConnectionResolve = resolve;
    });
    const proxyServer = net.createServer((downstream) => {
      const upstream = net.connect({ host: "127.0.0.1", port: f.center.port });
      allProxySockets.add(downstream);
      allProxySockets.add(upstream);
      openUpstreams.add(upstream);
      if (captureCliConnections) {
        cliCommandUpstreams.push(upstream);
        if (cliCommandUpstreams.length === 1) firstCliConnectionResolve(upstream);
        if (cliCommandUpstreams.length === 2) retryCliConnectionResolve(upstream);
      }
      downstream.pipe(upstream);
      upstream.pipe(downstream);
      upstream.on("data", () => {
        if (retryResponseExpected && upstream === cliCommandUpstreams[1]) {
          retryResponseExpected = false;
          retryResponseReceivedResolve();
        }
      });
      const cleanup = () => {
        openUpstreams.delete(upstream);
        allProxySockets.delete(downstream);
        allProxySockets.delete(upstream);
        downstream.destroy();
        upstream.destroy();
      };
      downstream.on("error", cleanup);
      upstream.on("error", cleanup);
      downstream.on("close", cleanup);
      upstream.on("close", cleanup);
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxyServer.address() as net.AddressInfo).port;
    t.after(async () => {
      for (const sock of allProxySockets) sock.destroy();
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    });

    const pausedEdgeB = await fleetEdgeHostFixture(t, f, {
      name: "edge-f6-paused",
      nodeId: "node-two",
      personId: "person-one",
      centerPort: proxyPort,
      beforeOpen: (root) => {
        git(root, "remote", "add", "origin", originRemote);
        git(root, "fetch", "-q", "origin");
        git(root, "branch", "--set-upstream-to", `origin/${branch}`);
        git(root, "reset", "--hard", `origin/${branch}`);
      },
    });
    // Wait until Edge B's resident replication stream is live, then freeze ONLY its TCP socket(s);
    // new CLI RPC connections opened afterwards will pass straight through to Center.
    assert.equal(
      await waitForFleetReplicaReady({ viewRoot: pausedEdgeB.viewRoot, repoId, nodeId: "node-two" }),
      true,
      "Edge B resident replication stream must become ready before pausing",
    );
    assert.ok(openUpstreams.size >= 1, "Edge B must hold an active resident replication TCP connection");
    const pausedUpstreams = [...openUpstreams];
    for (const sock of pausedUpstreams) sock.pause();

    const pausedDaemonId = "edge-f6-paused-cli";
    const pausedTransport = createUnixSocketTransportServer({
      daemonId: pausedDaemonId,
      socketPath: localUserDaemonEndpoint(pausedEdgeB.edgeUser, pausedDaemonId),
      createProtocolServer: (authContext, emit, _connectionId, connectionSignal) =>
        createJsonRpcProtocolServer({
          host: pausedEdgeB.host,
          build: daemonBuildStamp(),
          authContext: { ...authContext, connectionSignal },
          sessionPrincipal: (method, params) =>
            pausedEdgeB.host.sessionPrincipal({ ...authContext, connectionSignal }, method, params),
          executionPrincipal: async (credential, method, params) => {
            const principal = readRuntimeExecutionPrincipal(pausedEdgeB.edgeRoot, credential);
            if (!principal)
              throw Object.assign(new Error("Execution credential is unknown or expired on this edge runtime."), {
                code: "authorization_denied",
              });
            requireExecutionRequestScope(principal, method, params);
            return principal;
          },
          emit,
        }),
    });
    await pausedTransport.start();
    t.after(() => pausedTransport.stop());

    const staleReadBeforeCli = await pausedEdgeB.host.read(
      repoId,
      "repo.agentRuntime.sessions.read",
      { runtimeSessionId: session1 },
      localAuth,
    );
    captureCliConnections = true;
    const cliEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_")));
    const runSteerCli = () => {
      let settled = false;
      const promise = new Promise<{
        readonly code: number | null;
        readonly stdout: string;
        readonly stderr: string;
      }>((resolve) => {
        const child = spawn(
          process.execPath,
          [
            path.resolve("packages/cli/src/index.ts"),
            "--root",
            pausedEdgeB.edgeRoot,
            "--json",
            "runtime",
            "steer",
            session1,
            "--prompt",
            lostRespPrompt,
            "--idempotency-key",
            lostRespKey,
          ],
          {
            env: {
              ...cliEnv,
              HARNESS_DAEMON_USER_ROOT: pausedEdgeB.edgeUser,
              HARNESS_DAEMON_ID: pausedDaemonId,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          settled = true;
          resolve({ code: null, stdout, stderr: `${stderr}${String(error)}` });
        });
        child.on("close", (code) => {
          settled = true;
          resolve({ code, stdout, stderr });
        });
      });
      return { promise, isSettled: () => settled };
    };

    // The real CLI call commits at Center; drop its first TLS response so the edge write retry reuses the opId.
    const firstCli = runSteerCli();
    t.diagnostic("F6: real CLI started");
    const firstCliSocket = await firstCliConnection;
    t.diagnostic("F6: initial Center connection captured");
    await firstControlRequestCommitted;
    t.diagnostic("F6: initial Center request committed");
    assert.equal(firstControlRequestReceipt?.outcome, "applied");
    const persistedRev = Number(firstControlRequestReceipt?.revision);
    assert.ok(Number.isSafeInteger(persistedRev) && persistedRev > staleReadBeforeCli.watermark);
    firstCliSocket.destroy();
    releaseLostFirstResponse();
    t.diagnostic("F6: initial Center response dropped; awaiting transport retry");

    // The same real CLI invocation retries the Center write with the same idempotency key.
    const retrySocket = await retryCliConnection;
    await retryControlRequestCommitted;
    t.diagnostic("F6: Center resolved transport retry");
    assert.ok(retryControlRequestReceipt, "the retry must reach Center and resolve the existing request");
    await retryResponseReceived;
    t.diagnostic("F6: retried Center response received before replica catch-up");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      firstCli.isSettled(),
      false,
      "F6: the real CLI must remain pending after Center responds while Edge-B replication is paused",
    );
    assert.ok(retrySocket.destroyed === false);

    // Resume Edge-B's resident replication stream -> CLI resolves with no_changes and revision === persistedRev.
    for (const sock of pausedUpstreams) sock.resume();
    const cliResult = await firstCli.promise;
    t.diagnostic("F6: real CLI settled after replica catch-up");
    assert.equal(cliResult.code, 0, JSON.stringify(cliResult));
    const cliReceipt = JSON.parse(cliResult.stdout.trim()) as Record<string, unknown>;
    assert.equal(cliReceipt.outcome, "no_changes", JSON.stringify(cliReceipt));
    assert.equal(cliReceipt.revision, persistedRev);
    assert.equal(controlRequestCount, 2, "the retry must reuse the same Center request without another write");
    await waitForDurableCondition(async () => {
      const read = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: session1, includeControlReceipts: true },
        localAuth,
      );
      return Boolean(
        read.session?.controlReceipts?.some(
          (receipt) => receipt.controlRequestId === lostRespKey && receipt.status === "applied",
        ),
      );
    });
    const readAfterCli = await pausedEdgeB.host.read(
      repoId,
      "repo.agentRuntime.sessions.read",
      { runtimeSessionId: session1 },
      localAuth,
    );
    assert.ok(readAfterCli.watermark >= persistedRev);
    assert.equal(
      readProviderTrace(tracePath1).filter((entry) => entry.prompt === lostRespPrompt).length,
      1,
      "F6: retried steer must deliver exactly once to provider",
    );

    // Clean up session1.
    await f.host.cancelRuntime(repoId, { runtimeSessionId: session1 }, localAuth);
    await f.host.awaitRuntimeSessions(
      repoId,
      { runtimeSessionIds: [session1] },
      { ...localAuth, connectionSignal: AbortSignal.timeout(30_000) },
    );
  },
);
