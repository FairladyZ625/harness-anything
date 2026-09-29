import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";

/**
 * motion 是 GUI 唯一动画库;reducedMotion="user" 让 JS 动画遵守系统
 * 「减少动态效果」,与 styles.css 的 prefers-reduced-motion 全局规则同向。
 */
export function AppMotionConfig({ children }: { readonly children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
