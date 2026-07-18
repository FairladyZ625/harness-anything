// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli/parse-args.ts";
import type { ParsedCommand } from "../src/cli/types.ts";
import { commandRunPayload } from "../src/daemon/client.ts";

test("decision propose parser completes one transport-stable id and fallback claim", () => {
  const parsed = parseArgs([
    "decision", "propose", "--title", "Parser parity", "--question", "Same payload?",
    "--chosen", "Complete before transport", "--rejected", "Complete in runner", "--why-not", "That splits semantics"
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.action.kind !== "decision-propose") return;
  const action = parsed.value.action;
  assert.match(action.decisionId, /^dec_[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.equal(Number.isNaN(Date.parse(action.proposedAt)), false);
  assert.deepEqual(action.chosen, [{ id: "CH1", text: "Complete before transport" }]);
  assert.deepEqual(action.rejected, [{ id: "RJ1", text: "Complete in runner", why_not: "That splits semantics" }]);
  assert.deepEqual(action.claims, [{ id: "C1", text: "Complete before transport" }]);
  assert.deepEqual(transportedAction(parsed.value), action);
});

test("typed parser defaults for fact record and consent are transport-stable", () => {
  const fact = parseArgs([
    "fact", "record", "--task", "task_PARITY", "--statement", "Stable fact", "--source", "parser parity"
  ]);
  assert.equal(fact.ok, true);
  if (fact.ok && fact.value.action.kind === "record-fact") {
    assert.match(fact.value.action.factId, /^F-[0-9A-HJKMNP-TV-Z]{8}$/u);
    assert.equal(Number.isNaN(Date.parse(fact.value.action.observedAt)), false);
    assert.deepEqual(transportedAction(fact.value), fact.value.action);
  }

  const consent = parseArgs([
    "task", "consent-record", "task_PARITY", "--execution-id", "exe_PARITY", "--utterance", "Approved"
  ]);
  assert.equal(consent.ok, true);
  if (consent.ok && consent.value.action.kind === "task-consent-record") {
    assert.deepEqual(consent.value.action.consentActions, ["approve_execution", "complete_task"]);
    assert.deepEqual(transportedAction(consent.value), consent.value.action);
  }
});

function transportedAction(command: ParsedCommand): ParsedCommand["action"] {
  return (commandRunPayload(command).command as unknown as ParsedCommand).action;
}
