import { Fragment, useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.tsx";
import type { FleetOverviewEvent, FleetOverviewNode, FleetOverviewRead } from "../../api/renderer-dto.ts";
import { formatListTime } from "../model/time.ts";
import { RepoModeBadge, type RepoMode } from "../components/RepoModeBadge.tsx";
import { Empty } from "../components/primitives/Empty.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { Section } from "../components/primitives/Section.tsx";
import { Drawer } from "../components/primitives/Drawer.tsx";
import { READ_ERROR_LABELS, warningLabel } from "./collaboration/fleet-labels.ts";
import { FleetTopology } from "./collaboration/FleetTopology.tsx";
import { NodeDetails, nodeLabelOf } from "./collaboration/NodeDetails.tsx";

/**
 * 协作页:舰队拓扑(task_8ce646d94 数据层 + task_16c20131 视觉重做)。数据全部来自
 * `repo.fleet.overview.read` 这一条 typed read——节点(中心+边缘)、副本通道、每节点
 * 租约/派工、内部状态与 canonical 事件窗口都由 daemon 聚合并标注三态;页面只渲染,
 * 不从任务列表二次推导,也不推断中心没有声明的事实(在线、同步内部状态等按 daemon
 * 给的 unavailable 原因如实显示)。原因/声明的机器码是 daemon 的稳定契约:可见文本
 * 只放 i18n 人话解释,机器码进 title 提示与 data-reason 属性供测试断言,不在正文露出。
 *
 * 呈现是「指挥台」三层:上方 SVG 拓扑画布(状态光 + 数据流),底部事件流(新事件滑入,
 * 所属节点在拓扑上闪一下),点节点从右侧滑入详情抽屉(非模态,拓扑保持可点)。
 */

export function CollaborationView({
  repoId,
  mode,
  overview,
  overviewError = null,
  overviewLoading = false,
  onOpenTask,
  onNavigateEntity,
  now = new Date().toISOString(),
}: {
  readonly repoId: string;
  readonly mode: RepoMode;
  readonly overview: FleetOverviewRead | null;
  readonly overviewError?: string | null;
  readonly overviewLoading?: boolean;
  readonly onOpenTask: (taskId: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly now?: string;
}) {
  const nodes = overview?.nodes ?? [];
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [eventNode, setEventNode] = useState("all");
  const selected = selectedNode === null ? null : (nodes.find((node) => node.nodeId === selectedNode) ?? null);
  const events = overview?.events ?? [];
  const visibleEvents = eventNode === "all" ? events : events.filter((event) => event.nodeId === eventNode);
  const executing = nodes.reduce(
    (total, node) =>
      total +
      (Array.isArray(node.leases)
        ? node.leases.filter((lease) => lease.phase === "held" || lease.phase === "reserving").length
        : 0),
    0,
  );
  // 事件流与拓扑的联动:读面刷新出现新事件时,其所属节点在拓扑上闪一下(1.6s)。
  const [flashNodes, setFlashNodes] = useState<ReadonlySet<string>>(() => new Set());
  const seenEventIds = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const current = new Set(events.map((event) => event.eventId));
    const previous = seenEventIds.current;
    seenEventIds.current = current;
    if (previous.size === 0) return;
    const arrived = new Set(events.filter((event) => !previous.has(event.eventId)).map((event) => event.nodeId));
    if (arrived.size === 0) return;
    setFlashNodes(arrived);
    const timer = window.setTimeout(() => setFlashNodes(new Set()), 1600);
    return () => window.clearTimeout(timer);
  }, [events]);
  return (
    <section
      data-testid="collaboration-view"
      data-repo={repoId}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <PageHeader
        title={t("collaboration.title")}
        note={t("collaboration.fleetNote")}
        meta={t("collaboration.fleetSummary", { nodes: nodes.length, executing, events: events.length })}
        actions={<RepoModeBadge mode={mode} />}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
        {mode === "local" ? (
          <p
            data-testid="collaboration-center-notice"
            className="border-l-2 border-status-active pl-3 ui-meta text-text-muted"
          >
            {t("collaboration.centerNotice")}
          </p>
        ) : null}
        {overviewError !== null ? (
          <p
            data-testid="collaboration-read-error"
            data-reason={READ_ERROR_LABELS[overviewError] === undefined ? undefined : overviewError}
            title={READ_ERROR_LABELS[overviewError] === undefined ? undefined : overviewError}
            className="ui-meta text-status-blocked"
          >
            {t("collaboration.readFailed", {
              error:
                READ_ERROR_LABELS[overviewError] === undefined ? overviewError : t(READ_ERROR_LABELS[overviewError]),
            })}
          </p>
        ) : null}
        {overviewLoading && overview === null ? (
          <Empty>{t("collaboration.loading")}</Empty>
        ) : overview === null ? null : nodes.length === 0 ? (
          <Empty>{t("collaboration.empty")}</Empty>
        ) : (
          <>
            <Section title={t("collaboration.topologyTitle")} note={t("collaboration.topologyNote")} variant="panel">
              <div className="h-[clamp(300px,46vh,440px)]">
                <FleetTopology
                  nodes={nodes}
                  links={overview.links}
                  center={overview.center}
                  centerRevision={overview.centerRevision}
                  selectedNode={selectedNode}
                  onSelectNode={(nodeId) => setSelectedNode((current) => (current === nodeId ? null : nodeId))}
                  flashNodes={flashNodes}
                />
              </div>
            </Section>
            <Section
              title={t("collaboration.eventsTitle")}
              count={visibleEvents.length}
              note={t("collaboration.eventsNote")}
              action={
                <select
                  aria-label={t("collaboration.eventsFilter")}
                  data-testid="collaboration-event-filter"
                  value={eventNode}
                  onChange={(event) => setEventNode(event.target.value)}
                  className="border border-border bg-surface px-2 py-1 ui-meta text-text"
                >
                  <option value="all">{t("collaboration.filterAll")}</option>
                  {nodes.map((node) => (
                    <option key={node.nodeId} value={node.nodeId}>
                      {nodeLabelOf(node)}
                    </option>
                  ))}
                </select>
              }
              variant="panel"
            >
              <div data-testid="collaboration-events" className="max-h-[34vh] divide-y divide-border overflow-y-auto">
                {visibleEvents.map((event) => (
                  <EventRow
                    key={event.eventId}
                    event={event}
                    nodes={nodes}
                    now={now}
                    onOpenTask={onOpenTask}
                    onSelectNode={() => setSelectedNode(event.nodeId)}
                  />
                ))}
                {visibleEvents.length === 0 ? (
                  <p className="px-3 py-2 ui-meta text-text-muted">{t("collaboration.eventsEmpty")}</p>
                ) : null}
              </div>
            </Section>
            {overview.warnings.length > 0 ? (
              <p className="ui-micro text-text-faint" data-testid="collaboration-warnings">
                {overview.warnings.map((warning, index) => (
                  <Fragment key={warning}>
                    {index > 0 ? " · " : null}
                    <span title={warning}>{warningLabel(warning)}</span>
                  </Fragment>
                ))}
              </p>
            ) : null}
          </>
        )}
      </div>
      <Drawer
        open={selected !== null}
        onClose={() => setSelectedNode(null)}
        modal={false}
        ariaLabel={t("collaboration.drawerAria")}
      >
        {selected === null ? null : (
          <NodeDetails
            node={selected}
            overview={overview!}
            now={now}
            onOpenTask={onOpenTask}
            onNavigateEntity={onNavigateEntity}
            onClose={() => setSelectedNode(null)}
          />
        )}
      </Drawer>
    </section>
  );
}

