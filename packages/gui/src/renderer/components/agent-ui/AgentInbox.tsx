import { useRef, useState, type ReactNode } from "react";
import { LayoutGroup, motion } from "motion/react";
import { useEntryMotion } from "../../motion-config.tsx";
import { MOTION_DURATION, MOTION_EASE } from "../../motion-tokens.ts";
import { Button } from "../primitives/Button.tsx";
import { Empty } from "../primitives/Empty.tsx";
import { SegCtl } from "../primitives/SegCtl.tsx";
import { formatListTime } from "../../model/time.ts";
import { t, type MessageKey } from "../../i18n/index.tsx";

/**
 * agent-ui 全量后台任务收件箱(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2 / Affect UI AgentInbox 契约,
 * 分栏序数沿 Orca 五级注意力模型的头部三级:Needs you > Running > Done):
 * Board 三栏 / List 单列两视图,行内展开最近步骤并直接 Approve/Reject/Retry/Open,
 * 状态变更时卡片经 FLIP 平滑滑入新分栏。自包含 props 驱动,接入点在 W3 统一审批中心。
 */

export type InboxLane = "needs-you" | "running" | "done";
export type InboxActionKind = "approve" | "reject" | "retry" | "open";

export interface InboxItem {
  readonly id: string;
  readonly title: string;
  readonly agentName?: string;
  readonly lane: InboxLane;
  /** ISO 时间戳,列表行时间显示。 */
  readonly updatedAt?: string;
  /** 注意力说明(如「等待审批:Bash rm -rf」)。 */
  readonly note?: string;
  /** 最近执行步骤(行内展开显示,最新在后)。 */
  readonly recentSteps?: readonly string[];
  /** 行内动作;kind 决定默认文案与档位。 */
  readonly actions?: readonly InboxItemAction[];
  /** 自定义外层行 testId(如 my-asks-row-${id})。 */
  readonly testId?: string;
  /** 点击整行触发的导航/抽屉选择。 */
  readonly onSelect?: (item: InboxItem) => void;
}

export interface InboxItemAction {
  readonly kind: InboxActionKind;
  readonly label?: string;
  readonly onTrigger: (item: InboxItem) => void;
}

const LANE_ORDER: readonly InboxLane[] = ["needs-you", "running", "done"];

const LANE_META: Record<
  InboxLane,
  { readonly labelKey: MessageKey; readonly emptyKey: MessageKey; readonly dotClass: string }
> = {
  "needs-you": {
    labelKey: "agentUi.inbox.lane.needsYou",
    emptyKey: "agentUi.inbox.lane.empty.needsYou",
    dotClass: "bg-agent-question",
  },
  running: {
    labelKey: "agentUi.inbox.lane.running",
    emptyKey: "agentUi.inbox.lane.empty.running",
    dotClass: "bg-status-active",
  },
  done: {
    labelKey: "agentUi.inbox.lane.done",
    emptyKey: "agentUi.inbox.lane.empty.done",
    dotClass: "bg-status-done",
  },
};

const ACTION_META: Record<
  InboxActionKind,
  { readonly labelKey: MessageKey; readonly variant: "plain" | "primary" | "ghost" }
> = {
  approve: { labelKey: "agentUi.inbox.action.approve", variant: "primary" },
  reject: { labelKey: "agentUi.inbox.action.reject", variant: "ghost" },
  retry: { labelKey: "agentUi.inbox.action.retry", variant: "plain" },
  open: { labelKey: "agentUi.inbox.action.open", variant: "plain" },
};

