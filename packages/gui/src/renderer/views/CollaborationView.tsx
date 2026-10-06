import { Fragment, useState, type ReactNode } from "react";
import { t, type MessageKey } from "../i18n/index.tsx";
import type {
  FleetFieldState,
  FleetOverviewEvent,
  FleetOverviewLink,
  FleetOverviewNode,
  FleetOverviewRead,
} from "../../api/renderer-dto.ts";
import { formatListTime } from "../model/time.ts";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { RepoModeBadge, type RepoMode } from "../components/RepoModeBadge.tsx";
import { Empty } from "../components/primitives/Empty.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { Section } from "../components/primitives/Section.tsx";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag.tsx";

/**
 * 协作页:舰队拓扑(task_8ce646d94)。数据全部来自 `repo.fleet.overview.read` 这一条
 * typed read——节点(中心+边缘)、副本通道、每节点租约/派工、内部状态与 canonical
 * 事件窗口都由 daemon 聚合并标注三态;页面只渲染,不从任务列表二次推导,也不推断
 * 中心没有声明的事实(在线、同步内部状态等按 daemon 给的 unavailable 原因如实显示)。
 * 原因/声明的机器码是 daemon 的稳定契约:可见文本只放 i18n 人话解释,机器码进
 * title 提示与 data-reason 属性供测试断言,不在正文原样露出。
 *
 * 交互契约:点节点卡片(含中心)打开详情;事件流可按节点过滤,点事件跳到对应节点详情。
 */

const PHASE_LABEL: Readonly<Record<string, MessageKey>> = {
  held: "collaboration.phase.held",
  reserving: "collaboration.phase.reserving",
  orphaned: "collaboration.phase.orphaned",
  released: "collaboration.phase.released",
};
const PHASE_TONE: Readonly<Record<string, StatusTone>> = {
  held: "active",
  reserving: "wait",
  orphaned: "bad",
  released: "neutral",
};
const LINK_TONE: Readonly<Record<FleetOverviewLink["state"], StatusTone>> = {
  fresh: "done",
  lag: "wait",
  unsynced: "bad",
};
const LINK_LABEL: Readonly<Record<FleetOverviewLink["state"], string>> = {
  fresh: "fresh",
  lag: "lag",
  unsynced: "未同步",
};

/** daemon 稳定 reason 码 → 一句人话(为什么没有、何时会有);未收录的码显示通用说明,码进 title。 */
const REASON_LABELS: Readonly<Record<string, MessageKey>> = {
  "tls-session-fact-not-exposed": "collaboration.reason.onlineNotExposed",
  "replica-status-has-no-build-field": "collaboration.reason.buildNotInReplicaStatus",
  "edge-sync-internals-not-exposed": "collaboration.reason.syncInternalsNotExposed",
  "no-replica-sync-failure-record-in-lifecycle-read": "collaboration.reason.noSyncFailureRecord",
  "node-registry-not-queried": "collaboration.reason.registryNotQueried",
  "center-replica-ledger-has-no-row-for-node": "collaboration.reason.noReplicaRow",
  authorization_denied: "collaboration.reason.authorizationDenied",
  insufficient_scope: "collaboration.reason.insufficientScope",
};
/** 值域里的 daemon 标记串(如 owner 登记表查无此人)→ 人话;标记串进 title。 */
const VALUE_LABELS: Readonly<Record<string, MessageKey>> = {
  "not-in-registry": "collaboration.ownerNotRegistered",
};
/** notes 的 key 前缀(key=value 形态)→ 人话;整条声明串进 title。 */
const NOTE_LABELS: Readonly<Record<string, MessageKey>> = {
  "events-attribution": "collaboration.note.eventsAttribution",
  "edge-online": "collaboration.note.edgeOnline",
  "sync-internals": "collaboration.note.syncInternals",
};
/** warnings 的 key 前缀(key: detail 形态)→ 人话;整条 warning 串(含 detail)进 title。 */
const WARNING_LABELS: Readonly<Record<string, MessageKey>> = {
  "node-owner-registry-unavailable": "collaboration.warning.ownerRegistryUnavailable",
};

function reasonText(reason: string): string {
  const message = REASON_LABELS[reason];
  return message === undefined ? t("collaboration.reason.unknown") : t(message);
}

