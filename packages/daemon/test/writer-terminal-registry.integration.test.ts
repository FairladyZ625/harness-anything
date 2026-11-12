// harness-test-tier: integration
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openTerminalHost } from "../src/terminal-host.ts";
import { loadTmuxSessionRegistry } from "../src/terminal-session-store.ts";
import { openWriterSupervisor, WRITER_IDLE_TIMEOUT_MS } from "../src/writer-supervisor.ts";
import { policyTestCenter, provisionPolicyTestRepository } from "./keycloak-policy.fixtures.ts";
import { fixtureFence, settleSettingsEvent } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

test(
  "writer retirement and drain preserve the host's newer durable terminal sessions",
  { timeout: 120_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const rootDir = canonicalRoot(mkdtempSync(path.join(tmpdir(), "ha-writer-terminal-registry-"))),
      repoId = workspaceId("writer-terminal-registry"),
      registry = path.join(rootDir, ".harness", "generated", "terminal-sessions.json"),
      workers: Worker[] = [],
      attempts: Promise<unknown>[] = [];
    let supervisor: Awaited<ReturnType<typeof openWriterSupervisor>> | undefined,
      host: ReturnType<typeof openTerminalHost> | undefined;
    const openHost = () => openTerminalHost({ repoId, rootDir, daemonGeneration: 1, ...terminalFixture() }),
      spawn = (owner: ReturnType<typeof openTerminalHost>, name: string) =>
        owner.spawn({ idempotencyKey: name, name, backend: "tmux", cwd: { scope: "repo-root" } });
    const assertRecoverable = async (phase: string, names: string[]) => {
      const stored = loadTmuxSessionRegistry(registry)
        .map((session) => session.name)
        .sort();
      t.diagnostic(JSON.stringify({ phase, stored }));
      assert.deepEqual(stored, names, "writer lifecycle must preserve the host's complete durable registry");
      // Open before the existing host closes or persists again: this is the recovery window
      // after a host crash, when only the on-disk registry can discover surviving tmux sessions.
      const restored = openHost();
      try {
        const rows = restored.list().sessions as { name: string; status: string; attachable: boolean }[];
        assert.deepEqual(rows.map((row) => row.name).sort(), names);
        assert.ok(rows.every((row) => row.status === "running" && row.attachable));
      } finally {
        await restored.close();
      }
    };
    const retire = async () => {
      const worker = workers.at(-1)!;
      while (worker.threadId !== -1) {
        const first = attempts.length;
        t.mock.timers.tick(WRITER_IDLE_TIMEOUT_MS);
        assert.ok(attempts.length > first, "the idle deadline must request hibernation");
        await Promise.all(attempts.slice(first));
        // A restoring background owner may veto the first deadline. Advance from the actual
        // hibernation receipt and an event turn, never from a wall-clock sleep.
        if (worker.threadId !== -1) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    try {
      initRepo(rootDir);
      provisionPolicyTestRepository(repoId);
      const fence = fixtureFence(repoId, rootDir, path.join(rootDir, ".harness", "fixture-writer-epochs"));
      await settleSettingsEvent({ repoId, rootDir, writerEpochFence: fence });
      const seed = openHost();
      spawn(seed, "A");
      await seed.close();
      host = openHost();
      supervisor = await openWriterSupervisor(
        {
          repoId,
          rootDir,
          ownerId: "terminal-registry",
          defaultWriterEpochFence: fence,
          keycloakCenter: policyTestCenter,
        },
        {
          createWorker: (url, options) => {
            const worker = new Worker(url, {
              ...options,
              execArgv: [
                ...options.execArgv,
                "--import",
                new URL("./fixtures/writer-terminal-registry.mjs", import.meta.url).href,
              ],
            });
            const exited = once(worker, "exit"),
              post = worker.postMessage.bind(worker);
            worker.postMessage = (message: unknown, transferList) => {
              const control = message as { command?: string; requestId?: string };
              if (control.command === "hibernate")
                attempts.push(
                  new Promise<void>((resolve) => {
                    const listener = (receipt: { requestId?: string; value?: unknown }) => {
                      if (receipt.requestId !== control.requestId) return;
                      worker.off("message", listener);
                      if (receipt.value === true) void exited.then(() => resolve());
                      else resolve();
                    };
                    worker.on("message", listener);
                  }),
                );
              post(message, transferList);
            };
            workers.push(worker);
            return worker;
          },
        },
      );
      const firstGeneration = supervisor.status().generation!;
      spawn(host, "B");
      await retire();
      await assertRecoverable("first-idle", ["A", "B"]);

      assert.equal(await supervisor.request("hasBuiltinExecutor", { claimFence: "none" }), false);
      assert.ok(supervisor.status().generation! > firstGeneration);
      spawn(host, "C");
      await retire();
      await assertRecoverable("second-idle", ["A", "B", "C"]);

      assert.equal(await supervisor.request("hasBuiltinExecutor", { claimFence: "none" }), false);
      spawn(host, "D");
      await supervisor.close();
      await assertRecoverable("drain", ["A", "B", "C", "D"]);
      assert.equal(workers.length, 3, "each wake creates exactly one successor");
      assert.ok(workers.every((worker) => worker.threadId === -1));
    } finally {
      await supervisor?.close();
      await host?.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  },
);

function terminalFixture(): Pick<Parameters<typeof openTerminalHost>[0], "tmux" | "spawnPty"> {
  return {
    tmux: {
      probe: () => ({ available: true, executable: "/fixture/tmux", version: "fixture" }),
      hasSession: () => true,
      killSession: () => {
        throw new Error("The fixture must preserve durable sessions.");
      },
    },
    spawnPty: (() => {
      let exit: ((event: { exitCode: number }) => void) | undefined;
      return {
        onData: () => ({ dispose: () => undefined }),
        onExit: (listener: typeof exit) => {
          exit = listener;
          return { dispose: () => undefined };
        },
        kill: () => exit?.({ exitCode: 0 }),
      };
    }) as never,
  };
}
