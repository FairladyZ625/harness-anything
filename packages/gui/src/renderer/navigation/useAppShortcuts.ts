import { useEffect } from "react";
import { guiHostBridge } from "../gui-transport.ts";

/**
 * 全局快捷键 + 鼠标侧键(AppShell 级,从 App.tsx 抽出):
 *   ⌘K/Ctrl+K  命令面板
 *   Ctrl+`      终端页进出(进入/离开,语义在 App 的 onToggleTerminal)
 *   ⌘[/⌘]      视图历史后退/前进
 *   鼠标侧键 3/4 = 后退/前进(浏览器/Electron 惯例)
 *   Windows/Linux 侧键不到 DOM:主进程把 app-command browser-backward/forward
 *   转发到 preload 订阅,与 3/4 同落 back()/forward()(两路按平台互补,无双触发)。
 */
export function useAppShortcuts({
  onTogglePalette,
  onToggleTerminal,
  onBack,
  onForward,
}: {
  onTogglePalette: () => void;
  onToggleTerminal: () => void;
  onBack: () => void;
  onForward: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onTogglePalette();
      } else if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        onToggleTerminal();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "[") {
        e.preventDefault();
        onBack();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "]") {
        e.preventDefault();
        onForward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, onForward, onTogglePalette, onToggleTerminal]);

  // 鼠标侧键:button 3 = 后退,button 4 = 前进(macOS/Linux 的投递路径)。
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 3) onBack();
      else if (e.button === 4) onForward();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [onBack, onForward]);

  // Windows/Linux 的投递路径:主进程 app-command → preload 订阅(浏览器模式无桥,
  // 或桥不提供该能力时不订阅;按函数存在性判能力,不按属性存在性)。
  useEffect(() => {
    const onNavigationCommand = guiHostBridge()?.appCommand?.onNavigationCommand;
    if (typeof onNavigationCommand !== "function") return;
    return onNavigationCommand((command) => {
      if (command === "back") onBack();
      else if (command === "forward") onForward();
    });
  }, [onBack, onForward]);
}
