// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  consumeKnownError,
  makeTaskEventStore,
  makeTaskProjection,
  type AgentDefinitionSnapshot,
} from "../../kernel/src/index.ts";
import { type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { appendRuntimeWorkerRecord } from "../src/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { launchExitNotification } from "../src/runtime-spawn.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

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

test("runtime spawn publishes a canonical session and makes it visible in overview", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-spawn-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Spawn Test");
    git(root, "config", "user.email", "spawn@example.invalid");
    git(root, "commit", "--allow-empty", "-qm", "base");
    let launched: unknown,
      intentWasDurable = false;
    const cell = await openRepoCell({
      repoId: workspaceId("runtime-spawn"),
      rootDir: canonicalRoot(root),
      ownerId: "spawn-test",
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Codex Review",
          kindId: "codex",
          installationId: definition.installationId,
          providerId: definition.providerId,
          models: [definition.model, "gpt-5.6-terra"],
          defaultModel: definition.model,
          enabled: true,
          permissionMode: "bypass",
          codex: {
            reasoningEffort: definition.reasoningEffort,
            baseUrl: definition.baseUrl,
            baseUrlConfigured: true,
            wire_api: null,
            requires_openai_auth: null,
            http_headers: null,
          },
          authMode: definition.authMode,
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        },
      ],
      prepareRuntimeLaunch: (instanceId, request) => ({
        definition: {
          ...definition,
          model: request.model ?? definition.model,
          reasoningEffort: request.effort ?? definition.reasoningEffort,
        },
        installation,
        executablePath: installation.executablePath,
        args: [
          "exec",
          "--json",
          ...(request.permissionMode ? ["--sandbox", request.permissionMode] : []),
          "--model",
          request.model ?? definition.model,
          ...(request.effort ? ["--config", `model_reasoning_effort=${JSON.stringify(request.effort)}`] : []),
          "-",
        ],
        env: {
          HOME: "/isolated/codex-review/home",
          OPENAI_API_KEY: "resolved-only-in-daemon",
        },
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: (input) => {
        intentWasDurable = makeTaskEventStore({
          repoId: "runtime-spawn",
          rootDir: root,
        })
          .read()
          .events.some((candidate) => candidate.type === "runtime_dispatch_requested");
        launched = input;
        return {
          pid: 123,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    });
    try {
      const binding = {
        actor: { principal: { personId: "person-spawn" }, executor: null },
        source: "local" as const,
      };
      await assert.rejects(
        cell.spawnRuntime(
          {
            runtimeInstanceId: "codex-review",
            permission_mode: "read-only",
            cwd: { scope: "repo-root" },
            prompt: "Reject the misspelled field",
            taskId: null,
            idempotencyKey: "spawn-unknown-field",
          },
          binding,
        ),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "invalid_runtime_spawn" &&
          error.message ===
            'Runtime spawn payload contains an unknown field "permission_mode"; allowed fields: "runtimeInstanceId", "dispatchId", "agentId", "targetAgentId", "model", "effort", "permissionMode", "cwd", "prompt", "promptSource", "onExitCommand", "taskId", "idempotencyKey", "providerSessionId".',
      );
      await assert.rejects(
        cell.cancelRuntime({ runtimeSessionId: "missing", force: true }, binding),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "invalid_runtime_cancel" &&
          error.message ===
            'Runtime cancel payload contains an unknown field "force"; allowed fields: "runtimeSessionId".',
      );
      const receipt = await cell.spawnRuntime(
        {
          runtimeInstanceId: "codex-review",
          cwd: { scope: "repo-root" },
          prompt: "Inspect the repository",
          taskId: null,
          idempotencyKey: "spawn-once",
        },
        {
          actor: { principal: { personId: "person-spawn" }, executor: null },
          source: "local",
        },
      );
      assert.equal(receipt.outcome, "applied");
      assert.equal(intentWasDurable, true);
      assert.deepEqual(launched, {
        definition,
        installation,
        executablePath: "/opt/witnessed/codex",
        args: ["exec", "--json", "--model", "gpt-5.6-sol", "-"],
        env: {
          HOME: "/isolated/codex-review/home",
          OPENAI_API_KEY: "resolved-only-in-daemon",
        },
        cwd: canonicalRoot(root),
        prompt: "Inspect the repository",
      });
      const events = makeTaskEventStore({
          repoId: "runtime-spawn",
          rootDir: root,
        }).read().events,
        observed = events.find((candidate) => candidate.type === "runtime_installation_observed"),
        dispatch = events.find((candidate) => candidate.type === "runtime_dispatch_requested"),
        started = events.find((candidate) => candidate.type === "runtime_session_started");
      assert.equal(
        observed?.type === "runtime_installation_observed" && observed.payload.installationId,
        definition.installationId,
      );
      assert.equal(
        observed?.type === "runtime_installation_observed" && observed.payload.version,
        installation.version,
      );
      assert.equal(events.indexOf(observed!), 0);
      assert.equal(events.indexOf(dispatch!), 1);
      assert.equal(
        dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.instanceId,
        definition.instanceId,
      );
      assert.equal(
        dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.installationId,
        definition.installationId,
      );
      assert.deepEqual(
        dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.definitionSnapshot,
        definition,
      );
      assert.equal(started?.type === "runtime_session_started" && started.payload.instanceId, definition.instanceId);
      assert.equal(
        started?.type === "runtime_session_started" && started.payload.installationId,
        definition.installationId,
      );
      assert.equal(
        started?.type === "runtime_session_started" && started.payload.definitionSnapshotRef,
        dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.definitionSnapshotRef,
      );
      const overview = await cell.read("repo.agentRuntime.overview", {});
      const session = overview.sessions.find((candidate) => candidate.runtimeSessionId === receipt.runtimeSessionId);
      assert.equal(session?.instanceId, definition.instanceId);
      assert.deepEqual(session?.definitionSnapshot, definition);
      const alternate = await cell.spawnRuntime(
        {
          runtimeInstanceId: "codex-review",
          model: "gpt-5.6-terra",
          cwd: { scope: "repo-root" },
          prompt: "Inspect with alternate model",
          taskId: null,
          idempotencyKey: "spawn-terra",
        },
        {
          actor: { principal: { personId: "person-spawn" }, executor: null },
          source: "local",
        },
      );
      assert.equal(alternate.outcome, "applied");
      assert.deepEqual(launched, {
        definition: { ...definition, model: "gpt-5.6-terra" },
        installation,
        executablePath: "/opt/witnessed/codex",
        args: ["exec", "--json", "--model", "gpt-5.6-terra", "-"],
        env: {
          HOME: "/isolated/codex-review/home",
          OPENAI_API_KEY: "resolved-only-in-daemon",
        },
        cwd: canonicalRoot(root),
        prompt: "Inspect with alternate model",
      });
      const low = await cell.spawnRuntime(
        {
          runtimeInstanceId: "codex-review",
          effort: "low",
          cwd: { scope: "repo-root" },
          prompt: "Mechanical task",
          taskId: null,
          idempotencyKey: "spawn-low",
        },
        {
          actor: { principal: { personId: "person-spawn" }, executor: null },
          source: "local",
        },
      );
      assert.equal(low.outcome, "applied");
      assert.deepEqual(launched, {
        definition: { ...definition, reasoningEffort: "low" },
        installation,
        executablePath: "/opt/witnessed/codex",
        args: ["exec", "--json", "--model", "gpt-5.6-sol", "--config", 'model_reasoning_effort="low"', "-"],
        env: {
          HOME: "/isolated/codex-review/home",
          OPENAI_API_KEY: "resolved-only-in-daemon",
        },
        cwd: canonicalRoot(root),
        prompt: "Mechanical task",
      });
      const locked = await cell.spawnRuntime(
        {
          runtimeInstanceId: "codex-review",
          permissionMode: "read-only",
          cwd: { scope: "repo-root" },
          prompt: "Locked task",
          taskId: null,
          idempotencyKey: "spawn-locked",
        },
        {
          actor: { principal: { personId: "person-spawn" }, executor: null },
          source: "local",
        },
      );
      assert.equal(locked.outcome, "applied");
      assert.deepEqual((launched as { args: string[] }).args, [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--model",
        "gpt-5.6-sol",
        "-",
      ]);
      const xhigh = await cell.spawnRuntime(
        {
          runtimeInstanceId: "codex-review",
          effort: "xhigh",
          cwd: { scope: "repo-root" },
          prompt: "Hard task",
          taskId: null,
          idempotencyKey: "spawn-xhigh",
        },
        {
          actor: { principal: { personId: "person-spawn" }, executor: null },
          source: "local",
        },
      );
      assert.equal(xhigh.outcome, "applied");
      assert.deepEqual(launched, {
        definition: { ...definition, reasoningEffort: "xhigh" },
        installation,
        executablePath: "/opt/witnessed/codex",
        args: ["exec", "--json", "--model", "gpt-5.6-sol", "--config", 'model_reasoning_effort="xhigh"', "-"],
        env: {
          HOME: "/isolated/codex-review/home",
          OPENAI_API_KEY: "resolved-only-in-daemon",
        },
        cwd: canonicalRoot(root),
        prompt: "Hard task",
      });
      const current = (await cell.read("repo.agentRuntime.overview", {})).instances[0];
      assert.equal(current?.kindId, "codex");
      if (current?.kindId === "codex") assert.equal(current.codex.reasoningEffort, "high");
      await assert.rejects(
        cell.spawnRuntime(
          {
            kindId: "codex",
            installationId: "installation-codex",
            profileId: "default",
            cwd: { scope: "repo-root" },
            prompt: "Legacy",
            taskId: null,
            idempotencyKey: "legacy",
          },
          {
            actor: { principal: { personId: "person-spawn" }, executor: null },
            source: "local",
          },
        ),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_runtime_spawn",
      );
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attached runtime settlement includes provider records persisted after attach before exit", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-attached-tail-"));
  let exit: ((code: number | null) => void) | null = null;
  try {
    initIngressRepo(root, 4310);
    const cell = await openRepoCell({
      repoId: workspaceId("runtime-attached-tail"),
      rootDir: canonicalRoot(root),
      ownerId: "attached-tail-test",
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
      const receipt = await cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Settle the durable tail after attach",
          taskId: null,
          idempotencyKey: "attached-tail",
        },
        {
          actor: { principal: { personId: "person-attached-tail" }, executor: null },
          source: "local",
        },
      );
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
      await eventually(() =>
        makeTaskEventStore({ repoId: "runtime-attached-tail", rootDir: root })
          .read()
          .events.some(
            (event) =>
              event.type === "runtime_session_outcome_observed" &&
              event.payload.runtimeSessionId === receipt.runtimeSessionId,
          ),
      );
      const projection = makeTaskProjection({
          rootDir: root,
          eventStore: makeTaskEventStore({ repoId: "runtime-attached-tail", rootDir: root }),
        }),
        settled = projection.readRuntimeSession(String(receipt.runtimeSessionId))!;
      projection.close();
      assert.deepEqual(
        {
          liveness: settled.liveness,
          outcome: settled.outcome,
          exitCode: settled.exitCode,
        },
        { liveness: "exited", outcome: "succeeded", exitCode: 0 },
      );
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
    providerPid = 0;
  try {
    initIngressRepo(root, 4309);
    const open = (ownerId: string) =>
      openRepoCell({
        repoId: workspaceId(repoId),
        rootDir: canonicalRoot(root),
        ownerId,
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
    cell = await open("re-adopt-before");
    const receipt = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Stay alive across restart",
        taskId: null,
        idempotencyKey: "re-adopt",
      },
      {
        actor: { principal: { personId: "person-re-adopt" }, executor: null },
        source: "local",
      },
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
    await cell.close();
    cell = undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.doesNotThrow(() => process.kill(providerPid, 0), "repo-cell close must not terminate its runtime worker");
    cell = await open("re-adopt-after");
    writeFileSync(release, "release");
    await eventually(() =>
      makeTaskEventStore({ repoId, rootDir: root })
        .read()
        .events.some(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.runtimeSessionId === receipt.runtimeSessionId,
        ),
    );
    const projection = makeTaskProjection({
        rootDir: root,
        eventStore: makeTaskEventStore({ repoId, rootDir: root }),
      }),
      settled = projection.readRuntimeSession(String(receipt.runtimeSessionId))!;
    projection.close();
    assert.deepEqual(
      {
        liveness: settled.liveness,
        outcome: settled.outcome,
        exitCode: settled.exitCode,
      },
      { liveness: "exited", outcome: "succeeded", exitCode: 0 },
    );
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
      {
        actor: { principal: { personId: "person-re-adopt" }, executor: null },
        source: "local",
      },
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
    cell = await open("re-adopt-dead");
    await eventually(() =>
      makeTaskEventStore({ repoId, rootDir: root })
        .read()
        .events.some(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.runtimeSessionId === absentReceipt.runtimeSessionId,
        ),
    );
    const reopenedProjection = makeTaskProjection({
        rootDir: root,
        eventStore: makeTaskEventStore({ repoId, rootDir: root }),
      }),
      daemonlessSettlement = reopenedProjection.readRuntimeSession(String(absentReceipt.runtimeSessionId))!;
    reopenedProjection.close();
    assert.deepEqual(
      {
        liveness: daemonlessSettlement.liveness,
        outcome: daemonlessSettlement.outcome,
        exitCode: daemonlessSettlement.exitCode,
      },
      { liveness: "exited", outcome: "succeeded", exitCode: 0 },
    );
  } finally {
    writeFileSync(release, "release");
    await cell?.close();
    if (providerPid > 0)
      try {
        process.kill(providerPid, "SIGTERM");
      } catch (error) {
        consumeKnownError(error);
      }
    rmSync(parent, { recursive: true, force: true });
  }
});

test("explicit runtime cancel terminates every detached native provider descendant group", { skip: process.platform === "win32" ? "requires POSIX process-group semantics" : false }, async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-detached-cancel-")),
    root = path.join(parent, "repo"),
    pidFile = path.join(parent, "provider-pids.json"),
    repoId = "runtime-detached-cancel",
    executablePath = writeProviderExecutable(
      path.join(parent, "cancel-tree-provider.mjs"),
      `import fs from "node:fs"; import { spawn } from "node:child_process";\nfs.readFileSync(0, "utf8"); const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore", detached: true }); child.unref(); fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid])); console.log(JSON.stringify({ type: "thread.started", thread_id: "provider-cancel-tree" })); setInterval(() => undefined, 1000);\n`,
    ),
    installation = installationFixture("codex", executablePath),
    instance = {
      schemaVersion: 2 as const,
      instanceId: "codex-cancel-tree",
      name: "Codex Cancel Tree",
      kindId: "codex" as const,
      installationId: installation.installationId,
      providerId: "openai",
      models: ["codex-model"],
      defaultModel: "codex-model",
      enabled: true,
      permissionMode: "read-only" as const,
      codex: {},
      authMode: "subscription" as const,
      authState: "configured" as const,
      authReadiness: { status: "ready" as const, code: null, hint: null },
      isolationState: "enforced" as const,
    },
    preparedDefinition: AgentDefinitionSnapshot = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "codex-cancel-tree",
      installationId: installation.installationId,
      kindId: "codex",
      providerId: "openai",
      model: "codex-model",
      reasoningEffort: null,
      baseUrl: null,
      authMode: "subscription",
    };
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    runtimeSessionId = "",
    pids: number[] = [];
  try {
    initIngressRepo(root, 4310);
    cell = await openRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(root),
      ownerId: "cancel-tree",
      runtimeInstances: () => [instance],
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
    const spawned = await cell.spawnRuntime(
      {
        runtimeInstanceId: instance.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Wait for cancellation",
        taskId: null,
        idempotencyKey: "cancel-tree",
      },
      {
        actor: {
          principal: { personId: "person-cancel-tree" },
          executor: null,
        },
        source: "local",
      },
    );
    runtimeSessionId = String(spawned.runtimeSessionId);
    pids = await eventuallyValue(() => {
      try {
        const values = JSON.parse(readFileSync(pidFile, "utf8")) as number[];
        return values.length === 2 && values.every((pid) => Number.isInteger(pid) && pid > 0) ? values : null;
      } catch {
        return null;
      }
    });
    const hostPid = await eventuallyValue(() => {
      try {
        const records = readFileSync(
            path.join(root, ".harness", "runtime", "dispatches", `${String(spawned.dispatchId)}.jsonl`),
            "utf8",
          )
            .trim()
            .split(/\r?\n/u)
            .map((line) => JSON.parse(line) as Record<string, unknown>),
          pid = records.find((record) => record.kind === "process_started")?.pid;
        return Number.isInteger(pid) && Number(pid) > 0 ? Number(pid) : null;
      } catch {
        return null;
      }
    });
    pids = [hostPid, ...pids];
    assert.equal(
      (
        await cell.cancelRuntime(
          { runtimeSessionId },
          {
            actor: {
              principal: { personId: "person-cancel-tree" },
              executor: null,
            },
            source: "local",
          },
        )
      ).detail,
      "cancelled",
    );
    const streamPath = path.join(root, ".harness", "runtime", "dispatches", `${String(spawned.dispatchId)}.jsonl`),
      descendants = await eventuallyValue(() => {
        const records = readFileSync(streamPath, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
        return records.find((record) => record.kind === "process_descendants") ?? null;
      });
    assert.deepEqual((descendants.pids as number[]).slice().sort((left, right) => left - right), pids.slice().sort((left, right) => left - right));
    const survivors = pids.filter((pid) => {
      try { process.kill(pid, 0); return true; }
      catch { return false; }
    });
    assert.deepEqual(survivors, [], `cancel survivors: ${JSON.stringify(survivors)}`);
    t.diagnostic(`cancel descendants=${JSON.stringify(pids)} survivors=${JSON.stringify(survivors)}`);
  } finally {
    if (runtimeSessionId)
      try {
        await cell?.cancelRuntime(
          { runtimeSessionId },
          {
            actor: {
              principal: { personId: "person-cancel-tree" },
              executor: null,
            },
            source: "local",
          },
        );
      } catch (error) {
        consumeKnownError(error);
      }
    await cell?.close();
    for (const pid of pids)
      try {
        process.kill(pid, "SIGTERM");
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
