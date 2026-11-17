// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { INITIAL_SETTINGS_V1 } from "@harness-anything/kernel";
import { TerminalRoute } from "../src/renderer/views/TerminalRoute.tsx";
import { BrowserView } from "../src/renderer/views/BrowserView.tsx";
import { openExternalUrl } from "../src/renderer/browser/open-external-url.ts";
import { settingsQueryKeys } from "../src/renderer/settings-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { resetGuiTransportForTest } from "../src/renderer/gui-transport.ts";

vi.mock("../src/renderer/views/TerminalView.tsx", async () => {
  const { TerminalChrome } = await import("../src/renderer/components/terminal/TerminalChrome.tsx");
  return {
    TerminalView: (props: Record<string, unknown>) => (
      <>
        <TerminalChrome
          {...(props as Parameters<typeof TerminalChrome>[0])}
          generation={1}
          preferences={{ backend: "direct-pty" }}
          onPreferenceChange={() => undefined}
          chips={[]}
          activeGroupId={null}
          onSelectGroup={() => undefined}
          onCloseGroup={() => undefined}
          onNewTab={() => undefined}
          sessions={[]}
          openSessionIds={[]}
          onAttachSession={() => undefined}
          spawn={{ name: "", cwdScope: "repo-root", path: "", shellProfileId: "default", taskId: "" }}
          onSpawnChange={() => undefined}
          onCreate={() => undefined}
          tasks={[]}
        />
        <button
          data-testid="terminal-url"
          onClick={() => (props.openUrl as (url: string) => void)("https://example.test/login")}
        >
          URL
        </button>
      </>
    ),
  };
});
let root: Root;
let container: HTMLDivElement;
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  Reflect.deleteProperty(window, "harness");
  resetGuiTransportForTest();
  vi.restoreAllMocks();
  focusManager.setFocused(undefined);
  localStorage.clear();
});
const repoId = "terminal-browser-test";
function read(target: "embedded" | "system") {
  return {
    schema: "daemon.settings-read/v1",
    ok: true,
    settings: { ...INITIAL_SETTINGS_V1, gui: { ...INITIAL_SETTINGS_V1.gui, terminalBrowser: target } },
    values: { guiTerminalBrowser: target },
    revision: 1,
    lastChanged: "initial",
    decisionPoints: [],
  };
}
async function click(testId: string) {
  await act(async () => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());
}
async function mount(target: "embedded" | "system" = "embedded") {
  setActiveLocale("en-US");
  let current = target;
  const external = vi.fn(async () => undefined);
  const request = vi.fn(async (method: string, payload: { guiTerminalBrowser?: "embedded" | "system" }) => {
    if (method === "getSettings") return read(current);
    if (method === "updateSettings") {
      current = payload.guiTerminalBrowser!;
      return {
        schema: "command-receipt/v2",
        command: "settings-update",
        opId: "browser-test",
        ok: true,
        outcome: "applied",
        revision: 1,
      };
    }
    throw new Error(`Unexpected ${method}`);
  });
  Object.defineProperty(window, "harness", { configurable: true, value: { request, externalUrl: { open: external } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(settingsQueryKeys.read(repoId), read(target));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const navigate = vi.fn();
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TerminalRoute, {
          repoId,
          repoRoot: "/repo",
          daemonGeneration: 1,
          tasks: [],
          launchTask: null,
          navigate,
          onNavigateEntity: () => undefined,
          onOpenDocument: () => undefined,
        }),
      ),
    ),
  );
  return {
    client,
    navigate,
    external,
    request,
    cliUpdate: (next: typeof target) => {
      current = next;
    },
  };
}
describe("terminal browser preference", () => {
  it("embedded navigates internally without a host call", async () => {
    const f = await mount();
    await click("terminal-url");
    expect(f.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ view: "browser", browserUrl: "https://example.test/login" }),
    );
    expect(f.external).not.toHaveBeenCalled();
  });
  it("system opens externally without changing view", async () => {
    const f = await mount("system");
    await click("terminal-url");
    expect(f.external).toHaveBeenCalledWith("https://example.test/login");
    expect(f.navigate).not.toHaveBeenCalled();
  });
  it("toolbar and launch options persist through the shared settings action", async () => {
    const f = await mount();
    await click("terminal-browser-toggle");
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledWith(
        "updateSettings",
        expect.objectContaining({ guiTerminalBrowser: "system" }),
      ),
    );
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector('[data-testid="terminal-browser-toggle"]')?.getAttribute("aria-pressed")).toBe(
          "true",
        ),
      );
    });
    await click("terminal-url");
    expect(f.external).toHaveBeenCalledTimes(1);
    expect(f.navigate).not.toHaveBeenCalled();
    await click("terminal-launch-options");
    await click("terminal-browser-embedded");
    await act(async () => {
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="terminal-browser-embedded"]')?.getAttribute("aria-pressed")).toBe(
          "true",
        ),
      );
    });
    await click("terminal-url");
    expect(f.navigate).toHaveBeenCalledOnce();
    expect(f.external).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("harness:gui:terminal-preferences")).toBeNull();
  });
  it("uses an in-terminal CLI change on the very next link click", async () => {
    const f = await mount();
    f.cliUpdate("system");
    await click("terminal-url");
    await vi.waitFor(() => expect(f.external).toHaveBeenCalledWith("https://example.test/login"));
    expect(f.navigate).not.toHaveBeenCalled();
  });
  it("refreshes an out-of-band CLI write on window focus", async () => {
    const f = await mount();
    f.cliUpdate("system");
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector('[data-testid="terminal-browser-toggle"]')?.getAttribute("aria-pressed")).toBe(
          "true",
        ),
      );
    });
    await click("terminal-url");
    expect(f.external).toHaveBeenCalledOnce();
    expect(f.navigate).not.toHaveBeenCalled();
  });
});
it("BrowserView opens the current page through the same host bridge", async () => {
  const f = await mount();
  await act(async () => root.render(createElement(BrowserView, { initialUrl: "https://example.test/current" })));
  await click("browser-open-external");
  expect(f.external).toHaveBeenCalledWith("https://example.test/current");
});
it("browser fallback opens only HTTP(S) without an opener", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await openExternalUrl("https://example.test/login");
  expect(open).toHaveBeenCalledWith("https://example.test/login", "_blank", "noopener,noreferrer");
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hello", ""])
    await expect(openExternalUrl(url)).rejects.toThrow();
  expect(open).toHaveBeenCalledTimes(1);
});
