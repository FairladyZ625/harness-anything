import { cellCodedError } from "./repo-cell-errors.ts";
import type { SubmissionV1 } from "@harness-anything/kernel";

/**
 * A cut that seats the data-migration professional reviewer (its frozen `review.pathReviewers`
 * lane matched, the same routing evidence `reviewSeatForCut` reads) must arrive with the real
 * old-data-copy receipt for that same cut. The trigger is not re-derived here: `dataMigrationMatch`
 * only names the lane the submit already froze, so a later settings edit cannot move a cut.
 *
 * Per dec_3375D713F1A0D4F89FF269B990 CH3 (Slice S5, net gate count +0), this single gate routes
 * across two tiers:
 * - Tier 1 (`golden`): deterministic condensed full-morphology Gen-3 snapshot (<30s cross-platform)
 *   for ordinary `data-migration` PR cuts that do not modify persistent schema/migration formats.
 * - Tier 2 (`full`): full live canonical ledger cold-rebuild, required whenever a cut modifies
 *   `taskProjectionSchemaVersion` or persistent projection/ledger/migration schema format files.
 *   A `full` receipt (and legacy receipts omitting `tier`) always satisfies a `golden` requirement.
 *
 * Submit never runs the copy. It reads the receipt the worker produced and checks the cut it was
 * run against, that its tier meets the cut's requirement, and that it recorded no failures.
 */
export const DATA_MIGRATION_REVIEWER_ID = "data-migration";

export type OldDataCopyTier = "golden" | "full";

const OLD_DATA_COPY_TIERS: readonly OldDataCopyTier[] = ["golden", "full"];

/**
 * Exact repository paths whose modification alters persistent SQLite/PostgreSQL projection
 * schemas, `taskProjectionSchemaVersion`, Gen-3 `ledger.sqlite` format, or attach/generation
 * migration contracts and therefore escalates this gate to Tier 2 (`full`).
 */
export const FULL_OLD_DATA_COPY_PATHS: readonly string[] = Object.freeze([
  "packages/storage/src/projection/projection-schema.ts",
  "packages/storage/src/projection/projection-tables.ts",
  "packages/storage/src/projection/decision-projection-schema.ts",
  "packages/storage/src/projection/relation-freshness-columns.ts",
  "packages/storage/src/projection/rebuildable-task-projection-database.ts",
  "packages/storage/src/pg/pg-projection-schema.ts",
  "packages/storage/src/pg/pg-decision-search-schema.ts",
  "packages/storage/src/pg/pg-document-metadata-migration.ts",
  "packages/storage/src/pg/pg-decision-index-migration.ts",
  "packages/storage/src/pg/pg-event-read-index-migration.ts",
  "packages/storage/src/pg/pg-read-index-migration.ts",
  "packages/storage/src/store/sqlite-event-store.ts",
  "packages/storage/src/store/sqlite-ledger-layout.ts",
  "packages/storage/src/store/sqlite-entity-declarations.ts",
  "packages/storage/src/store/replication-log.ts",
  "packages/storage/src/store/generation-three-activation.ts",
  "packages/storage/src/store/generation-three-selection.ts",
  "packages/storage/src/store/generation-two-conversion.ts",
  "packages/storage/src/store/completion-generation-conversion.ts",
  "packages/storage/src/store/legacy-generation-conversion.ts",
  "packages/storage/src/store/attach-migrations.ts",
  "packages/storage/src/store/event-shape-migration.ts",
  "packages/storage/src/migration/engine.ts",
  "packages/storage/src/migration/manifest.ts",
  "packages/storage/src/migration/open.ts",
  "packages/storage/src/migration/postgres-endpoint.ts",
  "packages/storage/src/migration/postgres-grant.ts",
  "packages/storage/src/migration/postgres-projection-audit.ts",
  "packages/storage/src/migration/postgres-schema.ts",
  "packages/storage/src/migration/projection.ts",
  "packages/storage/src/migration/sqlite-control.ts",
  "packages/storage/src/migration/sqlite-endpoint.ts",
  "packages/storage/src/migration/types.ts",
]);

const FULL_OLD_DATA_COPY_PATH_SET = new Set<string>(FULL_OLD_DATA_COPY_PATHS);

const OLD_DATA_COPY_EVIDENCE_DIR = "old-data-copy-evidence",
  OLD_DATA_COPY_RECEIPT_FILE = "old-data-copy-evidence-receipt.json";

/** True when a repository-relative path alters a persistent schema/ledger/migration format. */
export function isFullOldDataCopyPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  return FULL_OLD_DATA_COPY_PATH_SET.has(normalized);
}

