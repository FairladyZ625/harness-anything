import type { DecisionRow } from "../model/types";
import type { RelationCoverageRow } from "../../api/renderer-dto.ts";
import type { ClaimCoverageInfo } from "./graphLayoutTypes";

export type ClaimFulfillmentMode = "evidenced" | "delivered" | "standing-policy";

/**
 * Normalize a coverage-row fulfillment into the three declared modes.
 * Missing / unexpected values fall back to "evidenced" (the kernel default
 * when a claim package leaves fulfillment undeclared) so the GUI never paints
 * a phantom fourth mode.
 */
export function normalizeClaimFulfillment(
  value: string | undefined | null,
): ClaimFulfillmentMode {
  if (value === "delivered" || value === "standing-policy" || value === "evidenced") {
    return value;
  }
  return "evidenced";
}

/**
 * 计算 decision 的 claim 覆盖信息。
 *
 * 优先用 coverageRows(kernel 给的最准);若上游没传(App.tsx 不向 GraphView 透传 coverageRows,
 * 但 triadic-data.adaptDecisionRows 已把 coveringFactRef 写进 decision.chosen/rejected[].evidence),
 * 退化到从 DecisionClaim.evidence 反推 — 有证据即 covered,无证据即 uncovered。
 * 这样布局器对 coverageRows 入参不做强依赖,GraphView 不需要改 App.tsx 调用面。
 *
 * fulfillment 三形态(evidenced / delivered / standing-policy)只来自 coverageRows
 * (kernel 投影).Path B 缺 coverageRows 时保持 "unknown",不把 evidence 有无误判成
 * 兑现形态 — 图例 / claim 灯把 unknown 画成灰占位,等投影到位再分色。
 */
export function computeClaimCoverage(
  decision: DecisionRow,
  coverageRows: ReadonlyArray<RelationCoverageRow> | undefined,
): ClaimCoverageInfo[] {
  const byClaim = new Map<string, ClaimCoverageInfo>();
  for (const claim of decision.claims) {
    byClaim.set(claim.id, {
      claimId: claim.id,
      status: "unknown",
      fulfillment: "unknown",
      evidenceFacts: [],
    });
  }

  // Path A: coverageRows 优先(状态最准,fulfillment 也只从这里来)。
  if (coverageRows && coverageRows.length > 0) {
    const decisionRef = `decision/${decision.decisionId}`;
    for (const row of coverageRows) {
      if (row.decisionRef !== decisionRef) continue;
      const claimId = row.claimRef.split("/")[2];
      if (!claimId) continue;
      const info = byClaim.get(claimId);
      if (!info) continue;
      // 多条 coverage row 取最严状态(uncovered 优先),并合并佐证 fact。
      if (row.status === "uncovered") info.status = "uncovered";
      else if (row.status === "covered" && info.status !== "uncovered") info.status = "covered";
      // Fulfillment: once Path A has spoken, record the mode. Prefer the first
      // non-default mode if multiple rows race (rare — one row per claim).
      if (info.fulfillment === "unknown") {
        info.fulfillment = normalizeClaimFulfillment(row.fulfillment);
      } else if (row.fulfillment && row.fulfillment !== "evidenced" && info.fulfillment === "evidenced") {
        info.fulfillment = normalizeClaimFulfillment(row.fulfillment);
      }
      if (row.coveringFactRef) {
        info.evidenceFacts = [...new Set([...info.evidenceFacts, row.coveringFactRef])];
      }
    }
  }

  // Path B: 退化到 DecisionClaim.evidence (chosen/rejected),补全 status / evidenceFacts。
  // 适 App.tsx 未透传 coverageRows 的场景(GraphView 只拿到 decisions + relations + facts)。
  // 注意:decision.claims 是 {id,text} 列表(全集),chosen/rejected 才有 evidence —
  // 所以先按 id 建索引,再遍历全集 claims 给没有 evidence 的 claim 标 uncovered。
  // 修 #10:此前 Path B 在 evidence 为空时把 unknown 直接翻成 uncovered,把
  // coverageRows 缺失/loading 误当成「确认风险」。现在 Path B 只升级 unknown→covered
  // (有 evidence 时);无证据则保持 unknown,等 coverageRows 到位后再由 Path A
  // 拍板。Path A 的 uncovered 判定保持原义(kernel 已计算 = 真风险)。
  // Path B 不碰 fulfillment — evidence 有无不能推断兑现形态。
  const evidenceById = new Map<string, string[]>();
  for (const claim of [...decision.chosen, ...decision.rejected]) {
    evidenceById.set(claim.id, claim.evidence);
  }
  for (const claim of decision.claims) {
    const info = byClaim.get(claim.id);
    if (!info) continue;
    const evidence = evidenceById.get(claim.id) ?? [];
    if (evidence.length > 0) {
      info.evidenceFacts = [...new Set([...info.evidenceFacts, ...evidence])];
      if (info.status === "unknown") info.status = "covered";
    }
    // evidence 为空且 Path A 未触 → 保持 unknown (loading/缺数据),不再误降为 uncovered。
  }

  return [...byClaim.values()];
}
