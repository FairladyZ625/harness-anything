import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkLocaleContent, findHeadingFailures } from "./check-locale-content.mjs";

test("findHeadingFailures accepts zh-CN headings with CJK characters", () => {
  const failures = findHeadingFailures("# 模块计划\n\n## ADR 决策\n\n### Gate 规则\n", "sample/zh-CN.md");
  assert.deepEqual(failures, []);
});

test("findHeadingFailures rejects level 1 to 3 zh-CN headings without CJK characters", () => {
  const failures = findHeadingFailures("# Module Plan\n\n#### Allowed Deep Heading\n\n## ADR\n\n### Gate\n", "sample/zh-CN.md");
  assert.deepEqual(failures, [
    "sample/zh-CN.md:1: zh-CN heading must contain at least one CJK character: # Module Plan",
    "sample/zh-CN.md:5: zh-CN heading must contain at least one CJK character: ## ADR",
    "sample/zh-CN.md:7: zh-CN heading must contain at least one CJK character: ### Gate"
  ]);
});

test("findHeadingFailures ignores fenced code blocks", () => {
  const failures = findHeadingFailures("```md\n# Module Plan\n```\n\n# 模块计划\n", "sample/zh-CN.md");
  assert.deepEqual(failures, []);
});

test("checkLocaleContent checks the governed zh-CN template set", () => {
  const root = mkdtempSync(path.join(tmpdir(), "locale-content-"));
  for (const name of [
    "module.plan",
    "module.brief",
    "gate-retro.analysis",
    "repository.adr.template",
    "repository.adr.readme",
    "module.session.prompt"
  ]) {
    const directory = path.join(root, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "zh-CN.md"), "# 中文标题\n", "utf8");
  }
  const ignoredDirectory = path.join(root, "not-yet-governed");
  mkdirSync(ignoredDirectory, { recursive: true });
  writeFileSync(path.join(ignoredDirectory, "zh-CN.md"), "# English Heading\n", "utf8");

  const result = checkLocaleContent({ templateRoot: root });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});
