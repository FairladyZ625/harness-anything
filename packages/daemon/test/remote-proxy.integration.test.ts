// harness-test-tier: integration
import { scopedRpcParams } from "@harness-anything/daemon/protocol";
import { waitForArrival, waitForDurableCondition } from "../../../tools/fixtures/event-arrival.ts";
import { daemonBuildStamp } from "../src/daemon-host/build-identity.ts";
import { openRemoteProxyManager } from "../src/daemon-host/remote-proxy.ts";
import { appendRuntimeWorkerRecord } from "../src/daemon-host/dispatch-stream.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { runDaemonControl } from "@harness-anything/cli/internal/daemon/control";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { localUserDaemonEndpoint } from "../src/daemon-host/client/local-daemon-target.ts";
import { requestDaemonJsonRpcAt } from "../src/daemon-host/client/local-json-rpc-client.ts";
import {
  streamAgentRuntimeAt,
  streamDaemonFacetAt,
  type DaemonStreamFailure,
} from "../src/daemon-host/client/local-json-rpc-stream.ts";
import { openDaemonHost, type DaemonHost } from "../src/daemon-host/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/daemon-host/protocol/json-rpc-server.ts";
import type { JsonObject } from "../src/daemon-host/protocol/json-rpc-types.ts";
import type { RuntimeStreamCursor } from "../src/daemon-host/protocol/stream-contract.ts";
import { currentDaemonProtocolVersion } from "../src/daemon-host/protocol/version.ts";
import { serveJsonRpcStream, type DaemonTransportConnection } from "../src/daemon-host/transport/json-rpc-stream.ts";
import { createUnixSocketTransportServer } from "../src/daemon-host/transport/unix-socket.ts";
import { openBootstrappedRepoCell, registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import type { CredentialPort } from "../src/daemon-host/agent-runtime-credential-port.ts";
import { createLocalGuiServiceBridge } from "../../gui/src/main/local-composition-root.ts";
import { fixtureRuntimeProcess, runtimeProcessFixture } from "./fixtures/runtime-process.ts";

test(
  "remote-proxy forwards repository frames and streams, reconnects, and fails closed",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixtureRuntimeProcess(t),
      parent = mkdtempSync(path.join(tmpdir(), "ha-remote-proxy-")),
      repoId = "proxy-repo",
      repoRoot = path.join(parent, "repo-b"),
      userRootA = path.join(parent, "user-a"),
      userRootB = path.join(parent, "user-b"),
      endpointA = localUserDaemonEndpoint(userRootA, "proxy-a"),
      uid = process.getuid?.() ?? 0,
      executablePath = writeProviderExecutable(
        path.join(parent, "codex-stub.mjs"),
        "if (process.argv[2] === '--version') console.log('codex-stub 1.0.0');\n",
      );
    signInPolicyTestUser(userRootA, "owner", [repoId], "admin");
    signInPolicyTestUser(userRootB, "owner", [repoId], "admin");
    initRepo(repoRoot, repoId, uid);
    registerBootstrappedDaemonRepo({
      canonicalRoot: repoRoot,
      repoId,
      userRoot: userRootB,
      createConvenienceLinks: false,
    });
    const vaultA = providerVault(),
      vaultB = providerVault();
    let providerOutput: ((chunk: string) => void) | undefined;
    const hostB = await openDaemonHost({
        daemonId: "origin-b",
        userRoot: userRootB,
        runtimeCredentialPort: vaultB.port,
        openCell: openBootstrappedRepoCell,
        runtimeDiscover: () => [
          {
            installationId: "installation-codex",
            kindId: "codex",
            executablePath,
            version: "1.0.0",
            observedAt: "2026-09-02T00:00:00.000Z",
          },
        ],
        runtimeLaunch: (_prepared, persistence) => {
          appendRuntimeWorkerRecord(repoRoot, persistence.dispatchId, { kind: "process_started", pid: worker.pid });
          return {
            ...worker,
            onOutput: (listener) => {
              providerOutput = listener;
              queueMicrotask(() =>
                listener(`${JSON.stringify({ type: "thread.started", thread_id: "proxy-provider-session" })}\n`),
              );
            },
            onErrorOutput: () => undefined,
            onExit: () => undefined,
          };
        },
      }),
      tcpB = daemonTcpTransport(hostB, uid),
      hostA = await openDaemonHost({
        daemonId: "proxy-a",
        userRoot: userRootA,
        runtimeCredentialPort: vaultA.port,
        runtimeDiscover: () => [
          {
            installationId: "installation-codex",
            kindId: "codex",
            executablePath,
            version: "fixture",
            observedAt: "2026-10-02T00:00:00.000Z",
          },
        ],
      }),
      transportA = createUnixSocketTransportServer({
        daemonId: "proxy-a",
        socketPath: endpointA,
        createProtocolServer: (authContext, emit) =>
          createJsonRpcProtocolServer({ host: hostA, build: daemonBuildStamp(), authContext, emit }),
      });
    await hostB.attachmentsSettled();
    await tcpB.start();
    await transportA.start();
    t.after(async () => {
      await transportA.stop();
      await tcpB.stop();
      await hostA.close();
      await hostB.close();
      rmSync(parent, { recursive: true, force: true });
    });
    const rpcA = (method: string, params: Record<string, unknown>) =>
        requestDaemonJsonRpcAt(endpointA, method, params, 2_000, 5_000),
      rpcB = (method: string, params: Record<string, unknown>) =>
        requestDaemonJsonRpcAt(tcpB.endpoint, method, params, 2_000, 5_000);

    await t.test("Goal 1-2: isolated A registers B by TCP endpoint without a root", async () => {
      const runCli = async (args: readonly string[]) => {
        const receipts: Record<string, unknown>[] = [],
          exit = await runDaemonControl(
            ["daemon", ...args, "--user-root", userRootA, "--daemon-id", "proxy-a"],
            (receipt) => receipts.push(receipt),
          );
        assert.equal(exit, 0, `${args.join(" ")}: ${JSON.stringify(receipts)}`);
        return receipts[0]!;
      };
      const add = await runCli(["connection", "add", "--connection", "server-b", "--endpoint", tcpB.endpoint]),
        update = await runCli(["connection", "update", "--connection", "server-b", "--display-name", "Server B"]),
        probe = await runCli(["connection", "probe", "--endpoint", tcpB.endpoint]),
        remove = await runCli(["connection", "remove", "--connection", "server-b"]);
      assert.deepEqual(
        [add.command, update.command, probe.command, remove.command],
        ["daemon-connection-add", "daemon-connection-update", "daemon-connection-probe", "daemon-connection-remove"],
      );
      for (const result of [add, update, probe, remove]) {
        assert.equal(result.ok, true);
        assert.equal((result.authorizationDecision as Record<string, unknown>).outcome, "allowed");
      }
      await runCli(["connection", "add", "--connection", "server-b", "--endpoint", tcpB.endpoint]);
      const receipt = await runCli([
        "repo",
        "register",
        "--repo-id",
        repoId,
        "--mode",
        "remote-proxy",
        "--endpoint",
        tcpB.endpoint,
      ]);
      assert.equal((receipt.repo as Record<string, unknown>).canonicalRoot, null);
      assert.equal((receipt.repo as Record<string, unknown>).mode, "remote-proxy");
      assert.equal(hostA.status().repos.find((repo) => repo.repoId === repoId)?.mode, "remote-proxy");
      assert.equal(hostA.status().repos.find((repo) => repo.repoId === repoId)?.rootDir, "");
      assert.equal(hostA.status().repos.find((repo) => repo.repoId === repoId)?.state, "closed");
      assert.equal(hostA.status().repos.find((repo) => repo.repoId === repoId)?.generation, null);
      const system = await rpcA("daemon.gui.system.read", {}),
        row = (system.repos as Array<Record<string, unknown>>).find((repo) => repo.repoId === repoId);
      assert.equal(row?.canonicalRoot, null);
      assert.equal(row?.cellState, "not_loaded");
    });

    await t.test("Goal 3: GUI reads and a write reach B and preserve its receipt", async () => {
      const settings = await rpcA("repo.settings.read", { repo: { repoId } });
      assert.equal(settings.schema, "daemon.settings-read/v1");
      const created = await rpcA("repo.task.create", {
        repo: { repoId },
        payload: { taskId: "task_proxy_round_trip", title: "Proxy round trip" },
      });
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      const listA = await rpcA("repo.tasks.list", { repo: { repoId }, payload: {} }),
        listB = await rpcB("repo.tasks.list", { repo: { repoId }, payload: {} });
      assert.equal(
        (listA.rows as Array<Record<string, unknown>>).some((row) => row.taskId === "task_proxy_round_trip"),
        true,
      );
      assert.deepEqual(listA, listB);
      const publication = await rpcA("repo.task.read", {
        repo: { repoId },
        payload: {
          action: {
            kind: "receipt-show",
            opId: created.opId,
            waitFor: ["git_verified", "worktree_visible"],
            timeoutMs: 4000,
          },
        },
      });
      assert.equal((publication.wait as { state?: string })?.state, "satisfied", JSON.stringify(publication));
      const document = await rpcA("repo.tasks.document.read", {
        repo: { repoId },
        payload: { taskId: "task_proxy_round_trip", path: "INDEX.md" },
      });
      assert.match(String(document.worktreeBody), /Proxy round trip/u);
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=",
        "base64",
      );
      const artifactRoot = path.join(repoRoot, "harness", String(created.packagePath), "artifacts");
      mkdirSync(artifactRoot, { recursive: true });
      writeFileSync(path.join(artifactRoot, "remote-preview.png"), png);
      const binary = await rpcA("repo.tasks.document.read", {
        repo: { repoId },
        payload: { taskId: "task_proxy_round_trip", path: "artifacts/remote-preview.png" },
      });
      assert.equal(binary.contentKind, "binary");
      assert.equal(binary.mediaType, "image/png");
      assert.deepEqual(
        Buffer.from(String(binary.bytes), "base64"),
        png,
        "remote GUI read must preserve server-only image bytes across A to B",
      );

      assert.equal((await rpcA("repo.artifacts.list", { repo: { repoId }, payload: {} })).ok, true);
      assert.equal((await rpcA("daemon.connection.probe", { endpoint: tcpB.endpoint })).ok, true);
    });

    await t.test("Provider GUI replacement writes the selected B vault and leaves same-id A unchanged", async () => {
      const apiKeyA = "fixture-remote-key-a",
        apiKeyB = "fixture-remote-key-b";
      const payload = {
        instanceId: "same-provider",
        name: "Same provider",
        kindId: "codex",
        installationId: "installation-codex",
        providerId: "fixture",
        models: ["gpt-proxy"],
        authMode: "api-key",
        apiKey: apiKeyA,
      };
      assert.equal((await rpcA("daemon.runtimeInstance.create", { payload })).ok, true);
      const names = ["HARNESS_DAEMON_USER_ROOT", "HARNESS_DAEMON_ID", "HARNESS_DAEMON_ENDPOINT"] as const,
        previous = names.map((name) => process.env[name]);
      process.env.HARNESS_DAEMON_USER_ROOT = userRootA;
      process.env.HARNESS_DAEMON_ID = "proxy-a";
      delete process.env.HARNESS_DAEMON_ENDPOINT;
      try {
        const gui = createLocalGuiServiceBridge();
        assert.equal(
          (
            (await gui.invoke(
              "daemon.runtimeInstance.create",
              scopedRpcParams("daemon.runtimeInstance.create", { ...payload, repoId }),
            )) as Record<string, unknown>
          ).ok,
          true,
        );
        const receipt = (await gui.invoke(
          "daemon.runtimeInstance.update",
          scopedRpcParams("daemon.runtimeInstance.update", {
            repoId,
            instanceId: "same-provider",
            apiKey: apiKeyB,
          }),
        )) as Record<string, unknown>;
        assert.equal(receipt.ok, true, JSON.stringify(receipt));
        assert.equal(receipt.credentialChanged, true);
        const list = await gui.invoke(
          "daemon.runtimeInstance.list",
          scopedRpcParams("daemon.runtimeInstance.list", { repoId, all: true }),
        );
        assert.doesNotMatch(JSON.stringify([receipt, list]), /fixture-remote-key-[ab]/u);
        assert.deepEqual([...vaultA.secrets.values()], [apiKeyA]);
        assert.deepEqual([...vaultB.secrets.values()], [apiKeyB]);
        registerDaemonRepo({
          userRoot: userRootA,
          repoId: "unsafe-provider",
          mode: "remote-proxy",
          endpoint: "tcp://192.0.2.1:9911",
          createConvenienceLinks: false,
        });
        const rejected = (await gui.invoke(
          "daemon.runtimeInstance.update",
          scopedRpcParams("daemon.runtimeInstance.update", {
            repoId: "unsafe-provider",
            instanceId: "same-provider",
            apiKey: apiKeyA,
          }),
        )) as Record<string, unknown>;
        assert.equal(rejected.code, "runtime_credential_transport_unsafe");
        assert.doesNotMatch(JSON.stringify(rejected), /fixture-remote-key-[ab]/u);
        assert.deepEqual([...vaultA.secrets.values()], [apiKeyA]);
        assert.deepEqual([...vaultB.secrets.values()], [apiKeyB]);
        const unknown = await rpcA("daemon.runtimeInstance.update", {
          repo: { repoId: "missing-provider" },
          payload: { instanceId: "same-provider", apiKey: apiKeyB },
        });
        assert.equal(unknown.code, "repo_namespace_unknown");
      } finally {
        names.forEach((name, index) => {
          if (previous[index] === undefined) delete process.env[name];
          else process.env[name] = previous[index];
        });
      }
    });

    await rpcB("daemon.runtimeInstance.create", {
      payload: {
        instanceId: "proxy-codex",
        name: "Proxy Codex",
        kindId: "codex",
        installationId: "installation-codex",
        providerId: "openai",
        models: ["gpt-proxy"],
        authMode: "subscription",
      },
    });
    const projectAccess = await rpcB("repo.settings.update", {
      repo: { repoId },
      payload: { runtimeAllowedInstances: ["proxy-codex"], expectedVersion: 1, idempotencyKey: "allow-proxy-codex" },
    });
    assert.equal(projectAccess.outcome, "applied", JSON.stringify(projectAccess));
    const spawned = await rpcA("repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "proxy-codex",
        model: "gpt-proxy",
        cwd: { scope: "repo-root" },
        prompt: "Observe the proxy.",
        taskId: null,
        dispatchKey: "proxy-runtime",
      },
    });
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const runtimeSessionId = String(spawned.runtimeSessionId),
      streamValues: Record<string, unknown>[] = [],
      streamArrivals = new Set<() => void>();
    const waitForStreamValue = (predicate: (value: Record<string, unknown>) => boolean) =>
      waitForArrival(
        () =>
          streamValues.some(
            (value) => predicate(value) || (Array.isArray(value.events) && value.events.some(predicate)),
          )
            ? true
            : null,
        (arrive) => {
          streamArrivals.add(arrive);
          return () => streamArrivals.delete(arrive);
        },
      );
    await waitForDurableCondition(async () => {
      const overview = await rpcA("repo.agentRuntime.overview", { repo: { repoId }, payload: {} });
      return JSON.stringify(overview).includes("proxy-provider-session");
    });
    const detach = await streamDaemonFacetAt({
      socketPath: endpointA,
      repoId,
      method: "repo.agentRuntime.attach",
      payload: { runtimeSessionId },
      timeoutMs: 2_000,
      onValue: (value) => {
        streamValues.push(value as Record<string, unknown>);
        for (const wake of streamArrivals) wake();
      },
    });
    t.after(detach);

    await t.test("Goal 3 stream: A receives B runtime events", async () => {
      providerOutput?.(
        `${JSON.stringify({ type: "item.completed", item: { id: "live", type: "agent_message", text: "live proxy event" } })}\n`,
      );
      await waitForStreamValue((value) => value.content === "live proxy event");
    });

    await t.test(
      "Goal 4: unavailable is explicit and the existing stream budget reconnects after B restarts",
      async () => {
        await tcpB.stop();
        const unavailable = await rpcA("repo.settings.read", { repo: { repoId } });
        assert.equal(unavailable.ok, false);
        assert.equal(unavailable.code, "remote_proxy_unavailable");
        providerOutput?.(
          `${JSON.stringify({ type: "item.completed", item: { id: "offline", type: "agent_message", text: "replayed after restart" } })}\n`,
        );
        await tcpB.start();
        await waitForStreamValue((value) => value.content === "replayed after restart");
        assert.equal((await rpcA("repo.settings.read", { repo: { repoId } })).ok, true);
      },
    );

    await t.test("Goal 5: A rejects local bootstrap and local control authority for a proxy repo", async () => {
      const external = await rpcA("daemon.rbac.manage", { repoId, operation: "health", mode: "external" });
      assert.equal(external.ok, false);
      assert.equal(
        external.code,
        "local_transport_required",
        "a read operation cannot carry external configuration through the proxy",
      );
      const bootstrap = await rpcA("daemon.repo.bootstrap", {
        repoId,
        rootDir: path.join(parent, "must-not-exist"),
        personId: "owner",
        displayName: "No local bootstrap",
      });
      assert.equal(bootstrap.ok, false);
      assert.equal(bootstrap.code, "repo_mode_remote_proxy");
      const control = await rpcA("daemon.gui.control.request", {
        payload: { kind: "refresh", authorityRepoId: repoId },
      });
      assert.equal(control.ok, false);
      assert.equal(control.code, "repo_mode_remote_proxy");
    });

    await t.test("Goal 6: a protocol outside the supported window fails without compatibility", async () => {
      const mismatch = await mismatchEndpoint();
      t.after(mismatch.close);
      registerDaemonRepo({
        userRoot: userRootA,
        repoId: "mismatch-repo",
        mode: "remote-proxy",
        endpoint: mismatch.endpoint,
        createConvenienceLinks: false,
      });
      const response = await rpcA("repo.settings.read", { repo: { repoId: "mismatch-repo" } });
      assert.equal(response.ok, false);
      assert.equal(response.code, "incompatible_protocol_version");
      const freshProxy = openRemoteProxyManager(userRootA);
      try {
        await assert.rejects(
          freshProxy.stream("mismatch-repo", "repo.agentRuntime.attach", {
            runtimeSessionId: "mismatch",
          }),
          { code: "incompatible_protocol_version" },
        );
      } finally {
        freshProxy.close();
      }
    });
  },
);

