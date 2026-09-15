// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "../../kernel/src/index.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { cellCodedError } from "../src/repo-cell-errors.ts";
import { projectedTaskIds } from "../src/repo-cell-receipts.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
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
    await t.test("doc status RPC reads use one projection session without nesting", async () => {
      const result = await rpc(host, auth, "repo.task.read", {
        repo: { repoId },
        payload: { action: { kind: "doc-status", paths: ["harness.yaml"] } },
      });
      assert.equal(result.outcome, "applied", JSON.stringify(result));
      assert.match(String(result.evidence), /^doc-scan:/u);
    });
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
      assert.ok(launchedPrompt.includes(`Canonical Task ID: ${taskId}`));
      assert.match(launchedPrompt, new RegExp(`Runtime actor: agent:runtime-session:${receipt.runtimeSessionId}`, "u"));
      assert.equal(launchedPrompt.includes(userRoot), false);
      assert.equal(launchedPrompt.includes("Daemon id: runtime-spawn-ingress"), false);
      assert.ok(launchedPrompt.includes(`Daemon endpoint: ${launchedEnv?.HARNESS_DAEMON_ENDPOINT}`));
      const started = makeTaskEventReader({ repoId, rootDir: root })
        .read()
        .events.find(
          (event) =>
            event.type === "runtime_session_started" && event.payload.runtimeSessionId === receipt.runtimeSessionId,
        );
      assert.deepEqual(started?.type === "runtime_session_started" && started.payload.taskBinding, {
        taskId,
        executionId,
      });
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
      const taskId = "task-runtime-cli-agent";
      await createReadyTask(taskId, "CLI agent runtime");
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
            instance: ingressDefinition.instanceId,
            permissionMode: "read-only",
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
          "agent",
          "run",
          "sol-reviewer",
          "--task",
          taskId,
          "--instance",
          ingressDefinition.instanceId,
          "--prompt",
          "Review through the declared identity.",
        ],
        {
          ...launchedEnv,
          HARNESS_ACTOR: undefined,
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
        /^# Agent Identity: Sol Reviewer \(sol-reviewer\)[\s\S]*AGENT_CLI_INGRESS_WITNESS[\s\S]*# Assigned Mission\nReview through the declared identity\.[\s\S]*# Read-only Dispatch Contract[\s\S]*final stdout/u,
      );
    });
    await t.test("enforced Codex runtimes receive a callback relay without opening operator routes", async () => {
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
        const receivesRelay = runtime.kindId === "codex" && runtime.isolationState === "enforced";
        if (receivesRelay) {
          assert.match(String(launchedEnv?.HARNESS_DAEMON_ENDPOINT), /[\\/]\.harness[\\/]r-[a-f0-9]{24}\.sock$/u);
          assert.equal(launchedEnv?.HARNESS_DAEMON_RELAY, "1");
          assert.doesNotMatch(String(launchedEnv?.HARNESS_DAEMON_ENDPOINT), /harness-anything/u);
          assert.equal(launchedPersistence?.callbackRelay?.path, launchedEnv?.HARNESS_DAEMON_ENDPOINT);
          assert.equal(launchedPersistence?.callbackRelay?.endpoint, directEndpoint);
          assert.ok(launchedPrompt.includes(`Daemon endpoint: ${launchedEnv?.HARNESS_DAEMON_ENDPOINT}`));
        } else {
          assert.equal(launchedEnv?.HARNESS_DAEMON_ENDPOINT, directEndpoint);
          assert.equal(launchedEnv?.HARNESS_DAEMON_RELAY, undefined);
          assert.equal(launchedPersistence?.callbackRelay, undefined);
          assert.ok(launchedPrompt.includes(`Daemon endpoint: ${directEndpoint}`));
        }
      }
    });
    await t.test("the first dispatch holds the task lease and a concurrent second dispatch is rejected", async () => {
      const taskId = "task-runtime-dispatcher-handoff";
      await createReadyTask(taskId, "Dispatcher handoff");
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
      assert.equal(
        makeTaskEventReader({ repoId, rootDir: root })
          .read()
          .events.some(
            (event) =>
              event.type === "runtime_dispatch_requested" &&
              event.payload.runtimeSessionId === receipt.runtimeSessionId &&
              event.payload.dispatchId === receipt.dispatchId,
          ),
        true,
        "the first dispatch must be durably recorded before the redispatch attempt",
      );
      const launchesAfterFirst = launchCount,
        [concurrent, unrelated] = await Promise.all([
          rpc(host, auth, "repo.agentRuntime.spawn", {
            repo: { repoId },
            payload: {
              runtimeInstanceId: ingressDefinition.instanceId,
              cwd: { scope: "repo-root" },
              prompt: "A second dispatcher must not share the execution lease.",
              taskId,
              idempotencyKey: "dispatcher-handoff-concurrent",
            },
          }),
          Promise.race([
            createReadyTask("task-runtime-dispatcher-unrelated", "Dispatcher unrelated write"),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error("unrelated write was not accepted within 5000ms")), 5_000);
            }),
          ]),
        ]);
      assert.equal(concurrent.outcome, "op_rejected", JSON.stringify(concurrent));
      assert.equal(concurrent.code, "runtime_task_lease_required", JSON.stringify(concurrent));
      assert.equal(launchCount, launchesAfterFirst, "the rejected dispatch must not launch a provider");
      assert.equal(unrelated, undefined);
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
    await t.test("a lagging task identity projection rejects without scanning canonical batches", () => {
      const cell = {
        knownTaskIds: null,
        projection: {
          list: () => ({ watermark: 2, sourceRevision: 3, rows: [{ taskId: "task-projected" }] }),
        },
        cellCodedError,
      };
      assert.throws(
        () => projectedTaskIds(cell),
        (error: Error & { readonly code?: string }) =>
          error.code === "content_not_ready" && /watermark 2, source revision 3/u.test(error.message),
      );
      assert.equal(cell.knownTaskIds, null);
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
  } finally {
    await transport.stop();
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
