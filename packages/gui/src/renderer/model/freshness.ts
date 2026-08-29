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
 *
 * 生命周期终态过滤(泽宇 2026-08-29 亲裁):decision.state 为
 * rejected/superseded/outcome_retired/deferred 的决策已经离开了"等待补齐"的轨道——
 * 它们的承重 claim 覆盖与否不代表补齐债,排除出风化候选与总数分母,只统计
 * in_effect/proposed 这两个可行动状态。这不是覆盖判定(covered/uncovered/成因仍完全
 * 由 kernel 给出),只是"这条决策还算不算债"的生命周期范围过滤,单点定义在本模块;
 * decision 在 join 时缺位(理论上不应发生)时保留该行,不猜它的状态。
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

/** 仍在"未覆盖债"统计范围内的决策状态——生命周期终态不再等待补齐。 */
const DEBT_SCOPE_DECISION_STATES: ReadonlySet<DecisionRow["state"]> = new Set(["in_effect", "proposed"]);

function decisionOf(byId: ReadonlyMap<string, DecisionRow>, decisionRef: string): DecisionRow | null {
  return byId.get(decisionRef.replace(/^decision\//u, "")) ?? null;
}

/**
 * 承重覆盖行里,decision 仍处于可行动状态(in_effect/proposed)的子集——
 * {@link freshnessCandidates} 与风化面板的总数分母共用同一口径,避免分子排除了
 * 终态债、分母却仍把它们算进"总承重 claim 数"而让比例失真。
 */
export function inDebtScopeCoverageRows(
  decisions: ReadonlyArray<DecisionRow>,
  coverageRows: ReadonlyArray<RelationCoverageRow>,
): RelationCoverageRow[] {
  const byId = new Map(decisions.map((decision) => [decision.decisionId, decision]));
  return coverageRows.filter((row) => {
    const decision = decisionOf(byId, row.decisionRef);
    return decision === null || DEBT_SCOPE_DECISION_STATES.has(decision.state);
  });
}

export function freshnessCandidates(
  decisions: ReadonlyArray<DecisionRow>,
  coverageRows: ReadonlyArray<RelationCoverageRow>,
): FreshnessCandidate[] {
  const byId = new Map(decisions.map((decision) => [decision.decisionId, decision]));
  return inDebtScopeCoverageRows(decisions, coverageRows)
    .filter(
      (row): row is RelationCoverageRow & { freshnessReason: FreshnessReason } => row.freshnessReason !== undefined,
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
