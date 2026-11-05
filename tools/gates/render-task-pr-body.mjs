#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { classifyProtectedChanges, deriveProtectedSurfaceRules } from "../check-pr-governance.mjs";
import {
  SUBMISSION_FACTS_END,
  SUBMISSION_FACTS_START,
  readSubmissionFacts,
  renderSubmissionFacts,
} from "../../packages/kernel/src/domain/submission-facts.ts";
import { markdownSections } from "../../packages/kernel/src/domain/transition-document-readiness.ts";
import { hasDependencyChange, replaceDependencyDeclaration } from "./dependency-policy.mjs";
import { repoRoot } from "./git.mjs";

const START = SUBMISSION_FACTS_START,
  END = SUBMISSION_FACTS_END;

// The PR template owns the four authored sections; this mapping only says which closeout section
// feeds each one. The closeout is the single authoring place (dec_BB2BCE9F995CD3A126E2918734 CH1),
// so no second PR-body template lives here.
const PR_SECTIONS = Object.freeze([
  { title: "Summary", aliases: Object.freeze(["summary", "概要"]) },
  { title: "What Changed", aliases: Object.freeze(["what changed", "改动内容", "改动"]) },
  { title: "Verification", aliases: Object.freeze(["verification", "验证"]) },
  { title: "Residual Risk", aliases: Object.freeze(["residual risk", "剩余风险", "残余风险"]) },
]);

// The PR template keeps Dependency-Change on one machine-readable line, not as a `##` section.
// G31 rejects the `none` sentinel whenever the cut touches a package.json or the lockfile, so the
// renderer takes the description from this closeout section and renders it on the template declaration line. G31 validates the published body separately.
const DEPENDENCY_CHANGE = Object.freeze({
  title: "Dependency Change",
  aliases: Object.freeze(["dependency change", "dependency-change", "依赖变更", "依赖改动", "依赖变化"]),
});

