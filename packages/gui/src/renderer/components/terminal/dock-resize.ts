import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

/**
 * 终端 dock 拖拽 resize(移植老 main 线 dock-resize.ts,bottom 停靠特化)。
 *
 * 手柄在 dock 上缘:向上拖 = 变大。地板值保证 dock 永远不会缩成读不了的
 * 一条缝;天花板给主视图留出空间。键盘步进让无指针用户同样可操作。
 */

export const DOCK_DEFAULT_HEIGHT = 352;
export const DOCK_MIN_HEIGHT = 120;
/** 主视图保留高度:dock 再拖也吞不掉主内容区。 */
export const DOCK_RESERVE_HEIGHT = 160;
export const DOCK_KEYBOARD_STEP = 16;

export function clampDockHeight(height: number, viewportHeight: number): number {
  const ceiling = Math.max(DOCK_MIN_HEIGHT, viewportHeight - DOCK_RESERVE_HEIGHT);
  return Math.round(Math.min(Math.max(height, DOCK_MIN_HEIGHT), ceiling));
}

interface DragOrigin {
  readonly pointerId: number;
  readonly startY: number;
  readonly startHeight: number;
}

export interface DockResize {
  readonly height: number;
  readonly resizing: boolean;
  readonly onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onHandlePointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onHandlePointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onHandleKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

export function useDockResize(): DockResize {
  const [height, setHeight] = useState(DOCK_DEFAULT_HEIGHT);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<DragOrigin | null>(null);

  // 窗口缩小后 dock 不得超过新天花板。
  useEffect(() => {
    const reclamp = () => setHeight((current) => clampDockHeight(current, window.innerHeight));
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, []);

  const onHandlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: height,
    };
    setResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [height]);

  const onHandlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setHeight(clampDockHeight(drag.startHeight + (drag.startY - event.clientY), window.innerHeight));
  }, []);

  const onHandlePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onHandleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const grow = event.key === "ArrowUp";
    const shrink = event.key === "ArrowDown";
    if (!grow && !shrink) return;
    event.preventDefault();
    const delta = grow ? DOCK_KEYBOARD_STEP : -DOCK_KEYBOARD_STEP;
    setHeight((current) => clampDockHeight(current + delta, window.innerHeight));
  }, []);

  return { height, resizing, onHandlePointerDown, onHandlePointerMove, onHandlePointerUp, onHandleKeyDown };
}
