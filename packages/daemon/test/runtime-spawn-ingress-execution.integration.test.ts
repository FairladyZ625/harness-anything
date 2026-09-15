// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "../../kernel/src/index.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { createRealizedTaskPlanFixture, realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import {
  definition,
  installation,
  initIngressRepo,
  rpc,
  eventuallyValue,
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
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
  writeFileSync(path.join(root, "delivery.ts"), "export const delivered = true;\n");
  execFileSync("git", ["add", "delivery.ts"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "test: runtime delivery"], { cwd: root });
  const deliveryCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync("git", ["worktree", "add", "--detach", workerRoot, deliveryCommit], { cwd: root });
  const originalPath = process.env.PATH;
  writeProviderExecutable(
    path.join(parent, "gh"),
    'if (process.argv[2] !== "run" || process.argv[3] !== "list") process.exit(1); console.log("[]");\n',
  );
  process.env.PATH = `${parent}${path.delimiter}${originalPath ?? ""}`;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
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
    ingressInstallation = { ...installation, executablePath },
    claudeInstallation = {
      ...ingressInstallation,
      installationId: "installation-claude",
      kindId: "claude" as const,
    };
  let launchCount = 0;
  const host = await openDaemonHost({
    daemonId: "runtime-spawn-ingress",
    userRoot,
    runtimeDiscover: () => [ingressInstallation, claudeInstallation],
    runtimeLaunch: () => {
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
      async () => {
        const created = await host.run(repoId, { kind: "task-create", taskId, title }, auth);
        const publication = await host.run(
          repoId,
          { kind: "receipt-show", opId: created.opId, waitFor: ["git_verified", "worktree_visible"], timeoutMs: 5000 },
          auth,
        );
        assert.equal(publication.wait?.state, "satisfied", JSON.stringify(publication));
        return created;
      },
      (planPath) => host.run(repoId, { kind: "doc-submit", paths: [planPath] }, auth),
      title,
      appendix,
    );
  };
  const writeCloseout = (taskId: string, summary: string): void => {
    const projection = makeTaskProjection({
      rootDir: root,
      eventStore: makeTaskEventReader({ repoId, rootDir: root }),
    });
    try {
      writeFileSync(
        path.join(root, "harness", projection.read(taskId).packagePath!, "closeout.md"),
        `## Summary\n${summary} Commit ${deliveryCommit}.\n` +
          "## Verification\nRuntime dispatch and holder assertions exercised by this integration fixture.\n" +
          "## Residual Risk\nNo remaining runtime fixture gaps.\n" +
          "## Same Mechanism Elsewhere\nRuntime review and continuation paths are covered in this file.\n",
      );
    } finally {
      projection.close();
    }
  };
  const endpoint = localUserDaemonEndpoint(userRoot, "runtime-spawn-ingress"),
    transport = createUnixSocketTransportServer({
      daemonId: "runtime-spawn-ingress",
      socketPath: endpoint,
      createProtocolServer: (authContext, emit) => {
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
        permissionMode: "workspace-write",
        isolationState: "enforced",
        codex: { reasoningEffort: ingressDefinition.reasoningEffort, fast: ingressDefinition.fast },
        authMode: ingressDefinition.authMode,
      },
      auth,
    );
    await t.test("changes requested admits implementation and reviewer redispatch", async () => {
      const taskId = "task-runtime-redispatch",
        firstExecutionId = "exec-runtime-redispatch-r1";
      await createReadyTask(taskId, "Runtime changes-requested redispatch");
      assert.equal(
        (await host.run(repoId, { kind: "task-start", taskId, executionId: firstExecutionId }, auth)).outcome,
        "applied",
      );
      writeCloseout(taskId, "The runtime execution is ready for review.");
      assert.equal(
        (
          await host.run(
            repoId,
            {
              kind: "task-submit",
              taskId,
              executionId: firstExecutionId,
            },
            auth,
          )
        ).outcome,
        "applied",
      );
      writeFileSync(
        path.join(root, "redispatch-changes.json"),
        JSON.stringify({
          verdict: "changes_requested",
          reason: "Exercise a second implementation round.",
          evidenceChecked: ["first-round receipt"],
        }),
      );
      const firstReviewer = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: ingressDefinition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Review the first round.",
          role: "reviewer",
          taskId,
          idempotencyKey: "runtime-changes-requested-first-reviewer",
        },
      });
      assert.equal(firstReviewer.outcome, "applied", JSON.stringify(firstReviewer));
      await eventuallyValue(
        async () =>
          makeTaskEventReader({ repoId, rootDir: root })
            .read()
            .events.find(
              (event) =>
                event.type === "runtime_session_task_bound" &&
                event.payload.runtimeSessionId === firstReviewer.runtimeSessionId,
            ) ?? null,
      );
      assert.equal(
        (
          await host.run(
            repoId,
            {
              kind: "task-review-execution",
              taskId,
              executionId: firstExecutionId,
              reviewId: "redispatch-changes",
              fromFile: "redispatch-changes.json",
              executor: {
                kind: "agent",
                id: `runtime-session:${String(firstReviewer.runtimeSessionId)}`,
              },
            },
            auth,
          )
        ).outcome,
        "applied",
      );

      const implementation = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: ingressDefinition.instanceId,
          cwd: { scope: "repo-relative", path: ".worktrees/worker" },
          prompt: "Continue implementation.",
          taskId,
          idempotencyKey: "runtime-changes-requested-implementation",
        },
      });
      assert.equal(implementation.outcome, "applied", JSON.stringify(implementation));

      const implementationBinding = await eventuallyValue(
        async () =>
          makeTaskEventReader({ repoId, rootDir: root })
            .read()
            .events.find(
              (event) =>
                event.type === "runtime_session_task_bound" &&
                event.payload.runtimeSessionId === implementation.runtimeSessionId,
            ) ?? null,
      );
      assert.equal(implementationBinding?.type, "runtime_session_task_bound");
      if (implementationBinding?.type !== "runtime_session_task_bound") throw new Error("missing task binding");
      writeCloseout(taskId, "The second runtime execution is ready for review.");
      // Import an unrelated failed run: this exercises actor attribution without supplying a green witness.
      writeProviderExecutable(
        path.join(parent, "gh"),
        `
        import { mkdirSync, writeFileSync } from "node:fs";
        import path from "node:path";
        const command = process.argv[3], sha = "f".repeat(40);
        if (command === "list") console.log(JSON.stringify([{ databaseId: 901, headBranch: "main", createdAt: "2026-01-01T00:00:00Z" }]));
        else if (command === "view") console.log(JSON.stringify({
          workflowName: "rewrite-ci", headSha: sha, headBranch: "main", status: "completed",
          conclusion: "failure", attempt: 1, event: "push"
        }));
        else if (command === "download") {
          const dir = process.argv[process.argv.indexOf("--dir") + 1];
          mkdirSync(dir, { recursive: true });
          writeFileSync(path.join(dir, "observation.json"), JSON.stringify({
            schema: "ci-run-artifact/v1",
            run: { runId: "901.1", sha, branch: "main", prNumber: null, job: "test", wallclockMs: 1, runner: "fixture" },
            tests: [], gates: []
          }));
        } else process.exit(1);
      `,
      );
      const beforeSubmission = makeTaskEventReader({ repoId, rootDir: root }).read().revision,
        secondExecutionId = implementationBinding.payload.executionId,
        secondSubmission = await host.run(
          repoId,
          {
            kind: "task-submit",
            taskId,
            executionId: secondExecutionId,
            executor: {
              kind: "agent",
              id: `runtime-session:${String(implementation.runtimeSessionId)}`,
            },
          },
          auth,
        );
      assert.equal(secondSubmission.outcome, "applied", JSON.stringify(secondSubmission));
      const observations = makeTaskEventReader({ repoId, rootDir: root })
        .read()
        .events.filter((event) => event.type === "ci_run_observed" && event.workspaceRevision > beforeSubmission);
      assert.ok(observations.length > 0, "automatic pull must ingest an observation on the runtime submission");
      for (const observation of observations)
        assert.deepEqual(observation.actor.executor, implementationBinding.actor.executor);

      writeFileSync(
        path.join(root, "redispatch-review.json"),
        JSON.stringify({ verdict: "approved", reason: "Second round reviewed.", evidenceChecked: ["second round"] }),
      );
      const staleReviewer = await host.run(
        repoId,
        {
          kind: "task-review-execution",
          taskId,
          executionId: secondExecutionId,
          reviewId: "redispatch-stale-reviewer",
          fromFile: "redispatch-review.json",
          executor: {
            kind: "agent",
            id: `runtime-session:${String(firstReviewer.runtimeSessionId)}`,
          },
        },
        auth,
      );
      assert.equal(staleReviewer.outcome, "op_rejected", JSON.stringify(staleReviewer));
      assert.equal(staleReviewer.code, "executor_binding_invalid", JSON.stringify(staleReviewer));
      assert.match(
        String((staleReviewer.diagnostic as { expectation?: unknown } | undefined)?.expectation),
        new RegExp(`ha agent run <reviewer-agent-id> --role reviewer --task ${taskId}`, "u"),
      );

      const independentReview = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: ingressDefinition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Review the continuation.",
          role: "reviewer",
          taskId,
          idempotencyKey: "runtime-changes-requested-reviewer",
        },
      });
      assert.equal(independentReview.outcome, "applied", JSON.stringify(independentReview));
    });
    await t.test("an in-review task dispatches a closeout continuation without reopening execution", async () => {
      const taskId = "task-runtime-review-continuation",
        executionId = "exec-runtime-review-continuation";
      await createReadyTask(taskId, "Runtime review continuation");
      assert.equal((await host.run(repoId, { kind: "task-start", taskId, executionId }, auth)).outcome, "applied");
      writeCloseout(taskId, "The runtime execution is ready for review.");
      assert.equal(
        (
          await host.run(
            repoId,
            {
              kind: "task-submit",
              taskId,
              executionId,
            },
            auth,
          )
        ).outcome,
        "applied",
      );
      const before = makeTaskEventReader({ repoId, rootDir: root })
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
      const events = makeTaskEventReader({ repoId, rootDir: root }).read().events;
      assert.equal(
        events.filter((event) => event.type === "execution_started" && event.taskId === taskId).length,
        before,
        "review continuation must not reopen or replace the submitted execution",
      );
      const bound = await eventuallyValue(
        async () =>
          makeTaskEventReader({ repoId, rootDir: root })
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
            makeTaskEventReader({ repoId, rootDir: root })
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
        const progress = makeTaskEventReader({ repoId, rootDir: root })
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
        const progressPublished = await host.run(
          repoId,
          { kind: "receipt-show", opId: progress.at(-1)!.opId, waitFor: ["worktree_visible"], timeoutMs: 5000 },
          auth,
        );
        assert.equal(progressPublished.wait?.state, "satisfied", JSON.stringify(progressPublished));
        assert.match(
          readFileSync(path.join(root, "harness/tasks/task-runtime-progress-runtime-progress/progress.md"), "utf8"),
          /Worker checkpoint one\.[\s\S]*Worker checkpoint two\./u,
        );
        const replayStore = makeTaskEventReader({ repoId, rootDir: root }),
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
      "a task-bound runtime syncs and dispatches its descendant task but not an unrelated task",
      async () => {
        const parentTaskId = "task-runtime-commander-parent",
          parentExecutionId = "exec-runtime-commander-parent",
          unrelatedTaskId = "task-runtime-commander-unrelated";
        await createReadyTask(parentTaskId, "Runtime commander parent");
        assert.equal(
          (await host.run(repoId, { kind: "task-start", taskId: parentTaskId, executionId: parentExecutionId }, auth))
            .outcome,
          "applied",
        );
        const commander = await rpc(host, auth, "repo.agentRuntime.spawn", {
          repo: { repoId },
          payload: {
            runtimeInstanceId: ingressDefinition.instanceId,
            cwd: { scope: "repo-root" },
            prompt: "Plan and dispatch the child task.",
            taskId: parentTaskId,
            idempotencyKey: "runtime-commander-parent",
          },
        });
        assert.equal(commander.outcome, "applied", JSON.stringify(commander));
        await eventuallyValue(
          async () =>
            makeTaskEventReader({ repoId, rootDir: root })
              .read()
              .events.find(
                (event) =>
                  event.type === "runtime_session_task_bound" &&
                  event.payload.runtimeSessionId === commander.runtimeSessionId,
              ) ?? null,
        );
        const commanderExecutor = {
            kind: "agent",
            id: `runtime-session:${commander.runtimeSessionId}`,
          } as const,
          child = await host.run(
            repoId,
            {
              kind: "task-create",
              title: "Runtime commander child",
              parentTaskId,
              executor: commanderExecutor,
            },
            auth,
          );
        assert.equal(child.outcome, "applied", JSON.stringify(child));
        assert.equal(typeof child.taskId, "string", JSON.stringify(child));
        assert.equal(typeof child.packagePath, "string", JSON.stringify(child));
        const publication = await host.run(
          repoId,
          { kind: "receipt-show", opId: child.opId, waitFor: ["git_verified", "worktree_visible"], timeoutMs: 5000 },
          auth,
        );
        assert.equal(publication.wait?.state, "satisfied", JSON.stringify(publication));
        const childTaskId = String(child.taskId);
        await realizeTaskPlanFixture(
          root,
          String(child.packagePath),
          (_planPath) =>
            host.run(repoId, { kind: "doc-submit", taskId: childTaskId, executor: commanderExecutor }, auth),
          "Runtime commander child",
        );

        const childDispatch = await rpc(host, auth, "repo.agentRuntime.spawn", {
          repo: { repoId },
          payload: {
            runtimeInstanceId: ingressDefinition.instanceId,
            cwd: { scope: "repo-root" },
            taskId: childTaskId,
            idempotencyKey: "runtime-commander-child",
            executor: commanderExecutor,
          },
        });
        assert.equal(childDispatch.outcome, "applied", JSON.stringify(childDispatch));
        await eventuallyValue(
          async () =>
            makeTaskEventReader({ repoId, rootDir: root })
              .read()
              .events.find(
                (event) =>
                  event.type === "runtime_session_task_bound" &&
                  event.payload.runtimeSessionId === childDispatch.runtimeSessionId &&
                  event.payload.taskId === childTaskId,
              ) ?? null,
        );

        await createReadyTask(unrelatedTaskId, "Runtime commander unrelated");
        const unrelatedDoc = await host.run(
          repoId,
          { kind: "doc-submit", taskId: unrelatedTaskId, executor: commanderExecutor },
          auth,
        );
        assert.deepEqual(
          { outcome: unrelatedDoc.outcome, code: unrelatedDoc.code },
          { outcome: "op_rejected", code: "executor_binding_invalid" },
          JSON.stringify(unrelatedDoc),
        );
        const launchesBeforeUnrelated = launchCount,
          unrelatedDispatch = await rpc(host, auth, "repo.agentRuntime.spawn", {
            repo: { repoId },
            payload: {
              runtimeInstanceId: ingressDefinition.instanceId,
              cwd: { scope: "repo-root" },
              taskId: unrelatedTaskId,
              idempotencyKey: "runtime-commander-unrelated",
              executor: commanderExecutor,
            },
          });
        assert.deepEqual(
          { outcome: unrelatedDispatch.outcome, code: unrelatedDispatch.code },
          { outcome: "op_rejected", code: "executor_binding_invalid" },
          JSON.stringify(unrelatedDispatch),
        );
        assert.equal(launchCount, launchesBeforeUnrelated);
      },
    );
    await t.test(
      "the task-bound runtime keeps writes scoped and submits only its own execution after projection reopen",
      async (runtimeTest) => {
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
            cwd: { scope: "repo-relative", path: ".worktrees/worker" },
            prompt: "Publish the report",
            taskId,
            idempotencyKey: "runtime-artifact",
          },
        });
        await eventuallyValue(
          async () =>
            makeTaskEventReader({ repoId, rootDir: root })
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

        await runtimeTest.test(
          "doc retire removes a runtime-produced artifact through the repository writer",
          async () => {
            const reason = "runtime evidence superseded",
              action = { kind: "doc-retire", path: syncedPath, reason } as const,
              waitForPublication = (opId: string) =>
                host.run(
                  repoId,
                  {
                    kind: "receipt-show",
                    opId,
                    waitFor: ["git_verified", "worktree_visible"],
                    timeoutMs: 5000,
                  },
                  auth,
                );
            const submitted = await waitForPublication(synced.opId);
            assert.equal(submitted.wait?.state, "satisfied", JSON.stringify(submitted));
            assert.equal(readFileSync(syncedTarget, "utf8"), "# Runtime doc sync artifact\n");
            const denied = await host.run(repoId, { ...action, executor: worker }, auth);
            assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
            assert.equal(denied.code, "lease_conflict", JSON.stringify(denied));
            assert.equal(readFileSync(syncedTarget, "utf8"), "# Runtime doc sync artifact\n");
            const cliRetirement = await spawnCli(
              ["--root", workerRoot, "--json", "doc", "retire", "--path", syncedPath, "--reason", reason],
              {
                ...process.env,
                HARNESS_DAEMON_USER_ROOT: userRoot,
                HARNESS_DAEMON_ID: "runtime-spawn-ingress",
                HARNESS_DAEMON_ENDPOINT: endpoint,
                HARNESS_ACTOR: undefined,
                HARNESS_DAEMON_RELAY: undefined,
              },
            );
            assert.equal(cliRetirement.status, 0, JSON.stringify(cliRetirement));
            const retired = JSON.parse(cliRetirement.stdout) as { outcome: string; opId: string };
            assert.equal(retired.outcome, "applied", JSON.stringify(retired));
            const settled = await waitForPublication(retired.opId);
            assert.equal(settled.wait?.state, "satisfied", JSON.stringify(settled));
            const event = makeTaskEventReader({ repoId, rootDir: root }).readEvent(retired.opId);
            assert.equal(event?.schema, "doc-event/v1");
            if (event?.schema === "doc-event/v1") {
              assert.equal(event.payload.retirementReason, reason);
              assert.equal(event.payload.changes.length, 1);
              assert.equal(event.payload.changes[0]?.path, syncedPath);
              assert.equal(event.payload.changes[0]?.candidate, null);
            }
            assert.equal(
              (await host.run(repoId, { kind: "doc-show", path: syncedPath }, auth)).code,
              "document_not_found",
            );
            assert.equal(existsSync(syncedTarget), false, "the writer must remove the file without manual unlink");
            assert.equal(
              execFileSync("git", ["ls-tree", "--name-only", "HEAD", `harness/${syncedPath}`], {
                cwd: root,
                encoding: "utf8",
              }).trim(),
              "",
            );
          },
        );

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
        writeCloseout(taskId, "Runtime worker submits its own dispatched execution.");
        const closeoutPath = "tasks/task-runtime-artifact-runtime-artifact/closeout.md";
        const taskProse = await host.run(repoId, { kind: "doc-submit", paths: [closeoutPath], executor: worker }, auth);
        assert.equal(taskProse.outcome, "applied", JSON.stringify(taskProse));
        const nonHolder = await host.run(
          repoId,
          {
            kind: "task-submit",
            taskId,
            executionId,
            executor: { kind: "agent", id: "runtime-session:unrelated-runtime" },
          },
          auth,
        );
        assert.deepEqual(
          { outcome: nonHolder.outcome, code: nonHolder.code },
          { outcome: "op_rejected", code: "executor_binding_invalid" },
          JSON.stringify(nonHolder),
        );
        assert.deepEqual(nonHolder.diagnostic, {
          kind: "validation",
          entity: `task ${taskId} execution ${executionId}`,
          field: "executor",
          actual: "agent:runtime-session:unrelated-runtime",
          expectation:
            `Expected agent:${worker.id} from the held execution lease; run from that executor, then retry ` +
            `ha task submit ${taskId} --execution-id ${executionId}`,
        });
        t.diagnostic(`executor_binding_invalid receipt=${JSON.stringify(nonHolder)}`);
        const reused = await host.run(repoId, { kind: "task-start", taskId, executionId, executor: worker }, auth);
        assert.equal(reused.outcome, "no_changes", JSON.stringify(reused));
        assert.equal(reused.acceptance, null);
        assert.equal(reused.executionId, executionId, "the dispatched worker reuses its own active lease");
        const lifecycle = await host.run(repoId, { kind: "task-submit", taskId, executionId, executor: worker }, auth);
        assert.equal(lifecycle.outcome, "applied", JSON.stringify(lifecycle));
        const submitted = makeTaskProjection({
          rootDir: root,
          eventStore: makeTaskEventReader({ repoId, rootDir: root }),
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
        assert.deepEqual(declaration.diagnostic, {
          kind: "validation",
          entity: `execution ${executionId}`,
          field: "declareExecutor",
          actual: `status=submitted node=review executor=agent:${worker.id}`,
          expectation:
            "Use declare-executor only when status=submitted node=review executor=none; this assigned execution " +
            `must continue with ha task review-execution ${taskId} --execution-id ${executionId} ` +
            "--review-id <review-id> --from-file <review.json>",
        });
        t.diagnostic(`invalid_proof receipt=${JSON.stringify(declaration)}`);
      },
    );
  } finally {
    await transport.stop();
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
