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
    payload: { dispatchId: "dispatch_0123456789abcdef01234567", dispatchKey: "resume-from-gui" },
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

test("Codex and ACP runtime declarations admit resuming their provider session through the shared route", () => {
  for (const kindId of ["codex", "codex-acp"] as const)
    assert.deepEqual(
      runtimeResumeAdmission({
        dispatchId: "dispatch_0123456789abcdef01234567",
        agentId: "sol",
        kindId,
        providerSessionId: "provider-session",
        resumedDispatches: new Map(),
      }),
      { resumable: true, dispatchId: "dispatch_0123456789abcdef01234567", agentId: "sol" },
    );
});

test("resume admission accepts deepseek-harness now that resume is a family-level acp declaration", () => {
  assert.deepEqual(
    runtimeResumeAdmission({
      dispatchId: "dispatch_0123456789abcdef01234567",
      agentId: null,
      kindId: "deepseek-harness",
      providerSessionId: "provider-session",
      resumedDispatches: new Map(),
    }),
    { resumable: true, dispatchId: "dispatch_0123456789abcdef01234567", agentId: null },
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

    // Task-bound resumes keep the single-consumption contract; the chain-following test below
    // covers the taskless conversation surface.
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

test("resuming a conversation follows its resume chain to the current leaf", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-resume-chain-")),
    first = "dispatch_0123456789abcdef01234567",
    second = "dispatch_0123456789abcdef99999999",
    third = "dispatch_0123456789abcdef88888888";
  try {
    for (const [dispatchId, resumedFrom] of [
      [first, undefined],
      [second, first],
      [third, second],
    ] as const)
      openDispatchStream(rootDir, {
        dispatchId,
        taskId: null,
        executionId: null,
        ...(resumedFrom ? { resumedFromDispatchId: resumedFrom } : {}),
        runtimeSessionId: `runtime-${dispatchId}`,
        instanceId: "instance-1",
        agentId: "ask-agent",
        startedAt: "2026-10-17T00:00:00.000Z",
      }).appendProviderBinding(`provider-${dispatchId}`, "2026-10-17T00:00:01.000Z");

    // The caller keeps naming the first dispatch (the ask session id); admission lands on the
    // leaf and returns the leaf's stream, so the new round continues the leaf's provider session.
    const links = new Map([
      [first, second],
      [second, third],
    ]);
    const resumed = admitRuntimeResume(rootDir, first, () => ({
      readRuntimeDispatchByResumeSource: (source: string) =>
        links.has(source)
          ? ({
              event: { payload: { dispatchId: links.get(source)!, resumedFromDispatchId: source } },
            } as unknown as RuntimeDispatchProjectionRow)
          : null,
    }));
    assert.equal(resumed?.header.dispatchId, third);
    assert.equal(resumed?.providerSessionId, `provider-${third}`);
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
