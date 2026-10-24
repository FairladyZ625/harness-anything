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
  "Execution Surface",
  "Constraints",
  "Deliverable Contract",
  "Evidence Protocol",
  "Verification",
] as const;

const legacyPlanHeadings = [
  "Brief",
  "Goal",
  "Context",
  "Required Reading",
  "Entry Conditions",
  "Dependencies",
  "Execution Surface",
  "Constraints",
  "Checkpoint",
  "Implementation Plan",
  "Deliverable Contract",
  "Evidence Protocol",
  "Verification",
] as const;

const planTemplate = readFileSync(
    new URL("../../preset/assets/software-coding/templates/task.plan.v2/en-US.md", import.meta.url),
    "utf8",
  ),
  legacyPlanTemplate = readFileSync(
    new URL("../../preset/assets/software-coding/templates/task.plan/en-US.md", import.meta.url),
    "utf8",
  ),
  closeoutTemplate = readFileSync(
    new URL("../../preset/assets/software-coding/templates/task.closeout/zh-CN.md", import.meta.url),
    "utf8",
  ),
  lightweightCloseoutTemplate = readFileSync(
    new URL("../../preset/assets/software-coding/templates/task.closeout.lightweight/en-US.md", import.meta.url),
    "utf8",
  ),
  lightweightPlanTemplate = readFileSync(
    new URL("../../preset/assets/software-coding/templates/task.plan.lightweight/en-US.md", import.meta.url),
    "utf8",
  ),
  planContract = transitionDocumentContract(planTemplate),
  legacyPlanContract = transitionDocumentContract(legacyPlanTemplate),
  lightweightPlanContract = transitionDocumentContract(lightweightPlanTemplate),
  plan = (body: string) => assessTransitionDocument("task.plan", body, planContract),
  legacyPlan = (body: string) => assessTransitionDocument("task.plan", body, legacyPlanContract);

test("transition document bindings enumerate canonical consumers and omit work closeout without a transition", () => {
  assert.deepEqual(
    ["task.start", "runtime.run", "squad.run", "decision.accept", "agent.install", "squad.install"].map(
      (transition) => `${transition}:${requireTransitionDocumentKind(transition)}`,
    ),
    [
      "task.start:task.plan",
      "runtime.run:task.plan",
      "squad.run:task.plan",
      "decision.accept:decision.body",
      "agent.install:agent.instructions",
      "squad.install:squad.roster",
    ],
  );
  // dec_E369B8616F50A6208B293997E7 CH2: a closeout is authored prose. `task.complete` names no
  // readiness-judged document, so completion never compares it to a scaffold and never rejects it
  // for retaining a template sentence. `work.closeout` still has no transition of its own.
  assert.throws(() => requireTransitionDocumentKind("task.complete"), /no canonical document binding/u);
  assert.throws(() => requireTransitionDocumentKind("work.closeout"), /no canonical document binding/u);
});

test("task document readiness resolves a dotted transition id directly from its descriptor", () => {
  const transition = "task.start",
    action = getTaskActionForTransition(transition);
  assert.equal(action?.id, "start");
  assert.equal(
    action?.managedDocuments.find(({ readinessRequired }) => readinessRequired)?.slot,
    requireTransitionDocumentKind(transition),
  );
  assert.equal(
    getTaskActionForTransition("task.complete")?.managedDocuments.some(({ readinessRequired }) => readinessRequired),
    false,
  );
});

test("task plan rejects pure scaffolds but accepts a retained scaffold sentence plus concrete content", () => {
  const scaffold = plan(planTemplate);
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
  const verificationScaffold = planContract.scaffoldBySection.Verification![0]!,
    pureScaffoldSection = realizedPlan().replace(
      "## Verification\n\nImplemented Verification.",
      `## Verification\n\n${verificationScaffold}`,
    );
  assert.deepEqual(plan(pureScaffoldSection).missingSections, []);
  assert.equal(plan(realizedPlan()).ready, true);
});

