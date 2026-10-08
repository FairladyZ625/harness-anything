import type { FleetReplicaStatus } from "./center-types.ts";
import { runtimeErrorCode } from "../runtime-spawn-errors.ts";
import type { RepoCell, RepoCellBinding } from "../repo-cell-types.ts";
import { keycloakNodeRegistry } from "../fleet-center-admission.ts";
import { daemonBuildStamp } from "../build-identity.ts";
import type { KeycloakCenterAuthority } from "../transport/auth-context.ts";

/**
 * 协作页舰队拓扑的只读聚合(task_8ce646d94):一次 typed read 回答「舰队有哪些节点、
 * 通道什么状态、每个节点在做什么、内部什么状态、最近发生了什么」。
 *
 * 事实边界(不推断、不编造):
 * - 中心节点是保留 id `center`(台账里只有边缘节点有 nodeId);中心自身事实来自
 *   daemon 进程(daemonId/build/startedAt);
 * - 边缘节点集 = 中心副本账本出现过的 nodeId ∪ 当前持有任务租约的 nodeId,两者都是
 *   daemon 既有事实;
 * - 通道/副本状态直接投影 `FleetTlsCenter.status().replicas`(centerRevision/ack/
 *   lag/delivery),保留 null;
 * - 在做什么 = 该节点当前租约的任务行 + 这些任务的 dispatch 行(daemon 既有读面);
 * - 事件 = canonical event 尾部只读投影,按任务**当前**租约归属节点——历史事件可能
 *   早于当前持有人,这一归属语义在结果里显式声明,不在 UI 里隐含;
 * - TLS 实时在线 session、edge 内部 watch/pull/退避、replica_sync_failed 生命周期
 *   记录当前读面不提供:字段显式 `unavailable` 带原因,不用别的信号冒充。
 *
 * 该查询只读,不占租约、不写事件;权限沿用 repository-read 授权与 viewer binding。
 */

