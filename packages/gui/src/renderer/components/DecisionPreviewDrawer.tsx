import { useEffect } from "react";
import { ArrowSquareOut, Scales, X } from "@phosphor-icons/react";
import type { DecisionRow, RelationEdge, TaskRow } from "../model/types";
import { derivedTasks, supersedeChain } from "../model/triadic.ts";
import { DecisionStateBadge, RiskTierBadge, UrgencyBadge } from "./badges.tsx";
import { t } from "../i18n/index.tsx";
import { EntityRefLink } from "./EntityRefLink.tsx";
import { localMonthDayTime } from "../model/local-time.ts";

const timeOf = (iso: string | undefined) => (iso ? localMonthDayTime(iso) ?? "—" : "—");

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-3">
      <div className="mb-2 font-mono text-[12px] uppercase tracking-wide text-text-faint">{title}</div>
      {children}
    </section>
  );
}

function ClaimList({ claims }: { claims: DecisionRow["chosen"] }) {
  if (claims.length === 0) return <p className="text-[14px] text-text-faint">{t("components.decisionPreviewDrawer.none")}</p>;
  return (
    <div className="space-y-2">
      {claims.map((claim) => (
        <div key={claim.id} className="rounded-md bg-surface-raised px-3 py-2">
          <p className="text-[14px] text-text">{claim.text}</p>
          {claim.rationale && <p className="mt-1 text-[13px] leading-snug text-text-muted">{t("components.decisionPreviewDrawer.why")}{claim.rationale}</p>}
          {"whyNot" in claim && claim.whyNot && <p className="mt-1 text-[13px] leading-snug text-danger">{t("components.decisionPreviewDrawer.whyNot")}{claim.whyNot}</p>}
        </div>
      ))}
    </div>
  );
}

/**
 * 决策预览抽屉(总览决策流点击入口)。与 TaskPreviewDrawer 同一交互语汇:
 * 右侧 fixed 覆盖层、Esc 关闭、页脚显式「打开详情」——点击不再把人踢出本页。
 * 字段取舍见任务报告 §3:question/chosen/rejected/claims 是不打开详情就能
 * 判断一条裁决的最小集,正文与 consents 留给决策池详情。
 */

