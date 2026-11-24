import type { ReviewReverifyMode, ReviewReverifyRoute, taskCompletionNext } from "@harness-anything/kernel";

/** One read-only completion next step for a single task, as `ha task complete` would judge it. */
export type DaemonTaskCompletionResult = {
  readonly ok: true;
  readonly taskId: string;
  /** The step to run now: a blocker's remediation, or `ha task complete` once none remains. */
  readonly completionNext: ReturnType<typeof taskCompletionNext>["next"];
  /** The blocker completionNext narrates, when one remains; null means the cut is ready to complete. */
  readonly completionBlocker: Pick<
    Exclude<ReturnType<typeof taskCompletionNext>["blocker"], null>,
    "code" | "gate"
  > | null;
  /**
   * Upstream Facts still needing an explicit still-holds/superseded disposition at completion,
   * exposed before the write so fact_retirement_undeclared is never a surprise. Null when the
   * gate is off, nothing is undischarged, or the relation neighborhood is not projected yet.
   */
  readonly factRetirement: {
    readonly undischarged: readonly {
      readonly factRef: string;
      readonly viaClaim: string;
      readonly viaDecision: string;
    }[];
  } | null;
  /**
   * dec_BEFCF7D0484E901F187C2C8EC6: the kernel reverify route of the task's current round and each
   * previous blocking finding's reverify. Additive: absent on older producers.
   */
  readonly reviewReverify?: {
    readonly route: ReviewReverifyRoute["kind"];
    readonly findings: readonly {
      readonly reviewId: string;
      readonly findingId: string;
      readonly reverify: ReviewReverifyMode;
      readonly adopted: boolean;
    }[];
  } | null;
};
