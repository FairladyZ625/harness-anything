// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  let launchedEnv: NodeJS.ProcessEnv | null = null,
    launchedPrompt = "",
    launchedPersistence: { readonly callbackRelay?: { readonly endpoint: string; readonly path: string } } | null =
      null,
    launchCount = 0;
  const host = await openDaemonHost({
    daemonId: "runtime-spawn-ingress",
    userRoot,
    runtimeDiscover: () => [ingressInstallation, claudeInstallation],
    runtimeLaunch: (prepared, persistence) => {
      launchedEnv = prepared.env;
      launchedPrompt = prepared.prompt;
      launchedPersistence = persistence;
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
        permissionMode: "workspace-write",
        isolationState: "enforced",
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
      assert.match(String(launchedEnv?.HARNESS_DAEMON_ENDPOINT), /[\\/]\.harness[\\/]r-[a-f0-9]{24}\.sock$/u);
      assert.equal(launchedEnv?.HARNESS_DAEMON_RELAY, "1");
      assert.doesNotMatch(String(launchedEnv?.HARNESS_DAEMON_ENDPOINT), /harness-anything/u);
      assert.equal(launchedPersistence?.callbackRelay?.path, launchedEnv?.HARNESS_DAEMON_ENDPOINT);
      assert.equal(launchedPersistence?.callbackRelay?.endpoint, endpoint);
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
      assert.equal(launchedPrompt.includes(userRoot), false);
      assert.equal(launchedPrompt.includes("Daemon id: runtime-spawn-ingress"), false);
      assert.ok(launchedPrompt.includes(`Daemon endpoint: ${launchedEnv?.HARNESS_DAEMON_ENDPOINT}`));
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
        eventStore: makeTaskEventReader({ repoId, rootDir: root }),
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
      const session = await eventuallyValue(async () => {
        const overview = await host.read(repoId, "repo.agentRuntime.overview", {}, auth),
          projected = overview.sessions.find((candidate) => candidate.runtimeSessionId === receipt.runtimeSessionId);
        return projected?.associations.some(
          (association) => association.taskId === taskId && association.executionId === executionId,
        )
          ? projected
          : null;
      });
      assert.equal(
        session?.associations.some(
          (association) => association.taskId === taskId && association.executionId === executionId,
        ),
        true,
      );
    });
    await t.test("the real CLI carries --agent identity through the daemon into the provider mission", async () => {
      const installed = await host.run(
        repoId,
        {
          kind: "agent-install",
          declaration: {
            schema: "agent-declaration/v1",
            id: "sol-reviewer",
            name: "Sol Reviewer",
            instructions: "Include AGENT_CLI_INGRESS_WITNESS in the review.",
            runtime_type: "codex",
            role: "worker",
          },
        },
        auth,
      );
      assert.equal(installed.outcome, "applied", JSON.stringify(installed));
      const result = await spawnCli(
        [
          "--root",
          workerRoot,
          "--json",
          "runtime",
          "run",
          ingressDefinition.instanceId,
          "--agent",
          "sol-reviewer",
          "--role",
          "reviewer",
          "--prompt",
          "Review through the declared identity.",
          "--permission-mode",
          "read-only",
          "--detach",
        ],
        {
          ...launchedEnv,
          HARNESS_DAEMON_ENDPOINT: endpoint,
          HARNESS_DAEMON_RELAY: undefined,
        },
      );
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(receipt.outcome, "running", JSON.stringify(receipt));
      assert.equal(receipt.code, undefined, JSON.stringify(receipt));
      assert.deepEqual(
        { ledgerAccess: receipt.ledgerAccess, reportDelivery: receipt.reportDelivery },
        { ledgerAccess: "unavailable", reportDelivery: "stdout" },
      );
      assert.match(
        launchedPrompt,
        /^# Agent Identity: Sol Reviewer \(sol-reviewer\)[\s\S]*AGENT_CLI_INGRESS_WITNESS[\s\S]*# Mission\n\nReview through the declared identity\.[\s\S]*# Read-only Dispatch Contract[\s\S]*final stdout/u,
      );
    });
    await t.test("only enforced Codex workspace-write receives a callback relay", async () => {
      const directEndpoint = localUserDaemonEndpoint(userRoot, "runtime-spawn-ingress"),
        cases = [
          {
            id: "claude-direct-route",
            kindId: "claude" as const,
            installationId: claudeInstallation.installationId,
            permissionMode: "workspace-write" as const,
            isolationState: "enforced" as const,
            provider: "anthropic",
            extra: { claude: {} },
          },
          {
            id: "codex-operator-route",
            kindId: "codex" as const,
            installationId: ingressInstallation.installationId,
            permissionMode: "workspace-write" as const,
            isolationState: "operator-environment" as const,
            provider: "openai",
            extra: { codex: {} },
          },
          {
            id: "codex-read-only-route",
            kindId: "codex" as const,
            installationId: ingressInstallation.installationId,
            permissionMode: "read-only" as const,
            isolationState: "enforced" as const,
            provider: "openai",
            extra: { codex: {} },
          },
        ];
      for (const [index, runtime] of cases.entries()) {
        host.runtimeInstance(
          "daemon.runtimeInstance.create",
          {
            instanceId: runtime.id,
            name: runtime.id,
            kindId: runtime.kindId,
            installationId: runtime.installationId,
            providerId: runtime.provider,
            models: ["gpt-5.6-sol"],
            defaultModel: "gpt-5.6-sol",
            enabled: true,
            permissionMode: runtime.permissionMode,
            isolationState: runtime.isolationState,
            authMode: "subscription",
            ...runtime.extra,
          },
          auth,
        );
        const taskId = `task-runtime-direct-route-${String(index)}`;
        await createReadyTask(taskId, `Direct route ${runtime.id}`);
        assert.equal(
          (await host.run(repoId, { kind: "task-start", taskId, executionId: `exec-${taskId}` }, auth)).outcome,
          "applied",
        );
        const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
          repo: { repoId },
          payload: {
            runtimeInstanceId: runtime.id,
            cwd: { scope: "repo-root" },
            prompt: `Direct route ${runtime.id}`,
            taskId,
            idempotencyKey: runtime.id,
          },
        });
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        assert.equal(launchedEnv?.HARNESS_DAEMON_ENDPOINT, directEndpoint);
        assert.equal(launchedEnv?.HARNESS_DAEMON_RELAY, undefined);
        assert.equal(launchedPersistence?.callbackRelay, undefined);
        assert.ok(launchedPrompt.includes(`Daemon endpoint: ${directEndpoint}`));
      }
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
          makeTaskEventReader({ repoId, rootDir: root })
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
        eventStore: makeTaskEventReader({ repoId, rootDir: root }),
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
    await t.test("a worker cannot replace its relay with the private daemon endpoint", async () => {
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
        HARNESS_DAEMON_ENDPOINT: endpoint,
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
      const events = makeTaskEventReader({ repoId, rootDir: root }).read().events,
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
    await t.test("changes requested admits implementation and reviewer redispatch", async () => {
      const taskId = "task-runtime-redispatch",
        firstExecutionId = "exec-runtime-redispatch-r1";
      await createReadyTask(taskId, "Runtime changes-requested redispatch");
      assert.equal(
        (await host.run(repoId, { kind: "task-start", taskId, executionId: firstExecutionId }, auth)).outcome,
        "applied",
      );
      assert.equal(
        (
          await host.run(
            repoId,
            {
              kind: "task-submit",
              taskId,
              executionId: firstExecutionId,
              submission: {
                completionClaim: "First round is ready for review.",
                deliverables: ["redispatch fixture"],
                outputs: ["runtime receipt"],
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
          cwd: { scope: "repo-root" },
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
      const secondExecutionId = implementationBinding.payload.executionId,
        secondSubmission = await host.run(
          repoId,
          {
            kind: "task-submit",
            taskId,
            executionId: secondExecutionId,
            submission: {
              completionClaim: "Second round is ready for review.",
              deliverables: ["redispatch fixture"],
              outputs: ["runtime receipt"],
              verificationNotes: ["integration"],
              knownGaps: [],
              residualRisks: [],
              commitSha: "b".repeat(40),
            },
            executor: {
              kind: "agent",
              id: `runtime-session:${String(implementation.runtimeSessionId)}`,
            },
          },
          auth,
        );
      assert.equal(secondSubmission.outcome, "applied", JSON.stringify(secondSubmission));
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
        new RegExp(`ha runtime run <runtime-instance-id> --role reviewer --task ${taskId}`, "u"),
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
          makeTaskEventReader({ repoId, rootDir: root })
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
        eventStore: makeTaskEventReader({ repoId, rootDir: root }),
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
        assert.deepEqual(nonHolder.diagnostic, {
          kind: "validation",
          entity: `task ${taskId} execution ${executionId}`,
          field: "executor",
          actual: "agent:runtime-session:unrelated-runtime",
          expectation:
            `Expected agent:${worker.id} from the held execution lease; run from that executor, then retry ` +
            `ha task submit ${taskId} --execution-id ${executionId} --from-file <submission.json>`,
        });
        t.diagnostic(`executor_binding_invalid receipt=${JSON.stringify(nonHolder)}`);
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
