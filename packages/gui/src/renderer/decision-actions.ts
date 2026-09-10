import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { GuiActionResult } from "../api/renderer-dto.ts";
import { consumeKnownError } from "../api/error-consumption.ts";
import { harnessClient, type DecisionProposalInput } from "./api-client.ts";
import type { DecisionRow, RelationEdge } from "./model/types.ts";
import { triadicQueryKeys } from "./triadic-data.ts";
import { workspaceSummaryQueryKeys } from "./workspace-summary-data.ts";

type ReceiptRecord = GuiActionResult & {
  readonly revision?: number;
  readonly code?: string;
  readonly origin?: string;
  readonly nextAction?: string;
  readonly evidence?: string;
  readonly error?: { readonly code?: string; readonly hint?: string };
  readonly proof?: {
    readonly committedRevision?: number;
    readonly appliedCut?: number;
    readonly durable?: boolean;
    readonly canonicalVisible?: boolean;
  };
  readonly path?: string;
  readonly commitSha?: string | null;
  readonly documentSha256?: string;
  readonly worktreeVisible?: boolean;
  readonly consentId?: string | null;
};

export interface DecisionSettlement {
  readonly state: "applied" | "pending" | "op_rejected";
  readonly opId: string;
  readonly code?: string;
  readonly origin?: string;
  readonly hint?: string;
  readonly receipt: ReceiptRecord;
}

// Settles from the write receipt itself; Git and worktree follower fields are shown, never awaited.
export function settleDecisionReceipt(initial: GuiActionResult): DecisionSettlement {
  const receipt = initial as ReceiptRecord,
    proof = receipt.proof;
  const validCommitIdentity =
    receipt.commitSha === null || (typeof receipt.commitSha === "string" && receipt.commitSha.length > 0);
  const completeDecisionReceipt =
    typeof receipt.path === "string" &&
    receipt.path.length > 0 &&
    validCommitIdentity &&
    typeof receipt.documentSha256 === "string" &&
    receipt.documentSha256.length > 0;
  if (
    receipt.outcome === "applied" &&
    completeDecisionReceipt &&
    proof?.durable === true &&
    proof.canonicalVisible === true &&
    proof.committedRevision === proof.appliedCut
  ) {
    return { state: "applied", opId: receipt.opId, receipt };
  }
  if (receipt.outcome === "pending" || receipt.outcome === "indeterminate" || receipt.outcome === "applied") {
    return {
      state: "pending",
      opId: receipt.opId,
      code: receipt.outcome === "applied" ? "canonical_not_visible" : (receipt.code ?? receipt.outcome),
      ...(receipt.origin ? { origin: receipt.origin } : {}),
      hint: receipt.nextAction ?? "用 opId 查询 canonical receipt；不要重放 mutation。",
      receipt,
    };
  }
  return {
    state: "op_rejected",
    opId: receipt.opId,
    code: receipt.error?.code ?? receipt.code ?? "write_rejected",
    ...(receipt.origin ? { origin: receipt.origin } : {}),
    hint: receipt.error?.hint ?? receipt.nextAction ?? "检查 canonical rejection；修正后显式重新提交。",
    receipt,
  };
}

/**
 * 决策的 claim 是否有可达的证据边。输入 relations 已过 current 收口
 * (triadic-data adaptRelationRows),这里只查方向与端点,不再自查边的状态词。
 */
export function decisionHasReachableEvidence(decision: DecisionRow, relations: ReadonlyArray<RelationEdge>): boolean {
  const claimRefs = new Set(decision.claims.map((claim) => `decision/${decision.decisionId}/${claim.id}`));
  return relations.some(
    (relation) =>
      relation.direction !== "undirected" &&
      claimRefs.has(relation.from) &&
      /^(?:fact|task|decision)\//u.test(relation.to),
  );
}

export type DecisionAction = "accept" | "reject" | "defer";

