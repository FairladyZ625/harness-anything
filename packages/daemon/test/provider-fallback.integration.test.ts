// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import type { RuntimeInstanceSummary, RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import type { TaskDispatchRow } from "../src/protocol/daemon-protocol.contract.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import type { RuntimeProcess } from "../src/runtime-spawn-types.ts";

const binding = {
  actor: { principal: { personId: "person-provider-fallback" }, executor: null },
  source: "local" as const,
};
const installation: RuntimeInstallationWitness = {
  installationId: "installation-provider-fallback",
  kindId: "codex",
  executablePath: "/opt/witnessed/provider-fallback",
  version: "1.0.0",
  observedAt: "2026-08-26T00:00:00.000Z",
};
const behaviors = new Map<string, "429" | "success" | "worker_stop">([
  ["provider-rate-first", "429"],
  ["provider-success-second", "success"],
  ["provider-rate-a", "429"],
  ["provider-rate-b", "429"],
  ["provider-stop-first", "worker_stop"],
  ["provider-unused-second", "success"],
]);

test("provider fallback switches attempts, exhausts to blocked, and never switches on worker_stop", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-provider-fallback-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    instances = [...behaviors.keys()].map(runtimeInstance),
    prompts = new Map<string, string[]>();
  let pid = 9000;
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Provider Fallback Test");
  git(root, "config", "user.email", "provider-fallback@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", "base");
  const cell = await openRepoCell({
    repoId: workspaceId("provider-fallback"),
    rootDir: canonicalRoot(root),
    ownerId: "provider-fallback",
    runtimeDaemonRoute: {
      userRoot,
      daemonId: "provider-fallback",
      endpoint: path.join(userRoot, "provider-fallback.sock"),
    },
    runtimeInstances: () => instances,
    prepareRuntimeLaunch: async (instanceId, request) => ({
      definition: definition(instanceId, request.model ?? `${instanceId}-model`),
      installation,
      executablePath: installation.executablePath,
      args: ["exec", "--json", "-"],
      env: {},
      cwd: request.cwd,
      prompt: request.prompt,
    }),
    runtimeLaunch: (prepared) => {
      const instanceId = prepared.definition.instanceId,
        behavior = behaviors.get(instanceId);
      assert.ok(behavior, `missing fake behavior for ${instanceId}`);
      prompts.set(instanceId, [...(prompts.get(instanceId) ?? []), prepared.prompt]);
      return fakeProcess(++pid, behavior);
    },
  });
  try {
    await installAgent(cell, "fallback-success", [
      { instance: "provider-rate-first" },
      { instance: "provider-success-second", model: "provider-success-model" },
    ]);
    await startTask(cell, "task_provider_fallback_success", "execution-provider-fallback-success");
    await cell.spawnRuntime(
      {
        agentId: "fallback-success",
        cwd: { scope: "repo-root" },
        prompt: "Finish the success fallback mission.",
        taskId: "task_provider_fallback_success",
        idempotencyKey: "provider-fallback-success",
      },
      binding,
    );
    const succeeded = await eventually(async () => {
      const rows = (await cell.read("repo.task.dispatches", { taskId: "task_provider_fallback_success" })).dispatches;
      return rows.length === 2 && rows[1]?.status === "succeeded" ? rows : null;
    });
    assertAttemptChain(succeeded, ["provider-rate-first", "provider-success-second"]);
    assert.deepEqual(
      succeeded.map(({ classification }) => classification),
      ["provider_fault", "worker_stop"],
    );
    assert.doesNotMatch(JSON.stringify(succeeded), /sk-provider-fallback-secret/u);
    assert.match(prompts.get("provider-success-second")?.[0] ?? "", /# Provider fallback continuation/u);
    assert.match(
      prompts.get("provider-success-second")?.[0] ?? "",
      /上次 attempt 用 provider-rate-first\/provider-rate-first-model 因/u,
    );
    assert.doesNotMatch(prompts.get("provider-success-second")?.[0] ?? "", /sk-provider-fallback-secret/u);
    const runtimeStatus = await cell.read("repo.agentRuntime.sessions.read", {
      runtimeSessionId: succeeded[0]!.runtimeSessionId,
    });
    assert.deepEqual(
      runtimeStatus.session.attemptChain?.attempts.map(({ attemptIndex, provider, classification }) => ({
        attemptIndex,
        provider: provider.instance,
        classification,
      })),
      [
        { attemptIndex: 0, provider: "provider-rate-first", classification: "provider_fault" },
        { attemptIndex: 1, provider: "provider-success-second", classification: "worker_stop" },
      ],
    );

    await installAgent(cell, "fallback-exhausted", [{ instance: "provider-rate-a" }, { instance: "provider-rate-b" }]);
    await startTask(cell, "task_provider_fallback_exhausted", "execution-provider-fallback-exhausted");
    await cell.spawnRuntime(
      {
        agentId: "fallback-exhausted",
        cwd: { scope: "repo-root" },
        prompt: "Exhaust the provider chain.",
        taskId: "task_provider_fallback_exhausted",
        idempotencyKey: "provider-fallback-exhausted",
      },
      binding,
    );
    const exhausted = await eventually(async () => {
      const task = (await cell.read("repo.tasks.list")).rows.find(
          (row) => row.taskId === "task_provider_fallback_exhausted",
        ),
        rows = (
          await cell.read("repo.task.dispatches", {
            taskId: "task_provider_fallback_exhausted",
          })
        ).dispatches;
      return task?.snapshot.task?.status === "blocked" && rows.length === 2 ? { task, rows } : null;
    });
    assert.equal(exhausted.task.snapshot.task?.status, "blocked", JSON.stringify(exhausted.task.snapshot));
    assert.equal(exhausted.task.snapshot.lease, null);
    assert.equal(exhausted.rows.filter(({ status }) => status === "running").length, 0);
    assert.deepEqual(
      exhausted.rows.map(({ classification }) => classification),
      ["provider_fault", "provider_fault"],
    );
    assert.equal(exhausted.rows[1]?.fallbackState, "exhausted");

    await installAgent(cell, "fallback-worker-stop", [
      { instance: "provider-stop-first" },
      { instance: "provider-unused-second" },
    ]);
    await startTask(cell, "task_provider_worker_stop", "execution-provider-worker-stop");
    await cell.spawnRuntime(
      {
        agentId: "fallback-worker-stop",
        cwd: { scope: "repo-root" },
        prompt: "Stop normally without switching provider.",
        taskId: "task_provider_worker_stop",
        idempotencyKey: "provider-worker-stop",
      },
      binding,
    );
    const stopped = await eventually(async () => {
      const rows = (await cell.read("repo.task.dispatches", { taskId: "task_provider_worker_stop" })).dispatches;
      return rows.length === 1 && rows[0]?.status === "succeeded" ? rows : null;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      (await cell.read("repo.task.dispatches", { taskId: "task_provider_worker_stop" })).dispatches.length,
      1,
    );
    assert.equal(stopped[0]?.classification, "worker_stop");
    assert.equal(prompts.has("provider-unused-second"), false);
  } finally {
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

async function installAgent(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  agentId: string,
  chain: readonly { readonly instance: string; readonly model?: string }[],
): Promise<void> {
  const receipt = await cell.run(
    {
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: agentId,
        name: agentId,
        instructions: "Execute the assigned mission.",
        runtime_type: "codex",
        fallback: { enabled: true, chain, backoff: { baseMs: 1, maxMs: 2, maxAttempts: chain.length } },
      },
    },
    binding,
  );
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
}

async function startTask(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  taskId: string,
  executionId: string,
): Promise<void> {
  assert.equal((await cell.run({ kind: "task-create", taskId, title: taskId }, binding)).outcome, "applied");
  assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied");
}

function assertAttemptChain(rows: readonly TaskDispatchRow[], providers: readonly string[]): void {
  assert.deepEqual(
    rows.map(({ attemptIndex }) => attemptIndex),
    providers.map((_, index) => index),
  );
  assert.deepEqual(
    rows.map(({ provider }) => provider.instance),
    providers,
  );
  assert.equal(new Set(rows.map(({ attemptGroupId }) => attemptGroupId)).size, 1);
  assert.equal(rows[0]?.fallbackState, "dispatched");
  assert.equal(rows[0]?.nextDispatchId, rows[1]?.dispatchId);
}

function runtimeInstance(instanceId: string): RuntimeInstanceSummary {
  return {
    schemaVersion: 2,
    instanceId,
    name: instanceId,
    kindId: "codex",
    installationId: installation.installationId,
    providerId: "openai",
    models: [`${instanceId}-model`, "provider-success-model"],
    defaultModel: `${instanceId}-model`,
    enabled: true,
    permissionMode: "read-only",
    codex: {
      reasoningEffort: null,
      baseUrl: null,
      baseUrlConfigured: false,
      wire_api: null,
      requires_openai_auth: null,
      http_headers: null,
    },
    authMode: "subscription",
    authState: "configured",
    authReadiness: { status: "ready", code: null, hint: null },
    isolationState: "enforced",
  };
}

function definition(instanceId: string, model: string): AgentDefinitionSnapshot {
  return {
    schema: "agent-definition-snapshot/v1",
    configVersion: 1,
    instanceId,
    installationId: installation.installationId,
    kindId: "codex",
    providerId: "openai",
    model,
    reasoningEffort: null,
    baseUrl: null,
    authMode: "subscription",
  };
}

function fakeProcess(pid: number, behavior: "429" | "success" | "worker_stop"): RuntimeProcess {
  let output: ((chunk: string) => void) | null = null,
    exit: ((code: number | null) => void) | null = null,
    terminated = false;
  return {
    pid,
    onOutput: (listener) => {
      output = listener;
    },
    onErrorOutput: () => undefined,
    onExit: (listener) => {
      exit = listener;
      setImmediate(() => {
        if (terminated) return;
        const frames =
          behavior === "429"
            ? [
                { type: "thread.started", thread_id: `provider-${pid}` },
                {
                  type: "turn.failed",
                  error: {
                    http_status: 429,
                    code: "rate_limit",
                    message: "quota exhausted OPENAI_API_KEY=sk-provider-fallback-secret",
                  },
                },
              ]
            : [
                { type: "thread.started", thread_id: `provider-${pid}` },
                ...(behavior === "success"
                  ? [{ type: "item.completed", item: { id: "write", type: "file_change", status: "completed" } }]
                  : []),
                { type: "item.completed", item: { id: "message", type: "agent_message", text: "done" } },
                { type: "turn.completed" },
              ];
        output?.(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
        exit?.(behavior === "429" ? 1 : 0);
      });
    },
    terminate: () => {
      terminated = true;
    },
  };
}

async function eventually<T>(read: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("provider fallback did not settle");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args]);
}
