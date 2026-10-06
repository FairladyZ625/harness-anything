import { useState, type CSSProperties, type ReactNode } from "react";
import type { RuntimeInstanceSummary } from "@harness-anything/daemon/protocol";
import {
  isAvailableAgentEntityRow,
  isAvailableSquadEntityRow,
  type AgentEntityRow,
  type SquadEntityRow,
} from "../../agent-entity-client.ts";
import { t } from "../../i18n/index.tsx";
import { runtimeAuthPresentation, type RuntimeAuthProbeState } from "../../runtime-auth-presentation.ts";
import { DenseRow } from "../primitives/DenseRow.tsx";
import { catalogRailCompactClass } from "../primitives/CatalogSplit.tsx";
import { StatusTag, TONE_COLOR } from "../primitives/StatusTag.tsx";
import { Avatar, KindDot } from "./parts.tsx";
import type { RuntimeSelection } from "./useRuntimeWorkspace.ts";

// W6 IA 拆分:原四段聚合 rail 随「Agent 运行时」入口撤销,拆成页级 rail——
// ProviderRail(承运者)/ IdentityRail(身份 + 组织,Squad 是 Agent 页内的面)。
// 会话页的 SessionRail 已随会话页重构撤销:会话列表改为 daemon 分组读面
// (sessionGroups),组件在 components/sessions/ 下。行渲染与 testid
// (rail-runtime-*/rail-agent-*/rail-squad-*/runtime-new-*)原样保留;跨页不再
// 共享选中态,互跳走可寻址路由。
//
// 目录版式(标准 §2.5):行用 DenseRow,健康/可用状态用有底色 StatusTag,异常项
// 置顶并用 .status-edge 红竖线强调,正常项不加强调;降级行可选中——右侧详情就地
// 解释为什么无效,不再把「无效」只留在 tooltip 里。

/** 行级红竖线:异常项点亮,正常项不占位(styles.css 的 .status-edge::after)。 */
const badEdge = { "--status-edge": TONE_COLOR.bad } as CSSProperties;

/**
 * 探测态(authProbeStates)与目录行合并一次:排序、行渲染与页面默认选中用同一份呈现。
 * 排序分档(标准 §2.5 v2):不可达是异常,置顶;已停用是人为关掉、不是出错,整组沉到
 * 列表下面;其余保持目录序。
 */
export function orderProviderRows(
  instances: readonly RuntimeInstanceSummary[],
  authProbeStates?: ReadonlyMap<string, RuntimeAuthProbeState>,
) {
  const rows = instances.map((instance) => {
    const auth = runtimeAuthPresentation(instance, authProbeStates?.get(instance.instanceId));
    return {
      instance,
      auth,
      rank: !instance.enabled ? 2 : auth.cap === "none" ? 0 : 1,
      abnormal: instance.enabled && auth.cap === "none",
    };
  });
  return rows.sort((left, right) => left.rank - right.rank);
}

