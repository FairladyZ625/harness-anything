#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { createPackageBoundaryPlugin } from "./eslint-package-boundaries.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adjacencyRuleId = "package-boundaries/adjacency";
const pathsRuleId = "package-boundaries/paths";
const eslint = new ESLint({
  cwd: root,
  overrideConfig: {
    plugins: { "package-boundaries": createPackageBoundaryPlugin(root) },
    rules: { [adjacencyRuleId]: "error", [pathsRuleId]: "warn" }
  }
});
const results = await eslint.lintFiles(["packages/**/*.{js,mjs,ts,tsx}"]);
const messages = results.flatMap((result) => result.messages
  .filter((message) => message.ruleId === adjacencyRuleId || message.ruleId === pathsRuleId)
  .map((message) => ({ file: path.relative(root, result.filePath).split(path.sep).join("/"), ...message })));
const counts = Object.fromEntries([...new Set(Object.values(messages.map((message) => message.messageId)))].map((id) => [id, 0]));
for (const message of messages) counts[message.messageId] = (counts[message.messageId] ?? 0) + 1;
for (const message of messages) {
  const label = message.severity === 2 ? "error (ratcheted)" : "warning";
  console.warn(`${message.file}:${message.line}:${message.column} ${label} ${message.message} ${message.ruleId}`);
}
const adjacencyErrors = messages.filter((message) => message.ruleId === adjacencyRuleId);
const pathWarnings = messages.filter((message) => message.ruleId === pathsRuleId);
const baseline = JSON.parse(readFileSync(path.join(root, "tools/package-boundary-violations.json"), "utf8"));
console.log(`Package boundary ESLint gate: ${adjacencyErrors.length} ratcheted error(s), ${pathWarnings.length} warning(s) ${JSON.stringify(counts)}.`);

if (adjacencyErrors.length !== baseline.total) {
  console.error(`Package boundary adjacency error count must equal explicit ratchet baseline: current=${adjacencyErrors.length} baseline=${baseline.total}.`);
  process.exitCode = 1;
}

const fatal = results.flatMap((result) => result.messages.filter((message) => message.fatal));
if (fatal.length > 0) {
  console.error(`Package boundary ESLint gate could not parse ${fatal.length} file(s).`);
  process.exitCode = 1;
}