function InboxRow({
  item,
  expanded,
  onToggle,
  testId,
}: {
  readonly item: InboxItem;
  readonly expanded: boolean;
  readonly onToggle: (next: boolean) => void;
  readonly testId: string;
}): ReactNode {
  const rowTestId = testId;
  const outerTestId = item.testId ?? testId;
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Esc 收起展开并把焦点还给行触发按钮(无障碍约束:焦点归位)。
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      onToggle(false);
      triggerRef.current?.focus();
    }
  };
  const { enabled, reduced } = useEntryMotion();
  const body = (
    <>
      {/* 原生 button:整行折叠头(disclosure 控件,aria-expanded+aria-controls,含标题/备注/时间/箭头),
          且 Esc 焦点归位需要它的 ref;Button 的动作密度与 feedback 语义不适用,故保留原生。 */}
      <button
        ref={triggerRef}
        type="button"
        data-testid={`${rowTestId}-toggle`}
        aria-expanded={expanded}
        aria-controls={`${rowTestId}-body`}
        onClick={() => {
          onToggle(!expanded);
          item.onSelect?.(item);
        }}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface"
      >
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${LANE_META[item.lane].dotClass}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate ui-meta font-semibold text-text">
            {item.agentName !== undefined && (
              <span className="mr-1.5 font-mono ui-micro font-normal text-text-faint">{item.agentName}</span>
            )}
            {item.title}
          </span>
          {item.note !== undefined && (
            <span data-testid={`${rowTestId}-note`} className="block truncate font-mono ui-micro text-text-faint">
              {item.note}
            </span>
          )}
        </span>
        {item.updatedAt !== undefined && (
          <span className="shrink-0 font-mono ui-micro text-text-faint">{formatListTime(item.updatedAt)}</span>
        )}
        <span aria-hidden className="shrink-0 font-mono ui-micro text-text-faint">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div
          id={`${rowTestId}-body`}
          role="region"
          aria-label={t("agentUi.inbox.stepsAria")}
          className="flex flex-col gap-2 border-t border-border px-2.5 py-2"
        >
          {item.recentSteps !== undefined && item.recentSteps.length > 0 ? (
            <ol data-testid={`${rowTestId}-steps`} className="flex flex-col gap-0.5 pl-1">
              {item.recentSteps.map((step, index) => (
                <li key={index} className="truncate ui-micro leading-relaxed text-text-muted">
                  <span className="mr-1.5 font-mono text-text-faint">{index + 1}.</span>
                  {step}
                </li>
              ))}
            </ol>
          ) : (
            <Empty>{t("agentUi.inbox.stepsEmpty")}</Empty>
          )}
          {item.actions !== undefined && item.actions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {item.actions.map((action) => (
                <Button
                  key={action.kind}
                  size="sm"
                  variant={ACTION_META[action.kind].variant}
                  testId={`${rowTestId}-action-${action.kind}`}
                  onClick={() => action.onTrigger(item)}
                >
                  {action.label ?? t(ACTION_META[action.kind].labelKey)}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
  const className = "min-w-0 rounded-lg border border-border bg-surface-raised/40";
  // FLIP 跨分栏滑动由 layoutId 共享布局承担;关动效时退回普通 div(与 SegCtl 同款档位切换)。
  // 键盘归位挂在两种分支上,与动效偏好无关。
  if (!enabled || reduced)
    return (
      <div data-testid={outerTestId} data-lane={item.lane} className={className} onKeyDown={onKeyDown}>
        {body}
      </div>
    );
  return (
    <motion.div
      layoutId={`inbox-item-${item.id}`}
      layout
      data-testid={outerTestId}
      data-lane={item.lane}
      onKeyDown={onKeyDown}
      transition={{ duration: MOTION_DURATION.controlSlide, ease: MOTION_EASE.out }}
      className={className}
    >
      {body}
    </motion.div>
  );
}

export function AgentInbox({
  items,
  view = "board",
  onViewChange,
  testId = "agent-inbox",
}: {
  readonly items: readonly InboxItem[];
  /** 受控视图;不传 onViewChange 时只按初始值渲染。 */
  readonly view?: "board" | "list";
  onViewChange?: (view: "board" | "list") => void;
  readonly testId?: string;
}) {
  const [internalView, setInternalView] = useState(view);
  // 受控:给了 onViewChange 就以 view prop 为准;未给时走内部状态。
  const activeView = onViewChange === undefined ? internalView : view;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const byLane = new Map<InboxLane, InboxItem[]>(
    LANE_ORDER.map((lane) => [lane, items.filter((item) => item.lane === lane)]),
  );
  const listItems = LANE_ORDER.flatMap((lane) => byLane.get(lane) ?? []);
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold ui-heading text-text">{t("agentUi.inbox.title")}</span>
        <SegCtl
          value={activeView}
          label={t("agentUi.inbox.viewAria")}
          onChange={(next) => {
            setInternalView(next);
            onViewChange?.(next);
          }}
          options={[
            { value: "board", label: t("agentUi.inbox.viewBoard"), testId: "inbox-view-board" },
            { value: "list", label: t("agentUi.inbox.viewList"), testId: "inbox-view-list" },
          ]}
        />
      </div>
      <LayoutGroup>
        {activeView === "board" ? (
          <div className="grid min-w-0 gap-3 lg:grid-cols-3">
            {LANE_ORDER.map((lane) => {
              const laneItems = byLane.get(lane) ?? [];
              return (
                <section
                  key={lane}
                  role="region"
                  aria-label={t(LANE_META[lane].labelKey)}
                  data-testid={`inbox-column-${lane}`}
                  className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface/40 p-2.5"
                >
                  <header className="flex items-center gap-2">
                    <span aria-hidden className={`size-1.5 rounded-full ${LANE_META[lane].dotClass}`} />
                    <span className="ui-meta font-semibold text-text">{t(LANE_META[lane].labelKey)}</span>
                    <span
                      data-testid={`inbox-column-${lane}-count`}
                      className="ml-auto font-mono ui-micro tabular-nums text-text-faint"
                    >
                      {laneItems.length}
                    </span>
                  </header>
                  {laneItems.length === 0 && <Empty>{t(LANE_META[lane].emptyKey)}</Empty>}
                  {laneItems.map((item) => (
                    <InboxRow
                      key={item.id}
                      item={item}
                      expanded={expandedId === item.id}
                      onToggle={(next) => setExpandedId(next ? item.id : null)}
                      testId={`inbox-item-${item.id}`}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            {listItems.length === 0 && <Empty>{t("agentUi.inbox.emptyInbox")}</Empty>}
            {listItems.map((item) => (
              <InboxRow
                key={item.id}
                item={item}
                expanded={expandedId === item.id}
                onToggle={(next) => setExpandedId(next ? item.id : null)}
                testId={`inbox-item-${item.id}`}
              />
            ))}
          </div>
        )}
      </LayoutGroup>
    </div>
  );
}
