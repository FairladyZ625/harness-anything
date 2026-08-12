#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const commandPath = "packages/cli/src/cli/thin-command.ts";
const entrypointPath = "packages/cli/src/index.ts";

export function findCliHelpContractViolations(rootDir = process.cwd(), options = {}) {
  const source = readFileSync(path.join(rootDir, commandPath), "utf8");
  const entrypoint = readFileSync(path.join(rootDir, entrypointPath), "utf8");
  const commands = extractCommands(source), violations = [];
  const minimumCommands = options.minimumCommands ?? 13;
  if (commands.length < minimumCommands) violations.push(`thin command directory contains ${commands.length} commands (< ${minimumCommands}); refusing a vacuous help surface`);
  const usages = commands.map(({ usage }) => usage);
  for (const duplicate of new Set(usages.filter((usage, index) => usages.indexOf(usage) !== index))) violations.push(`duplicate CLI usage: ${duplicate}`);
  for (const command of commands) {
    if (!command.usage.startsWith("ha ")) violations.push(`usage must start with ha: ${command.usage}`);
    if (!command.summary.trim()) violations.push(`command ${command.usage} is missing summary`);
    for (const flag of flags(command.usage)) if (!source.includes(`"${flag}"`) && !readControl(rootDir).includes(`"${flag}"`)) {
      violations.push(`command ${command.usage} documents unsupported option ${flag}`);
    }
  }
  if (!/argv\.length\s*===\s*0\s*\|\|\s*argv\.includes\("--help"\)/u.test(entrypoint) || !entrypoint.includes("renderThinHelp()")) {
    violations.push("CLI entrypoint must render the derived thin command directory for empty argv and --help");
  }
  if (!source.includes("...thinCliCommands.map")) violations.push("help output must derive from thinCliCommands");
  if (/CliResult\/v1|command-registry/u.test(`${source}\n${entrypoint}`)) violations.push("thin help must not depend on the retired CLI registry or CliResult/v1");
  return violations;
}

function extractCommands(source) { return [...source.matchAll(/\{\s*usage:\s*"([^"]+)"\s*,\s*summary:\s*"([^"]*)"\s*\}/gu)]
  .map((match) => ({ usage: match[1], summary: match[2] })); }
function flags(source) { return [...new Set([...source.matchAll(/--[a-z0-9-]+/gu)].map((match) => match[0]))]; }
function readControl(rootDir) { return readFileSync(path.join(rootDir, "packages/cli/src/daemon/control.ts"), "utf8"); }
function main() { const violations = findCliHelpContractViolations(); if (violations.length === 0) return;
  console.error("CLI help contract gate failed:"); for (const violation of violations) console.error(`- ${violation}`); process.exitCode = 1; }
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
