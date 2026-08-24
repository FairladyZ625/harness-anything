import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CaretRight,
  CirclesFour,
  FileText,
  LinkSimple,
  SealCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { DecisionStateBadge, RiskTierBadge, UrgencyBadge } from "../badges.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { localDateTime } from "../../model/local-time.ts";
import type { DecisionRow, RelationEdge, TaskRow } from "../../model/types.ts";
import { t } from "../../i18n/index.tsx";
import { DecisionBodyPanel } from "./DecisionBodyPanel.tsx";
import { ClaimsPanel, OverviewPanel, RelationsPanel } from "./DecisionDetailSections.tsx";
import { ActorRef, actorsLabel, IdentityItem } from "./widgets.tsx";

/**
 * 决策详情页(与 Task 详情同级的信息架构:身份条 + 分页签)。
 * 列表读面(repo.decisions.list)从不携带正文——kernel 列表路径显式 body:null,
 * 所以正文按决策逐条经 decision-show(includeBody)取回,一次一份,规模天然有界。
 * 取不到时逐态说明原因(加载/投影追赶/未投影/读取失败),绝不静默留白。
 */

const tabs = [
  { id: "body", label: "views.decisionDetailView.tabBody", icon: FileText },
  {
    id: "overview",
    label: "views.decisionDetailView.tabOverview",
    icon: CirclesFour,
  },
  {
    id: "claims",
    label: "views.decisionDetailView.tabClaims",
    icon: SealCheck,
  },
  {
    id: "relations",
    label: "views.decisionDetailView.tabRelations",
    icon: LinkSimple,
  },
] as const;

type DecisionDetailTab = (typeof tabs)[number]["id"];

