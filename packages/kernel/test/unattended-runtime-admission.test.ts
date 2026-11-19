// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSessionContinuationFence,
  SessionContinuationFenceError,
  type SessionContinuationFenceInput,
} from "../src/domain/runtime-session-continuation.ts";
import {
  assertUnattendedLaunchAdmission,
  UnattendedLaunchAdmissionError,
} from "../src/domain/unattended-launch-admission.ts";

const clean: SessionContinuationFenceInput = {
  origin: "unattended_inbox_wakeup",
  requestedAgentId: "terra",
  previousAgentId: "terra",
  taskId: "task_a",
  previousTaskId: "task_a",
  dispatchLineageMatches: true,
  providerSessionId: "provider-session-1",
  runtimeSupportsResume: true,
  priorStopProof: "proven_stopped",
  priorTerminalKind: "awaiting_ruling",
  hasHandoffPacket: false,
};

function code(error: unknown): string {
  assert.ok(error instanceof SessionContinuationFenceError || error instanceof UnattendedLaunchAdmissionError);
  return error.code;
}

test("(c) the fence refuses to resume a dead session on an unattended wakeup and cold-starts instead", () => {
  assert.deepEqual(assertSessionContinuationFence(clean), {
    governed: true,
    origin: "unattended_inbox_wakeup",
    mode: "continue",
    allowProviderResume: true,
    reason: "same_employee_clean_continuation",
  });
  for (const priorTerminalKind of ["stalled", "cancelled", "unreachable", "failed"] as const) {
    const verdict = assertSessionContinuationFence({ ...clean, priorTerminalKind });
    assert.deepEqual(
      verdict,
      {
        governed: true,
        origin: "unattended_inbox_wakeup",
        mode: "fresh",
        allowProviderResume: false,
        reason: "unclean_prior_terminal",
      },
      priorTerminalKind,
    );
  }
  assert.equal(assertSessionContinuationFence({ ...clean, dispatchLineageMatches: false }).governed, true);
  assert.deepEqual(assertSessionContinuationFence({ ...clean, origin: "unattended_schedule", taskId: "task_b" }), {
    governed: true,
    origin: "unattended_schedule",
    mode: "fresh",
    allowProviderResume: false,
    reason: "lineage_mismatch",
  });
  assert.equal(
    (assertSessionContinuationFence({ ...clean, runtimeSupportsResume: false }) as { reason: string }).reason,
    "provider_resume_unavailable",
  );
  assert.equal(
    (
      assertSessionContinuationFence({ ...clean, priorTerminalKind: "none", priorStopProof: "none" }) as {
        reason: string;
      }
    ).reason,
    "no_prior_session",
  );
});

test("(c) an unattended wakeup without proven_stopped, or across employees without handoff, does not start", () => {
  assert.throws(
    () => assertSessionContinuationFence({ ...clean, priorStopProof: "unproven" }),
    (error) => code(error) === "unattended_prior_stop_unproven",
  );
  assert.throws(
    () => assertSessionContinuationFence({ ...clean, requestedAgentId: "luna" }),
    (error) => code(error) === "unattended_handoff_packet_missing",
  );
  assert.deepEqual(assertSessionContinuationFence({ ...clean, requestedAgentId: "luna", hasHandoffPacket: true }), {
    governed: true,
    origin: "unattended_inbox_wakeup",
    mode: "handoff",
    allowProviderResume: false,
    reason: "employee_switched_with_handoff",
  });
});

test("(c) explicit operator recovery and provider-fallback are never intercepted (RJ2)", () => {
  const dead = {
    ...clean,
    priorTerminalKind: "stalled",
    priorStopProof: "unproven",
    requestedAgentId: "luna",
  } as const;
  for (const origin of ["manual_resume", "manual_recover_dispatch", "provider_fallback", "fresh_dispatch"] as const)
    assert.deepEqual(assertSessionContinuationFence({ ...dead, origin }), { governed: false, origin }, origin);
});

const env = {
  PATH: "/usr/bin",
  HOME: "/home/agent",
  GH_TOKEN: "ghp_secret_value_one",
  GITHUB_TOKEN: "ghp_secret_value_two",
  gh_token: "ghp_secret_value_three",
  EMPTY: undefined,
};

test("(d) unattended admission refuses bypass and strips plaintext GitHub tokens without echoing them", () => {
  for (const workKind of ["code_change", "supervision"] as const)
    assert.throws(
      () =>
        assertUnattendedLaunchAdmission({
          workKind,
          requestedPermissionMode: "bypass",
          supportedPermissionModes: ["bypass", "workspace-write", "read-only"],
          environment: env,
        }),
      (error) => code(error) === "unattended_permission_bypass_forbidden",
    );
  const admitted = assertUnattendedLaunchAdmission({
    workKind: "code_change",
    requestedPermissionMode: null,
    supportedPermissionModes: ["bypass", "workspace-write", "read-only"],
    environment: env,
  });
  assert.equal(admitted.permissionMode, "workspace-write", "an unset mode resolves to the ceiling, never to bypass");
  assert.equal(admitted.ceiling, "workspace-write");
  assert.deepEqual(admitted.environment, { PATH: "/usr/bin", HOME: "/home/agent" });
  assert.deepEqual(admitted.strippedEnvironmentKeys, ["GH_TOKEN", "GITHUB_TOKEN", "gh_token"]);
  assert.doesNotMatch(JSON.stringify(admitted), /ghp_secret_value/u);
});

test("(d) code work is capped at workspace-write, supervision at read-only, unsupported modes fail closed", () => {
  assert.equal(
    assertUnattendedLaunchAdmission({
      workKind: "code_change",
      requestedPermissionMode: "read-only",
      supportedPermissionModes: ["read-only"],
      environment: {},
    }).permissionMode,
    "read-only",
  );
  assert.equal(
    assertUnattendedLaunchAdmission({
      workKind: "supervision",
      requestedPermissionMode: null,
      supportedPermissionModes: ["bypass", "workspace-write", "read-only"],
      environment: {},
    }).permissionMode,
    "read-only",
  );
  assert.throws(
    () =>
      assertUnattendedLaunchAdmission({
        workKind: "supervision",
        requestedPermissionMode: "workspace-write",
        supportedPermissionModes: ["workspace-write", "read-only"],
        environment: {},
      }),
    (error) => code(error) === "unattended_permission_exceeds_ceiling",
  );
  assert.throws(
    () =>
      assertUnattendedLaunchAdmission({
        workKind: "code_change",
        requestedPermissionMode: null,
        supportedPermissionModes: ["bypass"],
        environment: { GH_TOKEN: "ghp_secret_value_four" },
      }),
    (error) => {
      assert.doesNotMatch(String(error), /ghp_secret_value/u);
      return code(error) === "unattended_permission_unsupported";
    },
  );
});
