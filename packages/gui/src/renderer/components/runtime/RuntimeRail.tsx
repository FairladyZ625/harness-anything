import { useState, type CSSProperties, type ReactNode } from "react";
import type { RuntimeInstanceSummary } from "@harness-anything/daemon/protocol";
import {
  isAvailableAgentEntityRow,
  isAvailableSquadEntityRow,
  type AgentEntityRow,
  type SquadEntityRow,
} from "../../agent-entity-client.ts";
import { t } from "../../i18n/index.tsx";
import {
  runtimeAuthPresentation,
  runtimeAuthPresentationText,
  type RuntimeAuthProbeState,
} from "../../runtime-auth-presentation.ts";
import { DenseRow } from "../primitives/DenseRow.tsx";
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
  // 探测态(authProbeStates)与目录行合并一次,排序与行渲染用同一份呈现。
  const rows = instances.map((instance) => {
    const auth = runtimeAuthPresentation(instance, authProbeStates?.get(instance.instanceId));
    return { instance, auth, abnormal: !instance.enabled || auth.cap === "none" };
  });
  const ordered = [...rows].sort((left, right) => Number(right.abnormal) - Number(left.abnormal));
  return (
    <nav
      data-testid="runtime-rail"
      aria-label={t("agentRuntime.railLabel")}
      className="flex basis-1/5 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface"
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
          const authTip = runtimeAuthPresentationText(instance, auth),
            live = liveByInstance.get(instance.instanceId) ?? 0,
            tone = !instance.enabled ? "cancel" : auth.cap === "none" ? "bad" : auth.cap === "part" ? "wait" : "done";
          return (
            <div
              key={instance.instanceId}
              data-testid={`rail-runtime-${instance.instanceId}`}
              aria-current={selectedId === instance.instanceId || undefined}
              className="status-edge relative"
              style={abnormal ? badEdge : undefined}
            >
              <DenseRow
                tag={
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
                }
                title={
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <KindDot kind={instance.kindId} />
                    <span className="min-w-0 truncate">{instance.name}</span>
                  </span>
                }
                reason={tone === "done" ? undefined : authTip}
                time={live > 0 ? t("agentRuntime.liveCount", { count: live }) : instance.defaultModel}
                selected={selectedId === instance.instanceId}
                onClick={() => onSelect(instance.instanceId)}
              />
            </div>
          );
        })}
      </Segment>
    </nav>
  );
}

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
      aria-label={t("agentRuntime.railLabel")}
      className="flex basis-1/5 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface"
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
            <div
              key={agent.id}
              data-testid={`rail-agent-${agent.id}`}
              aria-current={picked("agent", agent.id) || undefined}
            >
              <DenseRow
                tag={<RoleLabel role={agent.role} />}
                title={
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Avatar id={agent.id} />
                    <span className="min-w-0 truncate">{agent.name}</span>
                  </span>
                }
                time={
                  <span data-tip={t("agentRuntime.layerTip", { layer: agent.layer })} className="font-mono">
                    {agent.layer}
                  </span>
                }
                selected={picked("agent", agent.id)}
                onClick={() => onSelect({ type: "agent", id: agent.id })}
              />
            </div>
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
            <div
              key={squad.id}
              data-testid={`rail-squad-${squad.id}`}
              aria-current={picked("squad", squad.id) || undefined}
            >
              <DenseRow
                tag={<span className="font-mono ui-micro text-text-faint">{squad.workers.length + 1}</span>}
                title={
                  <span className="flex min-w-0 items-center gap-1.5">
                    <KindDot kind="any" />
                    <span className="min-w-0 truncate">{squad.name}</span>
                  </span>
                }
                selected={picked("squad", squad.id)}
                onClick={() => onSelect({ type: "squad", id: squad.id })}
              />
            </div>
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
      <details className="px-2.5 py-2 ui-micro leading-[1.5] text-text-faint">
        <summary className="cursor-pointer list-none">{t("agentRuntime.thesisSummary")}</summary>
        <p className="mt-1">{t("agentRuntime.thesisBody")}</p>
      </details>
    </nav>
  );
}

const isDegraded = (row: AgentEntityRow | SquadEntityRow): boolean => "state" in row;

type DegradedEntityRow = Extract<AgentEntityRow, { readonly state: "invalid" | "missing" }>;

/** 降级行:目录健康信号不是禁用项——可选中,原因(声明校验结果)直接写在行上。 */
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
    <div
      data-testid={`rail-${kind}-${row.id}`}
      aria-current={selected || undefined}
      className="status-edge relative"
      style={badEdge}
    >
      <DenseRow
        tag={
          <StatusTag
            tone="bad"
            label={t(row.state === "missing" ? "agentRuntime.catalogMissing" : "agentRuntime.catalogInvalid")}
          />
        }
        title={<span className="font-mono">{row.id}</span>}
        reason={row.error.hint}
        selected={selected}
        onClick={onSelect}
      />
    </div>
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
    <section className="border-b border-border">
      <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1.5 hover:bg-surface-raised">
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
          <span className="ui-micro font-bold uppercase tracking-[0.09em] text-text-faint">{title}</span>
          <span className="truncate ui-micro text-text-faint">{sub}</span>
          <span className="ml-auto shrink-0 font-mono ui-micro text-text-faint">
            {total !== undefined && total !== count ? `${count}/${total}` : count}
          </span>
        </button>
        {onNew && (
          <button
            type="button"
            data-testid={`runtime-new-${segment}`}
            onClick={onNew}
            className="shrink-0 rounded border border-border px-1.5 ui-micro text-text-faint hover:border-accent hover:text-accent"
          >
            {t("agentRuntime.new")}
          </button>
        )}
      </div>
      {open && <div className="px-1.5 pb-2">{count === 0 && emptyHint !== undefined ? emptyHint : children}</div>}
    </section>
  );
}
