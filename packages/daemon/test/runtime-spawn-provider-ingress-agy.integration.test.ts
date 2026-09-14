// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { eventuallyValue, initIngressRepo, rpc } from "./fixtures/runtime-ingress.ts";

test("agy consumes only its closed stream-json event protocol", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-events-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "runtime-agy-events",
    uid = 4305;
  let installation = {
    installationId: "installation-agy",
    kindId: "agy" as const,
    executablePath: "/opt/witnessed/agy",
    version: "1.1.15",
    observedAt: "2026-08-19T00:00:00.000Z",
  };
  initIngressRepo(root, uid);
  registerDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  const agyStub = writeProviderExecutable(path.join(parent, "agy-stub"), "process.exit(0)\n");
  installation = { ...installation, executablePath: agyStub };
  let unknown = false;
  const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const,
    host = await openDaemonHost({
      daemonId: "runtime-agy-events",
      userRoot,
      runtimeDiscover: () => [installation],
      runtimeLaunch: (prepared) => {
        assert.deepEqual(prepared.args, [
          "-p",
          unknown ? "Unknown event" : "Structured result",
          "--output-format",
          "stream-json",
          "--print-timeout",
          "30m",
          "--model",
          "gemini-3.1-pro-low",
          "--dangerously-skip-permissions",
          "--effort",
          "low",
        ]);
        const output = unknown
          ? [{ event: "future_event", text: "must not become a result" }]
          : [
              { event: "init", conversation_id: "agy-conversation" },
              {
                event: "step_update",
                step_update: {
                  conversation_id: "agy-conversation",
                  step_index: 1,
                  state: "ACTIVE",
                  step_type: "agent_response",
                  text_delta: "live",
                },
              },
              {
                event: "result",
                result: {
                  conversation_id: "agy-conversation",
                  status: "SUCCESS",
                  response: "AGY-OK",
                },
              },
            ];
        return {
          pid: 4601,
          onOutput: (listener) => {
            queueMicrotask(() => output.forEach((frame) => listener(`${JSON.stringify(frame)}\n`)));
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            queueMicrotask(() => listener(0));
          },
          terminate: () => undefined,
        };
      },
    });
  try {
    host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: "agy-provider",
        name: "agy provider",
        kindId: "agy",
        installationId: installation.installationId,
        providerId: "google",
        models: ["gemini-3.1-pro-low"],
        agy: { effort: "low" },
        authMode: "subscription",
      },
      auth,
    );
    const succeeded = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "agy-provider",
        cwd: { scope: "repo-root" },
        prompt: "Structured result",
        effort: "low",
        taskId: null,
        idempotencyKey: "agy-structured",
      },
    });
    assert.equal(succeeded.outcome, "applied", JSON.stringify(succeeded));
    const read = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: succeeded.runtimeSessionId },
      });
      return value.result ? value : null;
    });
    assert.equal((read.session as Record<string, unknown>).providerSessionId, "agy-conversation");
    assert.equal((read.result as Record<string, unknown>).text, "AGY-OK");
    assert.equal((read.session as { activity: { outcome: string } }).activity.outcome, "succeeded");
    unknown = true;
    const rejected = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "agy-provider",
        cwd: { scope: "repo-root" },
        prompt: "Unknown event",
        effort: "low",
        taskId: null,
        idempotencyKey: "agy-unknown",
      },
    });
    assert.equal(rejected.outcome, "applied", JSON.stringify(rejected));
    const rejectedRead = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: rejected.runtimeSessionId },
      });
      // See the comment above the first occurrence of this guard: a read racing the writer's
      // projection catch-up can return a receipt with no `session` yet.
      return (value.session as { activity?: { outcome: unknown } } | undefined)?.activity?.outcome ? value : null;
    });
    assert.equal((rejectedRead.session as { activity: { outcome: string } }).activity.outcome, "succeeded");
    assert.equal((rejectedRead.result as Record<string, unknown>).text, "");
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
