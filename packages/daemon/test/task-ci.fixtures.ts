import assert from "node:assert/strict";
import { submissionDigest } from "@harness-anything/kernel";

export const sha = "a".repeat(40),
  secret = "opaque-fixture-secret-ci-345";
export function fixture(role: "implementation" | "reviewer" = "implementation") {
  const p = {
      personId: "person-ci",
      repoId: "repo-ci",
      runtimeSessionId: "runtime-ci",
      dispatchId: "dispatch-ci",
      taskId: "task-ci",
      executionId: "execution-ci",
      role,
      source: "local" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    actor = {
      principal: { personId: p.personId },
      executor: { kind: "agent" as const, id: `runtime-session:${p.runtimeSessionId}` },
    },
    submission = { fixture: "submission" },
    dispatch = {
      actor,
      source: "local",
      payload: {
        dispatchId: p.dispatchId,
        role,
        instanceId: "instance-ci",
        reviewTarget: {
          kind: "task",
          taskId: p.taskId,
          executionId: p.executionId,
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
        assert.equal(id, "instance-ci");
        assert.equal(provider, "github");
        credentialReads++;
        return { GH_TOKEN: secret, HARNESS_GITHUB_TOKEN: secret };
      },
    },
    projection: {
      readRuntimeSession: () => ({
        liveness: "live",
        outcome: null,
        taskBindings: [{ taskId: p.taskId, executionId: p.executionId }],
      }),
      readRuntimeDispatch: () => dispatch,
      currentLease: () => ({ phase: "held", actor, executionId: p.executionId, source: "local" }),
      read: () => ({ snapshot: { executions: [{ executionId: p.executionId, submission }] } }),
      readCut: () => ({ sourceRevision: 42 }),
    },
    extracted: {
      readResult: (_id: string, value: object) => ({ outcome: "applied", evidence: JSON.stringify(value) }),
    },
  };
  return {
    context,
    binding: { executionPrincipal: p, actor, source: "local" as const },
    dispatch,
    credentialReads: () => credentialReads,
  };
}
