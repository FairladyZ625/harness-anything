// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { markdownSections } from "../src/domain/transition-document-readiness.ts";
import {
  assessTransitionDocument,
  submissionFromCloseout,
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
    "## Verification\n\nThe full gate matrix is GitHub CI's job, not this machine's.",
  );
  assert.deepEqual(assessTransitionDocument("task.plan", pureScaffoldSection).missingSections, [
    {
      section: "Verification",
      reason: "scaffold",
      retainedScaffold: "The full gate matrix is GitHub CI's job, not this machine's.",
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
  assert.deepEqual(
    assessTransitionDocument(
      "task.closeout",
      "# Closeout\n\n## Summary（交付了什么）\n\nDone.\n\n## Verification\n\nTests passed.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable.",
    ).missingSections.map(({ section }) => section),
    ["Summary"],
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

test("section reader preserves repeated risk sections and fenced heading examples", () => {
  const body = [
    "## Summary",
    "Delivered parser.",
    "## Verification",
    "Command:",
    "```markdown",
    "## Residual Risk",
    "example",
    "```",
    "Exit 0.",
    "## Residual Risk",
    "已知缺口：first unresolved issue.",
    "## Residual Risk",
    "已知缺口：second unresolved issue.",
    "## Same Mechanism Elsewhere",
    "Inspected adjacent parser.",
  ].join("\n");
  const sections = markdownSections(body);
  assert.equal(sections.get("verification"), "Command:\n```markdown\n## Residual Risk\nexample\n```\nExit 0.");
  assert.equal(
    sections.get("residual risk"),
    "已知缺口：first unresolved issue.\n\n已知缺口：second unresolved issue.",
  );
  assert.equal(assessTransitionDocument("task.closeout", body).ready, true);
});

test("fenced required headings cannot make a missing closeout section ready", () => {
  const body =
    "## Summary\nDelivery\n## Verification\n~~~\n## Residual Risk\nExample only\n~~~\n## Same Mechanism Elsewhere\nInspected.";
  assert.deepEqual(assessTransitionDocument("task.closeout", body).missingSections, [
    { section: "Residual Risk", reason: "empty" },
  ]);
});

test("closeout submission preserves all prose, repeated sections, gaps and fenced headings", () => {
  const summary = "Implemented deletion evidence.\nSecond summary paragraph.",
    verification = "- Unit tests pass.\n\n```md\n## Residual Risk\nexample only\n```",
    risk = "- 已知缺口：pending publication.\n- Accepted risk: reviewer must check deletions.",
    mechanism = "- Known gap elsewhere: sibling path unverified.\n- No filtering of prose.",
    body =
      `## Summary\n${summary}\n## Verification\n${verification}\n` +
      `## Residual Risk\n${risk}\n## Same Mechanism Elsewhere\n${mechanism}\n` +
      "## Residual Risk\nAnother known gap.",
    cut = { commitSha: "a".repeat(40), deliverables: [], outputs: ["Deleted-Production-Paths: src/old.ts"] },
    packet = submissionFromCloseout(body, cut),
    allRisks = [risk + "\n\nAnother known gap.", mechanism];
  assert.deepEqual(packet, {
    ...cut,
    completionClaim: summary,
    verificationNotes: [verification],
    knownGaps: allRisks,
    residualRisks: allRisks,
  });
});

test("closeout submission fails closed on missing or scaffold sections", () => {
  const cut = { commitSha: "a".repeat(40), deliverables: [], outputs: [] };
  for (const body of [
    "## Summary\nCompleted.\n## Verification\nTests pass.\n## Residual Risk\nKnown gap.",
    "## Summary\nSummarize the completed behavior change.\n## Verification\nTests pass.\n" +
      "## Residual Risk\nNo residual risks.\n## Same Mechanism Elsewhere\nSibling checked.",
  ]) {
    assert.throws(() => submissionFromCloseout(body, cut), { code: "closeout_placeholder" });
  }
});
