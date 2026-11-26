// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PeerRequestV1 } from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { eventuallyValue, rpc, writeProviderStub } from "./fixtures/runtime-ingress.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { evidence } from "./task-surface.fixtures.ts";

function makeCodexLauncher(launchedArgs: (readonly string[])[]) {
  let turn = 0;
  return (prepared: { readonly args: readonly string[] }) => {
    turn += 1;
    const currentTurn = turn;
    launchedArgs.push([...prepared.args]);
    let output: ((chunk: string) => void) | null = null;
    return {
      pid: 94100 + currentTurn,
      onOutput: (listener: (chunk: string) => void) => {
        output = listener;
      },
      onErrorOutput: () => undefined,
      onExit: (exit: (code: number) => void) => {
        queueMicrotask(() => {
          output?.(
            [
              JSON.stringify({ type: "thread.started", thread_id: "edge-ceo-session" }),
              JSON.stringify({
                type: "item.completed",
                item: { id: "msg", type: "agent_message", text: `edge ceo assessment turn ${currentTurn}` },
              }),
              JSON.stringify({ type: "turn.completed" }),
            ].join("\n") + "\n",
          );
          exit(0);
        });
      },
      terminate: () => undefined,
    };
  };
}

test(
  "remote-edge resident CEO settles peer wake, replies to peer, handles follow-up chat, and reconciles on restart",
  { timeout: 120_000 },
  async (t) => {
    const repoId = "lease-repo";
    const stubDir = mkdtempSync(path.join(tmpdir(), "ha-resident-ceo-edge-stub-"));
    t.after(() => removeTempRepository(stubDir));
    const installation = {
      installationId: "edge-ceo-codex-install",
      kindId: "codex" as const,
      executablePath: writeProviderStub(
        path.join(stubDir, "codex.mjs"),
        "codex",
        path.join(stubDir, "codex-args.json"),
      ),
      version: "codex-cli 0.159.1",
      observedAt: "2026-11-25T00:00:00.000Z",
    };
    const codexInstance = {
      instanceId: "edge-ceo-codex",
      name: "Edge Resident CEO Codex",
      kindId: "codex" as const,
      installationId: installation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription" as const,
      codex: {},
    };
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, false, {
      runtimeDiscover: async () => [installation],
    });
    const launchedArgs: (readonly string[])[] = [];
    const runtimeLaunch = makeCodexLauncher(launchedArgs);

    const edge = await fleetEdgeHostFixture(t, f, {
      runtimeDiscover: async () => [installation],
      runtimeLaunch,
    });
    const awaitRuntimeSessions = edge.host.awaitRuntimeSessions.bind(edge.host);
    let interruptedSettlementRead = false;
    Object.defineProperty(edge.host, "awaitRuntimeSessions", {
      configurable: true,
      value: async (...args: Parameters<typeof awaitRuntimeSessions>) => {
        if (!interruptedSettlementRead) {
          interruptedSettlementRead = true;
          throw Object.assign(new Error("synthetic Fleet read interruption"), { code: "ECONNRESET" });
        }
        return awaitRuntimeSessions(...args);
      },
    });

    const edgePersonAuth = {
      ...auth,
      oidcPrincipal: await edge.host.sessionPrincipal(auth, "repo.residentCeo.status", {
        repo: { repoId },
        payload: {},
      }),
    };
    const ceo = (host: typeof edge.host, operation: string, payload: Record<string, unknown> = {}) =>
      rpc(host, edgePersonAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });

    // 1. Center creates an OPEN peer delegation addressed to person-one (the edge owner).
    const delegated = await f.host.run(
      repoId,
      {
        kind: "peer-ask",
        requestKind: "delegate",
        toPersonId: "person-one",
        summary: "Assess remote-edge readiness",
      },
      localAuthFixture(),
    );
    assert.equal(delegated.outcome, "applied", JSON.stringify(delegated));
    await waitForFleetPublication(f.host, repoId, delegated.opId, localAuthFixture());
    const { request: firstRequest } = evidence(delegated) as { request: PeerRequestV1 };

    // Wait until edge replica reflects the OPEN peer request before configuring/starting Resident CEO.
    await eventuallyValue(async () => {
      const inbox = await edge.host.run(repoId, { kind: "peer-inbox", state: "OPEN", limit: 10 }, edgePersonAuth);
      if (inbox.outcome !== "applied" && inbox.outcome !== "no_changes") return null;
      const parsed = evidence(inbox) as { requests?: PeerRequestV1[] };
      return parsed.requests?.some((item) => item.requestId === firstRequest.requestId) ? true : null;
    }, "edge replica receives initial peer delegation");
    await registerFixtureRuntimeInstance(edge.host, repoId, edgePersonAuth, codexInstance);

    const configured = await ceo(edge.host, "config", {
      runtimeInstanceId: codexInstance.instanceId,
      model: "gpt-5.6-sol",
      heartbeatIntervalSec: 300,
    });
    assert.equal(configured.ok, true, JSON.stringify(configured));

    const started = await ceo(edge.host, "start");
    assert.equal(started.ok, true, JSON.stringify(started));

    // Resident CEO on remote-edge must settle lastWake -> "succeeded" with persistentSessionId.
    const settledWake = await eventuallyValue(
      async () => {
        const status = await ceo(edge.host, "status");
        assert.equal(status.ok, true, JSON.stringify(status));
        const profile = status.profile as {
          readonly persistentSessionId: string | null;
          readonly lastWake: {
            readonly status: string;
            readonly cause: string;
            readonly runtimeSessionId: string | null;
            readonly completedAt: string | null;
            readonly detail: string | null;
          } | null;
        };
        assert.notEqual(profile.lastWake?.status, "failed", JSON.stringify(profile.lastWake));
        return profile.lastWake?.status === "succeeded" ? profile : null;
      },
      "remote-edge resident CEO settles peer wake",
      15_000,
    );
    assert.equal(settledWake.lastWake?.cause, "peer-request");
    assert.equal(interruptedSettlementRead, true, "the first Fleet settlement read must be interrupted");
    assert.equal(settledWake.persistentSessionId, "edge-ceo-session");
    assert.ok(settledWake.lastWake?.completedAt, "completedAt must be populated after settlement");
    assert.ok(!launchedArgs[0]?.includes("resume"), JSON.stringify(launchedArgs[0]));

    // Peer request must have transitioned to ANSWERED at the center via acknowledgeResidentCeoPeer.
    const answeredFirst = await eventuallyValue(
      async () => {
        const watch = await f.host.run(
          repoId,
          { kind: "peer-watch", once: true, replyTo: firstRequest.requestId },
          localAuthFixture(),
        );
        const view = evidence(watch) as { request: PeerRequestV1 };
        return view.request.state === "ANSWERED" ? view.request : null;
      },
      "center observes peer-reply ANSWERED for first delegation",
      10_000,
    );
    assert.equal(answeredFirst.reply?.structuredBody.claim, "edge ceo assessment turn 1");

    // 2. Subsequent `ha ceo chat` must succeed (not blocked by resident_ceo_busy) and resume the session.
    const chat = await ceo(edge.host, "chat", { message: "Follow up on remote-edge readiness" });
    assert.equal(chat.ok, true, JSON.stringify(chat));
    assert.equal(chat.response, "edge ceo assessment turn 2");
    assert.ok(launchedArgs[1]?.includes("resume"), JSON.stringify(launchedArgs[1]));
    assert.ok(launchedArgs[1]?.includes("edge-ceo-session"), JSON.stringify(launchedArgs[1]));

    // 3. Restart reconciliation preserves an existing peer reply while recovering a settled wake.
    await edge.host.close();

    const secondDelegated = await f.host.run(
      repoId,
      {
        kind: "peer-ask",
        requestKind: "delegate",
        toPersonId: "person-one",
        summary: "Delegation awaiting restart reconciliation",
      },
      localAuthFixture(),
    );
    assert.equal(secondDelegated.outcome, "applied", JSON.stringify(secondDelegated));
    await waitForFleetPublication(f.host, repoId, secondDelegated.opId, localAuthFixture());
    const { request: secondRequest } = evidence(secondDelegated) as { request: PeerRequestV1 };
    const existingReply = await f.command("node-one", {
      kind: "peer-reply",
      requestId: secondRequest.requestId,
      claim: "recipient answered before Resident CEO recovery",
      requestedAction: "Preserve the recipient's existing assessment.",
    });
    assert.equal(existingReply.outcome, "applied", JSON.stringify(existingReply));
    await waitForFleetPublication(f.host, repoId, String(existingReply.receipt?.opId), localAuthFixture());

    // Persist status="running" and lastWake.status="running" referencing the settled session
    // and the second request that already reached ANSWERED through the ordinary peer-reply path.
    const localSettingsPath = resolveHarnessLayout(edge.edgeRoot).settingsLocalPath;
    const localSettings = JSON.parse(readFileSync(localSettingsPath, "utf8")) as Record<string, unknown>;
    const profiles = JSON.parse(String(localSettings.residentCeoProfilesJson)) as Record<
      string,
      Record<string, unknown>
    >;
    profiles["person-one"] = {
      ...profiles["person-one"],
      status: "running",
      persistentSessionId: null,
      lastWake: {
        wakeId: "wake-interrupted-before-restart",
        cause: "peer-request",
        requestedAt: "2026-11-25T16:00:00.000Z",
        completedAt: null,
        status: "running",
        runtimeSessionId: settledWake.lastWake!.runtimeSessionId,
        peerRequestId: secondRequest.requestId,
        detail: null,
      },
      updatedAt: new Date(Date.now() + 5_000).toISOString(),
    };
    localSettings.residentCeoProfilesJson = JSON.stringify(profiles);
    writeFileSync(localSettingsPath, `${JSON.stringify(localSettings, null, 2)}\n`);

    // Restart the edge daemon against the same edgeRoot and edgeUser.
    const restartedEdge = await openDaemonHost({
      daemonId: "edge-daemon",
      userRoot: edge.edgeUser,
      runtimeDiscover: async () => [installation],
      runtimeLaunch,
      oidc: createIdentitySession(edge.edgeUser, {
        fetch: f.owners.keycloak.fetch,
        loginAuthority: () =>
          Promise.resolve({
            url: f.owners.url,
            realm: "harness",
            clientId: "harness-node-node-one",
            clientSecret: "secret-node-one",
          }),
      }),
    });
    t.after(() => restartedEdge.close());
    await restartedEdge.attachmentsSettled();
    const recoveredSession = (await restartedEdge.awaitRuntimeSessions(
      repoId,
      { runtimeSessionIds: [settledWake.lastWake!.runtimeSessionId!], mode: "all" },
      edgePersonAuth,
    )) as {
      readonly session?: { readonly runtimeSessionId?: string };
      readonly settlement?: { readonly outcome?: string } | null;
    };
    assert.equal(recoveredSession.session?.runtimeSessionId, settledWake.lastWake!.runtimeSessionId);
    assert.equal(recoveredSession.settlement?.outcome, "succeeded");

    // Restart must reconcile the wake and retain the already-recorded peer reply.
    const reconciled = await eventuallyValue(
      async () => {
        const status = await ceo(restartedEdge, "status");
        assert.equal(status.ok, true, JSON.stringify(status));
        const profile = status.profile as {
          readonly persistentSessionId: string | null;
          readonly lastWake: {
            readonly wakeId: string;
            readonly status: string;
            readonly completedAt: string | null;
            readonly detail: string | null;
          } | null;
        };
        assert.notEqual(profile.lastWake?.status, "failed", JSON.stringify(profile.lastWake));
        return profile.lastWake?.wakeId === "wake-interrupted-before-restart" && profile.lastWake.status === "succeeded"
          ? profile
          : null;
      },
      "restarted remote-edge daemon reconciles settled running wake",
      15_000,
    );
    assert.equal(reconciled.persistentSessionId, "edge-ceo-session");
    assert.ok(reconciled.lastWake?.completedAt, "reconciled wake must record completedAt");

    const answeredSecond = await eventuallyValue(
      async () => {
        const watch = await f.host.run(
          repoId,
          { kind: "peer-watch", once: true, replyTo: secondRequest.requestId },
          localAuthFixture(),
        );
        const view = evidence(watch) as { request: PeerRequestV1 };
        return view.request.state === "ANSWERED" ? view.request : null;
      },
      "center observes peer-reply ANSWERED after restart reconciliation",
      10_000,
    );
    assert.equal(answeredSecond.reply?.structuredBody.claim, "recipient answered before Resident CEO recovery");

    // Follow-up `ha ceo chat` after restart reconciliation must succeed (no resident_ceo_busy).
    const chatAfterRestart = await ceo(restartedEdge, "chat", { message: "Chat after restart reconciliation" });
    assert.equal(chatAfterRestart.ok, true, JSON.stringify(chatAfterRestart));
    assert.equal(chatAfterRestart.response, "edge ceo assessment turn 3");
    assert.ok(launchedArgs[2]?.includes("resume"), JSON.stringify(launchedArgs[2]));
    assert.ok(launchedArgs[2]?.includes("edge-ceo-session"), JSON.stringify(launchedArgs[2]));
  },
);

