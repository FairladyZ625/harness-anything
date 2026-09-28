import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { GuiActionResult } from "../api/renderer-dto.ts";
import { harnessClient } from "./api-client.ts";
import { settleDecisionReceipt, type DecisionMutationFeedback } from "./decision-actions.ts";
import { triadicQueryKeys } from "./triadic-data.ts";
import { decisionShowQueryKeys } from "./decision-show-data.ts";

/**
 * Decision 评审的三个写动作(回应 / 业主处置 / 派审)。落定判据与裁决写同一条:回应与处置
 * 是 Decision 事件,回执三件套证 canonical 落定;派审是运行时派工,`applied` 即中心已接受
 * (同切面重复派审返回既有派工)。写后只失效三元切面,状态由重读得到,不在本地改写。
 */
export type DecisionReviewWriteKind = "respond" | "override" | "dispatch";

export interface DecisionReviewWriteFeedback {
  readonly state: DecisionMutationFeedback["state"];
  readonly kind: DecisionReviewWriteKind;
  readonly opId: string;
  readonly code?: string;
  readonly hint: string;
}

type ReceiptWithError = GuiActionResult & {
  readonly summary?: string;
  readonly nextAction?: string;
  readonly error?: { readonly code?: string; readonly hint?: string };
};

export function settleReviewDispatchReceipt(receipt: GuiActionResult): Omit<DecisionReviewWriteFeedback, "kind"> {
  const value = receipt as ReceiptWithError;
  if (value.outcome === "applied" || value.outcome === "no_changes")
    return { state: "success", opId: value.opId, hint: value.summary ?? value.opId };
  if (value.outcome === "pending" || value.outcome === "indeterminate")
    return { state: "pending", opId: value.opId, code: value.outcome, hint: value.nextAction ?? value.outcome };
  return {
    state: "error",
    opId: value.opId,
    code: value.error?.code ?? "write_rejected",
    hint: value.error?.hint ?? value.nextAction ?? "write_rejected",
  };
}

export function useDecisionReviewActions(repoId: string, decisionId: string) {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<DecisionReviewWriteFeedback | undefined>();
  const run = async (kind: DecisionReviewWriteKind, write: () => Promise<GuiActionResult>) => {
    setFeedback({ state: "pending", kind, opId: "awaiting-receipt", hint: "" });
    try {
      const receipt = await write();
      const settled =
        kind === "dispatch"
          ? settleReviewDispatchReceipt(receipt)
          : (() => {
              const settlement = settleDecisionReceipt(receipt);
              return settlement.state === "applied"
                ? { state: "success" as const, opId: settlement.opId, hint: settlement.receipt.path ?? settlement.opId }
                : {
                    state: settlement.state === "op_rejected" ? ("error" as const) : ("pending" as const),
                    opId: settlement.opId,
                    ...(settlement.code ? { code: settlement.code } : {}),
                    hint: settlement.hint ?? settlement.opId,
                  };
            })();
      // 评审写改变的是单体读上的切面与就绪,列表行上的派工:两处一起失效,状态靠重读得到。
      if (settled.state !== "error")
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: triadicQueryKeys.all(repoId) }),
          queryClient.invalidateQueries({ queryKey: decisionShowQueryKeys.repo(repoId) }),
        ]);
      const next = { ...settled, kind };
      setFeedback(next);
      return next;
    } catch (error) {
      const next = {
        state: "error" as const,
        kind,
        opId: "N/A",
        code: "bridge_error",
        hint: error instanceof Error ? error.message : String(error),
      };
      setFeedback(next);
      return next;
    }
  };
  return {
    feedback,
    respond: (responses: Parameters<typeof harnessClient.respondDecisionReview>[0]["responses"]) =>
      run("respond", () => harnessClient.respondDecisionReview({ repoId, decisionId, responses })),
    override: (input: {
      readonly reviewContentDigest: string;
      readonly reviewIds: readonly string[];
      readonly reason: string;
    }) => run("override", () => harnessClient.overrideDecisionReview({ repoId, decisionId, ...input })),
    dispatch: (expectedDigest: string) =>
      run("dispatch", () => harnessClient.dispatchDecisionReview({ repoId, decisionId, expectedDigest })),
  };
}
