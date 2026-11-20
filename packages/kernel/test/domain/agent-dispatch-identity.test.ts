// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  isSha256Digest,
  computeAgentDeclarationDigest,
  computeSkillSnapshotDigest,
  verifyBareProviderSessionResumeIdentity,
  verifyDispatchSnapshotFence,
} from "../../src/index.ts";
import { runtimeDefinitionSnapshotArtifact, validateAgentRuntimeEvent } from "../../src/domain/agent-runtime.ts";
import type { AgentDeclarationV1 } from "../../src/domain/agent-squad-schema.ts";

const sampleAgent: AgentDeclarationV1 = {
  schema: "agent-declaration/v1",
  id: "terra",
  name: "Terra",
  instructions: "Execute deterministically.",
  prompts: ["Read task_plan.md"],
  skills: [{ id: "test-isolation", path: "skills/test-isolation" }],
  runtimes: [{ type: "codex", model: "gpt-5.6-terra" }],
};

test("computeAgentDeclarationDigest is deterministic across object key ordering and sensitive to declaration edits", () => {
  const reordered = {
    runtimes: [{ model: "gpt-5.6-terra", type: "codex" as const }],
    skills: [{ path: "skills/test-isolation", id: "test-isolation" }],
    prompts: ["Read task_plan.md"],
    instructions: "Execute deterministically.",
    name: "Terra",
    id: "terra",
    schema: "agent-declaration/v1" as const,
  };
  const digestA = computeAgentDeclarationDigest(sampleAgent),
    digestB = computeAgentDeclarationDigest(reordered),
    edited = computeAgentDeclarationDigest({ ...sampleAgent, instructions: "Changed instructions." });
  assert.ok(isSha256Digest(digestA));
  assert.equal(digestA, digestB);
  assert.notEqual(digestA, edited);
});

test("computeSkillSnapshotDigest is order-invariant and detects byte or file tree mutations", () => {
  const shaA = "a".repeat(64),
    shaB = "b".repeat(64),
    shaC = "c".repeat(64);
  const digest1 = computeSkillSnapshotDigest([
      {
        id: "skill-two",
        files: [{ relativePath: "SKILL.md", sha256: shaB, byteLength: 10 }],
      },
      {
        id: "skill-one",
        files: [
          { relativePath: "scripts/run.mjs", sha256: shaC, byteLength: 42 },
          { relativePath: "SKILL.md", sha256: shaA, byteLength: 12 },
        ],
      },
    ]),
    digest2 = computeSkillSnapshotDigest([
      {
        id: "skill-one",
        files: [
          { relativePath: "SKILL.md", sha256: shaA, byteLength: 12 },
          { relativePath: "scripts/run.mjs", sha256: shaC, byteLength: 42 },
        ],
      },
      {
        id: "skill-two",
        files: [{ relativePath: "SKILL.md", sha256: shaB, byteLength: 10 }],
      },
    ]),
    mutated = computeSkillSnapshotDigest([
      {
        id: "skill-one",
        files: [
          { relativePath: "SKILL.md", sha256: shaB, byteLength: 12 },
          { relativePath: "scripts/run.mjs", sha256: shaC, byteLength: 42 },
        ],
      },
      {
        id: "skill-two",
        files: [{ relativePath: "SKILL.md", sha256: shaB, byteLength: 10 }],
      },
    ]);
  assert.ok(isSha256Digest(digest1));
  assert.equal(digest1, digest2);
  assert.notEqual(digest1, mutated);
  assert.throws(() =>
    computeSkillSnapshotDigest([{ id: "bad", files: [{ relativePath: "../escape.md", sha256: shaA, byteLength: 1 }] }]),
  );
});

test("verifyDispatchSnapshotFence accepts matching digests and rejects stale preview expectations", () => {
  const agentDigest = `sha256:${"1".repeat(64)}`,
    skillDigest = `sha256:${"2".repeat(64)}`;
  assert.deepEqual(
    verifyDispatchSnapshotFence({
      expectedAgentDeclarationDigest: agentDigest,
      expectedSkillSnapshotDigest: skillDigest,
      actualAgentDeclarationDigest: agentDigest,
      actualSkillSnapshotDigest: skillDigest,
    }),
    { ok: true },
  );
  const staleAgent = verifyDispatchSnapshotFence({
    expectedAgentDeclarationDigest: agentDigest,
    actualAgentDeclarationDigest: `sha256:${"9".repeat(64)}`,
    actualSkillSnapshotDigest: skillDigest,
  });
  assert.equal(staleAgent.ok, false);
  if (!staleAgent.ok) {
    assert.equal(staleAgent.code, "dispatch_snapshot_stale");
    assert.equal(staleAgent.field, "agentDeclarationDigest");
  }
  const staleSkill = verifyDispatchSnapshotFence({
    expectedSkillSnapshotDigest: skillDigest,
    actualAgentDeclarationDigest: agentDigest,
    actualSkillSnapshotDigest: `sha256:${"8".repeat(64)}`,
  });
  assert.equal(staleSkill.ok, false);
  if (!staleSkill.ok) {
    assert.equal(staleSkill.code, "dispatch_snapshot_stale");
    assert.equal(staleSkill.field, "skillSnapshotDigest");
  }
});

