import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

/** Where the terminal dock attaches within the main content area. */
export type DockPosition = "bottom" | "right";

/** Defaults match the sizes the dock shipped with before it became resizable. */
export const DOCK_DEFAULT_HEIGHT = 320;
export const DOCK_DEFAULT_WIDTH = 384;

/** Floors keep the dock usable; it must never collapse into an unreadable sliver. */
export const DOCK_MIN_HEIGHT = 120;
export const DOCK_MIN_WIDTH = 240;

/**
 * Ceilings reserve room for the rest of the shell so a drag can never swallow
 * the primary view (or push it under the sidebar).
 */
export const DOCK_RESERVE_HEIGHT = 160;
export const DOCK_RESERVE_WIDTH = 360;

/** Keyboard resize step, so the handle is operable without a pointer. */
export const DOCK_KEYBOARD_STEP = 16;

export function clampDockHeight(height: number, viewportHeight: number): number {
  const ceiling = Math.max(DOCK_MIN_HEIGHT, viewportHeight - DOCK_RESERVE_HEIGHT);
  return Math.round(Math.min(Math.max(height, DOCK_MIN_HEIGHT), ceiling));
}

export function clampDockWidth(width: number, viewportWidth: number): number {
  const ceiling = Math.max(DOCK_MIN_WIDTH, viewportWidth - DOCK_RESERVE_WIDTH);
  return Math.round(Math.min(Math.max(width, DOCK_MIN_WIDTH), ceiling));
}

interface DragOrigin {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startHeight: number;
  readonly startWidth: number;
}

export interface DockResize {
  /** Current dock height in px (used when docked at the bottom). */
  readonly height: number;
  /** Current dock width in px (used when docked at the right). */
  readonly width: number;
  /** True while a drag is in flight, so the dock can suppress transitions. */
  readonly resizing: boolean;
  readonly onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onHandlePointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onHandlePointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onHandleKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

function viewportHeight(): number {
  return typeof window === "undefined" ? DOCK_DEFAULT_HEIGHT + DOCK_RESERVE_HEIGHT : window.innerHeight;
}

function viewportWidth(): number {
  return typeof window === "undefined" ? DOCK_DEFAULT_WIDTH + DOCK_RESERVE_WIDTH : window.innerWidth;
}

/**
 * Drag-to-resize for the terminal dock. The handle sits on the dock's leading
 * edge, so dragging *toward* the viewport centre grows it: at the bottom that
 * is upward (smaller clientY), at the right that is leftward (smaller clientX).
 * Each position keeps its own size, so flipping sides restores what you set.
 */
export function useDockResize(position: DockPosition): DockResize {
  const [height, setHeight] = useState(DOCK_DEFAULT_HEIGHT);
  const [width, setWidth] = useState(DOCK_DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<DragOrigin | null>(null);

  // A shrinking window must not leave the dock larger than its ceiling.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reclamp = () => {
      setHeight((current) => clampDockHeight(current, window.innerHeight));
      setWidth((current) => clampDockWidth(current, window.innerWidth));
    };
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, []);

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startHeight: height,
        startWidth: width
      };
      setResizing(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [height, width]
  );

  const onHandlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (position === "bottom") {
        setHeight(clampDockHeight(drag.startHeight + (drag.startY - event.clientY), viewportHeight()));
      } else {
        setWidth(clampDockWidth(drag.startWidth + (drag.startX - event.clientX), viewportWidth()));
      }
    },
    [position]
  );

  const onHandlePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onHandleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const grow = event.key === (position === "bottom" ? "ArrowUp" : "ArrowLeft");
      const shrink = event.key === (position === "bottom" ? "ArrowDown" : "ArrowRight");
      if (!grow && !shrink) return;
      event.preventDefault();
      const delta = grow ? DOCK_KEYBOARD_STEP : -DOCK_KEYBOARD_STEP;
      if (position === "bottom") {
        setHeight((current) => clampDockHeight(current + delta, viewportHeight()));
      } else {
        setWidth((current) => clampDockWidth(current + delta, viewportWidth()));
      }
    },
    [position]
  );

  return { height, width, resizing, onHandlePointerDown, onHandlePointerMove, onHandlePointerUp, onHandleKeyDown };
}
