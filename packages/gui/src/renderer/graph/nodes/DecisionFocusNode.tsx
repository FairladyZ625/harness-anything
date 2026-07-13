import { Handle, Position, type NodeProps } from "@xyflow/react";
import { COVERAGE_COLOR_VAR } from "../constants";
import { t } from "../../i18n/index.tsx";

/**
 * 聚焦态 decision 节点(dec_01KXA7811SVVT8P66HNDFZQ7DF CH2/CH5)。
 *
 * 把 decision 展开成 claim 行(CH/C/RJ),每行一个 coverage 灯
 * (covered 绿 / uncovered 红 / unknown 灰)+ claim id + 证据计数徽章。
 * 每行挂一对 `<Handle id="claim-CH1">` 让边锚到具体 claim,
 * 停止 graphLayout 旧版把 decision/dec_x/CH1 折叠成 decision/dec_x。
 */
interface ClaimRow {
  claimId: string;
  status: "covered" | "uncovered" | "unknown";
  evidenceCount: number;
  derivesCount: number;
  /**
   * 该 claim 可展开的 fact ref 列表(并集:coverageRows.coveringFactRef ∪
   * 直接 evidence 边的 factRef)。GraphView 的 onNodeClick 用 data-claim-id
   * 锚到具体 claim,只 toggle 该行 factRefs,不再批量 toggle 全部 claim。
   */
  factRefs?: string[];
}

interface FocusData {
  label: string;
  decisionId: string;
  state?: string;
  riskTier?: string;
  urgency?: string;
  question?: string;
  claimRows?: ClaimRow[];
  focus?: boolean;
}

const STATUS_TEXT: Record<ClaimRow["status"], string> = {
  get covered() { return t("graph.decisionFocusNode.corroborated"); },
  get uncovered() { return t("graph.decisionFocusNode.noEvidence"); },
  unknown: "",
};

export function DecisionFocusNode({ data, selected }: NodeProps) {
  const d = data as unknown as FocusData;
  const rows = d.claimRows ?? [];

  return (
    <div
      className="flex h-full w-full cursor-pointer flex-col box-border rounded-xl"
      style={{
        backgroundColor: "rgba(176, 124, 240, 0.05)",
        border: `2px solid ${selected ? "var(--color-accent)" : "var(--color-border-strong)"}`,
        boxShadow: selected ? "0 0 0 4px rgba(255,255,255,0.04)" : "none",
      }}
    >
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !min-w-2.5 !min-h-2.5 !border-0 !bg-[var(--color-axis-authority)]" />
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !min-w-2.5 !min-h-2.5 !border-0 !bg-[var(--color-axis-authority)]" />

      {/* Header */}
      <div className="px-3 pt-2.5 pb-2 border-b border-white/5">
        <div className="flex items-center gap-2 font-mono text-[10px] text-accent">
          <span className="text-[12px]">◆</span>
          <span>{d.decisionId}</span>
          {d.state && (
            <span className="ml-auto rounded bg-accent/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-accent">
              {d.state}
            </span>
          )}
        </div>
        <div className="text-[12px] font-semibold text-text mt-1 leading-snug line-clamp-2">
          {d.label}
        </div>
        {d.question && (
          <div className="text-[10px] text-text-faint mt-1 leading-snug line-clamp-2 italic">
            {d.question}
          </div>
        )}
      </div>

      {/* Claim rows */}
      <div className="flex-1 flex flex-col">
        {rows.length === 0 && (
          <div className="px-3 py-3 text-[11px] text-text-faint italic">
            {t("graph.decisionFocusNode.noClaimAnchorEmptyDecision")}</div>
        )}
        {rows.map((row) => {
          const covColor = COVERAGE_COLOR_VAR[row.status];
          const hasFacts = (row.factRefs?.length ?? 0) > 0;
          return (
            <div
              key={row.claimId}
              data-claim-id={row.claimId}
              className={`relative flex items-center gap-2 px-3 border-b border-white/5 last:border-b-0 ${
                hasFacts ? "cursor-pointer hover:bg-white/[0.03]" : ""
              }`}
              style={{ minHeight: 44 }}
              title={hasFacts ? t("graph.decisionFocusNode.clickSwitchCountPiecesEvidenceFact", { count: row.factRefs!.length }) : undefined}
            >
              {/* per-claim source/target handles — let edges anchor to a specific claim row */}
              <Handle
                id={`claim-${row.claimId}`}
                type="source"
                position={Position.Right}
                className="!absolute !right-0 !top-1/2 !h-2 !w-2 !min-h-2 !min-w-2 !-translate-y-1/2 !border-0"
                style={{ backgroundColor: "var(--color-axis-authority)" }}
              />
              <Handle
                id={`claim-${row.claimId}-in`}
                type="target"
                position={Position.Left}
                className="!absolute !left-0 !top-1/2 !h-2 !w-2 !min-h-2 !min-w-2 !-translate-y-1/2 !border-0"
                style={{ backgroundColor: "var(--color-axis-authority)" }}
              />
              <span
                title={row.status === "covered" ? t("graph.decisionFocusNode.corroborated") : row.status === "uncovered" ? t("graph.decisionFocusNode.noEvidenceRisk") : t("graph.decisionFocusNode.unknownCoverage")}
                className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                style={{
                  backgroundColor: covColor,
                  boxShadow: row.status === "uncovered" ? `0 0 0 3px rgba(229,85,92,0.18)` : "none",
                }}
              />
              <span className="font-mono text-[11px] font-bold text-text shrink-0">
                {row.claimId}
              </span>
              <span className="text-[10px] text-text-faint shrink-0">
                {STATUS_TEXT[row.status]}
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                {row.derivesCount > 0 && (
                  <span
                    title={t("graph.decisionFocusNode.derivesCountDerivedDependentEdges", { derivesCount: row.derivesCount })}
                    className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[9px] font-mono text-text-muted"
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-sm" style={{ backgroundColor: "var(--color-axis-execution)" }} />
                    {row.derivesCount}
                  </span>
                )}
                {row.evidenceCount > 0 && (
                  <span
                    title={t("graph.decisionFocusNode.evidenceCountEvidenceFact", { evidenceCount: row.evidenceCount })}
                    className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[9px] font-mono text-text-muted"
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "var(--color-axis-evidence)" }} />
                    {row.evidenceCount}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
