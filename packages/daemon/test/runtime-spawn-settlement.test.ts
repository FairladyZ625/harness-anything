// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyRuntimeExit } from "../src/runtime-provider-fault.ts";
import { failed } from "../src/repo-cell-settlement.ts";
import { runtimeMissionName } from "../src/runtime-spawn-mission.ts";
import { scheduleMissionWithOutcomeProtocol, scheduleOutcomeFromRuntime } from "../src/schedule-runtime-outcome.ts";
import { publishExit } from "../src/runtime-spawn-settlement.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";

test("path-like runtime missions produce an actionable receipt without exposing the path", (context) => {
  let error: unknown;
  try {
    runtimeMissionName("tasks/task-owner/artifacts/missions/continue-01.md");
  } catch (caught) {
    error = caught;
  }
  const receipt = failed("op-runtime-mission", error);
  assert.equal(receipt.code, "invalid_runtime_mission");
  assert.deepEqual(receipt.diagnostic, {
    kind: "validation",
    entity: "runtime mission",
    field: "mission",
    actual: "path-like value",
    expectation:
      "Expected a bare mission id; the daemon resolves harness/<task-package>/artifacts/missions/<name>.md " +
      "and did not look up this file. Retry ha agent run <agent-id> --task <task-id> --mission <name>",
  });
  context.diagnostic(`invalid_runtime_mission receipt=${JSON.stringify(receipt)}`);
});

test("exit zero is success evidence even when provider protocol evidence is incomplete", () => {
  const result = classifyRuntimeExit(active({ protocolError: true }), 0);
  assert.equal(result.outcome, "succeeded");
  assert.match(result.reason, /successfully/u);
});

test("exit zero does not require a separate write or plan declaration", () => {
  const result = classifyRuntimeExit(active({ writeItemObserved: false, planObserved: false }), 0);
  assert.equal(result.outcome, "succeeded");
});

test("exit zero does not turn an internal plan heuristic into an unknown outcome", () => {
  assert.equal(
    classifyRuntimeExit(active({ writeItemObserved: true, planObserved: true, planIncomplete: true }), 0).outcome,
    "succeeded",
  );
});

test("scheduled missions receive the daemon-owned outcome protocol", () => {
  assert.equal(
    scheduleMissionWithOutcomeProtocol("Inspect the repository.\n"),
    [
      "Inspect the repository.",
      "",
      "# Schedule outcome protocol",
      "Your final response's last non-empty line must be exactly one of:",
      "HARNESS-OUTCOME: succeeded",
      "HARNESS-OUTCOME: failed",
    ].join("\n"),
  );
});

test("schedule outcome requires an exact verdict on the last non-empty line", () => {
  assert.equal(scheduleOutcomeFromRuntime("succeeded", "done\nHARNESS-OUTCOME: succeeded\n\n"), "succeeded");
  assert.equal(scheduleOutcomeFromRuntime("succeeded", "not done\nHARNESS-OUTCOME: failed"), "failed");
  assert.equal(scheduleOutcomeFromRuntime("succeeded", "HARNESS-OUTCOME: failed\nmore text"), "unknown");
  assert.equal(scheduleOutcomeFromRuntime("succeeded", " HARNESS-OUTCOME: succeeded"), "unknown");
  assert.equal(scheduleOutcomeFromRuntime("succeeded", "done"), "unknown");
  assert.equal(scheduleOutcomeFromRuntime("failed", "HARNESS-OUTCOME: succeeded"), "failed");
  assert.equal(scheduleOutcomeFromRuntime("unknown", "HARNESS-OUTCOME: succeeded"), "unknown");
  assert.equal(scheduleOutcomeFromRuntime("cancelled", "HARNESS-OUTCOME: succeeded"), "cancelled");
});

test("a write-capable squad leader converged decision settles as succeeded without per-turn write evidence", () => {
  const result = classifyRuntimeExit(
    active({
      squadId: "core-squad",
      delegatedBy: null,
      finalText: JSON.stringify({ schema: "squad-decision/v1", action: "converged", report: "# Synthesis" }),
      writeItemObserved: false,
      planObserved: false,
    }),
    0,
  );
  assert.equal(result.outcome, "succeeded");
});

