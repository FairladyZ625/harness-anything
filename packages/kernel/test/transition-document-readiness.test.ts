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
  transitionDocumentContract,
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

const planTemplate = readFileSync(
    new URL("../../preset/assets/software-coding/templates/task.plan/en-US.md", import.meta.url),
    "utf8",
  ),
  closeoutTemplate = readFileSync(
    new URL("../../preset/assets/software-coding/templates/task.closeout/zh-CN.md", import.meta.url),
    "utf8",
  ),
  lightweightPlanTemplate = readFileSync(
    new URL("../../preset/assets/software-coding/templates/task.plan.lightweight/en-US.md", import.meta.url),
    "utf8",
  ),
  planContract = transitionDocumentContract(planTemplate),
  closeoutContract = transitionDocumentContract(closeoutTemplate),
  lightweightPlanContract = transitionDocumentContract(lightweightPlanTemplate),
  plan = (body: string) => assessTransitionDocument("task.plan", body, planContract),
  closeout = (body: string) => assessTransitionDocument("task.closeout", body, closeoutContract);

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
  const scaffold = plan(template);
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
  assert.deepEqual(plan(emptyGoal).missingSections, [{ section: "Goal", reason: "empty" }]);

  const retainedScaffold = realizedPlan().replace(
    "## Brief\n\nImplemented Brief.",
    "## Brief\n\nOne-line statement of the task objective and scope. Implement task-index/v1 for CLI consumers.",
  );
  assert.equal(plan(retainedScaffold).ready, true);
  const verificationScaffold = "- List any review and human acceptance conditions this task additionally requires.",
    pureScaffoldSection = realizedPlan().replace(
      "## Verification\n\nImplemented Verification.",
      `## Verification\n\n${verificationScaffold}`,
    );
  assert.deepEqual(plan(pureScaffoldSection).missingSections, [
    {
      section: "Verification",
      reason: "scaffold",
      retainedScaffold: verificationScaffold.slice(0, 60),
    },
  ]);
  assert.equal(plan(realizedPlan()).ready, true);
});

test("task plan accepts explanatory suffixes on every required heading", () => {
  for (const suffix of [" (context)", "（说明）", " - details", " – details", "—说明"]) {
    const body = planHeadings.map((heading) => `## ${heading}${suffix}\n\nImplemented ${heading}.`).join("\n\n");
    assert.deepEqual(plan(body).missingSections, [], suffix);
  }
});

