import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";
import { BuiltinPolicyAdapter, builtinAuthorityUrl } from "@harness-anything/authorization/builtin";
import { isExecutionWipTask } from "@harness-anything/kernel";
import { makeTaskProjectionReader } from "@harness-anything/storage";
import { appendRuntimeWorkerRecord } from "../src/daemon-host/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { acquireWorkspaceLock } from "../src/daemon-host/repo-cell-lock.ts";
import { openRepoWriterCell } from "../src/daemon-host/repo-cell-open.ts";
import type { RuntimeLauncher } from "../src/daemon-host/runtime-spawn-types.ts";
import type { SquadRunReadResult } from "../src/daemon-host/squad-run-contract.ts";
import { waitForArrival } from "../../../tools/fixtures/event-arrival.ts";
import { realizedTaskPlan, realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { fixtureFence, settleSettingsEvent, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { evidence, git } from "./task-surface.fixtures.ts";

export type WorkerAttempt = SquadRunReadResult["run"]["workerAttempts"][number];

export type Provider = {
  prompt: string;
  cwd: string;
  dispatchId: string;
  sessionId: string;
  output?: (chunk: string) => void;
  exit?: (code: number | null) => void;
  process?: ReturnType<typeof spawn>;
};

export type WorkerAttemptView = Pick<
  WorkerAttempt,
  "dispatchId" | "runtimeSessionId" | "taskId" | "executionId" | "worktree" | "rejection"
>;

export type Status = {
  squadRunId: string;
  status: string;
  error: string | null;
  leaderTurns: Array<{ dispatchId: string; runtimeSessionId: string }>;
  workerAttempts: WorkerAttemptView[];
  workerCallbackCount: number;
  pendingLeaderCallbackCount: number;
};

const identityRoot = mkdtempSync(path.join(tmpdir(), "ha-squad-identity-")),
  identityProvider = new BuiltinPolicyAdapter({ userRoot: identityRoot }),
  owner = identityProvider.addUser({
    username: "squad-owner",
    personId: "squad-owner",
    displayName: "Squad Owner",
    email: "squad-owner@example.invalid",
    password: "fixture-password",
  }),
  accessToken = "squad-fixture-owner-session",
  centerToken = identityProvider.issueCenterToken(),
  identityUrl = builtinAuthorityUrl(identityRoot);

identityProvider.registerSession(accessToken, {
  personId: owner.personId,
  subject: owner.userId,
  expiresAt: Date.now() + 3_600_000,
  sessionExpiresAt: null,
  roles: ["admin"],
});

const localCenter = async () => ({
  url: identityUrl,
  realm: "local",
  clientId: "harness-center",
  accessToken: centerToken,
  provider: identityProvider,
});

export const binding = {
  actor: { principal: { personId: owner.personId }, executor: { kind: "agent" as const, id: "coordinator" } },
  source: "local" as const,
  keycloakAuthorization: {
    session: {
      provider: identityProvider,
      personId: owner.personId,
      accessToken,
      url: identityUrl,
      realm: "local",
      clientId: "harness-center",
    },
    center: localCenter,
  },
};

let gitTemplate: { readonly dir: string; readonly root: string; readonly bare: string } | null = null;
const suiteClosers: Array<() => Promise<void>> = [];

after(async () => {
  await Promise.all(suiteClosers.map((close) => close()));
  if (gitTemplate !== null) rmSync(gitTemplate.dir, { recursive: true, force: true });
  rmSync(identityRoot, { recursive: true, force: true });
});

function ensureGitTemplate(): { readonly root: string; readonly bare: string } {
  if (gitTemplate !== null) return gitTemplate;
  const dir = mkdtempSync(path.join(tmpdir(), "ha-squad-git-template-")),
    root = path.join(dir, "repo"),
    bare = path.join(dir, "remote.git");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Task Surface Test");
  git(root, "config", "user.email", "task-surface@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", "base");
  git(dir, "init", "--bare", bare);
  git(root, "remote", "add", "origin", bare);
  writeFileSync(path.join(root, ".gitignore"), "harness/\n.harness/\n.worktrees/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "test: fixture boundaries");
  gitTemplate = { dir, root, bare };
  return gitTemplate;
}

export async function stopFixtureProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  } else {
    child.kill("SIGKILL");
  }
  await closed;
}

// Exercise the real single writer and durable storage directly. Supervisor/reader RPC and
// their cold worker imports have separate integration coverage; this suite owns orchestration.
export const openOrchestrationCell = async (input: Parameters<typeof openRepoWriterCell>[0]) => {
  await identityProvider.claimRepositoryOwner(centerToken, input.repoId, owner.personId);
  const fence = fixtureFence(
    input.repoId,
    input.rootDir,
    path.join(input.rootDir, ".harness", "fixture-writer-epochs"),
    input.storage,
  );
  await settleSettingsEvent({ ...input, writerEpochFence: fence, runtimeInstances: input.runtimeInstances?.() });
  const lock = await acquireWorkspaceLock(input.rootDir);
  try {
    return await openRepoWriterCell({ keycloakCenter: localCenter, ...input, defaultWriterEpochFence: fence }, lock);
  } catch (error) {
    await lock.close();
    throw error;
  }
};

type OrchestrationHost = {
  readonly parent: string;
  readonly root: string;
  readonly bare: string;
  readonly repoId: string;
  readonly cell: Awaited<ReturnType<typeof openOrchestrationCell>>;
  readonly allProviders: Provider[];
  activeProviders: Provider[] | null;
  readonly taskProjection: ReturnType<typeof makeTaskProjectionReader>;
  readonly onActivity: (arrive: () => void) => () => boolean;
  readonly reopen: () => Promise<void>;
  readonly close: () => Promise<void>;
};

export type SuiteHost = {
  readonly get: () => Promise<OrchestrationHost>;
};

async function createOrchestrationHost(slug: string, wipLimit?: number): Promise<OrchestrationHost> {
  const template = ensureGitTemplate(),
    parent = mkdtempSync(path.join(tmpdir(), `ha-squad-e2e-${slug}-`)),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    bare = path.join(parent, "remote.git"),
    repoId = workspaceId(`squad-e2e-${slug}`),
    allProviders: Provider[] = [],
    // Every runtime launch and outcome wakes the waiters; a waiter drains the writer queue before it
    // reads, so a coordinator reaction scheduled by that event is visible to the read it triggers.
    activityWaiters = new Set<() => void>(),
    wakeActivity = () => {
      for (const wake of activityWaiters) wake();
    },
    onActivity = (arrive: () => void) => {
      activityWaiters.add(arrive);
      return () => activityWaiters.delete(arrive);
    };
  cpSync(template.bare, bare, { recursive: true });
  cpSync(template.root, root, { recursive: true });
  git(root, "remote", "set-url", "origin", bare);
  mkdirSync(path.join(root, "harness"));
  // Workers deliver repository commits; the parent task delivers the Squad synthesis report.
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  defaultVertical: software/coding\n  defaultPreset: standard-task\n  defaultProfile: baseline\n" +
      (wipLimit === undefined ? "" : `  tasks:\n    wipLimit: ${wipLimit}\n`),
  );
  let activeProviders: Provider[] | null = null;
  const runtimeLaunch: RuntimeLauncher = (prepared, persistence) => {
    // Git is already required by the fixture. Its stdin reader supplies a real PID
    // without booting another JavaScript runtime for a process that only waits.
    const child = spawn("git", ["hash-object", "--stdin"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (!child.pid) throw new Error("fixture worker child did not expose a pid");
    child.unref();
    const provider: Provider = {
      prompt: prepared.prompt,
      cwd: prepared.cwd,
      dispatchId: persistence.dispatchId,
      sessionId: prepared.args[0] ?? `provider-${persistence.dispatchId}`,
      process: child,
    };
    allProviders.push(provider);
    if (activeProviders !== null && activeProviders !== allProviders) activeProviders.push(provider);
    queueMicrotask(wakeActivity);
    return {
      pid: child.pid,
      onOutput: (listener) => {
        provider.output = listener;
        queueMicrotask(() =>
          listener(JSON.stringify({ type: "thread.started", thread_id: provider.sessionId }) + "\n"),
        );
      },
      onErrorOutput: () => undefined,
      onExit: (listener) => {
        provider.exit = listener;
      },
      terminate: () => {
        void stopFixtureProcess(child);
      },
      terminateTree: () => stopFixtureProcess(child),
    };
  };
  const open = () =>
    openOrchestrationCell({
      keycloakSession: async () => binding.keycloakAuthorization.session,
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: `squad-${slug}`,
      runtimeDaemonRoute: {
        userRoot,
        daemonId: "test",
        endpoint: path.join(parent, "socket"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: "stub",
          name: "Stub",
          kindId: "codex",
          installationId: "installation-stub",
          providerId: "openai",
          models: ["stub-model"],
          defaultModel: "stub-model",
          enabled: true,
          permissionMode: "workspace-write",
          codex: {},
          authMode: "subscription",
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        },
      ],
      prepareRuntimeLaunch: (instanceId, request) => ({
        definition: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId,
          installationId: "installation-stub",
          kindId: "codex",
          providerId: "openai",
          model: "stub-model",
          reasoningEffort: null,
          endpointKind: "official",
          baseUrlHash: null,
          authMode: "subscription",
        },
        installation: {
          installationId: "installation-stub",
          kindId: "codex",
          executablePath: "/fixture/stub",
          version: "1.0.0",
          observedAt: "2026-09-20T00:00:00.000Z",
        },
        executablePath: "/fixture/stub",
        args: request.providerSessionId ? [request.providerSessionId] : [],
        env: process.env,
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch,
      onRuntimeOutcome: () => {
        wakeActivity();
      },
    });
  let cell = await open(),
    closed = false;
  const taskProjection = makeTaskProjectionReader({ rootDir: root });
  await Promise.all(
    [
      ["leader", "commander"],
      ["one", "worker"],
      ["two", "worker"],
    ].map(async ([id, role]) => {
      const receipt = await cell.run(
        {
          kind: "agent-install",
          declaration: {
            schema: "agent-declaration/v1",
            id,
            name: id,
            role,
            instructions: "Perform the assigned role.",
            runtimes: [{ type: "codex" }],
          },
        },
        binding,
      );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    }),
  );
  const installed = await cell.run(
    {
      kind: "squad-install",
      declaration: {
        schema: "squad-declaration/v1",
        id: "squad",
        name: "Squad",
        leader: "leader",
        workers: ["one", "two"],
        leaderTurnBudget: 4,
        roster: "Leader integrates two independent workers and writes artifacts/reports/{squadRunId}.md.",
      },
    },
    binding,
  );
  assert.equal(installed.outcome, "applied", JSON.stringify(installed));
  return {
    parent,
    root,
    bare,
    repoId,
    get cell() {
      return cell;
    },
    allProviders,
    get activeProviders() {
      return activeProviders;
    },
    set activeProviders(value: Provider[] | null) {
      activeProviders = value;
    },
    taskProjection,
    onActivity,
    reopen: async () => {
      await cell.close();
      cell = await open();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all(
        allProviders.flatMap((provider) => (provider.process ? [stopFixtureProcess(provider.process)] : [])),
      );
      taskProjection.close();
      await cell.close();
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

export function createSuiteHost(slug: string): SuiteHost {
  let pending: Promise<OrchestrationHost> | null = null;
  suiteClosers.push(async () => {
    if (pending !== null) await (await pending).close();
  });
  return {
    get: () => {
      pending ??= createOrchestrationHost(slug);
      return pending;
    },
  };
}

export type OpenFixtureOptions = {
  readonly host?: SuiteHost;
  readonly runtimeCaller?: boolean;
  readonly wipLimit?: number;
  readonly prompt?: string;
  readonly startTaskSquad?: boolean;
};

export async function openFixture(
  t: { after(fn: () => Promise<void>): void },
  slug: string,
  options: OpenFixtureOptions = {},
) {
  const { runtimeCaller = false, wipLimit, prompt, startTaskSquad = true } = options,
    shared = options.host !== undefined,
    host = shared ? await options.host!.get() : await createOrchestrationHost(slug, wipLimit),
    providers: Provider[] = shared ? [] : host.allProviders,
    taskId = `task-squad-e2e-${slug}`;
  host.activeProviders = providers;

  let squadRunId = "",
    parentDispatchId: string | null = null;

  const status = async () =>
    evidence(await host.cell.run({ kind: "squad-status", squadRunId }, binding)) as unknown as Status;
  const task = (id: string) => host.taskProjection.withSession((query) => query.read(id));

  t.after(async () => {
    if (shared) {
      await Promise.all(
        providers.flatMap((provider) => (provider.process ? [stopFixtureProcess(provider.process)] : [])),
      );
      if (squadRunId !== "") {
        const current = await status();
        if (current.status === "running") {
          await host.cell.run({ kind: "squad-cancel", squadRunId }, binding);
        }
      }
      await host.cell.settlePendingMaterialization(`cleanup-${slug}`);
      if (host.activeProviders === providers) host.activeProviders = null;
      return;
    }
    await host.close();
  });

  if (startTaskSquad) {
    const created = await host.cell.run(
      { kind: "task-create", taskId, title: "Squad mission", presetId: "docs-task" },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(host.cell, created.opId, binding);
    await realizeTaskPlanFixture(host.root, String((created as Record<string, unknown>).packagePath), (planPath) =>
      host.cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    let squadBinding = binding;
    if (runtimeCaller) {
      const executing = await host.cell.run({ kind: "task-start", taskId }, binding);
      assert.equal(executing.outcome, "applied", JSON.stringify(executing));
      const caller = await host.cell.spawnRuntime(
        {
          runtimeInstanceId: "stub",
          agentId: "leader",
          taskId,
          cwd: { scope: "repo-root" },
          prompt: "Coordinate the mission through squad-run.",
          dispatchKey: "parent-caller",
        },
        binding,
      );
      parentDispatchId = String(caller.dispatchId);
      squadBinding = {
        ...binding,
        actor: {
          ...binding.actor,
          executor: { kind: "agent", id: `runtime-session:${String(caller.runtimeSessionId)}` },
        },
      };
      // The caller sends its delegation before exiting. Its authenticated request may retain the
      // canonical parent lease, but a second process must not receive that checkout until it stops.
      const parentProvider = providers.find((provider) => provider.dispatchId === parentDispatchId)!;
      await stopFixtureProcess(parentProvider.process!);
      await host.cell.runtimeIngress(
        {
          kind: "event",
          type: "runtime_session_exited",
          opId: "parent-caller-exited-before-squad",
          payload: { runtimeSessionId: String(caller.runtimeSessionId) },
        },
        binding,
      );
    }
    const started = await host.cell.run(
      {
        kind: "squad-run",
        squadId: "squad",
        taskId,
        runtimeInstanceId: "stub",
        cwd: { scope: "repo-root" },
        ...(prompt ? { prompt } : {}),
      },
      squadBinding,
    );
    assert.equal(started.outcome, "completed", JSON.stringify(started));
    squadRunId = String(evidence(started).squadRunId);
  }

  const finish = async (dispatchId: string, text: string, code = 0, offline = false) => {
    const provider = providers.find((row) => row.dispatchId === dispatchId)!;
    if (offline)
      appendRuntimeWorkerRecord(host.root, dispatchId, {
        kind: "process_started",
        occurredAt: new Date().toISOString(),
        pid: provider.process?.pid,
      });
    const events = [
      ...(offline ? [{ type: "thread.started", thread_id: provider.sessionId }] : []),
      {
        type: "item.completed",
        item: { id: "result", type: "agent_message", text },
      },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    if (offline) {
      for (const event of events)
        appendRuntimeWorkerRecord(host.root, dispatchId, {
          kind: "provider_event",
          occurredAt: new Date().toISOString(),
          event,
        });
    } else {
      // Preserve every frame in one output chunk, avoiding a repository queue task
      // for each line of this already complete fixture result.
      provider.output!(events.map((event) => JSON.stringify(event) + "\n").join(""));
    }
    await stopFixtureProcess(provider.process!);
    appendRuntimeWorkerRecord(host.root, dispatchId, {
      kind: "process_exit",
      occurredAt: new Date().toISOString(),
      exitCode: code,
      signal: null,
    });
    if (!offline) provider.exit!(code);
  };
  const until = <T>(read: () => T | null | Promise<T | null>, label: string): Promise<T> =>
    waitForArrival(async () => {
      await host.cell.settlePendingMaterialization(label);
      return read();
    }, host.onActivity);
  const waitStatus = (predicate: (state: Status) => unknown): Promise<Status> =>
    until(async () => {
      const current = await status();
      if (predicate(current)) return current;
      if (current.status === "failed") throw new Error(JSON.stringify(current));
      return null;
    }, "squad outcome waiter");

  return {
    parent: host.parent,
    root: host.root,
    bare: host.bare,
    repoId: host.repoId,
    taskId,
    squadRunId,
    get cell() {
      return host.cell;
    },
    providers,
    status,
    task,
    finish,
    waitStatus,
    until,
    parentDispatchId,
    reopen: () => host.reopen(),
    plan: async (first: string[], second: string[]) => {
      const state = await waitStatus((current) => current.leaderTurns.length >= 1);
      await finish(
        state.leaderTurns[0].dispatchId,
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [
            { to: "one", prompt: realizedTaskPlan("worker mission one"), ownedPaths: first },
            { to: "two", prompt: realizedTaskPlan("worker mission two"), ownedPaths: second },
          ],
        }),
      );
    },
    submit: async (child: WorkerAttemptView, head: string, inferCommit = false) => {
      await host.cell.settlePendingMaterialization("child closeout fixture");
      const row = task(child.taskId!),
        holder = {
          ...binding,
          actor: {
            principal: binding.actor.principal,
            executor: { kind: "agent" as const, id: `runtime-session:${child.runtimeSessionId}` },
          },
        };
      writeFileSync(
        path.join(host.root, "harness", row.packagePath!, "closeout.md"),
        `# Closeout\n\n## Summary\n\nDelivered ${head}.\n\n## Verification\n\nCommitted child file contents inspected.\n\n## Residual Risk\n\nIntegration review remains.\n\n## Same Mechanism Elsewhere\n\nSibling delivery uses the same protocol.\n`,
      );
      const receipt = await host.cell.run(
        {
          kind: "task-submit",
          taskId: child.taskId!,
          executionId: child.executionId!,
          ...(inferCommit ? {} : { commitSha: head }),
        },
        holder,
      );
      assert.equal(receipt.outcome, "applied", `real child submit: ${JSON.stringify(receipt)}`);
    },
  };
}

export type SquadFixture = Awaited<ReturnType<typeof openFixture>>;

export function assertChildrenClosed(fixture: SquadFixture, children: readonly WorkerAttemptView[]): void {
  for (const child of children) {
    const row = fixture.task(child.taskId!),
      task = row.snapshot.task!;
    assert.equal(task.status, "cancelled", `child ${child.taskId} must end with its run`);
    assert.equal(row.snapshot.lease, null);
    assert.equal(
      isExecutionWipTask({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        taskClass: task.taskClass,
        packageDisposition: task.packageDisposition ?? "active",
        hasCloseoutEvidence: false,
        hasOwnExecution: true,
        directChildCount: 0,
      }),
      false,
      "settled child must release WIP",
    );
  }
}
