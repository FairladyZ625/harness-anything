export type ReviewSeverity = "P0" | "P1" | "P2" | "P3";
export type ReviewGateStatus = "passed" | "failed";
export type PhaseKind = "init" | "execution" | "gate";
export type PhaseActor = "agent" | "human" | "coordinator" | "reviewer";
export type PhaseEvidenceStatus = "missing" | "partial" | "present" | "waived";
export type CloseoutGateReadiness = "not_required" | "missing" | "incomplete" | "ready" | "passed" | "failed";

export interface ReviewFinding {
  readonly id: string;
  readonly severity: ReviewSeverity;
  readonly finding: string;
  readonly open: boolean;
  readonly blocksRelease: boolean;
}

export interface ReviewGateInput {
  readonly taskId: string;
  readonly reviewerId: string;
  readonly submittedAt: string;
  readonly findings: ReadonlyArray<ReviewFinding>;
}

export interface ReviewGateIssue {
  readonly code: "invalid_review_table" | "release_blocking_finding";
  readonly findingId?: string;
  readonly message: string;
}

export interface VerifierBackedReviewContract {
  readonly schema: "verifier-backed-review/v1";
  readonly taskId: string;
  readonly reviewerId: string;
  readonly verifiedAt: string;
  readonly status: "passed";
  readonly findingSummary: {
    readonly total: number;
    readonly openBlocking: number;
  };
}

export type ReviewGateResult = {
  readonly ok: true;
  readonly status: "passed";
  readonly contract: VerifierBackedReviewContract;
  readonly issues: readonly [];
} | {
  readonly ok: false;
  readonly status: "failed";
  readonly issues: ReadonlyArray<ReviewGateIssue>;
};

export interface ParsedReviewMarkdown {
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly issues: ReadonlyArray<ReviewGateIssue>;
}

export interface PhaseRow {
  readonly phaseId: string;
  readonly kind: PhaseKind;
  readonly actor: PhaseActor;
  readonly exitCommand: string;
  readonly evidenceStatus: PhaseEvidenceStatus;
  readonly humanGate?: boolean;
}

export interface PhaseValidationIssue {
  readonly code: "invalid_phase_kind" | "invalid_phase_actor" | "missing_exit_command" | "agent_claims_human_gate";
  readonly phaseId: string;
  readonly message: string;
}

export interface CompletionGateInput {
  readonly taskId: string;
  readonly coordinationStatus: string;
  readonly packageDisposition: string;
  readonly closeoutReadiness: CloseoutGateReadiness;
  readonly reviewGate: ReviewGateStatus;
  readonly ciGate: ReviewGateStatus;
}

export interface CompletionGateIssue {
  readonly code: "review_not_passed" | "ci_not_passed" | "closeout_not_ready";
  readonly message: string;
}

export interface TaskDocumentPlaceholderPolicy {
  readonly closeoutPlaceholderFingerprints: ReadonlyArray<string>;
}

export function parseReviewMarkdown(markdown: string): ParsedReviewMarkdown {
  const findings: ReviewFinding[] = [];
  const issues: ReviewGateIssue[] = [];
  const lines = markdown.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => normalizeHeader(line) === "id|severity|finding|evidence checked|required action|open|disposition|blocks release|follow-up");
  if (headerIndex < 0) return { findings, issues };

  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith("|")) break;
    const cells = splitMarkdownRow(line);
    if (cells.length < 9) {
      issues.push({ code: "invalid_review_table", message: `Review finding row has ${cells.length} cells, expected 9.` });
      continue;
    }
    if (cells.every((cell) => cell.length === 0)) continue;
    const severity = cells[1];
    if (!isReviewSeverity(severity)) {
      issues.push({ code: "invalid_review_table", findingId: cells[0], message: `Invalid review severity: ${severity}` });
      continue;
    }
    const open = parseYesNo(cells[5]);
    const blocksRelease = parseYesNo(cells[7]);
    if (open === null || blocksRelease === null) {
      issues.push({ code: "invalid_review_table", findingId: cells[0], message: "Open and Blocks Release must be yes or no." });
      continue;
    }
    findings.push({
      id: cells[0],
      severity,
      finding: cells[2],
      open,
      blocksRelease
    });
  }

  return { findings, issues };
}

