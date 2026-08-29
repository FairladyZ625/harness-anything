// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventStore,
  type AgentDefinitionSnapshot,
  type RuntimeInstallationWitness,
} from "../../kernel/src/index.ts";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import { readDispatchStream } from "../src/dispatch-stream.ts";
import type { RuntimeProcess } from "../src/runtime-spawn-types.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const bindingSessionId = "runtime_89abcdef0123456789abcdef",
  personBinding = {
    actor: { principal: { personId: "person-parent-session" }, executor: null },
    source: "local" as const,
  },
  executorBinding = {
    actor: {
      principal: { personId: "person-parent-session" },
      executor: { kind: "agent" as const, id: `runtime-session:${bindingSessionId}` },
    },
    source: "local" as const,
  },
  installation: RuntimeInstallationWitness = {
    installationId: "installation-parent-session",
    kindId: "codex",
    executablePath: "/opt/witnessed/parent-session",
    version: "1.0.0",
    observedAt: "2026-08-28T00:00:00.000Z",
  };

test("a local binding executor names the parent runtime session when the caller passes none", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-parent-session-binding-")),
    root = path.join(parent, "repo");
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Parent Session Test");
  git(root, "config", "user.email", "parent-session@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", "base");
  const cell = await openRepoCell({
    repoId: workspaceId("parent-session-binding"),
    rootDir: canonicalRoot(root),
    ownerId: "parent-session-test",
    runtimeInstances: () => [runtimeInstance("codex-parent")],
    prepareRuntimeLaunch: async (instanceId, request) => ({
      definition: definition(instanceId, request.model ?? "codex-parent-model"),
      installation,
      executablePath: installation.executablePath,
      args: ["exec", "--json", "-"],
      env: {},
      cwd: request.cwd,
      prompt: request.prompt,
    }),
    runtimeLaunch: () => fakeProcess(7102, "success"),
  });
  try {
    await installSquad(cell);
    const receipt = await cell.spawnRuntime(
      {
        runtimeInstanceId: "codex-parent",
        agentId: "parent-leader",
        targetAgentId: "parent-worker",
        squadId: "parent-squad",
        cwd: { scope: "repo-root" },
        prompt: "Delegate one worker without an explicit parent field.",
        taskId: null,
        idempotencyKey: "parent-session-binding",
      },
      executorBinding,
    );
    const stream = readDispatchStream(root, String(receipt.dispatchId));
    assert.ok(stream, "delegated dispatch stream exists");
    assert.equal(stream.header.parentRuntimeSessionId, bindingSessionId);
  } finally {
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a leader-only squad decision keeps attribution and settles success or failure from its process exit", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-parent-session-archive-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    taskId = "task_parent_session_archive",
    executionId = "execution-parent-session-archive";
  let launches = 0;
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Parent Session Test");
  git(root, "config", "user.email", "parent-session@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", "base");
  const cell = await openRepoCell({
    repoId: workspaceId("parent-session-archive"),
    rootDir: canonicalRoot(root),
    ownerId: "parent-session-test",
    runtimeDaemonRoute: {
      userRoot,
      daemonId: "parent-session-archive",
      endpoint: path.join(userRoot, "parent-session-archive.sock"),
    },
    runtimeInstances: () => [{ ...runtimeInstance("codex-parent"), permissionMode: "workspace-write" }],
    prepareRuntimeLaunch: async (instanceId, request) => ({
      definition: definition(instanceId, request.model ?? "codex-parent-model"),
      installation,
      executablePath: installation.executablePath,
      args: ["exec", "--json", "-"],
      env: {},
      cwd: request.cwd,
      prompt: request.prompt,
    }),
    runtimeLaunch: () => {
      const attempt = launches;
      launches += 1;
      return fakeProcess(7103 + attempt, attempt === 0 ? "converged" : "failed-converged");
    },
  });
  try {
    await installSquad(cell);
    await startTask(cell, root, taskId, executionId);
    const receipt = await cell.spawnRuntime(
      {
        runtimeInstanceId: "codex-parent",
        agentId: "parent-leader",
        squadId: "parent-squad",
        cwd: { scope: "repo-root" },
        prompt: "Run as the attributed squad leader.",
        taskId,
        idempotencyKey: "parent-session-archive",
      },
      personBinding,
    );
    const stream = readDispatchStream(root, String(receipt.dispatchId));
    assert.ok(stream, "leader dispatch stream exists");
    assert.equal(stream.header.squadId, "parent-squad");
    assert.equal(Object.hasOwn(stream.header, "parentRuntimeSessionId"), false);
    assert.equal(Object.hasOwn(stream.header, "delegatedByAgentId"), false);
    const rows = await eventually(async () => {
      const result = (await cell.read("repo.task.dispatches", { taskId })) as {
        readonly dispatches: readonly {
          readonly squadId?: string;
          readonly parentRuntimeSessionId?: string;
          readonly endedAt: string | null;
          readonly outcome: string | null;
          readonly status: string;
          readonly dispatchPath?: string | null;
        }[];
      };
      const settled = result.dispatches.find((row) => row.endedAt !== null);
      return settled?.dispatchPath ? result.dispatches : null;
    });
    const leaderRow = rows.find((row) => row.squadId === "parent-squad");
    assert.ok(leaderRow, "settled leader row keeps its squad attribution");
    assert.equal(Object.hasOwn(leaderRow, "parentRuntimeSessionId"), false);
    assert.equal(leaderRow.squadId, "parent-squad");
    assert.equal(leaderRow.outcome, "succeeded");
    assert.equal(leaderRow.status, "succeeded");
    const document = (await cell.read("repo.tasks.document.read", {
        taskId,
        path: `artifacts/dispatches/${String(receipt.dispatchId)}.json`,
      })) as { readonly body: string },
      archived = JSON.parse(document.body) as Record<string, unknown>;
    assert.equal(archived.squadId, "parent-squad");
    assert.equal(archived.outcome, "succeeded");
    assert.equal(Object.hasOwn(archived, "parentRuntimeSessionId"), false);
    assert.equal(Object.hasOwn(archived, "delegatedByAgentId"), false);
    assertLeaseReleasedBeforeOutcome(root, taskId, executionId, String(receipt.runtimeSessionId));

    const failedTaskId = "task_parent_session_archive_failed",
      failedExecutionId = "execution-parent-session-archive-failed";
    await startTask(cell, root, failedTaskId, failedExecutionId);
    const failedReceipt = await cell.spawnRuntime(
      {
        runtimeInstanceId: "codex-parent",
        agentId: "parent-leader",
        squadId: "parent-squad",
        cwd: { scope: "repo-root" },
        prompt: "Exit non-zero after declaring convergence.",
        taskId: failedTaskId,
        idempotencyKey: "parent-session-archive-failed",
      },
      personBinding,
    );
    const failedRows = await eventually(async () => {
        const result = (await cell.read("repo.task.dispatches", { taskId: failedTaskId })) as {
          readonly dispatches: readonly {
            readonly runtimeSessionId: string;
            readonly endedAt: string | null;
            readonly outcome: string | null;
            readonly status: string;
          }[];
        };
        return result.dispatches.some((row) => row.endedAt !== null) ? result.dispatches : null;
      }),
      failedRow = failedRows.find((row) => row.runtimeSessionId === failedReceipt.runtimeSessionId);
    assert.ok(failedRow, "failed leader dispatch settles");
    assert.equal(failedRow.outcome, "failed");
    assert.equal(failedRow.status, "failed");
    assertLeaseReleasedBeforeOutcome(root, failedTaskId, failedExecutionId, String(failedReceipt.runtimeSessionId));
  } finally {
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

function assertLeaseReleasedBeforeOutcome(
  rootDir: string,
  taskId: string,
  executionId: string,
  runtimeSessionId: string,
): void {
  const events = makeTaskEventStore({ repoId: "parent-session-archive", rootDir }).read().events,
    releaseIndex = events.findIndex(
      (event) =>
        event.type === "lease_released" &&
        event.taskId === taskId &&
        event.payload.execution.executionId === executionId,
    ),
    outcomeIndex = events.findIndex(
      (event) =>
        event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
    );
  assert.ok(releaseIndex >= 0, `execution lease ${executionId} was released`);
  assert.ok(outcomeIndex >= 0, `runtime session ${runtimeSessionId} has a terminal outcome`);
  assert.ok(releaseIndex < outcomeIndex, "lease release precedes the terminal runtime outcome");
}

async function installSquad(cell: Awaited<ReturnType<typeof openRepoCell>>): Promise<void> {
  for (const declaration of [
    {
      schema: "agent-declaration/v1",
      id: "parent-leader",
      name: "Parent Leader",
      instructions: "Delegate work.",
      runtime_type: "codex",
    },
    {
      schema: "agent-declaration/v1",
      id: "parent-worker",
      name: "Parent Worker",
      instructions: "Do the work.",
      runtime_type: "codex",
    },
    {
      schema: "squad-declaration/v1",
      id: "parent-squad",
      name: "Parent Squad",
      leader: "parent-leader",
      workers: ["parent-worker"],
      leaderTurnBudget: 4,
      roster: "# Parent Squad",
    },
  ])
    assert.equal(
      (
        await cell.run(
          { kind: declaration.schema.startsWith("agent-") ? "agent-install" : "squad-install", declaration },
          personBinding,
        )
      ).outcome,
      "applied",
    );
}

async function startTask(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  rootDir: string,
  taskId: string,
  executionId: string,
): Promise<void> {
  const created = await cell.run({ kind: "task-create", taskId, title: taskId }, personBinding);
  assert.equal(created.outcome, "applied");
  await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
    cell.run({ kind: "doc-submit", paths: [planPath] }, personBinding),
  );
  assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, personBinding)).outcome, "applied");
}

function runtimeInstance(instanceId: string): RuntimeInstanceSummary {
  return {
    schemaVersion: 2,
    instanceId,
    name: instanceId,
    kindId: "codex",
    installationId: installation.installationId,
    providerId: "openai",
    models: [`${instanceId}-model`],
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

function fakeProcess(pid: number, behavior: "success" | "converged" | "failed-converged" | "429"): RuntimeProcess {
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
        const frames = [
          { type: "thread.started", thread_id: `provider-${pid}` },
          ...(behavior === "success"
            ? [{ type: "item.completed", item: { id: "write", type: "file_change", status: "completed" } }]
            : []),
          {
            type: "item.completed",
            item: {
              id: "message",
              type: "agent_message",
              text: behavior.includes("converged")
                ? JSON.stringify({ schema: "squad-decision/v1", action: "converged" })
                : "done",
            },
          },
          { type: "turn.completed" },
        ];
        output?.(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
        exit?.(behavior === "429" || behavior === "failed-converged" ? 1 : 0);
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
  throw new Error("parent-session dispatch did not settle");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args]);
}
