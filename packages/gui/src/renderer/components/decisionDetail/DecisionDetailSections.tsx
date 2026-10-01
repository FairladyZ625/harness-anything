import { derivedTasks, supersedeChain } from "../../model/triadic.ts";
import { formatTime } from "../../model/time.ts";
import type { DecisionRow, DecisionState, RelationEdge, TaskRow } from "../../model/types.ts";
import { t } from "../../i18n/index.tsx";
import { decisionStateLabel } from "../badges.tsx";
import { actorText } from "../decisionReview/parts.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { DayDigest, type DayPathStep } from "../primitives/DayDigest";
import { DenseRow } from "../primitives/DenseRow";
import { Region } from "../primitives/Region";
import { BoardColumn, BoardMain, BoardRegion, BoardSide, RegionBoard } from "../primitives/RegionBoard";
import type { StatusTone } from "../primitives/StatusTag";

/** 决策状态 → 状态色(标准 §3):时间线上的裁决结果与状态迁移用它上色。 */
const STATE_TONE: Record<DecisionState, StatusTone> = {
  proposed: "plan",
  in_effect: "done",
  rejected: "bad",
  deferred: "wait",
  superseded: "cancel",
  outcome_retired: "cancel",
  unknown: "neutral",
};

/** 问题、选项与理由都是整句:在条目里折行显示全文,不按 DenseRow 的单行省略号截断。 */
const wrapped = (text: string) => <span className="whitespace-normal">{text}</span>;

export function OverviewPanel({ decision }: { decision: DecisionRow }) {
  const timeline = decisionTimeline(decision);
  return (
    // 区域板(标准 §2.1,与工作概况、任务详情概况同一个 RegionBoard):主区依次是问题、已选、
    // 已否,时间线固定在最右一列;每块都在 Region 里并区内滚动,没有内容的区域整块消失。
    <RegionBoard data-testid="decision-overview-board">
      <BoardMain>
        {/* 主区只有一列:选项与理由是整句,列越宽越好读;拆成两列会把每条压到三分之一宽。 */}
        <BoardColumn>
          <BoardRegion region="question" data-testid="decision-overview-question">
            <Region title={t("views.decisionDetailView.question")}>
              <DenseRow title={wrapped(decision.question)} />
            </Region>
          </BoardRegion>
          {decision.chosen.length > 0 && (
            <BoardRegion region="chosen" data-testid="decision-overview-chosen">
              <Region
                title={t("views.decisionDetailView.chosen")}
                big={decision.chosen.length}
                bigTone="done"
                edge="done"
              >
                {decision.chosen.map((option) => (
                  <DenseRow
                    key={option.id}
                    relaxed
                    title={wrapped(option.text)}
                    reason={option.rationale ? wrapped(option.rationale) : undefined}
                    time={option.id}
                  />
                ))}
              </Region>
            </BoardRegion>
          )}
          {decision.rejected.length > 0 && (
            <BoardRegion region="rejected" data-testid="decision-overview-rejected">
              <Region
                title={t("views.decisionDetailView.rejected")}
                big={decision.rejected.length}
                bigTone="cancel"
                edge="cancel"
              >
                {decision.rejected.map((option) => (
                  <DenseRow
                    key={option.id}
                    relaxed
                    title={wrapped(option.text)}
                    reason={option.whyNot ? wrapped(option.whyNot) : undefined}
                    time={option.id}
                  />
                ))}
              </Region>
            </BoardRegion>
          )}
        </BoardColumn>
      </BoardMain>
      {timeline.length > 0 && (
        <BoardSide region="timeline" data-testid="decision-overview-timeline">
          <Region title={t("views.decisionDetailView.timeline")} big={timeline.length} padded>
            <DecisionTimelineDigest entries={timeline} />
          </Region>
        </BoardSide>
      )}
    </RegionBoard>
  );
}

interface TimelineEntry {
  readonly at: string;
  readonly name: string;
  readonly step: DayPathStep;
}

const actorLabel = (actor: DecisionRow["proposedBy"]) => (actor ? `${actor.kind}:${actor.id}` : "—");

/**
 * 决策行上带时间的记录:提出、每次评审、每条意见回应、业主处置、裁决 consent,以及
 * decidedAt。decidedAt 是最近一次状态迁移(裁决、被取代、退役)的时刻:与某条 consent
 * 同刻时就是那次裁决,不重复列;否则单列一条当前状态——被取代/退役的操作人读面没给,
 * 不拿裁决人顶替。
 */