test("task plan suffixes preserve empty and scaffold detection", () => {
  for (const suffix of [" (context)", "（说明）", " — details"]) {
    const body = realizedPlan().replace("## Required Reading", `## Required Reading${suffix}`);
    assert.deepEqual(plan(body.replace("Implemented Required Reading.", "")).missingSections, [
      { section: "Required Reading", reason: "empty" },
    ]);
    const scaffold =
      "List concrete code, document, and contract paths in reading order, with an authority level for each item. Resolve source conflicts explicitly instead of presenting contradictory inputs as peers.";
    assert.deepEqual(plan(body.replace("Implemented Required Reading.", scaffold)).missingSections, [
      { section: "Required Reading", reason: "scaffold", retainedScaffold: scaffold.slice(0, 60) },
    ]);
  }
  const template = readFileSync(
    new URL("../../preset/assets/software-coding/templates/task.plan/en-US.md", import.meta.url),
    "utf8",
  ).replace(/^(## .+)$/gmu, "$1 (details)");
  assert.deepEqual(
    plan(template).missingSections.map(({ section, reason }) => ({ section, reason })),
    planHeadings.map((section) => ({ section, reason: "scaffold" })),
  );
});

test("task plan suffix matching respects heading boundaries and fenced examples", () => {
  for (const heading of ["Required ReadingList", "Required Reading Optional", "Required Reading: optional"]) {
    assert.deepEqual(plan(realizedPlan().replace("## Required Reading", `## ${heading}`)).missingSections, [
      { section: "Required Reading", reason: "empty" },
    ]);
  }
  const body = realizedPlan().replace("## Required Reading\n\nImplemented Required Reading.", "");
  assert.deepEqual(plan(body + "\n```md\n## Required Reading (example)\nRead file.\n```").missingSections, [
    { section: "Required Reading", reason: "empty" },
  ]);
  assert.equal(plan(body + "\n## Required Reading (first)\nRead file.\n## Required Reading—second\n").ready, true);
});

test("closeout uses the same required-section and scaffold rules", () => {
  const template = readFileSync(
    new URL("../../preset/assets/software-coding/templates/task.closeout/zh-CN.md", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    closeout(template).missingSections.map(({ section, reason }) => ({
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
    closeout(
      "# Closeout\n\n## Summary\n\nDone.\n\n## Verification\n\nTests passed.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nSearched the shared validator; no siblings.",
    ).ready,
    true,
  );
  assert.deepEqual(
    closeout(
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
    assessTransitionDocument(
      "decision.body",
      "# Choice\n\n## 背景\n\nKnown facts.\n\n## 权衡\n\nCompared options.\n\n## 结论\n\nAdopt it.",
    ).ready,
    true,
  );
  assert.deepEqual(
    assessTransitionDocument(
      "decision.body",
      "## 背景\n\n说明需要裁定的问题与已知事实。\n\n## 权衡\n\n说明所选方案、被拒方案与取舍理由。\n\n" +
        "## 结论\n\n说明最终裁定及其适用范围。",
    ).missingSections.map(({ section, reason }) => ({ section, reason })),
    [
      { section: "背景", reason: "scaffold" },
      { section: "权衡", reason: "scaffold" },
      { section: "结论", reason: "scaffold" },
    ],
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

test("the readiness contract derives required sections and scaffold phrases from the scaffold itself", () => {
  const contract = transitionDocumentContract(
    "# Title\n\n## Alpha\n\nWrite something.\n\n```md\n## Hidden\nignore me\n```\n\n## Beta\n\nLine one.\nLine two.\n",
  );
  assert.deepEqual(contract.requiredSections, ["Alpha", "Beta"]);
  assert.deepEqual(contract.scaffoldBySection["Alpha"], ["Write something."]);
  assert.deepEqual(contract.scaffoldBySection["Beta"], ["Line one.", "Line two."]);
  assert.throws(() => assessTransitionDocument("task.plan", realizedPlan()), {
    code: "scaffold_unavailable",
  });
  assert.throws(() => assertTransitionDocumentReady("task.closeout", "## Summary\nDone."), {
    code: "scaffold_unavailable",
  });
});

test("the lightweight three-section scaffold passes once filled and rejects retained placeholders", () => {
  assert.deepEqual(lightweightPlanContract.requiredSections, ["Brief", "Context", "Verification"]);
  const untouched = assessTransitionDocument("task.plan", lightweightPlanTemplate, lightweightPlanContract);
  assert.equal(untouched.ready, false);
  assert.deepEqual(
    untouched.missingSections.map(({ section, reason }) => ({ section, reason })),
    [
      { section: "Brief", reason: "scaffold" },
      { section: "Context", reason: "scaffold" },
      { section: "Verification", reason: "scaffold" },
    ],
  );
  const filled = lightweightPlanTemplate
      .replace(
        "State the task's goal and scope in one line, plus the deliverable's shape and landing point.",
        "Fix plan readiness for lightweight tasks.",
      )
      .replace(
        "Record inputs, known facts, and constraints: relevant code and document paths, out-of-bounds areas, stop conditions.",
        "Kernel readiness judged a hardcoded 14-section list.",
      )
      .replace(
        "List acceptance: the targeted tests and checks that must go green, required negative controls, and the stop point.",
        "Dispatch and settle both accept the three-section plan.",
      ),
    retained = filled.replace(
      "Dispatch and settle both accept the three-section plan.",
      "List acceptance: the targeted tests and checks that must go green, required negative controls, and the stop point.",
    );
  assert.equal(assessTransitionDocument("task.plan", filled, lightweightPlanContract).ready, true);
  assert.deepEqual(
    assessTransitionDocument("task.plan", retained, lightweightPlanContract).missingSections.map(
      ({ section, reason }) => ({ section, reason }),
    ),
    [{ section: "Verification", reason: "scaffold" }],
  );
});

test("a filled three-section plan still fails the baseline fourteen-section contract", () => {
  const missing = plan(
    "## Brief\n\nFix it.\n\n## Context\n\nFacts.\n\n## Verification\n\nTests green.",
  ).missingSections;
  assert.equal(missing.length, planHeadings.length - 3);
  assert.ok(missing.every(({ reason }) => reason === "empty"));
});

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
  assert.equal(closeout(body).ready, true);
});

test("fenced required headings cannot make a missing closeout section ready", () => {
  const body =
    "## Summary\nDelivery\n## Verification\n~~~\n## Residual Risk\nExample only\n~~~\n## Same Mechanism Elsewhere\nInspected.";
  assert.deepEqual(closeout(body).missingSections, [{ section: "Residual Risk", reason: "empty" }]);
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
    packet = submissionFromCloseout(body, cut, closeoutContract),
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
  const cut = { commitSha: "a".repeat(40), deliverables: [], outputs: [] },
    summaryScaffold = closeoutContract.scaffoldBySection["Summary"]![0]!;
  for (const body of [
    "## Summary\nCompleted.\n## Verification\nTests pass.\n## Residual Risk\nKnown gap.",
    `## Summary\n${summaryScaffold}\n## Verification\nTests pass.\n` +
      "## Residual Risk\nNo residual risks.\n## Same Mechanism Elsewhere\nSibling checked.",
  ]) {
    assert.throws(() => submissionFromCloseout(body, cut, closeoutContract), { code: "closeout_placeholder" });
  }
});
