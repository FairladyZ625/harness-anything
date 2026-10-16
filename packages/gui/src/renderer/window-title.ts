/**
 * 窗口标题(task_ca1ee6b9e8f83c89cb376e5f07):停在项目上的窗口显示「项目名 —
 * Harness Anything」,让 Dock / 任务栏 / ⌘` 切窗口时可辨认;未选项目时保持应用名。
 * Electron 会把 document.title 同步为原生窗口标题(index.html 的 <title> 是初值)。
 */
export const APP_WINDOW_TITLE = "Harness Anything";

export function projectWindowTitle(projectName: string | null): string {
  return projectName === null ? APP_WINDOW_TITLE : `${projectName} — ${APP_WINDOW_TITLE}`;
}
