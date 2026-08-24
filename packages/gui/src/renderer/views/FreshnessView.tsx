import { useMemo, useState } from "react";
import { HourglassMedium } from "@phosphor-icons/react";
import type { DecisionRow } from "../model/types";
import type { RelationCoverageRow } from "../../api/renderer-dto.ts";
import { freshnessCandidates, type FreshnessCandidate, type FreshnessReason } from "../model/freshness.ts";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { StreamBody, StreamEmpty } from "../components/overview/streamParts.tsx";
import { t } from "../i18n/index.tsx";

/**
 * 风化视图(O-08):全仓「承重 claim 失去可达支撑」的聚合列表。
 * 数据只来自 canonical coverageRows(App 级 triadic 投影),判据见 model/freshness.ts。
 * 行集规模随 decisions × claims 增长,照抄 TaskStream 的 ROW_BATCH_SIZE 分批约定:
 * 被推迟的行由批量按钮报出剩余数,标题报出真实总数,不许静默截断。
 */
const ROW_BATCH_SIZE = 12;

const REASON_CLASS: Record<FreshnessReason, string> = {
  refuted: "border-danger/50 bg-danger/10 text-danger",
  "no-live-evidence": "border-stale/50 bg-stale/10 text-stale",
  "fulfillment-undeclared": "border-border bg-surface-raised text-text-muted",
};

function ReasonBadge({ reason }: { reason: FreshnessReason }) {
  return (
    <span
      data-testid={`freshness-reason-${reason}`}
      className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] ${REASON_CLASS[reason]}`}
    >
      {t(`views.freshnessView.reason.${reason}`)}
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
  return (
    <div
      data-testid="freshness-row"
      className="flex w-full items-start gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-left"
    >
      <ReasonBadge reason={candidate.reason} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-text" title={candidate.claimText ?? candidate.claimId}>
          <span className="font-mono text-[11px] text-text-faint">{candidate.claimId} </span>
          {candidate.claimText ?? t("views.freshnessView.claimMissing")}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1 font-mono text-[11px] text-text-faint">
          <EntityRefLink
            entityRef={`decision/${candidate.decisionId}`}
            onNavigate={onNavigateEntity}
            title={candidate.decisionTitle ?? candidate.decisionId}
          >
            {candidate.decisionId}
          </EntityRefLink>
          {candidate.decisionTitle && <span className="font-sans">{candidate.decisionTitle}</span>}
          {candidate.refutingFactRefs.length > 0 && (
            <span className="ml-2">
              {t("views.freshnessView.refutedBy", { count: candidate.refutingFactRefs.length })}{" "}
              {candidate.refutingFactRefs.map((ref) => (
                <EntityRefLink key={ref} entityRef={ref} onNavigate={onNavigateEntity} className="mr-1" />
              ))}
            </span>
          )}
        </p>
      </div>
    </div>
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
  const [visible, setVisible] = useState(ROW_BATCH_SIZE);
  const shown = candidates.slice(0, visible);
  const hidden = candidates.length - shown.length;
  const decisionsInvolved = new Set(candidates.map((candidate) => candidate.decisionId)).size;
  const basis = basisRevisionOf(coverageRows);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="freshness-view">
      <header className="shrink-0 border-b border-border bg-surface/40 px-5 py-4">
        <div className="flex items-baseline gap-2">
          <HourglassMedium weight="duotone" className="self-center text-text-muted" />
          <h1 className="ui-title font-mono font-semibold">{t("views.freshnessView.title")}</h1>
          <span className="font-mono text-[12px] text-text-faint" data-testid="freshness-counts">
            {t("views.freshnessView.counts", {
              uncovered: candidates.length,
              total: coverageRows.length,
              decisions: decisionsInvolved,
            })}
          </span>
          {basis !== null && (
            <span className="ml-auto shrink-0 font-mono text-[12px] text-text-faint">
              {t("views.freshnessView.basis", { value: basis })}
            </span>
          )}
        </div>
        <p className="mt-1 text-[12px] text-text-muted">{t("views.freshnessView.tagline")}</p>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-5">
        {relationState === "loading" ? (
          <StreamEmpty>{t("views.freshnessView.loading")}</StreamEmpty>
        ) : relationState === "error" ? (
          <StreamEmpty>{t("views.freshnessView.error")}</StreamEmpty>
        ) : candidates.length === 0 ? (
          // 空态必须是明确的「没有风化」,不是空白页;与加载/错误态分开,不冒充。
          <StreamEmpty>{t("views.freshnessView.empty")}</StreamEmpty>
        ) : (
          <StreamBody testId="freshness-rows">
            {shown.map((candidate) => (
              <FreshnessRow key={`${candidate.decisionId}/${candidate.claimId}`} candidate={candidate} onNavigateEntity={onNavigateEntity} />
            ))}
            {hidden > 0 && (
              <button
                type="button"
                data-testid="freshness-more"
                onClick={() => setVisible((count) => Math.min(count + ROW_BATCH_SIZE, candidates.length))}
                className="w-full px-1 py-1 text-center font-mono text-[11px] text-text-muted hover:text-text"
              >
                {t("views.freshnessView.showMore", {
                  count: Math.min(ROW_BATCH_SIZE, hidden),
                  remaining: hidden,
                })}
              </button>
            )}
          </StreamBody>
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