/** 单个字段的诚实三态:有值 / 无权限(带原因) / 未提供(带原因)。 */
export type FleetFieldState =
  | { readonly kind: "value"; readonly text: string }
  | { readonly kind: "redacted"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/** 台账里中心的保留节点 id;真实 nodeId 来自 fleet admission,不会与之冲突。 */
export const FLEET_CENTER_NODE_ID = "center";

export interface FleetCenterFact {
  readonly daemonId: string;
  readonly startedAt: string;
  readonly version: string;
  readonly commitSha: string | null;
}

/** 任务租约事实(来自 repo.tasks.list 的快照行,daemon 侧已按 viewer 裁剪)。 */
export interface FleetLeaseFact {
  readonly taskId: string;
  readonly title: string | null;
  readonly coordinationStatus: string;
  readonly leasePhase: string | null;
  readonly leaseExpiresAt: string | null;
  readonly personId: string | null;
  /** daemon 写侧 executor id(`runtime-session:<id>`);无执行会话为 null。 */
  readonly executorId: string | null;
  /** lease 来源节点;中心本机通道为 FLEET_CENTER_NODE_ID,无节点通道为 null。 */
  readonly nodeId: string | null;
}

/** 派工事实(来自 repo.task.dispatches 的行)。 */
export interface FleetDispatchFact {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly runtimeSessionId: string;
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly startedAt: string;
  readonly status: string;
}

/** canonical 事件摘要(来自 observe.tail kind=events 的条目)。 */
export interface FleetCanonicalEventFact {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
  readonly taskId: string | null;
  /** actor.executor.id(可能缺);用于派工→节点归属,匹配不上归中心。 */
  readonly executorId: string | null;
  readonly title: string | null;
}

export type FleetLeaseReads =
  | { readonly ok: true; readonly leases: readonly FleetLeaseFact[]; readonly dispatches: readonly FleetDispatchFact[] }
  | { readonly ok: false; readonly code: string };

export interface FleetOverviewInput {
  readonly repoId: string;
  readonly mode: string;
  readonly generatedAt: string;
  readonly center: FleetCenterFact;
  /** 本 repo 的副本状态行(空数组 = 中心没有 fleet listener 或尚无边缘同步过)。 */
  readonly replicas: readonly FleetReplicaStatus[];
  readonly leaseReads: FleetLeaseReads;
  readonly events: readonly FleetCanonicalEventFact[];
  /** Keycloak 节点登记的 owner personId;查询失败按节点给 unavailable 原因。 */
  readonly nodeOwners: ReadonlyMap<string, FleetFieldState>;
  /** projection sourceRevision;读面拿不到时为 null(事件尾部仍带自己的 revision)。 */
  readonly centerRevision: number | null;
}

export interface FleetTaskLeaseRow {
  readonly taskId: string;
  readonly title: string | null;
  readonly coordinationStatus: string;
  readonly phase: string | null;
  readonly expiresAt: string | null;
  readonly personId: string | null;
  readonly runtimeSessionId: string | null;
  readonly dispatchId: string | null;
  readonly agentId: string | null;
  readonly agentLabel: string | null;
  readonly startedAt: string | null;
  readonly dispatchStatus: string | null;
}

export interface FleetNodeRow {
  readonly nodeId: string;
  readonly role: "center" | "edge";
  readonly owner: FleetFieldState;
  readonly build: FleetFieldState;
  readonly online: FleetFieldState;
  readonly leases: readonly FleetTaskLeaseRow[] | { readonly redacted: string };
  readonly replica:
    | (Pick<
        FleetReplicaStatus,
        | "viewId"
        | "centerRevision"
        | "centerEventAt"
        | "ackRevision"
        | "ackedAt"
        | "lagRevisions"
        | "lagMs"
        | "delivery"
        | "deliveryLease"
        | "transferMetrics"
      > & { readonly repoId: string })
    | null;
  /** replica 为 null 时必给原因;非 null 时为 null。 */
  readonly replicaNote: string | null;
  readonly watch: FleetFieldState;
  readonly lastFailure: FleetFieldState;
}

export interface FleetLinkRow {
  readonly nodeId: string;
  readonly state: "fresh" | "lag" | "unsynced";
  readonly delivery: string | null;
  readonly lagRevisions: number | null;
  readonly lagMs: number | null;
  readonly ackedAt: string | null;
  readonly centerRevision: number | null;
}

export interface FleetEventRow {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
  readonly taskId: string | null;
  readonly title: string | null;
  readonly nodeId: string;
}

export interface FleetOverviewResult {
  readonly schema: "daemon.fleet-overview/v1";
  readonly ok: true;
  readonly repoId: string;
  readonly mode: string;
  readonly generatedAt: string;
  readonly center: {
    readonly nodeId: typeof FLEET_CENTER_NODE_ID;
    readonly daemonId: string;
    readonly startedAt: string;
    readonly version: string;
    readonly commitSha: string | null;
  };
  readonly centerRevision: number | null;
  readonly nodes: readonly FleetNodeRow[];
  readonly links: readonly FleetLinkRow[];
  readonly events: readonly FleetEventRow[];
  /** 事件归属语义与读面限制的显式声明(渲染时如实展示,不隐含)。 */
  readonly notes: readonly string[];
  readonly warnings: readonly string[];
}

const ONLINE_REASON = "tls-session-fact-not-exposed",
  EDGE_BUILD_REASON = "replica-status-has-no-build-field",
  WATCH_REASON = "edge-sync-internals-not-exposed",
  LAST_FAILURE_REASON = "no-replica-sync-failure-record-in-lifecycle-read",
  NO_REPLICA_ROW_REASON = "center-replica-ledger-has-no-row-for-node";

/** 授权类错误码 → 字段 redacted;其余错误原样抛出(fail-closed,不吞)。 */
export async function authorizedOrThrow<T>(
  read: () => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    const code = runtimeErrorCode(error);
    if (code !== null && (code === "authorization_denied" || code === "insufficient_scope")) {
      return { ok: false, code };
    }
    throw error;
  }
}

