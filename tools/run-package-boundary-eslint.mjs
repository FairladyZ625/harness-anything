#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { createPackageBoundaryPlugin } from "./eslint-package-boundaries.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ruleId = "package-boundaries/enforce";
const eslint = new ESLint({
  cwd: root,
  overrideConfig: {
    plugins: { "package-boundaries": createPackageBoundaryPlugin(root) },
    rules: { [ruleId]: "warn" }
  }
});
const results = await eslint.lintFiles(["packages/**/*.{js,mjs,ts,tsx}"]);
const messages = results.flatMap((result) => result.messages
  .filter((message) => message.ruleId === ruleId)
  .map((message) => ({ file: path.relative(root, result.filePath).split(path.sep).join("/"), ...message })));
const counts = Object.fromEntries([...new Set(Object.values(messages.map((message) => message.messageId)))].map((id) => [id, 0]));
for (const message of messages) counts[message.messageId] = (counts[message.messageId] ?? 0) + 1;
for (const message of messages) {
  console.warn(`${message.file}:${message.line}:${message.column} warning ${message.message} ${ruleId}`);
}
console.log(`Package boundary ESLint warn gate: ${messages.length} warning(s) ${JSON.stringify(counts)}.`);

const fatal = results.flatMap((result) => result.messages.filter((message) => message.fatal));
if (fatal.length > 0) {
  console.error(`Package boundary ESLint gate could not parse ${fatal.length} file(s).`);
  process.exitCode = 1;
}
