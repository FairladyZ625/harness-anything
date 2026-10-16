import { useEffect } from "react";
import { guiHostBridge } from "./gui-transport.ts";
import { projectWindowTitle } from "./window-title.ts";

/**
 * 项目窗口的渲染层接线(task_ca1ee6b9e8f83c89cb376e5f07),从 App.tsx 按职责拆出:
 *
 * - hostProjectWindowApi:宿主桥的窗口面能力探测(浏览器壳无此面;与 AppSidebar 对
 *   auth 面的 typeof 探测同款),测试里未建模该面的假桥也按无能力处理。
 * - useProjectWindowHost:窗口的当前项目上报主进程(注册表据此「同项目已开则聚焦」,
 *   窗口内换项目也随之更新),并暴露「在新窗口打开」入口;无能力时返回 null。
 * - useProjectWindowTitle:窗口标题跟随当前项目「项目名 — Harness Anything」,
 *   未选项目保持应用名;Electron 把 document.title 同步为原生窗口标题。
 */
import type { ProjectWindowApi } from "../api/project-window-contract.ts";

export function hostProjectWindowApi(): ProjectWindowApi | null {
  const candidate = guiHostBridge()?.windows;
  return candidate !== undefined &&
    typeof candidate.openProject === "function" &&
    typeof candidate.setActiveProject === "function"
    ? candidate
    : null;
}

export function useProjectWindowHost(activeRepoId: string | null): ((repoId: string) => void) | null {
  const hostWindows = hostProjectWindowApi();
  useEffect(() => {
    void hostWindows?.setActiveProject({ repoId: activeRepoId });
  }, [activeRepoId, hostWindows]);
  return hostWindows === null ? null : (repoId) => void hostWindows.openProject({ repoId });
}

export function useProjectWindowTitle(projectName: string | null): void {
  useEffect(() => {
    document.title = projectWindowTitle(projectName);
  }, [projectName]);
}