export function buildFleetOverview(input: FleetOverviewInput): FleetOverviewResult {
  const nodeIds = new Set<string>([FLEET_CENTER_NODE_ID]);
  const leasesByNode = new Map<string, FleetLeaseFact[]>();
  if (input.leaseReads.ok)
    for (const lease of input.leaseReads.leases) {
      if (lease.nodeId === null) continue;
      nodeIds.add(lease.nodeId);
      const list = leasesByNode.get(lease.nodeId) ?? [];
      list.push(lease);
      leasesByNode.set(lease.nodeId, list);
    }
  const replicaByNode = new Map<string, FleetReplicaStatus>();
  for (const replica of input.replicas) {
    nodeIds.add(replica.nodeId);
    // 节点只会对它正在拉取的 view 推进 ack,所以最近一次 ack 的行就是活跃 view;冻结在
    // 旧 ack 上的行属于退役 view(回收发生在该 view 下一次 ACK 落地时),全部行仍逐条出现在 links。
    const existing = replicaByNode.get(replica.nodeId);
    if (existing === undefined || moreRecentlyAcked(replica, existing)) replicaByNode.set(replica.nodeId, replica);
  }
  const dispatchByTask = new Map<string, FleetDispatchFact>();
  if (input.leaseReads.ok)
    for (const dispatch of input.leaseReads.dispatches) {
      const existing = dispatchByTask.get(dispatch.taskId);
      if (existing === undefined || dispatch.startedAt > existing.startedAt)
        dispatchByTask.set(dispatch.taskId, dispatch);
    }

  const nodes: FleetNodeRow[] = [...nodeIds].sort(compareNodeIds).map((nodeId) => {
    const isCenter = nodeId === FLEET_CENTER_NODE_ID,
      replica = isCenter ? null : (replicaByNode.get(nodeId) ?? null);
    return {
      nodeId,
      role: isCenter ? "center" : "edge",
      owner: isCenter
        ? { kind: "value", text: "daemon" }
        : (input.nodeOwners.get(nodeId) ?? { kind: "unavailable", reason: "node-registry-not-queried" }),
      build: isCenter
        ? { kind: "value", text: `${input.center.version} @ ${input.center.commitSha ?? "unknown"}` }
        : { kind: "unavailable", reason: EDGE_BUILD_REASON },
      online: isCenter ? { kind: "value", text: "running" } : { kind: "unavailable", reason: ONLINE_REASON },
      leases: input.leaseReads.ok
        ? leaseRows(leasesByNode.get(nodeId) ?? [], dispatchByTask)
        : { redacted: input.leaseReads.code },
      replica: replica === null ? null : projectReplica(replica),
      replicaNote: isCenter || replica !== null ? null : NO_REPLICA_ROW_REASON,
      watch: isCenter
        ? { kind: "value", text: "local canonical writer" }
        : { kind: "unavailable", reason: WATCH_REASON },
      lastFailure: { kind: "unavailable", reason: LAST_FAILURE_REASON },
    };
  });

  const links: FleetLinkRow[] = input.replicas
    .slice()
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.viewId.localeCompare(right.viewId))
    .map((replica) => ({
      nodeId: replica.nodeId,
      state:
        replica.delivery === "current" && replica.lagRevisions === 0
          ? "fresh"
          : replica.ackRevision === null || replica.delivery === "snapshot_required" || replica.delivery === "degraded"
            ? "unsynced"
            : "lag",
      delivery: replica.delivery,
      lagRevisions: replica.lagRevisions,
      lagMs: replica.lagMs,
      ackedAt: replica.ackedAt,
      centerRevision: replica.centerRevision,
    }));

  return {
    schema: "daemon.fleet-overview/v1",
    ok: true,
    repoId: input.repoId,
    mode: input.mode,
    generatedAt: input.generatedAt,
    center: {
      nodeId: FLEET_CENTER_NODE_ID,
      daemonId: input.center.daemonId,
      startedAt: input.center.startedAt,
      version: input.center.version,
      commitSha: input.center.commitSha,
    },
    centerRevision: input.centerRevision,
    nodes,
    links,
    events: fleetEventRows(input.events, leasesByNode, dispatchByTask),
    // notes 是稳定机器码(key=value),人话解释归 GUI i18n;daemon 不内嵌单语言文案。
    notes: ["events-attribution=current-lease", "edge-online=unavailable", "sync-internals=unavailable"],
    warnings: [
      ...new Set(
        [...input.nodeOwners.values()]
          .filter((state) => state.kind === "unavailable")
          .map((state) => `node-owner-registry-unavailable: ${(state as { readonly reason: string }).reason}`),
      ),
    ],
  };
}

function compareNodeIds(left: string, right: string): number {
  return Number(left !== FLEET_CENTER_NODE_ID) - Number(right !== FLEET_CENTER_NODE_ID) || left.localeCompare(right);
}

/** 节点级摘要的活跃 view 判据:最近一次 ack 更新(ISO 时间可比,空 = 从未 ack);
 * 同时 ack 时取 ackRevision 更高的一行,保证确定性。 */
