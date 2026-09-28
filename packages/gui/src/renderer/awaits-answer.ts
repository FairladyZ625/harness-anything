import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { AgendaAnsweredRow, AgendaAwaitsRow } from "../api/renderer-dto.ts";
import { agendaQueryKeys } from "./agenda-data.ts";
import { harnessClient } from "./api-client.ts";
import { t } from "./i18n/index.tsx";
import { settleTaskReceipt } from "./task-actions.ts";
import { taskQueryKeys } from "./task-data.ts";

/**
 * 「等你答复」就地答复(dec_DF67F23066BAFE444190A191B5):答复 = 以当前 GUI 使用者身份
 * retire 这条 awaits 边,答复原文进 retire 理由——与 `ha relation unrelate` 同一条 daemon 动作。
 */
export type AwaitsAskKind = AgendaAwaitsRow["askKind"];

/** 面板打开的对象:待答复(可答)或已答复(只读,给提问方跟进)。 */
export type AwaitsPanelSubject =
  | { readonly mode: "answer"; readonly row: AgendaAwaitsRow }
  | { readonly mode: "answered"; readonly row: AgendaAnsweredRow };

export interface AwaitsChoice {
  readonly id: string;
  readonly label: () => string;
  readonly tone: "primary" | "danger";
}

/** 每类请求的选项;question 没有选项,答复就是自由输入。 */
export const AWAITS_CHOICES: Readonly<Record<AwaitsAskKind, readonly AwaitsChoice[]>> = {
  acceptance: [
    { id: "pass", label: () => t("components.awaitsAnswer.choice.pass"), tone: "primary" },
    { id: "fail", label: () => t("components.awaitsAnswer.choice.fail"), tone: "danger" },
  ],
  reopen: [
    { id: "reopen", label: () => t("components.awaitsAnswer.choice.reopen"), tone: "primary" },
    { id: "keepClosed", label: () => t("components.awaitsAnswer.choice.keepClosed"), tone: "danger" },
  ],
  consent: [
    { id: "agree", label: () => t("components.awaitsAnswer.choice.agree"), tone: "primary" },
    { id: "disagree", label: () => t("components.awaitsAnswer.choice.disagree"), tone: "danger" },
  ],
  question: [],
};

export const AWAITS_KIND_LABEL: Readonly<Record<AwaitsAskKind, () => string>> = {
  question: () => t("components.awaitsAnswer.kind.question"),
  acceptance: () => t("components.awaitsAnswer.kind.acceptance"),
  consent: () => t("components.awaitsAnswer.kind.consent"),
  reopen: () => t("components.awaitsAnswer.kind.reopen"),
};

/**
 * 答复写进 retire 理由的格式:有选项时「选项:意见」(无意见只写选项),question 就是原文。
 * 提问方在 agenda / 关系历史里一眼看到选了什么、为什么。
 */
export function composeAwaitsAnswer(choice: AwaitsChoice | null, comment: string): string {
  const text = comment.trim();
  if (choice === null) return text;
  return text ? `${choice.label()}:${text}` : choice.label();
}

export interface AwaitsAnswerFeedback {
  readonly state: "pending" | "success" | "error" | "conflict";
  readonly opId: string;
  readonly code?: string;
  readonly hint: string;
}

/** 提交答复:回执落定即失效 agenda 与任务切面,条目随 refetch 从「等你答复」消失。 */
export function useAwaitsAnswer(repoId: string) {
  const queryClient = useQueryClient(),
    [feedback, setFeedback] = useState<AwaitsAnswerFeedback | null>(null);
  const submit = useCallback(
    async (row: AgendaAwaitsRow, reason: string): Promise<AwaitsAnswerFeedback> => {
      setFeedback({ state: "pending", opId: "awaiting-receipt", hint: t("components.awaitsAnswer.submitting") });
      // 与 task-actions 的写动作同一形状:回执落定成反馈,桥接层拒绝也原样显示成错误反馈。
      const result: AwaitsAnswerFeedback = await harnessClient
        .retireRelation({ repoId, relationId: row.relationId, reason, expectedVersion: row.relationRevision })
        .then(
          (receipt): AwaitsAnswerFeedback => {
            const settlement = settleTaskReceipt(receipt);
            return settlement.state === "applied"
              ? { state: "success", opId: settlement.opId, hint: t("components.awaitsAnswer.success") }
              : settlement.code === "revision_conflict"
                ? {
                    state: "conflict",
                    opId: settlement.opId,
                    code: settlement.code,
                    hint: t("components.awaitsAnswer.conflict"),
                  }
                : {
                    state: settlement.state === "pending" ? "pending" : "error",
                    opId: settlement.opId,
                    ...(settlement.code ? { code: settlement.code } : {}),
                    hint: settlement.hint ?? t("components.awaitsAnswer.failed"),
                  };
          },
          (error: unknown): AwaitsAnswerFeedback => ({
            state: "error",
            opId: "N/A",
            code: "bridge_error",
            hint: error instanceof Error ? error.message : String(error),
          }),
        );
      if (result.state !== "error")
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: agendaQueryKeys.read(repoId) }),
          queryClient.invalidateQueries({ queryKey: taskQueryKeys.all(repoId), refetchType: "active" }),
        ]);
      setFeedback(result);
      return result;
    },
    [repoId, queryClient],
  );
  return { feedback, submit, reset: () => setFeedback(null) };
}