function noteLabel(note: string): string {
  const message = NOTE_LABELS[note.split("=", 1)[0] ?? ""];
  // 未识别的 daemon 声明原样保留:静默丢弃比露出更不诚实。
  return message === undefined ? note : t(message);
}

function warningLabel(warning: string): string {
  const message = WARNING_LABELS[warning.split(":", 1)[0] ?? ""];
  return message === undefined ? warning : t(message);
}

type FleetLeaseRowView = Exclude<FleetOverviewNode["leases"], { readonly redacted: string }>[number];

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
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {mode === "local" ? (
          <p
            data-testid="collaboration-center-notice"
            className="mb-3 border-l-2 border-status-active pl-3 ui-meta text-text-muted"
          >
            {t("collaboration.centerNotice")}
          </p>
        ) : null}
        {overviewError !== null ? (
          <p data-testid="collaboration-read-error" className="mb-3 ui-meta text-status-blocked">
            {t("collaboration.readFailed", { error: overviewError })}
          </p>
        ) : null}
        {overviewLoading && overview === null ? (
          <Empty>{t("collaboration.loading")}</Empty>
        ) : overview === null ? null : nodes.length === 0 ? (
          <Empty>{t("collaboration.empty")}</Empty>
        ) : (
          <>
            <Section title={t("collaboration.topologyTitle")} note={t("collaboration.topologyNote")} variant="panel">
              <div
                data-testid="collaboration-topology"
                className="relative grid min-h-[250px] grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3 p-4"
              >
                {nodes.map((node) => (
                  <div key={node.nodeId} className={node.role === "center" ? "col-span-full flex justify-center" : ""}>
                    {node.role !== "center" ? (
                      <div aria-hidden="true" className="mx-auto mb-2 h-5 w-px bg-border" />
                    ) : null}
                    <NodeCard
                      node={node}
                      link={linkOf(overview, node)}
                      selected={node.nodeId === selectedNode}
                      onSelect={() => setSelectedNode(node.nodeId)}
                    />
                  </div>
                ))}
              </div>
            </Section>
            {selected !== null ? (
              <NodeDetails
                node={selected}
                overview={overview}
                now={now}
                onOpenTask={onOpenTask}
                onNavigateEntity={onNavigateEntity}
                onClose={() => setSelectedNode(null)}
              />
            ) : null}
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
                      {nodeLabel(node)}
                    </option>
                  ))}
                </select>
              }
              variant="panel"
            >
              <div data-testid="collaboration-events" className="divide-y divide-border">
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
              <p className="mt-3 ui-micro text-text-faint" data-testid="collaboration-warnings">
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
    </section>
  );
}

function linkOf(overview: FleetOverviewRead, node: FleetOverviewNode): FleetOverviewLink | null {
  return node.role === "center" ? null : (overview.links.find((link) => link.nodeId === node.nodeId) ?? null);
}

function nodeLabel(node: FleetOverviewNode): string {
  return node.role === "center" ? t("collaboration.centerNode") : node.nodeId;
}

