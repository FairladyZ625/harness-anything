#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";

export const defaultThresholds = Object.freeze({
  minCjkChars: 20,
  minLatinWords: 20
});

const ENGLISH_HEADING = /^# English\s*$/mu;
const CHINESE_HEADING = /^# 中文\s*$/mu;
const SHARED_CHECKLIST_HEADING = /^## PR Gate Checklist \/ PR 门禁清单\s*$/mu;
const MERGIFY_QUEUE_BRANCH = /^mergify\/merge-queue\//u;
const MERGIFY_QUEUE_PAYLOAD = /"merge-queue-pr"\s*:\s*true/u;
const MERGIFY_AUTHORS = new Set(["mergify[bot]", "app/mergify"]);

export function countBilingualSignals(body) {
  return {
    cjkChars: Array.from(body.matchAll(/[\u4E00-\u9FFF]/gu)).length,
    latinWords: Array.from(body.matchAll(/\b[A-Za-z]+(?:[-'][A-Za-z]+)?\b/gu)).length
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
        ...(!englishMatch ? [
          "缺少顶级标题 `# English`。",
          "Missing top-level heading `# English`."
        ] : []),
        ...(!chineseMatch ? [
          "缺少顶级标题 `# 中文`。",
          "Missing top-level heading `# 中文`."
        ] : [])
      ]
    };
  }

  if (englishMatch.index > chineseMatch.index) {
    return {
      ok: false,
      englishIndex: englishMatch.index,
      chineseIndex: chineseMatch.index,
      englishBlock: "",
      chineseBlock: "",
      issues: [
        "`# English` 必须出现在 `# 中文` 之前。",
        "`# English` must appear before `# 中文`."
      ]
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
    issues: []
  };
}

export function checkPrBodyBilingual(body, thresholds = defaultThresholds) {
  const blocks = splitPrBodyLanguageBlocks(body);
  const englishCounts = countBilingualSignals(blocks.englishBlock);
  const chineseCounts = countBilingualSignals(blocks.chineseBlock);
  const issues = [...blocks.issues];

  if (blocks.ok && englishCounts.latinWords < thresholds.minLatinWords) {
    issues.push(`英文块内容不足：需要至少 ${thresholds.minLatinWords} 个拉丁单词，当前 ${englishCounts.latinWords} 个。`);
    issues.push(`Not enough English block content: expected at least ${thresholds.minLatinWords} Latin words, found ${englishCounts.latinWords}.`);
  }
  if (blocks.ok && chineseCounts.cjkChars < thresholds.minCjkChars) {
    issues.push(`中文块内容不足：需要至少 ${thresholds.minCjkChars} 个 CJK 字符，当前 ${chineseCounts.cjkChars} 个。`);
    issues.push(`Not enough Chinese block content: expected at least ${thresholds.minCjkChars} CJK characters, found ${chineseCounts.cjkChars}.`);
  }

  return {
    ok: issues.length === 0,
    counts: {
      englishLatinWords: englishCounts.latinWords,
      englishCjkChars: englishCounts.cjkChars,
      chineseLatinWords: chineseCounts.latinWords,
      chineseCjkChars: chineseCounts.cjkChars
    },
    blocks: {
      englishIndex: blocks.englishIndex,
      chineseIndex: blocks.chineseIndex
    },
    issues
  };
}

export function shouldSkipPrBodyBilingualCheck({
  body = "",
  headRefName = "",
  authorLogin = ""
} = {}) {
  return MERGIFY_AUTHORS.has(authorLogin)
    && MERGIFY_QUEUE_BRANCH.test(headRefName)
    && MERGIFY_QUEUE_PAYLOAD.test(body);
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
      process.stdout.write([
        "Usage: node tools/check-pr-body-bilingual.mjs [--text <body> | --file <path> | --env <name>]",
        "",
        "Requires a top-level `# English` block before a top-level `# 中文` block.",
        "The English block must contain at least 20 Latin words; the Chinese block must contain at least 20 CJK characters.",
        "要求顶级 `# English` 块位于顶级 `# 中文` 块之前。",
        "英文块至少包含 20 个拉丁单词；中文块至少包含 20 个 CJK 字符。"
      ].join("\n"));
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
    if (shouldSkipPrBodyBilingualCheck({
      body,
      headRefName: process.env.PR_HEAD_REF ?? "",
      authorLogin: process.env.PR_AUTHOR_LOGIN ?? ""
    })) {
      process.stdout.write("PR body bilingual block check skipped for Mergify merge-queue verification PR.\n");
      process.exit(0);
    }

    const result = checkPrBodyBilingual(body);
    if (result.ok) {
      process.stdout.write([
        "PR body bilingual block check passed.",
        `English Latin words=${result.counts.englishLatinWords}, Chinese CJK=${result.counts.chineseCjkChars}`
      ].join(" "));
      process.stdout.write("\n");
    } else {
      process.stderr.write([
        "PR body bilingual block check failed.",
        "PR 正文两块式双语检查失败。",
        "",
        ...result.issues,
        "",
        "How to fix: fill the PR body as two complete blocks: `# English` first, then `---`, then `# 中文`.",
        "修复方式：请按两块完整正文填写 PR body：先写 `# English`，再用 `---` 分隔，然后写 `# 中文`。"
      ].join("\n"));
      process.stderr.write("\n");
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
