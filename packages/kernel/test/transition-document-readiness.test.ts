// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assessTransitionDocument,
  assertTransitionDocumentReady,
  getTaskActionForTransition,
  requireTransitionDocumentKind,
} from "../src/index.ts";

const planHeadings = [
  "Brief",
  "Goal",
  "Context",
  "Required Reading",
  "Entry Conditions",
  "Dependencies",
  "Execution Surface",
  "Constraints",
  "Checkpoint",
  "CI/Gate Authority Stop Condition",
  "Implementation Plan",
  "Deliverable Contract",
  "Evidence Protocol",
  "Verification",
] as const;

test("transition document bindings enumerate canonical consumers and omit milestone without a transition", () => {
  assert.deepEqual(
    [
      "task.start",
      "runtime.run",
      "squad.run",
      "task.complete",
      "decision.accept",
      "agent.install",
      "squad.install",
    ].map((transition) => `${transition}:${requireTransitionDocumentKind(transition)}`),
    [
      "task.start:task.plan",
      "runtime.run:task.plan",
      "squad.run:task.plan",
      "task.complete:task.closeout",
      "decision.accept:decision.body",
      "agent.install:agent.instructions",
      "squad.install:squad.roster",
    ],
  );
  assert.throws(() => requireTransitionDocumentKind("milestone.closeout"), /no canonical document binding/u);
});

test("task document readiness resolves a dotted transition id directly from its descriptor", () => {
  const transition = "task.complete",
    action = getTaskActionForTransition(transition);
  assert.equal(action?.id, "complete");
  assert.equal(
    action?.managedDocuments.find(({ readinessRequired }) => readinessRequired)?.slot,
    requireTransitionDocumentKind(transition),
  );
});

test("task plan rejects pure scaffolds but accepts a retained scaffold sentence plus concrete content", () => {
  const template = readFileSync(
    new URL("../../preset/assets/software-coding/templates/task.plan/en-US.md", import.meta.url),
    "utf8",
  );
  const scaffold = assessTransitionDocument("task.plan", template);
  assert.equal(scaffold.ready, false);
  assert.equal(scaffold.code, "plan_placeholder");
  assert.deepEqual(
    scaffold.missingSections.map(({ section }) => section),
    planHeadings,
  );
  assert.deepEqual(scaffold.missingSections[0], {
    section: "Brief",
    reason: "scaffold",
    retainedScaffold: "One-line statement of the task objective and scope.",
  });

  const emptyGoal = realizedPlan().replace("## Goal\n\nImplemented Goal.", "## Goal\n\n");
  assert.deepEqual(assessTransitionDocument("task.plan", emptyGoal).missingSections, [
    { section: "Goal", reason: "empty" },
  ]);

  const retainedScaffold = realizedPlan().replace(
    "## Brief\n\nImplemented Brief.",
    "## Brief\n\nOne-line statement of the task objective and scope. Implement task-index/v1 for CLI consumers.",
  );
  assert.equal(assessTransitionDocument("task.plan", retainedScaffold).ready, true);
  const pureScaffoldSection = realizedPlan().replace(
    "## Verification\n\nImplemented Verification.",
    "## Verification\n\nStop point = targeted tests for the surface you touched, green, plus a local commit.",
  );
  assert.deepEqual(assessTransitionDocument("task.plan", pureScaffoldSection).missingSections, [
    {
      section: "Verification",
      reason: "scaffold",
      retainedScaffold: "Stop point = targeted tests for the surface you touched, gre",
    },
  ]);
  assert.equal(assessTransitionDocument("task.plan", realizedPlan()).ready, true);
});

test("closeout uses the same required-section and scaffold rules", () => {
  const template = readFileSync(
    new URL("../../preset/assets/software-coding/templates/task.closeout/zh-CN.md", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    assessTransitionDocument("task.closeout", template).missingSections.map(({ section, reason }) => ({
      section,
      reason,
    })),
    [
      { section: "Summary", reason: "scaffold" },
      { section: "Verification", reason: "scaffold" },
      { section: "Residual Risk", reason: "scaffold" },
      { section: "Same Mechanism Elsewhere", reason: "scaffold" },
    ],
  );
  assert.equal(
    assessTransitionDocument(
      "task.closeout",
      "# Closeout\n\n## Summary\n\nDone.\n\n## Verification\n\nTests passed.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nSearched the shared validator; no siblings.",
    ).ready,
    true,
  );
});

test("decision and declaration documents reject their canonical blank scaffolds", () => {
  assert.throws(
    () => assertTransitionDocumentReady("decision.body", "---\nstate: proposed\n---\n# Choice\n"),
    (error: unknown) => (error as { readonly code?: string }).code === "body_placeholder",
  );
  assert.equal(
    assessTransitionDocument("decision.body", "# Choice\n\nAdopt the shared transition validator.").ready,
    true,
  );
  assert.equal(
    assessTransitionDocument(
      "agent.instructions",
      "(To be written: this text becomes the agent's system prompt verbatim.)",
    ).code,
    "instructions_placeholder",
  );
  assert.equal(
    assessTransitionDocument("agent.instructions", "Implement bounded tasks and report evidence.").ready,
    true,
  );
  assert.equal(assessTransitionDocument("squad.roster", "## Squad Roster\n（待补写）").ready, false);
  assert.equal(
    assessTransitionDocument("squad.roster", "## Squad roster\n\n- leader: lead\n- worker: sol").ready,
    true,
  );
});

function realizedPlan(): string {
  return `# Plan\n\n${planHeadings.map((heading) => `## ${heading}\n\nImplemented ${heading}.`).join("\n\n")}\n`;
}
