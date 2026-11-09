/**
 * The one PR-body composition for a frozen task cut.
 *
 * `tools/gates/render-task-pr-body.mjs` is the CLI adapter that supplies the live template,
 * the task closeout and the frozen submission; the daemon publication port calls this same module
 * so `ha task push`, the submit refresh and terminal settlement publish the same body. There is
 * no second template and no second governance declaration writer.
 */
import { readDependencyDeclarations, replaceDependencyDeclaration } from "./dependency-declaration.ts";
import type { CoverageRelation } from "./decision-coverage.ts";
import type { SubmissionV1 } from "./execution.ts";
import { classifyProtectedChanges, type ProtectedSurfaceRule } from "./protected-surface-governance.ts";
import {
  readSubmissionFacts,
  renderSubmissionFacts,
  SUBMISSION_FACTS_END,
  SUBMISSION_FACTS_START,
} from "./submission-facts.ts";
import {
  chineseCloseoutSectionBodies,
  chineseCloseoutSections,
  markdownSectionEntries,
  missingChineseCloseoutSections,
} from "./transition-document-readiness.ts";

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

const CHINESE_HEADING = /^#\s+中文\s*$/mu;

const MACHINE_READABLE_DECLARATIONS = "Machine-Readable Declarations";

const LIGHTWEIGHT_PROFILE = "lightweight",
  LIGHTWEIGHT_RESIDUAL_RISK = "Accepted residual risks are recorded in the Verification section.";