function decisionTimeline(decision: DecisionRow): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  if (decision.proposedAt)
    entries.push({
      at: decision.proposedAt,
      name: actorLabel(decision.proposedBy),
      step: { label: t("views.decisionDetailView.timelineProposed"), tone: "plan" },
    });
  for (const review of decision.review?.reviews ?? [])
    entries.push({
      at: review.reviewedAt,
      name: actorText(review.actor),
      step:
        review.verdict === "approved"
          ? { label: t("views.decisionReview.verdictApproved"), tone: "done" }
          : { label: t("views.decisionReview.verdictChangesRequested"), tone: "wait" },
    });
  for (const response of decision.review?.responses ?? [])
    entries.push({
      at: response.respondedAt,
      name: actorText(response.actor),
      step: {
        label: t(response.disposition === "adopt" ? "views.decisionReview.adopt" : "views.decisionReview.rebut"),
        tone: "active",
      },
    });
  for (const override of decision.review?.overrides ?? [])
    entries.push({
      at: override.overriddenAt,
      name: actorText(override.actor),
      step: { label: t("views.decisionReview.overrideTitle"), tone: "wait" },
    });
  for (const consent of decision.judgmentConsents)
    entries.push({
      at: consent.consentedAt,
      name: actorText(consent.actor),
      step: { label: decisionStateLabel(consent.targetState), tone: STATE_TONE[consent.targetState] },
    });
  if (decision.decidedAt && !decision.judgmentConsents.some((consent) => consent.consentedAt === decision.decidedAt))
    entries.push({
      at: decision.decidedAt,
      name:
        decision.state === "superseded" || decision.state === "outcome_retired" ? "—" : actorLabel(decision.arbiter),
      step: { label: decisionStateLabel(decision.state), tone: STATE_TONE[decision.state] },
    });
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