test("a non-zero squad leader exit is failed even when its final text declares convergence", () => {
  const result = classifyRuntimeExit(
    active({
      squadId: "core-squad",
      delegatedBy: null,
      finalText: JSON.stringify({ schema: "squad-decision/v1", action: "converged", report: "# Synthesis" }),
      writeItemObserved: false,
      planObserved: false,
    }),
    1,
  );
  assert.equal(result.outcome, "failed");
});

test("terminal settlement reports a runtime archive failure and still publishes the exit", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-archive-failure-")),
    runtime = active({
      process: {
        pid: 123,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      },
      runtimeSessionId: "runtime-archive-failure",
      dispatchOpId: "dispatch-op",
      binding: {
        actor: {
          principal: { kind: "human", id: "operator" },
          executor: { kind: "agent", id: "runtime-session:runtime-archive-failure" },
        },
        source: "local",
      },
      task: { taskId: "task-owner", executionId: "execution-owner", leaseVersion: 1 },
      schedule: null,
      cwd: rootDir,
      prompt: "archive this result",
      onExitCommand: null,
      reasoningEffort: null,
      fast: false,
      startedAt: "2026-09-03T00:00:00.000Z",
      stream: {
        ref: "runtime-stream:dispatch_0123456789abcdef01234567",
        appendAttemptOutcome: () => undefined,
      } as never,
      buffer: "",
      durableOutputCount: 0,
      stdoutObserved: true,
      providerSessionId: "provider-session",
      resumeProviderSessionId: null,
      finalText: null,
      cancelBinding: null,
      cancelOpId: null,
    }),
    archiveError = new Error("archive publication failed"),
    errors: string[] = [],
    published: string[] = [],
    outcomeBodies: string[] = [],
    outcomes: Record<string, unknown>[] = [],
    originalError = console.error,
    context = {
      exiting: new Set<string>(),
      processes: new Map([[runtime.runtimeSessionId, runtime]]),
      input: {
        repoId: "canonical",
        rootDir,
        now: () => "2026-09-03T00:01:00.000Z",
        stream: { publish: () => ({}) },
        remote: { archive: async () => Promise.reject(archiveError) },
      },
      resultMediaType: "text/markdown",
      runtimeResultText: () => "failed result",
      markProtocolError: () => undefined,
      publishRuntimeEvent: async (
        type: string,
        payload: Record<string, unknown> = {},
        _opId?: string,
        _binding?: unknown,
        body?: string,
      ) => {
        published.push(type);
        if (type === "runtime_session_outcome_observed") {
          outcomes.push(payload);
          outcomeBodies.push(String(body));
        }
        return {};
      },
      settleFallback: async () => undefined,
    } as unknown as RuntimeSpawnerContext;
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  try {
    await publishExit(context, runtime, 1);
    assert.match(errors.join("\n"), /could not be archived: archive publication failed/u);
    assert.deepEqual(published, ["runtime_session_exited", "runtime_session_outcome_observed"]);
    assert.equal(outcomes[0]?.outcome, "failed");
    assert.equal(outcomes[0]?.reasonCode, "runtime_archive_failed");
    const expectedBody = "failed result\n\nRuntime archive publication failed: archive publication failed";
    assert.deepEqual(outcomeBodies, [expectedBody]);
    assert.equal(
      outcomes[0]?.resultRef,
      `artifact:runtime-result/sha256/${createHash("sha256").update(expectedBody).digest("hex")}`,
      "the failed terminal resultRef must identify content that still contains the worker result",
    );
  } finally {
    console.error = originalError;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("terminal settlement keeps the worker result when fallback settlement fails", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-settlement-failure-")),
    runtime = active({
      process: {
        pid: 124,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      },
      runtimeSessionId: "runtime-settlement-failure",
      dispatchOpId: "settlement-dispatch-op",
      binding: {
        actor: {
          principal: { kind: "human", id: "operator" },
          executor: { kind: "agent", id: "runtime-session:runtime-settlement-failure" },
        },
        source: "local",
      },
      task: null,
      schedule: null,
      cwd: rootDir,
      prompt: "settle this result",
      onExitCommand: null,
      reasoningEffort: null,
      fast: false,
      startedAt: "2026-09-03T00:00:00.000Z",
      stream: {
        ref: "runtime-stream:dispatch_0123456789abcdef01234567",
        appendAttemptOutcome: () => undefined,
      } as never,
      buffer: "",
      durableOutputCount: 0,
      stdoutObserved: true,
      providerSessionId: "provider-session",
      resumeProviderSessionId: null,
      finalText: null,
      cancelBinding: null,
      cancelOpId: null,
    }),
    outcomeBodies: string[] = [],
    outcomes: Record<string, unknown>[] = [],
    context = {
      exiting: new Set<string>(),
      processes: new Map([[runtime.runtimeSessionId, runtime]]),
      input: {
        repoId: "canonical",
        rootDir,
        now: () => "2026-09-03T00:01:00.000Z",
        stream: { publish: () => ({}) },
        remote: { archive: async () => ({ outcome: "applied" }) },
      },
      resultMediaType: "text/markdown",
      runtimeResultText: () => "worker delivery",
      markProtocolError: () => undefined,
      publishRuntimeEvent: async (
        type: string,
        payload: Record<string, unknown> = {},
        _opId?: string,
        _binding?: unknown,
        body?: string,
      ) => {
        if (type === "runtime_session_outcome_observed") {
          outcomes.push(payload);
          outcomeBodies.push(String(body));
        }
        return {};
      },
      settleFallback: async () => {
        throw Object.assign(new Error("lease release failed"), { code: "runtime_lease_release_failed" });
      },
    } as unknown as RuntimeSpawnerContext;
  try {
    await publishExit(context, runtime, 0);
    const expectedBody =
      "worker delivery\n\nRuntime terminal settlement failed (runtime_lease_release_failed): lease release failed";
    assert.deepEqual(outcomeBodies, [expectedBody]);
    assert.equal(outcomes[0]?.outcome, "failed");
    assert.equal(outcomes[0]?.reasonCode, "runtime_lease_release_failed");
    assert.equal(
      outcomes[0]?.resultRef,
      `artifact:runtime-result/sha256/${createHash("sha256").update(expectedBody).digest("hex")}`,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("terminal settlement reports the branch and head its worker push published", async (context) => {
  const fixture = workerGitFixture(context, "settle-push", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, { finalText: "worker delivery" }),
    outcomeBodies: string[] = [],
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") {
        outcomes.push(payload);
        outcomeBodies.push(String(body));
      }
      return {};
    });
  await publishExit(settleContext, runtime, 0);
  const head = git(fixture.worker, "rev-parse", "HEAD").trim(),
    expectedBody = `worker delivery\n\nWorker branch pushed at settlement: codex/settle-push @ ${head}`;
  assert.deepEqual(outcomeBodies, [expectedBody]);
  assert.equal(
    outcomes[0]?.resultRef,
    `artifact:runtime-result/sha256/${createHash("sha256").update(expectedBody).digest("hex")}`,
    "the push line must be inside the durable terminal result the CEO reads",
  );
  assert.ok(git(fixture.bare, "show-ref", "--verify", "refs/heads/codex/settle-push").trim().startsWith(`${head} `));
});

test("squad leader settlement preserves its machine-readable control result", async (context) => {
  const fixture = workerGitFixture(context, "squad-leader-control", { reachableRemote: true }),
    controlResult = JSON.stringify({
      schema: "runtime-batch/v1",
      dispatches: [{ to: "terra", prompt: "Review the runtime boundary." }],
    }),
    runtime = workerSettlementRuntime(fixture, {
      agent: { id: "fable", name: "Fable" },
      delegatedBy: null,
      squadId: "core-squad",
      finalText: controlResult,
    }),
    outcomeBodies: string[] = [],
    settleContext = workerSettlementContext(
      fixture,
      async (type, _payload = {}, _opId?, _binding?, body?) => {
        if (type === "runtime_session_outcome_observed") outcomeBodies.push(String(body));
        return {};
      },
      controlResult,
    );
  await publishExit(settleContext, runtime, 0);
  assert.deepEqual(outcomeBodies, [controlResult]);
});

test("terminal settlement names the branch when the worker push fails", async (context) => {
  const fixture = workerGitFixture(context, "settle-fail", { reachableRemote: false }),
    runtime = workerSettlementRuntime(fixture, { finalText: "worker delivery" }),
    outcomeBodies: string[] = [],
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") {
        outcomes.push(payload);
        outcomeBodies.push(String(body));
      }
      return {};
    });
  await publishExit(settleContext, runtime, 0);
  assert.equal(outcomeBodies.length, 1);
  assert.match(
    outcomeBodies[0],
    /^worker delivery\n\nWorker branch push failed \(no retry\): codex\/settle-fail @ [0-9a-f]+: .+/u,
  );
  assert.equal(outcomes[0]?.outcome, "succeeded", "a push failure is reported, not turned into a task failure");
});

