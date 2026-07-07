#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultTemplateRoot = path.join(repoRoot, "packages/cli/src/commands/extensions/assets/software-coding/templates");
const zhCnFileName = "zh-CN.md";
const governedTemplateNames = [
  "module.plan",
  "module.brief",
  "gate-retro.analysis",
  "repository.adr.template",
  "repository.adr.readme",
  "module.session.prompt"
];
const headingPattern = /^(#{1,3})\s+(.+)$/u;
const cjkPattern = /[\u4E00-\u9FFF]/u;
const fencePattern = /^\s*(```|~~~)/u;

export function checkLocaleContent(options = {}) {
  const templateRoot = options.templateRoot ?? defaultTemplateRoot;
  const filePaths = options.filePaths ?? governedTemplateNames.map((name) => path.join(templateRoot, name, zhCnFileName));
  const failures = [];
  for (const filePath of filePaths) {
    if (!existsSync(filePath)) {
      failures.push(`${path.relative(repoRoot, filePath)}: missing governed zh-CN locale template`);
      continue;
    }
    const body = readFileSync(filePath, "utf8");
    const relativePath = path.relative(repoRoot, filePath);
    failures.push(...findHeadingFailures(body, relativePath));
  }
  return { ok: failures.length === 0, failures };
}

export function findHeadingFailures(body, relativePath = zhCnFileName) {
  const failures = [];
  let inFence = false;
  const lines = body.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fencePattern.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = headingPattern.exec(line);
    if (!heading) continue;
    if (!cjkPattern.test(heading[2])) {
      failures.push(`${relativePath}:${index + 1}: zh-CN heading must contain at least one CJK character: ${line}`);
    }
  }
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkLocaleContent();
  if (!result.ok) {
    console.error("zh-CN locale content drift detected:");
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  }
}
