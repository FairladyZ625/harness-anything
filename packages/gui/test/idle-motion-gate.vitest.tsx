// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MOTION_IDLE_AFTER_MS, useIdleMotionGate } from "../src/renderer/idle-motion-gate.ts";

// 空闲在场门控(task_5c651ff17b698ff2bce7e6affa):60s 无输入或窗口隐藏 →
// html[data-motion="idle"](styles.css 据此暂停全部 infinite 动画);任何输入同帧恢复。
// 这里验证属性这一侧的状态机;CSS paused 规则的收益由该任务的实机采样证据覆盖。

function GateProbe() {
  useIdleMotionGate();
  return null;
}

let root: Root | undefined;

function mountGate() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(<GateProbe />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  if (root) {
    act(() => {
      root.unmount();
    });
  }
  root = undefined;
  document.documentElement.removeAttribute("data-motion");
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  vi.useRealTimers();
});

it("挂载即 active;到 idleAfterMs 无输入翻 idle;输入同帧恢复 active 并重新计时", () => {
  mountGate();
  expect(document.documentElement.dataset.motion).toBe("active");

  act(() => {
    vi.advanceTimersByTime(MOTION_IDLE_AFTER_MS - 1);
  });
  expect(document.documentElement.dataset.motion).toBe("active");

  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(document.documentElement.dataset.motion).toBe("idle");

  act(() => {
    window.dispatchEvent(new Event("pointermove"));
  });
  expect(document.documentElement.dataset.motion).toBe("active");

  act(() => {
    vi.advanceTimersByTime(MOTION_IDLE_AFTER_MS);
  });
  expect(document.documentElement.dataset.motion).toBe("idle");
});

it("keydown/wheel/touchstart/pointerdown 都算输入", () => {
  mountGate();
  for (const event of ["keydown", "wheel", "touchstart", "pointerdown"]) {
    act(() => {
      vi.advanceTimersByTime(MOTION_IDLE_AFTER_MS);
    });
    expect(document.documentElement.dataset.motion).toBe("idle");
    act(() => {
      window.dispatchEvent(new Event(event));
    });
    expect(document.documentElement.dataset.motion).toBe("active");
  }
});

it("窗口隐藏立即 idle;回到可见且仍无输入时保持 idle,输入后才恢复", () => {
  mountGate();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(document.documentElement.dataset.motion).toBe("idle");

  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  // 隐藏期间把无输入时长推过阈值:回到可见时 apply 仍判 idle。
  act(() => {
    vi.advanceTimersByTime(MOTION_IDLE_AFTER_MS);
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // 回到可见本身不是用户输入:距上次输入已超过阈值,保持 idle。
  expect(document.documentElement.dataset.motion).toBe("idle");

  act(() => {
    window.dispatchEvent(new Event("keydown"));
  });
  expect(document.documentElement.dataset.motion).toBe("active");
});

it("卸载清理:摘除属性,此后不再翻 idle", () => {
  mountGate();
  act(() => {
    root?.unmount();
  });
  root = undefined;
  expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
  act(() => {
    vi.advanceTimersByTime(MOTION_IDLE_AFTER_MS * 2);
  });
  expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
});
