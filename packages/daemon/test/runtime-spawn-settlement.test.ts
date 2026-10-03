// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyRuntimeExit } from "../src/runtime-provider-fault.ts";
import { failed } from "../src/repo-cell-settlement.ts";
import { runtimeMissionName } from "../src/runtime-spawn-mission.ts";
import { scheduleMissionWithOutcomeProtocol, scheduleOutcomeFromRuntime } from "../src/schedule-runtime-outcome.ts";
import { publishExit, runtimeResultText } from "../src/runtime-spawn-settlement.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";

const fixtureTaskId = "task_0123456789abcdef01234567";

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

test("exit zero without a declared delivery witness is unknown", () => {
  const result = classifyRuntimeExit(active({ protocolError: true }), 0);
  assert.equal(result.outcome, "unknown");
});

test("exit zero is not promoted by write or plan heuristics", () => {
  const result = classifyRuntimeExit(active({ writeItemObserved: false, planObserved: false }), 0);
  assert.equal(result.outcome, "unknown");
});

test("exit zero does not turn an internal plan heuristic into an unknown outcome", () => {
  assert.equal(
    classifyRuntimeExit(active({ writeItemObserved: true, planObserved: true, planIncomplete: true }), 0).outcome,
    "unknown",
  );
});

test("taskless settlement requires the provider's completed turn and final result", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-taskless-witness-"));
  try {
    for (const sample of [
      { finalText: "completed result", expected: "succeeded" },
      { finalText: null, expected: "unknown" },
    ] as const) {
      const outcomes: Record<string, unknown>[] = [],
        runtime = tasklessSettlementRuntime(rootDir, sample.finalText),
        context = {
          exiting: new Set<string>(),
          processes: new Map([[runtime.runtimeSessionId, runtime]]),
          input: {
            repoId: "canonical",
            rootDir,
            now: () => "2026-09-29T00:01:00.000Z",
            stream: { publish: () => ({}) },
            remote: { archive: async () => ({ outcome: "applied" }) },
          },
          resultMediaType: "text/markdown",
          runtimeResultText: () => sample.finalText ?? "",
          markProtocolError: () => undefined,
          publishRuntimeEvent: async (type: string, payload: Record<string, unknown>) => {
            if (type === "runtime_session_outcome_observed") outcomes.push(payload);
            return {};
          },
          settleFallback: async () => undefined,
        } as unknown as RuntimeSpawnerContext;
      await publishExit(context, runtime, 0);
      assert.equal(outcomes[0]?.outcome, sample.expected);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
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

test("a failed attempt persists a one-line reason that references the dispatch stream diagnostics", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-settlement-reason-")),
    outcomes: Record<string, unknown>[] = [],
    runtime = active({
      process: {
        pid: 111,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      },
      runtimeSessionId: "runtime-settlement-reason",
      dispatchOpId: "reason-dispatch-op",
      binding: {
        actor: {
          principal: { kind: "human", id: "operator" },
          executor: { kind: "agent", id: "runtime-session:runtime-settlement-reason" },
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
        ref: "file:.harness/runtime/dispatches/dispatch_0123456789abcdef01234567.jsonl",
        appendAttemptOutcome: (value) => outcomes.push(value),
        appendTerminalOutcome: () => undefined,
      } as never,
      buffer: "",
      durableOutputCount: 0,
      stdoutObserved: true,
      providerSessionId: "provider-session",
      resumeProviderSessionId: null,
      finalText: null,
      cancelBinding: null,
      cancelOpId: null,
      errorBuffer:
        "PROVIDER-STDERR-FIRST-LINE diagnostic\nPROVIDER-STDERR-RAW-SECOND-LINE\nPROVIDER-STDERR-RAW-THIRD-LINE",
    }),
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
      runtimeResultText: () => "failed result",
      markProtocolError: () => undefined,
      publishRuntimeEvent: async () => ({}),
      settleFallback: async () => undefined,
    } as unknown as RuntimeSpawnerContext;
  try {
    await publishExit(context, runtime, 1);
    const outcome = outcomes[0] as { readonly classification: string; readonly reason: string };
    assert.equal(outcome.classification, "provider_fault");
    assert.equal(outcome.reason.includes("\n"), false, JSON.stringify(outcome.reason));
    assert.match(outcome.reason, /^PROVIDER-STDERR-FIRST-LINE diagnostic/u);
    assert.match(outcome.reason, /full diagnostics: file:\.harness\/runtime\/dispatches\//u);
    assert.doesNotMatch(outcome.reason, /PROVIDER-STDERR-RAW-SECOND-LINE/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime result text bounds provider failure diagnostics to one line plus the stream reference", () => {
  const failed_ = active({
      stream: { ref: "file:.harness/runtime/dispatches/dispatch_0123456789abcdef01234567.jsonl" } as never,
      errorBuffer:
        "PROVIDER-STDERR-FIRST-LINE diagnostic\nPROVIDER-STDERR-RAW-SECOND-LINE\nPROVIDER-STDERR-RAW-THIRD-LINE",
      failureText: null,
    }),
    text = runtimeResultText({} as never, failed_, 1, "failed");
  assert.match(text, /^Provider exited with code 1\. PROVIDER-STDERR-FIRST-LINE diagnostic/u);
  assert.match(text, /full stderr: file:\.harness\/runtime\/dispatches\//u);
  assert.doesNotMatch(text, /PROVIDER-STDERR-RAW-SECOND-LINE/u);
});

test("runtime result text caps provider frame failure text", () => {
  const failed_ = active({
      stream: { ref: "file:.harness/runtime/dispatches/dispatch_0123456789abcdef01234567.jsonl" } as never,
      errorBuffer: "",
      failureText: "F".repeat(5000),
    }),
    text = runtimeResultText({} as never, failed_, 1, "failed");
  assert.ok(text.length <= 1200, String(text.length));
});

test("a taskless squad leader result is not a delivery witness", () => {
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
  assert.equal(result.outcome, "unknown");
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
        appendTerminalOutcome: () => undefined,
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
      requiredRuntimeProjection: () => deliveryProjection(null),
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
        appendTerminalOutcome: () => undefined,
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
    expectedBody = `worker delivery\n\nWorker branch pushed at settlement: ${fixtureTaskId} @ ${head}`;
  assert.deepEqual(outcomeBodies, [expectedBody]);
  assert.equal(outcomes[0]?.outcome, "succeeded");
  assert.equal(
    outcomes[0]?.resultRef,
    `artifact:runtime-result/sha256/${createHash("sha256").update(expectedBody).digest("hex")}`,
    "the push line must be inside the durable terminal result the CEO reads",
  );
  assert.ok(git(fixture.bare, "show-ref", "--verify", `refs/heads/${fixtureTaskId}`).trim().startsWith(`${head} `));
});

test("terminal settlement publishes the submitted commit when worker HEAD advances", async (context) => {
  const fixture = workerGitFixture(context, "settle-submission", { reachableRemote: true }),
    submittedCommitSha = git(fixture.worker, "rev-parse", "HEAD").trim();
  git(fixture.worker, "commit", "--allow-empty", "--quiet", "-m", "feat: post-submission change");
  const head = git(fixture.worker, "rev-parse", "HEAD").trim(),
    runtime = workerSettlementRuntime(fixture, { finalText: "worker delivery" }),
    outcomeBodies: string[] = [],
    settleContext = workerSettlementContext(
      fixture,
      async (type, _payload = {}, _opId?, _binding?, body?) => {
        if (type === "runtime_session_outcome_observed") outcomeBodies.push(String(body));
        return {};
      },
      "worker delivery",
      submittedCommitSha,
    );
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () => deliveryProjection(submittedCommitSha, "repository-diff", [], [], true),
    },
    runtime,
    0,
  );
  assert.deepEqual(outcomeBodies, [
    `worker delivery\n\nWorker branch pushed at settlement: ${fixtureTaskId} @ ${submittedCommitSha} (worker HEAD ${head})`,
  ]);
  assert.doesNotMatch(outcomeBodies[0]!, /is not submitted/u);
  assert.equal(git(fixture.bare, "rev-parse", `refs/heads/${fixtureTaskId}`).trim(), submittedCommitSha);
});

test("an edge settlement, which holds no projection, publishes the worker branch head", async (context) => {
  const fixture = workerGitFixture(context, "settle-edge", { reachableRemote: true }),
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
  await publishExit(
    {
      ...settleContext,
      input: { ...settleContext.input, projection: undefined },
      // What a remote-edge spawner's projection read does: it has none.
      requiredRuntimeProjection: () => {
        throw Object.assign(new Error("Local runtime projection is unavailable."), {
          code: "runtime_preconditions_unavailable",
        });
      },
    },
    runtime,
    0,
  );
  const head = git(fixture.worker, "rev-parse", "HEAD").trim();
  assert.deepEqual(outcomeBodies, [
    `worker delivery\n\nWorker branch pushed at settlement: ${fixtureTaskId} @ ${head}`,
  ]);
  assert.equal(outcomes[0]?.outcome, "succeeded");
  assert.equal(git(fixture.bare, "rev-parse", `refs/heads/${fixtureTaskId}`).trim(), head);
});

test("terminal settlement tells the owner when a delivered closeout is not submitted", async (context) => {
  const fixture = workerGitFixture(context, "settle-unsubmitted-closeout", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, { finalText: "worker delivery" }),
    outcomeBodies: string[] = [],
    settleContext = workerSettlementContext(fixture, async (type, _payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") outcomeBodies.push(String(body));
      return {};
    });
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () => deliveryProjection(null, "repository-diff", [], [], true),
    },
    runtime,
    0,
  );
  assert.match(outcomeBodies[0]!, /Task task_0123456789abcdef01234567 is not submitted/u);
  assert.match(outcomeBodies[0]!, /ha task submit task_0123456789abcdef01234567 --as-owner/u);
});

test("terminal settlement keeps a clean task exit unknown without its execution delivery", async (context) => {
  const fixture = workerGitFixture(context, "settle-no-delivery", { reachableRemote: true, delivery: false }),
    runtime = workerSettlementRuntime(fixture, { finalText: "worker stopped" }),
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}) => {
      if (type === "runtime_session_outcome_observed") outcomes.push(payload);
      return {};
    });
  await publishExit({ ...settleContext, requiredRuntimeProjection: () => deliveryProjection(null) }, runtime, 0);
  assert.equal(outcomes[0]?.outcome, "unknown");
  assert.equal(git(fixture.bare, "for-each-ref", "--format=%(refname)", `refs/heads/${fixtureTaskId}`), "");
});

