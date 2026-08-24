import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

export const DOCK_DEFAULT_HEIGHT = 352,
  DOCK_MIN_HEIGHT = 120,
  DOCK_RESERVE_HEIGHT = 160,
  DOCK_DEFAULT_WIDTH = 560,
  DOCK_MIN_WIDTH = 384,
  DOCK_RESERVE_WIDTH = 320,
  DOCK_KEYBOARD_STEP = 16;

export function clampDockHeight(height: number, viewportHeight: number): number {
  return clamp(height, DOCK_MIN_HEIGHT, Math.max(DOCK_MIN_HEIGHT, viewportHeight - DOCK_RESERVE_HEIGHT));
}
export function clampDockWidth(width: number, viewportWidth: number): number {
  return clamp(width, DOCK_MIN_WIDTH, Math.max(DOCK_MIN_WIDTH, viewportWidth - DOCK_RESERVE_WIDTH));
}

interface DragOrigin {
  readonly pointerId: number;
  readonly coordinate: number;
  readonly size: number;
  readonly position: "bottom" | "right";
}
interface DockSizes {
  readonly height: number;
  readonly width: number;
}
export interface DockResize {
  readonly height: number;
  readonly width: number;
  readonly resizing: boolean;
  readonly onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onHandlePointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onHandlePointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onHandleKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

export function useDockResize(input: {
  readonly position: "bottom" | "right";
  readonly initialHeight?: number;
  readonly initialWidth?: number;
  readonly onSizesChange?: (sizes: DockSizes) => void;
}): DockResize {
  const [sizes, setSizes] = useState<DockSizes>(() => ({
      height: clampDockHeight(input.initialHeight ?? DOCK_DEFAULT_HEIGHT, window.innerHeight),
      width: clampDockWidth(input.initialWidth ?? DOCK_DEFAULT_WIDTH, window.innerWidth),
    })),
    [resizing, setResizing] = useState(false),
    dragRef = useRef<DragOrigin | null>(null),
    onSizesChangeRef = useRef(input.onSizesChange);
  onSizesChangeRef.current = input.onSizesChange;
  useEffect(() => {
    onSizesChangeRef.current?.(sizes);
  }, [sizes]);
  useEffect(() => {
    const reclamp = () =>
      setSizes((current) => ({
        height: clampDockHeight(current.height, window.innerHeight),
        width: clampDockWidth(current.width, window.innerWidth),
      }));
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, []);
  useEffect(() => {
    dragRef.current = null;
    setResizing(false);
  }, [input.position]);

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      dragRef.current = {
        pointerId: event.pointerId,
        coordinate: input.position === "bottom" ? event.clientY : event.clientX,
        size: input.position === "bottom" ? sizes.height : sizes.width,
        position: input.position,
      };
      setResizing(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [input.position, sizes],
  );
  const onHandlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const coordinate = drag.position === "bottom" ? event.clientY : event.clientX,
      next = drag.size + drag.coordinate - coordinate;
    setSizes((current) =>
      drag.position === "bottom"
        ? { ...current, height: clampDockHeight(next, window.innerHeight) }
        : { ...current, width: clampDockWidth(next, window.innerWidth) },
    );
  }, []);
  const onHandlePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);
  const onHandleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const grow = input.position === "bottom" ? event.key === "ArrowUp" : event.key === "ArrowLeft",
        shrink = input.position === "bottom" ? event.key === "ArrowDown" : event.key === "ArrowRight";
      if (!grow && !shrink) return;
      event.preventDefault();
      const delta = grow ? DOCK_KEYBOARD_STEP : -DOCK_KEYBOARD_STEP;
      setSizes((current) =>
        input.position === "bottom"
          ? { ...current, height: clampDockHeight(current.height + delta, window.innerHeight) }
          : { ...current, width: clampDockWidth(current.width + delta, window.innerWidth) },
      );
    },
    [input.position],
  );
  return {
    height: sizes.height,
    width: sizes.width,
    resizing,
    onHandlePointerDown,
    onHandlePointerMove,
    onHandlePointerUp,
    onHandleKeyDown,
  };
}

function clamp(value: number, floor: number, ceiling: number): number {
  return Math.round(Math.min(Math.max(value, floor), ceiling));
}
