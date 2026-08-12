#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = "packages/cli/src";
const contractPath = "packages/cli/src/cli/thin-command.ts";

export function findCliErrorCodeViolations(rootDir = process.cwd()) {
  const contract = readFileSync(path.join(rootDir, contractPath), "utf8");
  const codes = extractCodes(contract), violations = [];
  if (codes.length === 0) violations.push("thinCliLocalErrorCodes must declare the local parse/transport error vocabulary");
  for (const duplicate of new Set(codes.filter((code, index) => codes.indexOf(code) !== index))) violations.push(`thin CLI error code ${duplicate} is duplicated`);
  const known = new Set(codes), sources = walk(path.join(rootDir, sourceRoot)).map((file) => readFileSync(file, "utf8"));
  const usageSources = sources.map((source) => source.replace(/thinCliLocalErrorCodes\s*=\s*Object\.freeze\(\[[^\]]*\]\)/u, ""));
  for (const code of literalReceiptCodes(sources.join("\n"))) if (!known.has(code)) violations.push(`inline thin CLI receipt code ${code} is missing from thinCliLocalErrorCodes`);
  for (const code of codes) if (!usageSources.some((source) => source.includes(`"${code}"`))) violations.push(`thinCliLocalErrorCodes contains unused code ${code}`);
  if (sources.some((source) => /CliErrorCode|cliErrorCodeRegistry|cliKernelMappedErrorCodes/u.test(source))) violations.push("retired CliErrorCode registry must not return to the thin CLI");
  return violations;
}

function extractCodes(source) { const match = /thinCliLocalErrorCodes\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/u.exec(source); return match ? [...match[1].matchAll(/"([a-z][a-z0-9_]*)"/gu)].map((entry) => entry[1]) : []; }
function literalReceiptCodes(source) { const codes = new Set();
  for (const pattern of [/\brejected\(\s*"([a-z][a-z0-9_]*)"/gu, /\bfailure\([^,\n]+,\s*"([a-z][a-z0-9_]*)"/gu, /\bcode:\s*"([a-z][a-z0-9_]*)"/gu]) {
    for (const match of source.matchAll(pattern)) codes.add(match[1]);
  } return codes; }
function walk(dir) { const files = []; for (const entry of readdirSync(dir)) { const file = path.join(dir, entry); const stats = statSync(file);
  if (stats.isDirectory()) files.push(...walk(file)); else if (file.endsWith(".ts")) files.push(file); } return files; }
function main() { const violations = findCliErrorCodeViolations(); if (violations.length === 0) return;
  console.error("CLI error code gate failed:"); for (const violation of violations) console.error(`- ${violation}`); process.exitCode = 1; }
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