test("terminal settlement accepts a center-accepted task-package artifact", async (context) => {
  const fixture = workerGitFixture(context, "settle-artifact-delivery", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, { finalText: "artifact delivered", publicationOwner: "commander" }),
    outcomes: Record<string, unknown>[] = [],
    outcomeBodies: string[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") {
        outcomes.push(payload);
        outcomeBodies.push(String(body));
      }
      return {};
    });
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () =>
        deliveryProjection(
          null,
          "task-package-artifact",
          [{ path: "artifacts/report.md", revision: 42, blobSha256: "a".repeat(64) }],
          [],
          true,
        ),
    },
    runtime,
    0,
  );
  assert.equal(outcomes[0]?.outcome, "succeeded");
  assert.doesNotMatch(outcomeBodies[0]!, /is not submitted/u);
});

test("terminal settlement accepts a review registered for the dispatch role", async (context) => {
  const fixture = workerGitFixture(context, "settle-review-delivery", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      finalText: "review registered",
      publicationOwner: "commander",
      role: "reviewer",
    }),
    outcomes: Record<string, unknown>[] = [],
    outcomeBodies: string[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") {
        outcomes.push(payload);
        outcomeBodies.push(String(body));
      }
      return {};
    });
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () =>
        deliveryProjection(null, "repository-diff", [], [{ reviewId: `review-${runtime.dispatchId}` }], true),
    },
    runtime,
    0,
  );
  assert.equal(outcomes[0]?.outcome, "succeeded");
  assert.doesNotMatch(outcomeBodies[0]!, /is not submitted/u);
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

