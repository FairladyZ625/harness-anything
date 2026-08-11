export type ReviewSeverity = "P0" | "P1" | "P2" | "P3";

export interface ReviewFinding {
  readonly id: string;
  readonly severity: ReviewSeverity;
  readonly finding: string;
  readonly open: boolean;
  readonly blocksRelease: boolean;
}

export interface ReviewGateIssue {
  readonly code: "invalid_review_table" | "release_blocking_finding";
  readonly findingId?: string;
  readonly message: string;
}

export interface ParsedReviewMarkdown {
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly issues: ReadonlyArray<ReviewGateIssue>;
}

export interface DecisionReckonGateInput {
  readonly decisionId: string;
  readonly claims: ReadonlyArray<{ readonly id: string; readonly text: string; readonly load_bearing?: boolean }>;
  readonly coverageRows: ReadonlyArray<{
    readonly decisionRef: string;
    readonly claimRef: string;
    readonly status: "covered" | "uncovered";
    readonly coveringFactRef?: string;
    readonly relationPath: ReadonlyArray<string>;
  }>;
  readonly reckonedAt: string;
}

export type DecisionReckonGateResult = {
  readonly ok: boolean;
  readonly status: "passed" | "failed";
  readonly decisionRef: string;
  readonly reckonedAt: string;
  readonly loadBearingClaimRefs: ReadonlyArray<string>;
  readonly uncoveredClaimRefs: ReadonlyArray<string>;
  readonly coveredClaimRefs: ReadonlyArray<string>;
};

export interface TaskDocumentPlaceholderSectionFingerprint {
  readonly anchor: string;
  readonly body: string;
}

export interface TaskDocumentPlaceholderPolicy {
  readonly closeoutPlaceholderFingerprints: ReadonlyArray<string>;
  readonly taskPlanPlaceholderFingerprintSets: ReadonlyArray<ReadonlyArray<TaskDocumentPlaceholderSectionFingerprint>>;
  readonly visualMapPlaceholderFingerprintSets: ReadonlyArray<ReadonlyArray<TaskDocumentPlaceholderSectionFingerprint>>;
  readonly lessonCandidatesPlaceholderFingerprintSets: ReadonlyArray<ReadonlyArray<TaskDocumentPlaceholderSectionFingerprint>>;
}

export function parseReviewMarkdown(markdown: string): ParsedReviewMarkdown {
  const findings: ReviewFinding[] = [];
  const issues: ReviewGateIssue[] = [];
  const lines = markdown.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => splitMarkdownRow(line).map((cell) => cell.toLowerCase()).join("|") === "id|severity|finding|evidence checked|required action|open|disposition|blocks release|follow-up");
  if (headerIndex < 0) return { findings, issues };
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith("|")) break;
    const cells = splitMarkdownRow(line);
    if (cells.length < 9) {
      issues.push({ code: "invalid_review_table", message: `Review finding row has ${cells.length} cells, expected 9.` });
      continue;
    }
    const severity = cells[1];
    const open = parseYesNo(cells[5]);
    const blocksRelease = parseYesNo(cells[7]);
    if (!isReviewSeverity(severity) || open === null || blocksRelease === null) {
      issues.push({ code: "invalid_review_table", findingId: cells[0], message: "Review row has invalid severity, Open, or Blocks Release." });
      continue;
    }
    findings.push({ id: cells[0], severity, finding: cells[2], open, blocksRelease });
  }
  return { findings, issues };
}

export function isReviewPlaceholderMarkdown(markdown: string): boolean {
  return /^Status:\s*not-started\s*$/imu.test(markdown) && parseReviewMarkdown(markdown).findings.length === 0;
}

export function isCloseoutPlaceholderMarkdown(markdown: string, fingerprints: ReadonlyArray<string>): boolean {
  const normalized = normalizeDocumentText(markdown);
  return fingerprints.some((fingerprint) => {
    const candidate = normalizeDocumentText(fingerprint);
    return candidate.length > 0 && normalized.includes(candidate);
  });
}

export function isTaskDocumentPlaceholderMarkdown(
  markdown: string,
  fingerprintSets: ReadonlyArray<ReadonlyArray<TaskDocumentPlaceholderSectionFingerprint>>
): boolean {
  return fingerprintSets.some((fingerprints) => fingerprints.length > 0 && fingerprints.every((fingerprint) => (
    fingerprint.body.length > 0 && extractMarkdownSection(markdown, fingerprint.anchor) === fingerprint.body
  )));
}

export function extractMarkdownSection(markdown: string, anchor: string): string {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === anchor);
  if (start < 0) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/u.test(line.trim())) break;
    if (line.trim()) body.push(line.trim());
  }
  return body.join("\n").trim();
}

export function evaluateDecisionReckonGate(input: DecisionReckonGateInput): DecisionReckonGateResult {
  const decisionRef = `decision/${input.decisionId}`;
  const covered = new Set(input.coverageRows.filter((row) => row.status === "covered").map((row) => row.claimRef));
  const loadBearingClaimRefs = input.claims.filter((claim) => claim.load_bearing !== false).map((claim) => `${decisionRef}/${claim.id}`);
  const uncoveredClaimRefs = loadBearingClaimRefs.filter((claimRef) => !covered.has(claimRef));
  return {
    ok: uncoveredClaimRefs.length === 0,
    status: uncoveredClaimRefs.length === 0 ? "passed" : "failed",
    decisionRef,
    reckonedAt: input.reckonedAt,
    loadBearingClaimRefs,
    uncoveredClaimRefs,
    coveredClaimRefs: loadBearingClaimRefs.filter((claimRef) => covered.has(claimRef))
  };
}

function splitMarkdownRow(line: string): string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

function parseYesNo(value: string): boolean | null {
  return value === "yes" ? true : value === "no" ? false : null;
}

function isReviewSeverity(value: string): value is ReviewSeverity {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

function normalizeDocumentText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
