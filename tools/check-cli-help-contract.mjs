import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const registryPath = "packages/cli/src/cli/command-registry.ts";
const commandSpecDirPath = "packages/cli/src/cli/command-spec";
const receiptPath = "packages/cli/src/cli/receipt.ts";
const entrypointPath = "packages/cli/src/index.ts";
const defaultMinimumCommands = 20;

export function findCliHelpContractViolations(rootDir = process.cwd(), options = {}) {
  const minimumCommands = options.minimumCommands ?? defaultMinimumCommands;
  const registrySource = readFileSync(path.join(rootDir, registryPath), "utf8");
  const receiptSource = readFileSync(path.join(rootDir, receiptPath), "utf8");
  const entrypointSource = readFileSync(path.join(rootDir, entrypointPath), "utf8");
  const specSources = readdirSync(path.join(rootDir, commandSpecDirPath))
    .filter((name) => name.startsWith("command-spec-") && name.endsWith(".ts"))
    .sort()
    .map((name) => readFileSync(path.join(rootDir, commandSpecDirPath, name), "utf8"));

  const entries = specSources.flatMap(extractSpecEntries);
  const violations = [];

  if (entries.length < minimumCommands) {
    violations.push(
      `checker parsed only ${entries.length} command specs (< ${minimumCommands}); the command-spec source shape changed — update tools/check-cli-help-contract.mjs instead of accepting a vacuous pass`
    );
  }

  const kinds = entries.map((entry) => entry.kind);
  for (const kind of new Set(kinds.filter((kind, index) => kinds.indexOf(kind) !== index))) {
    violations.push(`command ${kind} is declared more than once across command-spec files`);
  }

  for (const entry of entries) {
    if (!entry.usage) violations.push(`command ${entry.kind} is missing usage`);
    if (!entry.summary) violations.push(`command ${entry.kind} is missing summary`);
    if (entry.examples.length === 0) violations.push(`command ${entry.kind} is missing examples`);
    if (!entry.hasReceiptContract) violations.push(`command ${entry.kind} is missing command descriptor receipt contract`);
    const descriptionByFlag = new Map(entry.options.map((option) => [option.flag, option.description]));
    const usageFlags = flagsFromText(entry.usage);
    for (const flag of usageFlags) {
      const description = descriptionByFlag.get(flag);
      if (description === undefined) {
        violations.push(`command ${entry.kind} option ${flag} is missing an options declaration`);
      } else if (description.trim().length === 0) {
        violations.push(`command ${entry.kind} option ${flag} has an empty description`);
      }
    }
    const usageFlagSet = new Set(usageFlags);
    for (const example of entry.examples) {
      for (const flag of flagsFromText(example)) {
        if (!usageFlagSet.has(flag)) {
          violations.push(`command ${entry.kind} example uses ${flag} but usage does not list it`);
        }
      }
    }
  }

  const specJoined = specSources.join("\n");
  if (/humanizeKind|Set this command option/u.test(`${registrySource}\n${specJoined}`)) {
    violations.push("command help must not use generic summary or option-description fallback text");
  }
  if (/CliResult\/v1/u.test(registrySource) || /CliResult\/v1/u.test(receiptSource) || /CliResult\/v1/u.test(entrypointSource)) {
    violations.push("CLI success output must use command-receipt/v2, not CliResult/v1");
  }
  if (/JSON\.stringify\(result\)/u.test(entrypointSource)) {
    violations.push("CLI entrypoint must serialize normalized CommandReceipt output, not raw CliResult");
  }
  return violations;
}

function extractSpecEntries(source) {
  const kindMatches = [...source.matchAll(/"kind":\s*"([^"]+)"/gu)];
  return kindMatches.map((match, index) => {
    const sliceStart = match.index ?? 0;
    const sliceEnd = index + 1 < kindMatches.length ? kindMatches[index + 1].index : source.length;
    const slice = source.slice(sliceStart, sliceEnd);
    return {
      kind: match[1],
      usage: quotedField(slice, "usage"),
      summary: quotedField(slice, "summary"),
      examples: stringArrayField(slice, "examples"),
      options: optionEntries(slice),
      hasReceiptContract: /"receiptContract":\s*\{/u.test(slice)
    };
  });
}

function quotedField(slice, fieldName) {
  const match = new RegExp(`"${fieldName}":\\s*"((?:[^"\\\\]|\\\\.)*)"`, "u").exec(slice);
  return match ? match[1] : "";
}

function stringArrayField(slice, fieldName) {
  const start = new RegExp(`"${fieldName}":\\s*\\[`, "u").exec(slice);
  if (!start || start.index === undefined) return [];
  const body = balancedSlice(slice, start.index + start[0].length - 1, "[", "]");
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((entry) => entry[1]);
}

function optionEntries(slice) {
  const start = /"options":\s*\[/u.exec(slice);
  if (!start || start.index === undefined) return [];
  const body = balancedSlice(slice, start.index + start[0].length - 1, "[", "]");
  return [...body.matchAll(/\{\s*"flag":\s*"([^"]+)"\s*,\s*"description":\s*"((?:[^"\\]|\\.)*)"\s*\}/gu)].map(
    (entry) => ({ flag: entry[1], description: entry[2] })
  );
}

function balancedSlice(source, openIndex, open, close) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth === 0) return source.slice(openIndex, index + 1);
  }
  throw new Error(`unterminated ${open}${close} literal`);
}

function flagsFromText(source) {
  return [...new Set([...source.matchAll(/--[a-z0-9-]+/gu)].map((match) => match[0]))];
}

function main() {
  const violations = findCliHelpContractViolations();
  if (violations.length === 0) return;

  console.error("CLI help contract gate failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
