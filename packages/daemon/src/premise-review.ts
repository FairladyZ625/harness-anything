import type { FactProjectionRow, TaskProjectionQueries } from "@harness-anything/kernel";

/**
 * A premise review is a task-bound Fact with this domain type. Its statement answers three questions
 * and names one conclusion, so the record lives in the ledger beside the task it judged:
 *
 *   restart: would we start this task today, from zero? alternative: the simplest alternative.
 *   sunk-cost: is the cost already spent driving the call? conclusion: continue | narrow | stop
 *
 * `ha task rework` past the repository rework budget and the agenda shape signal both read it.
 */
export const PREMISE_REVIEW_TYPE = "premise-review";

const KEYS = ["restart", "alternative", "sunk-cost", "conclusion"] as const;
export type PremiseReviewConclusion = "continue" | "narrow" | "stop";

export type PremiseReviewParse =
  | { readonly ok: true; readonly conclusion: PremiseReviewConclusion }
  | { readonly ok: false; readonly missing: readonly string[] };

export function premiseReviewCommand(taskId: string): string {
  return (
    `ha fact record --task ${taskId} --type ${PREMISE_REVIEW_TYPE} --source review:premise --statement ` +
    `"restart: <would we start this today, from zero?> alternative: <simplest alternative, including not doing it> ` +
    `sunk-cost: <is the cost already spent driving this?> conclusion: continue|narrow|stop"`
  );
}

/** Read the four labelled answers; each needs text, and the conclusion must be one of three words. */
export function parsePremiseReview(statement: string): PremiseReviewParse {
  const marks = [...statement.matchAll(/(restart|alternative|sunk-cost|conclusion)\s*[:：]/giu)],
    answers = new Map<string, string>();
  marks.forEach((mark, index) => {
    const start = mark.index + mark[0].length,
      end = marks[index + 1]?.index ?? statement.length;
    answers.set(mark[1]!.toLowerCase(), statement.slice(start, end).trim());
  });
  const missing = KEYS.filter((key) => !answers.get(key)),
    conclusion = /^(continue|narrow|stop)\b/iu.exec(answers.get("conclusion") ?? "")?.[1]?.toLowerCase();
  if (missing.length === 0 && conclusion) return { ok: true, conclusion: conclusion as PremiseReviewConclusion };
  return { ok: false, missing: missing.length ? missing : ["conclusion: continue|narrow|stop"] };
}

/**
 * The newest standing premise review of this task recorded after `after`. A review answers the
 * state it saw: one written before the latest return or escalation does not cover what came later.
 */
export function latestPremiseReview(
  projection: Pick<TaskProjectionQueries, "searchFacts">,
  taskId: string,
  after: string,
): { readonly fact: FactProjectionRow; readonly review: PremiseReviewParse } | null {
  const fact = projection
    .searchFacts({ taskId, domainType: PREMISE_REVIEW_TYPE, observedAfter: after, limit: 20 })
    .facts.find((row) => row.occurredAt > after && row.state === "standing" && !row.archived && !row.invalidated);
  return fact ? { fact, review: parsePremiseReview(fact.statement) } : null;
}