test("a frozen 13-section contract still judges the old section list", () => {
  assert.deepEqual(legacyPlanContract.requiredSections, legacyPlanHeadings);
  assert.deepEqual(
    legacyPlan(realizedPlan()).missingSections.map(({ section }) => section),
    ["Entry Conditions", "Dependencies", "Checkpoint", "Implementation Plan"],
  );
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
      "List concrete code, document, and contract paths in reading order, with an authority level for each item. Resolve source conflicts explicitly instead of presenting contradictory inputs as peers. A decision cited by the plan is read from the ledger at start time; a superseded decision yields to its successor.";
    assert.deepEqual(plan(body.replace("Implemented Required Reading.", scaffold)).missingSections, [
      { section: "Required Reading", reason: "scaffold", retainedScaffold: scaffold.slice(0, 60) },
    ]);
  }
  const template = planTemplate.replace(/^(## .+)$/gmu, "$1 (details)");
  assert.deepEqual(
    plan(template).missingSections.map(({ section, reason }) => ({ section, reason })),
    planHeadings.map((section) => ({ section, reason: "scaffold" })),
  );
});

test("task-plan operating rules remain valid while business sections are authored", () => {
  const authored = planHeadings
    .map((heading) => {
      if (["Execution Surface", "Verification"].includes(heading)) return null;
      return `## ${heading}\n\nAuthored ${heading}.`;
    })
    .filter((section): section is string => section !== null)
    .join("\n\n");
  const body =
    `${authored}\n\n## Execution Surface\n\n${planContract.scaffoldBySection["Execution Surface"]!.join("\n")}\n\n` +
    `## Verification\n\n${planContract.scaffoldBySection.Verification!.join("\n")}\n`;
  assert.equal(plan(body).ready, true);
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

test("a closeout is never judged against its scaffold: the template body submits as authored", () => {
  const cut = { commitSha: "c".repeat(40), deliverables: [], outputs: [] },
    packet = submissionFromCloseout(closeoutTemplate, cut);
  // The template materialized by task create is valid authored prose. Summary carries the
  // scaffold's own sentence; that sentence is what the frozen submission records as the claim.
  assert.equal(packet.completionClaim.startsWith("总结完成的行为变化及其意义。"), true);
  assert.equal(packet.verificationNotes.length, 1);
  assert.deepEqual(packet.knownGaps, packet.residualRisks);
  // Section heading suffixes and missing optional sections are prose choices, not rejections.
  const suffixed = submissionFromCloseout(
    "# Closeout\n\n## Summary（交付了什么）\n\nDone.\n\n## Verification\n\nTests passed.\n",
    cut,
  );
  assert.equal(suffixed.completionClaim, "Done.");
  assert.deepEqual(suffixed.verificationNotes, ["Tests passed."]);
  assert.deepEqual(suffixed.knownGaps, []);
  assert.deepEqual(suffixed.residualRisks, []);
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

test("a standing stop-condition rule kept verbatim from the scaffold does not block plan readiness", () => {
  const standingRules = {
    "en-US":
      "If this task is not a CI/gate/governance task but requires modifying CI/gate authority surfaces to pass, stop implementation, record the blocker, and request or create a governance task. Explicit CI/gate/governance tasks and break-glass main recovery are the only exceptions; break-glass must record reason, scope, and a follow-up governance task.",
    "zh-CN":
      "如果本任务不是 CI/gate/governance 任务，却需要修改 CI/gate 权威面才能通过，停止实现，记录 blocker，并请求或创建治理任务。唯一例外是任务明确授权 CI/gate/governance 改动，或紧急修复 main 的 break-glass；break-glass 必须记录原因、范围和后续治理任务。",
  } as const;
  for (const [locale, standingRule] of Object.entries(standingRules)) {
    const contract = transitionDocumentContract(
        readFileSync(
          new URL(`../../preset/assets/software-coding/templates/task.plan/${locale}.md`, import.meta.url),
          "utf8",
        ),
      ),
      authored = contract.requiredSections
        .filter((heading) => heading !== "CI/Gate Authority Stop Condition")
        .map((heading) => `## ${heading}\n\nAuthored ${heading}.`);
    assert.deepEqual(
      assessTransitionDocument(
        "task.plan",
        `# Plan\n\n${[...authored, `## CI/Gate Authority Stop Condition\n\n${standingRule}`].join("\n\n")}\n`,
        contract,
      ).missingSections,
      [],
      locale,
    );
  }
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
        "List acceptance: the targeted tests and checks that must go green, and the stop point; add a negative control when the task repairs a defect.",
        "Dispatch and settle both accept the three-section plan.",
      ),
    retained = filled.replace(
      "Dispatch and settle both accept the three-section plan.",
      "List acceptance: the targeted tests and checks that must go green, and the stop point; add a negative control when the task repairs a defect.",
    );
  assert.equal(assessTransitionDocument("task.plan", filled, lightweightPlanContract).ready, true);
  assert.deepEqual(
    assessTransitionDocument("task.plan", retained, lightweightPlanContract).missingSections.map(
      ({ section, reason }) => ({ section, reason }),
    ),
    [{ section: "Verification", reason: "scaffold" }],
  );
});

test("a filled three-section plan still fails the full baseline contract", () => {
  const body = "## Brief\n\nFix it.\n\n## Context\n\nFacts.\n\n## Verification\n\nTests green.",
    missing = plan(body).missingSections;
  assert.equal(missing.length, planHeadings.length - 3);
  assert.ok(missing.every(({ reason }) => reason === "empty"));
  const legacyMissing = legacyPlan(body).missingSections;
  assert.equal(legacyMissing.length, legacyPlanHeadings.length - 3);
  assert.ok(legacyMissing.every(({ reason }) => reason === "empty"));
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
  assert.deepEqual(submissionFromCloseout(body, { commitSha: "f".repeat(40), deliverables: [], outputs: [] }), {
    commitSha: "f".repeat(40),
    deliverables: [],
    outputs: [],
    completionClaim: "Delivered parser.",
    verificationNotes: ["Command:\n```markdown\n## Residual Risk\nexample\n```\nExit 0."],
    knownGaps: [
      "已知缺口：first unresolved issue.\n\n已知缺口：second unresolved issue.",
      "Inspected adjacent parser.",
    ],
    residualRisks: [
      "已知缺口：first unresolved issue.\n\n已知缺口：second unresolved issue.",
      "Inspected adjacent parser.",
    ],
  });
});

test("a fenced heading example stays inside its real section and never becomes one", () => {
  const body =
    "## Summary\nDelivery\n## Verification\n~~~\n## Residual Risk\nExample only\n~~~\n## Same Mechanism Elsewhere\nInspected.";
  // The reader still treats a fenced `## ` line as content, so the example cannot pose as a section.
  assert.equal(markdownSections(body).get("verification"), "~~~\n## Residual Risk\nExample only\n~~~");
  assert.deepEqual(
    submissionFromCloseout(body, { commitSha: "d".repeat(40), deliverables: [], outputs: [] }).knownGaps,
    ["Inspected."],
  );
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

test("closeout submission derives prose without failing on sections the author omitted", () => {
  const cut = { commitSha: "a".repeat(40), deliverables: [], outputs: [] };
  for (const body of [
    "## Summary\nCompleted.\n## Verification\nTests pass.\n## Residual Risk\nKnown gap.",
    // The canonically materialized template, untouched, is a valid submission.
    closeoutTemplate,
  ]) {
    const packet = submissionFromCloseout(body, cut);
    assert.equal(packet.completionClaim.length > 0, true);
    assert.notEqual(packet.completionClaim, "");
  }
});

test("a closeout body without a Summary heading answers with its own prose", () => {
  const cut = { commitSha: "e".repeat(40), deliverables: [], outputs: [] },
    packet = submissionFromCloseout("# Closeout\n\nDelivered the change.\n", cut);
  assert.equal(packet.completionClaim, "Delivered the change.");
  assert.deepEqual(packet.verificationNotes, []);
});

test("the lightweight closeout submits without risk sections and keeps its own Verification prose", () => {
  const sha = "b".repeat(40),
    body = `## Summary\nDelivered ${sha}.\n## Verification\nnode tools/x.test.mjs — exit 0.`,
    cut = { commitSha: sha, deliverables: [], outputs: [] },
    packet = submissionFromCloseout(body, cut);
  assert.deepEqual(packet, {
    ...cut,
    completionClaim: `Delivered ${sha}.`,
    verificationNotes: ["node tools/x.test.mjs — exit 0."],
    knownGaps: [],
    residualRisks: [],
  });
  // The lightweight template itself is a valid authored body: its prompt sentences are content.
  const untouched = submissionFromCloseout(lightweightCloseoutTemplate, cut);
  assert.equal(untouched.completionClaim.startsWith("Summarize the completed behavior change."), true);
});