export function ProviderRail({
  instances,
  authProbeStates,
  selectedId,
  liveByInstance,
  onSelect,
  onNew,
}: {
  readonly instances: readonly RuntimeInstanceSummary[];
  readonly authProbeStates?: ReadonlyMap<string, RuntimeAuthProbeState>;
  readonly selectedId: string | null;
  readonly liveByInstance: ReadonlyMap<string, number>;
  readonly onSelect: (instanceId: string) => void;
  readonly onNew: () => void;
}) {
  const [open, setOpen] = useState(true);
  const ordered = orderProviderRows(instances, authProbeStates);
  return (
    <nav
      data-testid="runtime-rail"
      data-pane="list"
      aria-label={t("agentRuntime.railLabel")}
      className="flex w-full flex-col overflow-y-auto bg-surface @min-[720px]:basis-1/5 @min-[720px]:shrink-0 @min-[720px]:border-r @min-[720px]:border-border"
    >
      <Segment
        segment="runtimes"
        title={t("agentRuntime.segRuntimes")}
        sub={t("agentRuntime.segRuntimesSub")}
        count={instances.length}
        open={open}
        onToggle={() => setOpen(!open)}
        onNew={onNew}
      >
        {ordered.map(({ instance, auth, abnormal }) => {
          const live = liveByInstance.get(instance.instanceId) ?? 0,
            // 已停用是人为关掉、不是出错:中性灰,不吃异常的红档;「可用」是正常值,同样中性。
            tone = !instance.enabled
              ? "neutral"
              : auth.cap === "none"
                ? "bad"
                : auth.cap === "part"
                  ? "wait"
                  : "neutral",
            tail = live > 0 ? t("agentRuntime.liveCount", { count: live }) : instance.defaultModel;
          return (
            <button
              type="button"
              key={instance.instanceId}
              data-testid={`rail-runtime-${instance.instanceId}`}
              aria-current={selectedId === instance.instanceId || undefined}
              className="status-edge relative w-full text-left"
              style={abnormal ? badEdge : undefined}
              onClick={() => onSelect(instance.instanceId)}
            >
              <DenseRow
                title={
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <KindDot kind={instance.kindId} />
                    <span className="min-w-0 truncate">{instance.name}</span>
                  </span>
                }
                reason={
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0">
                      <StatusTag
                        tone={tone}
                        label={t(
                          !instance.enabled
                            ? "agentRuntime.providerDisabledTag"
                            : auth.cap === "none"
                              ? "agentRuntime.providerUnreachable"
                              : auth.cap === "part"
                                ? auth.state === "probing"
                                  ? "agentRuntime.providerAuthChecking"
                                  : "agentRuntime.providerNotChecked"
                                : "agentRuntime.providerUsable",
                        )}
                      />
                    </span>
                    {tail ? <span className="min-w-0 truncate font-mono">{tail}</span> : null}
                  </span>
                }
                relaxed
                selected={selectedId === instance.instanceId}
              />
            </button>
          );
        })}
      </Segment>
    </nav>
  );
}

