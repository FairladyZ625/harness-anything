// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NODE_AUTO_CLAIM_POLICY,
  parseNodeAutoClaimPolicy,
  writeNodeAutoClaimPolicy,
} from "../src/node-auto-claim-config.ts";
import { decideNodeAutoClaim, openNodeAutoClaimLoop } from "../src/node-auto-claim.ts";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const assignment = {
  taskId: "task-a",
  expiresAt: "2026-11-03T00:00:00.000Z",
  assignedByPersonId: "person-a",
  assignedByTeamIds: ["team-a"],
} as const;
const policy = {
  ...DEFAULT_NODE_AUTO_CLAIM_POLICY,
  enabled: true,
  allowedAgentIds: ["sol"],
  maxConcurrent: 2,
} as const;

test("same owner is allowed while another person is denied", () => {
  assert.deepEqual(
    decideNodeAutoClaim({
      policy,
      assignment,
      ownerPersonId: "person-a",
      now: "2026-11-02T00:00:00.000Z",
      agentId: "sol",
      activeCount: 0,
    }),
    { accepted: true, reason: "accepted" },
  );
  assert.deepEqual(
    decideNodeAutoClaim({
      policy,
      assignment,
      ownerPersonId: "person-b",
      now: "2026-11-02T00:00:00.000Z",
      agentId: "sol",
      activeCount: 0,
    }),
    { accepted: false, reason: "source_not_allowed" },
  );
});

test("person/team authorization, expiry, agent allowlist and concurrency are fail-closed", () => {
  const explicit = { ...policy, allowedSources: { personIds: ["person-a"], teamIds: ["team-b"] } };
  assert.equal(
    decideNodeAutoClaim({
      policy: explicit,
      assignment: { ...assignment, assignedByPersonId: "person-c" },
      ownerPersonId: "person-b",
      now: "2026-11-02T00:00:00.000Z",
      agentId: "sol",
      activeCount: 0,
    }).accepted,
    false,
  );
  assert.equal(
    decideNodeAutoClaim({
      policy: explicit,
      assignment: { ...assignment, assignedByPersonId: "person-c", assignedByTeamIds: ["team-b"] },
      ownerPersonId: "person-b",
      now: "2026-11-02T00:00:00.000Z",
      agentId: "sol",
      activeCount: 0,
    }).accepted,
    true,
  );
  assert.equal(
    decideNodeAutoClaim({
      policy: explicit,
      assignment,
      ownerPersonId: "person-a",
      now: "2026-11-03T00:00:00.000Z",
      agentId: "sol",
      activeCount: 0,
    }).reason,
    "expired",
  );
  assert.equal(
    decideNodeAutoClaim({
      policy: explicit,
      assignment,
      ownerPersonId: "person-a",
      now: "2026-11-02T00:00:00.000Z",
      agentId: "other",
      activeCount: 0,
    }).reason,
    "agent_not_allowed",
  );
  assert.equal(
    decideNodeAutoClaim({
      policy: explicit,
      assignment,
      ownerPersonId: "person-a",
      now: "2026-11-02T00:00:00.000Z",
      agentId: "sol",
      activeCount: 2,
    }).reason,
    "concurrency_limit",
  );
});

test("policy parser rejects unknown fields and normalizes identifiers", () => {
  assert.deepEqual(
    parseNodeAutoClaimPolicy({
      schema: "node-auto-claim/v1",
      enabled: true,
      allowedSources: { personIds: ["b", "a", "a"], teamIds: [] },
      allowedAgentIds: ["sol"],
      maxConcurrent: 1,
    }),
    {
      schema: "node-auto-claim/v1",
      enabled: true,
      allowedSources: { personIds: ["a", "b"], teamIds: [] },
      allowedAgentIds: ["sol"],
      maxConcurrent: 1,
    },
  );
  assert.throws(() => parseNodeAutoClaimPolicy({ ...policy, extra: true }), /unknown policy field/u);
  assert.throws(() => parseNodeAutoClaimPolicy({ ...policy, maxConcurrent: 0 }), /maxConcurrent/u);
});

