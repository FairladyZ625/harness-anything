import type { MenuItemConstructorOptions } from "electron";

/**
 * macOS 应用菜单(task_ca1ee6b9e8f83c89cb376e5f07):其余四项保持系统 role(随系统
 * 语言本地化),文件菜单是本应用自己的,承载「新建窗口 ⌘⇧N」——总是新建、默认停在
 * 当前项目的新窗口(CEO 2026-10-17 裁定,不去重)。独立成纯函数使菜单结构可单测
 * (菜单点击本身无法 headless 验证)。
 */
export function darwinAppMenuTemplate(onNewWindow: () => void): MenuItemConstructorOptions[] {
  return [
    { role: "appMenu" },
    {
      label: "文件",
      submenu: [{ label: "新建窗口", accelerator: "CmdOrCtrl+Shift+N", click: () => onNewWindow() }],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
