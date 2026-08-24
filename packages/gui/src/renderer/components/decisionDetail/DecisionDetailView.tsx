import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CaretRight,
  CirclesFour,
  FileText,
  LinkSimple,
  SealCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { harnessClient } from "../../api-client.ts";
import { DecisionStateBadge, RiskTierBadge, UrgencyBadge } from "../badges.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { derivedTasks, supersedeChain } from "../../model/triadic.ts";
import { localDateTime } from "../../model/local-time.ts";
import type { DecisionRow, RelationEdge, TaskRow } from "../../model/types.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 决策详情页(与 Task 详情同级的信息架构:身份条 + 分页签)。
 * 列表读面(repo.decisions.list)从不携带正文——kernel 列表路径显式 body:null,
 * 所以正文按决策逐条经 decision-show(includeBody)取回,一次一份,规模天然有界。
 * 取不到时逐态说明原因(加载/投影追赶/未投影/读取失败),绝不静默留白。
 */

const tabs = [
  { id: "body", label: "views.decisionDetailView.tabBody", icon: FileText },
  { id: "overview", label: "views.decisionDetailView.tabOverview", icon: CirclesFour },
  { id: "claims", label: "views.decisionDetailView.tabClaims", icon: SealCheck },
  { id: "relations", label: "views.decisionDetailView.tabRelations", icon: LinkSimple },
] as const;

type DecisionDetailTab = (typeof tabs)[number]["id"];

