// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkPrBody } from "../../check-pr-body.mjs";
import { checkPrGovernance } from "../../check-pr-governance.mjs";
import { combinePrBodies, replaceSection } from "../combine-pr-bodies.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const template = readFileSync(path.join(repoRoot, ".github/pull_request_template.md"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "tools/gate-manifest.json"), "utf8"));

function body({
  summary,
  whatChanged = "- One coherent change.",
  verification = "- node --test tools/gates/test/combine-pr-bodies.test.mjs",
  risk = "No known risk.",
  dependency = "Dependency-Change: none",
  eventMigration = null,
  governance = "- Protected surface touched: no\n- Authority: not applicable",
  claims = null,
  chinese = null,
}) {
  let rendered = replaceSection(template, "Summary", summary);
  rendered = replaceSection(rendered, "What Changed", whatChanged);
  rendered = replaceSection(rendered, "Verification", verification);
  rendered = replaceSection(rendered, "Residual Risk", risk);
  rendered = replaceSection(
    rendered,
    "Machine-Readable Declarations",
    [dependency, eventMigration, claims].filter(Boolean).join("\n\n"),
  );
  rendered = replaceSection(rendered, "Governance Declaration", governance);
  if (chinese) rendered = `${rendered.replace(/\s+$/u, "")}\n\n# 中文\n\n${chinese}\n`;
  return rendered;
}

function protectedFiles() {
  return ["package.json", ".github/workflows/pr-body.yml"];
}

test("a combined manual-train body carries one dependency line and one governance declaration", () => {
  const first = body({
    summary: "Adds the local PR-body aggregate entry.",
    dependency: "Dependency-Change: bump effect to 2.0.0",
    eventMigration: "Event-Migration: none — no canonical-event sample changes",
    governance: "- Protected surface touched: yes\n- Authority: dec_ABC123",
    claims: [
      "CI-Attribution: the aggregate entry ran every body gate",
      "run-url: https://github.com/example/repo/actions/runs/123456",
      "commit-sha: 0123456789abcdef0123456789abcdef01234567",
      "failed-test: none",
      "scope: pr-body",
      "owner: platform",
    ].join("\n"),
  });
  const second = body({
    summary: "Adds the manual-train body combiner.",
    dependency: "Dependency-Change: add package train-fixture at 1.0.0",
    governance: "- Protected surface touched: yes\n- Authority: task_01HZZZZZZZZZZZZZZZZZZZZZZZ",
    chinese: "## 摘要\n\n组合正文生成器。\n\n## 验证\n\n组合测试通过。",
  });

  const combined = combinePrBodies({
    sources: [
      { label: "PR #1", body: first },
      { label: "PR #2", body: second },
    ],
    template,
  });

  const dependencyLines = [...combined.matchAll(/^Dependency-Change:.*$/gmu)];
  assert.equal(dependencyLines.length, 1);
  assert.match(dependencyLines[0][0], /bump effect to 2\.0\.0/u);
  assert.match(dependencyLines[0][0], /add package train-fixture/u);
  assert.equal([...combined.matchAll(/^## Governance Declaration$/gmu)].length, 1);
  assert.match(combined, /Authority: dec_ABC123/u);
  assert.match(combined, /Authority: task_01HZZZZZZZZZZZZZZZZZZZZZZZ/u);
  assert.equal([...combined.matchAll(/^Event-Migration:/gmu)].length, 1);
  assert.equal([...combined.matchAll(/^CI-Attribution:/gmu)].length, 1);
  assert.match(combined, /^# 中文$/mu);
  assert.match(combined, /^## 摘要$/mu);
  assert.match(combined, /组合正文生成器/u);

  assert.equal(checkPrBody(combined, { prTemplate: template }).ok, true);
  assert.equal(checkPrGovernance({ body: combined, changedFiles: protectedFiles(), manifest }).ok, true);
});

test("different member event migrations fail closed instead of picking one silently", () => {
  const first = body({ summary: "first", eventMigration: "Event-Migration: ha migrate alpha" });
  const second = body({ summary: "second", eventMigration: "Event-Migration: ha migrate beta" });

  assert.throws(
    () =>
      combinePrBodies({
        sources: [
          { label: "PR #1", body: first },
          { label: "PR #2", body: second },
        ],
        template,
      }),
    /different event migrations/u,
  );
});

test("a member body without a required section fails closed and names it", () => {
  const first = replaceSection(body({ summary: "first" }), "Verification", "-");
  const second = replaceSection(body({ summary: "second" }), "Verification", "-");

  assert.throws(
    () =>
      combinePrBodies({
        sources: [
          { label: "PR #1", body: first },
          { label: "PR #2", body: second },
        ],
        template,
      }),
    /## Verification/u,
  );
});

test("the combined body preserves each member's required prose under its own heading", () => {
  const combined = combinePrBodies({
    sources: [
      { label: "PR #1", body: body({ summary: "First summary." }) },
      { label: "PR #2", body: body({ summary: "Second summary." }) },
    ],
    template,
  });

  assert.match(combined, /### PR #1\n\nFirst summary\./u);
  assert.match(combined, /### PR #2\n\nSecond summary\./u);
  assert.ok(combined.indexOf("First summary.") < combined.indexOf("Second summary."));
});

test("a member with two Dependency-Change lines fails closed instead of merging them away", () => {
  const first = body({ summary: "first" });
  const second = replaceSection(
    body({ summary: "second" }),
    "Machine-Readable Declarations",
    "Dependency-Change: bump effect\nDependency-Change: add package train-fixture",
  );

  assert.throws(
    () =>
      combinePrBodies({
        sources: [
          { label: "PR #1", body: first },
          { label: "PR #2", body: second },
        ],
        template,
      }),
    /PR #2 has 2 Dependency-Change lines/u,
  );
});

test("a member with two Event-Migration lines fails closed", () => {
  const first = body({ summary: "first" });
  const second = replaceSection(
    body({ summary: "second" }),
    "Machine-Readable Declarations",
    "Dependency-Change: none\n\nEvent-Migration: ha migrate alpha\nEvent-Migration: ha migrate alpha",
  );

  assert.throws(
    () =>
      combinePrBodies({
        sources: [
          { label: "PR #1", body: first },
          { label: "PR #2", body: second },
        ],
        template,
      }),
    /PR #2 has 2 Event-Migration lines/u,
  );
});
