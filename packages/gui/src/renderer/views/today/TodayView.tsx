import { useMemo, useState } from "react";
import type { AgentRuntimeSessionGroupsResult } from "@harness-anything/daemon/protocol";
import type { AgendaSuccess } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import { type AwaitsPanelSubject } from "../../awaits-answer.ts";
import { AwaitsAnswerPanel } from "../../components/AwaitsAnswerPanel.tsx";
import { DenseRow, RowTime } from "../../components/primitives/DenseRow.tsx";
import { Drawer } from "../../components/primitives/Drawer.tsx";
import { Empty } from "../../components/primitives/Empty.tsx";
import { PageHeader } from "../../components/primitives/PageHeader.tsx";
import { Region } from "../../components/primitives/Region.tsx";
import { StatusTag, type StatusTone } from "../../components/primitives/StatusTag.tsx";
import { TitleText } from "../../components/primitives/TitleText.tsx";
import {
  agendaRowsOf,
  GROUP_BUCKET,
  GROUP_LABEL,
  GROUP_ORDER,
  GROUP_TONE,
  type AgendaRow,
} from "../../model/agenda-rows.ts";
import { formatDuration, formatRelative, formatTime } from "../../model/time.ts";
import { sessionStatusKey, type SessionStatus } from "../../sessions-model.ts";
import { CADENCE_STALLED_AFTER_MS } from "../../model/cadence.ts";
import { deliveredRows, useTodayRecentEvents, useTodaySessionGroups } from "./today-data.ts";

/**
 * 重构区第一个页面:「今天」(dec_C612E69B7C7E3480A5F9D2CAD3 CH1;规格 =
 * overall-restructure-proposal「一个中心:今天」)。打开即回答三件事,每件一个数:
 * 等你处理(需要本人动手;行集出自与议程页共用的 agendaRowsOf,attn 桶计数与议程
 * 「需要关注」同数)、正在跑(哪些 agent 为哪件事干活、跑了多久、是否卡住)、刚交付
 * (最近完成、点开即看)。首屏不出现 ID、revision、事件流与总量统计;下钻走
 * 「行 → 单层抽屉 → 完整详情」,能就地办的(答复)直接开答复面板。
 */