/** 长正文按块分批显形,照抄 TaskStream/DecisionPoolView 的 ROW_BATCH_SIZE 机制。 */
const BODY_BLOCK_BATCH_SIZE = 12;

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
  useEffect(() => { setActiveTab("body"); }, [decisionId]);

  const decision = useMemo(
    () => decisions.find((row) => row.decisionId === decisionId) ?? null,
    [decisions, decisionId],
  );

  if (!decision) {
    return <aside data-testid="decision-detail-pending" className="flex h-full flex-col items-start gap-3 px-4 py-6">
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
    </aside>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="decision-detail-view">
      <header className="shrink-0 border-b border-border bg-surface/80" data-testid="decision-detail-header">
        <div className="flex min-h-14 items-center gap-2.5 px-3 py-2 lg:px-4">
          <button
            type="button"
            onClick={onBack}
            aria-label={t("views.taskDetailView.returnPreviousLevel")}
            className="grid size-7 shrink-0 place-items-center rounded-md border border-border text-text-muted hover:border-border-strong hover:bg-surface-raised hover:text-text"
          >
            <ArrowLeft weight="bold" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1 font-mono text-[9px] leading-3 text-text-faint">
              <button type="button" onClick={onBack} className="truncate hover:text-text-muted">{projectName}</button>
              <CaretRight weight="bold" className="shrink-0" />
              {fromViewLabel && (
                <>
                  <button type="button" onClick={onBack} className="truncate hover:text-text-muted">{fromViewLabel}</button>
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
              <h1 className="truncate text-[16px] font-semibold leading-5 tracking-[-0.01em] text-text">{decision.title}</h1>
              <DecisionStateBadge state={decision.state} />
              <RiskTierBadge tier={decision.riskTier} />
              <UrgencyBadge urgency={decision.urgency} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onOpenPool && (
              <button type="button" onClick={() => onOpenPool(decision.decisionId)} className="rounded-md border border-border px-2 py-1.5 font-mono text-[10px] text-text-muted hover:border-border-strong hover:bg-surface-raised hover:text-text">
                {t("views.decisionDetailView.openInPool")}
              </button>
            )}
            {onFocusGraph && (
              <button type="button" onClick={() => onFocusGraph(`decision/${decision.decisionId}`)} className="rounded-md border border-border px-2 py-1.5 font-mono text-[10px] text-text-muted hover:border-border-strong hover:bg-surface-raised hover:text-text">
                {t("views.decisionDetailView.focusGraph")}
              </button>
            )}
          </div>
        </div>
        <details className="group relative z-30">
          <summary className="list-none cursor-pointer border-t border-border px-3 py-1.5 font-mono text-[10px] text-text-faint hover:text-text-muted [&::-webkit-details-marker]:hidden lg:px-4">
            {t("views.decisionDetailView.identity")}
          </summary>
          <dl data-testid="decision-identity-strip" className="grid w-full grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
            <IdentityItem label={t("views.decisionDetailView.identityDecision")} value={decision.legacyId ? `${decision.decisionId} · ${decision.legacyId}` : decision.decisionId} onClick={() => onNavigateEntity(`decision/${decision.decisionId}`)} />
            <IdentityItem label={t("views.decisionDetailView.identityVertical")} value={`${decision.vertical ?? "—"} · ${decision.preset ?? "—"}`} />
            <IdentityItem
              label={t("views.decisionDetailView.identityScope")}
              value={`${decision.appliesTo?.modules.join(",") || "—"} · ${decision.appliesTo?.productLines.join(",") || "—"}`}
            />
            <IdentityItem
              label={t("views.decisionDetailView.identityActors")}
              value={actorsLabel(decision)}
              content={<span className="flex flex-wrap items-center gap-x-1.5">
                <ActorRef actor={decision.proposedBy} onNavigateEntity={onNavigateEntity} />
                <span className="text-text-faint">·</span>
                <ActorRef actor={decision.arbiter ?? null} onNavigateEntity={onNavigateEntity} />
              </span>}
            />
            <IdentityItem
              label={t("views.decisionDetailView.identityTimeline")}
              value={`${localDateTime(decision.proposedAt ?? "") ?? "—"} · ${localDateTime(decision.decidedAt ?? "") ?? "—"}`}
            />
            <IdentityItem label={t("views.decisionDetailView.identityClass")} value={`${decision.decisionClass ?? "—"} · rev ${decision.workspaceRevision ?? "—"}`} />
          </dl>
        </details>
      </header>

      <nav role="tablist" aria-label="Decision 详情分区" className="flex h-8 shrink-0 overflow-x-auto border-b border-border bg-surface px-2 sm:px-3">
        {tabs.map((tab) => {
          const Icon = tab.icon, active = activeTab === tab.id;
          return <button
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
          </button>;
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
            {activeTab === "body" ? <DecisionBodyPanel repoId={repoId} decisionId={decision.decisionId} />
              : activeTab === "overview" ? <OverviewPanel decision={decision} />
              : activeTab === "claims" ? <ClaimsPanel decision={decision} />
              : <RelationsPanel decision={decision} tasks={tasks} relations={relations} onNavigateDecision={onNavigateDecision} onNavigateTask={onNavigateTask} onNavigateEntity={onNavigateEntity} />}
          </section>
        </div>
      </main>
    </div>
  );
}

function DecisionBodyPanel({ repoId, decisionId }: { repoId: string; decisionId: string }) {
  const query = useQuery({
    queryKey: ["decision-body", repoId, decisionId],
    queryFn: () => harnessClient.showDecision({ repoId, decisionId, includeBody: true }),
    enabled: decisionId !== "",
    staleTime: 10_000,
  });
  if (query.isPending) {
    return <p data-testid="decision-body-loading" className="font-mono text-[12px] text-text-faint">
      {t("views.decisionDetailView.bodyLoading")}
    </p>;
  }
  if (query.isError) {
    return <p data-testid="decision-body-error" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-[12px] text-danger">
      {t("views.decisionDetailView.bodyFailed", { detail: query.error instanceof Error ? query.error.message : String(query.error) })}
    </p>;
  }
  if (query.data.status === "pending") {
    return <p data-testid="decision-body-pending" className="rounded-md border border-stale/40 bg-stale/5 px-3 py-2 font-mono text-[12px] text-stale">
      {t("views.decisionDetailView.bodyPending")}{query.data.hint ? ` · ${query.data.hint}` : ""}
    </p>;
  }
  const body = query.data.decision.body;
  if (!body) {
    return <p data-testid="decision-body-unavailable" className="rounded-md border border-border bg-surface-raised px-3 py-2 font-mono text-[12px] text-text-muted">
      {t("views.decisionDetailView.bodyUnavailable")}
    </p>;
  }
  return <DecisionBodyDocument source={body.body} resetKey={decisionId} />;
}

function DecisionBodyDocument({ source, resetKey }: { source: string; resetKey: string }) {
  const blocks = useMemo(() => splitMarkdownBlocks(source), [source]);
  const [visible, setVisible] = useState(BODY_BLOCK_BATCH_SIZE);
  useEffect(() => { setVisible(BODY_BLOCK_BATCH_SIZE); }, [resetKey]);
  const shown = blocks.slice(0, visible), hidden = blocks.length - shown.length;
  return <div data-testid="decision-body-document">
    <div className="prose-harness">
      {shown.map((block, index) => (
        <div key={index} data-testid="decision-body-block">
          <Markdown remarkPlugins={[remarkGfm]}>{block}</Markdown>
        </div>
      ))}
    </div>
    {hidden > 0 && (
      <button
        type="button"
        data-testid="decision-body-more"
        onClick={() => setVisible((count) => Math.min(count + BODY_BLOCK_BATCH_SIZE, blocks.length))}
        className="mt-3 w-full rounded-lg border border-dashed border-border px-4 py-2 font-mono text-[12px] text-text-muted hover:border-border-strong hover:text-text"
      >
        {t("views.decisionDetailView.bodyShowMore", { count: Math.min(BODY_BLOCK_BATCH_SIZE, hidden), remaining: hidden })}
      </button>
    )}
  </div>;
}

/**
 * 把 Markdown 正文切成顶层块(空行分界),围栏代码块内的空行不切,
 * 纯空白的段不产生块。分批渲染的单位是块:批大小、显形按钮与剩余量上报沿用
 * TaskStream 的机制。
 */
export function splitMarkdownBlocks(source: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [], insideFence = false;
  const flush = () => {
    if (current.some((line) => line.trim() !== "")) blocks.push(current.join("\n"));
    current = [];
  };
  for (const line of source.split("\n")) {
    if (/^\s*(?:```|~~~)/u.test(line)) insideFence = !insideFence;
    if (!insideFence && line.trim() === "") { flush(); continue; }
    current.push(line);
  }
  flush();
  return blocks;
}

function OverviewPanel({ decision }: { decision: DecisionRow }) {
  return <div className="flex flex-col gap-3">
    <div className="rounded-md border border-border bg-surface-raised px-3 py-2">
      <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">{t("views.decisionDetailView.question")}</span>
      <p className="mt-1 text-[13px] font-medium text-text">{decision.question}</p>
    </div>
    {decision.chosen.length > 0 && (
      <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wide text-accent">{t("views.decisionsVerdict.chosen")}</span>
        {decision.chosen.map((option) => (
          <div key={option.id} className="mt-1 text-[12px] leading-relaxed">
            <span className="font-mono text-text-faint">{option.id} </span>
            <span className="text-text">{option.text}</span>
            {option.rationale && <p className="ml-4 text-[11px] text-text-muted">{option.rationale}</p>}
          </div>
        ))}
      </div>
    )}
    {decision.rejected.length > 0 && (
      <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wide text-danger">{t("views.decisionsVerdict.rejected")}</span>
        {decision.rejected.map((option) => (
          <div key={option.id} className="mt-1 text-[12px] leading-relaxed">
            <span className="font-mono text-text-faint">{option.id} </span>
            <span className="text-text line-through opacity-70">{option.text}</span>
            {option.whyNot && <p className="ml-4 text-[11px] italic text-text-muted">{t("views.decisionDetailView.whyNot")}: {option.whyNot}</p>}
          </div>
        ))}
      </div>
    )}
  </div>;
}

function ClaimsPanel({ decision }: { decision: DecisionRow }) {
  return <div className="flex flex-col gap-3">
    <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
      <h2 className="font-mono text-[11px] uppercase tracking-wide text-text-faint">{t("views.decisionDetailView.claims")}</h2>
      {decision.claims.length === 0
        ? <p className="mt-1 text-[12px] text-text-faint">{t("views.decisionDetailView.claimsEmpty")}</p>
        : <ul className="mt-1 list-inside list-disc text-[12px] text-text-muted">
          {decision.claims.map((claim) => (
            <li key={claim.id}>
              <span className="font-mono text-text-faint">{claim.id} </span>{claim.text}
              <span className="ml-1 font-mono text-[11px] text-text-faint">
                {t("views.decisionDetailView.fulfillment")}: {claim.fulfillment ?? "—"}{claim.loadBearing ? " · load-bearing" : ""}
              </span>
            </li>
          ))}
        </ul>}
    </section>
    <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
      <h2 className="font-mono text-[11px] uppercase tracking-wide text-text-faint">{t("views.decisionDetailView.consents")}</h2>
      {decision.judgmentConsents.length === 0
        ? <p className="mt-1 text-[12px] text-text-faint">{t("views.decisionDetailView.consentsEmpty")}</p>
        : <ul className="mt-1 space-y-1 font-mono text-[11px] text-text-muted">
          {decision.judgmentConsents.map((consent) => (
            <li key={consent.consentId}>{consent.action} · {consent.consentId} · {consent.consentedAt}</li>
          ))}
        </ul>}
    </section>
    {(decision.provenance?.length ?? 0) > 0 && (
      <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wide text-text-faint">{t("views.decisionsVerdict.provenance")}</h2>
        <ul className="mt-1 space-y-1 font-mono text-[11px] text-text-muted">
          {decision.provenance!.map((entry) => (
            <li key={entry.sessionId}>{entry.runtime}:{entry.sessionId} · {localDateTime(entry.boundAt) ?? "—"}</li>
          ))}
        </ul>
      </section>
    )}
  </div>;
}

function RelationsPanel({ decision, tasks, relations, onNavigateDecision, onNavigateTask, onNavigateEntity }: {
  decision: DecisionRow;
  tasks: TaskRow[];
  relations: RelationEdge[];
  onNavigateDecision: (decisionId: string) => void;
  onNavigateTask?: (taskId: string) => void;
  onNavigateEntity: (ref: string) => void;
}) {
  const self = `decision/${decision.decisionId}`;
  const touches = (ref: string) => ref === self || ref.startsWith(`${self}/`);
  const edges = relations.filter((edge) => touches(edge.from) || touches(edge.to));
  const chain = supersedeChain(decision, relations);
  const derived = derivedTasks(decision, relations, tasks);
  return <div className="flex flex-col gap-3">
    {(chain.supersedes.length > 0 || chain.supersededBy.length > 0) && (
      <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {chain.supersedes.length > 0 && (
            <span className="inline-flex items-center gap-1 font-mono text-danger">
              {chain.supersedes.map((id) => (
                <EntityRefLink key={id} entityRef={`decision/${id}`} onNavigate={() => onNavigateDecision(id)} title={id} className="text-danger hover:underline" />
              ))}
            </span>
          )}
          {chain.supersededBy.length > 0 && (
            <span className="inline-flex items-center gap-1 font-mono text-stale">
              {chain.supersededBy.map((id) => (
                <EntityRefLink key={id} entityRef={`decision/${id}`} onNavigate={() => onNavigateDecision(id)} title={id} className="text-stale hover:underline" />
              ))}
            </span>
          )}
        </div>
      </section>
    )}
    {derived.length > 0 && (
      <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wide text-text-faint">{t("views.decisionDetailView.derivedTasks")}</h2>
        <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
          {derived.map((task) => (
            <span key={task.taskId} className="inline-flex items-center gap-1 font-mono text-text-muted">
              {onNavigateTask
                ? <EntityRefLink entityRef={`task/${task.taskId}`} onNavigate={() => onNavigateTask(task.taskId)} title={task.taskId} className="rounded bg-surface px-1 text-text-muted hover:text-accent hover:underline" />
                : <span className="rounded bg-surface px-1">{task.taskId}</span>}
              <span className="text-text-faint">{task.title}</span>
            </span>
          ))}
        </div>
      </section>
    )}
    <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
      <h2 className="font-mono text-[11px] uppercase tracking-wide text-text-faint">{t("views.decisionDetailView.tabRelations")}</h2>
      {edges.length === 0
        ? <p className="mt-1 text-[12px] text-text-faint">{t("views.decisionDetailView.relationsEmpty")}</p>
        : <ul className="mt-1 space-y-1 font-mono text-[11px] text-text-muted">
          {edges.map((edge) => (
            <li key={edge.relationId} className="break-all">
              <RefLink ref_={edge.from} self={self} onNavigateEntity={onNavigateEntity} onNavigateDecision={onNavigateDecision} />
              <span className="mx-1 text-accent">--{edge.kind}--&gt;</span>
              <RefLink ref_={edge.to} self={self} onNavigateEntity={onNavigateEntity} onNavigateDecision={onNavigateDecision} />
              {edge.rationale && <span className="ml-1 text-text-faint">({edge.rationale})</span>}
            </li>
          ))}
        </ul>}
    </section>
  </div>;
}

function RefLink({ ref_, self, onNavigateEntity, onNavigateDecision }: {
  ref_: string; self: string; onNavigateEntity: (ref: string) => void; onNavigateDecision: (decisionId: string) => void;
}) {
  // 自引用(本决策)导航为 no-op:对等价位置不推栈,但仍走互链出口保持可激活。
  if (ref_.startsWith("decision/")) {
    const id = ref_.split("/")[1]!;
    const navigation = ref_ === self ? () => undefined : () => onNavigateDecision(id);
    return <EntityRefLink entityRef={ref_} onNavigate={navigation} title={id} className="hover:text-accent hover:underline" />;
  }
  return <EntityRefLink entityRef={ref_} onNavigate={() => onNavigateEntity(ref_)} title={ref_} className="hover:text-accent hover:underline" />;
}

function IdentityItem({ label, value, content, onClick }: { label: string; value: string; content?: ReactNode; onClick?: () => void }) {
  return <div className="min-w-0 bg-surface px-3 py-2">
    <dt className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-text-faint">{label}</dt>
    <dd title={value} className="mt-1 min-w-0 truncate font-mono text-[11px] text-text-muted">
      {content ?? (onClick ? <button type="button" onClick={onClick} className="text-accent hover:underline">{value}</button> : value)}
    </dd>
  </div>;
}

/** G10:agent 是可寻址实体,ID 必须有路;human/system 无详情页,纯文本。 */
function ActorRef({ actor, onNavigateEntity }: { actor: { kind: "agent" | "human" | "system"; id: string } | null | undefined; onNavigateEntity: (ref: string) => void }) {
  if (!actor) return <span className="text-text-muted">—</span>;
  if (actor.kind !== "agent") return <span className="text-text-muted">{`${actor.kind}:${actor.id}`}</span>;
  return (
    <EntityRefLink
      entityRef={`agent/${actor.id}`}
      onNavigate={() => onNavigateEntity(`agent/${actor.id}`)}
      title={actor.id}
      className="text-text-muted hover:text-accent hover:underline"
    >
      {`agent:${actor.id}`}
    </EntityRefLink>
  );
}

function actorsLabel(decision: DecisionRow): string {
  const proposed = decision.proposedBy ? `${decision.proposedBy.kind}:${decision.proposedBy.id}` : "—";
  const arbitrated = decision.arbiter ? `${decision.arbiter.kind}:${decision.arbiter.id}` : "—";
  return `${proposed} · ${arbitrated}`;
}