test(
  "local remote-proxy shutdown emits daemon_stopping, preserves cursor handoff, and distinguishes EOF and detach",
  { timeout: 30_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-remote-proxy-stop-")),
      repoId = "proxy-handoff-repo",
      repoRoot = path.join(parent, "repo-b"),
      userRootA = path.join(parent, "user-a"),
      userRootB = path.join(parent, "user-b"),
      endpointA = localUserDaemonEndpoint(userRootA, "proxy-a"),
      uid = process.getuid?.() ?? 0,
      executablePath = writeProviderExecutable(
        path.join(parent, "codex-stub.mjs"),
        "if (process.argv[2] === '--version') console.log('codex-stub 1.0.0');\n",
      );
    signInPolicyTestUser(userRootA, "owner", [repoId], "admin");
    signInPolicyTestUser(userRootB, "owner", [repoId], "admin");
    initRepo(repoRoot, repoId, uid);
    registerBootstrappedDaemonRepo({
      canonicalRoot: repoRoot,
      repoId,
      userRoot: userRootB,
      createConvenienceLinks: false,
    });
    const workers: ReturnType<typeof runtimeProcessFixture>[] = [],
      outputs: Array<(chunk: string) => void> = [],
      attachCursorsOnB: Array<RuntimeStreamCursor | undefined> = [],
      attachNotifiers = new Set<() => void>();
    let launchIndex = 0;
    const hostB = await openDaemonHost({
        daemonId: "origin-b",
        userRoot: userRootB,
        runtimeCredentialPort: providerVault().port,
        openCell: openBootstrappedRepoCell,
        runtimeDiscover: () => [
          {
            installationId: "installation-codex",
            kindId: "codex",
            executablePath,
            version: "1.0.0",
            observedAt: "2026-09-02T00:00:00.000Z",
          },
        ],
        runtimeLaunch: (_prepared, persistence) => {
          const worker = workers[launchIndex++]!;
          appendRuntimeWorkerRecord(repoRoot, persistence.dispatchId, { kind: "process_started", pid: worker.pid });
          return {
            ...worker,
            onOutput: (listener) => {
              outputs.push(listener);
              queueMicrotask(() =>
                listener(`${JSON.stringify({ type: "thread.started", thread_id: `proxy-session-${launchIndex}` })}\n`),
              );
            },
            onErrorOutput: () => undefined,
          };
        },
      }),
      observedHostB: DaemonHost = {
        ...hostB,
        attach: (repo, sessionId, cursor, auth) => {
          attachCursorsOnB.push(cursor);
          for (const wake of attachNotifiers) wake();
          return hostB.attach(repo, sessionId, cursor, auth);
        },
      },
      tcpB = daemonTcpTransport(observedHostB, uid);
    await hostB.attachmentsSettled();
    await tcpB.start();
    const openProxyDaemon = async (endFrames: JsonObject[]) => {
      const host = await openDaemonHost({
          daemonId: "proxy-a",
          userRoot: userRootA,
          runtimeCredentialPort: providerVault().port,
          runtimeDiscover: () => [
            {
              installationId: "installation-codex",
              kindId: "codex",
              executablePath,
              version: "fixture",
              observedAt: "2026-10-02T00:00:00.000Z",
            },
          ],
        }),
        transport = createUnixSocketTransportServer({
          daemonId: "proxy-a",
          socketPath: endpointA,
          createProtocolServer: (authContext, emit) =>
            createJsonRpcProtocolServer({
              host,
              build: daemonBuildStamp(),
              authContext,
              emit: async (method, params) => {
                await emit(method, params);
                if (method === "repo.agentRuntime.attach.frame.end") endFrames.push(params);
              },
            }),
        });
      await transport.start();
      return {
        close: async () => {
          await host.close();
          await transport.stop();
        },
      };
    };
    const endFramesA1: JsonObject[] = [],
      endFramesA2: JsonObject[] = [];
    let proxyA1: { readonly close: () => Promise<void> } | undefined = await openProxyDaemon(endFramesA1);
    t.after(async () => {
      await proxyA1?.close();
      await tcpB.stop();
      await hostB.close();
      rmSync(parent, { recursive: true, force: true });
    });
    workers.push(runtimeProcessFixture(t), runtimeProcessFixture(t));

    registerDaemonRepo({
      userRoot: userRootA,
      repoId,
      mode: "remote-proxy",
      endpoint: tcpB.endpoint,
      createConvenienceLinks: false,
    });
    const rpcB = (method: string, params: Record<string, unknown>) =>
      requestDaemonJsonRpcAt(tcpB.endpoint, method, params, 2_000, 5_000);
    await rpcB("daemon.runtimeInstance.create", {
      payload: {
        instanceId: "proxy-codex",
        name: "Proxy Codex",
        kindId: "codex",
        installationId: "installation-codex",
        providerId: "openai",
        models: ["gpt-proxy"],
        authMode: "subscription",
      },
    });
    assert.equal(
      (
        await rpcB("repo.settings.update", {
          repo: { repoId },
          payload: { runtimeAllowedInstances: ["proxy-codex"], expectedVersion: 1, idempotencyKey: "allow-handoff" },
        })
      ).outcome,
      "applied",
    );
    const spawn = async (dispatchKey: string) => {
      const receipt = await rpcB("repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: "proxy-codex",
          model: "gpt-proxy",
          cwd: { scope: "repo-root" },
          prompt: `Run ${dispatchKey}`,
          taskId: null,
          dispatchKey,
        },
      });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      return String(receipt.runtimeSessionId);
    };
    const session1 = await spawn("handoff-1"),
      session2 = await spawn("handoff-2");
    await waitForDurableCondition(async () => {
      const overview = await rpcB("repo.agentRuntime.overview", { repo: { repoId }, payload: {} });
      return (
        JSON.stringify(overview).includes("proxy-session-1") && JSON.stringify(overview).includes("proxy-session-2")
      );
    });

    const received: Array<{
        readonly type?: string;
        readonly content?: string;
        readonly cursor?: RuntimeStreamCursor;
      }> = [],
      failures: DaemonStreamFailure[] = [],
      arrivals = new Set<() => void>();
    const waitForFrame = (predicate: (frame: (typeof received)[number]) => boolean) =>
      waitForArrival(
        () => received.find(predicate) ?? null,
        (arrive) => {
          arrivals.add(arrive);
          return () => arrivals.delete(arrive);
        },
      );
    const detachClient = await streamAgentRuntimeAt({
      socketPath: endpointA,
      repoId,
      payload: { runtimeSessionId: session1 },
      timeoutMs: 2_000,
      onValue: (value) => {
        const frames = "ok" in value ? (value.ok ? value.events : []) : [value];
        for (const frame of frames) received.push(frame);
        for (const wake of arrivals) wake();
      },
      onClosed: (failure) => failures.push(failure),
    });
    t.after(detachClient);

    outputs[0]!(
      `${JSON.stringify({ type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "before A1 stop" } })}\n`,
    );
    const firstFrame = await waitForFrame((frame) => frame.content === "before A1 stop");
    const appliedCursor = firstFrame.cursor!;

    await proxyA1.close();
    proxyA1 = undefined;
    assert.deepEqual(endFramesA1, [{ code: "daemon_stopping" }]);
    assert.deepEqual(failures, []);

    const proxyA2 = await openProxyDaemon(endFramesA2);
    t.after(() => proxyA2.close());
    await waitForArrival(
      () => (attachCursorsOnB.length >= 2 ? true : null),
      (arrive) => {
        attachNotifiers.add(arrive);
        return () => attachNotifiers.delete(arrive);
      },
    );
    assert.deepEqual(attachCursorsOnB[1], appliedCursor);

    outputs[0]!(
      `${JSON.stringify({ type: "item.completed", item: { id: "msg-2", type: "agent_message", text: "after A2 handoff" } })}\n`,
    );
    const secondFrame = await waitForFrame((frame) => frame.content === "after A2 handoff");
    assert.equal(secondFrame.cursor!.streamEpoch, appliedCursor.streamEpoch);
    assert.equal(secondFrame.cursor!.seq, appliedCursor.seq + 1);
    assert.equal(
      received.filter((frame) => frame.content === "before A1 stop").length,
      1,
      "cursor resume must not replay already applied frames",
    );

    workers[0]!.exit(0);
    await waitForFrame((frame) => frame.type === "exit");
    await waitForArrival(
      () => (endFramesA2.length > 0 ? true : null),
      (arrive) => {
        const timer = setInterval(arrive, 25);
        return () => clearInterval(timer);
      },
    );
    assert.deepEqual(endFramesA2, [{}]);
    assert.deepEqual(failures, []);

    const directClosingProxy = openRemoteProxyManager(userRootA);
    try {
      const sub = await directClosingProxy.stream(repoId, "repo.agentRuntime.attach", {
        runtimeSessionId: session2,
      });
      const pendingNext = sub.next();
      directClosingProxy.close();
      await assert.rejects(pendingNext, { code: "daemon_stopping" });
      await assert.rejects(
        directClosingProxy.stream(repoId, "repo.agentRuntime.attach", { runtimeSessionId: session2 }),
        { code: "daemon_stopping" },
      );
    } finally {
      directClosingProxy.close();
    }

    const callerCancelProxy = openRemoteProxyManager(userRootA);
    try {
      const callerAbort = new AbortController();
      const subBySignal = await callerCancelProxy.stream(
        repoId,
        "repo.agentRuntime.attach",
        { runtimeSessionId: session2 },
        callerAbort.signal,
      );
      const pendingBySignal = subBySignal.next();
      callerAbort.abort();
      assert.equal(await pendingBySignal, null);

      const subByDetach = await callerCancelProxy.stream(repoId, "repo.agentRuntime.attach", {
        runtimeSessionId: session2,
      });
      const pendingByDetach = subByDetach.next();
      subByDetach.detach();
      assert.equal(await pendingByDetach, null);

      callerCancelProxy.close();
    } finally {
      callerCancelProxy.close();
    }

    const naturalEndProxy = openRemoteProxyManager(userRootA);
    try {
      const sub = await naturalEndProxy.stream(repoId, "repo.agentRuntime.attach", {
        runtimeSessionId: session2,
      });
      workers[1]!.exit(0);
      const frames: JsonObject[] = [];
      for (;;) {
        const frame = await sub.next();
        if (frame === null) break;
        frames.push(frame);
      }
      assert.equal(
        frames.some((frame) => frame.type === "exit"),
        true,
        `expected natural exit frame before EOF, got ${JSON.stringify(frames)}`,
      );
      naturalEndProxy.close();
      assert.equal(await sub.next(), null);
    } finally {
      naturalEndProxy.close();
    }
  },
);

