// harness-test-tier: integration
// @vitest-environment happy-dom
// 动效偏好的可订阅状态(照 ThemeProvider 的做法):设置页三选一切换后不重载立即生效,
// 选择写回 localStorage 并在重新挂载后保持。覆盖:
// ①选「始终开启」后 useEntryMotion().reduced 为 false——即使系统减弱动态效果为开;
// ②选「关闭」后 enabled 为 false;③偏好写入 localStorage,重新挂载读回同一选择;
// ④设置页外观组的分段控件就是这条切换路径(点「始终开启」→ storage 已写、同树探针立即翻转)。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppMotionConfig,
  MOTION_PREFERENCE_STORAGE_KEY,
  useEntryMotion,
  useMotionPreference,
} from "../src/renderer/motion-config.tsx";
import { SettingsView } from "../src/renderer/views/SettingsView.tsx";
import { connectionQueryKeys } from "../src/renderer/connection-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

// 系统减弱动态效果的形态用可控探针表达(与 entry-boundary.vitest.tsx 同一手法)。
const mediaProbe = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  useReducedMotion: () => mediaProbe.reduced,
}));

let root: Root | null = null;
let host: HTMLDivElement;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

beforeEach(() => {
  mediaProbe.reduced = false;
  localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host.remove();
  localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
  Reflect.deleteProperty(window, "harness");
});

/** 挂一棵带偏好切换按钮与 useEntryMotion 探针的树;按钮点击即设置页的「选择」动作。 */
function mountPreferenceTree() {
  const probe = { enabled: null as boolean | null, reduced: null as boolean | null };
  const MotionProbe = () => {
    const state = useEntryMotion();
    probe.enabled = state.enabled;
    probe.reduced = state.reduced;
    return null;
  };
  const Switcher = () => {
    const { setPreference } = useMotionPreference();
    return (
      <>
        <button onClick={() => setPreference("on")}>始终开启</button>
        <button onClick={() => setPreference("off")}>关闭</button>
      </>
    );
  };
  root = createRoot(host);
  act(() => {
    root!.render(
      <AppMotionConfig>
        <Switcher />
        <MotionProbe />
      </AppMotionConfig>,
    );
  });
  return probe;
}

describe("动效偏好:可订阅状态与立即生效", () => {
  it("选「始终开启」后 reduced 为 false,即使系统减弱动态效果为开", () => {
    mediaProbe.reduced = true;
    const probe = mountPreferenceTree();
    expect(probe.enabled).toBe(true);
    expect(probe.reduced).toBe(true);
    act(() => (host.querySelectorAll("button")[0] as HTMLButtonElement).click());
    expect(probe.enabled).toBe(true);
    expect(probe.reduced).toBe(false);
  });

  it("选「关闭」后 enabled 为 false", () => {
    const probe = mountPreferenceTree();
    act(() => (host.querySelectorAll("button")[1] as HTMLButtonElement).click());
    expect(probe.enabled).toBe(false);
  });

  it("选择写入 localStorage 并在重新挂载后保持", () => {
    mountPreferenceTree();
    act(() => (host.querySelectorAll("button")[0] as HTMLButtonElement).click());
    expect(localStorage.getItem(MOTION_PREFERENCE_STORAGE_KEY)).toBe("on");
    act(() => root!.unmount());
    root = null;
    const probe = mountPreferenceTree();
    expect(probe.enabled).toBe(true);
    expect(probe.reduced).toBe(false);
  });

  it("设置页外观组的分段控件切换即写 localStorage 并让入场动效立即恢复位移", async () => {
    mediaProbe.reduced = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(connectionQueryKeys.status(), []);
    // 仓库页初始 tab 渲染 AddLocalRepositoryPanel,其文件夹选择走 preload 桥;测试只点外观页,桥给最小实现。
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: { firstRun: { chooseRepository: async () => null, bootstrap: async () => ({}) } },
    });
    const probe = { enabled: null as boolean | null, reduced: null as boolean | null };
    const MotionProbe = () => {
      const state = useEntryMotion();
      probe.enabled = state.enabled;
      probe.reduced = state.reduced;
      return null;
    };
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <AppMotionConfig>
          <QueryClientProvider client={client}>
            <SettingsView repoId={null} repos={[]} onOpenProject={() => {}} />
          </QueryClientProvider>
          <MotionProbe />
        </AppMotionConfig>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      const appearanceTab = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("外观"));
      (appearanceTab as HTMLButtonElement).click();
      await Promise.resolve();
    });
    // 跟随系统 + 系统减弱动态开:只淡入、不位移。
    expect(probe.reduced).toBe(true);
    await act(async () => {
      ([...host.querySelectorAll("button")].find((b) => b.textContent === "始终开启") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    // 不重载、不换树:同一挂载内立即变为带位移的入场。
    expect(probe.enabled).toBe(true);
    expect(probe.reduced).toBe(false);
    expect(localStorage.getItem(MOTION_PREFERENCE_STORAGE_KEY)).toBe("on");
  });
});
