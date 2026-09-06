// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  validateSquadControlReceipt,
  makeDaemonCommandReceipt,
  validateDaemonGuiCommandReceipt,
} from "../src/protocol/daemon-protocol-validate-results.ts";
import type { SquadControlResult } from "../src/squad-control-result.ts";

test("Squad control result has a separate wire contract and cannot assert ledger acceptance", () => {
  const control: SquadControlResult = {
      schema: "squad-control-result/v1",
      command: "squad-run",
      outcome: "completed",
      squadRunId: `squad_${"a".repeat(24)}`,
      phase: "leader_running",
      summary: "leader started",
    },
    receipt = makeDaemonCommandReceipt("squad-run", control);
  assert.deepEqual(validateDaemonGuiCommandReceipt(receipt), []);
  for (const field of ["opId", "proof", "acceptance", "status"])
    assert.ok(validateSquadControlReceipt({ ...receipt, [field]: "unearned" }).length > 0);
  assert.ok(validateSquadControlReceipt({ ...receipt, command: "task-create" }).length > 0);
  assert.ok(validateSquadControlReceipt({ ...receipt, outcome: "applied" }).length > 0);
  assert.ok(validateDaemonGuiCommandReceipt({ ...receipt, schema: "command-receipt/v2" }).length > 0);
});

test("Squad control validates nested rejection and authorization fields", () => {
  const rejection = {
    schema: "squad-control-result/v1",
    command: "squad-cancel",
    ok: false,
    outcome: "op_rejected",
    code: "squad_run_not_found",
    summary: "No such run",
    error: { code: "squad_run_not_found" },
  };
  assert.deepEqual(validateSquadControlReceipt(rejection), []);
  assert.ok(validateSquadControlReceipt({ ...rejection, error: { code: "different" } }).length > 0);
  assert.ok(validateSquadControlReceipt({ ...rejection, error: { code: rejection.code, extra: true } }).length > 0);
  assert.ok(validateSquadControlReceipt({ ...rejection, authorizationDecision: { outcome: "allowed" } }).length > 0);
  assert.ok(validateSquadControlReceipt({ ...rejection, nextActions: [1] }).length > 0);
  assert.ok(validateSquadControlReceipt({ ...rejection, unmetCriteria: [{ ref: "made-up" }] }).length > 0);
});

test("Squad authorization accepts all actionTarget candidates and rejects malformed nested fields", () => {
  const authorization = {
    policyRef: "repository-policy@1",
    actor: { principal: { personId: "ZeyuLi" }, executor: null },
    subject: "task/task_sample",
    bindingsUsed: [{ scope: "repository", nested: { values: [true, null] } }],
    outcome: "allowed",
    reasonCodes: [],
    nextActions: [],
    evaluatedAtCut: "cut:1",
  };
  const base = {
    schema: "squad-control-result/v1",
    command: "squad-cancel",
    outcome: "op_rejected",
    ok: false,
    code: "denied",
    summary: "Denied",
    error: { code: "denied" },
  };
  for (const subject of [
    "settings/repository",
    "task/task_sample",
    "task/ABC-1",
    "decision/dec_sample/anchor",
    "fact/F-sample",
    "execution/exec_sample",
    "schedule/sample",
    "agent/sample",
    "squad/sample",
  ])
    assert.deepEqual(
      validateSquadControlReceipt({ ...base, authorizationDecision: { ...authorization, subject } }),
      [],
      subject,
    );
  for (const changed of [
    { subject: "task/plain" },
    { subject: "squad/UPPER" },
    { subject: "other/x" },
    { actor: { principal: { personId: " " }, executor: null } },
    { bindingsUsed: ["invalid"] },
    { outcome: "denied" },
    { reasonCodes: [" "] },
    { evaluatedAtCut: " " },
    { unexpected: true },
  ])
    assert.ok(
      validateSquadControlReceipt({ ...base, authorizationDecision: { ...authorization, ...changed } }).length > 0,
    );
});
