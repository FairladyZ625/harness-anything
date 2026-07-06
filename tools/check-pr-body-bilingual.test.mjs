import assert from "node:assert/strict";
import test from "node:test";
import { checkPrBodyBilingual, countBilingualSignals, shouldSkipPrBodyBilingualCheck } from "./check-pr-body-bilingual.mjs";

const validEnglish = [
  "# English",
  "",
  "## Summary",
  "",
  "This pull request updates the repository pull request body governance so reviewers receive a complete English description before a separate Chinese description.",
  "The change keeps the verification evidence, task scope, review evidence, residual risk, and references readable without mixing languages line by line.",
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
  "---",
  "",
  "## PR Gate Checklist / PR 门禁清单",
  "",
  "- [x] PR body uses two complete language blocks. / PR 正文使用两块完整正文。"
].join("\n");

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
