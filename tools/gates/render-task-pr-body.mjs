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
import {
  chineseCloseoutSectionBodies,
  chineseCloseoutSections,
  markdownSectionEntries,
  missingChineseCloseoutSections,
} from "../../packages/kernel/src/domain/transition-document-readiness.ts";
import {
  describeDependencyChange,
  readDependencyDeclarations,
  replaceDependencyDeclaration,
} from "./dependency-policy.mjs";
import { repoRoot } from "./git.mjs";

const START = SUBMISSION_FACTS_START,
  END = SUBMISSION_FACTS_END;

// The PR template owns the four authored sections; this mapping only says which closeout section
// feeds each one. The closeout is the single authoring place (dec_BB2BCE9F995CD3A126E2918734 CH1),
// so no second PR-body template lives here.
const PR_SECTIONS = Object.freeze([
  { title: "Summary", aliases: Object.freeze(["summary"]) },
  { title: "What Changed", aliases: Object.freeze(["what changed"]) },
  { title: "Verification", aliases: Object.freeze(["verification"]) },
  { title: "Residual Risk", aliases: Object.freeze(["residual risk"]) },
]);

// The review facts require a `# 中文` block with a Chinese verification heading. The renderer
// emits that shape from the same closeout instead of a second authored template. The Chinese
// closeout sections must carry the text: an English-only closeout is rejected rather than
// publishing English prose under Chinese headings. The aliases and the required-section judgment
// live in the kernel, so `ha task submit` refuses the same cut at the same boundary.
const CHINESE_HEADING = /^#\s+中文\s*$/mu;

// The PR template keeps Dependency-Change on one machine-readable line, not as a `##` section.
// G31 rejects the `none` sentinel whenever the cut touches a package.json or the lockfile, so the
// renderer phrases G31's own dependency-surface predicate from the frozen cut. The closeout cannot
// supply this text: a forgotten section must not force a red gate and a manual repair.
const MACHINE_READABLE_DECLARATIONS = "Machine-Readable Declarations";

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

/** The governing decision recorded on the task, if any; otherwise the caller cites the task itself. */
function decisionAuthority(projection) {
  const relations = Array.isArray(projection.decisionRelations) ? projection.decisionRelations : [],
    decision = relations.find(
      (relation) =>
        record(relation) &&
        relation.state === "active" &&
        typeof relation.sourceRef === "string" &&
        relation.sourceRef.startsWith("decision/") &&
        relation.relationType === "derives",
    );
  return decision ? decision.sourceRef.slice("decision/".length) : null;
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
    workspacePackagePath: projection.workspacePackagePath,
    profileId: record(task.metadata) && typeof task.metadata.profileId === "string" ? task.metadata.profileId : null,
    decisionAuthority: decisionAuthority(projection),
  };
}

function findSection(sections, aliases) {
  const matched = sections
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
  const sections = [...markdownSectionEntries(closeout)],
    chinese = chineseCloseoutSectionBodies(closeout),
    sources = Object.fromEntries(PR_SECTIONS.map(({ title, aliases }) => [title, findSection(sections, aliases)]));
  sources["What Changed"] ??= sources.Summary;
  if (profileId === LIGHTWEIGHT_PROFILE) sources["Residual Risk"] ??= LIGHTWEIGHT_RESIDUAL_RISK;
  return { sources, chinese };
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

/** The generated Chinese block is system-owned, so a re-render replaces it instead of stacking one. */
function withoutChineseSection(body) {
  const match = CHINESE_HEADING.exec(body);
  return match ? body.slice(0, match.index).replace(/\s+$/u, "") : body;
}

// Machine declarations stay in the one English declaration section; a closeout line copied into the
// Chinese block would make G31 or the Event-Migration check see a second declaration.
const MACHINE_DECLARATION = /^(?:Dependency-Change|Event-Migration):/u;

function chineseContent(content) {
  return authoredContent(content)
    .split(/\r?\n/u)
    .filter((line) => !MACHINE_DECLARATION.test(line))
    .join("\n")
    .trim();
}

/** Same closeout, second language block; no second template and no translated hand copy. */
function chineseSection(closeout, chinese) {
  // The kernel owns the judgment; the renderer only renders its verdict.
  const missing = missingChineseCloseoutSections(closeout).map((title) => `## ${title}`);
  if (missing.length > 0)
    throw new Error(
      `closeout must include ${missing.join(" and ")} so the PR body carries Chinese summary and verification; ` +
        "English prose is never published under Chinese headings",
    );
  const blocks = chineseCloseoutSections.flatMap(({ title, source }) => {
    const content = chineseContent(chinese[source] ?? "");
    return content.length > 0 ? [`## ${title}\n\n${content}`] : [];
  });
  return `# 中文\n\n${blocks.join("\n\n")}`;
}

/** Collapse generated text onto the one machine-readable line G31 parses. */
function declarationLine(content) {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^(?:[-*+]|\d+\.)[ \t]+/u, ""))
    .join(" ");
}

