import { t } from "../../i18n/index.tsx";
import { formatDuration } from "../../model/time.ts";
import { SegCtl } from "../runtime/parts.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { DenseRow, RowTime } from "../primitives/DenseRow.tsx";
import { Region } from "../primitives/Region.tsx";
import { SegBar } from "../primitives/SegBar.tsx";
import { StatusTag, type StatusTone } from "../primitives/StatusTag.tsx";
import {
  FLEET_TIME_WINDOWS,
  type FleetPulseSnapshot,
  type FleetTimeWindow,
  type FleetWorkerRow,
} from "../../model/cadence-fleet.ts";

/**
 * 舰队页签:回答「谁在执行哪个任务、工作是否流动、有无并发冲突」。任务标题来自
 * deriveFleetPulse 里 tasks 投影行的 title,不为每行另拉全文;ID 弱化——只做悬停
 * title 与行尾弱色,不再当主文本。
 *
 * 外壳是 Region(标准 §2.1):顶部概况条(任务流动 + 并发防撞,内容高度,容器 ≥640px
 * 时并排),下面是 Worker 活动列表。区域按内容收高:少量实例不出现通高空框,留白
 * 落在页面背景;列表长了在 Region 内部滚动(16rem 保底),概况条常驻不滚走。
 * 时间窗只筛实例列表;流动比/周转/防撞是任务池与事件窗口口径,不随时间窗变化,
 * 范围写在区域页脚——不把累计数标成所选窗口的指标。
 */

/** 状态→标签档(标准 §3):活跃/空闲是正常运行,中性或灰蓝;只有失败红、成功绿。 */
function workerTone(worker: FleetWorkerRow): StatusTone {
  if (worker.status === "live") return "neutral";
  if (worker.status === "idle") return "plan";
  if (worker.outcome === "failed") return "bad";
  if (worker.outcome === "succeeded") return "done";
  if (worker.outcome === "cancelled") return "cancel";
  return "neutral";
}

