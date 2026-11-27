// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("peer delegate CLI compiles to the canonical PeerRequest ask action", () => {
  const parsed = parseThinCommand(["peer", "delegate", "--to", "person_bob", "--title", "Review the migration"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.command.method, "repo.task.run");
  assert.deepEqual(parsed.command.action, {
    kind: "peer-ask",
    requestKind: "delegate",
    toPersonId: "person_bob",
    summary: "Review the migration",
    claim: "Review the migration",
    requestedAction: "Review the migration",
  });
});

test("resident CEO config CLI carries the selected instance, model, and heartbeat interval", () => {
  const parsed = parseThinCommand([
    "ceo",
    "config",
    "--instance",
    "instance_owner",
    "--model",
    "model-a",
    "--heartbeat-interval-sec",
    "600",
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.command.method, "repo.residentCeo.config");
  assert.deepEqual(parsed.command.action, {
    kind: "ceo-config",
    runtimeInstanceId: "instance_owner",
    model: "model-a",
    heartbeatIntervalSec: 600,
  });
});

test("resident CEO Phase 2 CLI parses policy config, proposals, approve, and reject commands", () => {
  const configured = parseThinCommand([
    "ceo",
    "config",
    "--instance",
    "instance_owner",
    "--model",
    "model-a",
    "--heartbeat-interval-sec",
    "300",
    "--policy",
    "approval-gated",
    "--default-work",
    "task_work_1",
    "--default-agent",
    "neon",
    "--auto-approve-sender",
    "person_alice",
    "--auto-approve-sender",
    "person_carol",
  ]);
  assert.equal(configured.ok, true);
  if (!configured.ok) return;
  assert.equal(configured.command.method, "repo.residentCeo.config");
  assert.deepEqual(configured.command.action, {
    kind: "ceo-config",
    runtimeInstanceId: "instance_owner",
    model: "model-a",
    heartbeatIntervalSec: 300,
    executionPolicy: "approval-gated",
    defaultWorkId: "task_work_1",
    defaultAgentId: "neon",
    autoApproveSenders: ["person_alice", "person_carol"],
  });

  const proposals = parseThinCommand(["ceo", "proposals", "--status", "pending_approval"]);
  assert.equal(proposals.ok, true);
  if (!proposals.ok) return;
  assert.equal(proposals.command.method, "repo.residentCeo.proposals");
  assert.deepEqual(proposals.command.action, { kind: "ceo-proposals", status: "pending_approval" });

  const history = parseThinCommand(["ceo", "history", "--limit", "25", "--cause", "peer-request"]);
  assert.equal(history.ok, true);
  if (!history.ok) return;
  assert.equal(history.command.method, "repo.residentCeo.history");
  assert.deepEqual(history.command.action, { kind: "ceo-history", limit: 25, cause: "peer-request" });

  const approved = parseThinCommand([
    "ceo",
    "approve",
    "prop_abc123",
    "--work",
    "task_work_1",
    "--title",
    "Custom promoted title",
    "--agent",
    "neon",
    "--target-node",
    "cea7e947",
    "--instance",
    "instance_owner",
    "--model",
    "model-a",
    "--prompt",
    "Execute migration",
  ]);
  assert.equal(approved.ok, true);
  if (!approved.ok) return;
  assert.equal(approved.command.method, "repo.residentCeo.approve");
  assert.deepEqual(approved.command.action, {
    kind: "ceo-approve",
    proposalId: "prop_abc123",
    workId: "task_work_1",
    title: "Custom promoted title",
    agentId: "neon",
    targetNodeId: "cea7e947",
    runtimeInstanceId: "instance_owner",
    model: "model-a",
    prompt: "Execute migration",
  });

  // Explicitly ensure --to is NOT accepted on ceo approve (reserved for Squad targetAgentId in agent-run).
  const rejectedLegacyTo = parseThinCommand(["ceo", "approve", "prop_abc123", "--to", "cea7e947"]);
  assert.equal(rejectedLegacyTo.ok, false);

  const rejected = parseThinCommand(["ceo", "reject", "prop_abc123", "--reason", "Out of scope"]);
  assert.equal(rejected.ok, true);
  if (!rejected.ok) return;
  assert.equal(rejected.command.method, "repo.residentCeo.reject");
  assert.deepEqual(rejected.command.action, {
    kind: "ceo-reject",
    proposalId: "prop_abc123",
    reason: "Out of scope",
  });
});

test("resident CEO Phase 3 CLI parses approval gate flags and rejects invalid mode or confidence range", () => {
  const configured = parseThinCommand([
    "ceo",
    "config",
    "--instance",
    "instance_owner",
    "--model",
    "model-a",
    "--heartbeat-interval-sec",
    "300",
    "--policy",
    "approval-gated",
    "--gate-mode",
    "auto-promote",
    "--gate-provider",
    "openrouter-decider",
    "--gate-min-confidence",
    "0.88",
  ]);
  assert.equal(configured.ok, true);
  if (!configured.ok) return;
  assert.equal(configured.command.method, "repo.residentCeo.config");
  assert.deepEqual(configured.command.action, {
    kind: "ceo-config",
    runtimeInstanceId: "instance_owner",
    model: "model-a",
    heartbeatIntervalSec: 300,
    executionPolicy: "approval-gated",
    gateMode: "auto-promote",
    gateProviderId: "openrouter-decider",
    gateMinConfidence: 0.88,
  });

  const boundaryOne = parseThinCommand([
    "ceo",
    "config",
    "--instance",
    "instance_owner",
    "--model",
    "model-a",
    "--heartbeat-interval-sec",
    "300",
    "--gate-mode",
    "secondary-guard",
    "--gate-min-confidence",
    "1",
  ]);
  assert.equal(boundaryOne.ok, true);
  if (boundaryOne.ok) assert.equal(boundaryOne.command.action.gateMinConfidence, 1);

  const badMode = parseThinCommand([
    "ceo",
    "config",
    "--instance",
    "instance_owner",
    "--model",
    "model-a",
    "--heartbeat-interval-sec",
    "300",
    "--gate-mode",
    "yolo",
  ]);
  assert.equal(badMode.ok, false);

  for (const invalidConfidence of ["0", "0.0", "1.2", "-0.5", "not-a-number"]) {
    const badConfidence = parseThinCommand([
      "ceo",
      "config",
      "--instance",
      "instance_owner",
      "--model",
      "model-a",
      "--heartbeat-interval-sec",
      "300",
      "--gate-min-confidence",
      invalidConfidence,
    ]);
    assert.equal(badConfidence.ok, false, `expected --gate-min-confidence ${invalidConfidence} to be rejected`);
  }
});
