// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyRuntimeExit } from "../src/runtime-provider-fault.ts";
import { publishExit } from "../src/runtime-spawn-settlement.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";

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
      publishRuntimeEvent: async (type: string) => {
        published.push(type);
        return {};
      },
      settleFallback: async () => undefined,
    } as unknown as RuntimeSpawnerContext;
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  try {
    await publishExit(context, runtime, 1);
    assert.match(errors.join("\n"), /could not be archived: archive publication failed/u);
    assert.deepEqual(published, ["runtime_session_exited", "runtime_session_outcome_observed"]);
  } finally {
    console.error = originalError;
    rmSync(rootDir, { recursive: true, force: true });
  }
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