test("commander-owned settlement keeps its commit local and reports an unsubmitted delivery", async (context) => {
  const fixture = workerGitFixture(context, "squad-child", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      agent: { id: "terra", name: "Terra" },
      delegatedBy: { id: "fable", name: "Fable" },
      squadId: "core-squad",
      finalText: "worker delivery",
      publicationOwner: "commander",
    }),
    outcomeBodies: string[] = [],
    outcomes: Record<string, unknown>[] = [],
    settleContext = workerSettlementContext(fixture, async (type, payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") {
        outcomes.push(payload);
        outcomeBodies.push(String(body));
      }
      return {};
    });
  let credentialRequests = 0;
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () => deliveryProjection(null, "repository-diff", [], [], true),
      prepareWorkerGitEnvironment: async () => {
        credentialRequests += 1;
        return {};
      },
    },
    runtime,
    0,
  );
  assert.equal(outcomes[0]?.outcome, "succeeded");
  assert.match(outcomeBodies[0]!, /Task task_0123456789abcdef01234567 is not submitted/u);
  assert.match(outcomeBodies[0]!, /ha task submit task_0123456789abcdef01234567 --as-owner/u);
  assert.equal(credentialRequests, 0);
  assert.equal(git(fixture.bare, "for-each-ref", "--format=%(refname)", `refs/heads/${fixtureTaskId}`), "");
  assert.equal(git(fixture.worker, "log", "-1", "--format=%s").trim(), "feat: worker change");
});

