// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkPrBodyBilingual,
  countBilingualSignals,
  defaultPrTemplatePath,
  shouldSkipPrBodyBilingualCheck
} from "./check-pr-body-bilingual.mjs";

const validEnglish = [
  "# English",
  "",
  "## Summary",
  "",
  "This pull request updates the repository pull request body governance so reviewers receive a complete English description before a separate Chinese description.",
  "",
  "## What Changed",
  "",
  "- Require every section declared by the pull request template.",
  "",
  "## Task And Scope",
  "",
  "- Harness task: task_example",
  "- Public scope: PR body validation only.",
  "",
  "## Version Impact",
  "",
  "- No version change because this updates repository tooling only.",
  "",
  "## Governance Declaration",
  "",
  "- Protected surface touched: yes",
  "- Authority: accepted decision example.",
  "",
  "## Verification",
  "",
  "- [x] The focused contract tests passed.",
  "",
  "## Review Evidence",
  "",
  "- Self-review completed with no blocking findings.",
  "",
  "## Residual Risk",
  "",
  "- Template heading matching remains intentionally exact.",
  "",
  "## References",
  "",
  "- Task: task_example",
  "",
  "---"
].join("\n");

const validChinese = [
  "# 中文",
  "",
  "## 概要",
  "",
  "本次改动把仓库拉取请求正文治理改成两块式双语结构，让审查者先看到完整英文正文，再看到完整中文正文，避免逐行耦合造成阅读负担。",
  "",
  "## 改动内容",
  "",
  "- 要求填写拉取请求模板声明的每一个章节。",
  "",
  "## 任务与范围",
  "",
  "- Harness 任务：task_example",
  "- 公开范围：仅校验拉取请求正文。",
  "",
  "## 版本影响",
  "",
  "- 本次只改仓库工具，因此不调整版本。",
  "",
  "## 治理声明",
  "",
  "- 是否触碰 protected surface：yes",
  "- 依据：已接受的示例决策。",
  "",
  "## 验证",
  "",
  "- [x] 定向契约测试已经通过。",
  "",
  "## 审查证据",
  "",
  "- 已完成自查，没有阻塞发现。",
  "",
  "## 残余风险",
  "",
  "- 模板标题继续采用精确匹配。",
  "",
  "## 关联材料",
  "",
  "- 任务：task_example",
  "",
  "---",
  "",
  "## PR Gate Checklist / PR 门禁清单",
  "",
  "- [x] PR body uses two complete language blocks. / PR 正文使用两块完整正文。"
].join("\n");

const checkerCliPath = fileURLToPath(new URL("./check-pr-body-bilingual.mjs", import.meta.url));

function runCheckerCliFromCrLfFile(t, body) {
  const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "pr body lint-")));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const copiedCliPath = join(tempRoot, "check-pr-body-bilingual.mjs");
  const bodyPath = join(tempRoot, "pull request body.md");
  copyFileSync(checkerCliPath, copiedCliPath);
  writeFileSync(bodyPath, body.replaceAll("\n", "\r\n"), "utf8");
  return spawnSync(
    process.execPath,
    [copiedCliPath, "--file", bodyPath],
    { encoding: "utf8" }
  );
}

function twoBlockBody({
  english = validEnglish,
  chinese = validChinese
} = {}) {
  return [english, chinese].join("\n");
}

test("standard two-block PR body passes", () => {
  const result = checkPrBodyBilingual(twoBlockBody());

  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
  assert.ok(result.counts.englishLatinWords >= 20);
  assert.ok(result.counts.chineseCjkChars >= 20);
});

test("slim PR body fails with missing template sections and remediation path", () => {
  const slimEnglish = [
    "# English",
    "",
    "## Summary",
    "",
    "This pull request describes a deliberately slim body with enough English words to satisfy the existing minimum content threshold while omitting required template sections.",
    "",
    "## Verification",
    "",
    "The focused tests passed and the result was reviewed locally before submission.",
    "",
    "## Governance Declaration",
    "",
    "The accepted decision authorizes this protected gate change."
  ].join("\n");
  const slimChinese = [
    "# 中文",
    "",
    "## 概要",
    "",
    "这是一份刻意缩减的拉取请求正文，中文内容数量足以通过现有最低门槛，但仍然遗漏了模板要求的多个必填章节。",
    "",
    "## 验证",
    "",
    "定向测试已经通过，并且提交之前完成了本地检查。",
    "",
    "## 治理声明",
    "",
    "已接受的决策授权本次门禁改动。"
  ].join("\n");

  const result = checkPrBodyBilingual(twoBlockBody({
    english: slimEnglish,
    chinese: slimChinese
  }));

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /`## What Changed`/u);
  assert.match(result.issues.join("\n"), /`## 改动内容`/u);
  assert.match(result.issues.join("\n"), /\.github\/pull_request_template\.md/u);
});

test("section containing only template placeholder text fails as missing", () => {
  const placeholderEnglish = validEnglish.replace(
    "## Residual Risk\n\n- Template heading matching remains intentionally exact.",
    "## Residual Risk\n\n-"
  );

  const result = checkPrBodyBilingual(twoBlockBody({ english: placeholderEnglish }));

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /`## Residual Risk`/u);
  assert.match(result.issues.join("\n"), /\.github\/pull_request_template\.md/u);
});

