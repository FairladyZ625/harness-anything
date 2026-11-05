#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  classifyProtectedChanges,
  deriveProtectedSurfaceRules,
  governanceDeclarationCites,
  governanceSections,
} from "../check-pr-governance.mjs";
import {
  SUBMISSION_FACTS_END,
  SUBMISSION_FACTS_START,
  readSubmissionFacts,
  renderSubmissionFacts,
} from "../../packages/kernel/src/domain/submission-facts.ts";
import { markdownSectionEntries } from "../../packages/kernel/src/domain/transition-document-readiness.ts";
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

// The closeout is the single authoring place; a governance declaration written there is the
// author's authorization and the renderer publishes it verbatim when the cut is protected.
const GOVERNANCE_DECLARATION = Object.freeze({
  title: "Governance Declaration",
  aliases: Object.freeze(["governance declaration", "governance 声明", "治理声明"]),
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

/** The governing decision recorded on the task, if any. Task identity alone is not authorization. */
function decisionAuthority(projection) {
  const relations = Array.isArray(projection.decisionRelations) ? projection.decisionRelations : [],
    decision = relations.find(
      (relation) =>
        record(relation) &&
        relation.state === "active" &&
        typeof relation.sourceRef === "string" &&
        relation.sourceRef.startsWith("decision/") &&
        (relation.relationType === "derives" || relation.relationType === "narrows"),
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
    packagePath: projection.packagePath,
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
    sources = Object.fromEntries(PR_SECTIONS.map(({ title, aliases }) => [title, findSection(sections, aliases)]));
  sources[DEPENDENCY_CHANGE.title] = findSection(sections, DEPENDENCY_CHANGE.aliases);
  sources["Governance Declaration"] = findSection(sections, GOVERNANCE_DECLARATION.aliases);
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

// The governance gate classifies protected paths from the gate manifest and requires the published
// body to cite an authorizing ADR/decision/task. The declaration is generated only from ledger
// authorization: a governing decision, else the task's own machine-read Execution Surface, else the
// closeout's governance section. A generated section records a digest of its content; only an
// untouched section is refreshed, so any edit (including a changed Authority or scope value) is
// preserved verbatim and left to the lint.
const GENERATED_GOVERNANCE = "harness:generated-governance",
  GENERATED_MARKER = /<!--[ \t]*harness:generated-governance[ \t]+sha256:([0-9a-f]{64})[ \t]*-->/u,
  GENERATED_FIXED_LINES = Object.freeze([
    "- Protected surface touched: yes",
    "- Machine-check boundary: this PR only asserts the declaration exists; reviewers decide whether it is true and sufficient.",
    "- Break-glass: no",
  ]);

function contentDigest(lines) {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function governanceDeclaration(authorization, files) {
  const content = [
    "- Protected surface touched: yes",
    `- Protected surface scope: ${files.map(pathCode).join(", ")}`,
    `- Authority: ${authorization.id}`,
  ];
  if (authorization.surface)
    content.push(`- Authorized surface: ${authoredContent(authorization.surface.replace(/\s+/gu, " ").trim())}`);
  content.push(GENERATED_FIXED_LINES[1], GENERATED_FIXED_LINES[2]);
  const marker = `<!-- ${GENERATED_GOVERNANCE} sha256:${contentDigest(content)} -->`;
  return ["## Governance Declaration", "", marker, ...content].join("\n");
}

function contentLines(sectionText) {
  return sectionText
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^##[ \t]/u.test(line));
}

/** The template's own governance fields; a section made only of them is still an unfilled default. */
function templateGovernanceLines(template) {
  const section = governanceSections(template).find(({ text }) => text.includes("Protected surface touched"));
  return new Set(section ? contentLines(section.text) : []);
}

function isTemplateDefault(sectionText, defaults) {
  const lines = contentLines(sectionText);
  return lines.length > 0 && defaults.size > 0 && lines.every((line) => defaults.has(line));
}

/** Only a generated section whose bytes still match its marker digest is machine-owned. */
function isPristineGenerated(sectionText) {
  const marker = GENERATED_MARKER.exec(sectionText);
  return Boolean(marker) && contentDigest(contentLines(sectionText)) === marker[1];
}

function removeSections(body, sections) {
  return [...sections]
    .sort((left, right) => right.start - left.start)
    .reduce((next, { start, end }) => `${next.slice(0, start)}${next.slice(end)}`, body);
}

function insertGovernanceDeclaration(body, declaration) {
  const match = /^##[ \t]+(?:Verification|验证)[ \t]*$/mu.exec(body);
  if (!match) return `${body.replace(/\s+$/u, "")}\n\n${declaration}\n`;
  return `${body.slice(0, match.index)}${declaration}\n\n${body.slice(match.index)}`;
}

function declareProtectedSurfaces({
  body,
  taskId,
  changedFiles,
  manifest,
  template,
  authorization,
  closeoutDeclaration,
}) {
  if (!manifest) return body;
  const files = classifyProtectedChanges(changedFiles, deriveProtectedSurfaceRules(manifest)).map(({ file }) => file),
    pristine = governanceSections(body).filter(({ text }) => isPristineGenerated(text)),
    cleaned = removeSections(body, pristine);
  if (files.length === 0) return cleaned;
  const defaults = templateGovernanceLines(template),
    remaining = governanceSections(cleaned);
  // An authored or user-edited section that already cites an authority is the author's evidence;
  // preserve it even without a ledger source for generation (a standalone task can be authorized
  // by its closeout/body alone).
  if (remaining.some(({ text }) => governanceDeclarationCites(text))) return cleaned;
  // A non-default, uncited section is an incomplete author declaration: keep it and let the lint
  // report the missing evidence instead of erasing it.
  if (remaining.some(({ text }) => !isTemplateDefault(text, defaults))) return cleaned;
  // The closeout is the single authoring place; publish its governance declaration verbatim when
  // it already cites an authority, instead of requiring the author to copy it into the body.
  const authored =
    typeof closeoutDeclaration === "string" && closeoutDeclaration.trim().length > 0
      ? `## Governance Declaration\n\n${authoredContent(closeoutDeclaration.trim())}`
      : null;
  if (authored && governanceDeclarationCites(authored))
    return insertGovernanceDeclaration(removeSections(cleaned, remaining), authored);
  if (!authorization)
    throw new Error(
      `Protected surface(s) touched (${files.join(", ")}) but task ${taskId} records no authorizing decision, Execution Surface, or closeout declaration; ` +
        "the renderer will not mint an authority claim. Add the authorization to the task plan or closeout before publishing.",
    );
  return insertGovernanceDeclaration(removeSections(cleaned, remaining), governanceDeclaration(authorization, files));
}

export function renderTaskPrBody({
  taskId,
  receipt,
  template,
  body = template,
  closeout,
  manifest,
  authorizedSurface,
}) {
  const { submission, profileId, decisionAuthority } = taskProjection(receipt, taskId),
    authorization = decisionAuthority
      ? { id: decisionAuthority, surface: null }
      : typeof authorizedSurface === "string" && authorizedSurface.trim().length > 0
        ? { id: taskId, surface: authorizedSurface }
        : null,
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
  rendered = declareProtectedSurfaces({
    body: rendered,
    taskId,
    changedFiles: submissionFacts.changedFiles,
    manifest,
    template,
    authorization,
    closeoutDeclaration: sources[GOVERNANCE_DECLARATION.title],
  });
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

/**
 * The task's own authorized write scope, read from the plan the ledger issued for this task. A
 * missing or unreadable plan yields no surface, so generation fails closed instead of citing
 * ancestry as authorization.
 */
function readAuthorizedSurface(rootDir, packagePath) {
  if (
    typeof packagePath !== "string" ||
    packagePath.length === 0 ||
    packagePath.startsWith("/") ||
    packagePath.split("/").includes("..")
  )
    return "";
  const docPath = `${packagePath}/task_plan.md`;
  try {
    const plan = execFileSync("ha", ["doc", "show", "--path", docPath, "--raw"], {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return findSection([...markdownSectionEntries(plan)], ["execution surface", "执行面", "执行范围"])?.trim() ?? "";
  } catch {
    return "";
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
      authorizedSurface = readAuthorizedSurface(rootDir, packagePath),
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
        authorizedSurface,
      });
    process.stdout.write(body);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
