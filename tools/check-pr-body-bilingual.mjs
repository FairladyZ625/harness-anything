#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import { parseProductionDeclaration } from "./gates/production-delta.mjs";

export const defaultThresholds = Object.freeze({
  minCjkChars: 20,
  minLatinWords: 20,
});

export const architectureJustificationThresholds = Object.freeze({
  maxChurn: 200,
  maxNet: 300,
});

const ENGLISH_HEADING = /^# English\s*$/mu;
const CHINESE_HEADING = /^# 中文\s*$/mu;
const SHARED_CHECKLIST_HEADING = /^## PR Gate Checklist \/ PR 门禁清单\s*$/mu;
const ENGLISH_JUSTIFICATION_HEADING = /^## Architectural Justification\s*$/mu;
const CHINESE_JUSTIFICATION_HEADING = /^## 架构辩护\s*$/mu;
const DELETED_PRODUCTION_PATHS = /^Deleted-Production-Paths:[ \t]*(.*?)\s*$/gmu;
const DELETED_GATES_FIXTURES = /^Deleted-Gates-Fixtures:[ \t]*(.*?)\s*$/gmu;

function isEmptyListDeclaration(value) {
  const normalized = value.trim();
  return normalized.length === 0 || /^(?:none|n\/a|not applicable)$/iu.test(normalized);
}

export function checkGateHarvestDeclarations(body) {
  const pathDeclarations = [...body.matchAll(DELETED_PRODUCTION_PATHS)].map((match) => match[1]);
  const gateDeclarations = [...body.matchAll(DELETED_GATES_FIXTURES)].map((match) => match[1]);
  const productionDelta = parseProductionDeclaration(body);
  const hasDeletedProductionPaths = pathDeclarations.some((value) => !isEmptyListDeclaration(value));
  const issues = [];

  if (!hasDeletedProductionPaths) {
    return {
      ok: true,
      hasDeletedProductionPaths: false,
      pathDeclarations,
      gateDeclarations,
      productionDeltaCount: productionDelta.declaration === null ? 0 : 1,
      issues,
    };
  }

  const hasDeletedGatesOrFixtures = gateDeclarations.some((value) => !isEmptyListDeclaration(value));
  if (!hasDeletedGatesOrFixtures) {
    issues.push("Gate Harvest with deleted production paths requires at least one Deleted-Gates-Fixtures entry.");
    issues.push("删除生产路径时，Gate Harvest 必须列出至少一个 Deleted-Gates-Fixtures 门或 fixture。");
  }
  if (productionDelta.declaration === null) {
    issues.push(
      "Gate Harvest with deleted production paths requires exactly one CI-backed Production-Delta: +N/-M line.",
    );
    issues.push("删除生产路径时，Gate Harvest 必须包含且仅包含一行由 CI 提供依据的 Production-Delta: +N/-M。");
  }

  return {
    ok: issues.length === 0,
    hasDeletedProductionPaths: true,
    pathDeclarations,
    gateDeclarations,
    productionDeltaCount: productionDelta.declaration === null ? 0 : 1,
    issues,
  };
}