function EventRow({
  event,
  nodes,
  now,
  onOpenTask,
  onSelectNode,
}: {
  readonly event: FleetOverviewEvent;
  readonly nodes: readonly FleetOverviewNode[];
  readonly now: string;
  readonly onOpenTask: (taskId: string) => void;
  readonly onSelectNode: () => void;
}) {
  const node = nodes.find((candidate) => candidate.nodeId === event.nodeId);
  return (
    <button
      type="button"
      className="fleet-event-in flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-raised"
      onClick={onSelectNode}
      data-testid={`collaboration-event-evt-${event.eventId}`}
    >
      <span className="shrink-0 ui-micro text-text-faint">{formatListTime(event.occurredAt, { now })}</span>
      <span className="min-w-0 flex-1 truncate ui-meta text-text">
        {event.type}
        {event.title === null ? null : ` · ${event.title}`}
      </span>
      {event.taskId === null ? null : (
        <span
          role="link"
          tabIndex={0}
          onClick={(clickEvent) => {
            clickEvent.stopPropagation();
            onOpenTask(event.taskId!);
          }}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key === "Enter") {
              keyEvent.stopPropagation();
              onOpenTask(event.taskId!);
            }
          }}
          className="shrink-0 font-mono text-accent hover:underline ui-micro"
          title={event.taskId}
        >
          {event.taskId}
        </span>
      )}
      <span className="shrink-0 ui-micro text-text-faint" data-testid={`collaboration-event-node-${event.eventId}`}>
        {" "}
        {node === undefined ? event.nodeId : nodeLabelOf(node)}
      </span>
    </button>
  );
}
