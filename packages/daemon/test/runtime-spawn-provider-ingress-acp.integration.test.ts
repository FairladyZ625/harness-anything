// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { initIngressRepo, rpc, eventuallyValue } from "./fixtures/runtime-ingress.ts";
import { writeAcpProviderStub } from "./fixtures/acp-stub.ts";

const repoId = "runtime-acp-ingress",
  uid = 4317,
  auth = {
    transportKind: "unix-socket",
    unixSocketOwnerBoundary: {
      ownerUid: uid,
      source: "unix-socket-filesystem-owner-boundary",
    },
  } as const;

async function withAcpDaemon(
  runtimeEnv: NodeJS.ProcessEnv,
  body: (input: {
    readonly host: Awaited<ReturnType<typeof openDaemonHost>>;
    readonly root: string;
    readonly capture: string;
  }) => Promise<void>,
): Promise<void> {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-acp-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    fakeHome = path.join(parent, "home"),
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
    host = await openDaemonHost({
      daemonId: "runtime-acp-ingress",
      userRoot,
      runtimeDiscover: () => [installation],
      runtimeEnv: { ...runtimeEnv, HOME: fakeHome },
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
        models: ["swe", "exit-before-session"],
        permissionMode: "bypass",
        authMode: "subscription",
      },
      auth,
    );
    await body({ host, root, capture });
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
}

async function spawnSettled(
  host: Awaited<ReturnType<typeof openDaemonHost>>,
  root: string,
  payload: { readonly prompt: string; readonly model?: string; readonly idempotencyKey: string },
) {
  const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
    repo: { repoId },
    payload: {
      runtimeInstanceId: "devin-provider",
      cwd: { scope: "repo-root" },
      taskId: null,
      ...payload,
    },
  });
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  const read = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: receipt.runtimeSessionId },
      });
      return (value.session as { activity?: { outcome?: unknown } } | undefined)?.activity?.outcome ? value : null;
    }),
    streamPath = path.join(root, ".harness", "runtime", "dispatches", `${String(receipt.dispatchId)}.jsonl`),
    records = await eventuallyValue(() => {
      const lines = readFileSync(streamPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      return lines.some((record) => record.kind === "attempt_outcome") ? lines : null;
    });
  return { receipt, read, records };
}

function streamOrder(records: readonly Record<string, unknown>[]): string[] {
  return records.flatMap((record) =>
    record.kind === "provider_event"
      ? [String((record.event as Record<string, unknown>).type)]
      : record.kind === "process_exit" || record.kind === "attempt_outcome"
        ? [String(record.kind)]
        : [],
  );
}

test("daemon ingress drives an ACP provider through the worker host", async () => {
  await withAcpDaemon(process.env, async ({ host, root, capture }) => {
    const { receipt, read } = await spawnSettled(host, root, {
      prompt: "do work",
      idempotencyKey: "devin-acp-ingress",
    });
    assert.equal((read.session as Record<string, unknown>).providerSessionId, "devin-acp-session");
    assert.equal((read.session as { activity: { outcome: unknown; exitCode: unknown } }).activity.outcome, "succeeded");
    assert.equal((read.session as { activity: { exitCode: unknown } }).activity.exitCode, 0);
    assert.equal((read.result as Record<string, unknown>).text, "devin live content");
    const streamPath = path.join(root, ".harness", "runtime", "dispatches", `${String(receipt.dispatchId)}.jsonl`),
      stream = await eventuallyValue(() => {
        try {
          const content = readFileSync(streamPath, "utf8");
          return content.includes('"acp.result"') ? content : null;
        } catch {
          return null;
        }
      });
    assert.match(stream, /"type":"acp\.session"/u);
    assert.match(stream, /"models":\["swe-2-medium","swe-2-high"\]/u);
    assert.match(stream, /"currentModelId":"swe-2-medium"/u);
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
  });
});

test("an ACP provider that exits 0 before its turn completes settles as failed", async () => {
  await withAcpDaemon(process.env, async ({ host, root }) => {
    const beforeSession = await spawnSettled(host, root, {
      prompt: "do work",
      model: "exit-before-session",
      idempotencyKey: "devin-acp-exit-before-session",
    });
    assert.equal((beforeSession.read.session as Record<string, unknown>).providerSessionId, null);
    assert.deepEqual((beforeSession.read.session as { activity: Record<string, unknown> }).activity.outcome, "failed");
    assert.deepEqual(streamOrder(beforeSession.records), ["acp.error", "process_exit", "attempt_outcome"]);
    assert.equal(beforeSession.records.find((record) => record.kind === "process_exit")?.exitCode, 0);
    assert.equal(
      beforeSession.records.find((record) => record.kind === "attempt_outcome")?.classification,
      "provider_fault",
    );

    const midPrompt = await spawnSettled(host, root, {
      prompt: "exit-mid-prompt",
      idempotencyKey: "devin-acp-exit-mid-prompt",
    });
    assert.equal((midPrompt.read.session as Record<string, unknown>).providerSessionId, "devin-acp-session");
    assert.deepEqual((midPrompt.read.session as { activity: Record<string, unknown> }).activity.outcome, "failed");
    assert.deepEqual(streamOrder(midPrompt.records), [
      "acp.session",
      "acp.mode",
      "acp.update",
      "acp.error",
      "process_exit",
      "attempt_outcome",
    ]);
    assert.equal(midPrompt.records.find((record) => record.kind === "attempt_outcome")?.classification, "gate_red");
  });
});

test("the worker host does not bind the ACP provider to the editor host the daemon inherited", async () => {
  // A daemon started from a Windsurf terminal inherits WINDSURF_EXT_HOST_PID; once that editor process
  // is gone, devin's ACP server exits 0 before answering session/new.
  const editorHostPid = spawnSync(process.execPath, ["-e", ""]).pid;
  await withAcpDaemon({ ...process.env, WINDSURF_EXT_HOST_PID: String(editorHostPid) }, async ({ host, root }) => {
    const { read, records } = await spawnSettled(host, root, {
      prompt: "do work",
      idempotencyKey: "devin-acp-editor-host",
    });
    assert.equal((read.session as Record<string, unknown>).providerSessionId, "devin-acp-session");
    assert.equal((read.session as { activity: Record<string, unknown> }).activity.outcome, "succeeded");
    assert.equal((read.result as Record<string, unknown>).text, "devin live content");
    assert.equal(streamOrder(records).at(-3), "acp.result");
  });
});
