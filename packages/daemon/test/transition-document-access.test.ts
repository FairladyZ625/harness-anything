// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assessTransitionDocument } from "../../kernel/src/index.ts";
import { missingSectionsHint } from "../src/transition-document-access.ts";

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

test("transition-document hints explain scaffold, empty, and ready sections line by line", () => {
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
        expectedFirst: "- Brief: 仍含模板句「One-line statement of the task objective and scope.」",
        expectedLines: 15,
      },
      {
        name: "partially realized plan",
        body: partial,
        expectedFirst: "- Brief: 仍含模板句「One-line statement of the task objective and scope.」",
        expectedLines: 2,
      },
      { name: "empty section", body: empty, expectedFirst: "- Verification: 空", expectedLines: 2 },
      {
        name: "fully realized plan",
        body: realizedPlan(),
        expectedFirst: "it has no missing required sections.",
        expectedLines: 1,
      },
    ] as const;

  for (const fixture of cases) {
    const hint = missingSectionsHint(assessTransitionDocument("task.plan", fixture.body).missingSections);
    assert.equal(hint.split("\n").length, fixture.expectedLines, fixture.name);
    assert.match(hint, new RegExp(escapeRegExp(fixture.expectedFirst), "u"), fixture.name);
  }
});

function realizedPlan(): string {
  return `# Plan\n\n${planHeadings.map((heading) => `## ${heading}\n\nImplemented ${heading}.`).join("\n\n")}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