function pathCode(value: string): string {
  const encoded = JSON.stringify(value),
    longestTickRun = Math.max(0, ...(encoded.match(/`+/gu) ?? []).map((run) => run.length)),
    delimiter = "`".repeat(longestTickRun + 1);
  return `${delimiter}${encoded}${delimiter}`;
}

/** The governing decision recorded on the task, if any; otherwise the caller cites the task itself. */
export function governanceDecisionAuthority(relations: readonly CoverageRelation[] | undefined): string | null {
  const decision = (relations ?? []).find(
    (relation) =>
      relation.state === "active" &&
      typeof relation.sourceRef === "string" &&
      relation.sourceRef.startsWith("decision/") &&
      relation.relationType === "derives",
  );
  return decision ? decision.sourceRef.slice("decision/".length) : null;
}

function findSection(sections: readonly (readonly [string, string])[], aliases: readonly string[]): string | undefined {
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

function authoredSources(
  closeout: string,
  profileId: string | null,
): {
  readonly sources: Record<string, string | undefined>;
  readonly chinese: Readonly<Record<string, string | undefined>>;
} {
  const sections = [...markdownSectionEntries(closeout)],
    chinese = chineseCloseoutSectionBodies(closeout),
    sources: Record<string, string | undefined> = Object.fromEntries(
      PR_SECTIONS.map(({ title, aliases }) => [title, findSection(sections, aliases)]),
    );
  sources["What Changed"] ??= sources.Summary;
  if (profileId === LIGHTWEIGHT_PROFILE) sources["Residual Risk"] ??= LIGHTWEIGHT_RESIDUAL_RISK;
  return { sources, chinese };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function markerPair(body: string, label: string): { readonly start: number; readonly end: number } {
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
function withoutFacts(body: string): string {
  const { start, end } = markerPair(body, "PR template");
  return body.slice(0, start + START.length) + body.slice(end);
}

function sectionBounds(body: string, title: string): { readonly start: number; readonly end: number } {
  const match = new RegExp(`^##[ \\t]+${escapeRegExp(title)}[ \\t]*$`, "mu").exec(body);
  if (!match) throw new Error(`PR template is missing the ## ${title} section`);
  const start = match.index + match[0].length,
    next = /^##[ \t]+/mu.exec(body.slice(start));
  return { start, end: next ? start + next.index : body.length };
}

function normalizedSection(body: string, title: string): string {
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
function authoredContent(content: string): string {
  return content
    .replace(/^##(?=[ \t])/gmu, "###")
    .replaceAll(START, "&lt;!-- harness:submission-facts:start --&gt;")
    .replaceAll(END, "&lt;!-- harness:submission-facts:end --&gt;");
}

function fillSection(body: string, title: string, content: string): string {
  const { start, end } = sectionBounds(body, title),
    section = body.slice(start, end),
    keptMarkers = section.includes(START) && section.includes(END) ? `\n\n${START}\n${END}` : "";
  return `${body.slice(0, start)}\n\n${authoredContent(content).trim()}${keptMarkers}\n\n${body.slice(end)}`;
}

/** The generated Chinese block is system-owned, so a re-render replaces it instead of stacking one. */
function withoutChineseSection(body: string): string {
  const match = CHINESE_HEADING.exec(body);
  return match ? body.slice(0, match.index).replace(/\s+$/u, "") : body;
}

// Machine declarations stay in the one English declaration section; a closeout line copied into the
// Chinese block would make G31 or the Event-Migration check see a second declaration.
const MACHINE_DECLARATION = /^(?:Dependency-Change|Event-Migration):/u;

function chineseContent(content: string): string {
  return authoredContent(content)
    .split(/\r?\n/u)
    .filter((line) => !MACHINE_DECLARATION.test(line))
    .join("\n")
    .trim();
}

/** Same closeout, second language block; no second template and no translated hand copy. */
function chineseSection(closeout: string, chinese: Readonly<Record<string, string | undefined>>): string {
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
function declarationLine(content: string): string {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^(?:[-*+]|\d+\.)[ \t]+/u, ""))
    .join(" ");
}

/** Keep exactly one declaration line, adding it when the author deleted the template sentinel. */
function setDependencyDeclaration(section: string, description: string): string {
  if (readDependencyDeclarations(section).length > 0) return replaceDependencyDeclaration(section, description);
  const newline = section.includes("\r\n") ? "\r\n" : "\n";
  return `${newline}${newline}Dependency-Change: ${description}${section}`;
}

// The system owns this entire section. Manual exceptions live in a separate section that this
// renderer never writes (owner 2026-11-06); no provenance or edit detection is needed.
const GOVERNANCE_SECTION =
  /^##[ \t]+(?:Governance Declaration|Governance 声明|治理声明)[ \t]*\r?$[\s\S]*?(?=^##[ \t]+|(?![\s\S]))/gimu;

function governanceDeclaration(taskId: string, decision: string | null, files: readonly string[]): string {
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

function declareProtectedSurfaces(
  body: string,
  taskId: string,
  changedFiles: readonly string[],
  rules: readonly ProtectedSurfaceRule[],
  decision: string | null,
): string {
  const stripped = body.replace(GOVERNANCE_SECTION, ""),
    files = classifyProtectedChanges(changedFiles, rules).map(({ file }) => file);
  if (files.length === 0) return stripped;
  const section = `${governanceDeclaration(taskId, decision, files)}\n\n`,
    verification = /^##[ \t]+(?:Verification|验证)[ \t]*$/mu.exec(stripped);
  if (!verification) return `${stripped.replace(/\s+$/u, "")}\n\n${section}`;
  return `${stripped.slice(0, verification.index)}${section}${stripped.slice(verification.index)}`;
}

type TaskPrBodyRenderInput = {
  readonly taskId: string;
  readonly submission: SubmissionV1;
  readonly profileId: string | null;
  /** The governing decision id, when the task has an active `derives` relation. */
  readonly decisionAuthority: string | null;
  readonly template: string;
  readonly body?: string | undefined;
  readonly closeout: string;
  /** Manifest-derived rules; empty means this repository publishes no protected surfaces. */
  readonly protectedSurfaceRules?: readonly ProtectedSurfaceRule[] | undefined;
  /** The `Dependency-Change:` value for this cut; defaults to the template's `none` sentinel. */
  readonly dependencyDescription?: string | undefined;
};

export function renderTaskPrBody(input: TaskPrBodyRenderInput): string {
  const template = input.template,
    body = input.body ?? template,
    submissionFacts = readSubmissionFacts(input.submission),
    delivery = renderSubmissionFacts(input.submission, submissionFacts),
    authored = typeof input.closeout === "string" ? input.closeout : "",
    stripped = withoutFacts(withoutChineseSection(body)),
    baseline = withoutFacts(template),
    { sources, chinese } = authoredSources(authored, input.profileId),
    dependencyDescription = input.dependencyDescription ?? "none";
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
    rendered = fillSection(rendered, title, content?.trim() ? content : authored);
  }
  rendered = declareProtectedSurfaces(
    rendered,
    input.taskId,
    submissionFacts.changedFiles,
    input.protectedSurfaceRules ?? [],
    input.decisionAuthority,
  );
  const { start, end } = markerPair(rendered, "PR template"),
    published = `${rendered.slice(0, start + START.length)}\n${delivery}\n${rendered.slice(end)}`;
  return `${published.replace(/\s+$/u, "")}\n\n${chineseSection(authored, chinese)}\n`;
}
