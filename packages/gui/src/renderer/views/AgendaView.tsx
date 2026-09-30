import { useMemo, useState } from "react";
import type { AgendaSuccess } from "../api-client.ts";
import type { MessageKey } from "../i18n/core.ts";
import { t } from "../i18n/index.tsx";
import { AWAITS_KIND_LABEL, type AwaitsPanelSubject } from "../awaits-answer.ts";
import { AwaitsAnswerPanel } from "../components/AwaitsAnswerPanel.tsx";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { Drawer } from "../components/primitives/Drawer.tsx";
import { FilterChips } from "../components/primitives/FilterChips.tsx";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag.tsx";
import { TitleText } from "../components/primitives/TitleText.tsx";
import {
  decisionAgendaRowRef,
  decisionAgendaRows,
  taskAwaitsRows,
  type DecisionReviewGroup,
} from "../model/decision-review.ts";
import { taskReviewRef } from "../navigation/entityRoutes.ts";
import { ageOf } from "./overview-model.ts";
import type { AgendaAwaitsRow } from "../../api/renderer-dto.ts";

/**
 * 议程(标准 §2.4 列表页;dec_DC3A1BB9 是它的唯一归处):回答「现在该推进哪几件事、
 * 哪些卡住」。行与组全部取总览同一条议程读面(repo.agenda.read),不另发请求、不逐条
 * 读 Decision;排序用 daemon 的注意力分(与 CLI 同序,attain 不出的行按组序垫底)。
 * 顶部 FilterChips 带计数 + 页内搜索,默认「需要关注」(下一步是你的行),不默认全量;
 * 行用 DenseRow、状态用有底色的 StatusTag;点行开抽屉,答复在抽屉里就地进答复面板,
 * 其余给「打开完整详情」落逐项回应 / 评审页签 / 评审会话 / 裁决页签 / 源实体详情。
 */
type AgendaGroup = DecisionReviewGroup | "answered" | "rework" | "adjudicate" | "taskReviewing";

/** 组的显示序 = 注意力序:等你动手的在前,已在别人手里的在后,已答复跟进垫底。 */
const GROUP_ORDER: readonly AgendaGroup[] = [
  "dispose",
  "rework",
  "adjudicate",
  "review",
  "judge",
  "reviewing",
  "taskReviewing",
  "answered",
];

const GROUP_LABEL: Readonly<Record<AgendaGroup, MessageKey>> = {
  dispose: "views.workspace.decisionReviewGroupDispose",
  rework: "views.agenda.groupRework",
  adjudicate: "views.agenda.groupAdjudicate",
  review: "views.workspace.decisionReviewGroupReview",
  judge: "views.workspace.decisionReviewGroupJudge",
  reviewing: "views.workspace.decisionReviewGroupReviewing",
  taskReviewing: "views.agenda.groupTaskReviewing",
  answered: "components.awaitsAnswer.answeredForYou",
};

/** 组 → 状态色档(标准 §3:同一类别同一色;颜色通道只承载注意力类别)。 */
const GROUP_TONE: Readonly<Record<AgendaGroup, StatusTone>> = {
  dispose: "bad",
  rework: "bad",
  adjudicate: "bad",
  review: "wait",
  judge: "wait",
  reviewing: "wait",
  taskReviewing: "wait",
  answered: "done",
};

/** 筛选桶:需要关注 = 下一步是「你」;待跟进 = 已出手、等别人回。 */
type AgendaFilter = "attn" | "follow" | "all";

const GROUP_BUCKET: Readonly<Record<AgendaGroup, AgendaFilter>> = {
  dispose: "attn",
  rework: "attn",
  adjudicate: "attn",
  review: "attn",
  judge: "attn",
  reviewing: "follow",
  taskReviewing: "follow",
  answered: "follow",
};

/** 议程的一行:组、标题、原因、等待时长,加上落点(完整详情 ref)与答复源行。 */
interface AgendaRow {
  readonly id: string;
  readonly group: AgendaGroup;
  readonly title: string;
  readonly hint: string;
  /** 读面各源行自带的时间字段(askedAt/answeredAt/submittedAt/proposedAt/updatedAt)。 */
  readonly since: string | null;
  /** 注意力分的检索键(attentionItems 的 ref);不在注意力切面里的行为 null。 */
  readonly scoreRef: string | null;
  /** 「打开完整详情」的落点;ask 行的完整详情是它的源实体。 */
  readonly target: string;
  readonly ask?: AgendaAwaitsRow;
}

