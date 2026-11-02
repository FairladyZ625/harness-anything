// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { localDefaultBinding } from "../src/daemon-host-binding.ts";
import { resolveRepoBootstrap } from "../src/repo-bootstrap.ts";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";
import { openPersistentWriterEpoch } from "@harness-anything/storage";
import { initRepo } from "./task-surface.fixtures.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";
import { readDispatchStreamHeader } from "../src/dispatch-stream.ts";
import type { RuntimeProcess } from "../src/runtime-spawn-types.ts";

for (const scenario of ["init", "delayed-write", "ended-session"] as const) {
  test(`production writer resolves the original host session for ${scenario}`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-writer-session-")),
      repoId = workspaceId("writer-session"),
      rootDir = canonicalRoot(root),
      seen: string[] = [],
      server = createServer((request, response) => {
        seen.push(request.headers.authorization ?? "");
        response.writeHead(request.headers.authorization === "Bearer live-token" ? 200 : 401, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ result: true }));
      });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as import("node:net").AddressInfo,
      authority = openPersistentWriterEpoch({ stateRoot: path.join(root, "epochs"), holderId: "session-test" }),
      lease = authority.acquire(repoId),
      fence = {
        schema: "harness-writer-epoch-fence/v1" as const,
        stateRoot: path.join(root, "epochs"),
        repoId,
        epoch: lease.epoch,
        holderId: lease.holderId,
      };
    authority.close();
    let token = scenario === "init" ? "old-token" : "live-token",
      calls = 0,
      currentPerson: string | null = "person-session",
      release!: () => void,
      requested!: () => void;
    const requestedToken = new Promise<void>((resolve) => {
        requested = resolve;
      }),
      releasedToken = new Promise<void>((resolve) => {
        release = resolve;
      }),
      auth: DaemonAuthenticationContext = {
        transportKind: "unix-socket",
        unixSocketOwnerBoundary: {
          ownerUid: process.getuid?.() ?? 0,
          source: "unix-socket-filesystem-owner-boundary",
        },
        oidcPrincipal: {
          personId: "person-session",
          subject: "subject-session",
          expiresAt: Date.now() + 60_000,
          accessToken: token,
          authority: { url: `http://127.0.0.1:${address.port}`, realm: "harness", clientId: "harness-center" },
        },
        localSessionAccessToken: async () => {
          calls += 1;
          requested();
          await releasedToken;
          return token;
        },
      };
    let supervisor: Awaited<ReturnType<typeof openWriterSupervisor>> | undefined;
    try {
      initRepo(rootDir);
      // Init exercises workerData and the first open-time authorization, rather than a helper.
      const bootstrap = resolveRepoBootstrap(
          { rootDir, repoId, personId: "person-session", displayName: "Session" },
          auth,
        ),
        opening = openWriterSupervisor({
          repoId,
          rootDir,
          ownerId: "session-test",
          bootstrap,
          defaultWriterEpochFence: fence,
          keycloakSession: async () => {
            if (currentPerson === null)
              throw Object.assign(new Error("session ended"), { code: "authentication_required" });
            return { ...auth.oidcPrincipal!.authority, personId: currentPerson, accessToken: token };
          },
        });
      if (scenario === "init") {
        await Promise.race([
          requestedToken,
          opening.then(() => {
            throw new Error("init did not resolve the host session");
          }),
        ]);
        token = "live-token";
        release();
      } else {
        token = "live-token";
        release();
      }
      supervisor = await opening;
      assert.equal((supervisor.bootstrapReceipt() as { outcome: string }).outcome, "applied");
      if (scenario === "init") {
        assert.ok(calls > 0, "init requested a current token from the host");
        assert.ok(seen.length > 0, "init authorizes through UMA");
      } else {
        const initCalls = calls;
        // Reset the synchronization barrier so the token changes after postMessage, at authorization.
        token = "old-token";
        const delayed = new Promise<void>((resolve) => {
          release = resolve;
        });
        const binding = localDefaultBinding({
          ...auth,
          localSessionAccessToken: async () => {
            calls += 1;
            requested();
            await delayed;
            if (scenario === "ended-session")
              throw Object.assign(new Error("original session ended"), { code: "authentication_required" });
            return token;
          },
        });
        const reached = new Promise<void>((resolve) => {
            requested = resolve;
          }),
          result = supervisor.request<{ outcome: string; code?: string }>(
            "run",
            { action: { kind: "task-create", taskId: "task-session", title: "Session" } },
            binding,
          );
        const umaBefore = seen.length;
        // Attach a rejection handler before waiting: DataCloneError is the pre-fix positive control.
        await Promise.race([
          reached,
          result.then(() => {
            throw new Error("write did not resolve the host session");
          }),
        ]);
        token = "live-token";
        release();
        if (scenario === "ended-session") {
          const denied = await result;
          assert.equal(denied.outcome, "op_rejected");
          assert.equal(denied.code, "authentication_required");
          assert.equal(seen.length, umaBefore, "ended sessions never send UMA");
        } else {
          assert.equal((await result).outcome, "applied");
          assert.equal(seen.length, umaBefore + 1, "one UMA call without retry");
        }
        assert.equal(calls, initCalls + 1);
      }
      if (scenario === "delayed-write") {
        // A public runtime ingress cannot borrow the daemon session for an identity-only caller.
        const runtimeBinding = {
          actor: { principal: { personId: "person-session" }, executor: null },
          source: "local" as const,
        };
        const action = {
          kind: "event",
          type: "runtime_dispatch_requested",
          opId: "runtime-session-continued",
          dispatchContext: { role: null, taskId: null, executionId: null },
          payload: {
            dispatchId: "dispatch_session_continued",
            runtimeSessionId: "runtime_session_continued",
            instanceId: "instance-session",
            installationId: "installation-session",
            kindId: "codex",
            dispatchKey: "session-continued",
            definitionSnapshotRef: "artifact:runtime-definition/session",
            definitionSnapshot: {
              schema: "agent-definition-snapshot/v1",
              configVersion: 1,
              instanceId: "instance-session",
              installationId: "installation-session",
              kindId: "codex",
              providerId: "openai",
              model: "gpt-5.6-sol",
              reasoningEffort: "high",
              baseUrl: null,
              authMode: "subscription",
            },
          },
        };
        await assert.rejects(supervisor.request("runtimeIngress", { action }, runtimeBinding), {
          code: "authorization_denied",
        });
        const acceptedUma = seen.length;
        currentPerson = "another-person";
        await assert.rejects(supervisor.request("runtimeIngress", { action }, runtimeBinding), {
          code: "authorization_denied",
        });
        currentPerson = null;
        await assert.rejects(supervisor.request("runtimeIngress", { action }, runtimeBinding), {
          code: "authorization_denied",
        });
        assert.equal(
          seen.length,
          acceptedUma,
          "changed or ended host sessions cannot borrow the original runtime owner's authority",
        );
      }
      assert.ok(seen.every((authorization) => authorization === "Bearer live-token"));
    } finally {
      release();
      await supervisor?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const exitCode of [0, 1]) {
  test(
    `a node-origin DeepSeek worker settles after its spawn RPC returns (exit=${exitCode})`,
    { timeout: 20000 },
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ha-writer-runtime-session-")),
        rootDir = canonicalRoot(root),
        repoId = workspaceId(`writer-runtime-${exitCode}`),
        terminal = Promise.withResolvers<{ payload: { runtimeSessionId: string; outcome: string } }>(),
        callbacks = new Map<string, { output?: (chunk: string) => void; exit?: (code: number | null) => void }>(),
        outcomes: string[] = [],
        server = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ result: true }));
        });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address() as import("node:net").AddressInfo,
        authority = openPersistentWriterEpoch({ stateRoot: path.join(root, "epochs"), holderId: "runtime-test" }),
        lease = authority.acquire(repoId),
        fence = {
          schema: "harness-writer-epoch-fence/v1" as const,
          stateRoot: path.join(root, "epochs"),
          repoId,
          epoch: lease.epoch,
          holderId: lease.holderId,
        },
        auth: DaemonAuthenticationContext = {
          transportKind: "unix-socket",
          unixSocketOwnerBoundary: {
            ownerUid: process.getuid?.() ?? 0,
            source: "unix-socket-filesystem-owner-boundary",
          },
          oidcPrincipal: {
            personId: "runtime-owner",
            subject: "runtime-owner",
            expiresAt: Date.now() + 60_000,
            accessToken: "original-token",
            authority: { url: `http://127.0.0.1:${address.port}`, realm: "harness", clientId: "harness-center" },
          },
          localSessionAccessToken: async () => "original-token",
        },
        definition = {
          schema: "agent-definition-snapshot/v1" as const,
          configVersion: 1,
          instanceId: "deepseek-worker",
          installationId: "deepseek-installation",
          kindId: "deepseek-harness" as const,
          providerId: "bailian",
          model: "deepseek-v4.1-flash",
          reasoningEffort: null,
          baseUrl: null,
          authMode: "api-key" as const,
        },
        installation = {
          installationId: definition.installationId,
          kindId: definition.kindId,
          executablePath: "/fixture/deepseek-harness",
          version: "1.0.0",
          observedAt: "2026-11-02T00:00:00.000Z",
        };
      authority.close();
      let supervisor: Awaited<ReturnType<typeof openWriterSupervisor>> | undefined,
        refreshes = 0;
      try {
        initRepo(rootDir);
        mkdirSync(path.join(root, "worker"));
        supervisor = await openWriterSupervisor({
          repoId,
          rootDir,
          ownerId: "runtime-test",
          defaultWriterEpochFence: fence,
          bootstrap: resolveRepoBootstrap({ rootDir, repoId, personId: "runtime-owner", displayName: "Runtime" }, auth),
          keycloakSession: async () => {
            throw new Error("node-origin runtime must not borrow the local operator");
          },
          runtimeInstances: () => [
            {
              schemaVersion: 2,
              instanceId: definition.instanceId,
              name: "DeepSeek",
              kindId: definition.kindId,
              installationId: definition.installationId,
              providerId: definition.providerId,
              models: [definition.model],
              defaultModel: definition.model,
              enabled: true,
              permissionMode: "bypass",
              codex: {},
              authMode: definition.authMode,
              authState: "configured",
              authReadiness: { status: "ready", code: null, hint: null },
              isolationState: "enforced",
            },
          ],
          prepareRuntimeLaunch: async (_instance, request) => ({
            definition,
            installation,
            executablePath: installation.executablePath,
            args: [],
            env: {},
            cwd: request.cwd,
            prompt: request.prompt,
          }),
          runtimeLaunch: (_launch, persistence): RuntimeProcess => {
            const listeners: { output?: (chunk: string) => void; exit?: (code: number | null) => void } = {};
            callbacks.set(persistence.dispatchId, listeners);
            return {
              pid: process.pid,
              onOutput: (listener) => {
                listeners.output = listener;
              },
              onErrorOutput: () => undefined,
              onExit: (listener) => {
                listeners.exit = listener;
              },
              terminate: () => undefined,
            };
          },
          onRuntimeOutcome: (event) => {
            outcomes.push(event.payload.runtimeSessionId);
            terminal.resolve(event);
          },
        });
        const binding = {
          ...localDefaultBinding({
            ...auth,
            localSessionAccessToken: async () => {
              refreshes += 1;
              return "refreshed-owner-token";
            },
          }),
          source: { kind: "node" as const, nodeId: "request-origin" },
        };
        const settings = await supervisor.request<{ outcome: string }>(
          "run",
          { action: { kind: "settings-update", runtimeAllowedInstances: [definition.instanceId] } },
          binding,
        );
        assert.equal(settings.outcome, "applied", JSON.stringify(settings));
        const spawn = (dispatchKey: string) =>
          supervisor!.request<{ runtimeSessionId: string; dispatchId: string }>(
            "spawnRuntime",
            {
              runtimeInstanceId: definition.instanceId,
              cwd: { scope: "repo-relative", path: "worker" },
              prompt: "work",
              dispatchKey,
            },
            binding,
          );
        const first = await spawn("finished"),
          live = await spawn("still-live");
        assert.notEqual(first.runtimeSessionId, live.runtimeSessionId, "both spawn RPCs returned distinct sessions");
        assert.equal(callbacks.size, 2, "both workers registered before the exit signal");
        const atReceipt = refreshes,
          completed = callbacks.get(first.dispatchId)!;
        assert.deepEqual(readDispatchStreamHeader(rootDir, first.dispatchId)?.binding?.source, binding.source);
        completed.output!(
          [
            { type: "acp.session", sessionId: "provider-session" },
            {
              type: "acp.result",
              sessionId: "provider-session",
              stopReason: "end_turn",
              finalText: "done",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          ]
            .map((frame) => JSON.stringify(frame))
            .join("\n") + "\n",
        );
        completed.exit!(exitCode);
        const observed = await terminal.promise;
        assert.equal(readDispatchStreamHeader(rootDir, first.dispatchId)?.executionOwner, "local");
        assert.equal(observed.payload.runtimeSessionId, first.runtimeSessionId);
        assert.equal(observed.payload.outcome, exitCode === 0 ? "succeeded" : "failed");
        assert.ok(refreshes > atReceipt, "exit publication refreshes the original session after the request ended");
        assert.deepEqual(outcomes, [first.runtimeSessionId], "the living sibling has no terminal outcome");
        assert.ok(callbacks.has(live.dispatchId));
      } finally {
        await supervisor?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
