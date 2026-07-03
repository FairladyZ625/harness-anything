import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const registryPath = "packages/cli/src/cli/command-registry.ts";
const optionDescriptionsPath = "packages/cli/src/cli/command-option-descriptions.ts";
const receiptPath = "packages/cli/src/cli/receipt.ts";
const receiptContractsPath = "packages/cli/src/cli/receipt-contracts.ts";
const entrypointPath = "packages/cli/src/index.ts";

export function findCliHelpContractViolations(rootDir = process.cwd()) {
  const source = readFileSync(path.join(rootDir, registryPath), "utf8");
  const optionDescriptionsSource = readFileSync(path.join(rootDir, optionDescriptionsPath), "utf8");
  const receiptSource = readFileSync(path.join(rootDir, receiptPath), "utf8");
  const receiptContractsSource = readFileSync(path.join(rootDir, receiptContractsPath), "utf8");
  const entrypointSource = readFileSync(path.join(rootDir, entrypointPath), "utf8");
  const commandUsageSource = extractAssignedLiteral(source, "commandUsages");
  const summarySource = extractAssignedLiteral(source, "commandSummaries");
  const exampleSource = extractAssignedLiteral(source, "commandExamples");
  const descriptionSource = extractAssignedLiteral(optionDescriptionsSource, "descriptions");
  const receiptContractSource = extractAssignedLiteral(receiptContractsSource, "commandReceiptContractsByKind");
  const violations = [];

  const commandKinds = [...commandUsageSource.matchAll(/\{\s*kind:\s*"([^"]+)"/gu)].map((match) => match[1]);
  const receiptKinds = objectKeys(receiptContractSource);
  const expectedReceiptKinds = commandKinds;
  const usageByKind = commandUsageByKind(commandUsageSource);
  const summaryKinds = objectKeys(summarySource);
  const exampleKinds = objectKeys(exampleSource);
  const examplesByKind = objectArrayEntries(exampleSource);
  const descriptionFlags = objectKeys(descriptionSource);
  const usageFlags = [...new Set([...commandUsageSource.matchAll(/--[a-z0-9-]+/gu)].map((match) => match[0]))];

  for (const kind of commandKinds) {
    if (!summaryKinds.has(kind)) violations.push(`command ${kind} is missing commandSummaries entry`);
    if (!exampleKinds.has(kind)) violations.push(`command ${kind} is missing commandExamples entry`);
  }
  for (const kind of summaryKinds) {
    if (!commandKinds.includes(kind)) violations.push(`commandSummaries has stale command ${kind}`);
  }
  for (const kind of exampleKinds) {
    if (!commandKinds.includes(kind)) violations.push(`commandExamples has stale command ${kind}`);
  }
  for (const kind of expectedReceiptKinds) {
    if (!receiptKinds.has(kind)) violations.push(`command ${kind} is missing command descriptor receipt contract`);
  }
  for (const kind of receiptKinds) {
    if (!expectedReceiptKinds.includes(kind)) violations.push(`commandReceiptContracts has stale command ${kind}`);
  }
  for (const flag of usageFlags) {
    if (!descriptionFlags.has(flag)) violations.push(`option ${flag} is missing help description`);
  }
  for (const [kind, exampleBody] of examplesByKind) {
    const usageFlagSet = new Set(flagsFromText(usageByKind.get(kind) ?? ""));
    for (const flag of flagsFromText(exampleBody)) {
      if (!usageFlagSet.has(flag)) {
        violations.push(`command ${kind} example uses ${flag} but usage does not list it`);
      }
    }
  }
  if (/humanizeKind|Set this command option/u.test(`${source}\n${optionDescriptionsSource}`)) {
    violations.push("command help must not use generic summary or option-description fallback text");
  }
  if (/CliResult\/v1/u.test(source) || /CliResult\/v1/u.test(receiptSource) || /CliResult\/v1/u.test(entrypointSource)) {
    violations.push("CLI success output must use CommandReceipt/v1, not CliResult/v1");
  }
  if (/JSON\.stringify\(result\)/u.test(entrypointSource)) {
    violations.push("CLI entrypoint must serialize normalized CommandReceipt output, not raw CliResult");
  }
  return violations;
}

function extractAssignedLiteral(source, constName) {
  const declaration = new RegExp(`\\bconst\\s+${constName}\\b[^=]*=`, "u").exec(source);
  if (!declaration?.index) {
    if (declaration?.index !== 0) throw new Error(`missing ${constName}`);
  }
  const start = declaration.index + declaration[0].length;
  const objectStart = source.indexOf("{", start);
  const arrayStart = source.indexOf("[", start);
  const bodyStart = objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart) ? objectStart : arrayStart;
  if (bodyStart < 0) throw new Error(`missing ${constName} literal`);
  const open = source[bodyStart];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
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
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index + 1);
  }
  throw new Error(`unterminated ${constName}`);
}

function objectKeys(source) {
  return new Set([...source.matchAll(/"([^"]+)"\s*:/gu)].map((match) => match[1]));
}

function commandUsageByKind(source) {
  return new Map([...source.matchAll(/\{\s*kind:\s*"([^"]+)"\s*,\s*usage:\s*"([^"]+)"/gu)].map((match) => [match[1], match[2]]));
}

function objectArrayEntries(source) {
  return new Map([...source.matchAll(/"([^"]+)"\s*:\s*\[([\s\S]*?)\]\s*(?:,|\})/gu)].map((match) => [match[1], match[2]]));
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
