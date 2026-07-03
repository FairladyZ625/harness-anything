#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";

export const defaultThresholds = Object.freeze({
  minCjkChars: 20,
  minLatinWords: 20
});

export function countBilingualSignals(body) {
  return {
    cjkChars: Array.from(body.matchAll(/[\u4E00-\u9FFF]/gu)).length,
    latinWords: Array.from(body.matchAll(/\b[A-Za-z]+(?:[-'][A-Za-z]+)?\b/gu)).length
  };
}

export function checkPrBodyBilingual(body, thresholds = defaultThresholds) {
  const counts = countBilingualSignals(body);
  const issues = [];
  if (counts.cjkChars < thresholds.minCjkChars) {
    issues.push(`中文内容不足：需要至少 ${thresholds.minCjkChars} 个 CJK 字符，当前 ${counts.cjkChars} 个。`);
    issues.push(`Not enough Chinese content: expected at least ${thresholds.minCjkChars} CJK characters, found ${counts.cjkChars}.`);
  }
  if (counts.latinWords < thresholds.minLatinWords) {
    issues.push(`英文内容不足：需要至少 ${thresholds.minLatinWords} 个拉丁单词，当前 ${counts.latinWords} 个。`);
    issues.push(`Not enough English content: expected at least ${thresholds.minLatinWords} Latin words, found ${counts.latinWords}.`);
  }
  return {
    ok: issues.length === 0,
    counts,
    issues
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
      process.stdout.write([
        "Usage: node tools/check-pr-body-bilingual.mjs [--text <body> | --file <path> | --env <name>]",
        "",
        "Requires CJK >= 20 and Latin words >= 20.",
        "要求 CJK 字符不少于 20 个，拉丁单词不少于 20 个。"
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
    const result = checkPrBodyBilingual(body);
    if (result.ok) {
      process.stdout.write(`PR body bilingual check passed: CJK=${result.counts.cjkChars}, Latin words=${result.counts.latinWords}\n`);
    } else {
      process.stderr.write([
        "PR body bilingual check failed.",
        "PR 正文双语检查失败。",
        "",
        ...result.issues,
        "",
        "修复方式：请按模板补充中文先行、英文跟随的完整 PR 描述。",
        "How to fix: fill the template with Chinese first and English following each section."
      ].join("\n"));
      process.stderr.write("\n");
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
