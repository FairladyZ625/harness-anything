import type { ReactNode } from "react";
import { t } from "../../i18n/index.tsx";
import { sessionStatusKey, sessionUnattributedKey, type SessionStatus } from "../../sessions-model.ts";
import { decisionSessionsRef } from "../../navigation/decisionReviewRoutes.ts";
import { SegCtl } from "../runtime/parts.tsx";
import { DenseRow, RowTime } from "../primitives/DenseRow.tsx";
import { Region } from "../primitives/Region.tsx";
import { StatusTag, type StatusTone } from "../primitives/StatusTag.tsx";
import {
  FLEET_HISTORY_RANGES,
  FLEET_RESULT_ROWS,
  type FleetExecutionRow,
  type FleetExecutionSnapshot,
  type FleetHistoryRange,
  type FleetTaskClaim,
} from "../../model/cadence-fleet.ts";

/**
 * 执行概况页签:回答「谁在做什么、哪条执行失败了、最近的结果是什么」。数据是一条
 * sessionGroups 有界读面(groupBy=task,无成员级筛选),三区全部从组自身的
 * runningCount + latestStatus 推——daemon 保证 live 会话不被历史窗口切掉,所以
 * 「正在执行」永远是全量;异常与结果是「已加载范围内的记录」,截断时 footer 与
 * 空态都如实说。运行中不等于有进展,成功会话不叫「已交付」;任务已 done/cancelled/
 * archived 的失败行照列,但行上声明任务当前状态,不叫人处理(恢复入口在会话详情)。
 */

/** 会话状态词 → 标签色:与会话页同一份状态词表(sessionStatusKey),失败红、结果不明琥珀。 */
const STATUS_TONE: Readonly<Record<SessionStatus, StatusTone>> = {
  running: "active",
  succeeded: "done",
  failed: "bad",
  cancelled: "cancel",
  unknown: "neutral",
  lost: "wait",
  unavailable: "wait",
  "ended-indeterminate": "wait",
};

const CLAIM_KEY: Readonly<Record<Exclude<FleetTaskClaim, null>, string>> = {
  awaiting: "views.cadence.fleetTaskAwaiting",
  done: "views.cadence.fleetTaskDone",
  cancelled: "views.cadence.fleetTaskCancelled",
  archived: "views.cadence.fleetTaskArchived",
  unknown: "views.cadence.fleetTaskUnknown",
};

/** 行主点击落点:任务组展开会话页该组,decision 组落决策会话,未归属桶直达会话详情。 */
function rowSessionRef(row: FleetExecutionRow): string | null {
  if (row.taskId !== null) return `tasksessions/${row.taskId}`;
  if (row.decisionId !== null) return decisionSessionsRef(row.decisionId, row.runtimeSessionId);
  return row.runtimeSessionId === null ? null : `session/${row.runtimeSessionId}`;
}

function rowTitle(row: FleetExecutionRow): string {
  if (row.unattributedKey === null) return row.title;
  const key = sessionUnattributedKey[row.unattributedKey as keyof typeof sessionUnattributedKey];
  return key === undefined ? row.title : t(key as never);
}

function claimText(row: FleetExecutionRow): string {
  return row.taskClaim === null ? "" : t(CLAIM_KEY[row.taskClaim] as never);
}

