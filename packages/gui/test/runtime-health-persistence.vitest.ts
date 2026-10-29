// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { runtimeHealthWorst } from "../src/renderer/model/runtime-health.ts";
import { useAppRuntimeHealth } from "../src/renderer/model/use-app-runtime-health.ts";

const repo = {
  mode: "local" as const,
  cellState: "attached" as const,
  queueDepth: 0,
  lastError: null,
  unavailableReason: null,
};

function Probe({ lag, repoKey }: { readonly lag: number; readonly repoKey: string }) {
  const health = useAppRuntimeHealth({
    repoKey,
    daemon: { ok: true, observedAt: new Date().toISOString(), uptimeMs: 1 },
    repo,
    projection: { watermark: 100 - lag, sourceRevision: 100, status: lag > 0 ? "pending" : "ready" },
    projectionLoading: false,
    mount: null,
    projectTasks: [],
  });
  return createElement("span", { "data-testid": "level" }, runtimeHealthWorst(health));
}

async function mountProbe() {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root: Root = createRoot(div);
  const render = async (lag: number, repoKey = "repo") => {
    await act(async () => {
      root.render(createElement(Probe, { lag, repoKey }));
    });
    return div.querySelector('[data-testid="level"]')?.textContent ?? "";
  };
  return { div, root, render };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useAppRuntimeHealth persistence wiring", () => {
  it("advances the lag clock from existing snapshots and degrades only after the grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    const { div, root, render } = await mountProbe();
    expect(await render(3)).toBe("syncing");
    vi.setSystemTime(new Date("2026-08-31T12:00:29.000Z"));
    expect(await render(3)).toBe("syncing");
    vi.setSystemTime(new Date("2026-08-31T12:00:30.000Z"));
    expect(await render(3)).toBe("degraded");
    // Resolving the lag clears the clock; a later wedge starts over at syncing.
    expect(await render(0)).toBe("ok");
    vi.setSystemTime(new Date("2026-08-31T12:00:31.000Z"));
    expect(await render(3)).toBe("syncing");
    await act(async () => root.unmount());
    div.remove();
  });

  it("restarts the clock when the active repo changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    const { div, root, render } = await mountProbe();
    expect(await render(3, "repo-a")).toBe("syncing");
    vi.setSystemTime(new Date("2026-08-31T12:00:35.000Z"));
    // repo-b has the same lag but a fresh clock; carrying repo-a's 35s would say degraded.
    expect(await render(3, "repo-b")).toBe("syncing");
    await act(async () => root.unmount());
    div.remove();
  });
});