function moreRecentlyAcked(candidate: FleetReplicaStatus, existing: FleetReplicaStatus): boolean {
  const candidateAck = candidate.ackedAt ?? "",
    existingAck = existing.ackedAt ?? "";
  return (
    candidateAck > existingAck ||
    (candidateAck === existingAck && (candidate.ackRevision ?? -1) > (existing.ackRevision ?? -1))
  );
}

function leaseRows(
  leases: readonly FleetLeaseFact[],
  dispatchByTask: ReadonlyMap<string, FleetDispatchFact>,
): readonly FleetTaskLeaseRow[] {
  return leases.map((lease) => {
    const dispatch = dispatchByTask.get(lease.taskId) ?? null;
    return {
      taskId: lease.taskId,
      title: lease.title,
      coordinationStatus: lease.coordinationStatus,
      phase: lease.leasePhase,
      expiresAt: lease.leaseExpiresAt,
      personId: lease.personId,
      runtimeSessionId:
        lease.executorId !== null && lease.executorId.startsWith("runtime-session:")
          ? lease.executorId.slice("runtime-session:".length)
          : null,
      dispatchId: dispatch?.dispatchId ?? null,
      agentId: dispatch?.agentId ?? null,
      agentLabel: dispatch?.agentName ?? null,
      startedAt: dispatch?.startedAt ?? null,
      dispatchStatus: dispatch?.status ?? null,
    };
  });
}

function projectReplica(replica: FleetReplicaStatus): NonNullable<FleetNodeRow["replica"]> {
  return {
    repoId: replica.repoId,
    viewId: replica.viewId,
    centerRevision: replica.centerRevision,
    centerEventAt: replica.centerEventAt,
    ackRevision: replica.ackRevision,
    ackedAt: replica.ackedAt,
    lagRevisions: replica.lagRevisions,
    lagMs: replica.lagMs,
    delivery: replica.delivery,
    deliveryLease: replica.deliveryLease,
    transferMetrics: replica.transferMetrics,
  };
}

function fleetEventRows(
  events: readonly FleetCanonicalEventFact[],
  leasesByNode: ReadonlyMap<string, readonly FleetLeaseFact[]>,
  dispatchByTask: ReadonlyMap<string, FleetDispatchFact>,
): readonly FleetEventRow[] {
  const nodeOfTask = new Map<string, string>();
  for (const [nodeId, leases] of leasesByNode) for (const lease of leases) nodeOfTask.set(lease.taskId, nodeId);
  const taskOfSession = new Map<string, string>();
  for (const dispatch of dispatchByTask.values()) taskOfSession.set(dispatch.runtimeSessionId, dispatch.taskId);
  const nodeOf = (event: FleetCanonicalEventFact): string => {
    if (event.taskId !== null && nodeOfTask.has(event.taskId)) return nodeOfTask.get(event.taskId)!;
    if (event.executorId !== null) {
      const session = event.executorId.startsWith("runtime-session:")
        ? event.executorId.slice("runtime-session:".length)
        : event.executorId;
      const task = taskOfSession.get(session);
      if (task !== undefined && nodeOfTask.has(task)) return nodeOfTask.get(task)!;
    }
    return FLEET_CENTER_NODE_ID;
  };
  return events.map((event) => ({
    eventId: event.eventId,
    type: event.type,
    occurredAt: event.occurredAt,
    workspaceRevision: event.workspaceRevision,
    taskId: event.taskId,
    title: event.title,
    nodeId: nodeOf(event),
  }));
}

