// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeDispatchProjectionRow } from "@harness-anything/kernel";
import { archiveDispatchStream, openDispatchStream } from "../src/dispatch-stream.ts";
import { parseDaemonRpcParams } from "../src/protocol/daemon-protocol.contract.ts";
import { validAgentRuntimeAttemptChain } from "../src/runtime-attempt-contract.ts";
import { admitRuntimeResume, runtimeResumeAdmission } from "../src/runtime-resume-admission.ts";

test("GUI resume spawn uses the dispatchId route", () => {
  const params = {
    repo: { repoId: "canonical" },
    payload: { dispatchId: "dispatch_0123456789abcdef01234567", idempotencyKey: "resume-from-gui" },
  };
  assert.equal(parseDaemonRpcParams("repo.agentRuntime.spawn", params).ok, true);
});

test("resume admission distinguishes resumable, missing-session, and already-resumed dispatches", () => {
  const base = {
    dispatchId: "dispatch_0123456789abcdef01234567",
    agentId: "terra",
    resumedDispatches: new Map<string, string>(),
  } as const;
  assert.deepEqual(runtimeResumeAdmission({ ...base, providerSessionId: "provider-session" }), {
    resumable: true,
    dispatchId: base.dispatchId,
    agentId: "terra",
  });
  assert.deepEqual(runtimeResumeAdmission({ ...base, providerSessionId: null }), {
    resumable: false,
    reason: "missing_provider_session",
  });
  assert.deepEqual(
    runtimeResumeAdmission({
      ...base,
      providerSessionId: "provider-session",
      resumedDispatches: new Map([[base.dispatchId, "dispatch_fedcba987654321001234567"]]),
    }),
    { resumable: false, reason: "already_resumed", resumedDispatchId: "dispatch_fedcba987654321001234567" },
  );
});

test("an archived resume source is rejected when the canonical projection records its prior resume", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-resume-archive-")),
    dispatchId = "dispatch_0123456789abcdef01234567",
    resumedDispatchId = "dispatch_fedcba987654321001234567";
  try {
    const writer = openDispatchStream(rootDir, {
      dispatchId,
      taskId: "task-resume",
      executionId: "execution-resume",
      runtimeSessionId: "runtime-resume-source",
      instanceId: "instance-1",
      agentId: "sol",
      startedAt: "2026-09-29T00:00:00.000Z",
    });
    writer.appendProviderBinding("provider-session", "2026-09-29T00:00:01.000Z");
    archiveDispatchStream(rootDir, dispatchId);

    assert.throws(
      () =>
        admitRuntimeResume(rootDir, dispatchId, () => ({
          readRuntimeDispatchByResumeSource: () =>
            ({
              event: { payload: { dispatchId: resumedDispatchId, resumedFromDispatchId: dispatchId } },
            }) as unknown as RuntimeDispatchProjectionRow,
        })),
      (error: unknown) =>
        error instanceof Error &&
        error.message === `Dispatch ${dispatchId} was already resumed as ${resumedDispatchId}.`,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime session attempt chains accept the canonical dispatch resume projection", () => {
  const attempt = {
    dispatchId: "dispatch_0123456789abcdef01234567",
    runtimeSessionId: "runtime-session",
    attemptIndex: 0,
    provider: { instance: "builder", model: "gpt-5" },
    classification: "provider_quota",
    reason: "quota exhausted",
    resume: { dispatchId: "dispatch_0123456789abcdef01234567", agentId: "sol" },
    fallbackState: null,
    nextDispatchId: null,
  };
  assert.equal(validAgentRuntimeAttemptChain({ attemptGroupId: attempt.dispatchId, attempts: [attempt] }), true);
  assert.equal(
    validAgentRuntimeAttemptChain({
      attemptGroupId: attempt.dispatchId,
      attempts: [{ ...attempt, undeclared: true }],
    }),
    false,
  );
});
