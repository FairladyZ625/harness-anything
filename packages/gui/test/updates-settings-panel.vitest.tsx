// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { EdgeUpgradeGuiApi, EdgeUpgradeGuiProgress } from "../src/api/edge-upgrade-contract.ts";
import type { UpdateApi } from "../src/api/update-contract.ts";
import { UpdatesSettingsPanel } from "../src/renderer/views/settings/UpdatesSettingsPanel.tsx";

const hosts: HTMLElement[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.remove());
  delete (window as { harness?: unknown }).harness;
});

function mount(repoId: string | null = "demo") {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  const root = createRoot(host);
  act(() => {
    root.render(<UpdatesSettingsPanel repoId={repoId} />);
  });
  return { host, root };
}

it("renders source-mode edge upgrade controls, runs upgrade, and offers GUI restart", async () => {
  let progressListener: ((progress: EdgeUpgradeGuiProgress) => void) | null = null;
  const relaunch = vi.fn(async () => undefined);
  const run = vi.fn(async () => {
    progressListener?.({ stage: "handing_off", message: "waiting for daemon" });
    return {
      schema: "edge-upgrade-receipt/v1" as const,
      ok: true,
      command: "edge-upgrade" as const,
      outcome: "upgraded" as const,
      installRoot: "/tmp/source",
      repoId: "demo",
      fromCommit: "a".repeat(40),
      toCommit: "b".repeat(40),
      targetCommit: "b".repeat(40),
      daemonPid: 2002,
      daemonBuildId: "b".repeat(40),
      daemonRestarted: true,
      syncedRepos: [{ repoId: "demo", revision: 12, lagRevisions: 0, mirrorOutcome: "materialized" }],
      rolledBack: false,
      guiRestartRequired: true,
    };
  });
  const edgeUpgrade: EdgeUpgradeGuiApi = {
    status: vi.fn(async () => ({
      mode: "source",
      ok: true,
      installRoot: "/tmp/source",
      repoId: "demo",
      localCommit: "a".repeat(40),
      daemonCommit: "a".repeat(40),
      centerCommit: "b".repeat(40),
      updateAvailable: true,
      canRollback: true,
      previousCommit: "9".repeat(40),
      inProgress: false,
    })),
    run,
    relaunch,
    onProgress: (listener) => {
      progressListener = listener;
      return () => {
        progressListener = null;
      };
    },
  };
  (window as { harness?: unknown }).harness = { edgeUpgrade };

  const { host } = mount("demo");
  await act(async () => {
    await Promise.resolve();
  });

  expect(host.querySelector('[data-testid="edge-upgrade-controls"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="edge-upgrade-rollback-btn"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="edge-upgrade-status-text"]')?.textContent).toContain(
    "aaaaaaaaaaaa -> bbbbbbbbbbbb",
  );

  const runBtn = host.querySelector('[data-testid="edge-upgrade-run-btn"]') as HTMLButtonElement;
  await act(async () => {
    runBtn.click();
    await Promise.resolve();
  });
  expect(run).toHaveBeenCalledWith({ repoId: "demo" });

  const relaunchBtn = host.querySelector('[data-testid="edge-upgrade-relaunch-btn"]') as HTMLButtonElement;
  expect(relaunchBtn).not.toBeNull();
  await act(async () => {
    relaunchBtn.click();
    await Promise.resolve();
  });
  expect(relaunch).toHaveBeenCalledTimes(1);
});

it("keeps electron-updater controls when running as a packaged desktop app", async () => {
  const updates: UpdateApi = {
    status: vi.fn(async () => ({ state: "downloaded" as const, version: "1.5.0" })),
    check: vi.fn(async () => ({ state: "not-available" as const })),
    install: vi.fn(async () => undefined),
    onStatus: () => () => undefined,
  };
  const edgeUpgrade: EdgeUpgradeGuiApi = {
    status: vi.fn(async () => ({
      mode: "packaged",
      ok: true,
      installRoot: null,
      repoId: "demo",
      localCommit: null,
      daemonCommit: null,
      centerCommit: null,
      updateAvailable: false,
      canRollback: false,
      previousCommit: null,
      inProgress: false,
    })),
    run: vi.fn(),
    relaunch: vi.fn(),
    onProgress: () => () => undefined,
  };
  (window as { harness?: unknown }).harness = { updates, edgeUpgrade };

  const { host } = mount("demo");
  await act(async () => {
    await Promise.resolve();
  });

  expect(host.querySelector('[data-testid="packaged-update-controls"]')).not.toBeNull();
  expect(host.textContent).toContain("1.5.0");
});
