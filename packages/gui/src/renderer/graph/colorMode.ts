import { useEffect, useState } from "react";
import type { ColorMode } from "@xyflow/react";

/**
 * GraphView colorMode 联动(dec_01KXA7811SVVT8P66HNDFZQ7DF — 关系图可用性,历史坑)。
 *
 * ReactFlow 的 minimap SVG 背景默认吃库内置 #fff,只有显式给 ReactFlow 传
 * colorMode="dark" 才会应用 .react-flow.dark 的 CSS 变量。本模块按
 * document.documentElement.dataset.theme(theme.tsx 维护)输出当前 colorMode,
 * 并 MutationObserver 监听切换。MiniMap 的 maskColor 也必须按 light/dark 选,
 * 否则 light 主题下暗 mask 把 minimap 糊黑(历史坑,设计判断 4)。
 *
 * SSR 安全:renderToStaticMarkup 没有 document;回落 "dark"(默认主题)。
 */
export function useColorMode(): ColorMode {
  const [mode, setMode] = useState<ColorMode>(() => readColorMode());
  useEffect(() => {
    setMode(readColorMode());
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => {
      setMode(readColorMode());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return mode;
}

export function readColorMode(): ColorMode {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * MiniMap mask 色:dark 用半透黑、light 用半透白。
 * 提取为纯函数便于组件测试(light/dark 各覆盖一例,验收门 4)。
 */
export function minimapMaskColor(mode: ColorMode): string {
  return mode === "dark" ? "rgba(0, 0, 0, 0.5)" : "rgba(255, 255, 255, 0.6)";
}
