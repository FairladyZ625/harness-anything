import { useMemo } from "react";
import type { ReactNode } from "react";
import type { DecisionRow } from "../model/types";
import type { RelationCoverageRow } from "../../api/renderer-dto.ts";
import {
  freshnessCandidates,
  inDebtScopeCoverageRows,
  type FreshnessCandidate,
  type FreshnessReason,
} from "../model/freshness.ts";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { Section } from "../components/primitives/Section.tsx";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag.tsx";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { t } from "../i18n/index.tsx";

/**
 * 决策失真预警视图(原 O-08 风化视图):回答「哪些记录已经和现实对不上」。候选按
 * 严重度分三档——被事实反驳(必须处置,warn 区)、缺少事实支撑(建议补证)、从未
 * 声明验证方式(自然老化);行用 DenseRow + 有底色状态标签,点决策 id 直达。数据只
 * 来自 canonical coverageRows,判据见 model/freshness.ts。完整渲染,不分批
 * (2026-08-25 泽宇裁决:性能顾虑用按需渲染解决,不转嫁给用户点击):每行带
 * content-visibility:auto,离屏行的布局与绘制由渲染器跳过;标题报出真实总数。
 * 计数范围只含 decision.state ∈ {in_effect, proposed}(2026-08-29 泽宇裁决):
 * 生命周期终态(rejected/superseded/outcome_retired/deferred)不算未覆盖债,
 * 分子分母同一口径,见 model/freshness.ts 的 inDebtScopeCoverageRows。
 */

/** 分档展示顺序与 model/freshness.ts 的 REASON_RANK 一致:最危险的排最前。 */
const SECTION_ORDER: readonly FreshnessReason[] = ["refuted", "no-live-evidence", "fulfillment-undeclared"];

/** 成因 → 状态色档(标准 §3):反驳=红,缺证=琥珀,自然老化=灰蓝。 */
const REASON_TONE: Record<FreshnessReason, StatusTone> = {
  refuted: "bad",
  "no-live-evidence": "wait",
  "fulfillment-undeclared": "plan",
};

function ReasonTag({ reason }: { reason: FreshnessReason }) {
  return (
    <span data-testid={`freshness-reason-${reason}`}>
      <StatusTag tone={REASON_TONE[reason]} label={t(`views.freshnessView.reason.${reason}`)} />
    </span>
  );
}

function FreshnessRow({
  candidate,
  onNavigateEntity,
}: {
  candidate: FreshnessCandidate;
  onNavigateEntity: (ref: string) => void;
}) {
  const decisionRef = `decision/${candidate.decisionId}`,
    meta: ReactNode[] = [
      <EntityRefLink
        key="decision"
        entityRef={decisionRef}
        onNavigate={onNavigateEntity}
        title={candidate.decisionTitle ?? candidate.decisionId}
      >
        {candidate.decisionId}
      </EntityRefLink>,
    ];
  if (candidate.decisionTitle) meta.push(<span key="title">{candidate.decisionTitle}</span>);
  for (const ref of candidate.refutingFactRefs) {
    meta.push(
      <EntityRefLink key={ref} entityRef={ref} onNavigate={onNavigateEntity}>
        {ref}
      </EntityRefLink>,
    );
  }
  return (
    <div data-testid="freshness-row" className="cv-auto-3r">
      <DenseRow
        tag={<ReasonTag reason={candidate.reason} />}
        title={candidate.claimText ?? t("views.freshnessView.claimMissing")}
        reason={
          <span className="flex flex-wrap items-center gap-x-2">
            {meta.map((node, index) => (
              <span key={index} className="flex items-center gap-x-2">
                {index > 0 ? <span aria-hidden>·</span> : null}
                {node}
              </span>
            ))}
          </span>
        }
        time={candidate.claimId}
      />
    </div>
  );
}

/** 加载/错误/一切正常:一条细状态行,不画大框(标准 §1.5 空了就消失)。 */
function StatusLine({ tone, label, children }: { tone: StatusTone; label: string; children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 py-2 text-text-faint ui-body" data-testid="freshness-status-line">
      <StatusTag tone={tone} label={label} />
      {children}
    </p>
  );
}