/** 时间线按天收束(§1.4):天摘要 + 每条记录一行(时刻、谁、做了什么)。 */
function DecisionTimelineDigest({ entries }: { readonly entries: readonly TimelineEntry[] }) {
  const groups: { day: string; entries: TimelineEntry[] }[] = [];
  for (const entry of entries) {
    const day = formatTime(entry.at, { style: "date" }) ?? entry.at.slice(0, 10);
    const last = groups.at(-1);
    if (last !== undefined && last.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return (
    <>
      {groups.map((group) => (
        <DayDigest
          key={group.day}
          // 标签用「月-日」,与工作概况、任务详情的进展同一写法。
          day={group.day.slice(5)}
          defaultOpen
          summary={t("views.decisionDetailView.timelineDay", { count: group.entries.length })}
          paths={group.entries.map((entry) => ({
            time: formatTime(entry.at, { style: "time" }) ?? undefined,
            name: entry.name,
            steps: [entry.step],
          }))}
        />
      ))}
    </>
  );
}

export function ClaimsPanel({ decision }: { decision: DecisionRow }) {
  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
        <h2 className="font-mono ui-micro uppercase tracking-wide text-text-faint">
          {t("views.decisionDetailView.claims")}
        </h2>
        {decision.claims.length === 0 ? (
          <p className="mt-1 ui-meta text-text-faint">{t("views.decisionDetailView.claimsEmpty")}</p>
        ) : (
          <ul className="mt-1 list-inside list-disc ui-meta text-text-muted">
            {decision.claims.map((claim) => (
              <li key={claim.id}>
                <span className="font-mono text-text-faint">{claim.id} </span>
                {claim.text}
                <span className="ml-1 font-mono ui-micro text-text-faint">
                  {t("views.decisionDetailView.fulfillment")}: {claim.fulfillment ?? "—"}
                  {claim.loadBearing ? " · load-bearing" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
        <h2 className="font-mono ui-micro uppercase tracking-wide text-text-faint">
          {t("views.decisionDetailView.consents")}
        </h2>
        {decision.judgmentConsents.length === 0 ? (
          <p className="mt-1 ui-meta text-text-faint">{t("views.decisionDetailView.consentsEmpty")}</p>
        ) : (
          <ul className="mt-1 space-y-1 font-mono ui-micro text-text-muted">
            {decision.judgmentConsents.map((consent) => (
              <li key={consent.consentId}>
                {consent.action} · {consent.consentId} · {consent.consentedAt}
              </li>
            ))}
          </ul>
        )}
      </section>
      {(decision.provenance?.length ?? 0) > 0 && (
        <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
          <h2 className="font-mono ui-micro uppercase tracking-wide text-text-faint">
            {t("views.decisionsVerdict.provenance")}
          </h2>
          <ul className="mt-1 space-y-1 font-mono ui-micro text-text-muted">
            {decision.provenance!.map((entry) => (
              <li key={entry.sessionId}>
                {entry.runtime}:{entry.sessionId} · {formatTime(entry.boundAt, { style: "date-time" }) ?? "—"}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function RelationsPanel({
  decision,
  tasks,
  relations,
  onNavigateDecision,
  onNavigateTask,
  onNavigateEntity,
}: {
  decision: DecisionRow;
  tasks: readonly TaskRow[];
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
  return (
    <div className="flex flex-col gap-3">
      {(chain.supersedes.length > 0 || chain.supersededBy.length > 0) && (
        <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5 ui-micro">
            {chain.supersedes.length > 0 && (
              <span className="inline-flex items-center gap-1 font-mono text-danger">
                {chain.supersedes.map((id) => (
                  <EntityRefLink
                    key={id}
                    entityRef={`decision/${id}`}
                    onNavigate={() => onNavigateDecision(id)}
                    title={id}
                    className="text-danger hover:underline"
                  />
                ))}
              </span>
            )}
            {chain.supersededBy.length > 0 && (
              <span className="inline-flex items-center gap-1 font-mono text-stale">
                {chain.supersededBy.map((id) => (
                  <EntityRefLink
                    key={id}
                    entityRef={`decision/${id}`}
                    onNavigate={() => onNavigateDecision(id)}
                    title={id}
                    className="text-stale hover:underline"
                  />
                ))}
              </span>
            )}
          </div>
        </section>
      )}
      {derived.length > 0 && (
        <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
          <h2 className="font-mono ui-micro uppercase tracking-wide text-text-faint">
            {t("views.decisionDetailView.derivedTasks")}
          </h2>
          <div className="mt-1 flex flex-wrap gap-2 ui-micro">
            {derived.map((task) => (
              <span key={task.taskId} className="inline-flex items-center gap-1 font-mono text-text-muted">
                {onNavigateTask ? (
                  <EntityRefLink
                    entityRef={`task/${task.taskId}`}
                    onNavigate={() => onNavigateTask(task.taskId)}
                    title={task.taskId}
                    className="rounded bg-surface px-1 text-text-muted hover:text-accent hover:underline"
                  />
                ) : (
                  <span className="rounded bg-surface px-1">{task.taskId}</span>
                )}
                <span className="text-text-faint">{task.title}</span>
              </span>
            ))}
          </div>
        </section>
      )}
      <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
        <h2 className="font-mono ui-micro uppercase tracking-wide text-text-faint">
          {t("views.decisionDetailView.tabRelations")}
        </h2>
        {edges.length === 0 ? (
          <p className="mt-1 ui-meta text-text-faint">{t("views.decisionDetailView.relationsEmpty")}</p>
        ) : (
          <ul className="mt-1 space-y-1 font-mono ui-micro text-text-muted">
            {edges.map((edge) => (
              <li key={edge.relationId} className="break-all">
                <RefLink
                  ref_={edge.from}
                  self={self}
                  onNavigateEntity={onNavigateEntity}
                  onNavigateDecision={onNavigateDecision}
                />
                <span className="mx-1 text-accent">--{edge.kind}--&gt;</span>
                <RefLink
                  ref_={edge.to}
                  self={self}
                  onNavigateEntity={onNavigateEntity}
                  onNavigateDecision={onNavigateDecision}
                />
                {edge.rationale && <span className="ml-1 text-text-faint">({edge.rationale})</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RefLink({
  ref_,
  self,
  onNavigateEntity,
  onNavigateDecision,
}: {
  ref_: string;
  self: string;
  onNavigateEntity: (ref: string) => void;
  onNavigateDecision: (decisionId: string) => void;
}) {
  // 自引用(本决策)导航为 no-op:对等价位置不推栈,但仍走互链出口保持可激活。
  if (ref_.startsWith("decision/")) {
    const id = ref_.split("/")[1]!;
    const navigation = ref_ === self ? () => undefined : () => onNavigateDecision(id);
    return (
      <EntityRefLink
        entityRef={ref_}
        onNavigate={navigation}
        title={id}
        className="hover:text-accent hover:underline"
      />
    );
  }
  return (
    <EntityRefLink
      entityRef={ref_}
      onNavigate={() => onNavigateEntity(ref_)}
      title={ref_}
      className="hover:text-accent hover:underline"
    />
  );
}