function FleetRow({
  row,
  meta,
  onNavigateEntity,
}: {
  readonly row: FleetExecutionRow;
  readonly meta: ReactNode;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const target = rowSessionRef(row);
  return (
    <div data-testid="cadence-fleet-row">
      <DenseRow
        relaxed
        tag={<StatusTag tone={STATUS_TONE[row.latestStatus]} label={t(sessionStatusKey[row.latestStatus] as never)} />}
        title={rowTitle(row)}
        reason={meta}
        time={row.latestActivityAt === "" ? undefined : <RowTime at={row.latestActivityAt} />}
        hoverTitle={row.taskId ?? row.decisionId ?? undefined}
        onClick={target === null ? undefined : () => onNavigateEntity(target)}
        action={
          row.taskId === null ? undefined : (
            <button
              type="button"
              data-testid="cadence-fleet-row-task"
              onClick={() => onNavigateEntity(`task/${row.taskId}`)}
              className="rounded bg-accent/10 px-2.5 py-1 font-mono ui-meta text-accent transition-colors hover:bg-accent/20"
            >
              {t("views.cadence.fleetTaskAction")}
            </button>
          )
        }
      />
    </div>
  );
}

function EmptyNote({ children }: { readonly children: ReactNode }) {
  return <p className="px-3.5 py-2.5 ui-meta text-text-faint">{children}</p>;
}

export function FleetPulsePane({
  snapshot,
  pending,
  error,
  selectedRange,
  onSelectRange,
  onNavigateEntity,
}: {
  readonly snapshot: FleetExecutionSnapshot;
  readonly pending: boolean;
  readonly error: string | null;
  readonly selectedRange: FleetHistoryRange;
  readonly onSelectRange: (range: FleetHistoryRange) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const rangeLabel = t(`views.cadence.fleetWindow.${selectedRange}`),
    results = snapshot.results.slice(0, FLEET_RESULT_ROWS);
  return (
    <div data-testid="cadence-fleet" className="@container flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      {/* 范围切换统一用分段控件(标准 §2.3);时间窗只筛历史两区,「正在执行」不受它影响。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2.5">
        <p className="ui-meta text-text-faint">{t("views.cadence.fleetLead")}</p>
        <span className="ml-auto">
          <SegCtl
            label={t("views.cadence.fleetHistoryRangeLabel")}
            value={selectedRange}
            onChange={onSelectRange}
            options={FLEET_HISTORY_RANGES.map((range) => ({
              value: range,
              label: t(`views.cadence.fleetWindow.${range}`),
            }))}
          />
        </span>
      </div>
      {error !== null ? (
        <p
          role="alert"
          data-testid="cadence-fleet-error"
          className="shrink-0 border-b border-border bg-status-blocked/10 px-3.5 py-1.5 font-mono ui-micro text-status-blocked"
        >
          {t("agentRuntime.readFailed", { error })}
        </p>
      ) : pending ? (
        <p data-testid="cadence-fleet-pending" className="shrink-0 px-0.5 py-2 ui-meta text-text-faint">
          {t("agentRuntime.loading")}
        </p>
      ) : (
        <>
          <div className="grid shrink-0 gap-3 @[640px]:grid-cols-2">
            <Region title={t("views.cadence.fleetExecutingTitle")} big={snapshot.executing.length}>
              {snapshot.executing.length === 0 ? (
                <div data-testid="cadence-fleet-executing">
                  <EmptyNote>{t("views.cadence.fleetExecutingEmpty")}</EmptyNote>
                </div>
              ) : (
                <div data-testid="cadence-fleet-executing" className="flex flex-col">
                  {snapshot.executing.map((row) => (
                    <FleetRow
                      key={row.key}
                      row={row}
                      meta={
                        row.currentExecutor ? (
                          <>
                            {row.agentName ?? row.instanceId} · {row.instanceId} ·{" "}
                            {t("views.cadence.fleetRoundSuffix", { count: row.roundCount })}
                          </>
                        ) : (
                          // 最新一轮已结束:只说几个会话在跑,不把已结束者指为当前执行人。
                          t("views.cadence.fleetExecutingSessions", { count: row.runningCount })
                        )
                      }
                      onNavigateEntity={onNavigateEntity}
                    />
                  ))}
                </div>
              )}
            </Region>
            <Region
              title={t("views.cadence.fleetAnomalyTitle")}
              edge={snapshot.anomalies.length > 0 ? "bad" : undefined}
              big={snapshot.anomalies.length}
            >
              {snapshot.anomalies.length === 0 ? (
                <div data-testid="cadence-fleet-anomaly">
                  <EmptyNote>{t("views.cadence.fleetAnomalyEmpty")}</EmptyNote>
                </div>
              ) : (
                <div data-testid="cadence-fleet-anomaly" className="flex flex-col">
                  {snapshot.anomalies.map((row) => (
                    <FleetRow
                      key={row.key}
                      row={row}
                      meta={
                        <>
                          {row.agentName ?? row.instanceId}
                          {claimText(row) === "" ? "" : ` · ${claimText(row)}`}
                        </>
                      }
                      onNavigateEntity={onNavigateEntity}
                    />
                  ))}
                </div>
              )}
            </Region>
          </div>
          <Region
            title={t("views.cadence.fleetResultsTitle")}
            big={snapshot.results.length}
            footer={
              snapshot.loadedGroups > results.length
                ? t("views.cadence.fleetResultsCapped", { shown: results.length, loaded: snapshot.loadedGroups })
                : undefined
            }
          >
            {snapshot.results.length === 0 ? (
              <div data-testid="cadence-fleet-results">
                <EmptyNote>{t("views.cadence.fleetResultsEmpty")}</EmptyNote>
              </div>
            ) : (
              <div data-testid="cadence-fleet-results" className="flex flex-col">
                {results.map((row) => (
                  <FleetRow
                    key={row.key}
                    row={row}
                    meta={
                      <>
                        {row.agentName ?? row.instanceId}
                        {claimText(row) === "" ? "" : ` · ${claimText(row)}`}
                      </>
                    }
                    onNavigateEntity={onNavigateEntity}
                  />
                ))}
              </div>
            )}
          </Region>
          {/* 口径行:窗口/总数是 daemon 按过滤后的集合算的,截断时明确「行只是已加载部分」。 */}
          <p data-testid="cadence-fleet-scope" className="shrink-0 ui-micro text-text-faint">
            {t("views.cadence.fleetFooterWindow", { range: rangeLabel })} ·{" "}
            {t("views.cadence.fleetFooterCounts", {
              groups: snapshot.totals.groups,
              sessions: snapshot.totals.sessions,
            })}{" "}
            · {t("views.cadence.fleetFooterLoaded", { loaded: snapshot.loadedGroups })}
            {snapshot.truncated ? ` · ${t("views.cadence.fleetFooterTruncated")}` : ""}
          </p>
        </>
      )}
    </div>
  );
}
