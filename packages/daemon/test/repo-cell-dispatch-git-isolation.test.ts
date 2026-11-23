// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import {
  runGitHistoryLogAsync,
  runProcessText,
  type AsyncGitHistoryLogRunner,
} from "../src/daemon-host/process-port.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { openRepoWriterCell } from "../src/daemon-host/repo-cell-open.ts";
import type { RepoCell, RepoCellApiContext } from "../src/daemon-host/repo-cell-types.ts";
import { enqueueRuntimePublication } from "../src/daemon-host/runtime-publication-queue.ts";
import type { RuntimeLauncher } from "../src/daemon-host/runtime-spawn-types.ts";
import { policyTestCenter, provisionPolicyTestRepository, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { fixtureFence, settleSettingsEvent, waitForFixturePublication } from "./repo-settings.fixture.ts";

const actor = { principal: { personId: "person-git-isolation" }, executor: null } as const;
const TARGET = "packages/demo/src/target.ts";
const OTHER = "packages/demo/src/other.ts";
const HIST_TASK = "task_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const DISPATCH_TASK = "task_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const DRIFT_TASK = "task_cccccccccccccccccccccccccc";

function git(cwd: string, ...args: string[]): string {
  return runProcessText(
    "git",
    [
      "-c",
      "user.name=Git Isolation Test",
      "-c",
      "user.email=git-isolation@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
  );
}

function writeRepoFile(root: string, file: string, body: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), body);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function stopStubProcess(child: ReturnType<typeof spawn>): Promise<void> {
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

function stubRuntimeInstances() {
  return [
    {
      schemaVersion: 2 as const,
      instanceId: "stub",
      name: "Stub",
      kindId: "codex" as const,
      installationId: "installation-stub",
      providerId: "openai" as const,
      models: ["stub-model"],
      defaultModel: "stub-model",
      enabled: true,
      permissionMode: "workspace-write" as const,
      codex: {},
      authMode: "subscription" as const,
      authState: "configured" as const,
      authReadiness: { status: "ready" as const, code: null, hint: null },
      isolationState: "enforced" as const,
    },
  ];
}

async function setupIsolationFixture(options: {
  readonly name: string;
  readonly runGitHistoryAsync: AsyncGitHistoryLogRunner;
}) {
  const parent = mkdtempSync(path.join(tmpdir(), `ha-dispatch-git-iso-${options.name}-`)),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = workspaceId(`dispatch-git-iso-${options.name}`),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
    launchedPrompts: string[] = [],
    spawnedChildren: ReturnType<typeof spawn>[] = [];

  mkdirSync(rootDir);
  git(rootDir, "init", "-q", "-b", "main");
  writeRepoFile(rootDir, TARGET, "export const target = 1;\n");
  writeRepoFile(rootDir, OTHER, "export const other = 1;\n");
  writeRepoFile(rootDir, ".gitignore", "harness/\n.harness/\n.worktrees/\n");
  mkdirSync(path.join(rootDir, "harness"));
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  defaultVertical: software/coding\n  defaultPreset: standard-task\n  defaultProfile: baseline\n",
  );
  git(rootDir, "add", "-A");
  git(rootDir, "commit", "-qm", "chore: seed repository");
  git(rootDir, "checkout", "-q", "-b", HIST_TASK);
  writeRepoFile(rootDir, TARGET, "export const target = 2;\n");
  git(rootDir, "commit", "-qam", "feat: update target");
  git(rootDir, "checkout", "-q", "main");
  git(rootDir, "merge", "-q", "--no-ff", "-m", `Merge pull request #77 from owner/${HIST_TASK}`, HIST_TASK);

  provisionPolicyTestRepository(repoId);
  const runtimeInstances = stubRuntimeInstances,
    fence = fixtureFence(repoId, rootDir, path.join(rootDir, ".harness/fixture-writer-epochs"));
  await settleSettingsEvent({ repoId, rootDir, writerEpochFence: fence, runtimeInstances: runtimeInstances() });

  const runtimeLaunch: RuntimeLauncher = (_prepared, persistence) => {
    const child = spawn("git", ["hash-object", "--stdin"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (!child.pid) throw new Error("stub runtime child did not expose a pid");
    child.unref();
    spawnedChildren.push(child);
    return {
      pid: child.pid,
      onOutput: (listener) => {
        queueMicrotask(() =>
          listener(JSON.stringify({ type: "thread.started", thread_id: `provider-${persistence.dispatchId}` }) + "\n"),
        );
      },
      onErrorOutput: () => undefined,
      onExit: () => undefined,
      terminate: () => {
        void stopStubProcess(child);
      },
      terminateTree: () => stopStubProcess(child),
    };
  };

  const cell = await openRepoWriterCell(
    {
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: `dispatch-git-iso-${options.name}`,
      keycloakSession: async () => binding.keycloakAuthorization.session,
      keycloakCenter: policyTestCenter,
      defaultWriterEpochFence: fence,
      runtimeDaemonRoute: {
        userRoot,
        daemonId: "test",
        endpoint: path.join(parent, "socket"),
      },
      runtimeInstances,
      prepareRuntimeLaunch: async (instanceId, request) => {
        launchedPrompts.push(request.prompt);
        return {
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
            observedAt: "2026-11-23T00:00:00.000Z",
          },
          executablePath: "/fixture/stub",
          args: request.providerSessionId ? [request.providerSessionId] : [],
          env: process.env,
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      runtimeLaunch,
      runGitHistoryAsync: options.runGitHistoryAsync,
    },
    { close: async () => undefined } as never,
  );

  // Seed an in-effect governing Decision with a rejected redline and an anchored Fact for TARGET.
  const proposed = await cell.run(
    {
      kind: "decision-propose",
      jsonInput: JSON.stringify({
        title: "Keep dispatch Git outside single-writer slot",
        question: "Where should reverse-trace Git history run during dispatch?",
        riskTier: "low",
        urgency: "low",
        vertical: "software/coding",
        preset: "standard-task",
        decisionClass: "ordinary",
        appliesTo: { modules: ["packages/demo/src"], productLines: [] },
        chosen: [{ id: "CH1", text: "Pre-collect Git history asynchronously outside enqueueRuntimePublication" }],
        rejected: [
          {
            id: "RJ1",
            text: "Run synchronous git log inside enqueueRuntimePublication",
            whyNot: "Blocks concurrent ordinary writes on the RepoCell single-writer slot.",
          },
        ],
        claims: [],
        fulfillments: [],
      }),
      body: "# Decision\n\n## 背景\n\nKeep write slots isolated.\n\n## 权衡\n\nAsync pre-collection.\n\n## 结论\n\nPre-collect outside write slot.\n",
    },
    binding,
  );
  assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
  const decisionId = String((JSON.parse(String(proposed.evidence)) as { readonly decisionId: string }).decisionId),
    arbiter = withPolicyGroup(
      {
        actor: { principal: { personId: `person-arbiter-${options.name}` }, executor: null },
        source: "local" as const,
      },
      "maintainer",
    ),
    accepted = await cell.run(
      {
        kind: "decision-accept",
        decisionId,
        rationale: "Enforce CH1 write-slot isolation.",
        judgmentOnlyRationale: "Test fixture acceptance.",
      },
      arbiter,
    );
  assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
  await waitForFixturePublication(cell as unknown as RepoCell, accepted.opId, arbiter);

  const factReceipt = await cell.run(
    {
      kind: "fact-record",
      statement: "TARGET history is collected outside the single-writer slot.",
      evidenceSource: `${TARGET}:1-2`,
      confidence: "high",
      memoryClass: "episodic",
      memoryTags: [],
    },
    binding,
  );
  assert.equal(factReceipt.outcome, "applied", JSON.stringify(factReceipt));
  await waitForFixturePublication(cell as unknown as RepoCell, factReceipt.opId, binding);

  return {
    parent,
    rootDir,
    repoId,
    binding,
    cell,
    decisionId,
    launchedPrompts,
    cleanup: async () => {
      await Promise.all(spawnedChildren.map((child) => stopStubProcess(child)));
      await cell.close();
      removeTempRepository(parent);
    },
  };
}

test(
  "paused dispatch Git history collection does not block concurrent accepted_durable writes on the same RepoCell (dec_9979850C CH1/F7)",
  { timeout: 60_000 },
  async () => {
    const gitEntered = deferred<void>();
    const releaseGit = deferred<void>();
    let pauseArmed = false;
    let enteredWriteSlot = false;
    let gitCallsBeforeWriteSlot = 0;
    let gitCallsInsideWriteSlot = 0;
    let gitReleased = false;

    const fixture = await setupIsolationFixture({
      name: "paused-git",
      runGitHistoryAsync: async (rootDir, args, timeoutMs) => {
        if (enteredWriteSlot) gitCallsInsideWriteSlot += 1;
        else gitCallsBeforeWriteSlot += 1;
        if (pauseArmed) {
          gitEntered.resolve();
          await releaseGit.promise;
        }
        return runGitHistoryLogAsync(rootDir, args, timeoutMs);
      },
    });
    try {
      const { rootDir, binding, cell, decisionId, launchedPrompts } = fixture;
      const created = await cell.run(
        { kind: "task-create", taskId: DISPATCH_TASK, title: "Dispatch with paused Git", presetId: "docs-task" },
        binding,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell as unknown as RepoCell, created.opId, binding);
      const packagePath = String((created as Record<string, unknown>).packagePath);
      await realizeTaskPlanFixture(
        rootDir,
        packagePath,
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
        "Dispatch with paused Git",
        `Target code path: \`${TARGET}\`.`,
      );
      const started = await cell.run({ kind: "task-start", taskId: DISPATCH_TASK }, binding);
      assert.equal(started.outcome, "applied", JSON.stringify(started));

      pauseArmed = true;
      let spawnSettled = false;
      const spawnPromise = cell
        .spawnRuntime(
          {
            taskId: DISPATCH_TASK,
            runtimeInstanceId: "stub",
            cwd: { scope: "repo-root" },
            dispatchKey: "dispatch-paused-git-ch1",
          },
          binding,
          undefined,
          () => {
            enteredWriteSlot = true;
          },
        )
        .then((receipt) => {
          spawnSettled = true;
          return receipt;
        });

      // Wait until the real async Git history runner is actively paused in-flight.
      await gitEntered.promise;
      assert.equal(enteredWriteSlot, false, "paused Git collection must not hold the single-writer slot");
      assert.equal(cell.status().queueDepth, 0, "the RepoCell write queue remains idle while Git is paused");

      // Execute concurrent ordinary writes on the SAME RepoCell while dispatch Git is paused.
      const concurrentFact = await cell.run(
        {
          kind: "fact-record",
          statement: "Ordinary write accepted durably while dispatch Git history is paused.",
          evidenceSource: `${OTHER}:1`,
          confidence: "high",
          memoryClass: "episodic",
          memoryTags: [],
        },
        binding,
      );
      assert.equal(concurrentFact.outcome, "applied", JSON.stringify(concurrentFact));
      assert.equal(concurrentFact.status, "accepted_durable", JSON.stringify(concurrentFact));
      assert.equal(concurrentFact.proof?.durable, true);

      const concurrentTask = await cell.run(
        { kind: "task-create", taskId: "task_concurrent_ordinary_write", title: "Concurrent task create" },
        binding,
      );
      assert.equal(concurrentTask.outcome, "applied", JSON.stringify(concurrentTask));
      assert.equal(concurrentTask.status, "accepted_durable", JSON.stringify(concurrentTask));

      // Confirm dispatch is still paused on Git and has not yet entered the write slot.
      assert.equal(gitReleased, false);
      assert.equal(spawnSettled, false);
      assert.equal(enteredWriteSlot, false);

      // Release Git and confirm dispatch completes normally with real reverse-traced causal context.
      gitReleased = true;
      releaseGit.resolve();
      const spawnReceipt = await spawnPromise;
      assert.equal(typeof spawnReceipt.dispatchId, "string", JSON.stringify(spawnReceipt));
      assert.equal(typeof spawnReceipt.runtimeSessionId, "string", JSON.stringify(spawnReceipt));
      assert.equal(enteredWriteSlot, true, "dispatch entered the write slot after Git snapshot finished");
      assert.ok(gitCallsBeforeWriteSlot >= 2, "real git log/branch history ran before entering the write slot");
      assert.equal(gitCallsInsideWriteSlot, 0, "zero Git subprocesses ran inside enqueueRuntimePublication");

      assert.equal(launchedPrompts.length, 1);
      const prompt = launchedPrompts[0]!;
      assert.match(
        prompt,
        new RegExp(`<redline ref="decision/${decisionId}/RJ1" trace-path="${TARGET.replaceAll(".", "\\.")}">`, "u"),
        "launched mission contains the reverse-traced redline",
      );
      assert.match(
        prompt,
        new RegExp(`<anchored ref="fact/F-[0-9A-F]+" trace-path="${TARGET.replaceAll(".", "\\.")}">`, "u"),
        "launched mission contains the reverse-traced anchored fact",
      );
    } finally {
      releaseGit.resolve();
      await fixture.cleanup();
    }
  },
);

test("negative control validity: pausing work inside enqueueRuntimePublication blocks a concurrent RepoCell write until released", async () => {
  const repoId = "negative-control-write-slot-blocks";
  provisionPolicyTestRepository(repoId);
  const binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
    slotEntered = deferred<void>(),
    releaseSlot = deferred<void>();
  const context = {
    mode: "local",
    state: "attached",
    causeClass: null,
    recoveryUncertain: false,
    queueDepth: 0,
    tail: Promise.resolve(),
    writeQueue: { waiting: [], nowMs: () => 0 },
    activeWriter: { workspaceId: repoId, generation: 1, ownerId: "test" },
    writerToken: null,
    activeWriterEpochFence: null,
    activeWriterEpochFenceDescriptor: null,
    input: { repoId },
    store: { readHead: () => ({ revision: 1 }) },
    projection: { readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }) },
    replica: { kick: () => undefined },
    now: () => "2026-11-23T00:00:00.000Z",
    operationId: () => "op-control",
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    attemptRecovery: async () => undefined,
    latched: () => "latched",
  } as unknown as RepoCellApiContext;
  // Bind a valid writer token for assertCurrentWriter.
  const { bindWriterGenerationToken } = await import("@harness-anything/kernel");
  Object.assign(context, { writerToken: bindWriterGenerationToken(context.activeWriter) });

  // Simulate what happens if Git collection is placed INSIDE enqueueRuntimePublication:
  const blockedDispatch = enqueueRuntimePublication(
    context,
    "runtime-run",
    { kind: "runtime-spawn", taskId: null },
    binding,
    async () => {
      slotEntered.resolve();
      await releaseSlot.promise;
      return { runtimeSessionId: "runtime_blocked_inside_slot" };
    },
  );
  await slotEntered.promise;

  let concurrentWriteSettled = false;
  const concurrentWrite = enqueueRuntimePublication(
    context,
    "runtime-run",
    { kind: "runtime-spawn", taskId: null },
    binding,
    () => ({ status: "accepted_durable", opId: "op-ordinary" }),
  ).then((result) => {
    concurrentWriteSettled = true;
    return result;
  });

  // Across multiple event-loop turns, the concurrent write stays blocked behind the paused slot.
  for (let turn = 0; turn < 10; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(concurrentWriteSettled, false, "a pause inside enqueueRuntimePublication blocks concurrent writes");
  assert.equal(context.queueDepth, 1, "one concurrent write is waiting behind the paused head");
  assert.equal(context.writeQueue.waiting.length, 2, "head plus waiting concurrent write are both tracked");

  releaseSlot.resolve();
  await blockedDispatch;
  const writeResult = await concurrentWrite;
  assert.equal(concurrentWriteSettled, true);
  assert.equal(writeResult.status, "accepted_durable");
  assert.equal(context.queueDepth, 0);
});

test(
  "concurrent task_plan.md path drift during paused Git preparation never falls back to Git inside the write slot",
  { timeout: 60_000 },
  async () => {
    const gitEntered = deferred<void>();
    const releaseGit = deferred<void>();
    let pauseArmed = false;
    let enteredWriteSlot = false;
    let gitCallsInsideWriteSlot = 0;

    const fixture = await setupIsolationFixture({
      name: "path-drift",
      runGitHistoryAsync: async (rootDir, args, timeoutMs) => {
        if (enteredWriteSlot) gitCallsInsideWriteSlot += 1;
        if (pauseArmed) {
          gitEntered.resolve();
          await releaseGit.promise;
        }
        return runGitHistoryLogAsync(rootDir, args, timeoutMs);
      },
    });
    try {
      const { rootDir, binding, cell, decisionId, launchedPrompts } = fixture;
      const created = await cell.run(
        { kind: "task-create", taskId: DRIFT_TASK, title: "Dispatch with plan path drift", presetId: "docs-task" },
        binding,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell as unknown as RepoCell, created.opId, binding);
      const packagePath = String((created as Record<string, unknown>).packagePath);
      await realizeTaskPlanFixture(
        rootDir,
        packagePath,
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
        "Dispatch with plan path drift",
        `Initial target: \`${TARGET}\`.`,
      );
      const started = await cell.run({ kind: "task-start", taskId: DRIFT_TASK }, binding);
      assert.equal(started.outcome, "applied", JSON.stringify(started));

      pauseArmed = true;
      const spawnPromise = cell.spawnRuntime(
        {
          taskId: DRIFT_TASK,
          runtimeInstanceId: "stub",
          cwd: { scope: "repo-root" },
          dispatchKey: "dispatch-path-drift-ch1",
        },
        binding,
        undefined,
        () => {
          enteredWriteSlot = true;
        },
      );

      await gitEntered.promise;
      assert.equal(enteredWriteSlot, false);

      // Concurrently mutate task_plan.md so its traced code path drifts from TARGET to OTHER.
      await realizeTaskPlanFixture(
        rootDir,
        packagePath,
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
        "Dispatch with plan path drift",
        `Updated target: \`${OTHER}\`.`,
      );
      await cell.settlePendingMaterialization("plan path drift");

      releaseGit.resolve();
      const spawnReceipt = await spawnPromise;
      assert.equal(typeof spawnReceipt.dispatchId, "string", JSON.stringify(spawnReceipt));
      assert.equal(enteredWriteSlot, true);
      assert.equal(gitCallsInsideWriteSlot, 0, "path drift must never fall back to running Git inside the write slot");

      // Module-scoped redline still resolves cleanly against the updated plan path OTHER,
      // while TARGET's anchored fact is not attributed to OTHER.
      assert.equal(launchedPrompts.length, 1);
      const prompt = launchedPrompts[0]!;
      assert.match(
        prompt,
        new RegExp(`<redline ref="decision/${decisionId}/RJ1" trace-path="${OTHER.replaceAll(".", "\\.")}">`, "u"),
      );
      assert.doesNotMatch(
        prompt,
        new RegExp(`trace-path="${TARGET.replaceAll(".", "\\.")}"`, "u"),
        "stale TARGET snapshot is never attributed after path drift",
      );
    } finally {
      releaseGit.resolve();
      await fixture.cleanup();
    }
  },
);