function NodeCard({
  node,
  link,
  selected,
  onSelect,
}: {
  readonly node: FleetOverviewNode;
  readonly link: FleetOverviewLink | null;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const leases = Array.isArray(node.leases) ? node.leases : [];
  const executing = leases.filter((lease) => lease.phase === "held" || lease.phase === "reserving").length;
  return (
    <button
      type="button"
      data-testid={`collaboration-node-${node.nodeId}`}
      aria-pressed={selected}
      onClick={onSelect}
      className={`w-full max-w-[300px] border px-3 py-3 text-left transition-colors ${selected ? "border-accent bg-surface-raised" : "border-border bg-surface hover:border-accent"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-semibold ui-body">{nodeLabel(node)}</span>
        <StatusTag
          tone={executing > 0 ? "active" : "neutral"}
          label={executing > 0 ? t("collaboration.nodeExecuting", { count: executing }) : t("collaboration.nodeIdle")}
        />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 ui-micro text-text-muted">
        <span>{t("collaboration.nodeRole")}</span>
        <span className="text-right">{node.role}</span>
        <span>owner</span>
        <span className="truncate text-right" data-testid={`collaboration-node-owner-${node.nodeId}`}>
          {fieldText(node.owner)}
        </span>
        <span>{t("collaboration.nodeCut")}</span>
        <span className="text-right">
          {node.replica === null
            ? t("collaboration.notProvided")
            : `cut ${node.replica.ackRevision ?? "—"} / ${node.replica.centerRevision}`}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-border pt-2 ui-micro text-text-faint">
        <span>{t("collaboration.nodeChannel")}</span>
        <span data-testid={`collaboration-node-channel-${node.nodeId}`}>
          {node.role === "center" ? (
            t("collaboration.centerChannel")
          ) : link === null ? (
            t("collaboration.noReplicaRow")
          ) : (
            <>
              <StatusTag mono tone={LINK_TONE[link.state]} label={LINK_LABEL[link.state]} />
              {link.ackedAt === null ? null : (
                <span className="ml-2">{t("collaboration.ackAt", { at: formatListTime(link.ackedAt) })}</span>
              )}
            </>
          )}
        </span>
      </div>
    </button>
  );
}

function NodeDetails({
  node,
  overview,
  now,
  onOpenTask,
  onNavigateEntity,
  onClose,
}: {
  readonly node: FleetOverviewNode;
  readonly overview: FleetOverviewRead;
  readonly now: string;
  readonly onOpenTask: (id: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <Section
      title={nodeLabel(node)}
      note={t("collaboration.nodeDetailNote")}
      action={
        <button type="button" onClick={onClose} className="text-accent ui-meta">
          {t("collaboration.close")}
        </button>
      }
      variant="panel"
    >
      <div data-testid="collaboration-node-details" className="grid gap-4 p-4 lg:grid-cols-2">
        <DetailBlock title={t("collaboration.doingTitle")}>
          {"redacted" in node.leases ? (
            <p
              data-testid="collaboration-node-leases-redacted"
              data-reason={node.leases.redacted}
              title={node.leases.redacted}
              className="ui-meta text-status-blocked"
            >
              {t("collaboration.noPermission")}：{reasonText(node.leases.redacted)}
            </p>
          ) : node.leases.length === 0 ? (
            <p className="ui-meta text-text-muted">{t("collaboration.noLeases")}</p>
          ) : (
            node.leases.map((lease) => (
              <LeaseRow
                key={lease.taskId}
                lease={lease}
                now={now}
                onOpenTask={onOpenTask}
                onNavigateEntity={onNavigateEntity}
              />
            ))
          )}
        </DetailBlock>
        <DetailBlock title={t("collaboration.internalTitle")}>
          <FieldLine
            label={t("collaboration.fieldDaemon")}
            state={
              node.role === "center"
                ? {
                    kind: "value",
                    text: `${overview.center.daemonId} · ${overview.center.version} @ ${overview.center.commitSha ?? "unknown"}`,
                  }
                : node.build
            }
          />
          <FieldLine label={t("collaboration.fieldOwner")} state={node.owner} />
          <FieldLine label={t("collaboration.fieldOnline")} state={node.online} />
          {node.replica === null ? (
            <DetailLine
              label={t("collaboration.fieldReplica")}
              value={node.replicaNote === null ? t("collaboration.notProvided") : reasonText(node.replicaNote)}
              title={node.replicaNote ?? undefined}
            />
          ) : (
            <>
              <DetailLine label={t("collaboration.fieldView")} value={`${node.replica.viewId}`} />
              <DetailLine
                label={t("collaboration.fieldCut")}
                value={`${node.replica.ackRevision ?? "—"} / ${node.replica.centerRevision}`}
              />
              <DetailLine
                label={t("collaboration.fieldAck")}
                value={
                  node.replica.ackedAt === null
                    ? t("collaboration.notProvided")
                    : formatListTime(node.replica.ackedAt, { now })
                }
              />
              <DetailLine
                label={t("collaboration.fieldLag")}
                value={`rev ${node.replica.lagRevisions}${node.replica.lagMs === null ? "" : ` · ${Math.round(node.replica.lagMs / 1000)}s`} · ${node.replica.delivery}`}
              />
            </>
          )}
          <FieldLine label={t("collaboration.fieldWatch")} state={node.watch} />
          <FieldLine label={t("collaboration.fieldLastFailure")} state={node.lastFailure} />
        </DetailBlock>
      </div>
      {overview.notes.length > 0 ? (
        <p className="px-4 pb-3 ui-micro text-text-faint" data-testid="collaboration-read-notes">
          {overview.notes.map((note, index) => (
            <Fragment key={note}>
              {index > 0 ? " · " : null}
              <span title={note}>{noteLabel(note)}</span>
            </Fragment>
          ))}
        </p>
      ) : null}
    </Section>
  );
}

function LeaseRow({
  lease,
  now,
  onOpenTask,
  onNavigateEntity,
}: {
  readonly lease: FleetLeaseRowView;
  readonly now: string;
  readonly onOpenTask: (id: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  return (
    <article className="border-t border-border py-2 first:border-t-0">
      <div className="flex items-center gap-2">
        <StatusTag mono tone="neutral" label={lease.coordinationStatus} />
        <button
          type="button"
          data-testid={`collaboration-task-${lease.taskId}`}
          onClick={() => onOpenTask(lease.taskId)}
          className="truncate text-left ui-body hover:underline"
        >
          {lease.title ?? lease.taskId}
        </button>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 ui-micro text-text-muted">
        <span>{lease.personId ?? t("collaboration.notProvided")}</span>
        {lease.agentId === null ? null : (
          <EntityRefLink entityRef={`agent/${lease.agentId}`} onNavigate={onNavigateEntity}>
            {lease.agentLabel ?? lease.agentId}
          </EntityRefLink>
        )}
        {lease.runtimeSessionId === null ? null : (
          <EntityRefLink
            entityRef={`session/${lease.runtimeSessionId}`}
            onNavigate={onNavigateEntity}
            title={lease.runtimeSessionId}
          >
            session
          </EntityRefLink>
        )}
        <span>
          {lease.phase === null ? (
            t("collaboration.leasePhaseMissing")
          ) : (
            <StatusTag
              mono
              tone={PHASE_TONE[lease.phase] ?? "neutral"}
              label={PHASE_LABEL[lease.phase] ? t(PHASE_LABEL[lease.phase]) : lease.phase}
            />
          )}
        </span>
        {lease.startedAt === null ? null : (
          <span>{t("collaboration.dispatchStartedAt", { at: formatListTime(lease.startedAt, { now }) })}</span>
        )}
        {lease.dispatchStatus === null ? null : <span className="font-mono">{lease.dispatchStatus}</span>}
      </div>
    </article>
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
      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-raised"
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
        {node === undefined ? event.nodeId : nodeLabel(node)}
      </span>
    </button>
  );
}

function DetailBlock({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 font-semibold ui-body">{title}</h3>
      {children}
    </div>
  );
}

/** 三态字段行:有值 / 无权限查看(带原因) / 未提供(带原因)——标签保留,值不编造;
 * 可见文本是人话解释,机器码只进 title/data-reason 供测试断言。 */
function FieldLine({ label, state }: { readonly label: string; readonly state: FleetFieldState }) {
  const machine = machineOf(state);
  return (
    <div
      className="flex justify-between gap-3 border-t border-border py-1.5 ui-meta"
      data-testid="collaboration-field-line"
    >
      <span className="shrink-0 text-text-faint">{label}</span>
      <span className="text-right text-text-muted" data-reason={machine} title={machine}>
        {fieldText(state)}
        {state.kind === "unavailable" || state.kind === "redacted" ? (
          <span className="block ui-micro text-text-faint">{reasonText(state.reason)}</span>
        ) : null}
      </span>
    </div>
  );
}

/** 机器可断言的原始码(值标记或原因码);普通值无标记,返回 undefined 不占属性。 */
function machineOf(state: FleetFieldState): string | undefined {
  return state.kind === "value" ? (VALUE_LABELS[state.text] === undefined ? undefined : state.text) : state.reason;
}

function fieldText(state: FleetFieldState): string {
  if (state.kind === "value") {
    const message = VALUE_LABELS[state.text];
    return message === undefined ? state.text : t(message);
  }
  return state.kind === "redacted" ? t("collaboration.noPermissionShort") : t("collaboration.notProvided");
}

function DetailLine({
  label,
  value,
  title,
}: {
  readonly label: string;
  readonly value: string;
  readonly title?: string;
}) {
  return (
    <div className="flex justify-between gap-3 border-t border-border py-1.5 ui-meta" data-reason={title}>
      <span className="shrink-0 text-text-faint">{label}</span>
      <span className="text-right text-text-muted" title={title}>
        {value}
      </span>
    </div>
  );
}
