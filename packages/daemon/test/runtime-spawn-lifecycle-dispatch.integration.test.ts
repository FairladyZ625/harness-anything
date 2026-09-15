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
  runtimeDefinitionSnapshotArtifact,
  type AgentDefinitionSnapshot,
} from "../../kernel/src/index.ts";
import { type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { appendRuntimeWorkerRecord } from "../src/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { TASK_WIP_LIMIT_ENV } from "../src/task-wip-settings.ts";

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
      intentWasDurable = false,
      observerSawUnknown = false,
      firstExit: ((code: number | null) => void) | null = null,
      launchCount = 0;
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
      runtimeLaunch: (input, persistence) => {
        intentWasDurable = makeTaskEventReader({
          repoId: "runtime-spawn",
          rootDir: root,
        })
          .read()
          .events.some((candidate) => candidate.type === "runtime_dispatch_requested");
        launched = input;
        const observer = makeTaskProjection({
            rootDir: root,
            eventStore: makeTaskEventReader({ repoId: "runtime-spawn", rootDir: root }),
          }),
          thisLaunch = launchCount++;
        observerSawUnknown ||= observer.readRuntimeSessions().some((candidate) => candidate.liveness === "unknown");
        appendRuntimeWorkerRecord(root, persistence.dispatchId, {
          kind: "process_started",
          occurredAt: "2026-08-30T05:42:44.000Z",
          pid: 123,
        });
        return {
          pid: 123,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            if (thisLaunch === 0) firstExit = listener;
          },
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
            'Runtime spawn payload contains an unknown field "permission_mode"; allowed fields: "runtimeInstanceId", ' +
              '"dispatchId", "agentId", "targetAgentId", "squadId", "role", "model", "effort", "fast", "permissionMode", "cwd", ' +
              '"prompt", "promptSource", "missionName", "onExitCommand", "taskId", "idempotencyKey", ' +
              '"providerSessionId".',
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
      assert.equal(observerSawUnknown, true);
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
      await eventually(() =>
        makeTaskEventReader({ repoId: "runtime-spawn", rootDir: root })
          .read()
          .events.some(
            (candidate) =>
              candidate.type === "runtime_session_liveness_changed" &&
              candidate.payload.runtimeSessionId === receipt.runtimeSessionId &&
              candidate.payload.liveness === "live",
          ),
      );
      const events = makeTaskEventReader({ repoId: "runtime-spawn", rootDir: root }).read().events,
        observed = events.find((candidate) => candidate.type === "runtime_installation_observed"),
        dispatch = events.find((candidate) => candidate.type === "runtime_dispatch_requested"),
        started = events.find((candidate) => candidate.type === "runtime_session_started"),
        live = events.find(
          (candidate) =>
            candidate.type === "runtime_session_liveness_changed" &&
            candidate.payload.runtimeSessionId === receipt.runtimeSessionId,
        );
      assert.equal(
        observed?.type === "runtime_installation_observed" && observed.payload.installationId,
        definition.installationId,
      );
      assert.equal(
        observed?.type === "runtime_installation_observed" && observed.payload.version,
        installation.version,
      );
      assert.ok(events.indexOf(observed!) < events.indexOf(dispatch!));
      assert.ok(events.indexOf(dispatch!) < events.indexOf(started!));
      assert.ok(events.indexOf(started!) < events.indexOf(live!));
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
      const definitionArtifact = runtimeDefinitionSnapshotArtifact(definition);
      assert.equal(
        dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.definitionSnapshotRef,
        definitionArtifact.ref,
      );
      assert.equal(
        Buffer.from(
          makeTaskEventReader({ repoId: "runtime-spawn", rootDir: root }).readContentBlob(
            definitionArtifact.claim.sha256,
          )!,
        ).toString("utf8"),
        definitionArtifact.body,
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
      const { session } = await eventuallyValue(async () => {
        const overview = await cell.read("repo.agentRuntime.overview", {}),
          projected = overview.sessions.find((candidate) => candidate.runtimeSessionId === receipt.runtimeSessionId);
        return projected?.liveness === "live" ? { session: projected } : null;
      });
      assert.equal(session?.instanceId, definition.instanceId);
      assert.deepEqual(session?.definitionSnapshot, definition);
      assert.equal(session?.definitionSnapshotPersisted, true);
      assert.equal(session?.liveness, "live");
      assert.equal(session?.semanticState, "running");

      // Sanitized copies of the Codex JSONL frame shapes captured from a real
      // provider stream on 2026-08-30, followed by its native process exit.
      for (const event of [
        { type: "thread.started", thread_id: "provider-live-after-launch" },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: { id: "message", type: "agent_message", text: "runtime stayed live" },
        },
        { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
      ])
        appendRuntimeWorkerRecord(root, String(receipt.dispatchId), {
          kind: "provider_event",
          occurredAt: "2026-08-30T05:42:45.000Z",
          event,
        });
      appendRuntimeWorkerRecord(root, String(receipt.dispatchId), {
        kind: "process_exit",
        occurredAt: "2026-08-30T05:42:46.000Z",
        exitCode: 0,
        signal: null,
      });
      assert.ok(firstExit, "runtime exit listener must be attached before the provider exits");
      firstExit(0);
      const settled = await eventuallyValue(async () => {
        const projected = (await cell.read("repo.agentRuntime.overview", {})).sessions.find(
          (candidate) => candidate.runtimeSessionId === receipt.runtimeSessionId,
        );
        return projected?.liveness === "exited" ? projected : null;
      });
      assert.equal(settled?.liveness, "exited");
      assert.notEqual(settled?.semanticState, "running");
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

test(
  "explicit runtime cancel terminates every detached native provider descendant group",
  { skip: process.platform === "win32" ? "requires POSIX process-group semantics" : false },
  async (t) => {
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
      const cancelledSession = await eventuallyValue(async () => {
        const read = await cell!.read("repo.agentRuntime.sessions.read", { runtimeSessionId });
        return read.session.activity.outcome === "cancelled" ? read.session : null;
      });
      assert.equal(cancelledSession.activity.outcome, "cancelled");
      const streamPath = path.join(root, ".harness", "runtime", "dispatches", `${String(spawned.dispatchId)}.jsonl`),
        descendants = await eventuallyValue(() => {
          const records = readFileSync(streamPath, "utf8")
            .trim()
            .split(/\r?\n/u)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          return records.find((record) => record.kind === "process_descendants") ?? null;
        });
      assert.deepEqual(
        (descendants.pids as number[]).slice().sort((left, right) => left - right),
        pids.slice().sort((left, right) => left - right),
      );
      const survivors = pids.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
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
  },
);

test("dispatch reclaims an orphaned task lease instead of requiring a manual release", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-orphan-lease-"));
  let clock = "2026-09-11T00:00:00.000Z";
  try {
    initIngressRepo(root, 4313);
    const cell = await openRepoCell({
      repoId: workspaceId("runtime-orphan-lease"),
      rootDir: canonicalRoot(root),
      ownerId: "orphan-lease-test",
      now: () => clock,
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: "orphan-lease-test",
        endpoint: path.join(root, ".daemon-user", "daemon.sock"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Codex Orphan Lease",
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
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    });
    try {
      const taskId = "task-runtime-orphan-lease",
        executionId = "execution-runtime-orphan-lease",
        binding = {
          actor: { principal: { personId: "person-orphan-lease" }, executor: null },
          source: "local" as const,
        };
      const created = await cell.run({ kind: "task-create", taskId, title: "Orphan lease dispatch" }, binding);
      assert.equal(created.outcome, "applied");
      await waitForFixturePublication(cell, created.opId, binding);
      await realizeTaskPlanFixture(
        root,
        String((created as Record<string, unknown>).packagePath),
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
        "Orphan lease dispatch",
      );
      assert.equal(
        (
          await cell.run(
            {
              kind: "task-start",
              taskId,
              executionId,
              executor: { kind: "agent", id: "orphan-lease-worker" },
              ttlMs: 60_000,
            },
            binding,
          )
        ).outcome,
        "applied",
      );
      const held = String(
        ((await cell.run({ kind: "task-show", taskId }, binding)) as Record<string, unknown>).summary,
      );
      assert.match(held, /\nlease: [^\n]*phase=held/u, held);
      // Past the 60s TTL the lease projects as orphaned with no manual `ha task release`.
      clock = "2026-09-11T00:01:01.000Z";
      const lapsed = String(
        ((await cell.run({ kind: "task-show", taskId }, binding)) as Record<string, unknown>).summary,
      );
      assert.match(lapsed, /\nlease: [^\n]*phase=orphaned/u, lapsed);
      // Only the same principal or the task owner may reclaim it; another person is refused.
      await assert.rejects(
        cell.spawnRuntime(
          {
            runtimeInstanceId: definition.instanceId,
            cwd: { scope: "repo-root" },
            prompt: "Reclaim another person's orphaned lease.",
            taskId,
            idempotencyKey: "orphan-lease-stranger",
          },
          { ...binding, actor: { principal: { personId: "person-orphan-stranger" }, executor: null } },
        ),
        /same principal reclaiming an orphaned lease/u,
      );
      const receipt = await cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Reclaim the orphaned lease and continue the task.",
          taskId,
          idempotencyKey: "orphan-lease-reclaim",
        },
        binding,
      );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const projection = makeTaskProjection({
        rootDir: root,
        eventStore: makeTaskEventReader({ repoId: "runtime-orphan-lease", rootDir: root }),
        now: () => clock,
      });
      try {
        const snapshot = projection.read(taskId).snapshot;
        assert.equal(snapshot.lease?.phase, "held");
        assert.deepEqual(snapshot.lease?.actor.executor, {
          kind: "agent",
          id: `runtime-session:${receipt.runtimeSessionId}`,
        });
      } finally {
        projection.close();
      }
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime dispatch of a planned task is rejected at a full worktable", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-wip-full-"));
  const previousLimit = process.env[TASK_WIP_LIMIT_ENV];
  process.env[TASK_WIP_LIMIT_ENV] = "1";
  let launchCount = 0;
  try {
    initIngressRepo(root, 4312);
    const cell = await openRepoCell({
      repoId: workspaceId("runtime-wip-full"),
      rootDir: canonicalRoot(root),
      ownerId: "runtime-wip-full-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: "runtime-wip-full-test",
        endpoint: path.join(root, ".daemon-user", "daemon.sock"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Codex WIP Full",
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
      runtimeLaunch: () => {
        launchCount += 1;
        return {
          pid: process.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    });
    try {
      const binding = {
        actor: { principal: { personId: "person-wip-full" }, executor: null },
        source: "local" as const,
      };
      const occupant = await cell.run(
        { kind: "task-create", taskId: "task-wip-full-occupant", title: "Occupant" },
        binding,
      );
      assert.equal(occupant.outcome, "applied");
      await waitForFixturePublication(cell, occupant.opId, binding);
      await realizeTaskPlanFixture(
        root,
        String((occupant as Record<string, unknown>).packagePath),
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
        "Occupant",
      );
      assert.equal(
        (
          await cell.run(
            { kind: "task-start", taskId: "task-wip-full-occupant", executionId: "execution-wip-full-occupant" },
            binding,
          )
        ).outcome,
        "applied",
      );
      const planned = await cell.run(
        { kind: "task-create", taskId: "task-wip-full-planned", title: "Planned dispatch target" },
        binding,
      );
      assert.equal(planned.outcome, "applied");
      await waitForFixturePublication(cell, planned.opId, binding);
      await realizeTaskPlanFixture(
        root,
        String((planned as Record<string, unknown>).packagePath),
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
        "Planned dispatch target",
      );
      await assert.rejects(
        cell.spawnRuntime(
          {
            runtimeInstanceId: definition.instanceId,
            cwd: { scope: "repo-root" },
            prompt: "Dispatch a planned task while the worktable is full",
            taskId: "task-wip-full-planned",
            idempotencyKey: "wip-full-dispatch",
          },
          binding,
        ),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "task_wip_limit_reached",
      );
      assert.equal(launchCount, 0, "the rejected dispatch must not launch a provider");
    } finally {
      await cell.close();
    }
  } finally {
    if (previousLimit === undefined) delete process.env[TASK_WIP_LIMIT_ENV];
    else process.env[TASK_WIP_LIMIT_ENV] = previousLimit;
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