// 目录行单行(视觉基线 v2.2,业主 2026-10-06 信息密度反馈):第一行只放名称(完整可读),
// 右侧一个小号模型/规模标签;模型、所在 Squad、leader 等第二行内容收进悬停全文
// (DenseRow.hoverTitle 契约),详情仍是完整出处。角色、层级、运行时是多数行重复的
// 值,只在顶部筛选里出现(标准 §2.4「重复值不进行」)。
//
// The identity rail: Agents and Squads share one page because a Squad has no lifecycle
// apart from its agents (proposal P2) — organisation is a facet of identity here, not a
// fourth entry. The design-thesis note stays at this rail's foot: dispatch is authored
// from this page, and the formula it explains (Agent × Runtime × Task → Session) is the
// one this page starts.
export function IdentityRail({
  agents,
  squads,
  selection,
  onSelect,
  onNew,
  toolbar,
  agentsTotal,
  squadsTotal,
  notice,
  agentsEmpty,
  squadsEmpty,
  agentNames,
  squadsByAgent,
}: {
  readonly agents: readonly AgentEntityRow[];
  readonly squads: readonly SquadEntityRow[];
  readonly selection: RuntimeSelection | null;
  readonly onSelect: (selection: RuntimeSelection) => void;
  readonly onNew: (segment: "agents" | "squads") => void;
  /** 列表顶部工具栏(搜索/筛选);rail 只出位置,内容归视图组装。 */
  readonly toolbar?: ReactNode;
  /** 过滤态的总数;给出且与可见数不同时段标题显示「命中/总数」。 */
  readonly agentsTotal?: number;
  readonly squadsTotal?: number;
  /** 贴在工具栏下的提示条(如「当前选中项被筛选隐藏」+ 清除入口)。 */
  readonly notice?: ReactNode;
  /** 段内零命中时的占位行(仅在对应段为空时渲染)。 */
  readonly agentsEmpty?: ReactNode;
  readonly squadsEmpty?: ReactNode;
  /** 全目录(不受筛选影响)的 Agent 名称与所在 Squad 名称,供第二行说明使用。 */
  readonly agentNames: ReadonlyMap<string, string>;
  readonly squadsByAgent: ReadonlyMap<string, readonly string[]>;
}) {
  const [segments, setSegments] = useState<Readonly<Record<string, boolean>>>({ agents: true, squads: true });
  const onToggle = (segment: string) => setSegments((value) => ({ ...value, [segment]: !(value[segment] ?? true) }));
  // 异常置顶:降级行(invalid/missing)排到段首,顺序其余保持 catalog 序。
  const degradedFirst = <T extends AgentEntityRow | SquadEntityRow>(rows: readonly T[]): T[] =>
    [...rows].sort((left, right) => Number(isDegraded(right)) - Number(isDegraded(left)));
  const picked = (type: "agent" | "squad", id: string) => selection?.type === type && selection.id === id;
  return (
    <nav
      data-testid="runtime-rail"
      data-pane="list"
      aria-label={t("agentRuntime.railLabel")}
      className={catalogRailCompactClass}
    >
      {toolbar}
      {notice}
      <Segment
        segment="agents"
        title={t("agentRuntime.segAgents")}
        sub={t("agentRuntime.segAgentsSub")}
        count={agents.length}
        total={agentsTotal}
        open={segments.agents ?? true}
        onToggle={() => onToggle("agents")}
        onNew={() => onNew("agents")}
        emptyHint={agentsEmpty}
      >
        {degradedFirst(agents).map((agent) =>
          isAvailableAgentEntityRow(agent) ? (
            <button
              type="button"
              key={agent.id}
              data-testid={`rail-agent-${agent.id}`}
              aria-current={picked("agent", agent.id) || undefined}
              className="w-full text-left"
              onClick={() => onSelect({ type: "agent", id: agent.id })}
            >
              <DenseRow
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar id={agent.id} />
                    <span className="min-w-0 truncate font-medium">{agent.name}</span>
                  </span>
                }
                // 右侧唯一关键量:首选模型(能区分这一行的信息);完整「模型 · 所在
                // Squad」与 agent id 收进悬停全文,详情卡仍是完整出处。
                time={agent.runtimes[0]?.model ?? agent.runtimes[0]?.type}
                hoverTitle={agentLineSummary(agent.runtimes, squadsByAgent.get(agent.id) ?? [], agent.id)}
                selected={picked("agent", agent.id)}
              />
            </button>
          ) : (
            <RailDegradedRow
              key={agent.id}
              kind="agent"
              row={agent}
              selected={picked("agent", agent.id)}
              onSelect={() => onSelect({ type: "agent", id: agent.id })}
            />
          ),
        )}
      </Segment>
      <Segment
        segment="squads"
        title={t("agentRuntime.segSquads")}
        sub={t("agentRuntime.segSquadsSub")}
        count={squads.length}
        total={squadsTotal}
        open={segments.squads ?? true}
        onToggle={() => onToggle("squads")}
        onNew={() => onNew("squads")}
        emptyHint={squadsEmpty}
      >
        {degradedFirst(squads).map((squad) =>
          isAvailableSquadEntityRow(squad) ? (
            <button
              type="button"
              key={squad.id}
              data-testid={`rail-squad-${squad.id}`}
              aria-current={picked("squad", squad.id) || undefined}
              className="w-full text-left"
              onClick={() => onSelect({ type: "squad", id: squad.id })}
            >
              <DenseRow
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <KindDot kind="any" />
                    <span className="min-w-0 truncate font-medium">{squad.name}</span>
                  </span>
                }
                time={t("agentRuntime.memberCount", { count: squad.workers.length + 1 })}
                hoverTitle={`${agentNames.get(squad.leader) ?? squad.leader} · ${squad.id}`}
                selected={picked("squad", squad.id)}
              />
            </button>
          ) : (
            <RailDegradedRow
              key={squad.id}
              kind="squad"
              row={squad}
              selected={picked("squad", squad.id)}
              onSelect={() => onSelect({ type: "squad", id: squad.id })}
            />
          ),
        )}
      </Segment>
      <details className="px-3.5 py-3 ui-meta text-text-faint">
        <summary className="cursor-pointer list-none">{t("agentRuntime.thesisSummary")}</summary>
        <p className="mt-1">{t("agentRuntime.thesisBody")}</p>
      </details>
    </nav>
  );
}

