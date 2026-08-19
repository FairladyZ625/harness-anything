#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const commandPath = "packages/daemon/src/protocol/daemon-protocol.contract.ts";
const renderPath = "packages/cli/src/cli/thin-command.ts";
const entrypointPath = "packages/cli/src/index.ts";
let loadSequence = 0;

export async function findCliHelpContractViolations(rootDir = process.cwd(), options = {}) {
  const source = readFileSync(path.join(rootDir, commandPath), "utf8");
  const render = readFileSync(path.join(rootDir, renderPath), "utf8");
  const entrypoint = readFileSync(path.join(rootDir, entrypointPath), "utf8");
  const commands = options.commands ?? await loadCommands(rootDir), violations = [];
  const minimumCommands = options.minimumCommands ?? 13;
  if (commands.length < minimumCommands) violations.push(`thin command directory contains ${commands.length} commands (< ${minimumCommands}); refusing a vacuous help surface`);
  const usages = commands.map(({ usage }) => usage);
  for (const duplicate of new Set(usages.filter((usage, index) => usages.indexOf(usage) !== index))) violations.push(`duplicate CLI usage: ${duplicate}`);
  for (const command of commands) {
    if (!command.usage.startsWith("ha ")) violations.push(`usage must start with ha: ${command.usage}`);
    if (!command.summary.trim()) violations.push(`command ${command.usage} is missing summary`);
    const routeFlags = new Set(command.path.filter((token) => token.startsWith("--"))), parserFlags = new Set(command.inputs.map(({ name }) => name)), usageFlags = flags(command.usage), help = typeof command.help === "string" ? command.help : `${command.usage}\n${command.summary}`;
    for (const flag of usageFlags) if (!routeFlags.has(flag) && !parserFlags.has(flag)) violations.push(`command ${command.usage} documents unsupported option ${flag}`);
    for (const flag of parserFlags) if (!usageFlags.includes(flag)) violations.push(`command ${command.usage} omits declared option ${flag}`);
    for (const input of command.inputs) checkInputHelp(command, input, help, violations);
  }
  if (!/argv\.length\s*===\s*0\s*\|\|\s*argv\.includes\("--help"\)/u.test(entrypoint) || !entrypoint.includes("renderThinHelp()")) violations.push("CLI entrypoint must render the derived thin command directory for empty argv and --help");
  if (!/thinCliCommands\.map\(\(\{\s*usage,\s*summary,\s*help\s*\}\)/u.test(render) || !/help\s*\?\s*`\\n\$\{help\}`/u.test(render)) violations.push("help output must derive input details from the command contract");
  if (/CliResult\/v1|command-registry/u.test(`${source}\n${entrypoint}`)) violations.push("thin help must not depend on the retired CLI registry or CliResult/v1");
  return violations;
}

function checkInputHelp(command, input, help, violations) {
  const prefix = `command ${command.usage} input ${input.name}`;
  if (input.required && !/\brequired\b/u.test(helpForInput(help, input))) violations.push(`${prefix} [parameter-relations]: required input is not visible in help`);
  if (Array.isArray(input.jsonFields)) {
    for (const field of input.jsonFields) if (!helpForInput(help, input).includes(field)) violations.push(`${prefix} [json-fields]: help omits required JSON field ${field}`);
  } else if (input.name === "--from-file" || input.name === "--json-input") violations.push(`${prefix} [json-fields]: structured JSON input must declare required fields in the input contract`);
  if (Array.isArray(input.enum)) for (const value of input.enum) if (!helpForInput(help, input).includes(value)) violations.push(`${prefix} [enum-values]: help omits enum value ${value}`);
  const bounds = input.minLength !== undefined || input.maxLength !== undefined ? [input.minLength ?? 0, input.maxLength ?? "∞"] : regexLength(input.regex);
  if (bounds && (!helpForInput(help, input).includes(`length: ${bounds[0]}..${bounds[1]}`) || !/\b(?:characters?|bytes?)\b/iu.test(helpForInput(help, input)))) violations.push(`${prefix} [constraints]: bounded length must be visible with a character/byte unit`);
  if (input.minItems !== undefined || input.maxItems !== undefined) {
    const count = `count: ${input.minItems ?? 0}..${input.maxItems ?? "∞"}`;
    if (!helpForInput(help, input).includes(count) || !/\bitems?\b/iu.test(helpForInput(help, input))) violations.push(`${prefix} [constraints]: item count must be visible with an item unit`);
  }
  if (input.unique && !/\bunique\b/iu.test(helpForInput(help, input))) violations.push(`${prefix} [constraints]: uniqueness must be visible in help`);
  for (const relation of [...(input.requires ?? []), ...(input.requiresAny ?? []), ...(input.conflictsWith ?? [])]) if (!helpForInput(help, input).includes(relation)) violations.push(`${prefix} [parameter-relations]: help omits relation ${relation}`);
  if (parameterRelationHint(input.error.nextAction) && !helpForInput(help, input).includes(input.error.nextAction)) violations.push(`${prefix} [parameter-relations]: help omits declared relationship hint`);
  if (input.format && !helpForInput(help, input).includes(input.format)) violations.push(`${prefix} [structured-format]: help omits format ${input.format}`);
  if (input.regex && !input.format && !helpForInput(help, input).includes(input.regex) && !helpForInput(help, input).includes(input.error.nextAction)) violations.push(`${prefix} [structured-format]: help omits declared input format`);
  if (/(?:\bcannot\b|\bnot allowed\b|\bnot permitted\b|\bforbidden\b|\bprohibited\b)/iu.test(input.error.nextAction) && !/(?:--[a-z0-9-]+|\bha\s+[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)?\b)/iu.test(input.error.nextAction)) violations.push(`${prefix} [actionable-hint]: negative hint must name a command or flag for the next step`);
}

function helpForInput(help, input) { return help.split(/\r?\n/u).filter((line) => line.includes(input.name)).join("\n"); }
function regexLength(regex) { const match = regex?.match(/\{(\d+)(?:,(\d+))?\}/u); if (!match) return undefined; return [Number(match[1]), Number(match[2] ?? match[1])]; }
function parameterRelationHint(value) { return /(?:\b(?:exactly one|one of|either|together|not both|only valid|requires|without|with)\b|,\s*or\b)/iu.test(value); }

async function loadCommands(rootDir) { const module = await import(`${pathToFileURL(path.join(rootDir, commandPath)).href}?cli-help=${loadSequence += 1}`); return module.daemonProtocolCommands ?? module.thinCliCommands; }
function flags(source) { return [...new Set([...source.matchAll(/--[a-z0-9-]+/gu)].map((match) => match[0]))]; }
async function main() { const violations = await findCliHelpContractViolations(); if (violations.length === 0) return; console.error("CLI help contract gate failed:"); for (const violation of violations) console.error(`- ${violation}`); process.exitCode = 1; }
if (path.resolve(process.argv[1] ?? "") === new URL(import.meta.url).pathname) await main();