export function TodayView({
  repoId,
  agenda,
  agendaError,
  titles,
  onNavigateEntity,
  onOpenTask,
  onOpenAgenda,
  onOpenSessions,
}: {
  readonly repoId: string;
  readonly agenda: AgendaSuccess | undefined;
  readonly agendaError: string | null;
  /** `task/<id>` → 标题(App 常驻任务投影);刚交付行的任务名从这取。 */
  readonly titles: ReadonlyMap<string, string>;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenAgenda: () => void;
  readonly onOpenSessions: () => void;
}) {
  const [panel, setPanel] = useState<AwaitsPanelSubject | null>(null);
  const [waitingDetail, setWaitingDetail] = useState<AgendaRow | null>(null);
  const [runningDetail, setRunningDetail] = useState<RunningRow | null>(null);
  const groupsQuery = useTodaySessionGroups(repoId);
  const eventsQuery = useTodayRecentEvents(repoId);
  const groupsErrorText = groupsQuery.error instanceof Error ? groupsQuery.error.message : null;

  // 等你处理:议程 attn 桶(需要关注)——行集出自与议程页共用的 agendaRowsOf,排序同法
  //(注意力分倒序,不在切面里的行按组序垫底),计数结构性等于议程页「需要关注」。
  const waitingRows = useMemo(() => {
    if (agenda === undefined) return [];
    const scoreOf = new Map((agenda.attentionItems ?? []).map((item) => [item.ref, item.attention.score] as const));
    return agendaRowsOf(agenda)
      .filter((row) => GROUP_BUCKET[row.group] === "attn")
      .map((row, index) => ({
        row,
        index,
        score: row.scoreRef === null ? -1 : (scoreOf.get(row.scoreRef) ?? -1),
        groupRank: GROUP_ORDER.indexOf(row.group),
      }))
      .sort((a, b) => b.score - a.score || a.groupRank - b.groupRank || a.index - b.index)
      .map(({ row }) => row);
  }, [agenda]);

  // 年龄与停滞都由当前已读数据帧判断,不立单独计时器。
  const now = useMemo(() => new Date().toISOString(), [agenda, groupsQuery.data, eventsQuery.dataUpdatedAt]);

  // 正在跑:会话组里还有 live 会话的任务,每任务一行;N = 在跑会话总数。
  const runningRows = useMemo(() => runningRowsOf(groupsQuery.data, Date.parse(now)), [groupsQuery.data, now]);
  const runningTotal = runningRows.reduce((total, row) => total + row.runningCount, 0);
  // 刚交付:最近事件页里的 task_completed,新→旧。
  const delivered = useMemo(() => deliveredRows(eventsQuery.data ?? []), [eventsQuery.data]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="today-view">
      <PageHeader title={t("views.today.title")} testId="today-header" />
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1" data-testid="today-board">
        <div className="grid min-w-0">
          <Region
            title={regionTitle(
              t("views.today.regionWaiting"),
              agenda === undefined ? (agendaError !== null ? "—" : "…") : waitingRows.length,
              waitingRows.length > 0 ? "text-danger" : "text-text-muted",
            )}
            edge={waitingRows.length > 0 ? "bad" : undefined}
            footer={
              <button
                type="button"
                data-testid="today-waiting-open-agenda"
                onClick={onOpenAgenda}
                className="ml-auto text-accent underline-offset-2 hover:underline"
              >
                {t("views.today.waitingOpenAgenda")}
              </button>
            }
          >
            {agendaError !== null ? (
              <p role="alert" className="px-3.5 py-2 text-sm text-danger">
                {t("views.today.readError", { message: agendaError })}
              </p>
            ) : agenda === undefined ? (
              <p className="px-3.5 py-2 text-sm text-text-muted">{t("views.today.loading")}</p>
            ) : waitingRows.length === 0 ? (
              <div className="px-3.5 py-2">
                <Empty>{t("views.today.emptyWaiting")}</Empty>
              </div>
            ) : (
              <div data-testid="today-waiting-rows">
                {waitingRows.map((row) => (
                  <WaitingRow
                    key={`${row.group}:${row.id}`}
                    row={row}
                    onAnswer={(ask) => setPanel({ mode: "answer", row: ask })}
                    onOpenDetail={() => setWaitingDetail(row)}
                  />
                ))}
              </div>
            )}
          </Region>
        </div>

        <div className="grid min-w-0">
          <Region
            title={regionTitle(
              t("views.today.regionRunning"),
              groupsQuery.data === undefined ? (groupsErrorText !== null ? "—" : "…") : runningTotal,
              runningTotal > 0 ? "text-accent" : "text-text-muted",
            )}
            footer={
              <button
                type="button"
                data-testid="today-running-open-sessions"
                onClick={onOpenSessions}
                className="ml-auto text-accent underline-offset-2 hover:underline"
              >
                {t("views.today.runningOpenSessions")}
              </button>
            }
          >
            {groupsErrorText !== null ? (
              <p role="alert" className="px-3.5 py-2 text-sm text-danger">
                {t("views.today.readError", { message: groupsErrorText })}
              </p>
            ) : groupsQuery.data === undefined ? (
              <p className="px-3.5 py-2 text-sm text-text-muted">{t("views.today.loading")}</p>
            ) : runningRows.length === 0 ? (
              <div className="px-3.5 py-2">
                <Empty>{t("views.today.emptyRunning")}</Empty>
              </div>
            ) : (
              <div data-testid="today-running-rows">
                {runningRows.slice(0, 5).map((row) => (
                  <div key={row.key} data-testid={`today-running-row-${row.taskId ?? row.key}`}>
                    <DenseRow
                      relaxed
                      tag={
                        <StatusTag tone={RUNNING_TONE[row.status]} label={t(sessionStatusKey[row.status] as never)} />
                      }
                      title={row.title}
                      reason={
                        row.runningCount > 1
                          ? t("views.today.runningAgentSessions", {
                              agent: row.agent ?? "—",
                              count: String(row.runningCount),
                            })
                          : (row.agent ?? undefined)
                      }
                      time={
                        row.startedAt === null ? undefined : (
                          <span title={formatTime(row.startedAt, { style: "date-time-seconds" }) ?? undefined}>
                            {formatDuration(Date.parse(now) - Date.parse(row.startedAt))}
                          </span>
                        )
                      }
                      onClick={() => setRunningDetail(row)}
                    />
                  </div>
                ))}
                {runningRows.length > 5 ? (
                  <p className="px-3.5 py-2 text-sm text-text-muted">
                    {t("views.today.runningMore", { count: String(runningRows.length - 5) })}
                  </p>
                ) : null}
              </div>
            )}
          </Region>
        </div>

        <div className="grid min-w-0">
          <Region
            title={regionTitle(
              t("views.today.regionDelivered"),
              eventsQuery.data === undefined ? (eventsQuery.error !== null ? "—" : "…") : delivered.length,
              delivered.length > 0 ? "text-success" : "text-text-muted",
            )}
          >
            {eventsQuery.error !== null ? (
              <p role="alert" className="px-3.5 py-2 text-sm text-danger">
                {t("views.today.readError", {
                  message: eventsQuery.error instanceof Error ? eventsQuery.error.message : String(eventsQuery.error),
                })}
              </p>
            ) : eventsQuery.data === undefined ? (
              <p className="px-3.5 py-2 text-sm text-text-muted">{t("views.today.loading")}</p>
            ) : delivered.length === 0 ? (
              <div className="px-3.5 py-2">
                <Empty>{t("views.today.emptyDelivered")}</Empty>
              </div>
            ) : (
              <div data-testid="today-delivered-rows">
                {delivered.map((row) => (
                  <div key={row.key} data-testid={`today-delivered-row-${row.taskId}`}>
                    <DenseRow
                      tag={<StatusTag tone="done" label={t("views.today.deliveredKind")} />}
                      title={titles.get(row.taskId) ?? t("views.today.deliveredUntitled")}
                      reason={row.summary ?? t("views.today.deliveredReason")}
                      hoverTitle={row.taskId}
                      time={row.at === null ? undefined : <RowTime at={row.at} />}
                      onClick={() => onOpenTask(row.taskId)}
                    />
                  </div>
                ))}
              </div>
            )}
          </Region>
        </div>
      </div>

      {/* 单层抽屉:等你处理行(非就地答复类)与正在跑行的摘要层,内给「打开完整详情」。 */}
      <Drawer open={waitingDetail !== null} onClose={() => setWaitingDetail(null)} ariaLabel={waitingDetail?.title}>
        {waitingDetail !== null ? (
          <div className="flex flex-col gap-3">
            <StatusTag tone={GROUP_TONE[waitingDetail.group]} label={t(GROUP_LABEL[waitingDetail.group])} />
            <h2 className="ui-title text-text">
              <TitleText title={waitingDetail.title} />
            </h2>
            <p className="ui-meta text-text-muted">{waitingDetail.hint}</p>
            {waitingDetail.since !== null ? (
              <p className="font-mono ui-meta text-text-faint">
                {t("views.today.waitingSince", { age: formatRelative(waitingDetail.since, { now }) })}
              </p>
            ) : null}
            <div className="mt-1 flex flex-wrap gap-1.5">
              <button
                type="button"
                data-testid="today-drawer-open"
                onClick={() => {
                  const target = waitingDetail.target;
                  setWaitingDetail(null);
                  onNavigateEntity(target);
                }}
                className="h-7 rounded-xs border border-border bg-text/10 px-3 text-text-muted ui-meta hover:text-text"
              >
                {t("views.today.actionOpenDetail")}
              </button>
            </div>
          </div>
        ) : null}
      </Drawer>
      <Drawer open={runningDetail !== null} onClose={() => setRunningDetail(null)} ariaLabel={runningDetail?.title}>
        {runningDetail !== null ? <RunningDetail detail={runningDetail} now={now} onOpenTask={onOpenTask} /> : null}
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

function regionTitle(label: string, value: number | string, valueClass: string) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{label}</span>
      <span className={`font-mono font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </span>
  );
}

/** 等你处理行:awaits 行的首要动作是就地答复,其余行的首要动作是打开单层抽屉。 */ function WaitingRow({
  row,
  onAnswer,
  onOpenDetail,
}: {
  readonly row: AgendaRow;
  readonly onAnswer: (ask: NonNullable<AgendaRow["ask"]>) => void;
  readonly onOpenDetail: () => void;
}) {
  const ask = row.ask;
  return (
    <div data-testid={`today-waiting-row-${row.id}`}>
      <DenseRow
        relaxed
        tag={<StatusTag tone={GROUP_TONE[row.group]} label={t(GROUP_LABEL[row.group])} />}
        title={row.title}
        reason={row.hint}
        time={row.since === null ? undefined : <RowTime at={row.since} />}
        action={
          ask !== undefined ? (
            <button
              type="button"
              data-testid={`today-answer-${row.id}`}
              onClick={() => onAnswer(ask)}
              className="h-7 rounded-xs border border-accent/40 bg-accent/20 px-3 text-accent ui-meta hover:bg-accent/30"
            >
              {t("views.today.actionAnswer")}
            </button>
          ) : (
            <button
              type="button"
              data-testid={`today-handle-${row.id}`}
              onClick={onOpenDetail}
              className="h-7 rounded-xs border border-border bg-text/10 px-3 text-text-muted ui-meta hover:text-text"
            >
              {t("views.today.actionHandle")}
            </button>
          )
        }
        onClick={onOpenDetail}
      />
    </div>
  );
}

/** 正在跑行的抽屉体:谁在跑、从何时起、卡住原因,出口是任务详情。 */
function RunningDetail({
  detail,
  now,
  onOpenTask,
}: {
  readonly detail: RunningRow;
  readonly now: string;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const startedAt = detail.startedAt,
    taskId = detail.taskId;
  return (
    <div className="flex flex-col gap-3">
      <StatusTag tone={RUNNING_TONE[detail.status]} label={t(sessionStatusKey[detail.status] as never)} />
      <h2 className="ui-title text-text">
        <TitleText title={detail.title} />
      </h2>
      <p className="ui-meta text-text-muted">
        {detail.runningCount > 1
          ? t("views.today.runningAgentSessions", { agent: detail.agent ?? "—", count: String(detail.runningCount) })
          : detail.agent}
      </p>
      {startedAt !== null ? (
        <p className="font-mono ui-meta text-text-faint">
          {t("views.today.runningFor", {
            age: formatDuration(Date.parse(now) - Date.parse(startedAt)),
            at: formatTime(startedAt, { style: "date-time-seconds" }) ?? "",
          })}
        </p>
      ) : null}
      {detail.reason !== null ? <p className="ui-meta text-text-muted">{detail.reason}</p> : null}
      {taskId !== null ? (
        <div className="mt-1 flex flex-wrap gap-1.5">
          <button
            type="button"
            data-testid="today-running-drawer-open"
            onClick={() => onOpenTask(taskId)}
            className="h-7 rounded-xs border border-border bg-text/10 px-3 text-text-muted ui-meta hover:text-text"
          >
            {t("views.today.actionOpenTask")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 正在跑一行:会话组读面的 task 组(runningCount > 0),谁是执行者、从何时起、卡没卡。 */
export interface RunningRow {
  readonly key: string;
  readonly taskId: string | null;
  readonly title: string;
  readonly agent: string | null;
  readonly startedAt: string | null;
  readonly lastActivityAt: string;
  readonly status: SessionStatus;
  readonly runningCount: number;
  readonly reason: string | null;
}

export function runningRowsOf(
  groups: AgentRuntimeSessionGroupsResult | undefined,
  now = Date.now(),
): readonly RunningRow[] {
  if (groups === undefined) return [];
  return groups.groups
    .filter((group) => group.runningCount > 0)
    .map((group) => ({
      key: group.key,
      taskId: group.taskId ?? null,
      title: group.label,
      agent: group.latestRound?.agentName ?? group.latestRound?.instanceId ?? null,
      startedAt: group.latestRound?.startedAt ?? null,
      lastActivityAt: group.latestActivityAt,
      status:
        group.latestStatus === "running" && now - Date.parse(group.latestActivityAt) > CADENCE_STALLED_AFTER_MS
          ? "blocked"
          : group.latestStatus,
      runningCount: group.runningCount,
      reason: group.latestRound?.reason ?? null,
    }))
    .sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt));
}

/** 会话组状态 → 标签色:在跑用「在做」青蓝;卡住(blocked/lost/failed)用红;其余中性。 */
const RUNNING_TONE: Readonly<Record<SessionStatus, StatusTone>> = {
  running: "active",
  succeeded: "done",
  failed: "bad",
  cancelled: "cancel",
  unknown: "neutral",
  lost: "bad",
  unavailable: "neutral",
  "ended-indeterminate": "neutral",
  stopped: "neutral",
  blocked: "bad",
};