function active(overrides: Partial<ActiveRuntime>): ActiveRuntime {
  return {
    dispatchId: "dispatch_0123456789abcdef01234567",
    instanceId: "provider-a",
    model: "model-a",
    cancelRequested: false,
    kindId: "codex",
    fallbackAttempt: null,
    permissionMode: "bypass",
    providerFault: null,
    errorOverflowed: false,
    errorBuffer: "",
    toolCallObserved: false,
    failureText: null,
    lossReason: null,
    planIncomplete: false,
    planObserved: true,
    protocolError: false,
    providerOutcome: "succeeded",
    writeItemObserved: true,
    ...overrides,
  } as ActiveRuntime;
}

type WorkerGitFixture = {
  readonly root: string;
  readonly bare: string;
  readonly canonical: string;
  readonly worker: string;
};

function workerGitFixture(
  context: { after(handler: () => void): unknown },
  slug: string,
  options: { readonly reachableRemote: boolean },
): WorkerGitFixture {
  const root = mkdtempSync(path.join(tmpdir(), `ha-settle-${slug}-`)),
    bare = path.join(root, "remote.git"),
    canonical = path.join(root, "project"),
    worker = path.join(root, "worker");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--bare", bare);
  git(root, "init", "-q", "project");
  git(canonical, "config", "user.email", "settle-test@example.invalid");
  git(canonical, "config", "user.name", "Settle Test");
  writeFileSync(path.join(canonical, "README.md"), "fixture\n");
  git(canonical, "add", "README.md");
  git(canonical, "commit", "--quiet", "-m", "fixture");
  git(canonical, "worktree", "add", "--quiet", worker, "-b", `codex/${slug}`);
  writeFileSync(path.join(worker, "change.txt"), "worker\n");
  git(worker, "add", "change.txt");
  git(worker, "commit", "--quiet", "-m", "feat: worker change");
  git(worker, "remote", "add", "origin", options.reachableRemote ? bare : path.join(root, "missing.git"));
  return { root, bare, canonical, worker };
}

