// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_NODE_AUTO_CLAIM_POLICY, parseNodeAutoClaimPolicy } from "../src/node-auto-claim-config.ts";
import { decideNodeAutoClaim } from "../src/node-auto-claim.ts";

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