/** Daemon-side exit check for the fleet overview read (parseDaemonGuiReadResult). */
export function validateFleetOverview(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["fleet overview must be an object"];
  const errors: string[] = [],
    row = value as Record<string, unknown>;
  if (row.schema !== "daemon.fleet-overview/v1") errors.push("schema must be daemon.fleet-overview/v1");
  if (row.ok !== true) errors.push("ok must be true");
  for (const field of ["repoId", "mode", "generatedAt"] as const)
    if (typeof row[field] !== "string") errors.push(`${field} must be a string`);
  const center = row.center;
  if (center === null || typeof center !== "object" || Array.isArray(center)) errors.push("center must be an object");
  else {
    const centerRow = center as Record<string, unknown>;
    if (centerRow.nodeId !== FLEET_CENTER_NODE_ID) errors.push("center.nodeId must be the reserved center id");
    for (const field of ["daemonId", "startedAt", "version"] as const)
      if (typeof centerRow[field] !== "string") errors.push(`center.${field} must be a string`);
    if (centerRow.commitSha !== null && typeof centerRow.commitSha !== "string")
      errors.push("center.commitSha must be a string or null");
  }
  if (row.centerRevision !== null && typeof row.centerRevision !== "number")
    errors.push("centerRevision must be a number or null");
  for (const field of ["nodes", "links", "events", "notes", "warnings"] as const) {
    if (!Array.isArray(row[field])) errors.push(`${field} must be an array`);
  }
  if (Array.isArray(row.nodes))
    for (const [index, node] of row.nodes.entries()) errors.push(...validateNodeRow(node, `nodes[${index}]`));
  if (Array.isArray(row.links))
    for (const [index, link] of row.links.entries()) {
      const entry = link as Record<string, unknown>;
      if (typeof entry.nodeId !== "string") errors.push(`links[${index}].nodeId must be a string`);
      if (!["fresh", "lag", "unsynced"].includes(String(entry.state)))
        errors.push(`links[${index}].state must be a known link state`);
    }
  if (Array.isArray(row.events))
    for (const [index, event] of row.events.entries()) {
      const entry = event as Record<string, unknown>;
      for (const field of ["eventId", "type", "occurredAt", "nodeId"] as const)
        if (typeof entry[field] !== "string") errors.push(`events[${index}].${field} must be a string`);
      if (typeof entry.workspaceRevision !== "number")
        errors.push(`events[${index}].workspaceRevision must be a number`);
    }
  return errors;
}

function validateNodeRow(node: unknown, at: string): readonly string[] {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return [`${at} must be an object`];
  const errors: string[] = [],
    row = node as Record<string, unknown>;
  if (typeof row.nodeId !== "string") errors.push(`${at}.nodeId must be a string`);
  if (row.role !== "center" && row.role !== "edge") errors.push(`${at}.role must be center or edge`);
  for (const field of ["owner", "build", "online", "watch", "lastFailure"] as const)
    errors.push(...validateFieldState(row[field], `${at}.${field}`));
  if (Array.isArray(row.leases)) {
    for (const [index, lease] of row.leases.entries()) {
      const entry = lease as Record<string, unknown>;
      if (typeof entry.taskId !== "string") errors.push(`${at}.leases[${index}].taskId must be a string`);
    }
  } else if (
    row.leases === null ||
    typeof row.leases !== "object" ||
    typeof (row.leases as Record<string, unknown>).redacted !== "string"
  )
    errors.push(`${at}.leases must be an array or a redaction object`);
  if (row.replicaNote !== null && typeof row.replicaNote !== "string")
    errors.push(`${at}.replicaNote must be a string or null`);
  const replica = row.replica;
  if (replica !== null) {
    if (replica === undefined || typeof replica !== "object" || Array.isArray(replica))
      errors.push(`${at}.replica must be an object or null`);
    else {
      const entry = replica as Record<string, unknown>;
      for (const field of ["viewId", "repoId", "delivery"] as const)
        if (typeof entry[field] !== "string") errors.push(`${at}.replica.${field} must be a string`);
      for (const field of ["centerRevision", "lagRevisions"] as const)
        if (typeof entry[field] !== "number") errors.push(`${at}.replica.${field} must be a number`);
    }
  }
  return errors;
}

function validateFieldState(state: unknown, at: string): readonly string[] {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return [`${at} must be a field state`];
  const row = state as Record<string, unknown>;
  if (row.kind !== "value" && row.kind !== "redacted" && row.kind !== "unavailable")
    return [`${at}.kind must be value, redacted or unavailable`];
  if (row.kind === "value" && typeof row.text !== "string") return [`${at}.text must be a string`];
  if (row.kind !== "value" && typeof row.reason !== "string") return [`${at}.reason must be a string`];
  return [];
}

const EVENT_PAGE_LIMIT = 64;

/** Host 侧装配:把 daemon 既有事实源(副本账本、任务租约投影、派工行、canonical 事件尾部、
 * Keycloak 节点登记、daemon build)聚成一次 overview 读。全部子读只读且走 viewer binding。 */
