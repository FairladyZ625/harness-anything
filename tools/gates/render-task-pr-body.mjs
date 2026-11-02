#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { checkPrBody } from "../check-pr-body.mjs";
import { readSubmissionFacts } from "../../packages/kernel/src/domain/submission-facts.ts";
import { markdownSections } from "../../packages/kernel/src/domain/transition-document-readiness.ts";
import { repoRoot } from "./git.mjs";

const START = "<!-- harness:submission-facts:start -->";
const END = "<!-- harness:submission-facts:end -->";

// The PR template owns the four authored sections; this mapping only says which closeout section
// feeds each one. The closeout is the single authoring place (dec_BB2BCE9F995CD3A126E2918734 CH1),
// so no second PR-body template lives here.
const PR_SECTIONS = Object.freeze([
  { title: "Summary", aliases: Object.freeze(["summary", "概要"]) },
  { title: "What Changed", aliases: Object.freeze(["what changed", "改动内容", "改动"]) },
  { title: "Verification", aliases: Object.freeze(["verification", "验证"]) },
  { title: "Residual Risk", aliases: Object.freeze(["residual risk", "剩余风险", "残余风险"]) },
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function taskProjection(receipt, taskId) {
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
  return { submission: current.submission, packagePath: projection.packagePath };
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
  const facts = readSubmissionFacts(submission);
  const files = submittedPaths(facts.changedFiles, "changedFiles");
  if (facts.kind === "legacy")
    return [
      "## Delivery Facts",
      `- Delivery commit: ${inlineCode(submission.commitSha)}`,
      "- Legacy submission facts: this historical cut predates frozen changedFiles and productionDelta.",
      "- Changed paths (stored delivery evidence):",
      ...(files.length ? files.map((filePath) => `  - ${pathCode(filePath)}`) : ["  - none"]),
      "- Production delta: unavailable on this legacy cut.",
    ].join("\n");
  const delta = facts.productionDelta;
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
    throw new Error("submitted code cut has no valid frozen productionDelta");
  const net = delta.added - delta.deleted,
    unclassified = delta.unclassified.length
      ? ["- G33 unclassified production paths:", ...delta.unclassified.map((entry) => `  - ${pathCode(entry)}`)]
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

function findSection(sections, aliases) {
  for (const alias of aliases) if (sections.has(alias)) return sections.get(alias);
  for (const [heading, content] of sections)
    for (const alias of aliases)
      if (heading.startsWith(alias) && /^[ \t(（—–\-:：]/u.test(heading.slice(alias.length))) return content;
  return undefined;
}

function authoredSources(closeout) {
  const sections = markdownSections(closeout);
  return Object.fromEntries(PR_SECTIONS.map(({ title, aliases }) => [title, findSection(sections, aliases)]));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function markerPair(body, label) {
  const start = body.indexOf(START),
    end = body.indexOf(END);
  if (
    start < 0 ||
    end < 0 ||
    start >= end ||
    body.indexOf(START, start + START.length) >= 0 ||
    body.indexOf(END, end + END.length) >= 0
  )
    throw new Error(`${label} must contain exactly one ordered submission-facts marker pair`);
  return { start, end };
}

/** Detach the previous facts so an unfilled section is compared without generated content. */
function withoutFacts(body) {
  const { start, end } = markerPair(body, "PR template");
  return body.slice(0, start + START.length) + body.slice(end);
}

function sectionBounds(body, title) {
  const match = new RegExp(`^##[ \\t]+${escapeRegExp(title)}[ \\t]*$`, "mu").exec(body);
  if (!match) throw new Error(`PR template is missing the ## ${title} section`);
  const start = match.index + match[0].length,
    next = /^##[ \t]+/mu.exec(body.slice(start));
  return { start, end: next ? start + next.index : body.length };
}

function normalizedSection(body, title) {
  const { start, end } = sectionBounds(body, title);
  return body
    .slice(start, end)
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function assertInjectable(title, content) {
  if (/^##[ \t]/mu.test(content))
    throw new Error(`closeout.md ## ${title} contains a top-level "## " heading; it cannot be injected as-is`);
  if (content.includes(START) || content.includes(END))
    throw new Error(`closeout.md ## ${title} contains a submission-facts marker; it cannot be injected as-is`);
}

function fillSection(body, title, content) {
  const { start, end } = sectionBounds(body, title),
    section = body.slice(start, end),
    keptMarkers = section.includes(START) && section.includes(END) ? `\n\n${START}\n${END}` : "";
  return `${body.slice(0, start)}\n\n${content.trim()}${keptMarkers}\n\n${body.slice(end)}`;
}

export function renderTaskPrBody({ taskId, receipt, template, body = template, closeout }) {
  const submission = taskProjection(receipt, taskId).submission,
    facts = deliveryFacts(submission),
    stripped = withoutFacts(body),
    baseline = withoutFacts(template),
    sources = authoredSources(typeof closeout === "string" ? closeout : "");
  let rendered = stripped;
  const missing = [];
  for (const { title } of PR_SECTIONS) {
    if (normalizedSection(stripped, title) !== normalizedSection(baseline, title)) continue;
    const content = sources[title];
    if (typeof content !== "string" || content.trim().length === 0) {
      missing.push(title);
      continue;
    }
    assertInjectable(title, content);
    rendered = fillSection(rendered, title, content);
  }
  if (missing.length > 0) throw new Error(`closeout.md is missing required section(s): ${missing.join(", ")}`);
  const privateTaskIds = [...new Set(rendered.match(/\btask_[0-9a-z]{8,26}\b/gu) ?? [])];
  if (privateTaskIds.length > 0)
    throw new Error(
      `rendered PR body contains private task id(s): ${privateTaskIds.join(", ")}; remove them from closeout.md before opening a pull request`,
    );
  const { start, end } = markerPair(rendered, "PR template");
  return `${rendered.slice(0, start + START.length)}\n${facts}\n${rendered.slice(end)}`;
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

function readCloseout(rootDir, packagePath) {
  if (
    typeof packagePath !== "string" ||
    packagePath.length === 0 ||
    packagePath.startsWith("/") ||
    packagePath.split("/").includes("..")
  )
    throw new Error("task projection has no usable packagePath for closeout.md");
  const docPath = `${packagePath}/closeout.md`;
  try {
    return execFileSync("ha", ["doc", "show", "--path", docPath, "--raw"], {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = record(error) && error.stderr !== undefined ? String(error.stderr).trim() : String(error),
      detail = stderr.split(/\r?\n/u)[0] || "unknown ha doc show failure";
    throw new Error(`cannot read ${docPath} with ha doc show: ${detail}`);
  }
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
      { submission, packagePath } = taskProjection(receipt, options.taskId),
      closeout = readCloseout(rootDir, packagePath),
      template = readFileSync(path.resolve(rootDir, ".github/pull_request_template.md"), "utf8"),
      input =
        path.resolve(rootDir, options.bodyFile) === path.resolve(rootDir, ".github/pull_request_template.md")
          ? template
          : readFileSync(path.resolve(rootDir, options.bodyFile), "utf8"),
      body = renderTaskPrBody({ taskId: options.taskId, receipt, template, body: input, closeout }),
      check = checkPrBody(body, {
        prTemplate: template,
        eventMigration: { files: readSubmissionFacts(submission).changedFiles },
      });
    if (!check.ok) throw new Error(["rendered PR body fails check-pr-body:", ...check.issues].join("\n"));
    process.stdout.write(body);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
