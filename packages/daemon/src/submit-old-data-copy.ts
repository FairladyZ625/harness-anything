import { cellCodedError } from "./repo-cell-errors.ts";
import type { SubmissionV1 } from "@harness-anything/kernel";

/**
 * A cut that seats the data-migration professional reviewer (its frozen `review.pathReviewers`
 * lane matched, the same routing evidence `reviewSeatForCut` reads) must arrive with the real
 * old-data-copy receipt for that same cut. The trigger is not re-derived here: `dataMigrationMatch`
 * only names the lane the submit already froze, so a later settings edit cannot move a cut.
 *
 * Submit never runs the copy. It reads the receipt the worker produced and checks exactly two
 * facts — the cut it was run against and that it recorded no failures. The tool's own `ok`
 * invariant (attach completed, cold rebuild at the source revision) stays the tool's judgment.
 */
export const DATA_MIGRATION_REVIEWER_ID = "data-migration";

const OLD_DATA_COPY_EVIDENCE_DIR = "old-data-copy-evidence",
  OLD_DATA_COPY_RECEIPT_FILE = "old-data-copy-evidence-receipt.json";

/** The one receipt location submit reads: the task package's own evidence subtree, now `<out>`. */
export function oldDataCopyReceiptPath(packagePath: string): string {
  return `${packagePath}/artifacts/${OLD_DATA_COPY_EVIDENCE_DIR}/${OLD_DATA_COPY_RECEIPT_FILE}`;
}

/** The paths that seat the data-migration reviewer for this cut, from its frozen assessment. */
export function dataMigrationMatch(submission: SubmissionV1): readonly string[] {
  return (
    submission.riskTierAssessment?.matchedPathReviewers.find(({ agentId }) => agentId === DATA_MIGRATION_REVIEWER_ID)
      ?.paths ?? []
  );
}

/** The command that produces the receipt at the canonical location, runnable from the worktree. */
export function oldDataCopyCommand(packagePath: string): string {
  return `node tools/old-data-copy-evidence.mjs --build . --out harness/${packagePath}/artifacts/${OLD_DATA_COPY_EVIDENCE_DIR}`;
}

export interface OldDataCopyReceiptJudgment {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Judge the receipt the same way the reviewer reads it: the build commit it names must be the
 * frozen cut, and it must record no failures. Anything else is reported with its own fact so the
 * worker can tell a missing receipt from a stale one from a failed run.
 */
export function judgeOldDataCopyReceipt(text: string, cutSha: string): OldDataCopyReceiptJudgment {
  let receipt: unknown;
  try {
    receipt = JSON.parse(text);
  } catch {
    return { ok: false, reason: "is not valid JSON" };
  }
  if (!isRecord(receipt) || receipt.schema !== "old-data-copy-evidence/v1")
    return { ok: false, reason: "is not an old-data-copy-evidence/v1 receipt" };
  const build = isRecord(receipt.build) ? receipt.build : {},
    bound =
      typeof build.headCommit === "string" ? build.headCommit : typeof build.commit === "string" ? build.commit : null;
  if (bound === null) return { ok: false, reason: "does not name the build commit it ran" };
  if (bound !== cutSha) return { ok: false, reason: `is bound to cut ${bound}, not the submitted cut ${cutSha}` };
  const failures = Array.isArray(receipt.failures) ? receipt.failures : [],
    phases = failures.map(failurePhase).filter((phase) => phase !== null);
  if (receipt.ok !== true || failures.length > 0)
    return {
      ok: false,
      reason:
        failures.length > 0
          ? `records ${String(failures.length)} failure(s)${phases.length > 0 ? `: ${phases.join(", ")}` : ""}`
          : "records ok=false",
    };
  return { ok: true };
}

/**
 * Submit admission for a migration-surface cut. Returns silently when the cut seats no
 * data-migration reviewer, so the ordinary delivery path is untouched.
 */
export function assertOldDataCopyReceipt(input: {
  readonly taskId: string;
  readonly packagePath: string;
  readonly submission: SubmissionV1;
  readonly readReceipt: () => string | null;
}): void {
  const matched = dataMigrationMatch(input.submission);
  if (matched.length === 0) return;
  const cutSha = input.submission.commitSha,
    target = oldDataCopyReceiptPath(input.packagePath),
    location = `harness/${target}`,
    command = oldDataCopyCommand(input.packagePath),
    rerun = `Run ${command}, then rerun ha task submit ${input.taskId}.`;
  if (cutSha === null)
    throw Object.assign(
      cellCodedError(
        "invalid_submission",
        `This submission touches the data-migration review surface (${matched.join(", ")}) but freezes no commit, ` +
          `so no receipt can bind it. ${rerun}`,
      ),
      { nextAction: command },
    );
  const text = input.readReceipt();
  if (text === null)
    throw Object.assign(
      cellCodedError(
        "invalid_submission",
        `Cut ${cutSha} touches the data-migration review surface (${matched.join(", ")}), so submit requires a ` +
          `real old-data-copy receipt bound to this cut at ${location}. ${rerun}`,
      ),
      { nextAction: command },
    );
  const judgment = judgeOldDataCopyReceipt(text, cutSha);
  if (!judgment.ok)
    throw Object.assign(
      cellCodedError("invalid_submission", `The old-data-copy receipt at ${location} ${judgment.reason}. ${rerun}`),
      { nextAction: command },
    );
}

function failurePhase(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value.phase === "string" && value.phase !== "" ? value.phase : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
