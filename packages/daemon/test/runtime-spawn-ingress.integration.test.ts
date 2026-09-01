// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection } from "../../kernel/src/index.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import {
  definition,
  installation,
  initIngressRepo,
  rpc,
  rpcAttach,
  eventually,
  eventuallyValue,
  writeProviderStub,
  installationFixture,
  spawnCli,
} from "./fixtures/runtime-ingress.ts";

test("daemon ingress preserves executor-scoped task-bound runtime spawn", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-spawn-ingress-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    workerRoot = path.join(root, ".worktrees", "worker"),
    executablePath = writeProviderExecutable(path.join(parent, "codex-stub.mjs"), "process.exit(0);\n"),
    repoId = "runtime-spawn-ingress",
    uid = process.getuid?.() ?? 0;
  initIngressRepo(root, uid);
  registerDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  mkdirSync(path.join(workerRoot, "packages", "cli", "src"), {
    recursive: true,
  });
  writeFileSync(path.join(workerRoot, "packages", "cli", "src", "index.ts"), "export {};\n");
  const auth = {
    transportKind: "unix-socket",
    unixSocketOwnerBoundary: {
      ownerUid: uid,
      source: "unix-socket-filesystem-owner-boundary",
    },
  } as const;
  const ingressDefinition = {
      ...definition,
      authMode: "subscription" as const,
    },
    ingressInstallation = { ...installation, executablePath };
  let launchedEnv: NodeJS.ProcessEnv | null = null,
    launchedPrompt = "",
    launchCount = 0;
  const host = await openDaemonHost({
    daemonId: "runtime-spawn-ingress",
    userRoot,
    runtimeDiscover: () => [ingressInstallation],
    runtimeLaunch: (prepared) => {
      launchedEnv = prepared.env;
      launchedPrompt = prepared.prompt;
      launchCount += 1;
      return {
        pid: 4310,
        onOutput: (listener) => {
          queueMicrotask(() =>
            listener(`${JSON.stringify({ type: "thread.started", thread_id: "provider-task-session" })}\n`),
          );
        },
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      };
    },
  });
  await host.attachmentsSettled();
  const createReadyTask = async (taskId: string, title: string, appendix = ""): Promise<void> => {
    await createRealizedTaskPlanFixture(
      root,
      () => host.run(repoId, { kind: "task-create", taskId, title }, auth),
      (planPath) => host.run(repoId, { kind: "doc-submit", paths: [planPath] }, auth),
      title,
      appendix,
    );
  };
  let transportConnections = 0;
  const endpoint = localUserDaemonEndpoint(userRoot, "runtime-spawn-ingress"),
    transport = createUnixSocketTransportServer({
      daemonId: "runtime-spawn-ingress",
      socketPath: endpoint,
      createProtocolServer: (authContext, emit) => {
        transportConnections += 1;
        return createJsonRpcProtocolServer({
          host,
          build: { commit: null },
          authContext,
          emit,
        });
      },
    });
  await transport.start();
  try {
    host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: ingressDefinition.instanceId,
        name: "Codex Review",
        kindId: ingressDefinition.kindId,
        installationId: ingressDefinition.installationId,
        providerId: ingressDefinition.providerId,
        models: [ingressDefinition.model],
        codex: { reasoningEffort: ingressDefinition.reasoningEffort, fast: ingressDefinition.fast },
        authMode: ingressDefinition.authMode,
      },
      auth,
    );
    await t.test("server binds the dispatched RuntimeSession to the task execution", async () => {
      const taskId = "task-runtime-agent",
        executionId = "exec-runtime-agent";
      await createReadyTask(taskId, "Agent runtime");
      assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId }, auth)).outcome, "applied");
      const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: ingressDefinition.instanceId,
          cwd: { scope: "repo-relative", path: ".worktrees/worker" },
          prompt: "Inspect the task.\n\n```sh\nnode packages/cli/src/index.ts --version\n```",
          taskId,
          idempotencyKey: "agent-task-bound",
        },
      });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      assert.equal((receipt.authorizationDecision as { policyRef?: string } | null)?.policyRef, "default@5");
      assert.equal((receipt.authorizationDecision as { outcome?: string } | null)?.outcome, "allowed");
      assert.equal(launchedEnv?.HARNESS_ACTOR, `agent:runtime-session:${receipt.runtimeSessionId}`);
      assert.equal(launchedEnv?.HARNESS_DAEMON_USER_ROOT, userRoot);
      assert.equal(launchedEnv?.HARNESS_DAEMON_ID, "runtime-spawn-ingress");
      assert.equal(launchedEnv?.HARNESS_DAEMON_REPO_ID, repoId);
      assert.match(String(launchedEnv?.HARNESS_DAEMON_ENDPOINT), /harness-anything/u);
      assert.match(launchedPrompt, new RegExp(`Repository id: ${repoId}`, "u"));
      assert.ok(launchedPrompt.includes("Repository registration: enabled"));
      assert.ok(launchedPrompt.includes(`Canonical repository root: ${realpathSync(root)}`));
      assert.ok(launchedPrompt.includes(`Worker repository root: ${realpathSync(workerRoot)}`));
      assert.ok(
        launchedPrompt.includes(
          `Task package root: ${path.join(realpathSync(root), "harness", "tasks", "task-runtime-agent-agent-runtime")}`,
        ),
      );
      assert.match(launchedPrompt, new RegExp(`Runtime actor: agent:runtime-session:${receipt.runtimeSessionId}`, "u"));
      assert.ok(launchedPrompt.includes(`Daemon user root: ${userRoot}`));
      assert.ok(launchedPrompt.includes("Daemon id: runtime-spawn-ingress"));
      assert.ok(launchedPrompt.includes(`Daemon endpoint: ${launchedEnv?.HARNESS_DAEMON_ENDPOINT}`));
      const bound = await eventuallyValue(
        async () =>
          makeTaskEventStore({ repoId, rootDir: root })
            .read()
            .events.find(
              (event) =>
                event.type === "runtime_session_task_bound" &&
                event.payload.runtimeSessionId === receipt.runtimeSessionId,
            ) ?? null,
      );
      assert.equal(bound?.type, "runtime_session_task_bound");
      assert.deepEqual(bound?.actor.executor, {
        kind: "agent",
        id: `runtime-session:${receipt.runtimeSessionId}`,
      });
      assert.deepEqual(
        bound?.type === "runtime_session_task_bound" && {
          taskId: bound.payload.taskId,
          executionId: bound.payload.executionId,
        },
        { taskId, executionId },
      );
      const claimed = makeTaskProjection({
        rootDir: root,
        eventStore: makeTaskEventStore({ repoId, rootDir: root }),
      });
      try {
        assert.deepEqual(claimed.read(taskId).snapshot.lease?.actor.executor, {
          kind: "agent",
          id: `runtime-session:${receipt.runtimeSessionId}`,
        });
        assert.deepEqual(claimed.read(taskId).snapshot.executions[0]?.actor.executor, {
          kind: "agent",
          id: `runtime-session:${receipt.runtimeSessionId}`,
        });
      } finally {
        claimed.close();
      }
      const overview = await host.read(repoId, "repo.agentRuntime.overview", {}, auth),
        session = overview.sessions.find((candidate) => candidate.runtimeSessionId === receipt.runtimeSessionId);
      assert.equal(
        session?.associations.some(
          (association) => association.taskId === taskId && association.executionId === executionId,
        ),
        true,
      );
    });
    await t.test("the first dispatch holds the task lease and a concurrent second dispatch is rejected", async () => {
      const taskId = "task-runtime-dispatcher-handoff",
        executionId = "exec-runtime-dispatcher-handoff";
      await createReadyTask(taskId, "Dispatcher handoff");
      assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId }, auth)).outcome, "applied");
      const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: ingressDefinition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Dispatcher hands off to the runtime session.",
          taskId,
          idempotencyKey: "dispatcher-handoff",
        },
      });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      assert.equal((receipt.authorizationDecision as { policyRef?: string } | null)?.policyRef, "default@5");
      assert.equal((receipt.authorizationDecision as { outcome?: string } | null)?.outcome, "allowed");
      const bound = await eventuallyValue(
        async () =>
          makeTaskEventStore({ repoId, rootDir: root })
            .read()
            .events.find(
              (event) =>
                event.type === "runtime_session_task_bound" &&
                event.payload.runtimeSessionId === receipt.runtimeSessionId,
            ) ?? null,
      );
      assert.equal(bound?.type, "runtime_session_task_bound");
      assert.deepEqual(bound?.actor.executor, {
        kind: "agent",
        id: `runtime-session:${receipt.runtimeSessionId}`,
      });
      const launchesAfterFirst = launchCount,
        concurrent = await rpc(host, auth, "repo.agentRuntime.spawn", {
          repo: { repoId },
          payload: {
            runtimeInstanceId: ingressDefinition.instanceId,
            cwd: { scope: "repo-root" },
            prompt: "A second dispatcher must not share the execution lease.",
            taskId,
            idempotencyKey: "dispatcher-handoff-concurrent",
          },
        });
      assert.equal(concurrent.outcome, "op_rejected", JSON.stringify(concurrent));
      assert.equal(concurrent.code, "runtime_task_lease_required", JSON.stringify(concurrent));
      assert.equal(launchCount, launchesAfterFirst, "the rejected dispatch must not launch a provider");
      const projection = makeTaskProjection({
        rootDir: root,
        eventStore: makeTaskEventStore({ repoId, rootDir: root }),
      });
      try {
        assert.equal(
          projection
            .read(taskId)
            .snapshot.decisionRelations.some(
              (relation) =>
                relation.sourceRef === `runtime-session/${receipt.runtimeSessionId}` &&
                relation.targetRef === `task/${taskId}` &&
                relation.relationType === "executes" &&
                relation.state === "active",
            ),
          true,
        );
      } finally {
        projection.close();
      }
    });
    await t.test("a worker that changes its user root is rejected before it can reach the parent daemon", async () => {
      const scratchUserRoot = path.join(parent, "isolated-user");
      registerDaemonRepo({
        canonicalRoot: root,
        repoId,
        userRoot: scratchUserRoot,
        createConvenienceLinks: false,
      });
      const before = transportConnections;
      const result = await spawnCli(["--root", workerRoot, "--json", "task", "list"], {
        ...launchedEnv,
        HARNESS_DAEMON_USER_ROOT: scratchUserRoot,
        HARNESS_DAEMON_ID: "isolated",
      });
      assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
      const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(receipt.code, "daemon_target_conflict", JSON.stringify(receipt));
      assert.equal(
        transportConnections,
        before,
        "a conflicting target must be rejected before opening the parent daemon socket",
      );
    });
    await t.test("task mission rejects an unmatched shell glob before provider launch", async () => {
      const taskId = "task-runtime-invalid-glob",
        executionId = "exec-runtime-invalid-glob";
      await createReadyTask(
        taskId,
        "Invalid glob",
        "```sh\nprintf 'inspect manifest' && rg runtime tools/test-tier-manifest.*.mjs\n```",
      );
      assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId }, auth)).outcome, "applied");
      const before = launchCount,
        receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
          repo: { repoId },
          payload: {
            runtimeInstanceId: ingressDefinition.instanceId,
            cwd: { scope: "repo-relative", path: ".worktrees/worker" },
            taskId,
            idempotencyKey: "invalid-glob",
          },
        });
      assert.equal(receipt.outcome, "op_rejected");
      assert.equal(receipt.code, "runtime_mission_invalid");
      assert.match(String(receipt.nextAction), /tools\/test-tier-manifest\.\*\.mjs/u);
      assert.equal(launchCount, before);
    });
    await t.test("task mission rejects a missing Node entry before provider launch", async () => {
      const taskId = "task-runtime-missing-entry",
        executionId = "exec-runtime-missing-entry";
      await createReadyTask(taskId, "Missing entry", "```bash\nnode tools/missing-entry.mjs\n```");
      assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId }, auth)).outcome, "applied");
      const before = launchCount,
        receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
          repo: { repoId },
          payload: {
            runtimeInstanceId: ingressDefinition.instanceId,
            cwd: { scope: "repo-relative", path: ".worktrees/worker" },
            taskId,
            idempotencyKey: "missing-entry",
          },
        });
      assert.equal(receipt.outcome, "op_rejected");
      assert.equal(receipt.code, "runtime_mission_invalid");
      assert.match(String(receipt.nextAction), /tools\/missing-entry\.mjs/u);
      assert.equal(launchCount, before);
    });
    await t.test("payload-reported executor remains rejected", async () => {
      const taskId = "task-runtime-mismatch",
        executionId = "exec-runtime-mismatch",
        caller = { kind: "agent", id: "codex-other" } as const;
      await createReadyTask(taskId, "Mismatched runtime");
      assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId }, auth)).outcome, "applied");
      const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: ingressDefinition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Wrong executor",
          taskId,
          idempotencyKey: "agent-task-mismatch",
          executor: caller,
        },
      });
      assert.equal(receipt.outcome, "op_rejected");
      assert.equal(receipt.code, "executor_binding_invalid");
      assert.match(String(receipt.nextAction), /runtime-session:<runtime-id>/u);
    });
    await t.test("task-bound runtime without a lease starts and dispatches in one command", async () => {
      const taskId = "task-runtime-no-lease";
      await createReadyTask(taskId, "Runtime no lease");
      const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: ingressDefinition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Acquire the lease and dispatch",
          taskId,
          idempotencyKey: "runtime-no-lease",
        },
      });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const events = makeTaskEventStore({ repoId, rootDir: root }).read().events,
        started = events.findIndex((event) => event.type === "execution_started" && event.taskId === taskId),
        dispatched = events.findIndex(
          (event) =>
            event.type === "runtime_dispatch_requested" && event.payload.runtimeSessionId === receipt.runtimeSessionId,
        );
      assert.ok(started >= 0 && started < dispatched, events.map((event) => event.type).join(" -> "));
      const start = events[started];
      assert.equal(start?.type, "execution_started");
      if (start?.type === "execution_started")
        assert.deepEqual(start.payload.lease.actor.executor, {
          kind: "agent",
          id: `runtime-session:${receipt.runtimeSessionId}`,
        });
    });
    await t.test("an in-review task dispatches a closeout continuation without reopening execution", async () => {
      const taskId = "task-runtime-review-continuation",
        executionId = "exec-runtime-review-continuation";
      await createReadyTask(taskId, "Runtime review continuation");
      assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId }, auth)).outcome, "applied");
      assert.equal(
        (
          await host.run(
            repoId,
            {
              kind: "task-submit",
              taskId,
              executionId,
              submission: {
                completionClaim: "Continue the closeout round.",
                deliverables: ["review continuation"],
                outputs: ["runtime dispatch"],
                verificationNotes: ["integration"],
                knownGaps: [],
                residualRisks: [],
                commitSha: "a".repeat(40),
              },
            },
            auth,
          )
        ).outcome,
        "applied",
      );
      const before = makeTaskEventStore({ repoId, rootDir: root })
        .read()
        .events.filter((event) => event.type === "execution_started" && event.taskId === taskId).length;
      const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: ingressDefinition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Continue review and closeout.",
          taskId,
          idempotencyKey: "runtime-review-continuation",
        },
      });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const events = makeTaskEventStore({ repoId, rootDir: root }).read().events;
      assert.equal(
        events.filter((event) => event.type === "execution_started" && event.taskId === taskId).length,
        before,
        "review continuation must not reopen or replace the submitted execution",
      );
      const bound = await eventuallyValue(
        async () =>
          makeTaskEventStore({ repoId, rootDir: root })
            .read()
            .events.find(
              (event) =>
                event.type === "runtime_session_task_bound" &&
                event.payload.runtimeSessionId === receipt.runtimeSessionId,
            ) ?? null,
      );
      assert.equal(bound?.type, "runtime_session_task_bound");
      if (bound?.type === "runtime_session_task_bound") assert.equal(bound.payload.executionId, executionId);
    });
    await t.test("a bare-person lease becomes the dispatched runtime's lease", async () => {
      const taskId = "task-runtime-human",
        executionId = "exec-runtime-human";
      await createReadyTask(taskId, "Human runtime");
      assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId }, auth)).outcome, "applied");
      const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: ingressDefinition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Inspect the human task",
          taskId,
          idempotencyKey: "human-task-bound",
        },
      });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      assert.equal(launchedEnv?.HARNESS_ACTOR, `agent:runtime-session:${receipt.runtimeSessionId}`);
      const bound = await eventuallyValue(
        async () =>
          makeTaskEventStore({ repoId, rootDir: root })
            .read()
            .events.find(
              (event) =>
                event.type === "runtime_session_task_bound" &&
                event.payload.runtimeSessionId === receipt.runtimeSessionId,
            ) ?? null,
      );
      assert.equal(bound?.type, "runtime_session_task_bound");
      assert.deepEqual(bound?.actor.executor, {
        kind: "agent",
        id: `runtime-session:${receipt.runtimeSessionId}`,
      });
      assert.deepEqual(
        bound?.type === "runtime_session_task_bound" && {
          taskId: bound.payload.taskId,
          executionId: bound.payload.executionId,
        },
        { taskId, executionId },
      );
      const projected = makeTaskProjection({
        rootDir: root,
        eventStore: makeTaskEventStore({ repoId, rootDir: root }),
      });
      try {
        assert.deepEqual(projected.read(taskId).snapshot.lease?.actor.executor, {
          kind: "agent",
          id: `runtime-session:${receipt.runtimeSessionId}`,
        });
      } finally {
        projected.close();
      }
    });
    await t.test(
      "the bound runtime appends attributed progress while an unrelated executor stays rejected",
      async () => {
        const taskId = "task-runtime-progress",
          executionId = "exec-runtime-progress";
        await createReadyTask(taskId, "Runtime progress");
        assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId }, auth)).outcome, "applied");
        const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
          repo: { repoId },
          payload: {
            runtimeInstanceId: ingressDefinition.instanceId,
            cwd: { scope: "repo-root" },
            prompt: "Record progress",
            taskId,
            idempotencyKey: "runtime-progress",
          },
        });
        await eventuallyValue(
          async () =>
            makeTaskEventStore({ repoId, rootDir: root })
              .read()
              .events.find(
                (event) =>
                  event.type === "runtime_session_task_bound" &&
                  event.payload.runtimeSessionId === receipt.runtimeSessionId,
              ) ?? null,
        );
        const worker = {
            kind: "agent",
            id: `runtime-session:${receipt.runtimeSessionId}`,
          } as const,
          evidence = [
            {
              type: "test",
              path: "reports/runtime-progress.txt",
              summary: "worker checkpoint",
            },
          ];
        assert.equal(
          (
            await host.run(
              repoId,
              {
                kind: "task-progress-append",
                taskId,
                text: "Worker checkpoint one.",
                evidence,
                executor: worker,
              },
              auth,
            )
          ).outcome,
          "applied",
        );
        assert.equal(
          (
            await host.run(
              repoId,
              {
                kind: "task-progress-append",
                taskId,
                text: "Worker checkpoint two.",
                evidence,
                executor: worker,
              },
              auth,
            )
          ).outcome,
          "applied",
        );
        const rejected = await host.run(
          repoId,
          {
            kind: "task-progress-append",
            taskId,
            text: "Unrelated writer.",
            evidence,
            executor: { kind: "agent", id: "unrelated-worker" },
          },
          auth,
        );
        assert.equal(rejected.outcome, "op_rejected");
        assert.equal(rejected.code, "executor_binding_invalid");
        const progress = makeTaskEventStore({ repoId, rootDir: root })
          .read()
          .events.filter((event) => event.schema === "task-progress-event/v1" && event.payload.taskId === taskId);
        assert.deepEqual(
          progress.map((event) => event.payload.text),
          ["Worker checkpoint one.", "Worker checkpoint two."],
        );
        assert.deepEqual(
          progress.map((event) => event.actor.executor),
          [worker, worker],
        );
        assert.deepEqual(
          progress.map((event) => event.payload.runtimeSessionId),
          [receipt.runtimeSessionId, receipt.runtimeSessionId],
        );
        assert.match(
          readFileSync(path.join(root, "harness/tasks/task-runtime-progress-runtime-progress/progress.md"), "utf8"),
          /Worker checkpoint one\.[\s\S]*Worker checkpoint two\./u,
        );
        const replayStore = makeTaskEventStore({ repoId, rootDir: root }),
          replay = makeTaskProjection({
            rootDir: root,
            eventStore: replayStore,
            projectionPath: path.join(parent, "runtime-progress-replay.sqlite"),
          });
        try {
          replay.rebuild();
          assert.deepEqual(
            replay.readProgress(taskId).rows.map((event) => ({
              text: event.payload.text,
              actor: event.actor.executor,
              runtimeSessionId: event.payload.runtimeSessionId,
            })),
            [
              {
                text: "Worker checkpoint one.",
                actor: worker,
                runtimeSessionId: receipt.runtimeSessionId,
              },
              {
                text: "Worker checkpoint two.",
                actor: worker,
                runtimeSessionId: receipt.runtimeSessionId,
              },
            ],
          );
        } finally {
          replay.close();
        }
      },
    );
    await t.test(
      "the task-bound runtime keeps writes scoped and submits only its own execution after projection reopen",
      async () => {
        const taskId = "task-runtime-artifact",
          executionId = "exec-runtime-artifact",
          otherTaskId = "task-runtime-artifact-other",
          otherExecutionId = "exec-runtime-artifact-other";
        await createReadyTask(taskId, "Runtime artifact");
        assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId }, auth)).outcome, "applied");
        await createReadyTask(otherTaskId, "Runtime artifact other");
        assert.equal(
          (
            await host.run(
              repoId,
              {
                kind: "task-start",
                taskId: otherTaskId,
                executionId: otherExecutionId,
              },
              auth,
            )
          ).outcome,
          "applied",
        );
        const spawned = await rpc(host, auth, "repo.agentRuntime.spawn", {
          repo: { repoId },
          payload: {
            runtimeInstanceId: ingressDefinition.instanceId,
            cwd: { scope: "repo-root" },
            prompt: "Publish the report",
            taskId,
            idempotencyKey: "runtime-artifact",
          },
        });
        await eventuallyValue(
          async () =>
            makeTaskEventStore({ repoId, rootDir: root })
              .read()
              .events.find(
                (event) =>
                  event.type === "runtime_session_task_bound" &&
                  event.payload.runtimeSessionId === spawned.runtimeSessionId,
              ) ?? null,
        );
        const worker = {
            kind: "agent",
            id: `runtime-session:${spawned.runtimeSessionId}`,
          } as const,
          source = "runtime-artifact.md",
          ownDestination = "reports/runtime-artifact.md";
        writeFileSync(path.join(root, source), "# Runtime artifact\n");
        const published = await host.run(
          repoId,
          {
            kind: "task-artifact-add",
            taskId,
            source,
            destination: ownDestination,
            executor: worker,
          },
          auth,
        );
        assert.equal(published.outcome, "applied", JSON.stringify(published));
        assert.equal(published.destination, `tasks/task-runtime-artifact-runtime-artifact/artifacts/${ownDestination}`);
        const rebuilt = await host.run(repoId, { kind: "projection-rebuild" }, auth);
        assert.equal(rebuilt.outcome, "applied", JSON.stringify(rebuilt));
        const reopened = await host.read(repoId, "repo.agentRuntime.overview", {}, auth),
          reopenedSession = reopened.sessions.find(
            (candidate) => candidate.runtimeSessionId === spawned.runtimeSessionId,
          );
        assert.equal(reopenedSession?.liveness, "unknown");
        const syncedPath = "tasks/task-runtime-artifact-runtime-artifact/artifacts/reports/runtime-doc-sync.md",
          syncedTarget = path.join(root, "harness", syncedPath);
        mkdirSync(path.dirname(syncedTarget), { recursive: true });
        writeFileSync(syncedTarget, "# Runtime doc sync artifact\n");
        const synced = await host.run(repoId, { kind: "doc-submit", paths: [syncedPath], executor: worker }, auth);
        assert.equal(synced.outcome, "applied", JSON.stringify(synced));
        assert.match(String(synced.summary), new RegExp(`applied:[\\s\\S]*${syncedPath}`, "u"));

        const crossTask = await host.run(
          repoId,
          {
            kind: "task-artifact-add",
            taskId: otherTaskId,
            source,
            destination: "reports/cross-task.md",
            executor: worker,
          },
          auth,
        );
        assert.deepEqual(
          {
            outcome: crossTask.outcome,
            code: crossTask.code,
            origin: crossTask.origin,
          },
          {
            outcome: "op_rejected",
            code: "executor_binding_invalid",
            origin: "daemon",
          },
        );
        const otherPath =
            "tasks/task-runtime-artifact-other-runtime-artifact-other/artifacts/reports/cross-task-doc-sync.md",
          otherTarget = path.join(root, "harness", otherPath);
        mkdirSync(path.dirname(otherTarget), { recursive: true });
        writeFileSync(otherTarget, "# Cross-task report\n");
        const crossTaskDoc = await host.run(repoId, { kind: "doc-submit", paths: [otherPath], executor: worker }, auth);
        assert.equal(crossTaskDoc.outcome, "op_rejected");
        assert.equal(crossTaskDoc.code, "lease_conflict");
        assert.match(
          crossTaskDoc.nextAction ?? "",
          /no live execution lease covers tasks\/task-runtime-artifact-other-runtime-artifact-other\/artifacts\/reports\/cross-task-doc-sync\.md for this runtime session; submit through the lease-brokered task command for a bound execution, or have the dispatcher re-dispatch \(a non-runtime principal may rerun ha doc sync --submit through the repository prose channel\)/u,
        );
        const closeoutPath = "tasks/task-runtime-artifact-runtime-artifact/closeout.md",
          closeoutTarget = path.join(root, "harness", closeoutPath),
          closeoutBody = readFileSync(closeoutTarget, "utf8");
        writeFileSync(closeoutTarget, `${closeoutBody}\nRuntime worker closeout.\n`);
        const taskProse = await host.run(repoId, { kind: "doc-submit", paths: [closeoutPath], executor: worker }, auth);
        assert.equal(taskProse.outcome, "applied", JSON.stringify(taskProse));
        const submission = {
          completionClaim: "Runtime worker submits its own dispatched execution.",
          deliverables: ["artifact"],
          outputs: [String(published.destination)],
          verificationNotes: ["integration"],
          knownGaps: [],
          residualRisks: [],
          commitSha: "a".repeat(40),
        };
        const nonHolder = await host.run(
          repoId,
          {
            kind: "task-submit",
            taskId,
            executionId,
            submission,
            executor: { kind: "agent", id: "runtime-session:unrelated-runtime" },
          },
          auth,
        );
        assert.deepEqual(
          { outcome: nonHolder.outcome, code: nonHolder.code },
          { outcome: "op_rejected", code: "executor_binding_invalid" },
          JSON.stringify(nonHolder),
        );
        assert.equal(
          (await host.run(repoId, { kind: "task-start", taskId, executionId, executor: worker }, auth)).outcome,
          "applied",
          "the dispatched worker reuses its own active lease",
        );
        const lifecycle = await host.run(
          repoId,
          { kind: "task-submit", taskId, executionId, submission, executor: worker },
          auth,
        );
        assert.equal(lifecycle.outcome, "applied", JSON.stringify(lifecycle));
        const submitted = makeTaskProjection({
          rootDir: root,
          eventStore: makeTaskEventStore({ repoId, rootDir: root }),
        });
        try {
          assert.deepEqual(submitted.read(taskId).snapshot.executions[0]?.actor.executor, worker);
        } finally {
          submitted.close();
        }
        const declaration = await host.run(
          repoId,
          {
            kind: "task-declare-executor",
            taskId,
            executionId,
            agent: worker.id,
            reason: "A dispatched execution should already have an executor.",
          },
          auth,
        );
        assert.equal(declaration.outcome, "op_rejected", JSON.stringify(declaration));
        assert.equal(declaration.code, "invalid_proof", JSON.stringify(declaration));
      },
    );
  } finally {
    await transport.stop();
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("daemon ingress persists scrubbed provider JSONL while returning canonical results for both runtime kinds", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-provider-events-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "runtime-provider-events",
    uid = 4302;
  initIngressRepo(root, uid);
  registerDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  const installations = (["claude", "codex"] as const).map((kindId) => {
    const executablePath = writeProviderStub(
      path.join(parent, `${kindId}-stub.mjs`),
      kindId,
      undefined,
      kindId === "claude" ? 1_000 : 40,
    );
    return {
      installationId: `installation-${kindId}`,
      kindId,
      executablePath,
      version: "1.0.0",
      observedAt: "2026-08-19T00:00:00.000Z",
    } as const;
  });
  const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const,
    host = await openDaemonHost({
      daemonId: "runtime-provider-events",
      userRoot,
      runtimeDiscover: () => installations,
    });
  await host.attachmentsSettled();
  try {
    for (const kindId of ["claude", "codex"] as const)
      host.runtimeInstance(
        "daemon.runtimeInstance.create",
        {
          instanceId: `${kindId}-provider`,
          name: `${kindId} provider`,
          kindId,
          installationId: `installation-${kindId}`,
          providerId: kindId === "claude" ? "anthropic" : "openai",
          models: [`${kindId}-model`],
          authMode: "subscription",
        },
        auth,
      );
    host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: "codex-read-only",
        name: "codex read only",
        kindId: "codex",
        installationId: "installation-codex",
        providerId: "openai",
        models: ["codex-model"],
        permissionMode: "read-only",
        authMode: "subscription",
      },
      auth,
    );
    for (const kindId of ["claude", "codex"] as const)
      await t.test(kindId, async () => {
        const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
          repo: { repoId },
          payload: {
            runtimeInstanceId: `${kindId}-provider`,
            cwd: { scope: "repo-root" },
            prompt: `Run ${kindId}`,
            taskId: null,
            idempotencyKey: `${kindId}-provider-events`,
          },
        });
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        // Keep Claude active while its first message is already buffered so it covers the attach
        // response's replay path; Codex continues to cover live notifications after attachment.
        if (kindId === "claude") await new Promise((resolve) => setTimeout(resolve, 2_000));
        const frames: Record<string, unknown>[] = [],
          attached = await rpcAttach(host, auth, repoId, String(receipt.runtimeSessionId), frames);
        try {
          await eventually(async () =>
            frames.some(
              (frame) =>
                frame.type === "activity" && frame.activity === "message" && frame.content === `${kindId} live content`,
            ),
          );
          const read = await eventuallyValue(async () => {
            const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
              repo: { repoId },
              payload: { runtimeSessionId: receipt.runtimeSessionId },
            });
            return value.result ? value : null;
          });
          assert.equal((read.session as Record<string, unknown>).providerSessionId, `${kindId}-provider-session`);
          assert.deepEqual((read.session as { activity: unknown }).activity, {
            lastObservedAt: (read.session as { activity: { lastObservedAt: string } }).activity.lastObservedAt,
            outcome: "succeeded",
            exitCode: 0,
            resultRef: (read.result as Record<string, unknown>).ref,
            missingEvidence: null,
          });
          assert.deepEqual(read.result, {
            ref: (read.result as Record<string, unknown>).ref,
            text: `${kindId} final result`,
          });
          assert.match(
            String((read.result as Record<string, unknown>).ref),
            /^artifact:runtime-result\/sha256\/[0-9a-f]{64}$/u,
          );
          const streamPath = path.join(root, ".harness", "runtime", "dispatches", `${receipt.dispatchId}.jsonl`),
            stream = await eventuallyValue(() => {
              try {
                return readFileSync(streamPath, "utf8");
              } catch {
                return null;
              }
            });
          assert.match(stream, /"kind":"provider_event"/u);
          if (kindId === "codex") {
            assert.doesNotMatch(
              stream,
              /credentialRef|executablePath|apiToken|sk-provider-secret|\/provider\/private/u,
            );
          }
          const outcome = makeTaskEventStore({ repoId, rootDir: root })
            .read()
            .events.find(
              (event) =>
                event.type === "runtime_session_outcome_observed" &&
                event.payload.runtimeSessionId === receipt.runtimeSessionId,
            );
          assert.equal(outcome?.type, "runtime_session_outcome_observed");
          if (outcome?.type === "runtime_session_outcome_observed")
            assert.equal(
              Buffer.from(
                makeTaskEventStore({ repoId, rootDir: root }).readContentBlob(outcome.payload.result.sha256)!,
              ).toString("utf8"),
              `${kindId} final result`,
            );
        } finally {
          attached.close();
        }
      });
    const readOnly = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: "codex-read-only",
          cwd: { scope: "repo-root" },
          prompt: "read-only",
          taskId: null,
          idempotencyKey: "codex-read-only",
        },
      }),
      readOnlyRead = await eventuallyValue(async () => {
        const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
          repo: { repoId },
          payload: { runtimeSessionId: readOnly.runtimeSessionId },
        });
        return (value.session as { activity: { outcome: unknown } }).activity.outcome ? value : null;
      });
    assert.deepEqual(
      (
        readOnlyRead.session as {
          activity: { outcome: unknown; exitCode: unknown };
        }
      ).activity && {
        outcome: (readOnlyRead.session as { activity: { outcome: unknown } }).activity.outcome,
        exitCode: (readOnlyRead.session as { activity: { exitCode: unknown } }).activity.exitCode,
      },
      { outcome: "succeeded", exitCode: 0 },
    );
    const noAction = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: "codex-provider",
          cwd: { scope: "repo-root" },
          prompt: "no-action",
          taskId: null,
          idempotencyKey: "codex-no-action",
        },
      }),
      noActionRead = await eventuallyValue(async () => {
        const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
          repo: { repoId },
          payload: { runtimeSessionId: noAction.runtimeSessionId },
        });
        return (value.session as { activity: { outcome: unknown } }).activity.outcome ? value : null;
      });
    assert.deepEqual(
      (
        noActionRead.session as {
          activity: { outcome: unknown; exitCode: unknown };
        }
      ).activity && {
        outcome: (noActionRead.session as { activity: { outcome: unknown } }).activity.outcome,
        exitCode: (noActionRead.session as { activity: { exitCode: unknown } }).activity.exitCode,
      },
      { outcome: "succeeded", exitCode: 0 },
    );
    const noWrite = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: "codex-provider",
          cwd: { scope: "repo-root" },
          prompt: "no-write",
          taskId: null,
          idempotencyKey: "codex-no-write",
        },
      }),
      noWriteRead = await eventuallyValue(async () => {
        const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
          repo: { repoId },
          payload: { runtimeSessionId: noWrite.runtimeSessionId },
        });
        return (value.session as { activity: { outcome: unknown } }).activity.outcome ? value : null;
      });
    assert.deepEqual(
      (
        noWriteRead.session as {
          activity: { outcome: unknown; exitCode: unknown };
        }
      ).activity && {
        outcome: (noWriteRead.session as { activity: { outcome: unknown } }).activity.outcome,
        exitCode: (noWriteRead.session as { activity: { exitCode: unknown } }).activity.exitCode,
      },
      { outcome: "succeeded", exitCode: 0 },
    );
    const denied = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: "claude-provider",
          cwd: { scope: "repo-root" },
          prompt: "permission-denied",
          taskId: null,
          idempotencyKey: "claude-permission-denied",
        },
      }),
      deniedRead = await eventuallyValue(async () => {
        const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
          repo: { repoId },
          payload: { runtimeSessionId: denied.runtimeSessionId },
        });
        return (value.session as { activity: { outcome: unknown } }).activity.outcome ? value : null;
      });
    assert.deepEqual(
      (
        deniedRead.session as {
          activity: { outcome: unknown; exitCode: unknown };
        }
      ).activity && {
        outcome: (deniedRead.session as { activity: { outcome: unknown } }).activity.outcome,
        exitCode: (deniedRead.session as { activity: { exitCode: unknown } }).activity.exitCode,
      },
      { outcome: "succeeded", exitCode: 0 },
    );
    const empty = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-provider",
        cwd: { scope: "repo-root" },
        prompt: "failure:empty",
        taskId: null,
        idempotencyKey: "codex-empty-failure",
      },
    });
    const emptyRead = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: empty.runtimeSessionId },
      });
      return (value.session as { activity: { outcome: unknown } }).activity.outcome ? value : null;
    });
    assert.deepEqual(
      (
        emptyRead.session as {
          activity: { outcome: unknown; exitCode: unknown };
        }
      ).activity && {
        outcome: (emptyRead.session as { activity: { outcome: unknown } }).activity.outcome,
        exitCode: (emptyRead.session as { activity: { exitCode: unknown } }).activity.exitCode,
      },
      { outcome: "failed", exitCode: 1 },
    );
    assert.equal(
      (emptyRead.result as Record<string, unknown>).text,
      "Provider exited with code 1 and produced no output.",
    );
    const secret = "sk-runtime-secret-1234567890",
      stderrFailure = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: "codex-provider",
          cwd: { scope: "repo-root" },
          prompt: "failure:secret",
          taskId: null,
          idempotencyKey: "codex-stderr-failure",
        },
      });
    const stderrRead = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: stderrFailure.runtimeSessionId },
      });
      return (value.session as { activity: { outcome: unknown } }).activity.outcome ? value : null;
    });
    assert.match(
      String((stderrRead.result as Record<string, unknown>).text),
      /Provider exited with code 1.*OPENAI_API_KEY=\[REDACTED\]/u,
    );
    assert.doesNotMatch(JSON.stringify(stderrRead), new RegExp(secret, "u"));
    assert.doesNotMatch(
      readFileSync(path.join(root, ".harness", "runtime", "dispatches", `${stderrFailure.dispatchId}.jsonl`), "utf8"),
      new RegExp(secret, "u"),
    );
    const structured = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-provider",
        cwd: { scope: "repo-root" },
        prompt: "failure:structured",
        taskId: null,
        idempotencyKey: "codex-structured-failure",
      },
    });
    const structuredRead = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: structured.runtimeSessionId },
      });
      return (value.session as { activity: { outcome: unknown } }).activity.outcome ? value : null;
    });
    assert.match(String((structuredRead.result as Record<string, unknown>).text), /structured provider failure/u);
    assert.doesNotMatch(JSON.stringify(structuredRead), new RegExp(secret, "u"));
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("daemon ingress resumes the same provider session for Claude and Codex", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-resume-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "runtime-resume",
    uid = 4303;
  initIngressRepo(root, uid);
  registerDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  const launches: {
      readonly kindId: string;
      readonly args: readonly string[];
    }[] = [],
    installations = (["claude", "codex"] as const).map((kindId) => {
      const executablePath = writeProviderStub(path.join(parent, `${kindId}-resume-stub.mjs`), kindId);
      return {
        installationId: `installation-${kindId}`,
        kindId,
        executablePath,
        version: "1.0.0",
        observedAt: "2026-08-19T00:00:00.000Z",
      } as const;
    });
  const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const,
    host = await openDaemonHost({
      daemonId: "runtime-resume",
      userRoot,
      runtimeDiscover: () => installations,
      runtimeLaunch: (prepared) => {
        const kindId = prepared.definition.kindId,
          resumed = prepared.args.includes("--resume") || prepared.args.includes("resume"),
          providerSessionId = kindId === "claude" ? "claude-resume-session" : "codex-resume-session";
        launches.push({ kindId, args: prepared.args });
        const output =
          kindId === "claude"
            ? [
                {
                  type: "system",
                  subtype: "init",
                  session_id: providerSessionId,
                },
                {
                  type: "assistant",
                  session_id: providerSessionId,
                  message: {
                    content: [
                      {
                        type: "text",
                        text: resumed ? "claude second turn" : "claude first turn",
                      },
                    ],
                  },
                },
                {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  session_id: providerSessionId,
                  result: resumed ? "claude second result" : "claude first result",
                },
              ]
            : [
                { type: "thread.started", thread_id: providerSessionId },
                {
                  type: "item.completed",
                  item: {
                    id: "resume-item",
                    type: "agent_message",
                    text: resumed ? "codex second turn" : "codex first turn",
                  },
                },
                {
                  type: "turn.completed",
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              ];
        return {
          pid: 4400 + launches.length,
          onOutput: (listener) => {
            queueMicrotask(() => output.forEach((frame) => listener(`${JSON.stringify(frame)}\n`)));
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            queueMicrotask(() => listener(0));
          },
          terminate: () => undefined,
        };
      },
    });
  try {
    for (const kindId of ["claude", "codex"] as const)
      await t.test(kindId, async () => {
        const definition = {
          instanceId: `${kindId}-resume`,
          name: `${kindId} resume`,
          kindId,
          installationId: `installation-${kindId}`,
          providerId: kindId === "claude" ? "anthropic" : "openai",
          models: [`${kindId}-model`],
          authMode: "subscription",
        };
        host.runtimeInstance("daemon.runtimeInstance.create", definition, auth);
        const first = await rpc(host, auth, "repo.agentRuntime.spawn", {
          repo: { repoId },
          payload: {
            runtimeInstanceId: definition.instanceId,
            cwd: { scope: "repo-root" },
            prompt: "First turn",
            taskId: null,
            idempotencyKey: `${kindId}-resume-first`,
          },
        });
        assert.equal(first.outcome, "applied", JSON.stringify(first));
        await eventually(async () =>
          makeTaskEventStore({ repoId, rootDir: root })
            .read()
            .events.some(
              (event) =>
                event.type === "runtime_session_outcome_observed" &&
                event.payload.runtimeSessionId === first.runtimeSessionId,
            ),
        );
        const providerSessionId = kindId === "claude" ? "claude-resume-session" : "codex-resume-session",
          second = await rpc(host, auth, "repo.agentRuntime.spawn", {
            repo: { repoId },
            payload: {
              runtimeInstanceId: definition.instanceId,
              cwd: { scope: "repo-root" },
              prompt: "Second turn",
              providerSessionId,
              taskId: null,
              idempotencyKey: `${kindId}-resume-second`,
            },
          });
        await eventually(async () =>
          makeTaskEventStore({ repoId, rootDir: root })
            .read()
            .events.some(
              (event) =>
                event.type === "runtime_session_outcome_observed" &&
                event.payload.runtimeSessionId === second.runtimeSessionId,
            ),
        );
        const read = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
          repo: { repoId },
          payload: { runtimeSessionId: second.runtimeSessionId },
        });
        assert.equal((read.session as Record<string, unknown>).providerSessionId, providerSessionId);
        assert.equal(
          (read.result as Record<string, unknown>).text,
          kindId === "claude" ? "claude second result" : "codex second turn",
        );
        const secondLaunch = launches.findLast((launch) => launch.kindId === kindId)!;
        if (kindId === "claude") assert.deepEqual(secondLaunch.args.slice(-2), ["--resume", providerSessionId]);
        else {
          assert.deepEqual(secondLaunch.args.slice(0, 2), ["exec", "resume"]);
          assert.equal(secondLaunch.args.at(-2), providerSessionId);
        }
      });
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("daemon ingress cancellation is explicit and idempotent for an active runtime", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-cancel-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    executablePath = path.join(parent, "cancel-stub.mjs"),
    repoId = "runtime-cancel",
    uid = 4304;
  initIngressRepo(root, uid);
  registerDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  const installation = installationFixture("codex", writeProviderStub(executablePath, "codex"));
  const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const,
    host = await openDaemonHost({
      daemonId: "runtime-cancel",
      userRoot,
      runtimeDiscover: () => [installation],
      runtimeLaunch: () => ({
        pid: 4501,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    });
  try {
    const definition = {
      instanceId: "codex-cancel",
      name: "codex cancel",
      kindId: "codex" as const,
      installationId: installation.installationId,
      providerId: "openai",
      models: ["codex-model"],
      authMode: "subscription" as const,
    };
    host.runtimeInstance("daemon.runtimeInstance.create", definition, auth);
    const spawned = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Keep running",
        taskId: null,
        idempotencyKey: "cancel-active",
      },
    });
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const frames: Record<string, unknown>[] = [],
      attached = await rpcAttach(host, auth, repoId, String(spawned.runtimeSessionId), frames);
    try {
      const cancelled = await rpc(host, auth, "repo.agentRuntime.cancel", {
        repo: { repoId },
        payload: { runtimeSessionId: spawned.runtimeSessionId },
      });
      assert.equal(cancelled.outcome, "applied");
      assert.equal(cancelled.command, "runtime-cancel");
      const read = await eventuallyValue(async () => {
        const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
          repo: { repoId },
          payload: { runtimeSessionId: spawned.runtimeSessionId },
        });
        return (value.session as Record<string, unknown>).liveness === "exited" ? value : null;
      });
      assert.equal(
        (read.session as Record<string, unknown>).activity &&
          ((read.session as Record<string, unknown>).activity as Record<string, unknown>).outcome,
        "cancelled",
      );
      await eventually(() => frames.some((frame) => frame.type === "exit" && frame.outcome === "cancelled"));
      const events = makeTaskEventStore({ repoId, rootDir: root })
        .read()
        .events.filter(
          (event) => "runtimeSessionId" in event.payload && event.payload.runtimeSessionId === spawned.runtimeSessionId,
        );
      assert.equal(
        events.some((event) => event.type === "runtime_session_cancelled"),
        true,
      );
      const repeat = await rpc(host, auth, "repo.agentRuntime.cancel", {
        repo: { repoId },
        payload: { runtimeSessionId: spawned.runtimeSessionId },
      });
      assert.equal(repeat.outcome, "applied");
      assert.equal(repeat.detail, "already-exited");
      const missing = await rpc(host, auth, "repo.agentRuntime.cancel", {
        repo: { repoId },
        payload: { runtimeSessionId: "runtime_missing" },
      });
      assert.equal(missing.outcome, "pending");
      assert.equal((missing.proof as Record<string, unknown>).canonicalVisible, false);
    } finally {
      attached.close();
    }
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("agy consumes only its closed stream-json event protocol", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-events-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "runtime-agy-events",
    uid = 4305;
  let installation = {
    installationId: "installation-agy",
    kindId: "agy" as const,
    executablePath: "/opt/witnessed/agy",
    version: "1.1.15",
    observedAt: "2026-08-19T00:00:00.000Z",
  };
  initIngressRepo(root, uid);
  registerDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  const agyStub = writeProviderExecutable(path.join(parent, "agy-stub"), "process.exit(0)\n");
  installation = { ...installation, executablePath: agyStub };
  let unknown = false;
  const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const,
    host = await openDaemonHost({
      daemonId: "runtime-agy-events",
      userRoot,
      runtimeDiscover: () => [installation],
      runtimeLaunch: (prepared) => {
        assert.deepEqual(prepared.args, [
          "-p",
          unknown ? "Unknown event" : "Structured result",
          "--output-format",
          "stream-json",
          "--model",
          "gemini-3.1-pro-low",
          "--dangerously-skip-permissions",
          "--effort",
          "low",
        ]);
        const output = unknown
          ? [{ event: "future_event", text: "must not become a result" }]
          : [
              { event: "init", conversation_id: "agy-conversation" },
              {
                event: "step_update",
                step_update: {
                  conversation_id: "agy-conversation",
                  step_index: 1,
                  state: "ACTIVE",
                  step_type: "agent_response",
                  text_delta: "live",
                },
              },
              {
                event: "result",
                result: {
                  conversation_id: "agy-conversation",
                  status: "SUCCESS",
                  response: "AGY-OK",
                },
              },
            ];
        return {
          pid: 4601,
          onOutput: (listener) => {
            queueMicrotask(() => output.forEach((frame) => listener(`${JSON.stringify(frame)}\n`)));
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            queueMicrotask(() => listener(0));
          },
          terminate: () => undefined,
        };
      },
    });
  try {
    host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: "agy-provider",
        name: "agy provider",
        kindId: "agy",
        installationId: installation.installationId,
        providerId: "google",
        models: ["gemini-3.1-pro-low"],
        agy: { effort: "low" },
        authMode: "subscription",
      },
      auth,
    );
    const succeeded = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "agy-provider",
        cwd: { scope: "repo-root" },
        prompt: "Structured result",
        effort: "low",
        taskId: null,
        idempotencyKey: "agy-structured",
      },
    });
    assert.equal(succeeded.outcome, "applied", JSON.stringify(succeeded));
    const read = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: succeeded.runtimeSessionId },
      });
      return value.result ? value : null;
    });
    assert.equal((read.session as Record<string, unknown>).providerSessionId, "agy-conversation");
    assert.equal((read.result as Record<string, unknown>).text, "AGY-OK");
    assert.equal((read.session as { activity: { outcome: string } }).activity.outcome, "succeeded");
    unknown = true;
    const rejected = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "agy-provider",
        cwd: { scope: "repo-root" },
        prompt: "Unknown event",
        effort: "low",
        taskId: null,
        idempotencyKey: "agy-unknown",
      },
    });
    assert.equal(rejected.outcome, "applied", JSON.stringify(rejected));
    const rejectedRead = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: rejected.runtimeSessionId },
      });
      return (value.session as { activity: { outcome: unknown } }).activity.outcome ? value : null;
    });
    assert.equal((rejectedRead.session as { activity: { outcome: string } }).activity.outcome, "succeeded");
    assert.equal((rejectedRead.result as Record<string, unknown>).text, "");
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
