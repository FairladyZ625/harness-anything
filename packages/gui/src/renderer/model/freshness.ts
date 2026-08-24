import type { DecisionRow } from "./types.ts";
import type { FreshnessReason, RelationCoverageRow } from "../../api/renderer-dto.ts";

/**
 * 风化(freshness)派生 —— 纯展示消费者:只消费 canonical coverageRows 与 daemon 读面
 * 附带的 uncovered 成因分类,本模块不做任何覆盖判定。
 *
 * 定义(dec_LEDGER_E37/E42,与 model/types.ts:191 的注释同源):承重 claim 沿
 * relation 可达的支撑 fact 为空 → 覆盖度不足 → 风化候选。「哪些行算 uncovered」
 * 以及成因(refuted / no-live-evidence / fulfillment-undeclared)全部由 kernel 域
 * 单点判定(kernel `freshnessReasonOf`),经 relation graph 读面以 optional
 * `freshnessReason` 字段送达;无该字段的行(covered 行、旧 daemon)一律不进候选,
 * renderer 不沿 option evidence 自行猜覆盖(与 readiness-signals 同一纪律)。
 */

export type { FreshnessReason };

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
    .filter(
      (row): row is RelationCoverageRow & { freshnessReason: FreshnessReason } =>
        row.freshnessReason !== undefined,
    )
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
        reason: row.freshnessReason,
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
