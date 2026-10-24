// harness-test-tier: integration
// @vitest-environment happy-dom
// 设置页对两类「仓库状态」失败必须原样透出服务端给的 code 与人话(2026-10-23 业主反馈):
// ①旧版 vertical 声明 → vertical_declaration_outdated + 迁移命令;
// ②台账从未 mint Settings → settings_entity_missing + `ha settings update`,且不得再出现
// 旧的 bootstrap 提示。GUI 不做二次改写:服务端说哪条命令,页面就显示哪条。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsView } from "../src/renderer/views/SettingsView.tsx";
import { catalogQueryKeys } from "../src/renderer/catalog-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { settingsFieldsFace, settingsGroupsFace } from "./settings-catalog-snapshot.ts";

const REPO_ID = "settings-failure-probe";
const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  Reflect.deleteProperty(window, "harness");
});

/** The daemon rejection exactly as `json-rpc-server` serializes it: code + rejectionExplanation. */
const rejection = (code: string, rejectionExplanation: string) => ({
  schema: "command-receipt/v2",
  ok: false,
  command: "repo.settings.read",
  outcome: "op_rejected",
  opId: "N/A",
  origin: "daemon",
  code,
  evidence: `rejection:${code}`,
  rejectionExplanation,
  error: { code },
});

async function mountFailingRead(payload: ReturnType<typeof rejection>): Promise<HTMLElement> {
  Object.defineProperty(window, "harness", {
    configurable: true,
    value: {
      updateSettings: vi.fn(),
      getSettings: async () => payload,
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The page reads its field/group元数据 from the catalog snapshot even while the settings read
  // fails, so the snapshot must be the real projection — otherwise the probe renders a section that
  // is not the one under test.
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SettingsView, { repoId: REPO_ID, repos: [], onOpenProject: () => {} }),
      ),
    );
  });
  // Poll the rendered surface rather than sleeping: the assertion is "the page eventually shows
  // the server's answer", and React Query settles on its own schedule.
  // Poll the rendered surface inside act: the assertion is "the page eventually shows the
  // server's answer", and React Query settles on its own schedule (no wall-clock sleep).
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.textContent ?? "").toMatch(/vertical_declaration_outdated|settings_entity_missing/u),
    );
  });
  return container;
}

describe("settings page surfaces repository-state failures verbatim", () => {
  it("shows the outdated-declaration code and its migration command", async () => {
    const container = await mountFailingRead(
      rejection(
        "vertical_declaration_outdated",
        "This repository's vertical declaration (harness/vertical.json) still uses a retired construct: checkerProfile. " +
          "ha migrate completion --source harness/vertical.json --mode convert --destination <new-file>",
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("vertical_declaration_outdated");
    expect(text).toContain("ha migrate completion --source harness/vertical.json");
    expect(text).toContain("checkerProfile");
    // The unreadable Effect signature must never reach the page.
    expect(text).not.toContain('readonly schema: "vertical-definition/v1"');
  });

  it("shows the missing-settings code with a command that exists, never the retired bootstrap hint", async () => {
    const container = await mountFailingRead(
      rejection(
        "settings_entity_missing",
        "This repository has no Settings entity yet. Run `ha settings update` as a person " +
          "(for example `ha settings update --locale en-US`); repository settings are principal-owned.",
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("settings_entity_missing");
    expect(text).toContain("ha settings update");
    expect(text).not.toContain("bootstrap the repository");
    // `ha daemon projection rebuild` re-derives existing events; it cannot create the entity, and an
    // agent may run it — recommending it would be an escape hatch, not a repair.
    expect(text).not.toContain("projection rebuild");
    // A missing entity is not a "wait a moment" state.
    expect(text).not.toContain("projection_pending");
  });
});