test("loop bounds concurrent starts, de-duplicates in-flight tasks, and rescans after offline attach", async () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-node-auto-claim-loop-"));
  try {
    writeNodeAutoClaimPolicy(userRoot, { ...policy, maxConcurrent: 1 });
    const allowed = { id: "task-allowed", assignedBy: "owner", expiresAt: assignment.expiresAt },
      queued = { id: "task-queued", assignedBy: "owner", expiresAt: assignment.expiresAt };
    let online = false;
    let candidateReads = 0;
    let release!: () => void;
    const runGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    let queuedStarted!: () => void;
    const queuedRun = new Promise<void>((resolve) => {
      queuedStarted = resolve;
    });
    const loop = openNodeAutoClaimLoop({
      userRoot,
      now: () => "2026-11-02T00:00:00.000Z",
      ownerPersonIdFor: async () => "owner",
      repos: () => (online ? ["repo-a"] : []),
      repoIdOf: (repo) => repo,
      candidates: async () => {
        candidateReads += 1;
        return [allowed, queued];
      },
      taskIdOf: (candidate) => candidate.id,
      assignmentOf: async (candidate) => ({
        taskId: candidate.id,
        expiresAt: candidate.expiresAt,
        assignedByPersonId: candidate.assignedBy,
        assignedByTeamIds: [],
      }),
      activeTaskKeys: async () => [],
      agentIds: () => ["sol"],
      claimAndRun: async (_repo, candidate) => {
        started.push(candidate.id);
        if (candidate.id === queued.id) queuedStarted();
        await runGate;
      },
    });
    await loop.trigger("offline");
    assert.deepEqual(started, []);
    online = true;
    const first = loop.trigger("attach");
    const second = loop.trigger("replica");
    await Promise.all([first, second]);
    assert.deepEqual(started, ["task-allowed"]);
    assert.equal(candidateReads, 2);
    assert.equal(
      loop.diagnostics().some((row) => row.reason === "concurrency_limit"),
      true,
    );
    assert.equal(
      loop.diagnostics().some((row) => row.reason === "accepted" && row.agentId === "sol"),
      true,
    );
    release();
    await queuedRun;
    await loop.close();
    assert.deepEqual(started, ["task-allowed", "task-queued"]);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("concurrency slots include local runs missing from the runtime projection", async () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-node-auto-claim-slots-"));
  try {
    writeNodeAutoClaimPolicy(userRoot, { ...policy, maxConcurrent: 2 });
    const first = { id: "task-first" },
      second = { id: "task-second" },
      third = { id: "task-third" };
    let candidates = [first],
      activeTaskKeys: readonly string[] = [];
    let release!: () => void;
    const runGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const loop = openNodeAutoClaimLoop({
      userRoot,
      now: () => "2026-11-02T00:00:00.000Z",
      ownerPersonIdFor: async () => "owner",
      repos: () => ["repo-a"],
      repoIdOf: (repo) => repo,
      candidates: async () => candidates,
      taskIdOf: (candidate) => candidate.id,
      assignmentOf: async (candidate) => ({
        taskId: candidate.id,
        expiresAt: assignment.expiresAt,
        assignedByPersonId: "owner",
        assignedByTeamIds: [],
      }),
      activeTaskKeys: async () => activeTaskKeys,
      agentIds: () => ["sol"],
      claimAndRun: async (_repo, candidate) => {
        started.push(candidate.id);
        await runGate;
      },
    });
    await loop.trigger("first-candidate");
    candidates = [second, third];
    activeTaskKeys = ["repo-a:existing-runtime"];
    await loop.trigger("projection-lag");
    assert.deepEqual(started, ["task-first"]);
    assert.equal(loop.diagnostics().filter((row) => row.reason === "concurrency_limit").length, 2);
    release();
    await loop.close();
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
