// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli/parse-args.ts";
import { normalizeCommandSemantics } from "../src/cli/command-semantic-normalizer.ts";
import type { ParsedCommand } from "../src/cli/types.ts";
import { commandRunPayload } from "../src/daemon/client.ts";
import { commandSpecs } from "../src/cli/command-spec/index.ts";

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

test("generated ingress identities mark compatibility input and fact source derives from the current session", async () => {
  const manualDecision = parseArgs([
    "decision", "propose", "--id", "dec_01KXTEST000000000000000000",
    "--title", "Generated identity", "--question", "Who allocates identity?",
    "--chosen", "The submission layer", "--rejected", "The caller", "--why-not", "That splits identity"
  ]);
  assert.equal(manualDecision.ok, true);
  if (manualDecision.ok && manualDecision.value.action.kind === "decision-propose") {
    assert.equal(manualDecision.value.action.decisionIdProvided, true);
  }

  const manualFact = parseArgs([
    "fact", "record", "--task", "task_PARITY", "--id", "F-DEADBEEF",
    "--statement", "Generated identity"
  ]);
  assert.equal(manualFact.ok, true);
  if (manualFact.ok && manualFact.value.action.kind === "record-fact") {
    assert.equal(manualFact.value.action.factIdProvided, true);
  }

  const parsed = parseArgs([
    "fact", "record", "--task", "task_PARITY", "--statement", "Derived source"
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.action.kind !== "record-fact") return;
  assert.equal(parsed.value.action.source, undefined);

  const normalized = await normalizeCommandSemantics(
    parsed.value,
    { holder: async () => ({ ok: false, reason: "not-needed" }) } as never,
    { runtime: "codex", sessionId: "session-parity", source: "runtime", detectedAt: "2026-07-18T00:00:00.000Z" }
  );
  assert.equal(normalized.action.kind, "record-fact");
  if (normalized.action.kind === "record-fact") {
    assert.equal(normalized.action.source, "session/session-parity");
    assert.deepEqual(transportedAction(normalized), normalized.action);
  }

  const twice = await normalizeCommandSemantics(
    normalized,
    { holder: async () => { throw new Error("normalized source must not re-read Holder state"); } } as never,
    { runtime: "codex", sessionId: "different-session", source: "runtime", detectedAt: "2026-07-18T00:01:00.000Z" }
  );
  assert.deepEqual(twice, normalized);
});

test("command-spec exposes generated identities and optional fact source", () => {
  const propose = commandSpecs.find((spec) => spec.kind === "decision-propose")!;
  const fact = commandSpecs.find((spec) => spec.kind === "record-fact")!;
  assert.equal(propose.options.some((option) => option.flag === "--id"), false);
  assert.equal(fact.options.some((option) => option.flag === "--id"), false);
  assert.match(fact.usage, /\[--source <text>\]/u);
  assert.match(fact.options.find((option) => option.flag === "--source")?.description ?? "", /active execution or current session/u);
});

function transportedAction(command: ParsedCommand): ParsedCommand["action"] {
  return (commandRunPayload(command).command as unknown as ParsedCommand).action;
}
