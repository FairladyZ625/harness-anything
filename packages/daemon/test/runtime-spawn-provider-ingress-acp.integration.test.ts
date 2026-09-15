// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { initIngressRepo, rpc, eventuallyValue } from "./fixtures/runtime-ingress.ts";
import { writeAcpProviderStub } from "./fixtures/acp-stub.ts";

test("daemon ingress drives an ACP provider through the worker host", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-acp-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    fakeHome = path.join(parent, "home"),
    repoId = "runtime-acp-ingress",
    uid = 4317,
    capture = path.join(parent, "acp-capture.jsonl"),
    executablePath = writeAcpProviderStub(path.join(parent, "devin-stub"), capture);
  mkdirSync(path.join(fakeHome, ".local/share/devin"), { recursive: true });
  writeFileSync(
    path.join(fakeHome, ".local/share/devin/credentials.toml"),
    'windsurf_api_key = "test-subscription-key"\n',
  );
  writeFileSync(capture, "");
  initIngressRepo(root, uid);
  registerDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
  const installation = {
      installationId: "installation-devin",
      kindId: "devin" as const,
      executablePath,
      version: "3000.10.21",
      observedAt: "2026-09-15T00:00:00.000Z",
    },
    auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const,
    host = await openDaemonHost({
      daemonId: "runtime-acp-ingress",
      userRoot,
      runtimeDiscover: () => [installation],
      runtimeEnv: { ...process.env, HOME: fakeHome },
    });
  await host.attachmentsSettled();
  try {
    host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: "devin-provider",
        name: "devin provider",
        kindId: "devin",
        installationId: "installation-devin",
        providerId: "devin",
        models: ["swe"],
        permissionMode: "bypass",
        authMode: "subscription",
      },
      auth,
    );
    const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "devin-provider",
        cwd: { scope: "repo-root" },
        prompt: "do work",
        taskId: null,
        idempotencyKey: "devin-acp-ingress",
      },
    });
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    const read = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: receipt.runtimeSessionId },
      });
      return (value.session as { activity?: { outcome?: unknown } } | undefined)?.activity?.outcome ? value : null;
    });
    assert.equal((read.session as Record<string, unknown>).providerSessionId, "devin-acp-session");
    assert.equal((read.session as { activity: { outcome: unknown; exitCode: unknown } }).activity.outcome, "succeeded");
    assert.equal((read.session as { activity: { exitCode: unknown } }).activity.exitCode, 0);
    assert.equal((read.result as Record<string, unknown>).text, "devin live content");
    const streamPath = path.join(root, ".harness", "runtime", "dispatches", `${receipt.dispatchId}.jsonl`),
      stream = await eventuallyValue(() => {
        try {
          const content = readFileSync(streamPath, "utf8");
          return content.includes('"acp.result"') ? content : null;
        } catch {
          return null;
        }
      });
    assert.match(stream, /"type":"acp\.session"/u);
    assert.match(stream, /"sessionUpdate":"tool_call"/u);
    assert.match(stream, /"stopReason":"end_turn"/u);
    const outcome = makeTaskEventReader({ repoId, rootDir: root })
      .read()
      .events.find(
        (event) =>
          event.type === "runtime_session_outcome_observed" &&
          event.payload.runtimeSessionId === receipt.runtimeSessionId,
      );
    assert.equal(outcome?.type, "runtime_session_outcome_observed");
    const captured = readFileSync(capture, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // The ACP host supplied the subscription credential and applied the bypass mode.
    assert.deepEqual(
      captured.find((entry) => entry.apiKey !== undefined),
      {
        apiKey: "test-subscription-key",
        methodId: "devin-browser",
      },
    );
    assert.deepEqual(
      captured.find((entry) => entry.mode !== undefined),
      { mode: "bypass" },
    );
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
