import { useEffect } from "react";

/**
 * 全局快捷键 + 鼠标侧键(AppShell 级,从 App.tsx 抽出):
 *   ⌘K/Ctrl+K  命令面板
 *   Ctrl+`      终端 dock
 *   ⌘[/⌘]      视图历史后退/前进
 *   鼠标侧键 3/4 = 后退/前进(浏览器/Electron 惯例)
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

  // 鼠标侧键:button 3 = 后退,button 4 = 前进。
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 3) onBack();
      else if (e.button === 4) onForward();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [onBack, onForward]);
}