/** Keep exactly one declaration line, adding it when the author deleted the template sentinel. */
function setDependencyDeclaration(section, description) {
  if (readDependencyDeclarations(section).length > 0) return replaceDependencyDeclaration(section, description);
  const newline = section.includes("\r\n") ? "\r\n" : "\n";
  return `${newline}${newline}Dependency-Change: ${description}${section}`;
}

// The system owns this entire section. Manual exceptions live in a separate section that this
// renderer never writes (owner 2026-11-06); no provenance or edit detection is needed.
const GOVERNANCE_SECTION =
  /^##[ \t]+(?:Governance Declaration|Governance 声明|治理声明)[ \t]*\r?$[\s\S]*?(?=^##[ \t]+|(?![\s\S]))/gimu;

function governanceDeclaration(taskId, decision, files) {
  const lines = [
    "## Governance Declaration",
    "",
    "- Protected surface touched: yes",
    `- Protected surface scope: ${files.map(pathCode).join(", ")}`,
    `- Authority: ${decision ?? taskId}`,
  ];
  if (decision) lines.push(`- Task: ${taskId}`);
  else lines.push("- Authorization: 授权：仅 task，待评审确认");
  lines.push(
    "- Machine-check boundary: this PR only asserts the declaration exists; reviewers decide whether it is true and sufficient.",
  );
  return lines.join("\n");
}

function declareProtectedSurfaces(body, taskId, changedFiles, manifest, decision) {
  const stripped = body.replace(GOVERNANCE_SECTION, ""),
    files = manifest
      ? classifyProtectedChanges(changedFiles, deriveProtectedSurfaceRules(manifest)).map(({ file }) => file)
      : [];
  if (files.length === 0) return stripped;
  const section = `${governanceDeclaration(taskId, decision, files)}\n\n`,
    verification = /^##[ \t]+(?:Verification|验证)[ \t]*$/mu.exec(stripped);
  if (!verification) return `${stripped.replace(/\s+$/u, "")}\n\n${section}`;
  return `${stripped.slice(0, verification.index)}${section}${stripped.slice(verification.index)}`;
}

export function renderTaskPrBody({ taskId, receipt, template, body = template, closeout, manifest, rootDir }) {
  const { submission, profileId, decisionAuthority } = taskProjection(receipt, taskId),
    submissionFacts = readSubmissionFacts(submission),
    delivery = renderSubmissionFacts(submission, submissionFacts),
    authored = typeof closeout === "string" ? closeout : "",
    stripped = withoutFacts(withoutChineseSection(body)),
    baseline = withoutFacts(template),
    { sources, chinese } = authoredSources(authored, profileId),
    dependencyDescription = describeDependencyChange({
      paths: submissionFacts.changedFiles,
      rootDir,
      base: submissionFacts.productionDelta?.baseSha,
      head: submission.commitSha,
    });
  let rendered = stripped;
  if (new RegExp(`^##[ \\t]+${MACHINE_READABLE_DECLARATIONS}[ \\t]*$`, "mu").test(rendered)) {
    const { start, end } = sectionBounds(rendered, MACHINE_READABLE_DECLARATIONS);
    rendered =
      rendered.slice(0, start) +
      setDependencyDeclaration(rendered.slice(start, end), authoredContent(declarationLine(dependencyDescription))) +
      rendered.slice(end);
  }
  for (const { title } of PR_SECTIONS) {
    if (normalizedSection(stripped, title) !== normalizedSection(baseline, title)) continue;
    const content = sources[title];
    // CH2: headings are authoring conventions, not a second admission contract. When a
    // heading is absent, publish the author's original document in its original order.
    rendered = fillSection(rendered, title, content?.trim() ? content : closeout);
  }
  rendered = declareProtectedSurfaces(rendered, taskId, submissionFacts.changedFiles, manifest, decisionAuthority);
  const { start, end } = markerPair(rendered, "PR template"),
    published = `${rendered.slice(0, start + START.length)}\n${delivery}\n${rendered.slice(end)}`;
  return `${published.replace(/\s+$/u, "")}\n\n${chineseSection(authored, chinese)}\n`;
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

function readCloseout(rootDir, workspacePackagePath) {
  if (
    typeof workspacePackagePath !== "string" ||
    workspacePackagePath.length === 0 ||
    workspacePackagePath.startsWith("/") ||
    workspacePackagePath.split("/").includes("..")
  )
    throw new Error("task projection has no usable workspacePackagePath for closeout.md");
  const docPath = `${workspacePackagePath}/closeout.md`;
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
      { workspacePackagePath } = taskProjection(receipt, options.taskId),
      closeout = readCloseout(rootDir, workspacePackagePath),
      template = readFileSync(path.resolve(rootDir, ".github/pull_request_template.md"), "utf8"),
      input =
        path.resolve(rootDir, options.bodyFile) === path.resolve(rootDir, ".github/pull_request_template.md")
          ? template
          : readFileSync(path.resolve(rootDir, options.bodyFile), "utf8"),
      manifest = JSON.parse(readFileSync(path.resolve(rootDir, "tools/gate-manifest.json"), "utf8")),
      body = renderTaskPrBody({
        taskId: options.taskId,
        receipt,
        template,
        body: input,
        closeout,
        manifest,
        rootDir,
      });
    process.stdout.write(body);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
