import type { DecisionRow } from "./types.ts";
import type { RelationCoverageRow } from "../../api/renderer-dto.ts";

/**
 * 风化(freshness)派生 —— 只消费 canonical coverageRows,不做第二次覆盖判定。
 *
 * 定义(dec_LEDGER_E37/E42,与 model/types.ts:191 的注释同源):承重 claim 沿
 * relation 可达的支撑 fact 为空 → 覆盖度不足 → 风化候选。canonical 判据就是
 * kernel `coverageOf` 投影出的 `status === "uncovered"`;本模块只做排序与归因
 * 分类,绝不沿 option evidence 自行猜覆盖(与 readiness-signals 同一纪律)。
 *
 * uncovered 的三种成因(status-word-register-domain 的登记语义):
 *   refuted                  —— 被活 fact 沿 refuted-by 反驳(最急:证据不止缺失,还在反向施压);
 *   no-live-evidence         —— 声明了 fulfillment 模式,但沿 relation 找不到满足该模式的证据;
 *   fulfillment-undeclared   —— claim 未声明 fulfillment(覆盖方式本身缺位)。
 */

export type FreshnessReason = "refuted" | "no-live-evidence" | "fulfillment-undeclared";

export interface FreshnessCandidate {
  readonly decisionId: string;
  readonly decisionTitle: string | null;
  readonly claimId: string;
  /** 来自 decision.claims 的原文 join;claim 不在投影行里时为 null(如实显示缺位)。 */
  readonly claimText: string | null;
  readonly reason: FreshnessReason;
  readonly fulfillment: RelationCoverageRow["fulfillment"];
  readonly refutingFactRefs: readonly string[];
}

const REASON_RANK: Record<FreshnessReason, number> = {
  refuted: 0,
  "no-live-evidence": 1,
  "fulfillment-undeclared": 2,
};

export function freshnessCandidates(
  decisions: ReadonlyArray<DecisionRow>,
  coverageRows: ReadonlyArray<RelationCoverageRow>,
): FreshnessCandidate[] {
  const byId = new Map(decisions.map((decision) => [decision.decisionId, decision]));
  return coverageRows
    .filter((row) => row.status === "uncovered")
    .map((row) => {
      const decisionId = row.decisionRef.replace(/^decision\//u, "");
      const decision = byId.get(decisionId) ?? null;
      // claimRef = `${decisionRef}/${claimId}`(decision-projection-coverage 的拼法);
      // 从 decisionRef 前缀之后截取,不假设 id 段内没有斜杠。
      const claimId = row.claimRef.startsWith(`${row.decisionRef}/`)
        ? row.claimRef.slice(row.decisionRef.length + 1)
        : row.claimRef;
      const claim = decision?.claims.find((candidate) => candidate.id === claimId) ?? null;
      return {
        decisionId,
        decisionTitle: decision?.title ?? null,
        claimId,
        claimText: claim?.text ?? null,
        reason: reasonOf(row),
        fulfillment: row.fulfillment,
        refutingFactRefs: row.refutingFactRefs ?? [],
      };
    })
    .sort(
      (left, right) =>
        REASON_RANK[left.reason] - REASON_RANK[right.reason] ||
        left.decisionId.localeCompare(right.decisionId) ||
        left.claimId.localeCompare(right.claimId),
    );
}

function reasonOf(row: RelationCoverageRow): FreshnessReason {
  if ((row.refutingFactRefs ?? []).length > 0) return "refuted";
  if (row.fulfillment === null) return "fulfillment-undeclared";
  return "no-live-evidence";
}
