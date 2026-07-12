import { useEffect, useState } from "react";
import type { ColorMode } from "@xyflow/react";

/**
 * GraphView colorMode 联动(dec_01KXA7811SVVT8P66HNDFZQ7DF — 关系图可用性)。
 *
 * ReactFlow 的 minimap SVG 背景默认吃库内置 #fff,只有显式给 ReactFlow 传
 * colorMode="dark" 才会应用 .react-flow.dark 的 CSS 变量。本模块按
 * document.documentElement.dataset.theme(theme.tsx:41 维护)输出当前 colorMode,
 * 并 MutationObserver 监听切换。
 *
 * SSR 安全:vitest 的 renderer-app-model 用例在 node 里 renderToStaticMarkup,
 * 没有 document;此时回落到 "dark"(应用默认主题),useEffect 里再补监听。
 */
export function useColorMode(): ColorMode {
  const [mode, setMode] = useState<ColorMode>(() => readColorMode());
  useEffect(() => {
    // mount 后再读一次,避免 SSR 默认与真实 data-theme 不一致。
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

function readColorMode(): ColorMode {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
