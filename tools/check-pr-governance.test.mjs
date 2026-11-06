// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkPrGovernance,
  classifyProtectedChanges,
  deriveProtectedSurfaceRules,
  readChangedFiles,
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
            "tools/check-pr-body.mjs",
            "tools/gate-manifest.json",
            "package.json:scripts.check",
            "tools/gate-allowlists/check-import-boundaries.json",
            "packages/*/package.json",
          ],
        },
      },
      {
        id: "ordinary-gate",
        changeControl: {
          requiresGovernanceEvidence: false,
          protectedSurfaces: ["docs-release/ordinary.md"],
        },
      },
    ],
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
    ...(breakGlass
      ? [
          "## Governance Exception",
          "",
          "- Break-glass: yes",
          "- Break-glass reason: restore main after an urgent CI outage",
          "- Break-glass scope: pr-body-lint governance declaration only",
          "- Follow-up governance task: task_01KWVTPX3AH5TG8VK4RJYXE7EZ",
        ]
      : []),
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
    manifest: makeManifest(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.protectedChanges.length, 0);
});

test("protected .github path fails without governance declaration", () => {
  const result = checkPrGovernance({
    body: "# English\n\nNo declaration.\n\n# 中文\n\n没有声明。",
    changedFiles: [".github/workflows/rewrite-ci.yml"],
    manifest: makeManifest(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.match(result.issues.join("\n"), /Governance Declaration/u);
  assert.deepEqual(result.protectedChanges[0].surfaces, [".github/**"]);
});

test("protected path passes with governance declaration and authority reference", () => {
  const result = checkPrGovernance({
    body: bodyWithGovernance(),
    changedFiles: ["tools/check-pr-body.mjs"],
    manifest: makeManifest(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
});

test("governance declaration must cite ADR decision or task evidence", () => {
  const result = checkPrGovernance({
    body: bodyWithGovernance()
      .replaceAll("ADR-0023 D5/D8 and task_01KWVTPX3AH5TG8VK4RJYXE7EZ", "the plan")
      .replaceAll("ADR-0023 D5/D8 与 task_01KWVTPX3AH5TG8VK4RJYXE7EZ", "计划"),
    changedFiles: ["package.json"],
    manifest: makeManifest(),
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /cite at least one ADR/u);
});

test("break-glass declaration requires reason scope and follow-up task", () => {
  const result = checkPrGovernance({
    body: [
      "# English",
      "",
      "## Governance Exception",
      "",
      "- Authority: ADR-0023 D8",
      "- Break-glass: yes",
      "",
      "# 中文",
      "",
      "## 治理例外",
      "",
      "- 依据：ADR-0023 D8",
      "- Break-glass：是",
    ].join("\n"),
    changedFiles: ["tools/gate-allowlists/check-import-boundaries.json"],
    manifest: makeManifest(),
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
    manifest: makeManifest(),
  });

  assert.equal(result.ok, true);
});

test("break-glass follow-up accepts both real task id shapes", () => {
  for (const followUpId of ["task_f7cc215a54a194898ad733c20a", "task_01KWVTPX3AH5TG8VK4RJYXE7EZ"]) {
    const result = checkPrGovernance({
      body: [
        "# English",
        "",
        "## Governance Exception",
        "",
        "- Authority: ADR-0023 D8",
        "- Break-glass: yes",
        "- Break-glass reason: restore main after an urgent CI outage",
        "- Break-glass scope: pr-body-lint governance declaration only",
        `- Follow-up governance task: ${followUpId}`,
      ].join("\n"),
      changedFiles: ["tools/gate-allowlists/check-import-boundaries.json"],
      manifest: makeManifest(),
    });

    assert.equal(result.ok, true, `${followUpId}: ${result.issues.join("; ")}`);
  }
});

test("break-glass follow-up rejects ids that are not one of the two real shapes", () => {
  for (const followUpId of ["task_2301", "task_abc", "task_f7cc215a54a194898ad733c20"]) {
    const result = checkPrGovernance({
      body: [
        "## Governance Exception",
        "",
        "- Authority: ADR-0023 D8",
        "- Break-glass: yes",
        "- Break-glass reason: restore main after an urgent CI outage",
        "- Break-glass scope: pr-body-lint governance declaration only",
        `- Follow-up governance task: ${followUpId}`,
      ].join("\n"),
      changedFiles: ["tools/gate-allowlists/check-import-boundaries.json"],
      manifest: makeManifest(),
    });

    assert.equal(result.ok, false, followUpId);
    assert.match(result.issues.join("\n"), /follow-up governance task id/u);
  }
});

test("governance citation does not count a task token outside the two real shapes", () => {
  const result = checkPrGovernance({
    body: "## Governance Declaration\n\n- Authority: task_2301",
    changedFiles: ["package.json"],
    manifest: makeManifest(),
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /cite at least one ADR/u);
});

test("break-glass declaration rejects an empty reason before the scope line", () => {
  const result = checkPrGovernance({
    body: bodyWithGovernance({ breakGlass: true }).replace(
      "- Break-glass reason: restore main after an urgent CI outage",
      "- Break-glass reason:",
    ),
    changedFiles: ["tools/gate-allowlists/check-import-boundaries.json"],
    manifest: makeManifest(),
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /non-empty break-glass reason/u);
});

for (const heading of ["Governance Exception", "治理例外"]) {
  test(`a standalone ${heading} emergency declaration authorizes protected changes`, () => {
    const body = `## ${heading}\n- Break-glass: yes\n- Break-glass reason: restore main\n- Break-glass scope: package.json\n- Follow-up governance task: task_f7cc215a54a194898ad733c20a`,
      result = checkPrGovernance({ body, changedFiles: ["package.json"], manifest: makeManifest() });
    assert.equal(result.ok, true, result.issues.join("\n"));
  });
}

test("manual notes cannot supply the missing system authority without an emergency declaration", () => {
  const result = checkPrGovernance({
    body: "## Governance Declaration\n- Authority: not applicable\n\n## Governance Exception\n- Note: discuss ADR-0023",
    changedFiles: ["package.json"],
    manifest: makeManifest(),
  });
  assert.equal(result.ok, false);
});

test("a valid system declaration does not hide incomplete manual emergency fields", () => {
  const result = checkPrGovernance({
    body: `${bodyWithGovernance()}\n## Governance Exception\n- Break-glass: yes`,
    changedFiles: ["package.json"],
    manifest: makeManifest(),
  });
  assert.equal(result.ok, false);
  for (const required of ["break-glass reason", "break-glass scope", "follow-up governance task"])
    assert.ok(
      result.issues.some((issue) => issue.includes(required)),
      result.issues.join("\n"),
    );
});

test("a manual emergency uses its own fields rather than fields from the system section", () => {
  const result = checkPrGovernance({
    body: `## Governance Declaration\n- Authority: ADR-0023\n- Reason: unrelated system prose\n- Scope: unrelated scope\n- Follow-up governance task: task_f7cc215a54a194898ad733c20a\n\n## Governance Exception\n- Break-glass: yes`,
    changedFiles: ["package.json"],
    manifest: makeManifest(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 3);
});

test("classifies wildcard package surfaces", () => {
  const rules = deriveProtectedSurfaceRules(makeManifest());
  const matches = classifyProtectedChanges(["packages/cli/package.json"], rules);

  assert.equal(matches.length, 1);
  assert.ok(matches[0].surfaces.includes("packages/*/package.json"));
});

test("changed files are the branch's own commits, not what the base branch merged meanwhile", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pr-governance-diff-"));
  const git = (...args) =>
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      encoding: "utf8",
    }).trim();
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(root, "README.md"), "base\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(path.join(root, "feature.txt"), "feature\n");
    git("add", "feature.txt");
    git("commit", "-q", "-m", "feature");
    git("checkout", "-q", "main");
    writeFileSync(path.join(root, "protected.mjs"), "merged on main later\n");
    git("add", "protected.mjs");
    git("commit", "-q", "-m", "main moves");
    const base = git("rev-parse", "main"),
      head = git("rev-parse", "feature");
    assert.deepEqual(readChangedFiles({ root, changedFilesPath: null, changedFilesText: null, base, head }), [
      "feature.txt",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing base/head derives the diff context from merge-base with origin/main", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pr-governance-local-"));
  const git = (...args) =>
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      encoding: "utf8",
    }).trim();
  try {
    git("init", "-q");
    writeFileSync(path.join(root, "README.md"), "base\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(path.join(root, "feature.txt"), "feature\n");
    git("add", "feature.txt");
    git("commit", "-q", "-m", "feature");
    assert.deepEqual(readChangedFiles({ root, changedFilesPath: null, changedFilesText: null, base: "", head: "" }), [
      "feature.txt",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing base/head without origin/main fails closed with a fix", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pr-governance-no-base-"));
  const git = (...args) =>
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      encoding: "utf8",
    }).trim();
  try {
    git("init", "-q");
    writeFileSync(path.join(root, "README.md"), "base\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "base");
    assert.throws(
      () => readChangedFiles({ root, changedFilesPath: null, changedFilesText: null, base: "", head: "" }),
      /git fetch origin main/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
