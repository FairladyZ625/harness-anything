// harness-test-tier: fast
import assert from "node:assert/strict";
import { submissionDigest } from "@harness-anything/kernel";

export const secret = "opaque-fixture-secret-pr-345";

export function fixture(role: "implementation" | "reviewer" = "implementation") {
  const principal = {
      personId: "person-pr",
      repoId: "repo-pr",
      runtimeSessionId: "runtime-pr",
      dispatchId: "dispatch-pr",
      taskId: "task-pr",
      executionId: "execution-pr",
      role,
      source: "local" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    actor = {
      principal: { personId: principal.personId },
      executor: { kind: "agent" as const, id: `runtime-session:${principal.runtimeSessionId}` },
    },
    submission = { fixture: "submission" },
    dispatch = {
      actor,
      source: "local",
      payload: {
        dispatchId: principal.dispatchId,
        role,
        instanceId: "instance-pr",
        reviewTarget: {
          kind: "task",
          taskId: principal.taskId,
          executionId: principal.executionId,
          digest: submissionDigest(submission as never),
        },
      },
    };
  let credentialReads = 0;
  const context = {
    rootDir: "/fixture/center",
    now: () => "2026-10-12T00:00:00Z",
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    input: {
      prepareDaemonGitEnvironment: async (id: string, provider = "github") => {
        assert.equal(id, "instance-pr");
        assert.equal(provider, "github");
        credentialReads++;
        return { GH_TOKEN: secret, HARNESS_GITHUB_TOKEN: secret };
      },
    },
    projection: {
      readRuntimeSession: () => ({
        liveness: "live",
        outcome: null,
        taskBindings: [{ taskId: principal.taskId, executionId: principal.executionId }],
      }),
      readRuntimeDispatch: () => dispatch,
      currentLease: () => ({ phase: "held", actor, executionId: principal.executionId, source: "local" }),
      read: () => ({ snapshot: { executions: [{ executionId: principal.executionId, submission }] } }),
      readCut: () => ({ sourceRevision: 42 }),
    },
    extracted: {
      readResult: (_id: string, value: object) => ({ outcome: "applied", evidence: JSON.stringify(value) }),
    },
  };
  return {
    context,
    binding: { executionPrincipal: principal, actor, source: "local" as const },
    dispatch,
    credentialReads: () => credentialReads,
  };
}