test("commander-owned settlement without a local commit does not report a delivery", async (context) => {
  const fixture = workerGitFixture(context, "squad-child-no-delivery", { reachableRemote: true, delivery: false }),
    runtime = workerSettlementRuntime(fixture, {
      agent: { id: "terra", name: "Terra" },
      delegatedBy: { id: "fable", name: "Fable" },
      squadId: "core-squad",
      finalText: "worker stopped",
      publicationOwner: "commander",
    }),
    outcomeBodies: string[] = [],
    settleContext = workerSettlementContext(fixture, async (type, _payload = {}, _opId?, _binding?, body?) => {
      if (type === "runtime_session_outcome_observed") outcomeBodies.push(String(body));
      return {};
    });
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () => deliveryProjection(null, "repository-diff", [], [], true),
    },
    runtime,
    0,
  );
  assert.doesNotMatch(outcomeBodies[0]!, /is not submitted/u);
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
    new RegExp(`^worker delivery\\n\\nWorker branch push failed \\(no retry\\): ${fixtureTaskId} @ [0-9a-f]+: .+`, "u"),
  );
  assert.equal(outcomes[0]?.outcome, "succeeded", "a push failure is reported, not turned into a task failure");
});

test("terminal settlement refuses to publish a worker commit outside the conventional identity", async (context) => {
  const fixture = workerGitFixture(context, "settle-identity", { reachableRemote: true }),
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
  git(
    fixture.worker,
    "-c",
    "user.name=Stale Worker",
    "-c",
    "user.email=stale-worker@example.invalid",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "feat: stale worker change",
  );
  const staleHead = git(fixture.worker, "rev-parse", "HEAD").trim();
  await publishExit(settleContext, runtime, 0);
  assert.equal(outcomeBodies.length, 1);
  assert.match(
    outcomeBodies[0],
    new RegExp(
      `^worker delivery\\n\\nWorker branch push failed \\(no retry\\): ` +
        `${fixtureTaskId} @ ${staleHead}: commit ${staleHead} carries author ` +
        "<stale-worker@example.invalid> and committer <stale-worker@example.invalid>, " +
        "not the conventional identity <settle-test@example.invalid>",
      "u",
    ),
  );
  assert.equal(outcomes[0]?.outcome, "succeeded", "an identity refusal is reported, not turned into a task failure");
  assert.notEqual(
    spawnSync("git", ["-C", fixture.bare, "show-ref", "--verify", "--quiet", `refs/heads/${fixtureTaskId}`]).status,
    0,
    "the settlement refusal leaves the branch unpublished",
  );
});

