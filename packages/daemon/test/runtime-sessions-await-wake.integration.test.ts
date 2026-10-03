// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { readDispatchStream } from "../src/dispatch-stream.ts";
import { eventually, initIngressRepo, rpc, writeProviderStub } from "./fixtures/runtime-ingress.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";

// A parked sessions.await re-reads settlement on exit signals and outcomes, not on provider
// activity: each activity frame used to wake every parked wait into a full read, so host-thread
// work grew with provider output times parked waits and starved every other request.
test("a parked sessions.await does not re-read settlement for provider activity frames", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-sessions-await-wake-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "sessions-await-wake",
    uid = process.getuid?.() ?? 0,
    activityFrames = 120;
  initIngressRepo(root, uid);
  registerDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
  const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: { ownerUid: uid, source: "unix-socket-filesystem-owner-boundary" },
    } as const,
    executablePath = writeProviderStub(path.join(parent, "claude-wake-stub.mjs"), "claude"),
    providerSessionId = "claude-wake-session";
  let emit: (frame: Record<string, unknown>) => void = () => undefined,
    exit: (code: number) => void = () => undefined;
  signInPolicyTestUser(userRoot, "person-wake", [repoId], "admin");
  const host = await openDaemonHost({
    daemonId: "sessions-await-wake",
    userRoot,
    runtimeDiscover: () => [
      {
        installationId: "installation-claude",
        kindId: "claude",
        executablePath,
        version: "1.0.0",
        observedAt: "2026-09-28T00:00:00.000Z",
      },
    ],
    runtimeLaunch: () => ({
      pid: 4312,
      onOutput: (listener) => {
        emit = (frame) => listener(`${JSON.stringify(frame)}\n`);
        emit({ type: "system", subtype: "init", session_id: providerSessionId });
      },
      onErrorOutput: () => undefined,
      onExit: (listener) => {
        exit = listener;
      },
      terminate: () => undefined,
    }),
  });
  const settlementReads = { count: 0 },
    read = host.read.bind(host);
  host.read = ((...args: Parameters<typeof host.read>) => {
    if (args[1] === "repo.agentRuntime.sessions.read") settlementReads.count += 1;
    return read(...args);
  }) as typeof host.read;
  try {
    host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: "claude-wake",
        name: "claude wake",
        kindId: "claude",
        installationId: "installation-claude",
        providerId: "anthropic",
        models: ["claude-model"],
        authMode: "subscription",
      },
      auth,
    );
    const spawned = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "claude-wake",
        cwd: { scope: "repo-root" },
        prompt: "Stream activity",
        taskId: null,
        idempotencyKey: "sessions-await-wake",
      },
    });
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const runtimeSessionId = String(spawned.runtimeSessionId),
      dispatchId = String(spawned.dispatchId);
    let settled = false;
    const wait = host
      .awaitRuntimeSessions(repoId, { runtimeSessionIds: [runtimeSessionId], mode: "any" }, auth)
      .finally(() => {
        settled = true;
      });
    await eventually(() => settlementReads.count >= 1);
    const readsWhenParked = settlementReads.count;
    for (let index = 0; index < activityFrames; index += 1) {
      emit({
        type: "assistant",
        session_id: providerSessionId,
        message: { content: [{ type: "text", text: `activity-frame-${index}` }] },
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    // Every frame has been consumed and its activity signal relayed before the count is taken.
    await eventually(
      () => JSON.stringify(readDispatchStream(root, dispatchId)).split("activity-frame-").length - 1 >= activityFrames,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false, "activity frames must not settle a live session");
    assert.ok(
      settlementReads.count - readsWhenParked <= 1,
      `${activityFrames} activity frames caused ${settlementReads.count - readsWhenParked} settlement re-reads`,
    );
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: providerSessionId,
      result: "wake result",
    });
    exit(0);
    const receipt = await wait;
    assert.equal(receipt.outcome, "succeeded", JSON.stringify(receipt));
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
