// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { canReclaim, isIndependentFrom, isSameExecution, isSamePerson, type ActorIdentity } from "../../src/index.ts";

const person = (personId: string, executor: ActorIdentity["executor"]): ActorIdentity => ({ principal: { personId }, executor });
const declared = (kind: string, id: string): ActorIdentity["executor"] => ({ kind, id }) as ActorIdentity["executor"];

test("isSamePerson ignores executor presence, kind, and id", () => {
  const agent = { kind: "agent", id: "executor-a" } as const;
  const otherAgent = { kind: "agent", id: "executor-b" } as const;
  const rows = [
    ["both executors null", person("person-a", null), person("person-a", null), true],
    ["one executor null", person("person-a", null), person("person-a", agent), true],
    ["same executor", person("person-a", agent), person("person-a", agent), true],
    ["different executor id", person("person-a", agent), person("person-a", otherAgent), true],
    ["different person", person("person-a", agent), person("person-b", agent), false]
  ] as const;

  for (const [label, left, right, expected] of rows) assert.equal(isSamePerson(left, right), expected, label);
});

test("isSameExecution requires the same person and the complete executor identity", () => {
  const rows = [
    ["both executors null", person("person-a", null), person("person-a", null), true],
    ["both null but different person", person("person-a", null), person("person-b", null), false],
    ["one executor null", person("person-a", null), person("person-a", declared("agent", "executor-a")), false],
    ["same kind and id", person("person-a", declared("agent", "executor-a")), person("person-a", declared("agent", "executor-a")), true],
    ["different kind", person("person-a", declared("agent", "executor-a")), person("person-a", declared("worker", "executor-a")), false],
    ["different id", person("person-a", declared("agent", "executor-a")), person("person-a", declared("agent", "executor-b")), false],
    ["different person", person("person-a", declared("agent", "executor-a")), person("person-b", declared("agent", "executor-a")), false]
  ] as const;

  for (const [label, left, right, expected] of rows) assert.equal(isSameExecution(left, right), expected, label);
});

test("isIndependentFrom matches the previous selfReview behavior across the full truth table", () => {
  const rows = [
    ["same person, both null", person("person-a", null), person("person-a", null), false, false],
    ["different person, both null", person("person-a", null), person("person-b", null), true, true],
    ["same person, one null", person("person-a", null), person("person-a", declared("agent", "executor-a")), true, true],
    ["different person, one null", person("person-a", null), person("person-b", declared("agent", "executor-a")), true, true],
    ["same person, same kind and id", person("person-a", declared("agent", "executor-a")), person("person-a", declared("agent", "executor-a")), false, false],
    ["different person, same kind and id", person("person-a", declared("agent", "executor-a")), person("person-b", declared("agent", "executor-a")), false, false],
    ["same person, different id", person("person-a", declared("agent", "executor-a")), person("person-a", declared("agent", "executor-b")), true, true],
    ["different person, different id", person("person-a", declared("agent", "executor-a")), person("person-b", declared("agent", "executor-b")), true, true],
    ["same person, different kind and same id", person("person-a", declared("agent", "executor-a")), person("person-a", declared("worker", "executor-a")), false, false],
    ["different person, different kind and same id", person("person-a", declared("agent", "executor-a")), person("person-b", declared("worker", "executor-a")), false, false],
    ["same person, different kind and id", person("person-a", declared("agent", "executor-a")), person("person-a", declared("worker", "executor-b")), true, true],
    ["different person, different kind and id", person("person-a", declared("agent", "executor-a")), person("person-b", declared("worker", "executor-b")), true, true]
  ] as const;

  for (const [label, author, reviewer, beforeIndependent, expected] of rows) {
    const actual = isIndependentFrom(author, reviewer);
    assert.equal(actual, expected, label);
    assert.equal(actual, beforeIndependent, `${label}: behavior must remain equivalent to the previous selfReview check`);
  }
});

test("canReclaim accepts only an orphaned lease and a caller with the holder principal", () => {
  const holder = person("person-a", declared("agent", "executor-departed"));
  const lease = (phase: "reserving" | "active" | "orphaned" | "released") => ({
    schema: "lease/v1" as const,
    taskId: "task-a",
    executionId: "execution-a",
    actor: holder,
    source: "local" as const,
    phase,
    expiresAt: "2026-08-17T10:00:00.000Z",
    ttlMs: 60_000,
    version: 1
  });
  const samePrincipalNewExecutor = person("person-a", declared("agent", "executor-reclaimer"));
  const differentPrincipal = person("person-b", declared("agent", "executor-reclaimer"));
  const rows = [
    ["orphaned, same principal after expiry", lease("orphaned"), samePrincipalNewExecutor, "2026-08-17T11:00:00.000Z", true],
    ["orphaned, same principal before expiry", lease("orphaned"), samePrincipalNewExecutor, "2026-08-17T09:00:00.000Z", true],
    ["orphaned, different principal", lease("orphaned"), differentPrincipal, "2026-08-17T11:00:00.000Z", false],
    ["reserving, same principal", lease("reserving"), samePrincipalNewExecutor, "2026-08-17T11:00:00.000Z", false],
    ["active, same principal", lease("active"), samePrincipalNewExecutor, "2026-08-17T11:00:00.000Z", false],
    ["released, same principal", lease("released"), samePrincipalNewExecutor, "2026-08-17T11:00:00.000Z", false]
  ] as const;

  for (const [label, current, caller, now, expected] of rows) assert.equal(canReclaim(current, caller, now), expected, label);
});
