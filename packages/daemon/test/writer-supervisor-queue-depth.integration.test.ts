// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";

test("writer supervisor observes internal runtime work draining to zero", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-writer-queue-depth-")),
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
        defaultWriterEpochFence: fence,
      })
    ).close();
    const runtimeExited = deferred<void>(),
      publishedQueueDepths: (number | null)[] = [];
    const binding = withPolicyGroup(
      { actor, source: "local" as const, writerEpoch: fence.epoch, writerEpochFence: fence },
      "contributor",
    );
    let runtimeSessionLookups = 0;
    supervisor = await openWriterSupervisor(
      {
        repoId,
        rootDir,
        ownerId: "writer-queue-depth",
        defaultWriterEpochFence: fence,
        keycloakSession: async () => {
          runtimeSessionLookups += 1;
          return binding.keycloakAuthorization.session;
        },
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
      { onPublishedStatus: (status) => publishedQueueDepths.push(status.queueDepth) },
    );
    const spawned = await supervisor.request<{ readonly runtimeSessionId: string }>(
      "spawnRuntime",
      {
        runtimeInstanceId: instance.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Finish immediately",
        taskId: null,
        idempotencyKey: "writer-queue-depth",
      },
      binding,
    );
    assert.equal(typeof spawned.runtimeSessionId, "string");
    const lookupsBeforeExit = runtimeSessionLookups;
    writeFileSync(releasePath, "release");
    await Promise.race([
      runtimeExited.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("runtime did not exit within 10000ms")), 10_000),
      ),
    ]);
    await waitUntil(() => supervisor!.status().queueDepth === 0);
    assert.equal(supervisor.status().queueDepth, 0);
    assert.equal(
      runtimeSessionLookups,
      lookupsBeforeExit,
      "local runtime publication does not resolve a Keycloak session through the host capability",
    );
    assert.ok(publishedQueueDepths.some((depth) => depth !== null && depth > 0));
    assert.equal(publishedQueueDepths.at(-1), 0, "the status callback witnesses the drained writer cut");
  } finally {
    await supervisor?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((settle) => (resolve = settle)), resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`condition did not become true within ${String(timeoutMs)}ms`);
}
