// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { policyTestCenter, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openPersistentWriterEpoch } from "@harness-anything/storage";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";

test(
  "real workspace changes keep the writer queue bounded after a controlled finite burst",
  { timeout: 300_000 },
  async (t) => {
    const notificationTarget = Number(process.env.FLEET_STRESS_WORKSPACE_NOTIFICATIONS ?? 100),
      parent = mkdtempSync(path.join(tmpdir(), "ha-writer-queue-depth-")),
      repoId = workspaceId("writer-queue-depth"),
      stateRoot = path.join(parent, "writer-epochs"),
      releasePath = path.join(parent, "release-provider"),
      executablePath = writeProviderExecutable(
        path.join(parent, "provider.mjs"),
        `import fs from "node:fs";
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
    try {
      const repoRoot = path.join(parent, "repo");
      mkdirSync(repoRoot);
      mkdirSync(path.join(repoRoot, "node_modules"));
      const rootDir = canonicalRoot(repoRoot);
      initRepo(rootDir);
      // Keep the file churn out of Git snapshots so this measures writer queue contention.
      writeFileSync(path.join(repoRoot, ".git", "info", "exclude"), "node_modules/\n");
      // Populate before watching: the measured burst modifies files, avoiding recursive watcher
      // directory-discovery work for each newly created entry.
      for (let index = 0; index < Math.max(1_000, notificationTarget); index += 1)
        writeFileSync(path.join(repoRoot, "node_modules", `file-${index}`), "before");
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
        burstObserved = deferred<number>(),
        publishedQueueDepths: (number | null)[] = [];
      // Buffer actual native notifications in the writer thread and release them together. This
      // makes the queue contention deterministic without inventing file events or sleeping.
      // Drop later notifications in the fixture so only the measured burst competes with the write.
      const preload = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { parentPort } from "node:worker_threads";
const nativeWatch = fs.watch;
fs.watch = function(target, options, listener) {
  if (String(target) !== ${JSON.stringify(repoRoot)}) return nativeWatch.call(this, target, options, listener);
  const pending = [];
  let released = false;
  const watcher = nativeWatch.call(this, target, options, (event, filename) => {
    if (released) return;
    pending.push([event, filename]);
    if (pending.length === ${notificationTarget}) {
      released = true;
      watcher.close();
      for (const args of pending) listener(...args);
      parentPort.postMessage({ schema: "test-native-workspace-burst", count: pending.length });
    }
  });
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
            worker.on("message", (message: { schema?: string; count?: number }) => {
              if (message.schema === "test-native-workspace-burst") burstObserved.resolve(message.count!);
            });
            return worker;
          },
        },
      );
      const spawned = await supervisor.request<{ readonly runtimeSessionId: string }>(
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
      publishedQueueDepths.length = 0;
      for (let index = 0; index < Math.max(1_000, notificationTarget); index += 1)
        writeFileSync(path.join(repoRoot, "node_modules", `file-${index}`), "workspace activity");
      const notifications = await burstObserved.promise,
        maxQueueDepth = Math.max(0, ...publishedQueueDepths.filter((depth): depth is number => depth !== null)),
        writeStarted = performance.now(),
        receipt = await supervisor.request<{ readonly outcome: string }>(
          "run",
          { action: { kind: "task-create", taskId: "task_workspace_burst", title: "Write during a workspace burst" } },
          binding,
        ),
        writeMs = Math.round(performance.now() - writeStarted);
      t.diagnostic(`nativeNotifications=${notifications} maxQueueDepth=${maxQueueDepth} taskCreateMs=${writeMs}`);
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      assert.ok(maxQueueDepth <= 3, `workspace burst left ${String(maxQueueDepth)} queued writes`);
      writeFileSync(releasePath, "release");
      await runtimeExited.promise;
    } finally {
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
