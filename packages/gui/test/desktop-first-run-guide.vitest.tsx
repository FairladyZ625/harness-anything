// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DesktopFirstRunGuide } from "../src/renderer/components/FirstRunGuide.tsx";

/**
 * 首启引导屏(评审 2026-10-17 P1):后台安装某一步失败时,引导屏以「哪一步/为什么/怎么办」
 * 显示错误;主进程完成安装后的推送会让引导屏重新拉取状态。
 */

const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.removeItem("harness.desktop-first-run.done");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  window.localStorage.removeItem("harness.desktop-first-run.done");
  Reflect.deleteProperty(window, "harness");
});

describe("desktop first-run guide", () => {
  it("shows setup failures as step, reason, and what to do", async () => {
    installBridge({
      desktopStatus: async () => ({
        node: { available: true, version: "v24.0.0", path: "/bundle/node" },
        path: { includesShim: false, shellRc: "/home/u/.zshrc" },
        daemon: { reachable: false, serviceInstalled: true },
        shim: { installed: true, preservedExistingHa: false, path: "/home/u/bin/ha" },
        setupFailures: [
          {
            step: "background-service",
            reason: "launchctl bootstrap exited 5: Operation not permitted",
            hint: "在终端运行 ha daemon service install 查看完整原因后重试",
          },
        ],
      }),
    });
    const guide = await mount(createElement(DesktopFirstRunGuide));
    const alert = guide.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert?.textContent).toContain("后台服务设置失败");
    expect(alert?.textContent).toContain("launchctl bootstrap exited 5");
    expect(alert?.textContent).toContain("ha daemon service install");
  });

  it("refetches the report when the main process finishes its background setup", async () => {
    const status = vi.fn();
    const node = { available: true, version: "v24.0.0", path: "/bundle/node" };
    status.mockResolvedValueOnce({ node, shim: { installed: false, preservedExistingHa: false, path: "/ha" } });
    status.mockResolvedValueOnce({ node, shim: { installed: true, preservedExistingHa: false, path: "/ha" } });
    let push: (() => void) | undefined;
    installBridge({
      desktopStatus: () => status(),
      onDesktopFirstRunUpdated: (listener: () => void) => {
        push = listener;
        return () => {};
      },
    });
    const guide = await mount(createElement(DesktopFirstRunGuide));
    expect(status).toHaveBeenCalledOnce();
    await act(async () => {
      push?.();
    });
    expect(status).toHaveBeenCalledTimes(2);
    expect(guide.textContent).toContain("App CLI shim");
  });

  it("renders nothing when the embedded runtime is missing (ha gui source launch)", async () => {
    // ha gui 的 npm/源码通道没有内嵌 Node;首启引导是打包 App 的安装面,这一通道整屏不弹。
    installBridge({
      desktopStatus: async () => ({
        node: { available: false, version: null, path: "/electron/Resources/node/darwin-arm64/node" },
        path: { includesShim: false, shellRc: "/home/u/.zshrc" },
        daemon: { reachable: true, serviceInstalled: false },
        shim: { installed: false, preservedExistingHa: false, path: "/home/u/bin/ha" },
      }),
    });
    const guide = await mount(createElement(DesktopFirstRunGuide));
    expect(guide.textContent).toBe("");
  });

  it("claims the desktop is ready only when every check passes", async () => {
    installBridge({
      desktopStatus: async () => ({
        node: { available: true, version: "v24.0.0", path: "/bundle/node" },
        path: { includesShim: true, shellRc: "/home/u/.zshrc" },
        daemon: { reachable: true, serviceInstalled: true },
        shim: { installed: true, preservedExistingHa: false, path: "/home/u/bin/ha" },
      }),
    });
    const guide = await mount(createElement(DesktopFirstRunGuide));
    expect(guide.querySelector("h1")?.textContent).toBe("电脑已准备好使用 Harness Anything");
  });

  it("does not claim readiness when a check failed, and a reachable daemon is not a failure", async () => {
    installBridge({
      desktopStatus: async () => ({
        node: { available: true, version: "v24.0.0", path: "/bundle/node" },
        path: { includesShim: false, shellRc: "/home/u/.zshrc" },
        daemon: { reachable: true, serviceInstalled: false },
        shim: { installed: false, preservedExistingHa: false, path: "/home/u/bin/ha" },
      }),
    });
    const guide = await mount(createElement(DesktopFirstRunGuide));
    expect(guide.querySelector("h1")?.textContent).not.toContain("已准备好");
    expect(guide.textContent).toContain("✓ 后台服务");
    expect(guide.textContent).toContain("daemon 正在运行");
  });

  it("explains an existing command-line ha as preserved instead of warning about it", async () => {
    installBridge({
      desktopStatus: async () => ({
        node: { available: true, version: "v24.0.0", path: "/bundle/node" },
        path: { includesShim: true, shellRc: "/home/u/.zshrc" },
        daemon: { reachable: true, serviceInstalled: true },
        shim: { installed: true, preservedExistingHa: true, path: "/home/u/bin/ha" },
        npmHa: "/Users/u/.local/bin/ha",
      }),
    });
    const guide = await mount(createElement(DesktopFirstRunGuide));
    expect(guide.textContent).toContain("/Users/u/.local/bin/ha");
    expect(guide.textContent).toContain("无需处理");
    expect(guide.textContent).not.toContain("检测到另一份 ha");
  });
});

interface BridgeOverride {
  readonly desktopStatus: () => Promise<unknown>;
  readonly onDesktopFirstRunUpdated?: (listener: () => void) => () => void;
}

function installBridge(override: BridgeOverride): void {
  Object.defineProperty(window, "harness", {
    configurable: true,
    value: { firstRun: override },
  });
}

async function mount(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(element));
  return container;
}
