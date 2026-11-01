// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { settingsQueryKeys } from "../src/renderer/settings-data.ts";
import { catalogQueryKeys } from "../src/renderer/catalog-data.ts";
import { settingsFieldsFace, settingsGroupsFace } from "./settings-catalog-snapshot.ts";

const REPO_ID = "settings-language-local-probe";
const mounted: Array<{ readonly root: Root; readonly container: HTMLElement }> = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  Reflect.deleteProperty(window, "harness");
  localStorage.clear();
});

async function mountSettings() {
  localStorage.setItem("harness-locale", "zh-CN");
  const [{ SettingsView }, { I18nProvider }, { setActiveLocale }] = await Promise.all([
    import("../src/renderer/views/SettingsView.tsx"),
    import("../src/renderer/i18n/index.tsx"),
    import("../src/renderer/i18n/core.ts"),
  ]);
  setActiveLocale("zh-CN");

  const updateCalls: unknown[] = [];
  Object.defineProperty(window, "harness", {
    configurable: true,
    value: {
      request: vi.fn(async (method: string, payload: unknown) => {
        if (method === "updateSettings") {
          updateCalls.push(payload);
          throw new Error("fetch failed");
        }
        throw new Error(`Unexpected settings probe request: ${method}`);
      }),
    },
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  client.setQueryData(settingsQueryKeys.read(REPO_ID), {
    schema: "daemon.settings-read/v1",
    ok: true,
    settings: { locale: "en-US", gates: [] },
    values: {},
    revision: 1,
    lastChanged: "initial",
    decisionPoints: [],
  });
  client.setQueryData(catalogQueryKeys.snapshot(REPO_ID), {
    schema: "daemon.gui-catalog/v1",
    ok: true,
    settingsFields: settingsFieldsFace(),
    settingsGroups: settingsGroupsFace(),
    settingsScaffolds: { task: [], repository: [] },
    verticals: [],
    presets: [],
    profiles: [],
    scaffolds: { task: [], repository: [] },
    reviewers: [],
    completionSources: [],
    agents: [],
  });
  client.setQueryData(["agents", REPO_ID], []);

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        I18nProvider,
        null,
        createElement(
          "div",
          { id: "locale-surface" },
          createElement(
            QueryClientProvider,
            { client },
            createElement(SettingsView, {
              repoId: REPO_ID,
              repos: [],
              onOpenProject: () => undefined,
              onJoinCenter: () => undefined,
            }),
          ),
        ),
      ),
    );
  });
  await act(async () => {
    await vi.waitFor(() => expect(container.querySelector("#locale-surface")).not.toBeNull());
  });
  return { container, updateCalls };
}

describe("settings language is a machine-local preference", () => {
  it("does not replace the chosen language with the repository locale on entry", async () => {
    const { container } = await mountSettings();

    expect(container.querySelector("#locale-surface")?.getAttribute("data-i18n-locale")).toBe("zh-CN");
  });

  it("changes language locally without sending a repository settings write", async () => {
    const { container, updateCalls } = await mountSettings();
    const languageTab = [...container.querySelectorAll("button")].find((button) =>
      /语言|Language/u.test(button.textContent ?? ""),
    );
    expect(languageTab).toBeDefined();
    await act(async () => languageTab!.click());
    const languageSelect = container.querySelector("select") as HTMLSelectElement | null;
    expect(languageSelect).not.toBeNull();
    await act(async () => {
      languageSelect!.value = "en-US";
      languageSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("#locale-surface")?.getAttribute("data-i18n-locale")).toBe("en-US");
    await act(async () => {
      languageSelect!.value = "zh-CN";
      languageSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(updateCalls).toEqual([]);
    expect(container.textContent).not.toContain("fetch failed");
    expect(container.querySelector("#locale-surface")?.getAttribute("data-i18n-locale")).toBe("zh-CN");
    expect({
      locale: container.querySelector("#locale-surface")?.getAttribute("data-i18n-locale"),
      language: languageSelect!.value,
      remoteWrites: updateCalls.length,
      fetchError: container.textContent?.includes("fetch failed") ?? false,
    }).toMatchInlineSnapshot(`
      {
        "fetchError": false,
        "language": "zh-CN",
        "locale": "zh-CN",
        "remoteWrites": 0,
      }
    `);
  });
});
