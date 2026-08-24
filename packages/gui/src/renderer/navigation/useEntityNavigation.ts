import { useCallback, useState } from "react";
import { pushRecentRef } from "./recentRefs.ts";
import { entityDetailTargetOf } from "./entityRoutes.ts";
import type { AppLocation } from "./viewHistory.ts";

/**
 * 实体导航(W4 从 AppShell 抽出):所有「跳去某个实体」的出口集中在此。
 *
 * 路由表(可寻址):
 *   task/<id>            → selectedId(TaskDetailView 既有路由)
 *   decision/<id>        → decisionDetail 详情页(不落决策池)
 *   fact/<task>/<anchor> → factDetail 详情页(W5 起事实分诊列表页已撤销)
 *   repo/<repoId>/<ref>  → 先切仓再导航(仓未启用 → 回 home 开项目切换器)
 * 显式「在决策池中查看」走 openDecisionInPool,落列表页并带焦点。
 *
 * recentRefs(最近访问,关系图左栏数据源)在此维护:点过/聚焦过的实体推头部,
 * 去重 + 截断。
 */
export function useEntityNavigation({
  navigate,
  updateLocation,
  activeRepoId,
  enabledRepoIds,
  openInRepo,
  onRepoUnavailable,
}: {
  navigate: (fields: Partial<AppLocation>) => void;
  updateLocation: (fields: Partial<AppLocation>) => void;
  activeRepoId: string | null;
  enabledRepoIds: ReadonlyArray<string>;
  /** 跨仓导航:切到目标仓后执行续导航(在本仓内打开 ref)。 */
  openInRepo: (repoId: string, continueInRepo: () => void) => void;
  /** 目标仓未启用:回 home 并打开项目切换器。 */
  onRepoUnavailable: () => void;
}) {
  const [recentRefs, setRecentRefs] = useState<string[]>([]);

  const remember = useCallback((ref: string) => {
    setRecentRefs((prev) => pushRecentRef(prev, ref));
  }, []);

  const openTaskPreview = useCallback(
    (id: string) => {
      updateLocation({ selectedId: null, previewId: id });
    },
    [updateLocation],
  );

  const openTaskDetail = useCallback(
    (id: string) => {
      navigate({ focusedEntityRef: `task/${id}`, previewId: null, selectedId: id });
    },
    [navigate],
  );

  // 本仓内导航:task → 既有详情路由;decision/fact → 详情页;其余引用忽略。
  const navigateLocalEntity = useCallback(
    (ref: string) => {
      remember(ref);
      if (ref.startsWith("task/")) {
        openTaskDetail(ref.slice(5).split("/")[0]);
        return;
      }
      const target = entityDetailTargetOf(ref);
      if (target) navigate({ ...target, selectedId: null, previewId: null });
    },
    [navigate, openTaskDetail, remember],
  );

  // 决策池聚焦跳转:落列表页并高亮滚动到该 decision(池内 tab 自动切换)。
  const openDecisionInPool = useCallback(
    (decisionId: string) => {
      remember(`decision/${decisionId}`);
      navigate({ focusedEntityRef: `decision/${decisionId}`, view: "decisionPool", selectedId: null, previewId: null });
    },
    [navigate, remember],
  );

  // 运行时实体选择(W6 拆分后三个入口的唯一互跳通道):agent/squad/session/provider
  // 引用经 entityRoutes 落到各自入口并推栈——页内选择与跨入口跳转同一条路径,
  // 导航回撤原路返回。runtime 引用不进 recentRefs(那是关系图的邻域记录)。
  const selectRuntimeEntity = useCallback(
    (ref: string) => {
      const target = entityDetailTargetOf(ref);
      if (target) navigate({ ...target, selectedId: null, previewId: null });
    },
    [navigate],
  );

  // 带 repo/<repoId>/ 前缀的实体引用先显式切仓,再在该仓导航。
  const navigateToEntity = useCallback(
    (rawRef: string) => {
      const scoped = /^repo\/([^/]+)\/(.+)$/u.exec(rawRef);
      const targetRepoId = scoped?.[1] ?? activeRepoId;
      const ref = scoped?.[2] ?? rawRef;
      if (targetRepoId && targetRepoId !== activeRepoId) {
        if (!enabledRepoIds.includes(targetRepoId)) {
          onRepoUnavailable();
          return;
        }
        openInRepo(targetRepoId, () => navigateLocalEntity(ref));
        return;
      }
      navigateLocalEntity(ref);
    },
    [activeRepoId, enabledRepoIds, navigateLocalEntity, onRepoUnavailable, openInRepo],
  );

  const navigateToDecision = useCallback(
    (decisionId: string) => navigateToEntity(`decision/${decisionId}`),
    [navigateToEntity],
  );
  const navigateToTask = useCallback((taskId: string) => openTaskDetail(taskId), [openTaskDetail]);

  const focusEntityInGraph = useCallback(
    (ref: string) => {
      remember(ref);
      navigate({ focusedEntityRef: ref, view: "graph", selectedId: null, previewId: null });
    },
    [navigate, remember],
  );

  // 图内换焦点(双击 / 领地 chip / 抽屉设焦 / 最近访问列表自身 / 焦点前后退)同样计入最近访问,否则那条侧栏记不下在图里逛过的东西。
  const focusEntityInWorkspace = useCallback(
    (ref: string | null) => {
      if (ref === null) {
        updateLocation({ focusedEntityRef: null });
        return;
      }
      remember(ref);
      navigate({ focusedEntityRef: ref });
    },
    [navigate, remember, updateLocation],
  );

  return {
    recentRefs,
    resetRecentRefs: useCallback(() => setRecentRefs([]), []),
    openTaskPreview,
    openTaskDetail,
    navigateToEntity,
    navigateToDecision,
    navigateToTask,
    focusEntityInGraph,
    focusEntityInWorkspace,
    openDecisionInPool,
    selectRuntimeEntity,
  };
}
