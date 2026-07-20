// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../src/cli/parse-args.ts";
import { commandSpecs } from "../src/cli/command-spec/index.ts";
import type { ParsedCommand } from "../src/cli/types.ts";
import { taskCloseoutFacadeSteps, taskStartFacadeSteps } from "../src/commands/core/task-lifecycle-facade.ts";

test("task start is a two-step boundary that cannot enter review", () => {
  const parsed = parseArgs(["task", "start", "task_BOUNDARY", "--ttl-ms", "60000"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.action.kind !== "task-start") return;
  const steps = taskStartFacadeSteps(parsed.value as ParsedCommand & { action: Extract<ParsedCommand["action"], { kind: "task-start" }> });
  assert.deepEqual(steps.map((step) => step.action.kind), ["task-claim", "status-set"]);
  assert.deepEqual(steps.map((step) => step.action.kind === "status-set" ? step.action.status : undefined), [undefined, "active"]);
  assert.equal(steps.some((step) => step.action.kind === "status-set" && step.action.status === "in_review"), false);
});

test("task closeout requires a separate invocation and preserves every canonical gate step", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-closeout-parser-"));
  const packet = path.join(root, "closeout.json");
  writeFileSync(packet, JSON.stringify({
    completionClaim: "Ready for deliberate closeout.",
    verdict: "approved",
    findings: "Acceptance checks passed.",
    rationale: "Evidence satisfies the task intent.",
    consentAssertedRationale: "The human approved through an external channel.",
    consentActions: ["approve_execution", "complete_task"],
    ci: "passed"
  }), "utf8");
  try {
    const parsed = parseArgs(["task", "closeout", "task_BOUNDARY", "--from-file", packet]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok || parsed.value.action.kind !== "task-closeout") return;
    const steps = taskCloseoutFacadeSteps(
      parsed.value as ParsedCommand & { action: Extract<ParsedCommand["action"], { kind: "task-closeout" }> },
      "a".repeat(40)
    );
    assert.deepEqual(steps.map((step) => step.action.kind), [
      "status-set", "task-review-execution", "task-code-doc-reconcile", "task-complete"
    ]);
    assert.equal(steps[0]?.action.kind === "status-set" && steps[0].action.status, "in_review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("both lifecycle facades satisfy the accepted command admission contract", () => {
  const start = commandSpecs.find((spec) => spec.kind === "task-start");
  const closeout = commandSpecs.find((spec) => spec.kind === "task-closeout");
  assert.ok(start?.admission);
  assert.ok(closeout?.admission);
  assert.equal(start.options.length <= 8, true);
  assert.equal(closeout.options.length <= 8, true);
  assert.equal(start.admission.decisionRef, "decision/dec_01KXWRC9CH70HN61B5FYPQP3XV");
  assert.equal(closeout.admission.decisionRef, "decision/dec_01KXWRC9CH70HN61B5FYPQP3XV");
  assert.equal(closeout.admission.chain?.structuredInput, true);
});
