import type { SubmissionV1 } from "./execution.ts";
import { declarations, descriptorFacets } from "./task-action-contract.ts";

/**
 * The managed-document slot a `task.*` transition must have ready before it runs. Derived from the
 * same declarations the catalog is assembled from, so readiness checks below the registry cannot
 * depend on the registry's assembled index.
 */
function taskActionReadinessDocumentSlot(transitionId: string): string | undefined {
  if (!transitionId.startsWith("task.")) return undefined;
  const declaration = declarations.find(({ id }) => `task.${id}` === transitionId);
  return declaration
    ? descriptorFacets(declaration.id).managedDocuments.find((document) => document.readinessRequired)?.slot
    : undefined;
}

type TransitionDocumentKind = "task.plan" | "decision.body" | "agent.instructions" | "squad.roster";
type TransitionDocumentPlaceholderCode =
  | "plan_placeholder"
  | "body_placeholder"
  | "instructions_placeholder"
  | "roster_placeholder";

interface TransitionDocumentBinding {
  readonly transition: string;
  readonly documentKind: TransitionDocumentKind;
}

const transitionDocumentBindings: readonly TransitionDocumentBinding[] = Object.freeze([
  { transition: "runtime.run", documentKind: "task.plan" },
  { transition: "squad.run", documentKind: "task.plan" },
  { transition: "decision.accept", documentKind: "decision.body" },
  { transition: "agent.install", documentKind: "agent.instructions" },
  { transition: "squad.install", documentKind: "squad.roster" },
]);

export interface TransitionDocumentMissingSection {
  readonly section: string;
  readonly reason: "empty" | "scaffold";
  readonly retainedScaffold?: string;
}

interface TransitionDocumentReadiness {
  readonly ready: boolean;
  readonly code: TransitionDocumentPlaceholderCode;
  readonly missingSections: readonly TransitionDocumentMissingSection[];
}

export type MarkdownDocumentContract = {
  readonly requiredSections: readonly string[];
  readonly scaffoldBySection: Readonly<Record<string, readonly string[]>>;
};

/**
 * Derives a document's readiness contract from the scaffold it was materialized from: every `## `
 * heading is a required section, and each non-empty scaffold line inside a section is a scaffold
 * phrase. The template is the single source — the kernel keeps no section list of its own.
 */
