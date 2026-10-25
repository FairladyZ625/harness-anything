// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyRuntimeExit } from "../src/runtime-provider-fault.ts";
import { failed } from "../src/repo-cell-settlement.ts";
import { runtimeMissionName } from "../src/runtime-spawn-mission.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import { publishExit, runtimeResultText } from "../src/runtime-spawn-settlement.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { ActiveRuntime, RuntimeAttemptTerminal } from "../src/runtime-spawn-types.ts";
import { active, tasklessSettlementRuntime } from "./runtime-spawn-settlement.fixtures.ts";

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

test("exit zero without a declared delivery witness is stopped when the worker reported a final message", () => {
  const result = classifyRuntimeExit(active({ protocolError: true, finalText: "stopped at checkpoint" }), 0);
  assert.equal(result.outcome, "stopped");
});

test("exit zero without final output is unknown even when write or plan heuristics are present", () => {
  const result = classifyRuntimeExit(active({ writeItemObserved: false, planObserved: false }), 0);
  assert.equal(result.outcome, "unknown");
});

test("exit zero without final output remains unknown despite an internal plan heuristic", () => {
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

test("reviewer exit on superseded cut settles as superseded instead of failed", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-reviewer-superseded-"));
  try {
    const terminals: RuntimeAttemptTerminal[] = [];
    const taskId = "task-reviewer-superseded";
    const executionId = "exec-reviewer-superseded-r1";
    const replacementId = "exec-reviewer-superseded-r2";
    const runtimeSessionId = "runtime-reviewer-superseded";
    const stream = openDispatchStream(rootDir, {
      dispatchId: "dispatch_0123456789abcdef01234567",
      startedAt: "2026-10-22T00:00:00.000Z",
    });
    const runtime = active({
      process: {
        pid: process.pid,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      },
      runtimeSessionId,
      dispatchOpId: "dispatch-op-reviewer-superseded",
      binding: {
        actor: {
          principal: { kind: "human", id: "operator" } as never,
          executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
        },
        source: "local" as const,
      },
      task: { taskId, executionId, leaseVersion: 1 },
      role: "reviewer",
      cwd: rootDir,
      stream,
      finalText: "Review finished but registration was rejected as superseded",
      cancelBinding: null,
      cancelOpId: null,
    });
    const outcomes: Record<string, unknown>[] = [];
    const snapshot = {
      task: { iteration: 1 },
      executions: [
        { executionId, iteration: 0, state: "returned", submission: { commitSha: "sha1" } },
        { executionId: replacementId, iteration: 1, state: "submitted", submission: { commitSha: "sha2" } },
      ],
      reviews: [],
    };
    const context = {
      exiting: new Set<string>(),
      processes: new Map([[runtime.runtimeSessionId, runtime]]),
      input: {
        repoId: "canonical",
        rootDir,
        now: () => "2026-10-22T00:01:00.000Z",
        stream: { publish: () => ({}) },
        remote: {
          archive: async () => ({ outcome: "applied" }),
        },
        projection: {
          read: (id: string) => (id === taskId ? { snapshot, packagePath: "harness/tasks/task-test" } : null),
        },
      },
      requiredRuntimeProjection: (input: { readonly projection: unknown }) => input.projection,
      resultMediaType: "text/markdown",
      runtimeResultText: () => "Review output",
      markProtocolError: () => undefined,
      publishRuntimeEvent: async (type: string, payload: Record<string, unknown>) => {
        if (type === "runtime_session_outcome_observed") outcomes.push(payload);
        return {};
      },
      settleFallback: async (_activeRuntime: unknown, _attemptOutcome: unknown, terminal: RuntimeAttemptTerminal) => {
        terminals.push(terminal);
      },
    } as unknown as RuntimeSpawnerContext;

    await publishExit(context, runtime, 0);

    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.outcome, "superseded");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.outcome, "stopped");
    assert.equal(outcomes[0]?.reasonCode, "review_cut_superseded");
    assert.match(String((outcomes[0]?.attempt as { readonly reason?: string })?.reason), /superseded/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("settlement reclaims the run's per-instance temp directory", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-settlement-temp-reclaim-"));
  try {
    const reclaimed: readonly [string, string][] = [],
      runtime = tasklessSettlementRuntime(rootDir, "temp reclaimed"),
      context = {
        exiting: new Set<string>(),
        processes: new Map([[runtime.runtimeSessionId, runtime]]),
        input: {
          repoId: "canonical",
          rootDir,
          now: () => "2026-10-11T00:01:00.000Z",
          stream: { publish: () => ({}) },
          remote: { archive: async () => ({ outcome: "applied" }) },
          reclaimRuntimeTempDirectory: (instanceId: string, runtimeSessionId: string) => {
            reclaimed.push([instanceId, runtimeSessionId]);
            return null;
          },
        },
        resultMediaType: "text/markdown",
        runtimeResultText: () => "temp reclaimed",
        markProtocolError: () => undefined,
        publishRuntimeEvent: async () => ({}),
        settleFallback: async () => undefined,
      } as unknown as RuntimeSpawnerContext;
    await publishExit(context, runtime, 0);
    assert.deepEqual(reclaimed, [["provider-a", runtime.runtimeSessionId]]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a temp reclaim failure is carried into the terminal body, not swallowed", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-settlement-temp-reclaim-failed-"));
  try {
    const runtime = tasklessSettlementRuntime(rootDir, "reclaim refused"),
      outcomeBodies: string[] = [],
      context = {
        exiting: new Set<string>(),
        processes: new Map([[runtime.runtimeSessionId, runtime]]),
        input: {
          repoId: "canonical",
          rootDir,
          now: () => "2026-10-11T00:01:00.000Z",
          stream: { publish: () => ({}) },
          remote: { archive: async () => ({ outcome: "applied" }) },
          reclaimRuntimeTempDirectory: () => new Error("EBUSY: resource busy or locked"),
        },
        resultMediaType: "text/markdown",
        runtimeResultText: () => "reclaim refused",
        markProtocolError: () => undefined,
        publishRuntimeEvent: async (
          _type: string,
          payload: Record<string, unknown>,
          _opId: string,
          _binding: unknown,
          body?: string,
        ) => {
          if (body !== undefined && payload.resultRef !== undefined) outcomeBodies.push(body);
          return {};
        },
        settleFallback: async () => undefined,
      } as unknown as RuntimeSpawnerContext;
    await publishExit(context, runtime, 0);
    assert.equal(
      outcomeBodies.some((body) => /Per-run temp directory reclaim failed: EBUSY: resource busy or locked/u.test(body)),
      true,
      `terminal bodies: ${JSON.stringify(outcomeBodies)}`,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("settlement keeps the cache-write counter out of the kernel event metrics copy", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-settlement-metrics-copy-"));
  try {
    const outcomes: Record<string, unknown>[] = [],
      metricsRecords: Record<string, unknown>[] = [],
      runtime = {
        ...tasklessSettlementRuntime(rootDir, "counters settle"),
        inputTokens: 110,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        outputTokens: 25,
        toolCallCount: 1,
        usageReported: true,
        compacted: false,
        rawUsage: { cache_creation_input_tokens: 10 },
        stream: {
          ref: "runtime-stream:dispatch-settlement-metrics-copy",
          appendAttemptOutcome: () => undefined,
          appendTerminalOutcome: () => undefined,
          appendRuntimeMetrics: (record: Record<string, unknown>) => metricsRecords.push(record),
        } as never,
      } as ActiveRuntime,
      context = {
        exiting: new Set<string>(),
        processes: new Map([[runtime.runtimeSessionId, runtime]]),
        input: {
          repoId: "canonical",
          rootDir,
          now: () => "2026-10-10T00:01:00.000Z",
          stream: { publish: () => ({}) },
          remote: { archive: async () => ({ outcome: "applied" }) },
        },
        resultMediaType: "text/markdown",
        runtimeResultText: () => "counters settle",
        markProtocolError: () => undefined,
        publishRuntimeEvent: async (type: string, payload: Record<string, unknown>) => {
          if (type === "runtime_session_outcome_observed") outcomes.push(payload);
          return {};
        },
        settleFallback: async () => undefined,
      } as unknown as RuntimeSpawnerContext;
    await publishExit(context, runtime, 0);
    // The kernel event whitelist (validRuntimeDispatchMetrics) pins the payload copy to the
    // three-count shape; the separate cache-write counter travels only in the stream records
    // that the token usage read side prices.
    assert.deepEqual(Object.keys(outcomes[0]?.runtimeMetrics ?? {}).sort(), [
      "cacheReadTokens",
      "inputTokens",
      "outputTokens",
      "toolCallCount",
      "totalTokens",
      "usageUnavailable",
    ]);
    assert.deepEqual(metricsRecords[0], {
      inputTokens: 110,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      outputTokens: 25,
      totalTokens: 135,
      toolCallCount: 1,
      usageUnavailable: false,
      compacted: false,
      raw: { cache_creation_input_tokens: 10 },
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a read-only task attach requires its dispatch report, while a reviewer still requires registration", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-read-only-report-witness-"));
  try {
    for (const sample of [
      { report: true, role: null, expected: "succeeded" },
      { report: false, role: null, expected: "stopped" },
      { report: true, role: "reviewer", expected: "failed" },
    ] as const) {
      const outcomes: Record<string, unknown>[] = [],
        runtime = {
          ...tasklessSettlementRuntime(rootDir, "scan report"),
          task: { taskId: "task-read-only-scan", executionId: "exe-read-only-scan" },
          permissionMode: "read-only",
          role: sample.role,
          finalText: "scan report",
        } as ActiveRuntime,
        context = {
          exiting: new Set<string>(),
          processes: new Map([[runtime.runtimeSessionId, runtime]]),
          input: {
            repoId: "canonical",
            rootDir,
            now: () => "2026-10-07T00:01:00.000Z",
            stream: { publish: () => ({}) },
            projection: true,
            remote: { archive: async () => ({ outcome: "applied" }) },
          },
          requiredRuntimeStore: () => ({ readEvent: () => null }),
          requiredRuntimeProjection: () => ({
            read: () => ({
              packagePath: "tasks/task-read-only-scan",
              snapshot: { executions: [], reviews: [] },
            }),
            readDocument: (documentPath: string) => ({
              document:
                sample.report && documentPath.endsWith("/artifacts/reports/dispatch_0123456789abcdef01234567.md")
                  ? { path: documentPath }
                  : null,
            }),
          }),
          resultMediaType: "text/markdown",
          runtimeResultText: () => "scan report",
          markProtocolError: () => undefined,
          publishRuntimeEvent: async (type: string, payload: Record<string, unknown>) => {
            if (type === "runtime_session_outcome_observed") outcomes.push(payload);
            return {};
          },
          settleFallback: async () => undefined,
        } as unknown as RuntimeSpawnerContext;
      await publishExit(context, runtime, 0);
      assert.equal(outcomes[0]?.outcome, sample.expected, JSON.stringify(sample));
      if (sample.role === "reviewer") {
        assert.equal(outcomes[0]?.reasonCode, "review_result_missing");
        assert.match(
          String((outcomes[0]?.attempt as { readonly reason?: string })?.reason),
          /review-.*was not registered/u,
        );
      }
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
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
      // decision/dec_FCD38D503B0C0752B83A417246/CH2: explicit service fault, not arbitrary stderr.
      providerFault: {
        code: "server_error",
        reason:
          "PROVIDER-STDERR-FIRST-LINE diagnostic\nPROVIDER-STDERR-RAW-SECOND-LINE\nPROVIDER-STDERR-RAW-THIRD-LINE",
      },
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

test("a taskless squad leader result is stopped without a delivery witness", () => {
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
  assert.equal(result.outcome, "stopped");
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

for (const cancelled of [false, true])
  test(`remote reviewer archive failure releases resources and publishes ${cancelled ? "cancelled" : "failed"}`, async () => {
    let released = false;
    const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-archive-failure-")),
      runtime = active({
        role: "reviewer",
        cancelRequested: cancelled,
        process: {
          release: () => {
            released = true;
          },
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
        requiredRuntimeProjection: () => {
          throw new Error("remote edge has no projection");
        },
      } as unknown as RuntimeSpawnerContext;
    console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
    try {
      await publishExit(context, runtime, 1);
      assert.match(errors.join("\n"), /could not be archived: archive publication failed/u);
      assert.deepEqual(published, [
        ...(cancelled ? ["runtime_session_cancelled"] : []),
        "runtime_session_exited",
        "runtime_session_outcome_observed",
      ]);
      assert.equal(outcomes[0]?.outcome, cancelled ? "cancelled" : "failed");
      assert.equal(released, true);
      assert.equal(context.processes.size, 0);
      assert.equal(context.exiting.size, 0);
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