function agendaRowsOf(agenda: AgendaSuccess): readonly AgendaRow[] {
  return [
    ...taskAwaitsRows(agenda).map((ask) => ({
      id: ask.relationId,
      title: ask.title,
      hint: `${AWAITS_KIND_LABEL[ask.askKind]()} · ${ask.question}`,
      group: "dispose" as const,
      since: ask.askedAt,
      scoreRef: `relation/${ask.relationId}`,
      target: ask.sourceRef,
      ask,
    })),
    ...agenda.answeredForYou.map((row) => ({
      id: row.relationId,
      title: row.title,
      hint: `${AWAITS_KIND_LABEL[row.askKind]()} · ${t("views.agenda.hintAnswered", { answer: row.answer })}`,
      group: "answered" as const,
      since: row.answeredAt,
      scoreRef: `relation/${row.relationId}`,
      target: row.sourceRef,
    })),
    ...taskReviewRows(agenda.awaitingRework, "rework", "views.agenda.hintRework", (row) => ({
      since: row.updatedAt,
      scoreRef: `task/${row.taskId}`,
    })),
    ...taskReviewRows(agenda.awaitingAdjudication, "adjudicate", "views.agenda.hintAdjudicate", (row) => ({
      since: row.submittedAt,
      scoreRef: `execution/${row.executionId}`,
    })),
    ...taskReviewRows(agenda.underReview, "taskReviewing", "views.agenda.hintTaskReviewing", (row) => ({
      since: row.submittedAt,
      scoreRef: `execution/${row.executionId}`,
    })),
    ...decisionAgendaRows(agenda).map((decision) => ({
      id: decision.decisionId,
      title: decision.title,
      hint: t(GROUP_HINTS[decision.group]),
      group: decision.group,
      since: null,
      scoreRef: `decision/${decision.decisionId}`,
      target: decisionAgendaRowRef(decision),
    })),
  ];
}

const GROUP_HINTS: Readonly<Record<DecisionReviewGroup, MessageKey>> = {
  dispose: "views.workspace.decisionReviewHintChangesRequested",
  review: "views.workspace.decisionReviewHintReviewRequired",
  reviewing: "views.workspace.decisionReviewHintReviewing",
  judge: "views.agenda.hintJudge",
};

