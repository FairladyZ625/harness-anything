#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { git, repoRoot } from "./git.mjs";

const START = "<!-- harness:submission-facts:start -->";
const END = "<!-- harness:submission-facts:end -->";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function taskSubmission(receipt, taskId) {
  if (!record(receipt) || receipt.ok !== true || typeof receipt.evidence !== "string")
    throw new Error(`ha task show ${taskId} did not return a successful task projection`);
  const projection = JSON.parse(receipt.evidence),
    task = projection.task;
  if (!record(task) || task.taskId !== taskId || !Number.isSafeInteger(task.iteration))
    throw new Error(`task projection does not identify ${taskId}`);
  const candidates = (Array.isArray(projection.executions) ? projection.executions : [])
      .filter(
        (execution) =>
          record(execution) &&
          execution.taskId === taskId &&
          execution.iteration === task.iteration &&
          record(execution.submission),
      )
      .sort((left, right) => String(left.submittedAt ?? "").localeCompare(String(right.submittedAt ?? ""))),
    current = candidates.at(-1);
  if (!current) throw new Error(`task ${taskId} has no submitted cut for iteration ${task.iteration}`);
  return current.submission;
}

function submittedPaths(value, name) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string"))
    throw new Error(`submitted cut has an invalid ${name} list`);
  return [...new Set(value)].sort();
}

function inlineCode(value) {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function pathCode(value) {
  const encoded = JSON.stringify(value),
    longestTickRun = Math.max(0, ...(encoded.match(/`+/gu) ?? []).map((run) => run.length)),
    delimiter = "`".repeat(longestTickRun + 1);
  return `${delimiter}${encoded}${delimiter}`;
}

function deliveryFacts(submission) {
  if (submission.commitSha === null) {
    const artifacts = submittedPaths(submission.deliverables, "deliverables");
    return [
      "## Delivery Facts",
      "- Delivery: artifact-only; no public Git commit.",
      `- Delivered artifacts: ${artifacts.length} center-accepted artifact(s); paths remain in the private submission record.`,
    ].join("\n");
  }
  if (!isSha(submission.commitSha)) throw new Error("submitted cut has an invalid delivery commit SHA");
  const files = submittedPaths(submission.changedFiles, "changedFiles");
  const delta = submission.productionDelta;
  if (
    !record(delta) ||
    !isSha(delta.baseSha) ||
    !Number.isSafeInteger(delta.added) ||
    delta.added < 0 ||
    !Number.isSafeInteger(delta.deleted) ||
    delta.deleted < 0 ||
    !Array.isArray(delta.changed) ||
    !delta.changed.every((entry) => record(entry) && typeof entry.filePath === "string") ||
    !Array.isArray(delta.unclassified) ||
    !delta.unclassified.every((entry) => typeof entry === "string")
  )
    throw new Error("submitted code cut has no valid frozen productionDelta; amend the submission before opening the PR");
  const net = delta.added - delta.deleted,
    unclassified = delta.unclassified.length
      ? [
          "- G33 unclassified production paths:",
          ...delta.unclassified.map((entry) => `  - ${pathCode(entry)}`),
        ]
      : ["- G33 classification: complete."],
    changed = files.length ? files.map((filePath) => `  - ${pathCode(filePath)}`) : ["  - none"];
  return [
    "## Delivery Facts",
    `- Delivery commit: ${inlineCode(submission.commitSha)}`,
    `- Merge base: ${inlineCode(delta.baseSha)}`,
    `- Production delta: +${delta.added}/-${delta.deleted} (net ${net >= 0 ? "+" : ""}${net}).`,
    "- Changed files:",
    ...changed,
    ...unclassified,
  ].join("\n");
}

export function renderTaskPrBody({ taskId, receipt, template, headSha }) {
  const start = template.indexOf(START),
    end = template.indexOf(END);
  if (
    start < 0 ||
    end < 0 ||
    start >= end ||
    template.indexOf(START, start + START.length) >= 0 ||
    template.indexOf(END, end + END.length) >= 0
  )
    throw new Error("PR template must contain exactly one ordered submission-facts marker pair");
  const submission = taskSubmission(receipt, taskId);
  if (submission.commitSha !== null && headSha !== undefined && submission.commitSha !== headSha)
    throw new Error("current HEAD differs from the submitted delivery commit; amend the submission before opening the PR");
  const facts = deliveryFacts(submission);
  return `${template.slice(0, start + START.length)}\n${facts}\n${template.slice(end)}`;
}

function parseArgs(argv) {
  let taskId = null;
  let bodyFile = ".github/pull_request_template.md";
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help") return { help: true };
    if (option !== "--task" && option !== "--body-file") throw new Error(`unknown argument: ${option}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    if (option === "--task") taskId = value;
    else bodyFile = value;
    index += 1;
  }
  if (!taskId) throw new Error("usage: node tools/gates/render-task-pr-body.mjs --task <task-id> [--body-file <path>]");
  return { taskId, bodyFile };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log("Usage: node tools/gates/render-task-pr-body.mjs --task <task-id> [--body-file <path>]");
      return 0;
    }
    const rootDir = repoRoot(),
      receipt = JSON.parse(
        execFileSync("ha", ["task", "show", options.taskId, "--json"], {
          cwd: rootDir,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        }),
      ),
      template = readFileSync(path.resolve(rootDir, options.bodyFile), "utf8"),
      headSha = git(rootDir, ["rev-parse", "HEAD"]).trim();
    process.stdout.write(renderTaskPrBody({ taskId: options.taskId, receipt, template, headSha }));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
