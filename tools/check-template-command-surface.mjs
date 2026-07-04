#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandRegistry } from "../packages/cli/src/cli/command-registry.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultTemplateRoot = path.join(repoRoot, "packages/cli/src/commands/extensions/assets/software-coding/templates");
const deprecatedForms = [
  { pattern: /\b(?:ha|harness-anything)\s+record\s+fact\b/u, replacement: "ha fact record" },
  { pattern: /\b(?:ha|harness-anything)\s+task-review\b/u, replacement: "ha task review" },
  { pattern: /\b(?:ha|harness-anything)\s+task-complete\b/u, replacement: "ha task complete" },
  { pattern: /\b(?:ha|harness-anything)\s+task\s+status\s+set\b/u, replacement: "ha task transition" }
];

export function checkTemplateCommandSurface(options = {}) {
  const templateRoot = options.templateRoot ?? defaultTemplateRoot;
  const validPaths = new Set(commandRegistry.map((entry) => entry.commandPath.join(" ")));
  const failures = [];
  for (const filePath of listMarkdownFiles(templateRoot)) {
    const body = readFileSync(filePath, "utf8");
    const relativePath = path.relative(repoRoot, filePath);
    for (const command of extractHarnessCommands(body)) {
      const normalized = normalizeCommand(command);
      if (!normalized) continue;
      for (const deprecated of deprecatedForms) {
        if (deprecated.pattern.test(normalized.original)) {
          failures.push(`${relativePath}: deprecated command "${normalized.original}"; use ${deprecated.replacement}`);
        }
      }
      if (isPlaceholderCommand(normalized.tokens)) continue;
      const pathKey = longestRegisteredPrefix(normalized.tokens, validPaths);
      if (!pathKey) {
        failures.push(`${relativePath}: unknown command surface "${normalized.original}"`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

function listMarkdownFiles(rootDir) {
  if (!existsSync(rootDir)) return [];
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...listMarkdownFiles(entryPath));
    if (entry.isFile() && /\.md$/iu.test(entry.name)) files.push(entryPath);
  }
  return files;
}

function extractHarnessCommands(body) {
  const commands = [];
  for (const match of body.matchAll(/`([^`\n]*(?:ha|harness-anything|npx harness-anything)\s+[^`\n]+)`/gu)) {
    commands.push(match[1]);
  }
  for (const match of body.matchAll(/^(\s*(?:ha|harness-anything|npx harness-anything)\s+[^\n]+)/gmu)) {
    commands.push(match[1].trim());
  }
  return commands;
}

function normalizeCommand(command) {
  const withoutNpx = command.trim().replace(/^npx\s+harness-anything\b/u, "harness-anything");
  const launcherMatch = /^(?:ha|harness-anything)\b\s*(.*)$/u.exec(withoutNpx);
  if (!launcherMatch) return undefined;
  const tokens = tokenize(launcherMatch[1]);
  return { original: withoutNpx, tokens };
}

function tokenize(input) {
  return [...input.matchAll(/"[^"]*"|'[^']*'|\S+/gu)].map((match) => match[0]);
}

function isPlaceholderCommand(tokens) {
  return tokens.length === 0 || tokens[0] === "<command>" || tokens[0] === "...";
}

function longestRegisteredPrefix(tokens, validPaths) {
  for (let length = Math.min(tokens.length, 4); length >= 1; length -= 1) {
    const key = tokens.slice(0, length).join(" ");
    if (validPaths.has(key)) return key;
  }
  return undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkTemplateCommandSurface();
  if (!result.ok) {
    console.error("Seeded template command surface drift detected:");
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  }
}