export async function readFleetOverviewFromHost(input: {
  readonly repoId: string;
  readonly mode: string;
  readonly cell: RepoCell;
  readonly binding: RepoCellBinding;
  readonly fleetReplicas: readonly FleetReplicaStatus[];
  readonly keycloakCenter: KeycloakCenterAuthority;
  readonly now: string;
  readonly userRoot: string;
  readonly daemon: { readonly daemonId: string; readonly startedAt: string };
}): Promise<FleetOverviewResult> {
  const leaseFacts = await authorizedOrThrow(async () => {
    const tasks = await input.cell.read("repo.tasks.list", { limit: 500 }, input.binding);
    const leases: FleetLeaseFact[] = [];
    for (const row of tasks.rows) {
      const lease = row.snapshot.lease;
      if (lease === null || lease === undefined) continue;
      const nodeId =
        lease.source === "local"
          ? FLEET_CENTER_NODE_ID
          : typeof lease.source === "object" && lease.source.kind === "node"
            ? lease.source.nodeId
            : null;
      leases.push({
        taskId: row.taskId,
        title: row.snapshot.task?.title ?? null,
        coordinationStatus: String(row.coordinationStatus),
        leasePhase: lease.phase,
        leaseExpiresAt: lease.expiresAt,
        personId: lease.actor.principal.personId,
        executorId: lease.actor.executor?.id ?? null,
        nodeId,
      });
    }
    const taskIds = [...new Set(leases.map((lease) => lease.taskId))];
    const dispatches =
      taskIds.length === 0
        ? []
        : (await input.cell.read("repo.task.dispatches", { taskIds, limit: 200 }, input.binding)).dispatches.map(
            (row) => ({
              dispatchId: row.dispatchId,
              taskId: row.taskId,
              runtimeSessionId: row.runtimeSessionId,
              agentId: row.agentId ?? null,
              agentName: row.agentName ?? null,
              startedAt: row.startedAt,
              status: row.status,
            }),
          );
    return { leases, dispatches };
  });
  const events = await input.cell.observeTail(
    { kind: "events", direction: "history" },
    { daemonId: input.daemon.daemonId, userRoot: input.userRoot },
  );
  const eventFacts: FleetCanonicalEventFact[] = (events.status === "unavailable" ? [] : events.items).map((item) => {
    const row = item as Record<string, unknown>,
      payload = (row.payload ?? {}) as Record<string, unknown>,
      actor = (row.actor ?? {}) as Record<string, unknown>,
      executor = (actor.executor ?? {}) as Record<string, unknown>;
    return {
      eventId: String(row.eventId),
      type: String(row.type),
      occurredAt: String(row.occurredAt),
      workspaceRevision: Number(row.workspaceRevision),
      taskId: typeof row.taskId === "string" ? row.taskId : null,
      executorId: typeof executor.id === "string" ? executor.id : null,
      title:
        typeof payload.title === "string"
          ? payload.title
          : typeof payload.statement === "string"
            ? payload.statement
            : typeof payload.text === "string"
              ? payload.text
              : null,
    };
  });
  const leaseNodes = new Set<string>(
    leaseFacts.ok ? leaseFacts.value.leases.flatMap((lease) => (lease.nodeId === null ? [] : [lease.nodeId])) : [],
  );
  const nodeOwners = new Map<string, FleetFieldState>();
  const registry = keycloakNodeRegistry(input.keycloakCenter);
  const ownerOf = async (nodeId: string): Promise<FleetFieldState> => {
    try {
      const personId = await registry.nodeOwner(nodeId);
      return { kind: "value", text: personId ?? "not-in-registry" };
    } catch (error) {
      // Keycloak 是外部登记服务:查不到 owner 时该节点字段显式 unavailable(带原因),
      // 不吞错也不让整个拓扑读失败——失败作为字段状态与 warning 显式浮出。
      return {
        kind: "unavailable",
        reason: runtimeErrorCode(error) ?? (error instanceof Error ? error.message : String(error)),
      };
    }
  };
  for (const nodeId of new Set([...input.fleetReplicas.map((replica) => replica.nodeId), ...leaseNodes]))
    nodeOwners.set(nodeId, await ownerOf(nodeId));
  return buildFleetOverview({
    repoId: input.repoId,
    mode: input.mode,
    generatedAt: input.now,
    center: {
      daemonId: input.daemon.daemonId,
      startedAt: input.daemon.startedAt,
      version: process.env.npm_package_version ?? "0.0.0",
      commitSha: daemonBuildStamp().commit,
    },
    replicas: input.fleetReplicas,
    leaseReads: leaseFacts.ok ? { ok: true, ...leaseFacts.value } : { ok: false, code: leaseFacts.code },
    events: eventFacts.slice(0, EVENT_PAGE_LIMIT),
    nodeOwners,
    centerRevision: input.cell.statusCuts()?.ledgerRevision ?? null,
  });
}