export function isReviewPlaceholderMarkdown(markdown: string): boolean {
  const parsed = parseReviewMarkdown(markdown);
  return /^Status:\s*not-started\s*$/imu.test(markdown) && parsed.findings.length === 0;
}

export function isCloseoutPlaceholderMarkdown(markdown: string, fingerprints: ReadonlyArray<string>): boolean {
  const normalized = normalizeDocumentText(markdown);
  return fingerprints.some((fingerprint) => {
    const normalizedFingerprint = normalizeDocumentText(fingerprint);
    return normalizedFingerprint.length > 0 && normalized.includes(normalizedFingerprint);
  });
}

export function evaluateReviewGate(input: ReviewGateInput): ReviewGateResult {
  const blocking = input.findings.filter((finding) => finding.open && finding.blocksRelease);
  if (blocking.length > 0) {
    return {
      ok: false,
      status: "failed",
      issues: blocking.map((finding) => ({
        code: "release_blocking_finding",
        findingId: finding.id,
        message: `${finding.severity} finding blocks release: ${finding.finding}`
      }))
    };
  }

  return {
    ok: true,
    status: "passed",
    issues: [],
    contract: {
      schema: "verifier-backed-review/v1",
      taskId: input.taskId,
      reviewerId: input.reviewerId,
      verifiedAt: input.submittedAt,
      status: "passed",
      findingSummary: {
        total: input.findings.length,
        openBlocking: 0
      }
    }
  };
}

export function validatePhaseRows(rows: ReadonlyArray<PhaseRow>): { readonly ok: boolean; readonly issues: ReadonlyArray<PhaseValidationIssue> } {
  const issues: PhaseValidationIssue[] = [];
  for (const row of rows) {
    if (!isPhaseKind(row.kind)) {
      issues.push({ code: "invalid_phase_kind", phaseId: row.phaseId, message: `Invalid phase kind: ${row.kind}` });
    }
    if (!isPhaseActor(row.actor)) {
      issues.push({ code: "invalid_phase_actor", phaseId: row.phaseId, message: `Invalid phase actor: ${row.actor}` });
    }
    if (row.exitCommand.trim().length === 0) {
      issues.push({ code: "missing_exit_command", phaseId: row.phaseId, message: "Phase exit command is required." });
    }
    if (row.humanGate === true && row.actor !== "human") {
      issues.push({ code: "agent_claims_human_gate", phaseId: row.phaseId, message: "Human gate phases must be owned by a human actor." });
    }
  }
  return { ok: issues.length === 0, issues };
}

export function evaluateCompletionGate(input: CompletionGateInput): {
  readonly ok: boolean;
  readonly issues: ReadonlyArray<CompletionGateIssue>;
  readonly axes: Pick<CompletionGateInput, "coordinationStatus" | "packageDisposition" | "closeoutReadiness">;
} {
  const issues: CompletionGateIssue[] = [];
  if (input.reviewGate !== "passed") {
    issues.push({ code: "review_not_passed", message: "Task completion requires a passed review gate." });
  }
  if (input.ciGate !== "passed") {
    issues.push({ code: "ci_not_passed", message: "Task completion requires a passed CI gate." });
  }
  if (input.closeoutReadiness !== "ready" && input.closeoutReadiness !== "passed") {
    issues.push({ code: "closeout_not_ready", message: "Task completion requires closeout readiness to be ready or passed." });
  }
  return {
    ok: issues.length === 0,
    issues,
    axes: {
      coordinationStatus: input.coordinationStatus,
      packageDisposition: input.packageDisposition,
      closeoutReadiness: input.closeoutReadiness
    }
  };
}

function normalizeHeader(line: string): string {
  return splitMarkdownRow(line).map((cell) => cell.toLowerCase()).join("|");
}

function normalizeDocumentText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function splitMarkdownRow(line: string): string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

function parseYesNo(value: string): boolean | null {
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

function isReviewSeverity(value: string): value is ReviewSeverity {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

function isPhaseKind(value: string): value is PhaseKind {
  return value === "init" || value === "execution" || value === "gate";
}

function isPhaseActor(value: string): value is PhaseActor {
  return value === "agent" || value === "human" || value === "coordinator" || value === "reviewer";
}
