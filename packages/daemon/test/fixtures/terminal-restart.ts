import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { localUserDaemonEndpoint } from "../../src/daemon-host/client/local-daemon-target.ts";
import type { DaemonHost } from "../../src/daemon-host/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../../src/daemon-host/protocol/json-rpc-server.ts";
import type { JsonObject } from "../../src/daemon-host/protocol/json-rpc-types.ts";
import { openTerminalHost } from "../../src/daemon-host/terminal-host.ts";
import { createUnixSocketTransportServer } from "../../src/daemon-host/transport/unix-socket.ts";

export async function startTerminalRestartFixture(repoId: string) {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-terminal-restart-"))),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    daemonId = "terminal-restart",
    socketPath = localUserDaemonEndpoint(userRoot, daemonId),
    writes: Array<{ generation: number; utf8: string }> = [],
    attached: Array<{ generation: number; afterSeq: number; daemonGeneration?: number }> = [],
    ended = Promise.withResolvers<JsonObject>();
  mkdirSync(rootDir);
  mkdirSync(userRoot);
  writeFileSync(
    path.join(userRoot, "registry.json"),
    JSON.stringify({
      schema: "harness-daemon-registry/v2",
      connections: [{ id: "local", kind: "local", displayName: "This device", state: "enabled" }],
      repos: [
        {
          repoId,
          canonicalRoot: rootDir,
          displayName: "Terminal restart",
          authoredBranch: "main",
          mode: "local",
          connectionId: "local",
          state: "enabled",
          registeredAt: "2026-11-19T00:00:00.000Z",
        },
      ],
    }),
  );

  let namespace: string | null = null;
  function startHost(generation: number) {
    const terminal = openTerminalHost({
      repoId,
      rootDir,
      daemonGeneration: generation,
      platform: "linux",
      resolveTerminalEnvironment: () => ({}),
      tmux: {
        probe: () => ({ available: true, executable: "/test/tmux" }),
        hasSession: (_executable, name) => namespace === name,
        killSession: () => {
          namespace = null;
        },
      },
      spawnPty: (_file, args) => {
        assert.ok(Array.isArray(args));
        if (args[1] === "new-session") namespace = args[4]!;
        else assert.equal(args[3], namespace, "the restored PTY must attach to the same tmux session");
        let output: ((utf8: string) => void) | undefined;
        return {
          onData: (listener: NonNullable<typeof output>) => {
            output = listener;
            if (generation === 8) output("reattached:");
          },
          onExit: () => undefined,
          write: (utf8: string) => {
            writes.push({ generation, utf8 });
            assert.ok(output);
            output(utf8);
          },
          kill: () => undefined,
        } as ReturnType<NonNullable<Parameters<typeof openTerminalHost>[0]["spawnPty"]>>;
      },
    });
    const host = {
      read: async () => terminal.list(),
      terminalAttach: async (_repoId, { sessionId, afterSeq, daemonGeneration }) => {
        attached.push({ generation, afterSeq, daemonGeneration });
        return terminal.attach(sessionId, afterSeq, daemonGeneration);
      },
      terminalAction: async (_repoId, method, payload) => {
        if (method === "repo.terminal.input") return terminal.input(payload);
        if (method === "repo.terminal.detach") return terminal.detach(payload);
        throw new Error(`Unexpected action ${method}`);
      },
    } satisfies Pick<DaemonHost, "read" | "terminalAttach" | "terminalAction">;
    const transport = createUnixSocketTransportServer({
      daemonId,
      socketPath,
      createProtocolServer: (authContext, emit, _connectionId, connectionSignal) =>
        createJsonRpcProtocolServer({
          host: host as DaemonHost,
          build: { loadedBuildId: null, commit: null, builtAt: null },
          authContext: { ...authContext, connectionSignal },
          emit: async (method, params) => {
            await emit(method, params);
            if (generation === 7 && method === "repo.terminal.attach.frame.end") ended.resolve(params);
          },
        }),
    });
    return { terminal, transport };
  }

  let active = startHost(7),
    listening = false;
  async function stopListening() {
    if (!listening) return;
    listening = false;
    await active.transport.stop();
  }
  const { sessionId } = active.terminal.spawn({
    backend: "tmux",
    idempotencyKey: "restart",
    shellProfileId: "sh",
    cwd: { scope: "repo-root" },
  });
  assert.ok(sessionId);
  await active.transport.start();
  listening = true;
  return {
    rootDir,
    parent,
    sessionId,
    writes,
    attached,
    env: {
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_DAEMON_ID: daemonId,
      HARNESS_DAEMON_REPO_ID: repoId,
      HARNESS_DAEMON_ENDPOINT: socketPath,
    },
    restart: async () => {
      await active.terminal.close();
      try {
        const end = await Promise.race([ended.promise, delay(5_000, undefined, { ref: false })]);
        assert.deepEqual(end, { code: "daemon_stopping" });
      } finally {
        await stopListening();
      }
      active = startHost(8);
      await active.transport.start();
      listening = true;
    },
    close: async () => {
      try {
        await stopListening();
        await active.terminal.close();
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  };
}
