// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  architectureJustificationThresholds,
  checkArchitectureJustification,
  checkGateHarvestDeclarations,
  checkPrBodyBilingual,
  countBilingualSignals,
  shouldSkipPrBodyBilingualCheck,
} from "./check-pr-body-bilingual.mjs";

const validEnglish = [
  "# English",
  "",
  "## Summary",
  "",
  "This pull request updates the repository pull request body governance so reviewers receive a complete English description before a separate Chinese description.",
  "The change keeps the verification evidence, task scope, review evidence, residual risk, and references readable without mixing languages line by line.",
  "",
  "---",
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
  "- [x] PR body uses two complete language blocks. / PR 正文使用两块完整正文。",
].join("\n");

function twoBlockBody({ english = validEnglish, chinese = validChinese } = {}) {
  return [english, chinese].join("\n");
}

test("standard two-block PR body passes", () => {
  const result = checkPrBodyBilingual(twoBlockBody());

  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
  assert.ok(result.counts.englishLatinWords >= 20);
  assert.ok(result.counts.chineseCjkChars >= 20);
});

test("production churn above 200 requires both bilingual justification sections", () => {
  const result = checkPrBodyBilingual(
    twoBlockBody({
      english: [validEnglish.replace("\n\n---", ""), "Production-Delta: +201/-0", "", "---"].join("\n"),
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.architectureJustification.required, true);
  assert.match(result.issues.join("\n"), /English `## Architectural Justification`/u);
  assert.match(result.issues.join("\n"), /中文 `## 架构辩护`/u);
});

test("a placeholder or separator does not satisfy a required justification", () => {
  const result = checkPrBodyBilingual(
    twoBlockBody({
      english: [
        validEnglish.replace("\n\n---", ""),
        "Production-Delta: +201/-0",
        "",
        "## Architectural Justification",
        "---",
        "",
        "---",
      ].join("\n"),
      chinese: validChinese.replace(
        "\n\n---\n\n## PR Gate Checklist / PR 门禁清单",
        "\n\n## 架构辩护\n\n-\n\n---\n\n## PR Gate Checklist / PR 门禁清单",
      ),
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.architectureJustification.required, true);
  assert.equal(result.architectureJustification.issues.length, 4);
});

test("production net above 300 passes with non-empty bilingual justification sections", () => {
  const result = checkPrBodyBilingual(
    twoBlockBody({
      english: [
        validEnglish.replace("\n\n---", ""),
        "Production-Delta: +301/-0",
        "",
        "## Architectural Justification",
        "The new capability belongs in this module because it shares the existing boundary and removes the obsolete path; narrowing the scope would leave the required contract incomplete.",
        "",
        "---",
      ].join("\n"),
      chinese: validChinese.replace(
        "\n\n---\n\n## PR Gate Checklist / PR 门禁清单",
        "\n\n## 架构辩护\n\n新能力沿用现有模块边界，并删除了不再需要的旧路径；继续收窄范围会留下不完整的必要契约。\n\n---\n\n## PR Gate Checklist / PR 门禁清单",
      ),
    }),
  );

  assert.equal(result.ok, true, result.issues.join("\n"));
  assert.deepEqual(result.architectureJustification, {
    ok: true,
    required: true,
    known: true,
    added: 301,
    deleted: 0,
    churn: 301,
    net: 301,
    issues: [],
  });
});

test("threshold boundaries do not require justification", () => {
  const result = checkArchitectureJustification({
    englishBlock: `${validEnglish.replace("\n\n---", "")}\nProduction-Delta: +200/-0\n`,
    chineseBlock: validChinese,
  });

  assert.equal(architectureJustificationThresholds.maxChurn, 200);
  assert.equal(architectureJustificationThresholds.maxNet, 300);
  assert.equal(result.required, false);
  assert.equal(result.churn, 200);
});

test("deleted production paths require deleted gates or fixtures", () => {
  const result = checkPrBodyBilingual(
    twoBlockBody({
      english: [
        validEnglish.replace("\n\n---", ""),
        "Deleted-Production-Paths: packages/legacy.ts",
        "Deleted-Gates-Fixtures: none",
        "Production-Delta: +0/-4",
        "",
        "---",
      ].join("\n"),
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /requires at least one Deleted-Gates-Fixtures entry/u);
  assert.equal(result.gateHarvest.hasDeletedProductionPaths, true);
});

test("deleted production paths pass with a same-commit gate or fixture and CI delta", () => {
  const result = checkPrBodyBilingual(
    twoBlockBody({
      english: [
        validEnglish.replace("\n\n---", ""),
        "Deleted-Production-Paths: packages/legacy.ts",
        "Deleted-Gates-Fixtures: tools/gates/test/legacy.json",
        "Production-Delta: +0/-4",
        "",
        "---",
      ].join("\n"),
    }),
  );

  assert.equal(result.ok, true, result.issues.join("\n"));
  assert.equal(result.gateHarvest.productionDeltaCount, 1);
});

test("deleted production paths require the CI production delta field", () => {
  const result = checkGateHarvestDeclarations(
    ["Deleted-Production-Paths: packages/legacy.ts", "Deleted-Gates-Fixtures: tools/gates/test/legacy.json"].join("\n"),
  );

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /requires exactly one CI-backed Production-Delta/u);
});

test("a body with no deleted production paths preserves existing behavior", () => {
  const result = checkGateHarvestDeclarations(
    ["Deleted-Production-Paths: none", "Deleted-Gates-Fixtures: none"].join("\n"),
  );

  assert.equal(result.ok, true);
  assert.equal(result.hasDeletedProductionPaths, false);
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
  const shortEnglish = ["# English", "", "Tiny section.", "", "---"].join("\n");

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
    "- [x] 这里有很多中文但属于共享门禁清单，不能补足中文正文。",
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
    "This older coupled format also has English words but does not declare a separate English body block for review.",
  ].join("\n");

  const result = checkPrBodyBilingual(body);

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /Missing top-level heading `# English`/u);
  assert.match(result.issues.join("\n"), /Missing top-level heading `# 中文`/u);
});

test("signal counter counts CJK characters and Latin words independently", () => {
  assert.deepEqual(countBilingualSignals("中文内容 English words here"), {
    cjkChars: 4,
    latinWords: 3,
  });
});

test("Mergify merge-queue verification PR skips body template lint by author and branch alone", () => {
  // Mergify's draft body format changed (2026-08-27: no "merge-queue-pr" payload marker any more),
  // so the body carries no fingerprint; author + queue branch are the only stable signals.
  const body = [
    "**⏳ The pull request [#1849](/o/r/pull/1849) is queued for merge and currently being checked. ⏳**",
    "",
    "```yaml",
    "pull_requests:",
    "  - number: 1849",
    "```",
  ].join("\n");

  assert.equal(
    shouldSkipPrBodyBilingualCheck({ body, headRefName: "mergify/merge-queue/e00b463e2d", authorLogin: "mergify[bot]" }),
    true,
  );
  assert.equal(
    shouldSkipPrBodyBilingualCheck({ body, headRefName: "mergify/merge-queue/e00b463e2d", authorLogin: "app/mergify" }),
    true,
  );
});

test("Mergify skip requires both bot author and queue branch", () => {
  assert.equal(shouldSkipPrBodyBilingualCheck({ headRefName: "codex/not-a-queue", authorLogin: "mergify[bot]" }), false);
  assert.equal(
    shouldSkipPrBodyBilingualCheck({ headRefName: "mergify/merge-queue/e00b463e2d", authorLogin: "FairladyZ625" }),
    false,
  );
});