function workerSettlementRuntime(fixture: WorkerGitFixture, overrides: Partial<ActiveRuntime>): ActiveRuntime {
  return active({
    process: {
      pid: process.pid,
      onOutput: () => undefined,
      onErrorOutput: () => undefined,
      onExit: () => undefined,
      terminate: () => undefined,
    },
    runtimeSessionId: "runtime-settle-push",
    dispatchOpId: "settle-dispatch-op",
    binding: {
      actor: {
        principal: { kind: "human", id: "operator" },
        executor: { kind: "agent", id: "runtime-session:runtime-settle-push" },
      },
      source: "local",
    },
    task: { taskId: "task-owner", executionId: "execution-owner", leaseVersion: 1 },
    schedule: null,
    cwd: fixture.worker,
    prompt: "settle this result",
    onExitCommand: null,
    reasoningEffort: null,
    fast: false,
    startedAt: "2026-09-14T00:00:00.000Z",
    stream: {
      ref: "runtime-stream:dispatch_0123456789abcdef01234567",
      appendAttemptOutcome: () => undefined,
    } as never,
    buffer: "",
    durableOutputCount: 0,
    stdoutObserved: true,
    providerSessionId: "provider-session",
    resumeProviderSessionId: null,
    finalText: null,
    cancelBinding: null,
    cancelOpId: null,
    toolCallObserved: true,
    ...overrides,
  });
}

function workerSettlementContext(
  fixture: WorkerGitFixture,
  publishRuntimeEvent: (
    type: string,
    payload?: Record<string, unknown>,
    opId?: string,
    binding?: unknown,
    resultBody?: string,
  ) => Promise<unknown>,
  resultText = "worker delivery",
): RuntimeSpawnerContext {
  return {
    exiting: new Set<string>(),
    processes: new Map(),
    input: {
      repoId: "canonical",
      rootDir: fixture.canonical,
      now: () => "2026-09-14T00:01:00.000Z",
      stream: { publish: () => ({}) },
      remote: { archive: async () => ({ outcome: "applied" }) },
    },
    resultMediaType: "text/markdown",
    runtimeResultText: () => resultText,
    markProtocolError: () => undefined,
    settleFallback: async () => undefined,
    prepareWorkerGitEnvironment: async () => ({}),
    publishRuntimeEvent,
  } as unknown as RuntimeSpawnerContext;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}