export function DecisionDetailView({
  repoId,
  decisionId,
  decisions,
  tasks = [],
  relations = [],
  loading,
  onBack,
  projectName,
  fromViewLabel,
  onNavigateDecision,
  onNavigateTask,
  onNavigateEntity,
  onFocusGraph,
  onOpenPool,
}: {
  repoId: string;
  decisionId: string | null;
  decisions: DecisionRow[];
  tasks?: TaskRow[];
  relations?: RelationEdge[];
  loading: boolean;
  onBack: () => void;
  projectName: string;
  fromViewLabel?: string;
  onNavigateDecision: (decisionId: string) => void;
  onNavigateTask?: (taskId: string) => void;
  onNavigateEntity: (ref: string) => void;
  onFocusGraph?: (ref: string) => void;
  onOpenPool?: (decisionId: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<DecisionDetailTab>("body");
  useEffect(() => {
    setActiveTab("body");
  }, [decisionId]);

  const decision = useMemo(
    () => decisions.find((row) => row.decisionId === decisionId) ?? null,
    [decisions, decisionId],
  );

  if (!decision) {
    return (
      <aside data-testid="decision-detail-pending" className="flex h-full flex-col items-start gap-3 px-4 py-6">
        {loading ? (
          <p className="font-mono text-[12px] text-text-faint">{t("views.entityDetail.loadingProjection")}</p>
        ) : (
          <>
            <div className="flex items-center gap-1 text-[12px] font-semibold text-stale">
              <WarningCircle weight="bold" />
              {t("views.entityDetail.notProjected")}
            </div>
            <div className="font-mono text-[11px] text-text-faint">{decisionId ?? "—"}</div>
          </>
        )}
      </aside>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="decision-detail-view">
      <header className="shrink-0 border-b border-border bg-surface/80" data-testid="decision-detail-header">
        <div className="flex min-h-14 items-center gap-2.5 px-3 py-2 lg:px-4">
          <button
            type="button"
            onClick={onBack}
            aria-label={t("views.taskDetailView.returnPreviousLevel")}
            className={[
              "grid size-7 shrink-0 place-items-center rounded-md border border-border text-text-muted",
              "hover:border-border-strong hover:bg-surface-raised hover:text-text",
            ].join(" ")}
          >
            <ArrowLeft weight="bold" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1 font-mono text-[9px] leading-3 text-text-faint">
              <button type="button" onClick={onBack} className="truncate hover:text-text-muted">
                {projectName}
              </button>
              <CaretRight weight="bold" className="shrink-0" />
              {fromViewLabel && (
                <>
                  <button type="button" onClick={onBack} className="truncate hover:text-text-muted">
                    {fromViewLabel}
                  </button>
                  <CaretRight weight="bold" className="shrink-0" />
                </>
              )}
              <EntityRefLink
                entityRef={`decision/${decision.decisionId}`}
                onNavigate={onNavigateEntity}
                title={decision.decisionId}
                className="truncate font-mono text-[9px] leading-3 text-text-muted hover:text-accent hover:underline"
              />
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <h1 className="truncate text-[16px] font-semibold leading-5 tracking-[-0.01em] text-text">
                {decision.title}
              </h1>
              <DecisionStateBadge state={decision.state} />
              <RiskTierBadge tier={decision.riskTier} />
              <UrgencyBadge urgency={decision.urgency} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onOpenPool && (
              <button
                type="button"
                onClick={() => onOpenPool(decision.decisionId)}
                className={[
                  "rounded-md border border-border px-2 py-1.5 font-mono text-[10px] text-text-muted",
                  "hover:border-border-strong hover:bg-surface-raised hover:text-text",
                ].join(" ")}
              >
                {t("views.decisionDetailView.openInPool")}
              </button>
            )}
            {onFocusGraph && (
              <button
                type="button"
                onClick={() => onFocusGraph(`decision/${decision.decisionId}`)}
                className={[
                  "rounded-md border border-border px-2 py-1.5 font-mono text-[10px] text-text-muted",
                  "hover:border-border-strong hover:bg-surface-raised hover:text-text",
                ].join(" ")}
              >
                {t("views.decisionDetailView.focusGraph")}
              </button>
            )}
          </div>
        </div>
        <details className="group relative z-30">
          <summary
            className={[
              "list-none cursor-pointer border-t border-border px-3 py-1.5 font-mono text-[10px]",
              "text-text-faint hover:text-text-muted [&::-webkit-details-marker]:hidden lg:px-4",
            ].join(" ")}
          >
            {t("views.decisionDetailView.identity")}
          </summary>
          <dl
            data-testid="decision-identity-strip"
            className="grid w-full grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3 lg:grid-cols-6"
          >
            <IdentityItem
              label={t("views.decisionDetailView.identityDecision")}
              value={decision.legacyId ? `${decision.decisionId} · ${decision.legacyId}` : decision.decisionId}
              onClick={() => onNavigateEntity(`decision/${decision.decisionId}`)}
            />
            <IdentityItem
              label={t("views.decisionDetailView.identityVertical")}
              value={`${decision.vertical ?? "—"} · ${decision.preset ?? "—"}`}
            />
            <IdentityItem
              label={t("views.decisionDetailView.identityScope")}
              value={`${decision.appliesTo?.modules.join(",") || "—"} · ${
                decision.appliesTo?.productLines.join(",") || "—"
              }`}
            />
            <IdentityItem
              label={t("views.decisionDetailView.identityActors")}
              value={actorsLabel(decision)}
              content={
                <span className="flex flex-wrap items-center gap-x-1.5">
                  <ActorRef actor={decision.proposedBy} onNavigateEntity={onNavigateEntity} />
                  <span className="text-text-faint">·</span>
                  <ActorRef actor={decision.arbiter ?? null} onNavigateEntity={onNavigateEntity} />
                </span>
              }
            />
            <IdentityItem
              label={t("views.decisionDetailView.identityTimeline")}
              value={`${localDateTime(decision.proposedAt ?? "") ?? "—"} · ${
                localDateTime(decision.decidedAt ?? "") ?? "—"
              }`}
            />
            <IdentityItem
              label={t("views.decisionDetailView.identityClass")}
              value={`${decision.decisionClass ?? "—"} · rev ${decision.workspaceRevision ?? "—"}`}
            />
          </dl>
        </details>
      </header>

      <nav
        role="tablist"
        aria-label="Decision 详情分区"
        className="flex h-8 shrink-0 overflow-x-auto border-b border-border bg-surface px-2 sm:px-3"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon,
            active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`decision-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`decision-panel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={[
                "relative flex h-8 shrink-0 items-center gap-1 px-2 text-[11px] font-medium",
                active ? "text-text" : "text-text-faint hover:text-text-muted",
              ].join(" ")}
            >
              <Icon weight={active ? "bold" : "regular"} className="text-[12px]" />
              {t(tab.label)}
              {active ? <span className="absolute inset-x-2 bottom-0 h-0.5 bg-accent" /> : null}
            </button>
          );
        })}
      </nav>

      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4">
        <div className="mx-auto h-full w-full max-w-[72rem]">
          <section
            id={`decision-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`decision-tab-${activeTab}`}
            className="min-h-0"
            data-testid={`decision-panel-${activeTab}`}
          >
            {activeTab === "body" ? (
              <DecisionBodyPanel repoId={repoId} decisionId={decision.decisionId} />
            ) : activeTab === "overview" ? (
              <OverviewPanel decision={decision} />
            ) : activeTab === "claims" ? (
              <ClaimsPanel decision={decision} />
            ) : (
              <RelationsPanel
                decision={decision}
                tasks={tasks}
                relations={relations}
                onNavigateDecision={onNavigateDecision}
                onNavigateTask={onNavigateTask}
                onNavigateEntity={onNavigateEntity}
              />
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
