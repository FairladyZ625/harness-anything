import { useAgendaAdvisories } from "../agenda-advisories.ts";
import { useMemo, useState } from "react";
import type { AgendaSuccess } from "../api-client.ts";
import { t } from "../i18n/index.tsx";
import { type AwaitsPanelSubject } from "../awaits-answer.ts";
import { AwaitsAnswerPanel } from "../components/AwaitsAnswerPanel.tsx";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { Drawer } from "../components/primitives/Drawer.tsx";
import { FilterChips } from "../components/primitives/FilterChips.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { StatusTag } from "../components/primitives/StatusTag.tsx";
import { TitleText } from "../components/primitives/TitleText.tsx";
import {
  agendaRowsOf,
  GROUP_BUCKET,
  GROUP_LABEL,
  GROUP_ORDER,
  GROUP_TONE,
  type AgendaFilter,
  type AgendaRow,
} from "../model/agenda-rows.ts";
import { formatListTime, formatRelative } from "../model/time.ts";
import type { AgendaAwaitsRow } from "../../api/renderer-dto.ts";

/**
 * 议程(标准 §2.4 列表页;dec_DC3A1BB9 是它的唯一归处):回答「现在该推进哪几件事、
 * 哪些卡住」。行与组全部取总览同一条议程读面(repo.agenda.read),不另发请求、不逐条
 * 读 Decision;排序用 daemon 的注意力分(与 CLI 同序,attain 不出的行按组序垫底)。
 * 顶部 FilterChips 带计数 + 页内搜索,默认「需要关注」(下一步是你的行),不默认全量;
 * 行用 DenseRow、状态用有底色的 StatusTag;点行开抽屉,答复在抽屉里就地进答复面板,
 * 其余给「打开完整详情」落逐项回应 / 评审页签 / 评审会话 / 裁决页签 / 源实体详情。
 * 行派生与「重构 › 今天」页共用 model/agenda-rows.ts(dec_C612E69B7C7E3480A5F9D2CAD3)。
 */
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
  const advisoryRead = useAgendaAdvisories(repoId, allRows);
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
      <PageHeader
        title={t("views.agenda.title")}
        note={t("views.agenda.note")}
        meta={
          <span data-testid="agenda-count">
            {visible.length}/{allRows.length}
          </span>
        }
      />
      <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
        <span data-testid="agenda-filter-chips">
          <FilterChips chips={chips} value={filter} onChange={setFilter} />
        </span>
        <input
          type="search"
          aria-label={t("views.agenda.title")}
          placeholder={t("views.agenda.searchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          data-testid="agenda-search"
          className="min-w-[200px] flex-1 rounded-xs border border-border bg-surface-raised px-3 py-1.5 ui-meta text-text outline-none placeholder:text-text-faint focus:border-border-strong"
        />
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
            {advisoryRead.error ? (
              <p role="alert" className="ui-meta text-danger">
                {t("views.agenda.advisoryReadError", { error: String(advisoryRead.error) })}
              </p>
            ) : null}
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
                      tag={
                        <>
                          <StatusTag tone={GROUP_TONE[row.group]} label={t(GROUP_LABEL[row.group])} />
                          {advisoryRead.advisories.has(
                            /^task(?:review)?\/([^/]+)/u.exec(row.target ?? "")?.[1] ?? "",
                          ) ? (
                            <StatusTag
                              testId="agenda-advisory-tag"
                              tone="neutral"
                              label={t("views.dispatch.advisory")}
                            />
                          ) : null}
                        </>
                      }
                      title={row.title}
                      reason={row.hint}
                      time={row.since === null ? undefined : formatListTime(row.since, { now })}
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
  const target = detail.target;
  return (
    <div className="flex flex-col gap-3">
      <StatusTag tone={GROUP_TONE[detail.group]} label={t(GROUP_LABEL[detail.group])} />
      <h2 className="ui-title text-text">
        <TitleText title={detail.title} />
      </h2>
      <p className="ui-meta text-text-muted">{detail.hint}</p>
      {detail.since !== null ? (
        <p className="font-mono ui-meta text-text-faint">
          {t("views.agenda.waitingSince", { age: formatRelative(detail.since, { now }) })}
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
        {target !== null ? (
          <button
            type="button"
            data-testid="agenda-drawer-open"
            onClick={() => onOpenDetail(target)}
            className="h-7 rounded-xs border border-border bg-text/10 px-3 text-text-muted ui-meta hover:text-text"
          >
            {t("views.agenda.openDetail")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
