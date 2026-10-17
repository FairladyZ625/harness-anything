import { useEffect, type ReactNode } from "react";

/**
 * 空闲在场门控(task_5c651ff17b698ff2bce7e6affa,GUI 空闲 GPU 高占用)。
 *
 * 实测机制:任一 infinite CSS 动画(环境光浮动、活跃行/状态点呼吸、舰队流光)都会让
 * 合成器持续产帧,而全窗口的 .glass backdrop-filter 每帧重跑模糊,gpu-process 空闲也
 * 16–19%(重页 100%+);全部暂停后回落到 ~0.3%(top 实时采样差分,2026-10-17)。
 *
 * 本 hook 只负责「在场」这一维:60s 无用户输入、或窗口隐藏时挂
 * html[data-motion="idle"];任何输入立即摘除。暂停哪些动画由 styles.css 的
 * html[data-motion="idle"] 规则收敛(只暂停 infinite 循环,一次性入场动画不受影响,
 * 空闲期间到达的新内容仍能播完入场)。与 motion-config.tsx 的「偏好」维度正交:
 * 偏好决定要不要动,在场决定现在动不动。
 */
export const MOTION_IDLE_AFTER_MS = 60_000;

const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

export function useIdleMotionGate(idleAfterMs: number = MOTION_IDLE_AFTER_MS) {
  useEffect(() => {
    const root = document.documentElement;
    let lastActivity = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      root.dataset.motion = document.hidden || performance.now() - lastActivity >= idleAfterMs ? "idle" : "active";
    };
    // 重新计时而不是周期轮询:状态只在事件边沿变化,空闲期间零定时器。
    const onActivity = () => {
      lastActivity = performance.now();
      clearTimeout(timer);
      timer = setTimeout(apply, idleAfterMs);
      apply();
    };
    const onVisibilityChange = () => apply();
    root.dataset.motion = "active";
    timer = setTimeout(apply, idleAfterMs);
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, onActivity);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      delete root.dataset.motion;
    };
  }, [idleAfterMs]);
}

/** 挂在渲染树根部(main.tsx 包 <App/>):App.tsx 已在复杂度门上限,门控不进它。 */
export function IdleMotionGate({ children }: { readonly children: ReactNode }) {
  useIdleMotionGate();
  return children;
}
