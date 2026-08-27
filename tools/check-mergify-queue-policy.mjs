#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mergifyPath = path.join(repoRoot, ".mergify.yml");

export function checkMergifyQueuePolicy({ mergifyText = readFileSync(mergifyPath, "utf8") } = {}) {
  const queueRules = parseNamedRules(mergifyText, "queue_rules");
  const pullRequestRules = parseNamedRules(mergifyText, "pull_request_rules");
  const defaultQueue = queueRules.find((rule) => rule.name === "default");
  const errors = [];
  const hardCodedChecks = queueRules.flatMap((rule) =>
    readList(rule.lines, "queue_conditions")
      .filter((condition) => condition.startsWith("check-success = "))
      .map((condition) => `${rule.name}: ${condition}`),
  );

  if (hardCodedChecks.length > 0) {
    errors.push(`queue rules must not hard-code check-success contexts: ${hardCodedChecks.join(", ")}`);
  }

  if (!defaultQueue) {
    errors.push(".mergify.yml declares no default queue rule");
  } else {
    if (readScalar(defaultQueue.lines, "branch_protection_injection_mode") !== "queue") {
      errors.push("default queue must derive required checks with branch_protection_injection_mode: queue");
    }

    const conditions = readList(defaultQueue.lines, "queue_conditions");
    if (!conditions.includes("#check-failure = 0")) {
      errors.push("default queue must reject failed checks with #check-failure = 0");
    }
  }

  const requeueRule = pullRequestRules.find((rule) => isAutomaticRequeueRule(rule));
  if (!requeueRule) {
    errors.push(
      "pull_request_rules must queue merge-queue + dequeued PRs after #check-failure = 0 and #check-pending = 0",
    );
  } else {
    if (readActionScalar(requeueRule.lines, "queue", "name") !== "default") {
      errors.push("automatic requeue rule must target the default queue");
    }
    if (!readActionList(requeueRule.lines, "label", "remove").includes("dequeued")) {
      errors.push("automatic requeue rule must remove the dequeued label");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    queueRule: defaultQueue?.name ?? null,
    requeueRule: requeueRule?.name ?? null,
  };
}

function isAutomaticRequeueRule(rule) {
  const conditions = new Set(readList(rule.lines, "conditions"));
  return ["base = main", "label = merge-queue", "label = dequeued", "#check-failure = 0", "#check-pending = 0"].every(
    (condition) => conditions.has(condition),
  );
}

function parseNamedRules(text, sectionName) {
  const section = readTopLevelSection(text, sectionName);
  const rules = [];
  let current = null;

  for (const line of section) {
    const nameMatch = /^  - name:\s*(.+?)\s*$/u.exec(line);
    if (nameMatch) {
      current = { name: unquoteYamlScalar(nameMatch[1]), lines: [line] };
      rules.push(current);
      continue;
    }
    current?.lines.push(line);
  }

  return rules;
}

function readTopLevelSection(text, sectionName) {
  const lines = text.split(/\r?\n/u);
  const header = `${sectionName}:`;
  const start = lines.findIndex((line) => line.trimEnd() === header);
  if (start < 0) return [];

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/u.test(lines[index]) && !lines[index].startsWith("#")) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function readScalar(lines, key, indent = 4) {
  const prefix = " ".repeat(indent);
  const pattern = new RegExp(`^${prefix}${escapeRegex(key)}:\\s*(.+?)\\s*$`, "u");
  const match = lines.map((line) => pattern.exec(line)).find(Boolean);
  return match ? unquoteYamlScalar(match[1]) : null;
}

function readList(lines, key, indent = 4) {
  const block = readNestedBlock(lines, `${" ".repeat(indent)}${key}:`, indent);
  const itemPattern = new RegExp(`^\\s{${indent + 2}}-\\s*(.+?)\\s*$`, "u");
  return block
    .map((line) => itemPattern.exec(line))
    .filter(Boolean)
    .map((match) => match[1].trim())
    .filter((value) => !value.startsWith("#"))
    .map((value) => normalizeCondition(unquoteYamlScalar(value)));
}

function readActionScalar(lines, action, key) {
  const actions = readNestedBlock(lines, "    actions:", 4);
  const actionLines = readNestedBlock(actions, `      ${action}:`, 6);
  return readScalar(actionLines, key, 8);
}

function readActionList(lines, action, key) {
  const actions = readNestedBlock(lines, "    actions:", 4);
  const actionLines = readNestedBlock(actions, `      ${action}:`, 6);
  return readList(actionLines, key, 8);
}

function readNestedBlock(lines, header, headerIndent) {
  const start = lines.findIndex((line) => line.trimEnd() === header);
  if (start < 0) return [];

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "" || lines[index].trimStart().startsWith("#")) continue;
    const indent = lines[index].search(/\S/u);
    if (indent <= headerIndent) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function normalizeCondition(value) {
  return value
    .replace(/\s*([=!<>~]+)\s*/gu, " $1 ")
    .replace(/\s+/gu, " ")
    .trim();
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"');
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/gu, "'");
  }
  return trimmed;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function main() {
  const result = checkMergifyQueuePolicy();
  if (!result.ok) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
    return;
  }

  console.log(`Mergify queue policy check passed (automatic rule: ${result.requeueRule}).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