function statusBadge(worker: FleetWorkerRow): string {
  if (worker.status === "live") return t("views.cadence.fleetStatus.live");
  if (worker.status === "idle") return t("views.cadence.fleetStatus.idle");
  if (worker.outcome === "succeeded") return t("views.cadence.fleetOutcome.succeeded");
  if (worker.outcome === "failed") return t("views.cadence.fleetOutcome.failed");
  if (worker.outcome === "cancelled") return t("views.cadence.fleetOutcome.cancelled");
  if (worker.outcome === "unknown") return t("views.cadence.fleetOutcome.unknown");
  return t("views.cadence.fleetStatus.exited");
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function duration(value: number | null): string {
  if (value === null) return t("views.cadence.fleetTurnaroundUnknown");
  return formatDuration(value);
}

function WorkerRow({
  worker,
  onNavigateEntity,
}: {
  readonly worker: FleetWorkerRow;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const metrics = worker.metrics
    ? ` · ${t("views.cadence.fleetTokensCompact", {
        total: formatTokens(worker.metrics.totalTokens),
      })}`
    : "";
  return (
    <div data-testid="cadence-fleet-worker" className="contents">
      <DenseRow
        relaxed
        tag={<StatusTag tone={workerTone(worker)} label={statusBadge(worker)} />}
        title={worker.label}
        reason={
          <>
            {worker.tasks.length === 0
              ? t("views.cadence.fleetNoTasks")
              : worker.tasks.map((task, index) => (
                  <span key={task.taskId}>
                    {index > 0 ? <span className="mr-1.5">·</span> : null}
                    <EntityRefLink
                      entityRef={`task/${task.taskId}`}
                      onNavigate={onNavigateEntity}
                      title={task.taskId}
                      className="ui-meta text-accent hover:underline"
                    >
                      {task.title}
                    </EntityRefLink>
                  </span>
                ))}
            <span>
              {" — "}
              {t("views.cadence.fleetContribution", {
                facts: worker.facts,
                decisions: worker.decisions,
                files: worker.touchedFiles,
              })}
              {metrics}
            </span>
          </>
        }
        time={worker.lastActiveAt === null ? undefined : <RowTime at={worker.lastActiveAt} />}
        hoverTitle={
          worker.metrics
            ? `${worker.instanceId} · ${worker.runtimeSessionId} · ${t("views.cadence.fleetTokens", {
                total: formatTokens(worker.metrics.totalTokens),
                calls: worker.metrics.toolCalls,
              })}`
            : `${worker.instanceId} · ${worker.runtimeSessionId}`
        }
      />
    </div>
  );
}

export function FleetPulsePane({
  snapshot,
  selectedWindow,
  onSelectWindow,
  onNavigateEntity,
}: {
  readonly snapshot: FleetPulseSnapshot;
  readonly selectedWindow: FleetTimeWindow;
  readonly onSelectWindow: (window: FleetTimeWindow) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  return (
    <div data-testid="cadence-fleet" className="@container flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      {/* 概况条:内容高度,不撑满剩余空间;容器够宽时两块并排。 */}
      <div className="grid shrink-0 gap-3 @[640px]:grid-cols-2">
        <Region title={t("views.cadence.fleetFlowTitle")} footer={t("views.cadence.fleetFlowScope")}>
          <div data-testid="cadence-fleet-flow" className="flex flex-col">
            {/* 流动比分段条:待认领=灰蓝、在飞=青蓝、收口=绿,与全站状态色同源。 */}
            <div className="border-b border-border px-3.5 pb-2.5 pt-3">
              <SegBar
                counts={{ planned: snapshot.flow.claimed, active: snapshot.flow.inFlight, done: snapshot.flow.settled }}
              />
            </div>
            <DenseRow title={t("views.cadence.fleetFlowInFlight")} time={snapshot.flow.inFlight} />
            <DenseRow title={t("views.cadence.fleetFlowClaimed")} time={snapshot.flow.claimed} />
            <DenseRow title={t("views.cadence.fleetFlowSettled")} time={snapshot.flow.settled} />
            <DenseRow title={t("views.cadence.fleetTurnaroundTitle")} time={duration(snapshot.turnaroundMs)} />
          </div>
        </Region>
        <Region
          title={t("views.cadence.fleetFenceTitle")}
          edge={snapshot.collisions.length > 0 ? "bad" : undefined}
          big={snapshot.collisions.length > 0 ? snapshot.collisions.length : undefined}
          footer={t("views.cadence.fleetFenceScope")}
        >
          {snapshot.collisions.length === 0 ? (
            /* 空态收成一条状态点(标准 §1.5):正常不刷大绿。 */
            <p
              data-testid="cadence-fleet-fence"
              className="flex items-center gap-2 px-3.5 py-2.5 ui-meta text-text-faint"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-status-done" />
              {t("views.cadence.fleetFenceClean")}
            </p>
          ) : (
            <div data-testid="cadence-fleet-fence" className="flex flex-col">
              {snapshot.collisions.map(({ taskId, title, workerCount }) => (
                <DenseRow
                  key={taskId}
                  title={title}
                  hoverTitle={taskId}
                  time={t("views.cadence.fleetFenceTask", { count: workerCount })}
                  onClick={() => onNavigateEntity(`task/${taskId}`)}
                />
              ))}
            </div>
          )}
        </Region>
      </div>
      {/* 实例列表:少量实例时按内容收高(无通高空框),列表超长时占住剩余高度并区内滚动。 */}
      <div className="grid min-h-[16rem] shrink grid-rows-[minmax(0,1fr)]">
        <Region
          title={t("views.cadence.fleetWorkersTitle")}
          big={snapshot.workers.length}
          footer={t("views.cadence.fleetListScope")}
        >
          <div className="flex h-full flex-col">
            {/* 范围切换统一用分段控件 SegCtl(标准 §2.3);Region 标题行不放动作,固定在行体顶部。 */}
            <div className="flex-none border-b border-border px-3 pb-2 pt-0.5">
              <SegCtl
                label={t("views.cadence.fleetWindowTitle")}
                value={selectedWindow}
                onChange={onSelectWindow}
                options={FLEET_TIME_WINDOWS.map((win) => ({
                  value: win,
                  label: t(`views.cadence.fleetWindow.${win}`),
                }))}
              />
            </div>
            {snapshot.workers.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-3.5 py-8 text-center">
                <p className="ui-meta text-text-faint">
                  {selectedWindow === "active"
                    ? t("views.cadence.fleetActiveEmpty")
                    : t("views.cadence.fleetWorkersEmpty")}
                </p>
                {selectedWindow === "active" ? (
                  <button
                    type="button"
                    data-testid="cadence-fleet-switch-24h"
                    onClick={() => onSelectWindow("24h")}
                    className="mt-2.5 rounded bg-accent/10 px-3 py-1 font-mono ui-meta text-accent transition-colors hover:bg-accent/20"
                  >
                    {t("views.cadence.fleetSwitchTo24h")}
                  </button>
                ) : selectedWindow !== "all" ? (
                  <button
                    type="button"
                    data-testid="cadence-fleet-switch-all"
                    onClick={() => onSelectWindow("all")}
                    className="mt-2.5 rounded bg-accent/10 px-3 py-1 font-mono ui-meta text-accent transition-colors hover:bg-accent/20"
                  >
                    {t("views.cadence.fleetSwitchToAll")}
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {snapshot.workers.map((worker) => (
                  <WorkerRow key={worker.runtimeSessionId} worker={worker} onNavigateEntity={onNavigateEntity} />
                ))}
              </div>
            )}
          </div>
        </Region>
      </div>
    </div>
  );
}
