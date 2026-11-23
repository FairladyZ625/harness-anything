// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeDispatchProjectionRow } from "@harness-anything/kernel";
import { archiveDispatchStream, openDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import {
  daemonActionRoutes,
  daemonMethodPayloadFields,
  parseDaemonRpcParams,
} from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { daemonProtocolMethods } from "../src/daemon-host/protocol/daemon-protocol-commands.ts";
import { cancelRuntime, steerRuntime } from "../src/daemon-host/runtime-spawn-control.ts";
import type { RuntimeSpawnerContext } from "../src/daemon-host/runtime-spawn-context.ts";
import { taskDispatchLeaseQualifies } from "../src/daemon-host/task-dispatch-admission.ts";
import { validAgentRuntimeAttemptChain } from "../src/daemon-host/runtime-attempt-contract.ts";
import {
  admitRuntimeResume,
  assertRuntimeHandoffLaunch,
  resolveRuntimeResume,
  runtimeResumeAdmission,
} from "../src/daemon-host/runtime-resume-admission.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test("GUI resume spawn uses the dispatchId route", () => {
  const params = {
    repo: { repoId: "canonical" },
    payload: { dispatchId: "dispatch_0123456789abcdef01234567", dispatchKey: "resume-from-gui" },
  };
  assert.equal(parseDaemonRpcParams("repo.agentRuntime.spawn", params).ok, true);
});

test("resume admission accepts a single source selector", () => {
  assert.throws(
    () =>
      resolveRuntimeResume({} as Parameters<typeof resolveRuntimeResume>[0], {
        dispatchId: "dispatch_0123456789abcdef01234567",
        providerSessionId: "fixture-session",
      }),
    { code: "invalid_runtime_spawn", message: "Choose one runtime resume source." },
  );
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
    removeTempRepository(rootDir);
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
    removeTempRepository(rootDir);
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

// The source verifies a rollout's `cli_version`; this boundary verifies the target installation's
// `codex --version` output. Both read the one verified list, so a release verified by bytes cannot
// be accepted on the source and refused on the target.
test("handoff target admission reads the same verified Codex version list as source closure", () => {
  const checkpoint = { dispatchId: "dispatch_0123456789abcdef01234567" } as Parameters<
    typeof assertRuntimeHandoffLaunch
  >[1];
  const launch = { taskId: "task-1", agentId: "worker", role: undefined, trustedSchedule: undefined };
  for (const version of ["0.159.1", "0.159.3", "0.163.0"])
    assert.doesNotThrow(() => assertRuntimeHandoffLaunch(true, checkpoint, launch, "codex", `codex-cli ${version}`));
  for (const version of ["0.163.1", "0.162.0", "codex-cli 0.159.2", "", "0.163.0-extra"])
    assert.throws(() => assertRuntimeHandoffLaunch(true, checkpoint, launch, "codex", version), {
      code: "runtime_handoff_version_unsupported",
    });
  // No checkpoint means no native state to admit, so the version gate does not apply.
  assert.doesNotThrow(() => assertRuntimeHandoffLaunch(true, undefined, launch, "codex", "codex-cli 0.163.1"));
});

test("resolveRuntimeResume derives its wire allowlist from the protocol contract and accepts executor and recovery while rejecting bogusField", () => {
  const input = {
    rootDir: process.cwd(),
    repoId: "protocol-probe",
    now: () => "2026-11-17T00:00:00.000Z",
  };
  assert.deepEqual(
    resolveRuntimeResume(input, {
      agentId: "terra",
      taskId: "task-1",
      dispatchKey: "executor-key",
      executor: { kind: "agent", id: "claude-session:claude-1" },
    }),
    { requestedDispatchId: undefined, resumed: null, inherited: undefined, handoffEnabled: false },
  );
  assert.deepEqual(
    resolveRuntimeResume(input, {
      agentId: "terra",
      taskId: "task-1",
      dispatchKey: "recovery-key",
      recovery: { dispatchId: "dispatch_0123456789abcdef01234567", executionId: "exe-1", expectedVersion: 1 },
    }),
    { requestedDispatchId: undefined, resumed: null, inherited: undefined, handoffEnabled: false },
  );
  assert.throws(
    () =>
      resolveRuntimeResume(input, {
        agentId: "terra",
        taskId: "task-1",
        dispatchKey: "bogus-key",
        bogusField: "unexpected",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "invalid_runtime_spawn" &&
      /unknown field "bogusField"/u.test(error.message),
  );
});

// dec_89D06D7360CBEC09795F7B12EC/CH3: the two former steering registrations now resolve one codec.
test("runtime control handlers and the single steering registration align with daemonMethodPayloadFields", async () => {
  const steeringRoutes = [...daemonProtocolMethods, ...daemonActionRoutes].filter(
    ({ method }) => method === "repo.agentRuntime.steer",
  );
  assert.equal(steeringRoutes.length, 1);
  assert.deepEqual(
    Object.keys((steeringRoutes[0].params.fields.payload as { fields: Record<string, unknown> }).fields),
    daemonMethodPayloadFields("repo.agentRuntime.steer"),
  );
  assert.ok(daemonMethodPayloadFields("repo.agentRuntime.spawn").includes("executor"));
  assert.ok(daemonMethodPayloadFields("repo.agentRuntime.spawn").includes("recovery"));
  assert.ok(daemonMethodPayloadFields("repo.agentRuntime.cancel").includes("ruling"));
  assert.ok(daemonMethodPayloadFields("repo.agentRuntime.steer").includes("expected"));

  const stubContext = {
    input: { repoId: "protocol-probe", rootDir: process.cwd(), now: () => "2026-11-17T00:00:00.000Z" },
    runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as RuntimeSpawnerContext;
  const binding = { actor: { principal: { personId: "owner" }, executor: null }, source: "local" as const };
  await assert.rejects(
    cancelRuntime(stubContext, { runtimeSessionId: "runtime_1", bogusField: true }, binding),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "invalid_runtime_cancel" &&
      /unknown field "bogusField"/u.test(error.message),
  );
  await assert.rejects(
    steerRuntime(stubContext, { runtimeSessionId: "runtime_1", prompt: "go", bogusField: true }, binding),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "invalid_runtime_steer" &&
      /unknown field "bogusField"/u.test(error.message),
  );
});

test("taskDispatchLeaseQualifies allows same-person host CLI sessions to hand off a bare-person lease while isolating runtime sessions", () => {
  const bareLease = {
    schema: "lease/v1" as const,
    taskId: "task-1",
    executionId: "exe-1",
    actor: { principal: { personId: "person-a" }, executor: null },
    source: "local" as const,
    phase: "held" as const,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ttlMs: 60_000,
    version: 1,
  };
  assert.equal(
    taskDispatchLeaseQualifies(
      bareLease,
      { principal: { personId: "person-a" }, executor: { kind: "agent", id: "claude-session:s1" } },
      "runtime_target",
      null,
      true,
    ),
    true,
  );
  assert.equal(
    taskDispatchLeaseQualifies(
      bareLease,
      { principal: { personId: "person-a" }, executor: { kind: "agent", id: "runtime-session:other" } },
      "runtime_target",
      null,
      true,
    ),
    false,
  );
  assert.equal(
    taskDispatchLeaseQualifies(
      bareLease,
      { principal: { personId: "person-b" }, executor: { kind: "agent", id: "claude-session:s1" } },
      "runtime_target",
      null,
      true,
    ),
    false,
  );
});