export function transitionDocumentContract(scaffoldBody: string): MarkdownDocumentContract {
  const requiredSections: string[] = [],
    scaffoldBySection: Record<string, readonly string[]> = {};
  let heading: string | null = null,
    phrases: string[] = [],
    fence: { marker: string; length: number } | null = null;
  const retain = () => {
    if (heading === null) return;
    requiredSections.push(heading);
    scaffoldBySection[heading] = Object.freeze(phrases);
  };
  for (const line of scaffoldBody.split(/\r?\n/u)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (delimiter) {
      if (fence === null) {
        fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
      } else if (delimiter[1]![0] === fence.marker && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    const match = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line);
    if (match) {
      retain();
      heading = match[1]!;
      phrases = [];
      continue;
    }
    if (heading !== null && line.trim()) phrases.push(line.trim());
  }
  retain();
  return Object.freeze({ requiredSections: Object.freeze(requiredSections), scaffoldBySection });
}

const placeholderCodes: Readonly<Record<TransitionDocumentKind, TransitionDocumentPlaceholderCode>> = {
  "task.plan": "plan_placeholder",
  "decision.body": "body_placeholder",
  "agent.instructions": "instructions_placeholder",
  "squad.roster": "roster_placeholder",
};

// These sections carry repository-wide operating rules. Keeping their scaffold prose is valid;
// task-specific sections still require authored content and retain the placeholder rejection.
const standingTaskPlanSections = new Set(["execution surface", "implementation plan", "verification"]);

const declarationScaffolds: Readonly<Record<"agent.instructions" | "squad.roster", readonly string[]>> = {
  "agent.instructions": [
    "(To be written: this text becomes the agent's system prompt verbatim.)",
    "（待补写:这段文字会原样成为该 Agent 的系统指令。）",
  ],
  "squad.roster": ["## Squad roster\n(to be written)", "## Squad Roster\n（待补写）"],
};

export function assessTransitionDocument(
  kind: TransitionDocumentKind,
  body: string,
  contract?: MarkdownDocumentContract,
): TransitionDocumentReadiness {
  const missingSections =
    kind === "task.plan"
      ? missingMarkdownSections(body, requireDocumentContract(kind, contract), kind)
      : kind === "decision.body"
        ? decisionBodyMissingSections(body)
        : declarationMissingSection(kind, body);
  return Object.freeze({
    ready: missingSections.length === 0,
    code: placeholderCodes[kind],
    missingSections: Object.freeze(missingSections),
  });
}

function requireDocumentContract(
  kind: TransitionDocumentKind,
  contract: MarkdownDocumentContract | undefined,
): MarkdownDocumentContract {
  if (contract === undefined)
    throw transitionDocumentAccessLikeError(
      "scaffold_unavailable",
      `${kind} readiness requires the document's materialized scaffold.`,
    );
  return contract;
}

function transitionDocumentAccessLikeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function requireTransitionDocumentKind(transition: string): TransitionDocumentKind {
  const readinessSlot = taskActionReadinessDocumentSlot(transition);
  if (readinessSlot) return readinessSlot as TransitionDocumentKind;
  const binding = transitionDocumentBindings.find((candidate) => candidate.transition === transition);
  if (!binding) throw new Error(`Transition ${transition} has no canonical document binding.`);
  return binding.documentKind;
}

export function assertTransitionDocumentReady(
  kind: TransitionDocumentKind,
  body: string,
  contract?: MarkdownDocumentContract,
): void {
  const assessment = assessTransitionDocument(kind, body, contract);
  if (assessment.ready) return;
  const sections = assessment.missingSections.map(({ section }) => section).join(", "),
    error = new Error(
      `${assessment.code}: ${kind} has empty or scaffold-equivalent required content: ${sections}.` +
        (kind === "decision.body" ? " Provide Decision prose with --body or --body-file." : ""),
    ) as Error & {
      code: TransitionDocumentPlaceholderCode;
      missingSections: readonly TransitionDocumentMissingSection[];
    };
  error.code = assessment.code;
  error.missingSections = assessment.missingSections;
  throw error;
}

/**
 * Preserve authored evidence verbatim; the execution cut supplies every repository-derived field.
 * The closeout prose is read, never judged: section headings are conventions the scaffold suggests,
 * and any authored body without a `## Summary` answers with its own prose. Only the Submission
 * schema decides whether a cut carries a claim (dec_E369B8616F50A6208B293997E7 CH2).
 */
export function submissionFromCloseout(
  body: string,
  cut: import("./execution.ts").SubmissionDelivery &
    Pick<SubmissionV1, "deliverables" | "outputs" | "completionContract">,
): SubmissionV1 {
  // The four scaffold headings are read as prefixes, so an authored suffix ("## Summary (what
  // shipped)") still files its prose under that section without the heading having to match exactly.
  const sections = markdownSections(body, closeoutSectionPrefixes),
    // The risk sections ride along when the author kept them; both feed known and residual risks.
    risks = [sections.get("residual risk"), sections.get("same mechanism elsewhere")].filter(
      (section): section is string => section !== undefined,
    ),
    verification = sections.get("verification");
  return {
    completionClaim: sections.get("summary") ?? authorProse(body),
    verificationNotes: verification === undefined ? [] : [verification],
    knownGaps: risks,
    residualRisks: risks,
    ...cut,
  };
}

const closeoutSectionPrefixes = Object.freeze(["summary", "verification", "residual risk", "same mechanism elsewhere"]);

function missingMarkdownSections(
  body: string,
  contract: MarkdownDocumentContract,
  kind: TransitionDocumentKind,
): TransitionDocumentMissingSection[] {
  const sections = markdownSections(body, kind === "task.plan" ? contract.requiredSections : []),
    untouchedScaffold = contract.requiredSections.every((heading) => {
      const content = sections.get(normalizeHeading(heading));
      return (
        !!content?.trim() &&
        (contract.scaffoldBySection[heading] ?? []).some((scaffold) =>
          normalizeText(content).includes(normalizeText(scaffold)),
        )
      );
    });
  return contract.requiredSections.flatMap((heading): readonly TransitionDocumentMissingSection[] => {
    const content = sections.get(normalizeHeading(heading));
    if (!content?.trim()) return [{ section: heading, reason: "empty" }];
    const scaffolds = contract.scaffoldBySection[heading] ?? [],
      normalized = normalizeText(content),
      retained = scaffolds.filter((scaffold) => normalized.includes(normalizeText(scaffold)));
    if (retained.length === 0) return [];
    if (
      kind === "task.plan" &&
      contract.requiredSections.includes("Execution Surface") &&
      standingTaskPlanSections.has(normalizeHeading(heading)) &&
      !untouchedScaffold
    )
      return [];
    const issue = (): TransitionDocumentMissingSection => ({
      section: heading,
      reason: "scaffold",
      retainedScaffold: clipScaffold(retained[0]!),
    });
    if (untouchedScaffold) return [issue()];
    const remainder = retained.reduce((value, scaffold) => value.replaceAll(normalizeText(scaffold), " "), normalized);
    return /[\p{L}\p{N}]/u.test(remainder) ? [] : [issue()];
  });
}

function decisionBodyMissingSections(body: string): readonly TransitionDocumentMissingSection[] {
  const scaffolds = [
      ["背景", "说明需要裁定的问题与已知事实。"],
      ["权衡", "说明所选方案、被拒方案与取舍理由。"],
      ["结论", "说明最终裁定及其适用范围。"],
    ] as const,
    normalized = normalizeText(stripFrontmatter(body));
  if (scaffolds.every(([heading, prompt]) => normalized.includes(normalizeText(`## ${heading} ${prompt}`))))
    return scaffolds.map(([section, retainedScaffold]) => ({
      section,
      reason: "scaffold" as const,
      retainedScaffold,
    }));
  return meaningfulMarkdown(body) ? [] : [{ section: "body", reason: "empty" }];
}

/** The authored body as the claim of last resort: frontmatter, heading marks and HTML comments removed. */
function authorProse(body: string): string {
  return stripFrontmatter(body)
    .replace(/^#{1,6}[ \t]+.*$/gmu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .trim();
}

function meaningfulMarkdown(body: string): boolean {
  const prose = stripFrontmatter(body)
    .replace(/^#{1,6}[ \t]+.*$/gmu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .trim();
  return prose.length > 0;
}

/** Shared section reader: fenced examples are content, and repeated sections retain every occurrence. */
export function markdownSections(body: string, headingPrefixes: readonly string[] = []): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  const prefixes = headingPrefixes.map(normalizeHeading);
  let heading: string | null = null;
  let content: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  const retain = () => {
    if (heading === null) return;
    const previous = sections.get(heading);
    sections.set(heading, [previous, content.join("\n").trim()].filter((value) => value !== undefined).join("\n\n"));
  };
  for (const line of body.split(/\r?\n/u)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence === null && delimiter) {
      fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
    } else if (fence !== null) {
      if (
        delimiter &&
        delimiter[1]![0] === fence.marker &&
        delimiter[1]!.length >= fence.length &&
        !delimiter[2]!.trim()
      )
        fence = null;
      content.push(line);
      continue;
    }
    const match = fence === null ? /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line) : null;
    if (match) {
      retain();
      heading = normalizeHeading(match[1]!);
      const authoredHeading = heading;
      heading =
        prefixes.find(
          (prefix) => authoredHeading.startsWith(prefix) && /^[ \t]*[(—–-]/u.test(authoredHeading.slice(prefix.length)),
        ) ?? heading;
      content = [];
    } else content.push(line);
  }
  retain();
  return sections;
}

function declarationTextReady(kind: "agent.instructions" | "squad.roster", body: string): boolean {
  const normalized = normalizeText(body);
  return normalized.length > 0 && !declarationScaffolds[kind].some((value) => normalized === normalizeText(value));
}

function declarationMissingSection(
  kind: "agent.instructions" | "squad.roster",
  body: string,
): readonly TransitionDocumentMissingSection[] {
  if (declarationTextReady(kind, body)) return [];
  const section = kind === "agent.instructions" ? "instructions" : "roster",
    normalized = normalizeText(body),
    retained = declarationScaffolds[kind].find((value) => normalized === normalizeText(value));
  return retained
    ? [{ section, reason: "scaffold", retainedScaffold: clipScaffold(retained) }]
    : [{ section, reason: "empty" }];
}

function clipScaffold(value: string): string {
  return [...value].slice(0, 60).join("");
}

function stripFrontmatter(body: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(body);
  return match ? body.slice(match[0].length) : body;
}

function normalizeHeading(value: string): string {
  return normalizeText(value).toLocaleLowerCase();
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}
