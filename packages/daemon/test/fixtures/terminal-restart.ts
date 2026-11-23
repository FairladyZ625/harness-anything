import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { waitForArrival, watchDirectoryArrival } from "../../../../tools/fixtures/event-arrival.ts";
import { localUserDaemonEndpoint } from "../../src/daemon-host/client/local-daemon-target.ts";
import { requestDaemonJsonRpcAt } from "../../src/daemon-host/client/local-json-rpc-client.ts";
import { daemonConnLogFileStem } from "../../src/daemon-host/conn-log.ts";
import { readDaemonLifecycleRecords } from "../../src/daemon-host/lifecycle-log.ts";
import { startDaemon } from "../../src/daemon-host/runtime.ts";
import { openTerminalHost } from "../../src/daemon-host/terminal-host.ts";
import { createWriterRequestQueue } from "../../src/daemon-host/writer-request-queue.ts";
import { rosterRepo } from "../daemon-host-recovery.fixture.ts";
import { removeTempRepository } from "../../../../tools/fixtures/remove-temp-repository.ts";

export { fetch as daemonFixtureFetch } from "undici";

export async function startTerminalRestartFixture(repoId: string) {
  const { signInPolicyTestUser } = await import("../keycloak-policy.fixtures.ts");
  const { openBootstrappedRepoCell, registerBootstrappedDaemonRepo } = await import("../repo-settings.fixture.ts");
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-terminal-restart-"))),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    daemonId = "terminal-restart",
    socketPath = localUserDaemonEndpoint(userRoot, daemonId),
    logDir = path.join(userRoot, "logs"),
    writes: Array<{ generation: number; utf8: string }> = [],
    attached: Array<{ generation: number; afterSeq: number; daemonGeneration?: number }> = [],
    releaseWrite = Promise.withResolvers<void>();
  rosterRepo(rootDir, repoId);
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  await registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  const writer = createWriterRequestQueue({
    repoId,
    abortInFlightOnClose: false,
    terminateAborted: async (error) => {
      throw error;
    },
  });

  let namespace: string | null = null;
  function makeTerminal(generation: number) {
    return openTerminalHost({
      repoId,
      rootDir,
      daemonGeneration: generation,
      registryFilePath: path.join(parent, "terminal-sessions.json"),
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
  }

  async function startHost(generation: number, terminal: ReturnType<typeof makeTerminal>) {
    const daemon = await startDaemon({
      daemonId,
      userRoot,
      buildSupersessionEnabled: false,
      openCell: async (input) => {
        const cell = await openBootstrappedRepoCell(input);
        return {
          ...cell,
          terminal: {
            ...cell.terminal,
            list: terminal.list,
            attach: (sessionId, afterSeq, daemonGeneration) => {
              attached.push({ generation, afterSeq, daemonGeneration });
              return terminal.attach(sessionId, afterSeq, daemonGeneration);
            },
            input: terminal.input,
            detach: terminal.detach,
          },
          close: async () => {
            try {
              await terminal.close();
              if (generation === 7) await writer.close();
            } finally {
              await cell.close();
            }
          },
        };
      },
    });
    assert.ok("stop" in daemon, "the isolated daemon must own its socket");
    try {
      await waitForArrival(() => {
        const result = readDaemonLifecycleRecords(userRoot, daemonId, "current-generation").find(
          ({ event }) => event === "repo_attach_completed" || event === "repo_attach_failed",
        );
        if (!result) return null;
        assert.equal(result.event, "repo_attach_completed", JSON.stringify(result));
        return result;
      }, watchDirectoryArrival(logDir));
      const list = await requestDaemonJsonRpcAt(
        socketPath,
        "repo.terminal.sessions.list",
        { repo: { repoId } },
        2_000,
        5_000,
      );
      assert.equal(list.schema, "terminal-session-list/v1", JSON.stringify(list));
      return daemon;
    } catch (error) {
      await daemon.stop();
      throw error;
    }
  }

  const terminal = makeTerminal(7);
  const { sessionId } = terminal.spawn({
    backend: "tmux",
    idempotencyKey: "restart",
    shellProfileId: "sh",
    cwd: { scope: "repo-root" },
  });
  assert.ok(sessionId);
  let active = await startHost(7, terminal),
    restarting: Promise<void> | undefined;
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
    countStoppingAttaches: () => {
      const files = readdirSync(logDir).filter((name) => name.startsWith(daemonConnLogFileStem(daemonId)));
      return files
        .flatMap((file) => readFileSync(path.join(logDir, file), "utf8").split("\n").slice(0, -1))
        .map((line) => JSON.parse(line))
        .filter(({ method, code }) => method === "repo.terminal.attach" && code === "daemon_stopping").length;
    },
    releaseWrite: releaseWrite.resolve,
    restart: () => {
      const write = writer.request("in-flight", "terminal-restart", undefined, false, async (request) => {
        request.markDispatched();
        await releaseWrite.promise;
      });
      restarting = (async () => {
        await active.stop();
        await write;
        active = await startHost(8, makeTerminal(8));
      })();
      return restarting;
    },
    close: async () => {
      releaseWrite.resolve();
      try {
        await restarting;
      } finally {
        try {
          await active.stop();
        } finally {
          removeTempRepository(parent);
        }
      }
    },
  };
}
