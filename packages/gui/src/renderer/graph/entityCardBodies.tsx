import { CloseoutBadge, EngineBadge, FreshnessTag } from "../components/badges";
import { StatusTag } from "../components/primitives/StatusTag";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import type { AgentNodeRow, ScheduleNodeRow } from "./runtimeEntities";
import type { DecisionRow, FactRef, TaskRow } from "../model/types";
import { isExternal } from "../model/types";
import { t } from "../i18n/index.tsx";

/**
 * ego 节点原位展开卡片的实体摘要体(task_baca8e2b3e32c288fbd14b71f0)。
 *
 * 单一实现:卡片正文只在这里,关系抽屉(GraphDrawer)自图场景恢复原位展开后不再
 * 承载节点正文(边信息才是它的职责)——同一实体的正文永远只出现在一处。
 * i18n 键沿用 graph.graphDrawer.* 命名(抽屉时代的名字,值随卡片走)。
 */

export function EgoTaskSummaryBody({ task }: { task: TaskRow }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusTag status={task.coordinationStatus} />
        <CloseoutBadge value={task.closeoutReadiness} />
        <EngineBadge engine={task.engine} locked={isExternal(task)} />
      </div>
      <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
      <div className="flex gap-3 font-mono ui-micro text-text-muted">
        <span>{t("graph.graphDrawer.rawValue", { raw: task.rawStatus })}</span>
      </div>
      {(task.riskTier || task.urgency) && (
        <div className="font-mono ui-micro text-text-muted">
          {t("graph.graphDrawer.riskUrgency", {
            risk: task.riskTier ?? t("graph.graphDrawer.unknown"),
            urgency: task.urgency ?? t("graph.graphDrawer.unknown"),
          })}
        </div>
      )}
    </>
  );
}

export function EgoDecisionSummaryBody({ decision }: { decision: DecisionRow }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 font-mono ui-micro">
        <span className="rounded bg-accent px-1.5 py-0.5 text-accent-fg">{decision.state}</span>
        <span className="text-text-muted">
          {t("graph.graphDrawer.riskUrgency", {
            risk: decision.riskTier ?? t("graph.graphDrawer.unknown"),
            urgency: decision.urgency ?? t("graph.graphDrawer.unknown"),
          })}
        </span>
      </div>
      {decision.question && (
        <div className="rounded-md border border-border bg-surface-raised px-2 py-1.5">
          <span className="ui-micro font-mono uppercase tracking-wide text-text-faint">
            {t("graph.graphDrawer.question")}
          </span>
          <p className="ui-meta mt-0.5 font-medium text-text">{decision.question}</p>
        </div>
      )}
      {decision.chosen?.length > 0 && (
        <div className="rounded-md border border-accent/30 bg-accent-fg/5 px-2 py-1.5">
          <span className="ui-micro font-mono uppercase tracking-wide text-accent">
            {t("graph.graphDrawer.chosen")}
          </span>
          <div className="mt-0.5 flex flex-col gap-1">
            {decision.chosen.map((claim) => (
              <p key={claim.id} className="ui-meta text-text">
                {claim.text}
              </p>
            ))}
          </div>
        </div>
      )}
      {decision.rejected?.length > 0 && (
        <div className="rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5">
          <span className="ui-micro font-mono uppercase tracking-wide text-danger">
            {t("graph.graphDrawer.rejected")}
          </span>
          <div className="mt-0.5 flex flex-col gap-1">
            {decision.rejected.map((claim) => (
              <div key={claim.id} className="text-text-muted">
                <p className="ui-meta">{claim.text}</p>
                {claim.whyNot && <p className="ui-micro mt-0.5 leading-snug text-text-faint">↳ {claim.whyNot}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
      {decision.claims && decision.claims.length > 0 && (
        <div className="rounded-md border border-border bg-surface-raised px-2 py-1.5">
          <span className="ui-micro font-mono uppercase tracking-wide text-text-faint">
            {t("graph.graphDrawer.claims")}
          </span>
          <ul className="list-inside list-disc ui-meta text-text-muted mt-1">
            {decision.claims.map((c) => (
              <li key={c.id}>{c.text}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function EgoFactSummaryBody({ fact, onNavigate }: { fact: FactRef; onNavigate?: (ref: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="ui-micro flex items-center gap-2 font-mono">
        <span className="rounded bg-stale px-1.5 py-0.5 text-stale-fg">{fact.category}</span>
        {fact.at && <span className="text-text-muted">@ {fact.at}</span>}
      </div>
      <div className="rounded-md border border-stale/30 bg-stale/5 px-2 py-1.5">
        <span className="ui-micro font-mono uppercase tracking-wide text-stale">
          {t("graph.graphDrawer.factObservation")}
        </span>
        {fact.text ? (
          <p className="ui-meta mt-0.5 font-medium leading-relaxed text-text">{fact.text}</p>
        ) : (
          <p className="ui-micro mt-1.5 italic leading-relaxed text-text-faint">
            {t("graph.graphDrawer.factAnchorOnly")}
          </p>
        )}
      </div>
      <div className="ui-micro flex flex-col gap-0.5 rounded-md border border-border bg-surface-raised px-2 py-1.5 font-mono text-text-muted">
        {fact.taskId && (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="text-text-faint">{t("graph.graphDrawer.anchorTaskLabel")}</span>{" "}
            {onNavigate ? (
              <EntityRefLink
                entityRef={`task/${fact.taskId}`}
                onNavigate={onNavigate}
                title={fact.taskId}
                className="text-accent hover:underline"
              />
            ) : (
              fact.taskId
            )}
          </div>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="text-text-faint">{t("graph.graphDrawer.anchorLabel")}</span>{" "}
          {onNavigate ? (
            <EntityRefLink
              entityRef={fact.anchor.startsWith("fact/") ? fact.anchor : `fact/${fact.anchor}`}
              onNavigate={onNavigate}
              title={fact.anchor}
              className="break-all text-accent hover:underline"
            >
              {fact.anchor}
            </EntityRefLink>
          ) : (
            fact.anchor
          )}
        </div>
      </div>
    </div>
  );
}

export function EgoAgentSummaryBody({ agent }: { agent: AgentNodeRow }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="ui-micro flex items-center gap-2 font-mono">
        <span className="rounded bg-axis-assoc/15 px-1.5 py-0.5 text-text-muted">{agent.sub}</span>
      </div>
      <div className="rounded-md border border-border bg-surface-raised px-2 py-1.5">
        <span className="ui-micro font-mono uppercase tracking-wide text-text-faint">
          {t("graph.graphDrawer.dispatchedTasks")}
        </span>
        <p className="ui-meta mt-0.5 font-medium text-text">
          {agent.taskCount > 0
            ? t("graph.graphDrawer.dispatchCount", { count: agent.taskCount })
            : t("graph.graphDrawer.noDispatches")}
        </p>
      </div>
    </div>
  );
}

export function EgoScheduleSummaryBody({ schedule }: { schedule: ScheduleNodeRow }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="ui-micro flex items-center gap-2 font-mono">
        <span className="rounded bg-axis-assoc/15 px-1.5 py-0.5 text-text-muted">{schedule.sub}</span>
      </div>
      <div className="rounded-md border border-border bg-surface-raised px-2 py-1.5">
        <span className="ui-micro font-mono uppercase tracking-wide text-text-faint">
          {t("graph.graphDrawer.scheduleTarget")}
        </span>
        <p className="ui-meta mt-0.5 break-all font-medium text-text">
          {schedule.targetAgentId ?? t("graph.graphDrawer.scheduleTargetNone")}
        </p>
      </div>
    </div>
  );
}