export interface DecisionMutationFeedback {
  readonly state: "pending" | "success" | "error";
  readonly kind: "propose" | DecisionAction;
  readonly opId: string;
  readonly code?: string;
  readonly origin?: string;
  readonly hint: string;
  readonly receipt?: Pick<ReceiptRecord, "consentId" | "path" | "commitSha" | "documentSha256" | "worktreeVisible">;
}

export function useDecisionActions(repoId: string) {
  const queryClient = useQueryClient();
  const locks = useRef(new Map<string, Promise<DecisionMutationFeedback>>());
  const pendingResolvers = useRef(new Map<string, (receipt: GuiActionResult) => Promise<DecisionMutationFeedback>>());
  const activeRepoId = useRef(repoId),
    emptyFeedback = useRef<ReadonlyMap<string, DecisionMutationFeedback>>(new Map()).current;
  activeRepoId.current = repoId;
  const [feedbackState, setFeedbackState] = useState<{
    readonly repoId: string;
    readonly values: ReadonlyMap<string, DecisionMutationFeedback>;
  }>({ repoId, values: new Map() });
  const feedback = feedbackState.repoId === repoId ? feedbackState.values : emptyFeedback;
  const publish = (key: string, value: DecisionMutationFeedback) => {
    if (activeRepoId.current === repoId)
      setFeedbackState((current) => ({
        repoId,
        values: new Map(current.repoId === repoId ? current.values : []).set(key, value),
      }));
    return value;
  };
  const operationKey = (key: string): string => `${repoId}:${key}`;
  const visibleReceipt = (receipt: ReceiptRecord): DecisionMutationFeedback["receipt"] => ({
    consentId: receipt.consentId,
    path: receipt.path,
    commitSha: receipt.commitSha,
    documentSha256: receipt.documentSha256,
    worktreeVisible: receipt.worktreeVisible,
  });
  const refresh = async (): Promise<void> => {
    // 一次失效覆盖全部三元切面(derives/摘要/事实/完整投影):挂载中的查询按
    // react-query 默认 refetchType:"active" 重取,没挂载的只标记 stale。
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: triadicQueryKeys.all(repoId) }),
      queryClient.invalidateQueries({ queryKey: workspaceSummaryQueryKeys.read(repoId) }),
    ]);
  };
  const failure = (key: string, kind: DecisionMutationFeedback["kind"], settlement: DecisionSettlement) =>
    publish(key, {
      state: settlement.state === "op_rejected" ? "error" : "pending",
      kind,
      opId: settlement.opId,
      ...(settlement.code ? { code: settlement.code } : {}),
      ...(settlement.origin ? { origin: settlement.origin } : {}),
      hint: settlement.hint ?? "canonical receipt 尚未 settled；不要重放 mutation。",
    });
  const once = (key: string, kind: DecisionMutationFeedback["kind"], run: () => Promise<DecisionMutationFeedback>) => {
    const scopedKey = operationKey(key),
      held = locks.current.get(scopedKey);
    if (held) return held;
    const promise = run().then(
      (result) => {
        if (result.state !== "pending") locks.current.delete(scopedKey);
        return result;
      },
      (error) => {
        locks.current.delete(scopedKey);
        return publish(key, {
          state: "error",
          kind,
          opId: "N/A",
          code: "bridge_error",
          hint: error instanceof Error ? error.message : String(error),
        });
      },
    );
    locks.current.set(scopedKey, promise);
    return promise;
  };
  const propose = (input: DecisionProposalInput) =>
    once("proposal", "propose", async () => {
      publish("proposal", {
        state: "pending",
        kind: "propose",
        opId: "awaiting-receipt",
        hint: "正在提交完整 proposal packet…",
      });
      const finish = async (settlement: DecisionSettlement): Promise<DecisionMutationFeedback> => {
        if (settlement.state !== "applied") {
          if (settlement.state === "pending")
            pendingResolvers.current.set(operationKey("proposal"), (receipt) => finish(settleDecisionReceipt(receipt)));
          return failure("proposal", "propose", settlement);
        }
        const decisionId = decisionIdFromEvidence(settlement.receipt.evidence);
        if (!decisionId)
          return publish("proposal", {
            state: "pending",
            kind: "propose",
            opId: settlement.opId,
            code: "projection_key_missing",
            hint: "receipt 已 applied 但未返回 decisionId；用 opId 查询，勿重放 mutation。",
          });
        // 回执已证 durable + canonicalVisible + committedRevision===appliedCut:失效后交给
        // 正常 refetch,不再强制整表重读并逐条扫描确认。
        await refresh();
        pendingResolvers.current.delete(operationKey("proposal"));
        return publish("proposal", {
          state: "success",
          kind: "propose",
          opId: settlement.opId,
          hint: `${decisionId} 已由 durable 回执确认落定。`,
          receipt: visibleReceipt(settlement.receipt),
        });
      };
      return finish(settleDecisionReceipt(await harnessClient.proposeDecision({ repoId, ...input })));
    });
  const judge = (
    decision: DecisionRow,
    action: DecisionAction,
    input: { readonly rationale: string; readonly judgmentOnlyRationale?: string },
  ) =>
    once(decision.decisionId, action, async () => {
      publish(decision.decisionId, {
        state: "pending",
        kind: action,
        opId: "awaiting-receipt",
        hint: `正在提交 ${action} rationale…`,
      });
      const initial =
        action === "accept"
          ? await harnessClient.acceptDecision({
              repoId,
              decisionId: decision.decisionId,
              rationale: input.rationale,
              ...(input.judgmentOnlyRationale ? { judgmentOnlyRationale: input.judgmentOnlyRationale } : {}),
            })
          : action === "reject"
            ? await harnessClient.rejectDecision({ repoId, decisionId: decision.decisionId, reason: input.rationale })
            : await harnessClient.deferDecision({ repoId, decisionId: decision.decisionId, reason: input.rationale });
      const finish = async (settlement: DecisionSettlement): Promise<DecisionMutationFeedback> => {
        if (settlement.state !== "applied") {
          if (settlement.state === "pending")
            pendingResolvers.current.set(operationKey(decision.decisionId), (receipt) =>
              finish(settleDecisionReceipt(receipt)),
            );
          return failure(decision.decisionId, action, settlement);
        }
        // 与 propose 同一条落定判据:回执三件套已证 canonical 落定,失效后交给正常 refetch。
        await refresh();
        pendingResolvers.current.delete(operationKey(decision.decisionId));
        return publish(decision.decisionId, {
          state: "success",
          kind: action,
          opId: settlement.opId,
          hint: "canonical decision + judgment consent 已由回执确认。",
          receipt: visibleReceipt(settlement.receipt),
        });
      };
      return finish(settleDecisionReceipt(initial));
    });
  const checkReceipt = async (key: string): Promise<DecisionMutationFeedback | undefined> => {
    const scopedKey = operationKey(key),
      current = feedback.get(key),
      resolve = pendingResolvers.current.get(scopedKey);
    if (!current || !resolve || current.state !== "pending" || current.opId === "awaiting-receipt") return current;
    publish(key, { ...current, hint: "正在执行 receipt-show；不会重放 mutation。" });
    try {
      const result = await resolve(await harnessClient.showReceipt({ repoId, opId: current.opId }));
      if (result.state !== "pending") locks.current.delete(scopedKey);
      return result;
    } catch (error) {
      consumeKnownError(error);
      locks.current.delete(scopedKey);
      return publish(key, {
        state: "error",
        kind: current.kind,
        opId: current.opId,
        code: "receipt_read_failed",
        hint: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return { feedback, propose, judge, checkReceipt };
}

function decisionIdFromEvidence(evidence: string | undefined): string | null {
  if (!evidence) return null;
  try {
    const value = JSON.parse(evidence) as { readonly decisionId?: unknown };
    return typeof value.decisionId === "string" ? value.decisionId : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

export type { DecisionProposalInput } from "./api-client.ts";