test("verifyBareProviderSessionResumeIdentity enforces recorded session, owner/task, Agent, and Skill identity", () => {
  const agentDigest = `sha256:${"3".repeat(64)}`,
    skillDigest = `sha256:${"4".repeat(64)}`,
    prior = {
      runtimeSessionId: "runtime_1",
      personId: "owner",
      taskId: "task_1",
      agentId: "terra",
      agentDeclarationDigest: agentDigest,
      skillSnapshotDigest: skillDigest,
    };
  const validRequest = {
    providerSessionId: "prov-1",
    personId: "owner",
    taskId: "task_1",
    agentId: "terra",
    agentDeclarationDigest: agentDigest,
    skillSnapshotDigest: skillDigest,
  };
  assert.deepEqual(verifyBareProviderSessionResumeIdentity([prior], validRequest), { ok: true });
  assert.deepEqual(verifyBareProviderSessionResumeIdentity([], validRequest).ok, false);
  assert.equal(
    (
      verifyBareProviderSessionResumeIdentity([], validRequest) as {
        readonly ok: false;
        readonly code: string;
      }
    ).code,
    "runtime_resume_session_not_found",
  );
  assert.equal(
    (
      verifyBareProviderSessionResumeIdentity([prior], { ...validRequest, personId: "intruder" }) as {
        readonly ok: false;
        readonly code: string;
      }
    ).code,
    "runtime_resume_binding_mismatch",
  );
  assert.equal(
    (
      verifyBareProviderSessionResumeIdentity([prior], { ...validRequest, agentId: "sol" }) as {
        readonly ok: false;
        readonly code: string;
      }
    ).code,
    "runtime_resume_agent_mismatch",
  );
  assert.equal(
    (
      verifyBareProviderSessionResumeIdentity([prior], {
        ...validRequest,
        skillSnapshotDigest: `sha256:${"f".repeat(64)}`,
      }) as {
        readonly ok: false;
        readonly code: string;
      }
    ).code,
    "runtime_resume_skill_mismatch",
  );
});

test("runtime_dispatch_requested validates optional agentDeclarationDigest and skillSnapshotDigest", () => {
  const definition = {
    schema: "agent-definition-snapshot/v1" as const,
    configVersion: 1 as const,
    instanceId: "inst-1",
    installationId: "install-1",
    kindId: "codex" as const,
    providerId: "openai",
    model: "gpt-5",
    reasoningEffort: null,
    baseUrl: null,
    authMode: "subscription" as const,
  };
  const baseEvent = {
    schema: "agent-runtime-event/v1",
    eventId: "event-1",
    workspaceRevision: 1,
    opId: "op-1",
    actor: { principal: { personId: "owner" }, executor: null },
    source: "local",
    occurredAt: "2026-11-20T00:00:00.000Z",
    type: "runtime_dispatch_requested",
    payload: {
      dispatchId: "dispatch_1",
      runtimeSessionId: "runtime_1",
      instanceId: "inst-1",
      installationId: "install-1",
      kindId: "codex",
      dispatchKey: "key-1",
      definitionSnapshotRef: runtimeDefinitionSnapshotArtifact(definition).ref,
      definitionSnapshot: definition,
      agentDeclarationDigest: `sha256:${"a".repeat(64)}`,
      skillSnapshotDigest: `sha256:${"b".repeat(64)}`,
    },
  };
  assert.deepEqual(validateAgentRuntimeEvent(baseEvent), []);
  assert.deepEqual(
    validateAgentRuntimeEvent({
      ...baseEvent,
      payload: { ...baseEvent.payload, skillSnapshotDigest: "not-a-sha256" },
    }),
    ["runtime dispatch identity digest is invalid"],
  );
});
