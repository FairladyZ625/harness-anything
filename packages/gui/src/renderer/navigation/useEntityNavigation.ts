import { useCallback, useState } from "react";
import { pushRecentRef } from "./recentRefs.ts";
import { entityDetailTargetOf, workTargetOf } from "./entityRoutes.ts";
import { decisionDetailLocation, decisionSessionsLocation } from "./decisionReviewRoutes.ts";
import type { AppLocation } from "./viewHistory.ts";

/**
 * 实体导航(W4 从 AppShell 抽出):所有「跳去某个实体」的出口集中在此。
 *
 * 路由表(可寻址,判定全部在 entityDetailTargetOf):
 *   task/<工作根>         → 工作页(workspace,根任务详情是其中一个分区)
 *   task/<id>            → selectedId(TaskDetailView 既有路由)
 *   decision/<id>        → decisionDetail 详情页(不落决策池)
 *   fact/<anchor> → factDetail 详情页(W5 起事实分诊列表页已撤销)
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
  declaredKinds = [],
  isWorkRoot,
}: {
  navigate: (fields: Partial<AppLocation>) => void;
  updateLocation: (fields: Partial<AppLocation>) => void;
  activeRepoId: string | null;
  enabledRepoIds: ReadonlyArray<string>;
  /** 跨仓导航:切到目标仓后执行续导航(在本仓内打开 ref)。 */
  openInRepo: (repoId: string, continueInRepo: () => void) => void;
  /** 目标仓未启用:回 home 并打开项目切换器。 */
  onRepoUnavailable: () => void;
  /** 已注册 kind 清单(读面派生):声明实体的 ref 靠它路由,本模块不持有副本。 */
  declaredKinds?: readonly string[];
  /** 工作根判定(读面同切面的任务行派生):task 引用靠它分流到工作页或任务详情。 */
  isWorkRoot: (taskId: string) => boolean;
}) {
  const [recentRefs, setRecentRefs] = useState<string[]>([]);

  const remember = useCallback((ref: string) => {
    setRecentRefs((prev) => pushRecentRef(prev, ref));
  }, []);

  // 本仓内导航:一切实体引用(含 task)经 entityDetailTargetOf 判定落点;不认识的引用忽略。
  // Decision 评审/会话别名与任务评审别名在最近访问里记成它们指向的那条 decision / task(别名不是图上的实体)。
  const navigateLocalEntity = useCallback(
    (ref: string) => {
      const reviewedDecision = (decisionDetailLocation(ref) ?? decisionSessionsLocation(ref))?.decisionId;
      remember(
        reviewedDecision
          ? `decision/${reviewedDecision}`
          : ref.startsWith("taskreview/")
            ? `task/${ref.slice("taskreview/".length)}`
            : ref,
      );
      const target = entityDetailTargetOf(ref, declaredKinds, isWorkRoot);
      if (target) navigate({ selectedId: null, previewId: null, ...target });
    },
    [declaredKinds, isWorkRoot, navigate, remember],
  );

  const openTaskDetail = useCallback((id: string) => navigateLocalEntity(`task/${id}`), [navigateLocalEntity]);

  // 预览抽屉是任务详情的轻量版;工作根没有单独的任务详情,直接进工作页。
  const openTaskPreview = useCallback(
    (id: string) => {
      if (isWorkRoot(id)) openTaskDetail(id);
      else updateLocation({ selectedId: null, previewId: id });
    },
    [isWorkRoot, openTaskDetail, updateLocation],
  );

  // 显式开某个已知工作的工作页:任务详情的「属于工作」。
  const openWork = useCallback(
    (taskId: string) => navigate({ ...workTargetOf(taskId), selectedId: null, previewId: null }),
    [navigate],
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
      const target = entityDetailTargetOf(ref, declaredKinds, isWorkRoot);
      if (target) navigate({ selectedId: null, previewId: null, ...target });
    },
    [declaredKinds, isWorkRoot, navigate],
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
    openWork,
    navigateToEntity,
    navigateToDecision,
    focusEntityInGraph,
    focusEntityInWorkspace,
    openDecisionInPool,
    selectRuntimeEntity,
  };
}
