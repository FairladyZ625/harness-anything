import { useCallback, useState } from "react";
import { ArrowClockwise, Plus } from "@phosphor-icons/react";
import { FloatingPanelGrid } from "../panel-workspace/floating-panel-grid.tsx";
import {
  panelWorkspacePreferenceStorage,
  readPanelWorkspaceLayout,
  type PanelWorkspaceStorage,
} from "../panel-workspace/panel-workspace-layout.ts";
import {
  DEFAULT_WORKBENCH_PANEL_IDS,
  WORKBENCH_PANEL_CATALOG,
  buildWorkbenchPanels,
  workbenchPresetGeometry,
  type WorkbenchPanelProps,
} from "../panel-workspace/workbench-panels.tsx";
import { PageHeader } from "../components/primitives/PageHeader";
import { Button } from "../components/primitives/Button";
import { Popover } from "../components/Popover.tsx";
import { t } from "../i18n/index.tsx";

/**
 * 可定制面板工作台(task_f82b0d6058966986403ef1b635 首个检查点;
 * task_48fe291624e06a2e9ad9496c81 面板目录与自由组合)。
 *
 * 预设页面(任务详情的分栏、实体工作台的模式条)之外,把真实功能面板放到同一块
 * 自由画板上:从页头的「面板目录」选择要打开的功能块(有限目录,一个类型一个
 * 面板),拖条拖动、四边四角缩放、放大还原、关闭面板,所选集合与几何按工作区
 * (连接目标 + 仓)保存恢复、一键重置回默认三块。面板是完整功能块——目录与功能体
 * 的组合源在 workbench-panels.tsx,页面与工作台共用同一套组件,不复制业务状态。
 */
export type PanelWorkbenchViewProps = WorkbenchPanelProps & {
  /** 布局分槽键:daemon 投影的 connectionId + repoId(连接目标 + 仓),不取显示名。 */
  readonly workspaceKey: string;
  /** 测试注入的存储;缺省 renderer localStorage。 */
  readonly storage?: PanelWorkspaceStorage | null;
};

export function PanelWorkbenchView(props: PanelWorkbenchViewProps) {
  const storage = props.storage ?? panelWorkspacePreferenceStorage();
  const [resetNonce, setResetNonce] = useState(0);
  const [openIds, setOpenIds] = useState<readonly string[]>(
    () => readPanelWorkspaceLayout(storage, props.workspaceKey).panels ?? DEFAULT_WORKBENCH_PANEL_IDS,
  );

  /** 选择变更只更新画板输入；几何与选择由画板统一落盘并显示错误。 */
  const togglePanel = useCallback(
    (panelId: string) => {
      const next = openIds.includes(panelId) ? openIds.filter((id) => id !== panelId) : [...openIds, panelId];
      setOpenIds(next);
    },
    [openIds],
  );

  /** 重置:选择集合与几何一起回默认。清槽由画板的重置路径完成(resetNonce 驱动)。 */
  const resetWorkbench = useCallback(() => {
    setOpenIds(DEFAULT_WORKBENCH_PANEL_IDS);
    setResetNonce((nonce) => nonce + 1);
  }, []);

  const open = new Set(openIds);
  const panels = buildWorkbenchPanels(props).filter((panel) => open.has(panel.id));

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="panel-workbench-view">
      <PageHeader
        testId="panel-workbench-header"
        title={t("views.panelWorkbench.title")}
        note={t("views.panelWorkbench.note")}
        actions={
          <>
            <Popover
              label={t("views.panelWorkbench.addPanel")}
              testId="panel-catalog-button"
              panelClassName="w-64"
              triggerClassName="ui-control inline-flex w-max shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded border border-border-strong px-2.5 ui-meta text-text hover:border-text-faint hover:bg-surface"
              trigger={
                <>
                  <Plus weight="bold" className="ui-meta" />
                  {t("views.panelWorkbench.addPanel")}
                </>
              }
            >
              {() => (
                <ul className="flex flex-col gap-0.5 py-1" data-testid="panel-catalog-list">
                  {WORKBENCH_PANEL_CATALOG.map((entry) => {
                    const entryOpen = openIds.includes(entry.id);
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          data-testid={`panel-catalog-entry-${entry.id}`}
                          aria-pressed={entryOpen}
                          onClick={() => togglePanel(entry.id)}
                          className={`flex w-full items-center gap-2 rounded-xs px-2.5 py-1.5 text-left ui-meta ${
                            entryOpen
                              ? "border border-accent/40 bg-accent/15 font-semibold text-accent"
                              : "border border-transparent text-text-muted hover:bg-surface-raised hover:text-text"
                          }`}
                        >
                          {t(entry.titleKey)}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Popover>
            <Button variant="ghost" testId="panel-workbench-reset" onClick={resetWorkbench}>
              <ArrowClockwise weight="bold" className="ui-meta" />
              {t("views.panelWorkbench.resetLayout")}
            </Button>
          </>
        }
      />
      <main className="relative min-h-0 flex-1 px-3 pb-3">
        <FloatingPanelGrid
          workspaceId={props.workspaceKey}
          panels={panels}
          presetGeometry={workbenchPresetGeometry}
          onClosePanel={togglePanel}
          storage={storage}
          resetNonce={resetNonce}
        />
        {panels.length === 0 ? (
          <div
            className="pointer-events-none absolute inset-0 grid place-items-center p-6"
            data-testid="panel-workbench-empty"
          >
            <p className="max-w-sm text-center ui-meta text-text-faint">{t("views.panelWorkbench.emptyCanvas")}</p>
          </div>
        ) : null}
      </main>
    </div>
  );
}
