import assert from "node:assert/strict";
import test from "node:test";
import {
  checkPrGovernance,
  classifyProtectedChanges,
  deriveProtectedSurfaceRules
} from "./check-pr-governance.mjs";

function makeManifest() {
  return {
    gates: [
      {
        id: "pr-body-lint",
        changeControl: {
          requiresGovernanceEvidence: true,
          protectedSurfaces: [
            ".github/pull_request_template.md",
            "tools/check-pr-body-bilingual.mjs",
            "tools/gate-manifest.json",
            "package.json:scripts.check",
            "tools/gate-allowlists/check-import-boundaries.json",
            "packages/*/package.json"
          ]
        }
      },
      {
        id: "ordinary-gate",
        changeControl: {
          requiresGovernanceEvidence: false,
          protectedSurfaces: [
            "docs-release/ordinary.md"
          ]
        }
      }
    ]
  };
}

function bodyWithGovernance({ breakGlass = false } = {}) {
  return [
    "# English",
    "",
    "## Summary",
    "",
    "This PR changes a governance surface.",
    "",
    "## Governance Declaration",
    "",
    "- Protected surface touched: yes",
    "- Authority: ADR-0023 D5/D8 and task_01KWVTPX3AH5TG8VK4RJYXE7EZ",
    `- Break-glass: ${breakGlass ? "yes" : "no"}`,
    ...(breakGlass ? [
      "- Break-glass reason: restore main after an urgent CI outage",
      "- Break-glass scope: pr-body-lint governance declaration only",
      "- Follow-up governance task: task_01KWVTPX3AH5TG8VK4RJYXE7EZ"
    ] : []),
    "",
    "---",
    "",
    "# 中文",
    "",
    "## 概要",
    "",
    "本 PR 修改治理面。",
    "",
    "## 治理声明",
    "",
    "- 触碰 protected surface：是",
    "- 依据：ADR-0023 D5/D8 与 task_01KWVTPX3AH5TG8VK4RJYXE7EZ",
    "- Break-glass：否"
  ].join("\n");
}

test("derives protected rules from manifest changeControl only", () => {
  const rules = deriveProtectedSurfaceRules(makeManifest()).map((rule) => rule.display);

  assert.ok(rules.includes(".github/**"));
  assert.ok(rules.includes(".github/pull_request_template.md"));
  assert.ok(rules.includes("tools/gate-allowlists/**"));
  assert.ok(rules.includes("package.json"));
  assert.ok(rules.includes("packages/*/package.json"));
  assert.equal(rules.includes("docs-release/ordinary.md"), false);
});

test("ordinary PR paths skip without requiring governance declaration", () => {
  const result = checkPrGovernance({
    body: "# English\n\nOrdinary body.\n\n# 中文\n\n普通正文。",
    changedFiles: ["docs-release/guide.md"],
    manifest: makeManifest()
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.protectedChanges.length, 0);
});

test("protected .github path fails without governance declaration", () => {
  const result = checkPrGovernance({
    body: "# English\n\nNo declaration.\n\n# 中文\n\n没有声明。",
    changedFiles: [".github/workflows/rewrite-ci.yml"],
    manifest: makeManifest()
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.match(result.issues.join("\n"), /Governance Declaration/u);
  assert.deepEqual(result.protectedChanges[0].surfaces, [".github/**"]);
});

test("protected path passes with governance declaration and authority reference", () => {
  const result = checkPrGovernance({
    body: bodyWithGovernance(),
    changedFiles: ["tools/check-pr-body-bilingual.mjs"],
    manifest: makeManifest()
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
});

test("governance declaration must cite ADR decision or task evidence", () => {
  const result = checkPrGovernance({
    body: bodyWithGovernance().replaceAll("ADR-0023 D5/D8 and task_01KWVTPX3AH5TG8VK4RJYXE7EZ", "the plan").replaceAll("ADR-0023 D5/D8 与 task_01KWVTPX3AH5TG8VK4RJYXE7EZ", "计划"),
    changedFiles: ["package.json"],
    manifest: makeManifest()
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /cite at least one ADR/u);
});

test("break-glass declaration requires reason scope and follow-up task", () => {
  const result = checkPrGovernance({
    body: [
      "# English",
      "",
      "## Governance Declaration",
      "",
      "- Authority: ADR-0023 D8",
      "- Break-glass: yes",
      "",
      "# 中文",
      "",
      "## 治理声明",
      "",
      "- 依据：ADR-0023 D8",
      "- Break-glass：是"
    ].join("\n"),
    changedFiles: ["tools/gate-allowlists/check-import-boundaries.json"],
    manifest: makeManifest()
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /reason/u);
  assert.match(result.issues.join("\n"), /scope/u);
  assert.match(result.issues.join("\n"), /follow-up governance task id/u);
});

test("break-glass declaration passes with required exception fields", () => {
  const result = checkPrGovernance({
    body: bodyWithGovernance({ breakGlass: true }),
    changedFiles: ["tools/gate-allowlists/check-import-boundaries.json"],
    manifest: makeManifest()
  });

  assert.equal(result.ok, true);
});

test("classifies wildcard package surfaces", () => {
  const rules = deriveProtectedSurfaceRules(makeManifest());
  const matches = classifyProtectedChanges(["packages/cli/package.json"], rules);

  assert.equal(matches.length, 1);
  assert.ok(matches[0].surfaces.includes("packages/*/package.json"));
});