function active(overrides: Partial<ActiveRuntime>): ActiveRuntime {
  return {
    dispatchId: "dispatch_0123456789abcdef01234567",
    instanceId: "provider-a",
    model: "model-a",
    cancelRequested: false,
    kindId: "codex",
    publicationOwner: "runtime",
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

function tasklessSettlementRuntime(rootDir: string, finalText: string | null): ActiveRuntime {
  return active({
    process: {
      pid: process.pid,
      onOutput: () => undefined,
      onErrorOutput: () => undefined,
      onExit: () => undefined,
      terminate: () => undefined,
    },
    runtimeSessionId: `runtime-taskless-${finalText === null ? "missing" : "complete"}`,
    dispatchOpId: `dispatch-taskless-${finalText === null ? "missing" : "complete"}`,
    binding: {
      actor: {
        principal: { kind: "human", id: "operator" },
        executor: { kind: "agent", id: "runtime-session:runtime-taskless" },
      },
      source: "local",
    },
    task: null,
    schedule: null,
    squadId: null,
    delegatedBy: null,
    cwd: rootDir,
    prompt: "settle taskless result",
    onExitCommand: null,
    reasoningEffort: null,
    fast: false,
    startedAt: "2026-09-29T00:00:00.000Z",
    stream: {
      ref: "runtime-stream:dispatch-taskless",
      appendAttemptOutcome: () => undefined,
      appendTerminalOutcome: () => undefined,
    } as never,
    buffer: "",
    durableOutputCount: 0,
    stdoutObserved: true,
    providerSessionId: "provider-session",
    resumeProviderSessionId: null,
    finalText,
    cancelBinding: null,
    cancelOpId: null,
  });
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
  options: { readonly reachableRemote: boolean; readonly delivery?: boolean },
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
  git(canonical, "remote", "add", "origin", bare);
  git(canonical, "push", "--quiet", "origin", "HEAD:main");
  if (!options.reachableRemote) git(canonical, "remote", "set-url", "origin", path.join(root, "missing.git"));
  // Settlement publishes the branch named after the dispatched task.
  git(canonical, "worktree", "add", "--quiet", worker, "-b", fixtureTaskId);
  if (options.delivery !== false) {
    writeFileSync(path.join(worker, "change.txt"), "worker\n");
    git(worker, "add", "change.txt");
    git(worker, "commit", "--quiet", "-m", "feat: worker change");
  }
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
    task: { taskId: fixtureTaskId, executionId: "execution-owner", leaseVersion: 1 },
    schedule: null,
    squadId: null,
    delegatedBy: null,
    cwd: fixture.worker,
    prompt: "settle this result",
    onExitCommand: null,
    reasoningEffort: null,
    fast: false,
    startedAt: "2026-09-14T00:00:00.000Z",
    stream: {
      ref: "runtime-stream:dispatch_0123456789abcdef01234567",
      appendAttemptOutcome: () => undefined,
      appendTerminalOutcome: () => undefined,
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
  submittedCommitSha?: string,
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
      // This node holds a projection; `requiredRuntimeProjection` below is the read every test steers.
      projection: () => deliveryProjection(null),
    },
    resultMediaType: "text/markdown",
    runtimeResultText: () => resultText,
    markProtocolError: () => undefined,
    settleFallback: async () => undefined,
    prepareWorkerGitEnvironment: async () => ({}),
    requiredRuntimeProjection: () =>
      deliveryProjection(submittedCommitSha ?? git(fixture.worker, "rev-parse", "HEAD").trim()),
    publishRuntimeEvent,
  } as unknown as RuntimeSpawnerContext;
}

function deliveryProjection(
  commitSha: string | null,
  outputShape = "repository-diff",
  artifacts: readonly Record<string, unknown>[] = [],
  reviews: readonly Record<string, unknown>[] = [],
  closeoutRecorded = false,
) {
  return {
    read: () => ({
      packagePath: "tasks/task_0123456789abcdef01234567-fixture",
      snapshot: {
        task: { presetSnapshotDigest: "sha256:preset" },
        reviews,
        executions: [
          {
            executionId: "execution-owner",
            submission: commitSha === null && artifacts.length === 0 ? null : { commitSha, artifacts },
          },
        ],
      },
    }),
    readDocument: (documentPath: string) => ({
      document:
        closeoutRecorded && documentPath.endsWith("/closeout.md")
          ? { path: documentPath, body: "## Summary\nDelivered.\n" }
          : null,
    }),
    readPresetSnapshot: () => ({ snapshot: { profile: { outputShape } } }),
  } as never;
}

function git(root: string, ...args: string[]): string {
  // Fixture pushes to main are harness-side git, not a task-bound worker push the wrapper
  // refuses. A task-bound host injects GIT_AUTHOR_*/GIT_COMMITTER_* and its own git config;
  // env beats both repo config and -c flags, so the fixture must not inherit either.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
  for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"])
    delete env[name];
  delete env.HARNESS_TASK_BOUND;
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env });
}