// A closeout materialized before the What Changed scaffold existed keeps that shape for the life of
// the task package and is frozen at submit, so map its authored Summary onto the PR template's What
// Changed instead of failing the only publication path. The lightweight closeout materializes only
// Summary and Verification; it also points Residual Risk at Verification, where that profile records
// accepted risks (dec_BB2BCE9F995CD3A126E2918734 CH1). A hand-authored section wins when the
// closeout carries one.
const LIGHTWEIGHT_PROFILE = "lightweight",
  LIGHTWEIGHT_RESIDUAL_RISK = "Accepted residual risks are recorded in the Verification section.";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathCode(value) {
  const encoded = JSON.stringify(value),
    longestTickRun = Math.max(0, ...(encoded.match(/`+/gu) ?? []).map((run) => run.length)),
    delimiter = "`".repeat(longestTickRun + 1);
  return `${delimiter}${encoded}${delimiter}`;
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
  return {
    submission: current.submission,
    packagePath: projection.packagePath,
    profileId: record(task.metadata) && typeof task.metadata.profileId === "string" ? task.metadata.profileId : null,
  };
}

function findSection(sections, aliases) {
  const matched = [...sections]
    .filter(([heading]) =>
      aliases.some(
        (alias) =>
          heading === alias || (heading.startsWith(alias) && /^[ \t(（—–\-:：]/u.test(heading.slice(alias.length))),
      ),
    )
    .map(([, content]) => content);
  return matched.length > 0 ? matched.join("\n\n") : undefined;
}

function authoredSources(closeout, profileId) {
  const sections = markdownSections(closeout),
    sources = Object.fromEntries(PR_SECTIONS.map(({ title, aliases }) => [title, findSection(sections, aliases)]));
  sources[DEPENDENCY_CHANGE.title] = findSection(sections, DEPENDENCY_CHANGE.aliases);
  sources["What Changed"] ??= sources.Summary;
  if (profileId === LIGHTWEIGHT_PROFILE) sources["Residual Risk"] ??= LIGHTWEIGHT_RESIDUAL_RISK;
  return sources;
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

// Closeout prose cannot introduce machine-owned markers or template section boundaries.
function authoredContent(content) {
  return content
    .replace(/^##(?=[ \t])/gmu, "###")
    .replaceAll(START, "&lt;!-- harness:submission-facts:start --&gt;")
    .replaceAll(END, "&lt;!-- harness:submission-facts:end --&gt;");
}

function fillSection(body, title, content) {
  const { start, end } = sectionBounds(body, title),
    section = body.slice(start, end),
    keptMarkers = section.includes(START) && section.includes(END) ? `\n\n${START}\n${END}` : "";
  return `${body.slice(0, start)}\n\n${authoredContent(content).trim()}${keptMarkers}\n\n${body.slice(end)}`;
}

/** Collapse closeout prose onto the one machine-readable line G31 parses. */
function dependencyDescription(content) {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^(?:[-*+]|\d+\.)[ \t]+/u, ""))
    .join(" ");
}

// The governance gate classifies protected paths from the gate manifest; the renderer reuses that
// classification and cites the task itself as the authority, so a touched protected surface is
// declared on the only rendering path instead of failing pr-body-lint after the PR opens.
function declareProtectedSurfaces(body, taskId, changedFiles, manifest) {
  if (!manifest) return body;
  const files = classifyProtectedChanges(changedFiles, deriveProtectedSurfaceRules(manifest)).map(({ file }) => file);
  if (files.length === 0) return body;
  return body
    .replace(/^- Protected surface touched: no$/mu, "- Protected surface touched: yes")
    .replace(/^- Protected surface scope:\s*$/mu, `- Protected surface scope: ${files.map(pathCode).join(", ")}`)
    .replace(/^- Authority: not applicable$/mu, `- Authority: ${taskId}`);
}

export function renderTaskPrBody({ taskId, receipt, template, body = template, closeout, manifest }) {
  const { submission, profileId } = taskProjection(receipt, taskId),
    submissionFacts = readSubmissionFacts(submission),
    delivery = renderSubmissionFacts(submission, submissionFacts),
    stripped = withoutFacts(body),
    baseline = withoutFacts(template),
    sources = authoredSources(typeof closeout === "string" ? closeout : "", profileId);
  let rendered = stripped;
  if (hasDependencyChange(submissionFacts.changedFiles) && sources[DEPENDENCY_CHANGE.title]?.trim()) {
    const { start, end } = sectionBounds(rendered, "Machine-Readable Declarations");
    rendered =
      rendered.slice(0, start) +
      replaceDependencyDeclaration(
        rendered.slice(start, end),
        authoredContent(dependencyDescription(sources[DEPENDENCY_CHANGE.title])),
      ) +
      rendered.slice(end);
  }
  for (const { title } of PR_SECTIONS) {
    if (normalizedSection(stripped, title) !== normalizedSection(baseline, title)) continue;
    const content = sources[title];
    // CH2: headings are authoring conventions, not a second admission contract. When a
    // heading is absent, publish the author's original document in its original order.
    rendered = fillSection(rendered, title, content?.trim() ? content : closeout);
  }
  rendered = declareProtectedSurfaces(rendered, taskId, submissionFacts.changedFiles, manifest);
  const { start, end } = markerPair(rendered, "PR template");
  return `${rendered.slice(0, start + START.length)}\n${delivery}\n${rendered.slice(end)}`;
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
      { packagePath } = taskProjection(receipt, options.taskId),
      closeout = readCloseout(rootDir, packagePath),
      template = readFileSync(path.resolve(rootDir, ".github/pull_request_template.md"), "utf8"),
      input =
        path.resolve(rootDir, options.bodyFile) === path.resolve(rootDir, ".github/pull_request_template.md")
          ? template
          : readFileSync(path.resolve(rootDir, options.bodyFile), "utf8"),
      manifest = JSON.parse(readFileSync(path.resolve(rootDir, "tools/gate-manifest.json"), "utf8")),
      body = renderTaskPrBody({ taskId: options.taskId, receipt, template, body: input, closeout, manifest });
    process.stdout.write(body);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