test("body missing one required section reports that exact heading", () => {
  const missingReferencesEnglish = validEnglish.replace(
    "\n## References\n\n- Task: task_example\n",
    "\n"
  );

  const result = checkPrBodyBilingual(twoBlockBody({ english: missingReferencesEnglish }));
  const englishIssue = result.issues.find((issue) => issue.startsWith("English block"));

  assert.equal(result.ok, false);
  assert.match(englishIssue, /`## References`/u);
  assert.doesNotMatch(englishIssue, /`## Summary`/u);
});

test("CLI failure lists missing headings and the template remediation path", (t) => {
  const missingReferencesEnglish = validEnglish.replace(
    "\n## References\n\n- Task: task_example\n",
    "\n"
  );
  const result = runCheckerCliFromCrLfFile(
    t,
    twoBlockBody({ english: missingReferencesEnglish })
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /`## References`/u);
  assert.match(result.stderr, /\.github\/pull_request_template\.md/u);
  assert.match(result.stderr, /How to fix: fill every required section/u);
});

test("CLI accepts a CRLF body file that fills the complete template structure", (t) => {
  const result = runCheckerCliFromCrLfFile(t, twoBlockBody());

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check passed/u);
});

test("section containing only whitespace fails as missing", () => {
  const whitespaceChinese = validChinese.replace(
    "## 残余风险\n\n- 模板标题继续采用精确匹配。",
    "## 残余风险\n\n   \n\t"
  );

  const result = checkPrBodyBilingual(twoBlockBody({ chinese: whitespaceChinese }));

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /`## 残余风险`/u);
});

test("required sections follow template heading changes without checker changes", () => {
  const templateBody = readFileSync(defaultPrTemplatePath, "utf8");
  const changedTemplate = templateBody.replace(
    "## What Changed\n",
    "## Deployment Plan\n\n-\n\n## What Changed\n"
  );

  const missingResult = checkPrBodyBilingual(twoBlockBody(), undefined, {
    templateBody: changedTemplate
  });
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.issues.join("\n"), /`## Deployment Plan`/u);

  const matchingEnglish = validEnglish.replace(
    "## What Changed\n",
    "## Deployment Plan\n\n- No deployment is required for this repository tooling change.\n\n## What Changed\n"
  );
  const matchingResult = checkPrBodyBilingual(
    twoBlockBody({ english: matchingEnglish }),
    undefined,
    { templateBody: changedTemplate }
  );
  assert.equal(matchingResult.ok, true);
});

test("missing English heading fails", () => {
  const body = validChinese;

  const result = checkPrBodyBilingual(body);

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /Missing top-level heading `# English`/u);
});

test("missing Chinese heading fails", () => {
  const body = validEnglish;

  const result = checkPrBodyBilingual(body);

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /Missing top-level heading `# 中文`/u);
});

test("Chinese block before English block fails", () => {
  const body = [validChinese, validEnglish].join("\n");

  const result = checkPrBodyBilingual(body);

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /must appear before/u);
});

test("English block with too few Latin words fails", () => {
  const shortEnglish = [
    "# English",
    "",
    "Tiny section.",
    "",
    "---"
  ].join("\n");

  const result = checkPrBodyBilingual(twoBlockBody({ english: shortEnglish }));

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /Not enough English block content/u);
});

test("Chinese block with too few CJK characters fails", () => {
  const shortChinese = [
    "# 中文",
    "",
    "中文太短。",
    "",
    "---",
    "",
    "## PR Gate Checklist / PR 门禁清单",
    "",
    "- [x] 这里有很多中文但属于共享门禁清单，不能补足中文正文。"
  ].join("\n");

  const result = checkPrBodyBilingual(twoBlockBody({ chinese: shortChinese }));

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /Not enough Chinese block content/u);
});

test("old coupled bilingual format fails without top-level language headings", () => {
  const body = [
    "## 概要 / Summary",
    "",
    "本次改动继续使用逐行耦合格式，虽然有中文内容但没有独立中文正文块。",
    "This older coupled format also has English words but does not declare a separate English body block for review."
  ].join("\n");

  const result = checkPrBodyBilingual(body);

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /Missing top-level heading `# English`/u);
  assert.match(result.issues.join("\n"), /Missing top-level heading `# 中文`/u);
});

test("signal counter counts CJK characters and Latin words independently", () => {
  assert.deepEqual(countBilingualSignals("中文内容 English words here"), {
    cjkChars: 4,
    latinWords: 3
  });
});

test("Mergify merge-queue verification PR can skip body template lint", () => {
  const body = [
    "<!---",
    "DO NOT EDIT",
    "-*- Mergify Payload -*-",
    "{\"merge-queue-pr\": true}",
    "-*- Mergify Payload End -*-",
    "-->",
    "",
    "This pull request has been created by Mergify to check mergeability."
  ].join("\n");

  assert.equal(shouldSkipPrBodyBilingualCheck({
    body,
    headRefName: "mergify/merge-queue/e00b463e2d",
    authorLogin: "mergify[bot]"
  }), true);
});

test("Mergify skip requires bot author, queue branch, and payload marker", () => {
  const body = "{\"merge-queue-pr\": true}";

  assert.equal(shouldSkipPrBodyBilingualCheck({
    body,
    headRefName: "codex/not-a-queue",
    authorLogin: "mergify[bot]"
  }), false);
  assert.equal(shouldSkipPrBodyBilingualCheck({
    body,
    headRefName: "mergify/merge-queue/e00b463e2d",
    authorLogin: "FairladyZ625"
  }), false);
  assert.equal(shouldSkipPrBodyBilingualCheck({
    body: "regular body",
    headRefName: "mergify/merge-queue/e00b463e2d",
    authorLogin: "mergify[bot]"
  }), false);
});
