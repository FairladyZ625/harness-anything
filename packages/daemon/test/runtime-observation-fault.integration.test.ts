// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import workerThreads, { type WorkerOptions } from "node:worker_threads";
import type { RuntimeProcess } from "../src/runtime-spawn-types.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { definition, installation, initIngressRepo } from "./fixtures/runtime-ingress.ts";

test(
  "an asynchronous workspace fault cannot kill the canonical writer or a sibling runtime",
  { timeout: 60_000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-writer-watch-fault-"));
    initIngressRepo(root, 0);
    const faultCwd = path.join(root, "faulted-workspace"),
      siblingCwd = path.join(root, "sibling-workspace"),
      watcherReady = path.join(root, "watcher-ready");
    mkdirSync(faultCwd);
    mkdirSync(siblingCwd);
    const originalWorker = workerThreads.Worker;
    const writers: InstanceType<typeof originalWorker>[] = [];
    const writerFailed = Promise.withResolvers<Error>(),
      observationFailed = Promise.withResolvers<string>();
    const terminationStarted = Promise.withResolvers<void>(),
      finishTermination = Promise.withResolvers<void>();
    const failedOutcome = Promise.withResolvers<{ outcome: string; reasonCode?: string | null }>();
    const siblingOutcome = Promise.withResolvers<{ outcome: string }>();
    const controls = new Map<
      string,
      {
        output: Parameters<RuntimeProcess["onOutput"]>[0];
        exit: Parameters<RuntimeProcess["onExit"]>[0];
        terminated: number;
        exited: boolean;
      }
    >();
    // The writer's nested monitor worker inherits this preload; trigger a native watcher error
    // only after both runtimes are attached and the test changes the faulted workspace.
    const preload = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const nativeWatch = fs.watch;
fs.watch = function(...args) {
  const watcher = nativeWatch.apply(this, args);
  if (String(args[0]) === ${JSON.stringify(faultCwd)}) {
    watcher.once("change", () => watcher.emit("error", Object.assign(new Error("native watcher permission denied"), {code:"EACCES"})));
    fs.writeFileSync(${JSON.stringify(watcherReady)}, "ready");
  }
  return watcher;
};
syncBuiltinESMExports();
`;
    t.mock.method(
      workerThreads,
      "Worker",
      class extends originalWorker {
        constructor(filename: string | URL, options: WorkerOptions = {}) {
          const writer = String(filename).includes("repo-writer-worker.") && options.workerData?.role !== "reader";
          super(
            filename,
            writer
              ? {
                  ...options,
                  execArgv: [
                    ...(options.execArgv ?? []),
                    "--import",
                    `data:text/javascript,${encodeURIComponent(preload)}`,
                  ],
                }
              : options,
          );
          if (writer) {
            writers.push(this);
            this.on("error", writerFailed.resolve);
          }
        }
      },
    );
    syncBuiltinESMExports();
    const resources: { cell?: Awaited<ReturnType<typeof openRepoCell>> } = {};
    t.after(async () => {
      finishTermination.resolve();
      await resources.cell?.close();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    });
    const survive = <T>(work: Promise<T>): Promise<T> =>
      Promise.race([
        work,
        writerFailed.promise.then((error) => {
          throw error;
        }),
      ]);
    const binding = withPolicyGroup(
      {
        actor: { principal: { personId: "observation-operator" }, executor: null },
        source: "local" as const,
      },
      "admin",
    );
    let failedId = "",
      siblingId = "";
    const cell = await openRepoCell({
      repoId: workspaceId("observation-fault"),
      rootDir: canonicalRoot(root),
      ownerId: "observation-fault",
      recordLifecycle: (entry) => {
        if (entry.event === "runtime_observation_failed") observationFailed.resolve(entry.error ?? "");
      },
      onRuntimeOutcome: (event) => {
        if (event.payload.runtimeSessionId === failedId) failedOutcome.resolve(event.payload);
        if (event.payload.runtimeSessionId === siblingId) siblingOutcome.resolve(event.payload);
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Observation fault fixture",
          kindId: definition.kindId,
          installationId: definition.installationId,
          providerId: definition.providerId,
          models: [definition.model],
          defaultModel: definition.model,
          enabled: true,
          permissionMode: "workspace-write",
          codex: {},
          authMode: definition.authMode,
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        },
      ],
      prepareRuntimeLaunch: async (_id, request) => ({
        definition,
        installation,
        executablePath: installation.executablePath,
        args: [],
        env: process.env,
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: (request) => {
        const control = {
          output: (_chunk: string) => undefined as void,
          exit: (_code: number | null) => undefined as void,
          terminated: 0,
          exited: false,
        };
        controls.set(request.cwd, control);
        return {
          pid: 2_147_483_647,
          onOutput: (listener) => {
            control.output = listener;
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            control.exit = (code) => {
              control.exited = true;
              listener(code);
            };
          },
          terminate: () => assert.fail("tree termination is available"),
          terminateTree: async () => {
            if (control.exited) return;
            control.terminated += 1;
            if (request.cwd === faultCwd) {
              terminationStarted.resolve();
              await finishTermination.promise;
            }
          },
        };
      },
    });
    resources.cell = cell;
    for (const cwd of ["faulted-workspace", "sibling-workspace"]) {
      const spawned = await cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-relative", path: cwd },
          prompt: "observe workspace",
          dispatchKey: cwd,
        },
        binding,
      );
      assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
      if (cwd === "faulted-workspace") failedId = String(spawned.runtimeSessionId);
      else siblingId = String(spawned.runtimeSessionId);
    }
    assert.equal(writers.length, 1);
    const writer = writers[0]!,
      threadId = writer.threadId;
    await waitForFile(watcherReady);
    writeFileSync(path.join(faultCwd, "trigger.txt"), "change");
    assert.match(await survive(observationFailed.promise), /EACCES.*native watcher permission denied/u);
    await survive(terminationStarted.promise);
    // The runtime's termination is intentionally pending: neither ledger reads nor writes may wait for it.
    assert.equal((await survive(cell.run({ kind: "task-list" }, binding))).outcome, "applied");
    assert.equal(
      (
        await survive(
          cell.run({ kind: "task-create", taskId: "task_after_watch_fault", title: "Writer survived" }, binding),
        )
      ).outcome,
      "applied",
    );
    assert.equal(controls.get(siblingCwd)!.terminated, 0);
    finishTermination.resolve();
    const failed = await survive(failedOutcome.promise);
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.reasonCode, "runtime_observation_failed");
    const sibling = controls.get(siblingCwd)!;
    sibling.output(
      [
        { type: "thread.started", thread_id: "sibling-provider-session" },
        { type: "item.completed", item: { id: "answer", type: "agent_message", text: "Sibling is still working." } },
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      ]
        .map((frame) => JSON.stringify(frame))
        .join("\n") + "\n",
    );
    sibling.exit(0);
    assert.notEqual((await survive(siblingOutcome.promise)).outcome, "failed");
    assert.equal((await survive(cell.run({ kind: "task-list" }, binding))).outcome, "applied");
    assert.equal(writers.length, 1, "no replacement writer may disguise the failure");
    assert.equal(writer.threadId, threadId);
    assert.equal(controls.get(faultCwd)!.terminated, 1);
    assert.equal(sibling.terminated, 0);
  },
);

function waitForFile(file: string): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(path.dirname(file), () => {
      if (existsSync(file)) {
        watcher.close();
        resolve();
      }
    });
    if (existsSync(file)) {
      watcher.close();
      resolve();
    }
  });
}
