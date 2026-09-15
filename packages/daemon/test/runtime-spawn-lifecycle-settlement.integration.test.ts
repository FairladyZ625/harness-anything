// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  consumeKnownError,
  makeTaskEventReader,
  makeTaskProjection,
  type AgentDefinitionSnapshot,
} from "../../kernel/src/index.ts";
import { type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { appendRuntimeWorkerRecord } from "../src/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import {
  openPersistentWriterEpoch,
  readLedgerWriterEpoch,
  type WriterEpochFenceDescriptor,
} from "../src/writer-epoch.ts";
import { launchExitNotification } from "../src/runtime-spawn.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const definition: AgentDefinitionSnapshot = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "codex-review",
  installationId: "installation-codex",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  baseUrl: "https://api.example.test/",
  authMode: "api-key",
};
const installation: RuntimeInstallationWitness = {
  installationId: definition.installationId,
  kindId: definition.kindId,
  executablePath: "/opt/witnessed/codex",
  version: "1.0.0",
  observedAt: "2026-08-14T00:00:00.000Z",
};

test("attached task runtime settlement releases its execution lease before publishing the terminal outcome", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-attached-tail-"));
  let exit: ((code: number | null) => void) | null = null,
    failSettlement = false,
    launchedPrompt: string | undefined;
  try {
    initIngressRepo(root, 4310);
    const cell = await openRepoCell({
      repoId: workspaceId("runtime-attached-tail"),
      rootDir: canonicalRoot(root),
      ownerId: "attached-tail-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: "attached-tail-test",
        endpoint: path.join(root, ".daemon-user", "daemon.sock"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Codex Attached Tail",
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
      prepareRuntimeLaunch: async (_instanceId, request) => {
        launchedPrompt = request.prompt;
        return {
          definition,
          installation,
          executablePath: installation.executablePath,
          args: ["exec", "--json", "-"],
          env: process.env,
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      runtimeLaunch: () => ({
        pid: process.pid,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: (listener) => {
          exit = listener;
        },
        terminate: () => undefined,
      }),
      killpoint: (point) => {
        if (!failSettlement || point !== "after_sqlite_commit") return;
        const latest = makeTaskEventReader({ repoId: "runtime-attached-tail", rootDir: root }).read().events.at(-1);
        if (latest?.type === "lease_released" && latest.taskId === "task-runtime-settlement-failed") {
          failSettlement = false;
          throw Object.assign(new Error("injected terminal lease settlement failure"), {
            code: "runtime_lease_release_failed",
          });
        }
      },
    });
    try {
      const taskId = "task-runtime-attached-tail",
        executionId = "execution-runtime-attached-tail",
        binding = {
          actor: { principal: { personId: "person-attached-tail" }, executor: null },
          source: "local" as const,
        };
      const created = await cell.run({ kind: "task-create", taskId, title: "Attached tail lease" }, binding);
      assert.equal(created.outcome, "applied");
      await waitForFixturePublication(cell, created.opId, binding);
      await realizeTaskPlanFixture(
        root,
        String((created as Record<string, unknown>).packagePath),
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
        "Attached tail lease",
      );
      assert.equal(
        (
          await cell.run(
            { kind: "task-start", taskId, executionId, executor: { kind: "agent", id: "attached-tail-worker" } },
            binding,
          )
        ).outcome,
        "applied",
      );
      const receipt = await cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Settle the durable tail after attach",
          taskId,
          idempotencyKey: "attached-tail",
        },
        binding,
      );
      // A task-bound dispatch without an agent declaration is worker work and carries the shared discipline.
      assert.match(launchedPrompt ?? "", /^# Harness Execution Discipline/u);
      assert.match(launchedPrompt ?? "", /must not operate host virtualization, networking, or system services/u);
      const claimedProjection = makeTaskProjection({
        rootDir: root,
        eventStore: makeTaskEventReader({ repoId: "runtime-attached-tail", rootDir: root }),
      });
      try {
        assert.deepEqual(
          claimedProjection.read(taskId).snapshot.lease?.actor.executor,
          { kind: "agent", id: `runtime-session:${receipt.runtimeSessionId}` },
          "dispatch must hand the lease to the RuntimeSession before provider work starts",
        );
      } finally {
        claimedProjection.close();
      }
      const records = [
        { type: "thread.started", thread_id: "provider-attached-tail" },
        {
          type: "item.completed",
          item: {
            id: "write",
            type: "file_change",
            changes: [{ path: "result.txt", kind: "add" }],
            status: "completed",
          },
        },
        {
          type: "item.completed",
          item: { id: "message", type: "agent_message", text: "attached tail settled" },
        },
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      ];
      for (const event of records) {
        appendRuntimeWorkerRecord(root, String(receipt.dispatchId), {
          kind: "provider_event",
          occurredAt: "2026-08-24T12:00:00.000Z",
          event,
        });
      }
      appendRuntimeWorkerRecord(root, String(receipt.dispatchId), {
        kind: "process_exit",
        occurredAt: "2026-08-24T12:00:01.000Z",
        exitCode: 0,
        signal: null,
      });
      assert.ok(exit, "runtime exit listener must be attached before the provider exits");
      exit(0);
      const events = await eventuallyValue(() => {
          const events = makeTaskEventReader({ repoId: "runtime-attached-tail", rootDir: root }).read().events;
          return events.some(
            (event) =>
              event.type === "runtime_session_outcome_observed" &&
              event.payload.runtimeSessionId === receipt.runtimeSessionId,
          )
            ? events
            : null;
        }),
        outcomeIndex = events.findIndex(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.runtimeSessionId === receipt.runtimeSessionId,
        ),
        releaseIndex = events.findIndex(
          (event) =>
            event.type === "lease_released" &&
            event.taskId === taskId &&
            event.payload.execution.executionId === executionId,
        ),
        projection = makeTaskProjection({
          rootDir: root,
          projectionPath: path.join(root, ".harness/cache/runtime-attached-tail-observer.sqlite"),
          eventStore: makeTaskEventReader({ repoId: "runtime-attached-tail", rootDir: root }),
        });
      projection.catchUp();
      const settled = projection.readRuntimeSession(String(receipt.runtimeSessionId))!,
        taskSnapshot = projection.read(taskId).snapshot;
      projection.close();
      assert.deepEqual(
        {
          liveness: settled.liveness,
          outcome: settled.outcome,
          exitCode: settled.exitCode,
        },
        { liveness: "exited", outcome: "succeeded", exitCode: 0 },
      );
      assert.deepEqual(
        events
          .filter(
            (event) =>
              (event.type === "runtime_session_exited" || event.type === "runtime_session_outcome_observed") &&
              event.payload.runtimeSessionId === receipt.runtimeSessionId,
          )
          .map((event) => event.actor.executor),
        [
          { kind: "agent", id: `runtime-session:${receipt.runtimeSessionId}` },
          { kind: "agent", id: `runtime-session:${receipt.runtimeSessionId}` },
        ],
        "terminal Runtime events must use the daemon-derived RuntimeSession claim",
      );
      assert.ok(releaseIndex < outcomeIndex, "terminal outcome must not become visible before lease release");
      assert.equal(taskSnapshot.lease, null, "terminal RuntimeSession settlement must release the execution lease");

      const failedTaskId = "task-runtime-settlement-failed",
        failedExecutionId = "execution-runtime-settlement-failed";
      const failedCreated = await cell.run(
        { kind: "task-create", taskId: failedTaskId, title: "Failed settlement" },
        binding,
      );
      assert.equal(failedCreated.outcome, "applied");
      await waitForFixturePublication(cell, failedCreated.opId, binding);
      await realizeTaskPlanFixture(
        root,
        String((failedCreated as Record<string, unknown>).packagePath),
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
        "Failed settlement",
      );
      assert.equal(
        (
          await cell.run(
            {
              kind: "task-start",
              taskId: failedTaskId,
              executionId: failedExecutionId,
              executor: { kind: "agent", id: "failed-settlement-worker" },
            },
            binding,
          )
        ).outcome,
        "applied",
      );
      const failedReceipt = await cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Expose a failed terminal lease settlement",
          taskId: failedTaskId,
          idempotencyKey: "failed-settlement",
        },
        binding,
      );
      for (const event of records) {
        appendRuntimeWorkerRecord(root, String(failedReceipt.dispatchId), {
          kind: "provider_event",
          occurredAt: "2026-08-24T12:01:00.000Z",
          event,
        });
      }
      appendRuntimeWorkerRecord(root, String(failedReceipt.dispatchId), {
        kind: "process_exit",
        occurredAt: "2026-08-24T12:01:01.000Z",
        exitCode: 0,
        signal: null,
      });
      const beforeFailedExitCount = makeTaskEventReader({ repoId: "runtime-attached-tail", rootDir: root }).read()
        .events.length;
      failSettlement = true;
      assert.ok(exit, "failed-settlement runtime must attach its exit listener");
      exit(0);
      await eventually(() => {
        const terminal = makeTaskEventReader({ repoId: "runtime-attached-tail", rootDir: root })
          .read()
          .events.find(
            (event) =>
              event.type === "runtime_session_outcome_observed" &&
              event.payload.runtimeSessionId === failedReceipt.runtimeSessionId,
          );
        return terminal?.type === "runtime_session_outcome_observed" && terminal.payload.outcome === "failed";
      });
      assert.equal(failSettlement, false, "the failed task lease release must trigger the post-commit fault");
      const failedEvents = makeTaskEventReader({ repoId: "runtime-attached-tail", rootDir: root }).read().events,
        failedExitIndex = failedEvents.findIndex(
          (event) =>
            event.type === "runtime_session_exited" &&
            event.payload.runtimeSessionId === failedReceipt.runtimeSessionId,
        ),
        failedOutcomeIndex = failedEvents.findIndex(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.runtimeSessionId === failedReceipt.runtimeSessionId,
        ),
        failedOutcome = failedEvents.find(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.runtimeSessionId === failedReceipt.runtimeSessionId,
        ),
        failedStatus = await eventuallyValue(async () => {
          const status = await cell.read("repo.agentRuntime.sessions.read", {
            runtimeSessionId: failedReceipt.runtimeSessionId,
          });
          return status.session.activity.outcome === "failed" ? status : null;
        });
      const failedReleaseIndexes = failedEvents.flatMap((event, index) =>
        index >= beforeFailedExitCount && event.type === "lease_released" && event.taskId === failedTaskId
          ? [index]
          : [],
      );
      assert.equal(
        failedReleaseIndexes.length,
        1,
        "the post-commit fault does not roll back the accepted lease release",
      );
      assert.ok(failedReleaseIndexes[0]! < failedOutcomeIndex);
      assert.ok(failedExitIndex < failedOutcomeIndex, "the failed settlement still publishes one terminal outcome");
      assert.equal(
        failedEvents.filter(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.runtimeSessionId === failedReceipt.runtimeSessionId,
        ).length,
        1,
      );
      assert.equal(failedStatus.session.activity.outcome, "failed");
      assert.equal(
        failedOutcome?.type === "runtime_session_outcome_observed" && failedOutcome.payload.reasonCode,
        "publication_indeterminate",
      );
      assert.equal(failedStatus.session.activity.reasonCode, "publication_indeterminate");
      assert.match(failedStatus.result?.text ?? "", /publication_indeterminate/u);
      failSettlement = false;
      assert.equal(
        (await cell.run({ kind: "task-create", taskId: "task-after-settlement-failure", title: "Tail live" }, binding))
          .outcome,
        "applied",
      );
      assert.equal(
        failedEvents.some(
          (event) =>
            event.type === "lease_released" &&
            event.taskId === failedTaskId &&
            event.payload.execution.executionId === failedExecutionId,
        ),
        true,
      );
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal settlement leaves an execution lease generation it never dispatched under held", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-lease-generation-"));
  let exit: ((code: number | null) => void) | null = null;
  try {
    initIngressRepo(root, 4311);
    const cell = await openRepoCell({
      repoId: workspaceId("runtime-lease-generation"),
      rootDir: canonicalRoot(root),
      ownerId: "lease-generation-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: "lease-generation-test",
        endpoint: path.join(root, ".daemon-user", "daemon.sock"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Codex Lease Generation",
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
      prepareRuntimeLaunch: async (_instanceId, request) => ({
        definition,
        installation,
        executablePath: installation.executablePath,
        args: ["exec", "--json", "-"],
        env: process.env,
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: () => ({
        pid: process.pid,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: (listener) => {
          exit = listener;
        },
        terminate: () => undefined,
      }),
    });
    try {
      const taskId = "task-runtime-lease-generation",
        executionId = "execution-runtime-lease-generation",
        binding = {
          actor: { principal: { personId: "person-lease-generation" }, executor: null },
          source: "local" as const,
        },
        start = async () =>
          (
            await cell.run(
              { kind: "task-start", taskId, executionId, executor: { kind: "agent", id: "lease-generation-worker" } },
              binding,
            )
          ).outcome;
      const created = await cell.run({ kind: "task-create", taskId, title: "Lease generation" }, binding);
      assert.equal(created.outcome, "applied");
      await waitForFixturePublication(cell, created.opId, binding);
      await realizeTaskPlanFixture(
        root,
        String((created as Record<string, unknown>).packagePath),
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
        "Lease generation",
      );
      assert.equal(await start(), "applied");
      const receipt = await cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Dispatch under the first lease generation",
          taskId,
          idempotencyKey: "lease-generation",
        },
        binding,
      );
      // The holder hands the execution over — release and restart — while the dispatch is still
      // live. Both generations carry the same executionId, so only the lease version tells them
      // apart, and the dispatch below belongs to the first one.
      const runtimeHolder = {
        ...binding,
        actor: {
          principal: binding.actor.principal,
          executor: { kind: "agent" as const, id: `runtime-session:${receipt.runtimeSessionId}` },
        },
      };
      assert.equal((await cell.run({ kind: "task-release", taskId }, runtimeHolder)).outcome, "applied");
      assert.equal(await start(), "applied");
      appendRuntimeWorkerRecord(root, String(receipt.dispatchId), {
        kind: "provider_event",
        occurredAt: "2026-08-24T12:00:00.000Z",
        event: { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      });
      appendRuntimeWorkerRecord(root, String(receipt.dispatchId), {
        kind: "process_exit",
        occurredAt: "2026-08-24T12:00:01.000Z",
        exitCode: 0,
        signal: null,
      });
      assert.ok(exit, "runtime exit listener must be attached before the provider exits");
      exit(0);
      await eventually(() =>
        makeTaskEventReader({ repoId: "runtime-lease-generation", rootDir: root })
          .read()
          .events.some(
            (event) =>
              event.type === "runtime_session_outcome_observed" &&
              event.payload.runtimeSessionId === receipt.runtimeSessionId,
          ),
      );
      const projection = makeTaskProjection({
          rootDir: root,
          eventStore: makeTaskEventReader({ repoId: "runtime-lease-generation", rootDir: root }),
        }),
        lease = projection.read(taskId).snapshot.lease;
      projection.close();
      assert.equal(lease?.phase, "held", "a stale dispatch must not release the lease generation that replaced it");
      assert.equal(lease?.executionId, executionId);
      const spawned = await cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Dispatch under the surviving lease generation",
          taskId,
          idempotencyKey: "lease-generation-next",
        },
        binding,
      );
      assert.equal(typeof spawned.dispatchId, "string");
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-cell restart re-adopts a live native runtime and settles an exit recorded while absent", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-re-adopt-")),
    root = path.join(parent, "repo"),
    release = path.join(parent, "release"),
    pidFile = path.join(parent, "provider.pid"),
    repoId = "runtime-re-adopt",
    executablePath = writeProviderExecutable(
      path.join(parent, "re-adopt-provider.mjs"),
      `import fs from "node:fs";\nfs.readFileSync(0, "utf8");\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nconsole.log(JSON.stringify({ type: "thread.started", thread_id: "provider-re-adopt-session" }));\nconst timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return; clearInterval(timer); console.log(JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", changes: [{ path: "result.txt", kind: "add" }], status: "completed" } })); console.log(JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "survived daemon restart" } })); console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })); }, 10);\n`,
    ),
    installation = installationFixture("codex", executablePath),
    definition = {
      instanceId: "codex-re-adopt",
      name: "Codex Re-adopt",
      kindId: "codex" as const,
      installationId: installation.installationId,
      providerId: "openai",
      models: ["codex-model"],
      defaultModel: "codex-model",
      enabled: true,
      permissionMode: "workspace-write" as const,
      codex: {},
      authMode: "subscription" as const,
      authState: "configured" as const,
      authReadiness: { status: "ready" as const, code: null, hint: null },
      isolationState: "enforced" as const,
      schemaVersion: 2 as const,
    },
    preparedDefinition: AgentDefinitionSnapshot = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: definition.instanceId,
      installationId: installation.installationId,
      kindId: "codex",
      providerId: "openai",
      model: "codex-model",
      reasoningEffort: null,
      baseUrl: null,
      authMode: "subscription",
    };
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    providerPid = 0,
    oldAuthority: ReturnType<typeof openPersistentWriterEpoch> | undefined,
    newAuthority: ReturnType<typeof openPersistentWriterEpoch> | undefined;
  try {
    initIngressRepo(root, 4309);
    const writerEpochStateRoot = path.join(parent, "writer-epochs");
    const oldAuthorityInstance = openPersistentWriterEpoch({ stateRoot: writerEpochStateRoot, holderId: "daemon-old" });
    oldAuthority = oldAuthorityInstance;
    const oldLease = oldAuthorityInstance.acquire(repoId, readLedgerWriterEpoch(repoId, root)),
      oldFence: WriterEpochFenceDescriptor = {
        schema: "harness-writer-epoch-fence/v1",
        stateRoot: writerEpochStateRoot,
        repoId,
        holderId: oldLease.holderId,
        epoch: oldLease.epoch,
      },
      actor = { principal: { personId: "person-re-adopt" }, executor: null },
      oldBinding = {
        actor,
        source: "local" as const,
        writerEpoch: oldLease.epoch,
        writerEpochFence: oldFence,
        withWriterEpochFence: <T>(operation: () => T) =>
          oldAuthority!.withAppendFence(repoId, oldLease.epoch, oldLease.holderId, operation),
      },
      open = (ownerId: string, defaultWriterEpochFence: WriterEpochFenceDescriptor) =>
        openRepoCell({
          repoId: workspaceId(repoId),
          rootDir: canonicalRoot(root),
          ownerId,
          defaultWriterEpochFence,
          runtimeDaemonRoute: {
            userRoot: path.join(parent, "daemon-user"),
            daemonId: "runtime-re-adopt-test",
            endpoint: path.join(parent, "daemon.sock"),
          },
          runtimeInstances: () => [definition],
          prepareRuntimeLaunch: async (_instanceId, request) => ({
            definition: preparedDefinition,
            installation,
            executablePath,
            args: ["exec", "--json", "--model", "codex-model", "-"],
            env: process.env,
            cwd: request.cwd,
            prompt: request.prompt,
          }),
        });
    assert.equal(oldLease.epoch, 1);
    cell = await open("re-adopt-before", oldFence);
    const receipt = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Stay alive across restart",
        taskId: null,
        idempotencyKey: "re-adopt",
      },
      oldBinding,
    );
    providerPid = await eventuallyValue(() => {
      try {
        const value = Number(readFileSync(pidFile, "utf8"));
        return Number.isInteger(value) && value > 0 ? value : null;
      } catch {
        return null;
      }
    });
    await eventually(() =>
      readFileSync(
        path.join(root, ".harness", "runtime", "dispatches", `${String(receipt.dispatchId)}.jsonl`),
        "utf8",
      ).includes("provider-re-adopt-session"),
    );
    const firstDispatchPath = path.join(
        root,
        ".harness",
        "runtime",
        "dispatches",
        `${String(receipt.dispatchId)}.jsonl`,
      ),
      firstDispatchLines = readFileSync(firstDispatchPath, "utf8").trimEnd().split(/\r?\n/u),
      firstHeader = JSON.parse(firstDispatchLines[0]!) as Record<string, unknown>;
    assert.equal(Object.hasOwn(firstHeader.binding as object, "writerEpoch"), false);
    assert.equal(Object.hasOwn(firstHeader.binding as object, "writerEpochFence"), false);
    firstDispatchLines[0] = JSON.stringify({
      ...firstHeader,
      binding: {
        ...(firstHeader.binding as Record<string, unknown>),
        writerEpoch: oldLease.epoch,
        writerEpochFence: oldFence,
      },
    });
    writeFileSync(firstDispatchPath, `${firstDispatchLines.join("\n")}\n`);
    const reAdoptHostPid = await eventuallyValue(() => {
      const started = readFileSync(
        path.join(root, ".harness", "runtime", "dispatches", `${String(receipt.dispatchId)}.jsonl`),
        "utf8",
      )
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((record) => record.kind === "process_started");
      return Number.isInteger(started?.pid) && Number(started?.pid) > 0 ? Number(started?.pid) : null;
    });
    await cell.close();
    cell = undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.doesNotThrow(() => process.kill(providerPid, 0), "repo-cell close must not terminate its runtime worker");
    const newAuthorityInstance = openPersistentWriterEpoch({ stateRoot: writerEpochStateRoot, holderId: "daemon-new" });
    newAuthority = newAuthorityInstance;
    const newLease = newAuthorityInstance.acquire(repoId, readLedgerWriterEpoch(repoId, root)),
      newFence: WriterEpochFenceDescriptor = {
        schema: "harness-writer-epoch-fence/v1",
        stateRoot: writerEpochStateRoot,
        repoId,
        holderId: newLease.holderId,
        epoch: newLease.epoch,
      },
      newBinding = {
        actor,
        source: "local" as const,
        writerEpoch: newLease.epoch,
        writerEpochFence: newFence,
        withWriterEpochFence: <T>(operation: () => T) =>
          newAuthority!.withAppendFence(repoId, newLease.epoch, newLease.holderId, operation),
      };
    assert.equal(newLease.epoch, 2);
    cell = await open("re-adopt-after", newFence);
    await assert.rejects(
      cell.run({ kind: "task-create", taskId: "task-stale-runtime-writer", title: "stale runtime writer" }, oldBinding),
      (error: unknown) => (error as { readonly code?: string }).code === "writer_epoch_stale",
    );
    const liveProjection = makeTaskProjection({
      rootDir: root,
      projectionPath: path.join(parent, "runtime-re-adopt-live-before-exit.sqlite"),
      eventStore: makeTaskEventReader({ repoId, rootDir: root }),
    });
    liveProjection.catchUp();
    const adopted = liveProjection.readRuntimeSession(String(receipt.runtimeSessionId))!;
    liveProjection.close();
    assert.deepEqual({ liveness: adopted.liveness, outcome: adopted.outcome }, { liveness: "live", outcome: null });
    assert.doesNotThrow(() => process.kill(reAdoptHostPid, 0), "adopted runtime worker must still be alive");
    writeFileSync(release, "release");
    await eventually(() =>
      makeTaskEventReader({ repoId, rootDir: root })
        .read()
        .events.some(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.runtimeSessionId === receipt.runtimeSessionId,
        ),
    );
    const projection = makeTaskProjection({
      rootDir: root,
      projectionPath: path.join(parent, "runtime-re-adopt-live-observer.sqlite"),
      eventStore: makeTaskEventReader({ repoId, rootDir: root }),
    });
    projection.catchUp();
    const settled = projection.readRuntimeSession(String(receipt.runtimeSessionId))!;
    projection.close();
    assert.deepEqual(
      {
        liveness: settled.liveness,
        outcome: settled.outcome,
        exitCode: settled.exitCode,
      },
      { liveness: "exited", outcome: "succeeded", exitCode: 0 },
    );
    assert.match(String(settled.resultRef), /^artifact:runtime-result\/sha256\//u);
    await eventually(() => {
      try {
        process.kill(reAdoptHostPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.match(
      readFileSync(path.join(root, ".harness", "runtime", "dispatches", `${String(receipt.dispatchId)}.jsonl`), "utf8"),
      /survived daemon restart/u,
    );
    rmSync(release, { force: true });
    const absentReceipt = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Exit while daemon is absent",
        taskId: null,
        idempotencyKey: "re-adopt-absent-exit",
      },
      newBinding,
    );
    providerPid = await eventuallyValue(() => {
      try {
        const value = Number(readFileSync(pidFile, "utf8"));
        return Number.isInteger(value) && value > 0 && value !== providerPid ? value : null;
      } catch {
        return null;
      }
    });
    await eventually(() =>
      readFileSync(
        path.join(root, ".harness", "runtime", "dispatches", `${String(absentReceipt.dispatchId)}.jsonl`),
        "utf8",
      ).includes("provider-re-adopt-session"),
    );
    await cell.close();
    cell = undefined;
    writeFileSync(release, "release");
    await eventually(() =>
      readFileSync(
        path.join(root, ".harness", "runtime", "dispatches", `${String(absentReceipt.dispatchId)}.jsonl`),
        "utf8",
      ).includes('"kind":"process_exit"'),
    );
    cell = await open("re-adopt-dead", newFence);
    await eventually(() =>
      makeTaskEventReader({ repoId, rootDir: root })
        .read()
        .events.some(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.runtimeSessionId === absentReceipt.runtimeSessionId,
        ),
    );
    const reopenedProjection = makeTaskProjection({
      rootDir: root,
      projectionPath: path.join(parent, "runtime-re-adopt-dead-observer.sqlite"),
      eventStore: makeTaskEventReader({ repoId, rootDir: root }),
    });
    reopenedProjection.catchUp();
    const daemonlessSettlement = reopenedProjection.readRuntimeSession(String(absentReceipt.runtimeSessionId))!;
    reopenedProjection.close();
    assert.deepEqual(
      {
        liveness: daemonlessSettlement.liveness,
        outcome: daemonlessSettlement.outcome,
        exitCode: daemonlessSettlement.exitCode,
      },
      { liveness: "exited", outcome: "succeeded", exitCode: 0 },
    );
    assert.match(String(daemonlessSettlement.resultRef), /^artifact:runtime-result\/sha256\//u);
    const nextReceipt = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Dispatch after runtime adoption",
        taskId: null,
        idempotencyKey: "re-adopt-next-dispatch",
      },
      newBinding,
    );
    assert.equal(typeof nextReceipt.dispatchId, "string");
    await eventually(() =>
      makeTaskEventReader({ repoId, rootDir: root })
        .read()
        .events.some(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.runtimeSessionId === nextReceipt.runtimeSessionId,
        ),
    );

    const taskId = "task-runtime-lost",
      executionId = "execution-runtime-lost",
      binding = {
        actor: { principal: { personId: "owner" }, executor: null },
        source: "local" as const,
      };
    const taskCreateReceipt = await cell.run({ kind: "task-create", taskId, title: "Runtime Lost" }, binding);
    assert.equal(taskCreateReceipt.outcome, "applied", JSON.stringify(taskCreateReceipt));
    await waitForFixturePublication(cell, taskCreateReceipt.opId, binding);
    await realizeTaskPlanFixture(
      root,
      String((taskCreateReceipt as Record<string, unknown>).packagePath),
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
      "Runtime Lost",
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied");
    rmSync(release, { force: true });
    const lostReceipt = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Lose the worker host while the daemon is absent",
        taskId,
        idempotencyKey: "re-adopt-lost",
      },
      binding,
    );
    providerPid = await eventuallyValue(() => {
      try {
        const value = Number(readFileSync(pidFile, "utf8"));
        return Number.isInteger(value) && value > 0 ? value : null;
      } catch {
        return null;
      }
    });
    const lostDispatchId = String(lostReceipt.dispatchId),
      hostPid = await eventuallyValue(() => {
        const started = readFileSync(
          path.join(root, ".harness", "runtime", "dispatches", `${lostDispatchId}.jsonl`),
          "utf8",
        )
          .trim()
          .split(/\r?\n/u)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((record) => record.kind === "process_started");
        return Number.isInteger(started?.pid) && Number(started?.pid) > 0 ? Number(started?.pid) : null;
      });
    await cell.close();
    cell = undefined;
    process.kill(hostPid, "SIGKILL");
    try {
      process.kill(providerPid, "SIGKILL");
    } catch (error) {
      consumeKnownError(error);
    }
    await eventuallyValue(() => {
      try {
        process.kill(hostPid, 0);
        return null;
      } catch {
        return true;
      }
    });
    cell = await open("re-adopt-lost", newFence);
    await eventually(() =>
      makeTaskEventReader({ repoId, rootDir: root })
        .read()
        .events.some(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.runtimeSessionId === lostReceipt.runtimeSessionId,
        ),
    );
    rmSync(path.join(root, ".harness", "runtime", "dispatches", "runtime-sessions.json"), { force: true });
    const lostDispatches = await cell.read("repo.task.dispatches", { taskId }),
      lostRow = lostDispatches.dispatches.find((row) => row.dispatchId === lostDispatchId),
      lostProjection = makeTaskProjection({
        rootDir: root,
        eventStore: makeTaskEventReader({ repoId, rootDir: root }),
      });
    lostProjection.catchUp();
    const lostSession = lostProjection.readRuntimeSession(String(lostReceipt.runtimeSessionId))!;
    lostProjection.close();
    assert.ok(lostRow, "lost dispatch row missing after daemon restart");
    assert.equal(
      readFileSync(path.join(root, ".harness", "runtime", "dispatches", `${lostDispatchId}.jsonl`), "utf8")
        .split(/\r?\n/u)
        .some((line) => line.includes('"kind":"process_lost"')),
      true,
      "daemon restart loss must be durable in the dispatch stream",
    );
    assert.deepEqual(
      {
        status: lostRow.status,
        outcome: lostRow.outcome,
        exitCode: lostRow.exitCode,
        resultRef: lostRow.resultRef,
        liveness: lostSession.liveness,
      },
      {
        status: "lost",
        outcome: "unknown",
        exitCode: null,
        resultRef: lostSession.resultRef,
        liveness: "exited",
      },
    );
  } finally {
    writeFileSync(release, "release");
    await cell?.close();
    oldAuthority?.close();
    newAuthority?.close();
    if (providerPid > 0)
      try {
        process.kill(providerPid, "SIGTERM");
      } catch (error) {
        consumeKnownError(error);
      }
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runtime exit notification records a bounded timeout", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-exit-notification-")),
    executablePath = writeProviderExecutable(
      path.join(root, "hold-notification.mjs"),
      "setInterval(() => undefined, 1_000)\n",
    ),
    records: Array<Record<string, unknown>> = [];
  try {
    launchExitNotification({
      command: executablePath,
      cwd: root,
      stream: {
        appendExitNotification: (value, occurredAt) => records.push({ ...value, occurredAt }),
      },
      payload: {
        schema: "runtime-session-exited/v1",
        runtimeSessionId: "runtime-timeout",
        outcome: "succeeded",
        exitCode: 0,
        nextAction: "ha runtime status runtime-timeout --wait",
      },
      now: () => "2026-08-23T00:00:00.000Z",
      timeoutMs: 50,
    });
    const finished = await eventuallyValue(() => records.find((record) => record.phase === "finished") ?? null);
    assert.deepEqual(
      records.map(({ phase, started, exitCode, timedOut }) => ({
        phase,
        started,
        exitCode,
        timedOut,
      })),
      [
        { phase: "started", started: true, exitCode: null, timedOut: false },
        { phase: "finished", started: true, exitCode: null, timedOut: true },
      ],
    );
    assert.equal(finished.occurredAt, "2026-08-23T00:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function initIngressRepo(root: string, uid: number): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Spawn Test");
  git(root, "config", "user.email", "spawn@example.invalid");
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: runtime-spawn-ingress\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "owner", displayName: "Owner", roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }] }], roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write"] }] }, null, 2)}\n`,
  );
  git(root, "add", "harness");
  git(root, "commit", "-qm", "fixture");
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  await eventuallyValue(async () => ((await check()) ? true : null));
}
async function eventuallyValue<T>(read: () => T | null | Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("runtime provider event did not arrive");
}

function installationFixture(kindId: "claude" | "codex", executablePath: string): RuntimeInstallationWitness {
  return {
    installationId: `installation-${kindId}`,
    kindId,
    executablePath,
    version: "1.0.0",
    observedAt: "2026-08-19T00:00:00.000Z",
  };
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args]);
}