export function AgendaView({
  repoId,
  agenda,
  agendaError,
  onNavigateEntity,
}: {
  readonly repoId: string;
  readonly agenda: AgendaSuccess | undefined;
  readonly agendaError: string | null;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [panel, setPanel] = useState<AwaitsPanelSubject | null>(null);
  const [detail, setDetail] = useState<AgendaRow | null>(null);
  const [filter, setFilter] = useState<AgendaFilter>("attn");
  const [search, setSearch] = useState("");

  const allRows = useMemo(() => (agenda === undefined ? [] : agendaRowsOf(agenda)), [agenda]);
  // 排序 = 注意力分倒序(daemon 同一分,GUI 不重推),不在切面里的行按组序垫底。
  const ordered = useMemo(() => {
    const scoreOf = new Map((agenda?.attentionItems ?? []).map((item) => [item.ref, item.attention.score] as const));
    return allRows
      .map((row, index) => ({
        row,
        index,
        score: row.scoreRef === null ? -1 : (scoreOf.get(row.scoreRef) ?? -1),
        groupRank: GROUP_ORDER.indexOf(row.group),
      }))
      .sort((a, b) => b.score - a.score || a.groupRank - b.groupRank || a.index - b.index)
      .map(({ row }) => row);
  }, [allRows, agenda]);

  const query = search.trim().toLocaleLowerCase();
  // 搜索覆盖筛选(样张同法):有查询时跨桶找,没有时按当前筛选桶显示。
  const visible = ordered.filter((row) =>
    query === ""
      ? filter === "all" || GROUP_BUCKET[row.group] === filter
      : `${row.title} ${row.hint}`.toLocaleLowerCase().includes(query),
  );

  const chips = (
    [
      ["attn", t("views.agenda.filterAttn")],
      ["follow", t("views.agenda.filterFollow")],
      ["all", t("views.agenda.filterAll")],
    ] as const
  ).map(([key, label]) => ({
    key,
    label,
    count: allRows.filter((row) => key === "all" || GROUP_BUCKET[row.group] === key).length,
  }));

  // 年龄随读面前进重算(与总览同法):不立计时器,读面刷新即新的一帧。
  const now = new Date().toISOString();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="agenda-view">
      <header className="flex flex-wrap items-baseline gap-3 px-5 pb-2 pt-4">
        <h1 className="ui-title font-semibold">{t("views.agenda.title")}</h1>
        <span className="ui-meta text-text-muted">{t("views.agenda.note")}</span>
        <span className="font-mono ui-body text-text-faint" data-testid="agenda-count">
          {visible.length}/{allRows.length}
        </span>
      </header>
      <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
        <input
          type="search"
          aria-label={t("views.agenda.title")}
          placeholder={t("views.agenda.searchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          data-testid="agenda-search"
          className="min-w-[220px] flex-1 rounded-xs border border-border bg-surface-raised px-3 py-1.5 ui-meta text-text outline-none placeholder:text-text-faint focus:border-border-strong"
        />
        <span data-testid="agenda-filter-chips">
          <FilterChips chips={chips} value={filter} onChange={setFilter} />
        </span>
      </div>
      <div className="min-h-0 flex-1 px-5 pb-4">
        {agendaError ? (
          <p role="alert" className="text-sm text-danger">
            {t("views.agenda.error", { message: agendaError })}
          </p>
        ) : agenda === undefined ? (
          <p className="text-sm text-text-muted">{t("views.agenda.loading")}</p>
        ) : (
          <>
            {agenda.status === "pending" ? (
              <p className="mb-2 font-mono ui-micro text-text-faint">
                {t("views.overviewView.decisionTilesCatchingUp", { revision: String(agenda.sourceRevision) })}
              </p>
            ) : null}
            {visible.length === 0 ? (
              <p className="text-sm text-text-muted">{t("views.agenda.empty")}</p>
            ) : (
              <div className="border-t border-border">
                {visible.map((row) => (
                  <div key={`${row.group}:${row.id}`} data-testid={`agenda-row-${row.id}`}>
                    <DenseRow
                      tag={<StatusTag tone={GROUP_TONE[row.group]} label={t(GROUP_LABEL[row.group])} />}
                      title={row.title}
                      reason={row.hint}
                      time={row.since === null ? undefined : ageOf(row.since, now)}
                      onClick={() => setDetail(row)}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <Drawer open={detail !== null} onClose={() => setDetail(null)} ariaLabel={detail?.title}>
        {detail !== null ? (
          <AgendaDetail
            detail={detail}
            now={now}
            onAnswer={(ask) => {
              setDetail(null);
              setPanel({ mode: "answer", row: ask });
            }}
            onOpenDetail={(target) => {
              setDetail(null);
              onNavigateEntity(target);
            }}
          />
        ) : null}
      </Drawer>
      {panel ? (
        <AwaitsAnswerPanel
          repoId={repoId}
          subject={panel}
          onClose={() => setPanel(null)}
          onNavigateEntity={(ref) => {
            setPanel(null);
            onNavigateEntity(ref);
          }}
        />
      ) : null}
    </div>
  );
}

/** 抽屉体(标准 §2.4):行只给结论,问题原文与动作在这里。 */
function AgendaDetail({
  detail,
  now,
  onAnswer,
  onOpenDetail,
}: {
  readonly detail: AgendaRow;
  readonly now: string;
  readonly onAnswer: (ask: AgendaAwaitsRow) => void;
  readonly onOpenDetail: (target: string) => void;
}) {
  const ask = detail.ask;
  return (
    <div className="flex flex-col gap-3">
      <StatusTag tone={GROUP_TONE[detail.group]} label={t(GROUP_LABEL[detail.group])} />
      <h2 className="ui-title text-text">
        <TitleText title={detail.title} />
      </h2>
      <p className="ui-meta text-text-muted">{detail.hint}</p>
      {detail.since !== null ? (
        <p className="font-mono ui-meta text-text-faint">
          {t("views.agenda.waitingSince")} {ageOf(detail.since, now)}
        </p>
      ) : null}
      <div className="mt-1 flex flex-wrap gap-1.5">
        {ask !== undefined ? (
          <button
            type="button"
            data-testid="agenda-drawer-answer"
            onClick={() => onAnswer(ask)}
            className="h-7 rounded-xs border border-accent/40 bg-accent/20 px-3 text-accent ui-meta hover:bg-accent/30"
          >
            {t("components.awaitsAnswer.openAnswer")}
          </button>
        ) : null}
        <button
          type="button"
          data-testid="agenda-drawer-open"
          onClick={() => onOpenDetail(detail.target)}
          className="h-7 rounded-xs border border-border bg-text/10 px-3 text-text-muted ui-meta hover:text-text"
        >
          {t("views.agenda.openDetail")}
        </button>
      </div>
    </div>
  );
}

/** 评审返回 / 待初审 / 任务评审中:行只取读面的 taskId 与标题,落任务详情的收口页签。 */
function taskReviewRows<T extends { readonly taskId: string; readonly title: string }>(
  rows: readonly T[],
  group: "rework" | "adjudicate" | "taskReviewing",
  hint: MessageKey,
  metaOf: (row: T) => { readonly since: string | null; readonly scoreRef: string },
): AgendaRow[] {
  return rows.map((row) => ({
    id: row.taskId,
    title: row.title,
    hint: t(hint),
    group,
    ...metaOf(row),
    target: taskReviewRef(row.taskId),
  }));
}