export function FreshnessView({
  decisions,
  coverageRows,
  relationState = "ready",
  onNavigateEntity,
}: {
  decisions: ReadonlyArray<DecisionRow>;
  coverageRows: ReadonlyArray<RelationCoverageRow>;
  relationState?: "ready" | "loading" | "error";
  onNavigateEntity: (ref: string) => void;
}) {
  const candidates = useMemo(() => freshnessCandidates(decisions, coverageRows), [decisions, coverageRows]);
  // 分母与候选同一口径(in_effect/proposed):生命周期终态的承重 claim 既不算未覆盖债,
  // 也不该仍算进"总承重 claim 数"——否则排除了分子却不排除分母,比例失真。
  const inScopeTotal = useMemo(
    () => inDebtScopeCoverageRows(decisions, coverageRows).length,
    [decisions, coverageRows],
  );
  const decisionsInvolved = new Set(candidates.map((candidate) => candidate.decisionId)).size;
  const basis = basisRevisionOf(coverageRows);
  const byReason = useMemo(() => {
    const groups = new Map<FreshnessReason, FreshnessCandidate[]>();
    for (const candidate of candidates) {
      const bucket = groups.get(candidate.reason);
      if (bucket) bucket.push(candidate);
      else groups.set(candidate.reason, [candidate]);
    }
    return groups;
  }, [candidates]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="freshness-view">
      <header className="shrink-0 border-b border-border px-5 py-3.5 md:px-7">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h1 className="text-[19px] font-semibold text-text">{t("views.freshnessView.title")}</h1>
          <span className="ui-meta text-text-muted" data-testid="freshness-counts">
            {t("views.freshnessView.counts", {
              uncovered: candidates.length,
              total: inScopeTotal,
              decisions: decisionsInvolved,
            })}
          </span>
          {basis !== null && (
            <span className="ml-auto shrink-0 font-mono ui-meta text-text-faint">
              {t("views.freshnessView.basis", { value: basis })}
            </span>
          )}
        </div>
        <p className="mt-1 ui-meta text-text-muted">{t("views.freshnessView.tagline")}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-4 md:px-7">
        {relationState === "loading" ? (
          <StatusLine tone="plan" label={t("views.freshnessView.statusLoading")}>
            {t("views.freshnessView.loading")}
          </StatusLine>
        ) : relationState === "error" ? (
          <StatusLine tone="bad" label={t("views.freshnessView.statusError")}>
            {t("views.freshnessView.error")}
          </StatusLine>
        ) : candidates.length === 0 ? (
          // 空态必须是明确的「没有待处置项」,不是空白页;与加载/错误态分开,不冒充。
          <StatusLine tone="done" label={t("views.freshnessView.statusOk")}>
            {t("views.freshnessView.empty")}
          </StatusLine>
        ) : (
          <div data-testid="freshness-rows" className="max-w-[1100px]">
            {SECTION_ORDER.map((reason) => {
              const group = byReason.get(reason);
              if (!group || group.length === 0) return null;
              return (
                <Section
                  key={reason}
                  variant={reason === "refuted" ? "warn" : undefined}
                  title={t(`views.freshnessView.section.${reason}.title`)}
                  count={group.length}
                  note={t(`views.freshnessView.section.${reason}.description`)}
                >
                  {group.map((candidate) => (
                    <FreshnessRow
                      key={`${candidate.decisionId}/${candidate.claimId}`}
                      candidate={candidate}
                      onNavigateEntity={onNavigateEntity}
                    />
                  ))}
                </Section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** 与 readiness-signals 的 basisSummary 同一纪律:报出判据所基于的投影修订号。 */
function basisRevisionOf(rows: ReadonlyArray<RelationCoverageRow>): number | null {
  const revisions = [...new Set(rows.flatMap((row) => (row.basisRevision === undefined ? [] : [row.basisRevision])))];
  return revisions.length === 1 ? revisions[0] : null;
}
