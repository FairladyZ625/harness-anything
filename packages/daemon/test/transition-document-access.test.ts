// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assessTransitionDocument } from "../../kernel/src/index.ts";

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

test("transition-document readiness reports scaffold and empty sections as structured entries", () => {
  const template = readFileSync(
      new URL("../../preset/assets/software-coding/templates/task.plan/en-US.md", import.meta.url),
      "utf8",
    ),
    partial = realizedPlan().replace(
      "## Brief\n\nImplemented Brief.",
      "## Brief\n\nOne-line statement of the task objective and scope.",
    ),
    empty = realizedPlan().replace("## Verification\n\nImplemented Verification.", "## Verification\n\n"),
    cases = [
      {
        name: "all-template plan",
        body: template,
        expectedFirst: {
          section: "Brief",
          reason: "scaffold",
          retainedScaffold: "One-line statement of the task objective and scope.",
        },
        expectedEntries: 14,
      },
      {
        name: "partially realized plan",
        body: partial,
        expectedFirst: {
          section: "Brief",
          reason: "scaffold",
          retainedScaffold: "One-line statement of the task objective and scope.",
        },
        expectedEntries: 1,
      },
      {
        name: "empty section",
        body: empty,
        expectedFirst: { section: "Verification", reason: "empty" },
        expectedEntries: 1,
      },
      {
        name: "fully realized plan",
        body: realizedPlan(),
        expectedFirst: undefined,
        expectedEntries: 0,
      },
    ] as const;

  for (const fixture of cases) {
    const missing = assessTransitionDocument("task.plan", fixture.body).missingSections;
    assert.equal(missing.length, fixture.expectedEntries, fixture.name);
    assert.deepEqual(missing[0], fixture.expectedFirst, fixture.name);
  }
});

function realizedPlan(): string {
  return `# Plan\n\n${planHeadings.map((heading) => `## ${heading}\n\nImplemented ${heading}.`).join("\n\n")}\n`;
}
