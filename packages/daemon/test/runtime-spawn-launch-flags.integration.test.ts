// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { initIngressRepo, rpc, writeProviderStub, spawnCli } from "./fixtures/runtime-ingress.ts";

test("daemon ingress passes Claude effort and Codex fast through to the witnessed CLIs", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-effort-ingress-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "runtime-claude-effort-ingress",
    uid = process.getuid?.() ?? 0,
    argsPath = path.join(parent, "claude-args.json"),
    codexArgsPath = path.join(parent, "codex-args.json"),
    executablePath = writeProviderStub(path.join(parent, "claude-stub"), "claude", argsPath),
    codexExecutablePath = writeProviderStub(path.join(parent, "codex-stub"), "codex", codexArgsPath),
    claudeInstallation = {
      installationId: "installation-claude-effort",
      kindId: "claude" as const,
      executablePath,
      version: "2.1.251",
      observedAt: "2026-08-30T00:00:00.000Z",
    },
    codexInstallation = {
      installationId: "installation-codex-fast",
      kindId: "codex" as const,
      executablePath: codexExecutablePath,
      version: "0.150.1",
      observedAt: "2026-08-30T00:00:00.000Z",
    },
    auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const;
  initIngressRepo(root, uid);
  registerDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
  const host = await openDaemonHost({
      daemonId: "runtime-claude-effort-ingress",
      userRoot,
      runtimeDiscover: () => [claudeInstallation, codexInstallation],
    }),
    endpoint = localUserDaemonEndpoint(userRoot, "runtime-claude-effort-ingress"),
    transport = createUnixSocketTransportServer({
      daemonId: "runtime-claude-effort-ingress",
      socketPath: endpoint,
      createProtocolServer: (authContext, emit) =>
        createJsonRpcProtocolServer({ host, build: { commit: null }, authContext, emit }),
    });
  await transport.start();
  try {
    await host.attachmentsSettled();
    host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: "claude-effort-provider",
        name: "Claude effort provider",
        kindId: "claude",
        installationId: claudeInstallation.installationId,
        providerId: "anthropic",
        models: ["claude-fable-5"],
        claude: {},
        authMode: "subscription",
      },
      auth,
    );
    host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: "codex-fast-provider",
        name: "Codex fast provider",
        kindId: "codex",
        installationId: codexInstallation.installationId,
        providerId: "openai",
        models: ["gpt-5.6-sol"],
        codex: {},
        authMode: "subscription",
      },
      auth,
    );
    const childEnv = {
        ...process.env,
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_ID: "runtime-claude-effort-ingress",
        HARNESS_DAEMON_REPO_ID: repoId,
        HARNESS_DAEMON_ENDPOINT: endpoint,
      },
      expectedArgs = [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "claude-fable-5",
        "--effort",
        "high",
      ],
      spawned = await spawnCli(
        [
          "--root",
          root,
          "--json",
          "runtime",
          "run",
          "claude-effort-provider",
          "--effort",
          "high",
          "--prompt",
          "probe",
          "--no-stream",
        ],
        childEnv,
      );
    assert.equal(spawned.status, 0, `${spawned.stderr}\n${spawned.stdout}`);
    assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), expectedArgs);
    const fastSpawned = await spawnCli(
      ["--root", root, "--json", "runtime", "run", "codex-fast-provider", "--fast", "--prompt", "probe", "--no-stream"],
      childEnv,
    );
    assert.equal(fastSpawned.status, 0, `${fastSpawned.stderr}\n${fastSpawned.stdout}`);
    assert.deepEqual(JSON.parse(readFileSync(codexArgsPath, "utf8")), [
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'service_tier="fast"',
      "-",
    ]);
    const unsupported = await spawnCli(
      [
        "--root",
        root,
        "--json",
        "runtime",
        "run",
        "claude-effort-provider",
        "--fast",
        "--prompt",
        "reject",
        "--no-stream",
      ],
      childEnv,
    );
    assert.notEqual(unsupported.status, 0);
    assert.equal((JSON.parse(unsupported.stdout) as Record<string, unknown>).code, "invalid_runtime_fast");
    const rejected = await spawnCli(
      [
        "--root",
        root,
        "--json",
        "runtime",
        "run",
        "claude-effort-provider",
        "--effort",
        "turbo",
        "--prompt",
        "reject",
        "--no-stream",
      ],
      childEnv,
    );
    assert.equal(rejected.status, 2, `${rejected.stderr}\n${rejected.stdout}`);
    assert.equal((JSON.parse(rejected.stdout) as Record<string, unknown>).code, "invalid_runtime_effort");
    const rejectedIngress = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "claude-effort-provider",
        cwd: { scope: "repo-root" },
        prompt: "reject",
        effort: "turbo",
        taskId: null,
        idempotencyKey: "claude-effort-turbo",
      },
    });
    assert.equal(rejectedIngress.outcome, "op_rejected", JSON.stringify(rejectedIngress));
    assert.equal(rejectedIngress.code, "invalid_runtime_effort");
    assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), expectedArgs);
  } finally {
    await transport.stop();
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
