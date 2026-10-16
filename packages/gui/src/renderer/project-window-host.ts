import { useEffect } from "react";
import { guiHostBridge } from "./gui-transport.ts";
import { projectWindowTitle } from "./window-title.ts";

/**
 * 项目窗口的渲染层接线(task_ca1ee6b9e8f83c89cb376e5f07),从 App.tsx 按职责拆出:
 *
 * - useProjectWindowHost:窗口的当前项目上报主进程(注册表据此「同项目已开则聚焦」,
 *   窗口内换项目也随之更新),并暴露「在新窗口打开」入口;浏览器壳无此能力,返回 null。
 * - useProjectWindowTitle:窗口标题跟随当前项目「项目名 — Harness Anything」,
 *   未选项目保持应用名;Electron 把 document.title 同步为原生窗口标题。
 */

export function useProjectWindowHost(activeRepoId: string | null): ((repoId: string) => void) | null {
  const hostWindows = guiHostBridge()?.windows;
  useEffect(() => {
    void hostWindows?.setActiveProject({ repoId: activeRepoId });
  }, [activeRepoId, hostWindows]);
  return hostWindows === undefined ? null : (repoId) => void hostWindows.openProject({ repoId });
}

export function useProjectWindowTitle(projectName: string | null): void {
  useEffect(() => {
    document.title = projectWindowTitle(projectName);
  }, [projectName]);
}
