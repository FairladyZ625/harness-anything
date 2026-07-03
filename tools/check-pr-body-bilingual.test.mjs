import assert from "node:assert/strict";
import test from "node:test";
import { checkPrBodyBilingual, countBilingualSignals } from "./check-pr-body-bilingual.mjs";

test("bilingual PR body passes with enough Chinese and English", () => {
  const body = [
    "## 概要 / Summary",
    "本次改动固化 PR 正文双语规则，要求中文先行、英文跟随，并通过 CI 自动检查，避免后续审查继续依赖人工记忆。",
    "This change enforces bilingual pull request bodies with Chinese first and English following, using continuous integration so future reviews do not rely on memory alone."
  ].join("\n");

  const result = checkPrBodyBilingual(body);

  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
});

test("pure Chinese PR body fails without English words", () => {
  const body = "本次改动固化双语规范，要求所有公开拉取请求正文都必须中文先行，并且保留完整模板结构用于审查。";

  const result = checkPrBodyBilingual(body);

  assert.equal(result.ok, false);
  assert.equal(result.counts.latinWords, 0);
  assert.match(result.issues.join("\n"), /英文内容不足/u);
});

test("pure English PR body fails without Chinese characters", () => {
  const body = "This change requires every public pull request body to include bilingual sections and keeps the existing template structure for review evidence.";

  const result = checkPrBodyBilingual(body);

  assert.equal(result.ok, false);
  assert.equal(result.counts.cjkChars, 0);
  assert.match(result.issues.join("\n"), /Not enough Chinese content/u);
});

test("token padding below thresholds fails closed", () => {
  const body = "中文 bilingual";

  const result = checkPrBodyBilingual(body);

  assert.equal(result.ok, false);
  assert.equal(result.counts.cjkChars < 20, true);
  assert.equal(result.counts.latinWords < 20, true);
});

test("signal counter counts CJK characters and Latin words independently", () => {
  assert.deepEqual(countBilingualSignals("中文内容 English words here"), {
    cjkChars: 4,
    latinWords: 3
  });
});
