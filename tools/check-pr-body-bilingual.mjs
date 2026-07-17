#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const defaultThresholds = Object.freeze({
  minCjkChars: 20,
  minLatinWords: 20
});

const ENGLISH_HEADING = /^# English\s*$/mu;
const CHINESE_HEADING = /^# 中文\s*$/mu;
const SHARED_CHECKLIST_HEADING = /^## PR Gate Checklist \/ PR 门禁清单\s*$/mu;
const LEVEL_TWO_HEADING = /^##[ \t]+(.+?)\s*$/gmu;
const MERGIFY_QUEUE_BRANCH = /^mergify\/merge-queue\//u;
const MERGIFY_QUEUE_PAYLOAD = /"merge-queue-pr"\s*:\s*true/u;
const MERGIFY_AUTHORS = new Set(["mergify[bot]", "app/mergify"]);
export const defaultPrTemplatePath = ".github/pull_request_template.md";

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

function parseLevelTwoSections(block) {
  const matches = Array.from(block.matchAll(LEVEL_TWO_HEADING));
  return matches.map((match, index) => ({
    heading: match[1],
    content: block.slice(
      match.index + match[0].length,
      matches[index + 1]?.index ?? block.length
    )
  }));
}

function deriveRequiredSections(templateBody, templatePath) {
  const blocks = splitPrBodyLanguageBlocks(templateBody);
  if (!blocks.ok) {
    throw new Error(`Cannot derive required PR sections from ${templatePath}: ${blocks.issues.join(" ")}`);
  }

  return {
    english: parseLevelTwoSections(blocks.englishBlock),
    chinese: parseLevelTwoSections(blocks.chineseBlock)
  };
}

function normalizedContentLines(content) {
  return content
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isGenericPlaceholderLine(line) {
  const value = line
    .replace(/^(?:>\s*)+/u, "")
    .replace(/^(?:[-*+]|\d+[.)])\s*/u, "")
    .replace(/^\[[ xX]\]\s*/u, "")
    .trim();

  return value.length === 0
    || /^[-–—_./\\…]+$/u.test(value)
    || /^(?:todo|tbd|placeholder|fill[ -]?me|to be filled|待补充?|待填写|待完善)(?:[：:].*)?$/iu.test(value)
    || /^(?:\[[^\]]*\]|<[^>]*>)$/u.test(value);
}

function hasMeaningfulSectionContent(content, templateContent) {
  const templateScaffolding = new Set(normalizedContentLines(templateContent));
  return normalizedContentLines(content).some((line) => (
    !templateScaffolding.has(line) && !isGenericPlaceholderLine(line)
  ));
}

function formatRequiredHeadings(headings) {
  return headings.map((heading) => `\`## ${heading}\``).join(", ");
}

export function checkPrBodyBilingual(body, thresholds = defaultThresholds, {
  templateBody = readFileSync(defaultPrTemplatePath, "utf8"),
  templatePath = defaultPrTemplatePath
} = {}) {
  const blocks = splitPrBodyLanguageBlocks(body);
  const englishCounts = countBilingualSignals(blocks.englishBlock);
  const chineseCounts = countBilingualSignals(blocks.chineseBlock);
  const issues = [...blocks.issues];

  if (blocks.ok) {
    const requiredSections = deriveRequiredSections(templateBody, templatePath);
    const englishSections = new Map(parseLevelTwoSections(blocks.englishBlock).map((section) => [section.heading, section]));
    const chineseSections = new Map(parseLevelTwoSections(blocks.chineseBlock).map((section) => [section.heading, section]));
    const missingEnglish = requiredSections.english
      .filter((required) => {
        const section = englishSections.get(required.heading);
        return !section || !hasMeaningfulSectionContent(section.content, required.content);
      })
      .map((section) => section.heading);
    const missingChinese = requiredSections.chinese
      .filter((required) => {
        const section = chineseSections.get(required.heading);
        return !section || !hasMeaningfulSectionContent(section.content, required.content);
      })
      .map((section) => section.heading);

    if (missingEnglish.length > 0) {
      issues.push(`English block is missing required sections or has empty/placeholder-only sections from ${templatePath}: ${formatRequiredHeadings(missingEnglish)}.`);
    }
    if (missingChinese.length > 0) {
      issues.push(`中文块缺少 ${templatePath} 要求的章节，或章节仅含空白/占位文本：${formatRequiredHeadings(missingChinese)}。`);
    }
  }

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
        `Each language block must fill every \`##\` section declared in ${defaultPrTemplatePath}.`,
        "The English block must contain at least 20 Latin words; the Chinese block must contain at least 20 CJK characters.",
        "要求顶级 `# English` 块位于顶级 `# 中文` 块之前。",
        `每个语言块都必须填写 ${defaultPrTemplatePath} 声明的全部 \`##\` 章节。`,
        "英文块至少包含 20 个拉丁单词；中文块至少包含 20 个 CJK 字符。"
      ].join("\n"));
      process.stdout.write("\n");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return process.env.PR_BODY ?? "";
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
        `How to fix: fill every required section from ${defaultPrTemplatePath} in two complete blocks: \`# English\` first, then \`---\`, then \`# 中文\`.`,
        `修复方式：请填写 ${defaultPrTemplatePath} 的全部必需章节，并按两块完整正文组织：先写 \`# English\`，再用 \`---\` 分隔，然后写 \`# 中文\`。`
      ].join("\n"));
      process.stderr.write("\n");
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
