// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { policyTestCenter, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openPersistentWriterEpoch } from "@harness-anything/storage";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";
import { dispatchStreamPath, readDispatchStream } from "../src/dispatch-stream.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";

test(
  "ordinary writes remain available while an active runtime workspace continuously changes thousands of files",
  { timeout: 300_000 },
  async (t) => {
    const fileCount = Number(process.env.FLEET_STRESS_WORKSPACE_FILES ?? 2_000),
      parent = mkdtempSync(path.join(tmpdir(), "ha-writer-queue-depth-")),
      repoId = workspaceId("writer-queue-depth"),
      stateRoot = path.join(parent, "writer-epochs"),
      releasePath = path.join(parent, "release-provider"),
      readyPath = path.join(parent, "provider-ready"),
      watcherReady = path.join(parent, "watcher-ready"),
      executablePath = writeProviderExecutable(
        path.join(parent, "provider.mjs"),
        `import fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
      await new Promise(resolve => { const watcher = fs.watch(${JSON.stringify(parent)}, () => {
        if (fs.existsSync(${JSON.stringify(releasePath)})) { watcher.close(); resolve(); }
      }); if (fs.existsSync(${JSON.stringify(releasePath)})) { watcher.close(); resolve(); } });
` +
          'console.log(JSON.stringify({ type: "thread.started", thread_id: "queue-depth-session" }));\n' +
          'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));\n',
      ),
      definition = {
        schema: "agent-definition-snapshot/v1" as const,
        configVersion: 1 as const,
        instanceId: "codex-queue-depth",
        installationId: "installation-queue-depth",
        kindId: "codex" as const,
        providerId: "openai",
        model: "codex-model",
        reasoningEffort: null,
        baseUrl: null,
        authMode: "subscription" as const,
      },
      installation = {
        installationId: definition.installationId,
        kindId: definition.kindId,
        executablePath,
        version: "1.0.0",
        observedAt: "2026-09-20T00:00:00.000Z",
      },
      instance = {
        schemaVersion: 2 as const,
        instanceId: definition.instanceId,
        name: "Queue Depth Runtime",
        kindId: definition.kindId,
        installationId: installation.installationId,
        providerId: definition.providerId,
        models: [definition.model],
        defaultModel: definition.model,
        enabled: true,
        permissionMode: "workspace-write" as const,
        codex: {},
        authMode: "subscription" as const,
        authState: "configured" as const,
        authReadiness: { status: "ready" as const, code: null, hint: null },
        isolationState: "enforced" as const,
      };
    let supervisor: Awaited<ReturnType<typeof openWriterSupervisor>> | undefined;
    let churn: Worker | undefined;
    const stopChurn = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    try {
      const repoRoot = path.join(parent, "repo");
      mkdirSync(repoRoot);
      mkdirSync(path.join(repoRoot, "node_modules"));
      const rootDir = canonicalRoot(repoRoot);
      initRepo(rootDir);
      const authority = openPersistentWriterEpoch({ stateRoot, holderId: "writer-queue-depth" }),
        lease = authority.acquire(repoId),
        fence = {
          schema: "harness-writer-epoch-fence/v1" as const,
          stateRoot,
          repoId,
          epoch: lease.epoch,
          holderId: lease.holderId,
        };
      authority.close();
      await (
        await openBootstrappedRepoCell({
          repoId,
          rootDir,
          ownerId: "writer-queue-depth-seed",
          runtimeInstances: () => [instance],
          defaultWriterEpochFence: fence,
        })
      ).close();
      const runtimeExited = deferred<void>(),
        publishedQueueDepths: (number | null)[] = [];
      let workspaceWatchRegistrations = 0;
      // The watcher must not be installed in the writer thread, even if the workspace churns.
      const preload = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
const nativeWatch = fs.watch;
fs.watch = function(target, options, listener) {
  const watcher = nativeWatch.call(this, target, options, listener);
  if (String(target) === ${JSON.stringify(repoRoot)} && options?.recursive) {
    if (workerData?.cwd === ${JSON.stringify(repoRoot)}) fs.writeFileSync(${JSON.stringify(watcherReady)}, "ready");
    else parentPort.postMessage({ schema: "test-recursive-workspace-watch" });
  }
  return watcher;
};
syncBuiltinESMExports();
`;
      const binding = withPolicyGroup(
        { actor, source: "local" as const, writerEpoch: fence.epoch, writerEpochFence: fence },
        "contributor",
      );
      supervisor = await openWriterSupervisor(
        {
          repoId,
          rootDir,
          ownerId: "writer-queue-depth",
          keycloakCenter: policyTestCenter,
          defaultWriterEpochFence: fence,
          keycloakSession: async () => binding.keycloakAuthorization.session,
          runtimeInstances: () => [instance],
          prepareRuntimeLaunch: async (_instanceId, request) => ({
            definition,
            installation,
            executablePath,
            args: ["exec", "--json", "--model", definition.model, "-"],
            env: process.env,
            cwd: request.cwd,
            prompt: request.prompt,
          }),
          onRuntimeOutcome: (event) => {
            if (event.type === "runtime_session_outcome_observed") runtimeExited.resolve();
          },
        },
        {
          onPublishedStatus: (status) => publishedQueueDepths.push(status.queueDepth),
          createWorker: (url, options) => {
            const worker = new Worker(url, {
              ...options,
              execArgv: [...options.execArgv, "--import", `data:text/javascript,${encodeURIComponent(preload)}`],
            });
            worker.on("message", (message: { schema?: string }) => {
              if (message.schema === "test-recursive-workspace-watch") workspaceWatchRegistrations += 1;
            });
            return worker;
          },
        },
      );
      const spawned = await supervisor.request<{ readonly runtimeSessionId: string; readonly dispatchId: string }>(
        "spawnRuntime",
        {
          runtimeInstanceId: instance.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Finish immediately",
          taskId: null,
          dispatchKey: "writer-queue-depth",
        },
        binding,
      );
      assert.equal(typeof spawned.runtimeSessionId, "string");
      await waitForFile(readyPath);
      await waitForFile(watcherReady);
      assert.equal(workspaceWatchRegistrations, 0, "the writer must not recursively watch the workspace");
      publishedQueueDepths.length = 0;
      churn = new Worker(
        `const fs = require("node:fs");
         const path = require("node:path");
         const { parentPort, workerData } = require("node:worker_threads");
         const stop = new Int32Array(workerData.stop);
         for (let i = 0; i < workerData.files; i++) fs.writeFileSync(path.join(workerData.dir, "file-" + i), "created");
         parentPort.postMessage({ ready: true });
         let writes = 0;
         while (Atomics.load(stop, 0) === 0 && writes < 100000) {
           fs.writeFileSync(path.join(workerData.dir, "file-" + (writes % workerData.files)), "changed");
           writes++;
         }
         parentPort.postMessage({ writes, limitReached: writes === 100000 });`,
        {
          eval: true,
          workerData: { dir: path.join(repoRoot, "node_modules"), files: fileCount, stop: stopChurn.buffer },
        },
      );
      let churnWrites = 0,
        churnLimitReached = false;
      const ready = new Promise<void>((resolve, reject) => {
        churn!.on("message", (message: { ready?: boolean; writes?: number; limitReached?: boolean }) => {
          if (message.ready) resolve();
          if (typeof message.writes === "number") churnWrites = message.writes;
          if (message.limitReached) churnLimitReached = true;
        });
        churn!.once("error", reject);
      });
      const churnExited = new Promise<void>((resolve, reject) => {
        churn!.once("error", reject);
        churn!.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`churn worker exited ${String(code)}`)),
        );
      });
      await ready;
      await waitForWorkspaceProgress(repoRoot, spawned.dispatchId);
      const writeStarted = performance.now(),
        receipt = await supervisor.request<{ readonly outcome: string }>(
          "run",
          { action: { kind: "task-create", taskId: "task_workspace_burst", title: "Write during workspace churn" } },
          binding,
        ),
        writeMs = Math.round(performance.now() - writeStarted);
      Atomics.store(stopChurn, 0, 1);
      await churnExited;
      const maxQueueDepth = Math.max(0, ...publishedQueueDepths.filter((depth): depth is number => depth !== null));
      t.diagnostic(
        `workspaceFiles=${fileCount} churnWrites=${churnWrites} maxQueueDepth=${maxQueueDepth} taskCreateMs=${writeMs}`,
      );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      assert.ok(churnWrites > 0, "changes continued while the ordinary write ran");
      assert.equal(churnLimitReached, false, "the bounded churn must still be active during the ordinary write");
      assert.ok(maxQueueDepth <= 3, `workspace churn left ${String(maxQueueDepth)} queued writes`);
      writeFileSync(releasePath, "release");
      await runtimeExited.promise;
    } finally {
      Atomics.store(stopChurn, 0, 1);
      await churn?.terminate();
      writeFileSync(releasePath, "release");
      await supervisor?.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((settle) => (resolve = settle)), resolve };
}

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

function waitForWorkspaceProgress(rootDir: string, dispatchId: string): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (readDispatchStream(rootDir, dispatchId)?.records.some((record) => record.kind === "workspace_activity")) {
        watcher.close();
        resolve();
      }
    };
    const watcher = watch(path.dirname(dispatchStreamPath(rootDir, dispatchId)), check);
    check();
  });
}
