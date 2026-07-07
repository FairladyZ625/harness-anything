#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = process.cwd();
const TARGET_PATH = "packages/cli/src/cli/parsers/capabilities.ts";

export function findCapabilitiesKindSourceViolations(source, filePath = TARGET_PATH) {
  const findings = [];
  const hardcodedKindSetPattern = /new\s+Set(?:<[^>]+>)?\s*\(\s*\[(?=[\s\S]*?["']task["'])(?=[\s\S]*?["']decision["'])[\s\S]*?\]\s*\)/gu;
  for (const match of source.matchAll(hardcodedKindSetPattern)) {
    findings.push(`${filePath}:${lineNumber(source, match.index ?? 0)}: capabilities parser must derive entity kinds from registries, not hardcode a kind list.`);
  }
  return findings;
}

export function checkCapabilitiesKindSource(root = DEFAULT_ROOT) {
  const target = path.join(root, TARGET_PATH);
  const source = readFileSync(target, "utf8");
  const findings = findCapabilitiesKindSourceViolations(source, TARGET_PATH);
  return {
    ok: findings.length === 0,
    findings
  };
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function main() {
  const result = checkCapabilitiesKindSource();
  if (!result.ok) {
    for (const finding of result.findings) console.error(finding);
    process.exitCode = 1;
    return;
  }
  console.log("Capabilities kind source check passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