test(
  "remote-edge resident CEO handles >512-byte peer replies, terminal fleet_task_rejected idempotency, and fail-closed controls",
  { timeout: 120_000 },
  async (t) => {
    const repoId = "lease-repo";
    const stubDir = mkdtempSync(path.join(tmpdir(), "ha-resident-ceo-edge-idempotency-stub-"));
    t.after(() => removeTempRepository(stubDir));
    const installation = {
      installationId: "edge-ceo-codex-install",
      kindId: "codex" as const,
      executablePath: writeProviderStub(
        path.join(stubDir, "codex.mjs"),
        "codex",
        path.join(stubDir, "codex-args.json"),
      ),
      version: "codex-cli 0.159.1",
      observedAt: "2026-11-25T00:00:00.000Z",
    };
    const codexInstance = {
      instanceId: "edge-ceo-codex",
      name: "Edge Resident CEO Codex",
      kindId: "codex" as const,
      installationId: installation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription" as const,
      codex: {},
    };
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, false, {
      runtimeDiscover: async () => [installation],
    });
    const longAssessment = `edge ceo long assessment ${"detailed-evidence-".repeat(90)}end`;
    assert.ok(longAssessment.length > 1500, "test fixture must exceed the 512-char default Fleet field cap");
    let turn = 0;
    const runtimeLaunch = () => {
      turn += 1;
      const currentTurn = turn;
      let output: ((chunk: string) => void) | null = null;
      return {
        pid: 95100 + currentTurn,
        onOutput: (listener: (chunk: string) => void) => {
          output = listener;
        },
        onErrorOutput: () => undefined,
        onExit: (exit: (code: number) => void) => {
          queueMicrotask(() => {
            output?.(
              [
                JSON.stringify({ type: "thread.started", thread_id: "edge-ceo-long-session" }),
                JSON.stringify({
                  type: "item.completed",
                  item: {
                    id: "msg",
                    type: "agent_message",
                    text: currentTurn === 1 ? longAssessment : `edge ceo follow-up turn ${currentTurn}`,
                  },
                }),
                JSON.stringify({ type: "turn.completed" }),
              ].join("\n") + "\n",
            );
            exit(0);
          });
        },
        terminate: () => undefined,
      };
    };

    const edge = await fleetEdgeHostFixture(t, f, {
      runtimeDiscover: async () => [installation],
      runtimeLaunch,
    });
    const edgePersonAuth = {
      ...auth,
      oidcPrincipal: await edge.host.sessionPrincipal(auth, "repo.residentCeo.status", {
        repo: { repoId },
        payload: {},
      }),
    };
    const ceo = (host: typeof edge.host, operation: string, payload: Record<string, unknown> = {}) =>
      rpc(host, edgePersonAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });

    // 1. Real >512-byte LLM response must cross Fleet peer-reply without tripping closed-schema 512-char rejection.
    const firstDelegated = await f.host.run(
      repoId,
      {
        kind: "peer-ask",
        requestKind: "delegate",
        toPersonId: "person-one",
        summary: "Long assessment over Fleet",
      },
      localAuthFixture(),
    );
    assert.equal(firstDelegated.outcome, "applied", JSON.stringify(firstDelegated));
    await waitForFleetPublication(f.host, repoId, firstDelegated.opId, localAuthFixture());
    const { request: firstRequest } = evidence(firstDelegated) as { request: PeerRequestV1 };

    await eventuallyValue(async () => {
      const inbox = await edge.host.run(repoId, { kind: "peer-inbox", state: "OPEN", limit: 10 }, edgePersonAuth);
      if (inbox.outcome !== "applied" && inbox.outcome !== "no_changes") return null;
      const parsed = evidence(inbox) as { requests?: PeerRequestV1[] };
      return parsed.requests?.some((item) => item.requestId === firstRequest.requestId) ? true : null;
    }, "edge replica receives long-reply peer delegation");
    await registerFixtureRuntimeInstance(edge.host, repoId, edgePersonAuth, codexInstance);

    assert.equal(
      (
        await ceo(edge.host, "config", {
          runtimeInstanceId: codexInstance.instanceId,
          model: "gpt-5.6-sol",
          heartbeatIntervalSec: 300,
        })
      ).ok,
      true,
    );
    assert.equal((await ceo(edge.host, "start")).ok, true);

    const settledFirst = await eventuallyValue(
      async () => {
        const status = await ceo(edge.host, "status");
        assert.equal(status.ok, true, JSON.stringify(status));
        const profile = status.profile as {
          readonly lastWake: {
            readonly status: string;
            readonly runtimeSessionId: string | null;
          } | null;
        };
        assert.notEqual(profile.lastWake?.status, "failed", JSON.stringify(profile.lastWake));
        return profile.lastWake?.status === "succeeded" ? profile : null;
      },
      "remote-edge resident CEO settles >512-byte peer reply",
      15_000,
    );
    const settledSessionId = settledFirst.lastWake!.runtimeSessionId!;

    const answeredFirst = await eventuallyValue(
      async () => {
        const watch = await f.host.run(
          repoId,
          { kind: "peer-watch", once: true, replyTo: firstRequest.requestId },
          localAuthFixture(),
        );
        const view = evidence(watch) as { request: PeerRequestV1 };
        return view.request.state === "ANSWERED" ? view.request : null;
      },
      "center observes full >512-byte peer reply",
      10_000,
    );
    assert.equal(answeredFirst.reply?.structuredBody.claim, longAssessment);

    // Wait for edge replica to reflect firstRequest as ANSWERED and settledSessionId as succeeded
    // before stopping the watcher and testing reconciliation controls deterministically.
    await eventuallyValue(async () => {
      const inbox = await edge.host.run(repoId, { kind: "peer-inbox", state: "ANSWERED", limit: 20 }, edgePersonAuth);
      if (inbox.outcome !== "applied" && inbox.outcome !== "no_changes") return null;
      const parsed = evidence(inbox) as { requests?: PeerRequestV1[] };
      return parsed.requests?.some((item) => item.requestId === firstRequest.requestId) ? true : null;
    }, "edge replica observes ANSWERED peer request");

    await eventuallyValue(async () => {
      try {
        const readSession = (await edge.host.read(
          repoId,
          "repo.agentRuntime.sessions.read",
          { runtimeSessionId: settledSessionId },
          edgePersonAuth,
        )) as { readonly settlement?: { readonly outcome?: string } | null };
        return readSession.settlement?.outcome === "succeeded" ? true : null;
      } catch (error) {
        if ((error as { code?: unknown }).code === "runtime_session_not_found") return null;
        throw error;
      }
    }, "edge replica observes settled runtime session");

    // Stop the background watcher BEFORE creating openDelegated so it never wakes on openRequest.
    assert.equal((await ceo(edge.host, "stop")).ok, true);

    // Create a second OPEN peer request for non-terminal negative control.
    const openDelegated = await f.host.run(
      repoId,
      {
        kind: "peer-ask",
        requestKind: "delegate",
        toPersonId: "person-one",
        summary: "Open peer request for non-terminal fail-closed control",
      },
      localAuthFixture(),
    );
    assert.equal(openDelegated.outcome, "applied", JSON.stringify(openDelegated));
    await waitForFleetPublication(f.host, repoId, openDelegated.opId, localAuthFixture());
    const { request: openRequest } = evidence(openDelegated) as { request: PeerRequestV1 };

    await eventuallyValue(async () => {
      const inbox = await edge.host.run(repoId, { kind: "peer-inbox", state: "OPEN", limit: 20 }, edgePersonAuth);
      if (inbox.outcome !== "applied" && inbox.outcome !== "no_changes") return null;
      const parsed = evidence(inbox) as { requests?: PeerRequestV1[] };
      return parsed.requests?.some((item) => item.requestId === openRequest.requestId) ? true : null;
    }, "edge replica observes second OPEN peer request");

    const localSettingsPath = resolveHarnessLayout(edge.edgeRoot).settingsLocalPath;
    const seedPendingWake = (wakeId: string, peerRequestId: string) => {
      const localSettings = JSON.parse(readFileSync(localSettingsPath, "utf8")) as Record<string, unknown>;
      const profiles = JSON.parse(String(localSettings.residentCeoProfilesJson)) as Record<
        string,
        Record<string, unknown>
      >;
      profiles["person-one"] = {
        ...profiles["person-one"],
        status: "running",
        lastWake: {
          wakeId,
          cause: "peer-request",
          requestedAt: "2026-11-26T03:40:00.000Z",
          completedAt: null,
          status: "running",
          runtimeSessionId: settledSessionId,
          peerRequestId,
          detail: null,
        },
        updatedAt: new Date(Date.now() + 5_000).toISOString(),
      };
      localSettings.residentCeoProfilesJson = JSON.stringify(profiles);
      writeFileSync(localSettingsPath, `${JSON.stringify(localSettings, null, 2)}\n`);
    };

    const originalRun = edge.host.run.bind(edge.host);
    let syntheticPeerReplyRejection: { readonly code: string; readonly rejectionExplanation: string } | null = null;
    Object.defineProperty(edge.host, "run", {
      configurable: true,
      value: async (...args: Parameters<typeof originalRun>) => {
        const [, action] = args;
        if (action.kind === "peer-reply" && syntheticPeerReplyRejection !== null) {
          return {
            outcome: "op_rejected",
            opId: "fleet:synthetic-op",
            code: syntheticPeerReplyRejection.code,
            rejectionExplanation: syntheticPeerReplyRejection.rejectionExplanation,
          };
        }
        return originalRun(...args);
      },
    });

    // 2. Negative control: non-terminal (OPEN) PeerRequest + fleet_task_rejected must FAIL CLOSED.
    seedPendingWake("wake-open-fleet-rejected", openRequest.requestId);
    syntheticPeerReplyRejection = {
      code: "fleet_task_rejected",
      rejectionExplanation: "Simulated non-terminal Fleet command failure.",
    };
    await assert.rejects(
      () =>
        edge.host.residentCeo(
          repoId,
          "chat",
          { message: "Should fail closed on non-terminal fleet_task_rejected" },
          edgePersonAuth,
        ),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "fleet_task_rejected");
        assert.match(String((error as Error).message), /Simulated non-terminal Fleet command failure\./u);
        return true;
      },
    );

    // 3. Negative control: already-ANSWERED PeerRequest + authentication_required must FAIL CLOSED.
    seedPendingWake("wake-answered-auth-failed", firstRequest.requestId);
    syntheticPeerReplyRejection = {
      code: "authentication_required",
      rejectionExplanation: "Expired OIDC session.",
    };
    await assert.rejects(
      () =>
        edge.host.residentCeo(
          repoId,
          "chat",
          { message: "Should fail closed on authentication_required" },
          edgePersonAuth,
        ),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "authentication_required");
        assert.match(String((error as Error).message), /Expired OIDC session\./u);
        return true;
      },
    );

    // 4. Positive regression: already-ANSWERED PeerRequest + wrapped fleet_task_rejected must skip idempotently.
    seedPendingWake("wake-answered-fleet-rejected", firstRequest.requestId);
    syntheticPeerReplyRejection = {
      code: "fleet_task_rejected",
      rejectionExplanation: "Wrapped terminal peer-reply rejection.",
    };
    const chatAfterWrappedReject = await ceo(edge.host, "chat", {
      message: "Follow up after wrapped terminal fleet_task_rejected",
    });
    assert.equal(chatAfterWrappedReject.ok, true, JSON.stringify(chatAfterWrappedReject));
    assert.equal(chatAfterWrappedReject.response, "edge ceo follow-up turn 2");
  },
);
