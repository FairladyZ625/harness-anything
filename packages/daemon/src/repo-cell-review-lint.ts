import { isIndependentFrom, type ActorIdentity } from "../../kernel/src/index.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { Snapshot } from "./repo-cell-types.ts";

export function legacyReviewLint(body: string, taskId: string, reviewerId: string, verifiedAt: string) {
  const lines = body.split(/\r?\n/u),
    header = lines.findIndex(
      (line) =>
        line
          .replace(/^\||\|$/gu, "")
          .split("|")
          .map((cell) => cell.trim().toLocaleLowerCase())
          .join("|") ===
        "id|severity|finding|evidence checked|required action|open|disposition|blocks release|follow-up",
    ),
    issues: { code: string; findingId?: string; message: string }[] = [],
    findings: {
      id: string;
      severity: string;
      finding: string;
      open: boolean;
      blocksRelease: boolean;
    }[] = [];
  if (header >= 0)
    for (const line of lines.slice(header + 2)) {
      if (!line.trim().startsWith("|")) break;
      const cells = line
        .replace(/^\||\|$/gu, "")
        .split("|")
        .map((cell) => cell.trim());
      if (cells.length < 9) {
        issues.push({
          code: "invalid_review_table",
          message: `Review finding row has ${cells.length} cells, expected 9.`,
        });
        continue;
      }
      const yesNo = (value: string) =>
          /^(?:yes|true)$/iu.test(value) ? true : /^(?:no|false)$/iu.test(value) ? false : null,
        open = yesNo(cells[5]!),
        blocksRelease = yesNo(cells[7]!);
      if (!/^(?:P0|P1|P2|P3)$/u.test(cells[1]!) || open === null || blocksRelease === null) {
        issues.push({
          code: "invalid_review_table",
          findingId: cells[0],
          message: "Severity must be P0-P3 and Open/Blocks Release must be yes or no.",
        });
        continue;
      }
      findings.push({
        id: cells[0]!,
        severity: cells[1]!,
        finding: cells[2]!,
        open,
        blocksRelease,
      });
    }
  const blocking = findings.filter((finding) => finding.open && finding.blocksRelease);
  return {
    applicable: true,
    valid: issues.length === 0,
    status: issues.length ? "invalid" : blocking.length ? "warning" : "passed",
    issues: [
      ...issues,
      ...blocking.map((finding) => ({
        code: "release_blocking_finding",
        findingId: finding.id,
        message: `${finding.severity} finding blocks release: ${finding.finding}`,
      })),
    ],
    reviewerId,
    contract: {
      schema: "verifier-backed-review/v1",
      taskId,
      reviewerId,
      verifiedAt,
      status: blocking.length ? "warning" : "passed",
      findingSummary: { total: findings.length, openBlocking: blocking.length },
    },
  };
}

// Independence is decided on the executor axis, never on the shared transport principal. Reporting both
// failures as one "independent transport-bound arbiter" sentence sent #1541 hunting a transport defect for
// what is an undeclared executor on the original start, so each cause now names itself and its own repair.
export function reviewerDependence(actor: ActorIdentity, snapshot: Snapshot): string | null {
  const execution = snapshot.executions.find(
    (candidate) => candidate.iteration === snapshot.task?.iteration && candidate.submission !== null,
  );
  if (execution === undefined)
    return "Execution Review requires a submitted execution on the current iteration; submit the execution first.";
  if (isIndependentFrom(execution.actor, actor)) return null;
  return execution.actor.executor === null && actor.executor === null
    ? [
        "Execution Review requires a reviewer independent of the submitter: the ",
        "submitted execution's original start declared no executor, so only a ",
        "different person can review it. Run ha task declare-executor with that ",
        "principal and an agent executor to record an auditable recovery before ",
        "same-person review.",
      ].join("")
    : [
        "Execution Review requires a reviewer independent of the submitting ",
        "executor; review without declaring that executor.",
      ].join("");
}

export function reviewVerdict(value: unknown): "approved" | "changes_requested" | "dismissed" {
  if (value === "approved" || value === "changes_requested" || value === "dismissed") return value;
  throw cellCodedError("invalid_command", "verdict must be approved, changes_requested, or dismissed.");
}

export function iteration(value: unknown): number {
  if (value === 0 || value === 1) return value;
  throw cellCodedError("invalid_command", "iteration must be 0 or 1.");
}

export function digest(value: unknown, name: string): `sha256:${string}` {
  if (typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value)) return value as `sha256:${string}`;
  throw cellCodedError("invalid_command", `${name} must be a SHA-256 digest.`);
}