/** 提议/批准者:agent 是可寻址实体 → 链接;human/system 无详情页 → 纯文本。 */
function ActorRef({ actor, onNavigateEntity }: {
  readonly actor: { kind: "agent" | "human" | "system"; id: string } | undefined;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  if (actor === undefined) return <>—</>;
  if (actor.kind !== "agent") return <>{`${actor.kind}:${actor.id}`}</>;
  return (
    <EntityRefLink
      entityRef={`agent/${actor.id}`}
      onNavigate={onNavigateEntity}
      title={actor.id}
      className="text-text-muted hover:text-accent hover:underline"
    >
      {`agent:${actor.id}`}
    </EntityRefLink>
  );
}

/** decision ID 列表(逗号分隔),每项都是通往该 decision 的路。 */
function DecisionIdList({ ids, onOpenDetail, tone }: {
  readonly ids: readonly string[];
  readonly onOpenDetail: (decisionId: string) => void;
  readonly tone: string;
}) {
  return (
    <>
      {ids.map((id) => (
        <EntityRefLink
          key={id}
          entityRef={`decision/${id}`}
          onNavigate={() => onOpenDetail(id)}
          title={id}
          className={tone}
        />
      )).reduce<React.ReactNode[]>((acc, link, index) => (index === 0 ? [link] : [...acc, ", ", link]), [])}
    </>
  );
}

export function DecisionPreviewDrawer({
  decision,
  tasks,
  relations,
  onClose,
  onOpenDetail,
  onNavigateEntity,
}: {
  decision: DecisionRow | null;
  tasks: TaskRow[];
  relations: RelationEdge[];
  onClose: () => void;
  onOpenDetail: (decisionId: string) => void;
  /** G10 实体互链:抽屉内出现的其他实体 ID(proposer agent、派生 task)必须有路。 */
  onNavigateEntity: (ref: string) => void;
}) {
  useEffect(() => {
    if (!decision) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, decision]);

  if (!decision) return null;

  const chain = supersedeChain(decision, relations);
  const spawned = derivedTasks(decision, relations, tasks);
  const loadBearing = decision.claims.filter((claim) => claim.loadBearing);
  const amended = decision.decidedAt && decision.lastChangedAt && decision.lastChangedAt !== decision.decidedAt;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-bg/45">
      <aside className="flex h-full w-full max-w-[520px] flex-col border-l border-border-strong bg-surface shadow-2xl shadow-black/40">
        <header className="border-b border-border px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <EntityRefLink
                  entityRef={`decision/${decision.decisionId}`}
                  onNavigate={() => onOpenDetail(decision.decisionId)}
                  title={decision.decisionId}
                  className="font-mono text-[13px] text-text-faint hover:text-accent hover:underline"
                />
                <DecisionStateBadge state={decision.state} />
                <RiskTierBadge tier={decision.riskTier} />
                <UrgencyBadge urgency={decision.urgency} />
              </div>
              <h2 className="mt-2 flex items-start gap-2 text-[20px] font-semibold leading-tight text-text">
                <Scales weight="bold" className="mt-1 shrink-0 text-accent" />
                {decision.title}
              </h2>
            </div>
            <button
              onClick={onClose}
              aria-label={t("components.decisionPreviewDrawer.close")}
              className="grid size-8 shrink-0 place-items-center rounded-md text-text-faint hover:bg-surface-raised hover:text-text"
            >
              <X weight="bold" />
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-text-faint">
            <span className="flex min-w-0 items-center gap-1">
              {t("components.decisionPreviewDrawer.proposedBy")} <ActorRef actor={decision.proposedBy} onNavigateEntity={onNavigateEntity} />
            </span>
            <span className="flex min-w-0 items-center gap-1">
              {t("components.decisionPreviewDrawer.arbiter")}{" "}
              <ActorRef actor={decision.arbiter} onNavigateEntity={onNavigateEntity} />
            </span>
            <span>{t("components.decisionPreviewDrawer.proposedAt")} {timeOf(decision.proposedAt)}</span>
            <span>{t("components.decisionPreviewDrawer.decidedAt")} {timeOf(decision.decidedAt)}</span>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Section title={t("components.decisionPreviewDrawer.question")}>
            <p className="text-[15px] leading-relaxed text-text">{decision.question}</p>
          </Section>

          <Section title={t("components.decisionPreviewDrawer.chosen")}>
            <ClaimList claims={decision.chosen} />
          </Section>

          <Section title={t("components.decisionPreviewDrawer.rejected")}>
            <ClaimList claims={decision.rejected} />
          </Section>

          <Section title={t("components.decisionPreviewDrawer.loadBearingClaims")}>
            {loadBearing.length === 0 ? (
              <p className="text-[14px] text-text-faint">{t("components.decisionPreviewDrawer.none")}</p>
            ) : (
              <ul className="list-inside list-disc space-y-1 text-[14px] text-text-muted">
                {loadBearing.map((claim) => (
                  <li key={claim.id}>{claim.text}</li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={t("components.decisionPreviewDrawer.supersedeChain")}>
            {chain.supersedes.length === 0 && chain.supersededBy.length === 0 && !amended ? (
              <p className="text-[14px] text-text-faint">{t("components.decisionPreviewDrawer.none")}</p>
            ) : (
              <div className="space-y-1 font-mono text-[12px]">
                {chain.supersedes.length > 0 && (
                  <p className="flex flex-wrap items-center gap-1 text-danger">
                    {t("components.decisionPreviewDrawer.retires")} <DecisionIdList
                      ids={chain.supersedes}
                      onOpenDetail={onOpenDetail}
                      tone="text-danger hover:underline"
                    />
                  </p>
                )}
                {chain.supersededBy.length > 0 && (
                  <p className="flex flex-wrap items-center gap-1 text-stale">
                    {t("components.decisionPreviewDrawer.supersededBy")} <DecisionIdList
                      ids={chain.supersededBy}
                      onOpenDetail={onOpenDetail}
                      tone="text-stale hover:underline"
                    />
                  </p>
                )}
                {amended && <p className="text-text-muted">{t("components.decisionPreviewDrawer.amendedAt")} {timeOf(decision.lastChangedAt)}</p>}
              </div>
            )}
          </Section>

          <Section title={t("components.decisionPreviewDrawer.derivedTasks")}>
            {spawned.length === 0 ? (
              <p className="text-[14px] text-text-faint">{t("components.decisionPreviewDrawer.none")}</p>
            ) : (
              <div className="space-y-1.5">
                {spawned.map((task) => (
                  <div key={task.taskId} className="rounded-md bg-surface-raised px-3 py-2">
                    <EntityRefLink
                      entityRef={`task/${task.taskId}`}
                      onNavigate={onNavigateEntity}
                      title={task.taskId}
                      className="font-mono text-[12px] text-text-faint hover:text-accent hover:underline"
                    />
                    <span className="ml-2 text-[14px] text-text">{task.title}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
          <button
            onClick={() => onOpenDetail(decision.decisionId)}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-[15px] font-semibold text-accent-fg"
          >
            <ArrowSquareOut weight="bold" />
            {t("components.decisionPreviewDrawer.openFullDetails")}
          </button>
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-2 text-[15px] text-text-muted hover:bg-surface-raised hover:text-text"
          >
            {t("components.decisionPreviewDrawer.closeButton")}
          </button>
        </footer>
      </aside>
    </div>
  );
}