function daemonTcpTransport(host: DaemonHost, ownerUid: number) {
  let server: net.Server | undefined,
    port = 0;
  const connections = new Set<DaemonTransportConnection>();
  return {
    get endpoint() {
      if (port === 0) throw new Error("TCP daemon is not started");
      return `tcp://127.0.0.1:${port}`;
    },
    start: async () => {
      if (server) return;
      server = net.createServer((socket) => {
        const connection = serveJsonRpcStream({
          input: socket,
          output: socket,
          transportKind: "unix-socket",
          authContext: {
            transportKind: "unix-socket",
            unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" },
          },
          createProtocolServer: (authContext, emit) =>
            createJsonRpcProtocolServer({ host, build: daemonBuildStamp(), authContext, emit }),
        });
        connections.add(connection);
        socket.once("close", () => connections.delete(connection));
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(port, "127.0.0.1", () => {
          server!.off("error", reject);
          const address = server!.address();
          if (typeof address !== "object" || address === null) reject(new Error("TCP endpoint has no port"));
          else {
            port = address.port;
            resolve();
          }
        });
      });
    },
    stop: async () => {
      if (!server) return;
      await Promise.all([...connections].map((connection) => connection.close()));
      const closing = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => closing.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function providerVault() {
  const secrets = new Map<string, string>();
  let serial = 0;
  const port: CredentialPort = {
    issue: () => `credential:v1:remote-fixture-${++serial}`,
    store: async (reference, secret) => {
      secrets.set(reference, secret);
    },
    resolve: async (reference) => secrets.get(reference) ?? "",
    remove: async (reference) => {
      secrets.delete(reference);
    },
  };
  return { port, secrets };
}

async function mismatchEndpoint(): Promise<{ endpoint: string; close: () => void }> {
  const sockets = new Set<net.Socket>(),
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const lines = createInterface({ input: socket });
      lines.on("line", (line) => {
        const request = JSON.parse(line) as { readonly id: number; readonly method: string };
        if (request.method === "protocol.hello")
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                ok: true,
                protocolVersion: { ...currentDaemonProtocolVersion, major: currentDaemonProtocolVersion.major + 1 },
                methods: [],
                build: {},
              },
            })}\n`,
          );
      });
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("mismatch server has no port");
  return {
    endpoint: `tcp://127.0.0.1:${address.port}`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

function initRepo(root: string, repoId: string, uid: number): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Remote Proxy Test");
  git(root, "config", "user.email", "remote-proxy@example.invalid");
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `${JSON.stringify(
      {
        schema: "harness-people/v1",
        people: [
          {
            personId: "owner",
            displayName: "Owner",
            roles: ["owner"],
            credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }],
          },
        ],
        roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write", "admin", "arbiter"] }],
      },
      null,
      2,
    )}\n`,
  );
  git(root, "add", "harness");
  git(root, "commit", "-qm", "init");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}