export function countBilingualSignals(body) {
  return {
    cjkChars: Array.from(body.matchAll(/[\u4E00-\u9FFF]/gu)).length,
    latinWords: Array.from(body.matchAll(/\b[A-Za-z]+(?:[-'][A-Za-z]+)?\b/gu)).length,
  };
}

export function splitPrBodyLanguageBlocks(body) {
  const englishMatch = ENGLISH_HEADING.exec(body);
  const chineseMatch = CHINESE_HEADING.exec(body);

  if (!englishMatch || !chineseMatch) {
    return {
      ok: false,
      englishIndex: englishMatch?.index ?? -1,
      chineseIndex: chineseMatch?.index ?? -1,
      englishBlock: "",
      chineseBlock: "",
      issues: [
        ...(!englishMatch ? ["缺少顶级标题 `# English`。", "Missing top-level heading `# English`."] : []),
        ...(!chineseMatch ? ["缺少顶级标题 `# 中文`。", "Missing top-level heading `# 中文`."] : []),
      ],
    };
  }

  if (englishMatch.index > chineseMatch.index) {
    return {
      ok: false,
      englishIndex: englishMatch.index,
      chineseIndex: chineseMatch.index,
      englishBlock: "",
      chineseBlock: "",
      issues: ["`# English` 必须出现在 `# 中文` 之前。", "`# English` must appear before `# 中文`."],
    };
  }

  const afterChinese = body.slice(chineseMatch.index);
  const checklistMatch = SHARED_CHECKLIST_HEADING.exec(afterChinese);
  const chineseEnd = checklistMatch ? chineseMatch.index + checklistMatch.index : body.length;

  return {
    ok: true,
    englishIndex: englishMatch.index,
    chineseIndex: chineseMatch.index,
    englishBlock: body.slice(englishMatch.index, chineseMatch.index),
    chineseBlock: body.slice(chineseMatch.index, chineseEnd),
    issues: [],
  };
}

function sectionContent(block, headingPattern) {
  const heading = headingPattern.exec(block);
  if (!heading) return null;
  const afterHeading = block.slice(heading.index + heading[0].length);
  const nextHeading = /^##\s+/mu.exec(afterHeading);
  return afterHeading
    .slice(0, nextHeading?.index ?? afterHeading.length)
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split(/\r?\n/u)
    .filter((line) => !/^\s*[-*]\s*$/u.test(line))
    .filter((line) => !/^\s*(?:[-*_]){3,}\s*$/u.test(line))
    .join("\n")
    .trim();
}

export function checkArchitectureJustification({
  englishBlock,
  chineseBlock,
  thresholds = architectureJustificationThresholds,
}) {
  const parsedDelta = parseProductionDeclaration(englishBlock);
  if (parsedDelta.declaration === null) {
    return {
      ok: true,
      required: false,
      known: false,
      added: null,
      deleted: null,
      churn: null,
      net: null,
      issues: [],
    };
  }

  const { added, deleted } = parsedDelta.declaration;
  const churn = added + deleted;
  const net = added - deleted;
  const required = churn > thresholds.maxChurn || net > thresholds.maxNet;
  if (!required) {
    return { ok: true, required, known: true, added, deleted, churn, net, issues: [] };
  }

  const issues = [];
  if (!sectionContent(englishBlock, ENGLISH_JUSTIFICATION_HEADING)) {
    issues.push(
      "Production churn/net threshold exceeded; English `## Architectural Justification` must contain a justification.",
    );
    issues.push("生产变更总量或净增超过阈值；英文 `## Architectural Justification` 必须填写架构辩护。");
  }
  if (!sectionContent(chineseBlock, CHINESE_JUSTIFICATION_HEADING)) {
    issues.push("Production churn/net threshold exceeded; Chinese `## 架构辩护` must contain a justification.");
    issues.push("生产变更总量或净增超过阈值；中文 `## 架构辩护` 必须填写架构辩护。");
  }

  return { ok: issues.length === 0, required, known: true, added, deleted, churn, net, issues };
}

export function checkPrBodyBilingual(body, thresholds = defaultThresholds) {
  const blocks = splitPrBodyLanguageBlocks(body);
  const englishCounts = countBilingualSignals(blocks.englishBlock);
  const chineseCounts = countBilingualSignals(blocks.chineseBlock);
  const issues = [...blocks.issues];
  const gateHarvest = checkGateHarvestDeclarations(blocks.englishBlock);
  issues.push(...gateHarvest.issues);
  const architectureJustification = checkArchitectureJustification({
    englishBlock: blocks.englishBlock,
    chineseBlock: blocks.chineseBlock,
  });
  issues.push(...architectureJustification.issues);

  if (blocks.ok && englishCounts.latinWords < thresholds.minLatinWords) {
    issues.push(
      `英文块内容不足：需要至少 ${thresholds.minLatinWords} 个拉丁单词，当前 ${englishCounts.latinWords} 个。`,
    );
    issues.push(
      `Not enough English block content: expected at least ${thresholds.minLatinWords} Latin words, found ${englishCounts.latinWords}.`,
    );
  }
  if (blocks.ok && chineseCounts.cjkChars < thresholds.minCjkChars) {
    issues.push(`中文块内容不足：需要至少 ${thresholds.minCjkChars} 个 CJK 字符，当前 ${chineseCounts.cjkChars} 个。`);
    issues.push(
      `Not enough Chinese block content: expected at least ${thresholds.minCjkChars} CJK characters, found ${chineseCounts.cjkChars}.`,
    );
  }

  return {
    ok: issues.length === 0,
    counts: {
      englishLatinWords: englishCounts.latinWords,
      englishCjkChars: englishCounts.cjkChars,
      chineseLatinWords: chineseCounts.latinWords,
      chineseCjkChars: chineseCounts.cjkChars,
    },
    blocks: {
      englishIndex: blocks.englishIndex,
      chineseIndex: blocks.chineseIndex,
    },
    gateHarvest,
    architectureJustification,
    issues,
  };
}

function readBodyFromArgs(argv) {
  if (argv.length === 0) return process.env.PR_BODY ?? "";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--text" || token === "--file" || token === "--env") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      if (token === "--text") return value;
      if (token === "--file") return readFileSync(value, "utf8");
      if (token === "--env") return process.env[value] ?? "";
    }
    if (token === "--help") {
      process.stdout.write(
        [
          "Usage: node tools/check-pr-body-bilingual.mjs [--text <body> | --file <path> | --env <name>]",
          "",
          "Requires a top-level `# English` block before a top-level `# 中文` block.",
          "The English block must contain at least 20 Latin words; the Chinese block must contain at least 20 CJK characters.",
          "When Deleted-Production-Paths names a path, Deleted-Gates-Fixtures and exactly one CI-backed Production-Delta declaration are required.",
          "When the single Production-Delta declaration exceeds 200 churn lines or +300 net production lines, both language blocks must contain a completed architectural justification section.",
          "要求顶级 `# English` 块位于顶级 `# 中文` 块之前。",
          "英文块至少包含 20 个拉丁单词；中文块至少包含 20 个 CJK 字符。",
          "当 Deleted-Production-Paths 声明路径时，必须填写 Deleted-Gates-Fixtures，并包含且仅包含一行由 CI 提供依据的 Production-Delta。",
          "当唯一的 Production-Delta 超过 200 行 churn 或生产净增 +300 行时，英文和中文块都必须填写完整的架构辩护段。",
        ].join("\n"),
      );
      process.stdout.write("\n");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return process.env.PR_BODY ?? "";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const body = readBodyFromArgs(process.argv.slice(2));
    const result = checkPrBodyBilingual(body);
    if (result.ok) {
      process.stdout.write(
        [
          "PR body bilingual block check passed.",
          `English Latin words=${result.counts.englishLatinWords}, Chinese CJK=${result.counts.chineseCjkChars}`,
        ].join(" "),
      );
      process.stdout.write("\n");
    } else {
      process.stderr.write(
        [
          "PR body bilingual block check failed.",
          "PR 正文两块式双语检查失败。",
          "",
          ...result.issues,
          "",
          "How to fix: fill the PR body as two complete blocks: `# English` first, then `---`, then `# 中文`.",
          "修复方式：请按两块完整正文填写 PR body：先写 `# English`，再用 `---` 分隔，然后写 `# 中文`。",
        ].join("\n"),
      );
      process.stderr.write("\n");
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
