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

export type TransitionDocumentKind = "task.plan" | "decision.body" | "agent.instructions" | "squad.roster";
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
 *
 * `requiredAnchors` narrows that set to the sections a catalog declared for this document (for
 * example, a section only fix tasks must fill). The anchors stay data: this function never knows
 * which work kind it is serving.
 */
export function transitionDocumentContract(
  scaffoldBody: string,
  requiredAnchors?: readonly string[],
): MarkdownDocumentContract {
  const derived = transitionDocumentSections(scaffoldBody);
  return requiredAnchors === undefined ? derived : narrowTransitionDocumentContract(derived, requiredAnchors);
}

function transitionDocumentSections(scaffoldBody: string): MarkdownDocumentContract {
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

/** Keep only the declared sections, in declaration order, and fail closed on an undeclared anchor. */
function narrowTransitionDocumentContract(
  contract: MarkdownDocumentContract,
  requiredAnchors: readonly string[],
): MarkdownDocumentContract {
  const headingBySection = new Map(contract.requiredSections.map((heading) => [normalizeHeading(heading), heading])),
    requiredSections = requiredAnchors.map((anchor) => {
      const declared = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(anchor)?.[1] ?? anchor,
        heading = headingBySection.get(normalizeHeading(declared));
      if (heading === undefined)
        throw transitionDocumentAccessLikeError(
          "scaffold_unavailable",
          `Required anchor ${anchor} is not a section of the materialized scaffold.`,
        );
      return heading;
    });
  return Object.freeze({
    requiredSections: Object.freeze(requiredSections),
    scaffoldBySection: Object.freeze(
      Object.fromEntries(requiredSections.map((heading) => [heading, contract.scaffoldBySection[heading] ?? []])),
    ),
  });
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
  const missingSections = transitionDocumentMissingSections(kind, body, contract);
  if (missingSections === null)
    throw transitionDocumentAccessLikeError(
      "scaffold_unavailable",
      `${kind} readiness requires the document's materialized scaffold.`,
    );
  return Object.freeze({
    ready: missingSections.length === 0,
    code: placeholderCodes[kind],
    missingSections: Object.freeze(missingSections),
  });
}

/** Content readiness of an authored document (dec_6B912A63D279A922FA1288536D CH1). */
export const authoredDocumentReadinessStates = ["missing", "contract_unavailable", "not_ready", "ready"] as const;
export type AuthoredDocumentReadinessState = (typeof authoredDocumentReadinessStates)[number];

export interface AuthoredDocumentReadiness {
  readonly state: AuthoredDocumentReadinessState;
  readonly missingSections: readonly TransitionDocumentMissingSection[];
}

/**
 * The one content-readiness judgment for an authored document. `body: null` is a document with no
 * canonical content; a kind whose readiness is defined by its materialized scaffold answers
 * `contract_unavailable` instead of guessing when that contract is absent. The section verdict is
 * the same one every transition gate reads through `assessTransitionDocument`.
 */
export function assessAuthoredDocumentReadiness(
  kind: TransitionDocumentKind,
  body: string | null,
  contract?: MarkdownDocumentContract,
): AuthoredDocumentReadiness {
  if (body === null) return Object.freeze({ state: "missing", missingSections: Object.freeze([]) });
  const missingSections = transitionDocumentMissingSections(kind, body, contract);
  if (missingSections === null)
    return Object.freeze({ state: "contract_unavailable", missingSections: Object.freeze([]) });
  return Object.freeze({
    state: missingSections.length === 0 ? "ready" : "not_ready",
    missingSections: Object.freeze(missingSections),
  });
}

/** Missing sections per kind; `null` when the kind's readiness needs a scaffold contract that is absent. */
function transitionDocumentMissingSections(
  kind: TransitionDocumentKind,
  body: string,
  contract: MarkdownDocumentContract | undefined,
): readonly TransitionDocumentMissingSection[] | null {
  if (kind === "task.plan") return contract === undefined ? null : missingMarkdownSections(body, contract, kind);
  return kind === "decision.body" ? decisionBodyMissingSections(body) : declarationMissingSection(kind, body);
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

/** The Chinese mirror of each authored closeout section the public PR body publishes. */
interface ChineseCloseoutSection {
  readonly title: string;
  readonly aliases: readonly string[];
  readonly source: "Summary" | "What Changed" | "Verification" | "Residual Risk";
  /** 摘要 and 验证 gate bilingual delivery; the other two ride along when the author kept them. */
  readonly required: boolean;
}

/**
 * The bilingual closeout contract is one datum, not a renderer convention: the PR body generator
 * and `ha task submit` both read this table through `missingChineseCloseoutSections`, so a cut that
 * cannot publish Chinese prose is refused before publication instead of at PR time.
 */
export const chineseCloseoutSections: readonly ChineseCloseoutSection[] = Object.freeze([
  Object.freeze({ title: "摘要", aliases: Object.freeze(["摘要", "概要"]), source: "Summary", required: true }),
  Object.freeze({
    title: "改动内容",
    aliases: Object.freeze(["改动内容", "改动"]),
    source: "What Changed",
    required: false,
  }),
  Object.freeze({
    title: "验证",
    aliases: Object.freeze(["验证", "验证记录", "验证结果"]),
    source: "Verification",
    required: true,
  }),
  Object.freeze({
    title: "残余风险",
    aliases: Object.freeze(["残余风险", "剩余风险"]),
    source: "Residual Risk",
    required: false,
  }),
]);

/** The authored Chinese closeout text per English section it mirrors; absent means unauthored. */
export function chineseCloseoutSectionBodies(closeout: string): Readonly<Record<string, string | undefined>> {
  const entries = [...markdownSectionEntries(closeout)];
  return Object.fromEntries(
    chineseCloseoutSections.map(({ aliases, source }) => [source, authoredSection(entries, aliases)]),
  );
}

/** The one bilingual-delivery judgment: which required Chinese closeout sections carry no authored text. */
export function missingChineseCloseoutSections(closeout: string): readonly string[] {
  const bodies = chineseCloseoutSectionBodies(closeout);
  return chineseCloseoutSections
    .filter(({ required, source }) => required && !bodies[source]?.trim())
    .map(({ title }) => title);
}

function authoredSection(
  entries: readonly (readonly [string, string])[],
  aliases: readonly string[],
): string | undefined {
  const matched = entries
    .filter(([heading]) =>
      aliases.some(
        (alias) =>
          heading === alias || (heading.startsWith(alias) && /^[ \t(（—–\-:：]/u.test(heading.slice(alias.length))),
      ),
    )
    .map(([, content]) => content);
  return matched.length > 0 ? matched.join("\n\n") : undefined;
}

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
  for (const [authoredHeading, content] of markdownSectionEntries(body)) {
    const heading =
      prefixes.find(
        (prefix) => authoredHeading.startsWith(prefix) && /^[ \t]*[(—–-]/u.test(authoredHeading.slice(prefix.length)),
      ) ?? authoredHeading;
    const previous = sections.get(heading);
    sections.set(heading, [previous, content].filter((value) => value !== undefined).join("\n\n"));
  }
  return sections;
}

/** Read each authored occurrence in source order, before any grouping by heading. */
export function* markdownSectionEntries(body: string): Generator<readonly [string, string]> {
  let heading: string | null = null;
  let content: string[] = [];
  let fence: { marker: string; length: number } | null = null;
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
      if (heading !== null) yield [heading, content.join("\n").trim()];
      heading = normalizeHeading(match[1]!);
      content = [];
    } else content.push(line);
  }
  if (heading !== null) yield [heading, content.join("\n").trim()];
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