const isDegraded = (row: AgentEntityRow | SquadEntityRow): boolean => "state" in row;

/** Agent 行悬停全文:完整模型清单、所在 Squad 与 agent id——行上只露首选模型。 */
function agentLineSummary(
  runtimes: readonly { readonly type: string; readonly model?: string | null }[],
  squads: readonly string[],
  id: string,
): string {
  return [runtimes.map((target) => target.model ?? target.type).join(" / "), ...squads, id].filter(Boolean).join(" · ");
}

type DegradedEntityRow = Extract<AgentEntityRow, { readonly state: "invalid" | "missing" }>;

/** 降级行:目录健康信号不是禁用项——可选中,状态标签就在行上;校验原因收进悬停,
 * 右侧详情就地解释为什么无效(标准 §2.5)。 */
function RailDegradedRow({
  kind,
  row,
  selected,
  onSelect,
}: {
  readonly kind: "agent" | "squad";
  readonly row: DegradedEntityRow;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`rail-${kind}-${row.id}`}
      aria-current={selected || undefined}
      className="status-edge relative w-full text-left"
      style={badEdge}
      onClick={onSelect}
    >
      <DenseRow
        title={<span className="font-mono">{row.id}</span>}
        time={
          <StatusTag
            tone="bad"
            label={t(row.state === "missing" ? "agentRuntime.catalogMissing" : "agentRuntime.catalogInvalid")}
          />
        }
        hoverTitle={row.error.hint}
        selected={selected}
      />
    </button>
  );
}

/** 角色标签(worker/reviewer/commander):目录与详情共用同一份呈现。 */
export function RoleLabel({ role }: { readonly role: "worker" | "reviewer" | "commander" }) {
  return (
    <span
      className={["shrink-0 rounded-[3px] border px-1 font-mono ui-micro tracking-[0.04em]", "text-text-muted"].join(
        " ",
      )}
      style={{ borderColor: "var(--color-border-strong)" }}
    >
      {t(
        role === "commander"
          ? "agentRuntime.roleCommander"
          : role === "reviewer"
            ? "agentRuntime.roleReviewer"
            : "agentRuntime.roleWorker",
      )}
    </span>
  );
}

function Segment({
  segment,
  title,
  sub,
  count,
  total,
  open,
  onToggle,
  onNew,
  emptyHint,
  children,
}: {
  readonly segment: string;
  readonly title: string;
  readonly sub: string;
  readonly count: number;
  readonly total?: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onNew?: () => void;
  readonly emptyHint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="pb-4">
      <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1.5 hover:bg-surface-raised">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span
            aria-hidden
            className={`shrink-0 ui-micro text-text-faint transition-transform ${open ? "rotate-90" : ""}`}
          >
            ▶
          </span>
          <span className="ui-meta font-semibold text-text-muted">{title}</span>
          <span className="truncate ui-meta text-text-faint">{sub}</span>
          <span className="ml-auto shrink-0 font-mono ui-meta text-text-faint">
            {total !== undefined && total !== count ? `${count}/${total}` : count}
          </span>
        </button>
        {onNew && (
          <button
            type="button"
            data-testid={`runtime-new-${segment}`}
            onClick={onNew}
            className="h-7 shrink-0 rounded border border-border px-2.5 ui-meta text-text-muted hover:border-accent hover:text-accent"
          >
            {t("agentRuntime.new")}
          </button>
        )}
      </div>
      {open && <div>{count === 0 && emptyHint !== undefined ? emptyHint : children}</div>}
    </section>
  );
}