/**
 * Resolve the minimum old-data-copy tier required for a migration-surface submission.
 * Escalates to `"full"` whenever any matched path or changed file in the cut touches
 * `FULL_OLD_DATA_COPY_PATHS`; otherwise `"golden"`.
 */
export function requiredOldDataCopyTier(
  matchedPaths: readonly string[],
  changedFiles: readonly string[] = [],
): OldDataCopyTier {
  return [...matchedPaths, ...changedFiles].some(isFullOldDataCopyPath) ? "full" : "golden";
}

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
export function oldDataCopyCommand(packagePath: string, tier: OldDataCopyTier = "golden"): string {
  return `node tools/old-data-copy-evidence.mjs --tier ${tier} --build . --out harness/${packagePath}/artifacts/${OLD_DATA_COPY_EVIDENCE_DIR}`;
}

export interface OldDataCopyReceiptJudgment {
  readonly ok: boolean;
  readonly tier?: OldDataCopyTier;
  readonly reason?: string;
}

/**
 * Judge the receipt the same way the reviewer reads it: the build commit it names must be the
 * frozen cut, its tier must satisfy `requiredTier` (legacy receipts omitting `tier` count as
 * `"full"`), and it must record no failures.
 */
export function judgeOldDataCopyReceipt(
  text: string,
  cutSha: string,
  requiredTier: OldDataCopyTier = "golden",
): OldDataCopyReceiptJudgment {
  let receipt: unknown;
  try {
    receipt = JSON.parse(text);
  } catch {
    return { ok: false, reason: "is not valid JSON" };
  }
  if (!isRecord(receipt) || receipt.schema !== "old-data-copy-evidence/v1")
    return { ok: false, reason: "is not an old-data-copy-evidence/v1 receipt" };
  const tier = parseReceiptTier(receipt.tier);
  if (tier === null)
    return {
      ok: false,
      reason: `records invalid tier ${JSON.stringify(receipt.tier)} (expected "golden" or "full")`,
    };
  if (requiredTier === "full" && tier !== "full")
    return {
      ok: false,
      tier,
      reason: `is tier "${tier}", but this cut modifies persistent schema/format files and requires tier "full"`,
    };
  const build = isRecord(receipt.build) ? receipt.build : {},
    bound =
      typeof build.headCommit === "string" ? build.headCommit : typeof build.commit === "string" ? build.commit : null;
  if (bound === null) return { ok: false, tier, reason: "does not name the build commit it ran" };
  if (bound !== cutSha) return { ok: false, tier, reason: `is bound to cut ${bound}, not the submitted cut ${cutSha}` };
  // The producer always emits an array. A missing, null, or scalar value is a truncated or
  // hand-made payload whose failure list cannot be trusted, so it is not an empty list.
  if (!Array.isArray(receipt.failures)) return { ok: false, tier, reason: "does not record a failures array" };
  const failures = receipt.failures,
    phases = failures.map(failurePhase).filter((phase) => phase !== null);
  if (receipt.ok !== true || failures.length > 0)
    return {
      ok: false,
      tier,
      reason:
        failures.length > 0
          ? `records ${String(failures.length)} failure(s)${phases.length > 0 ? `: ${phases.join(", ")}` : ""}`
          : "records ok=false",
    };
  return { ok: true, tier };
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
    requiredTier = requiredOldDataCopyTier(matched, input.submission.changedFiles ?? []),
    target = oldDataCopyReceiptPath(input.packagePath),
    location = `harness/${target}`,
    command = oldDataCopyCommand(input.packagePath, requiredTier),
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
          `real old-data-copy receipt (tier "${requiredTier}") bound to this cut at ${location}. ${rerun}`,
      ),
      { nextAction: command },
    );
  const judgment = judgeOldDataCopyReceipt(text, cutSha, requiredTier);
  if (!judgment.ok)
    throw Object.assign(
      cellCodedError("invalid_submission", `The old-data-copy receipt at ${location} ${judgment.reason}. ${rerun}`),
      { nextAction: command },
    );
}

function parseReceiptTier(value: unknown): OldDataCopyTier | null {
  // Legacy receipts emitted before Slice S5 omitted `tier` and always ran against the full ledger.
  if (value === undefined) return "full";
  if (typeof value === "string" && (OLD_DATA_COPY_TIERS as readonly string[]).includes(value))
    return value as OldDataCopyTier;
  return null;
}

function failurePhase(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value.phase === "string" && value.phase !== "" ? value.phase : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
