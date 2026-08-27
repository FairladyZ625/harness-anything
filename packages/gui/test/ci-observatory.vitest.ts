// harness-test-tier: integration
// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CiObservatoryView } from "../src/renderer/views/CiObservatoryView.tsx";
import type { CiObservatoryRead } from "../src/api/renderer-dto.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const REPO_ID = "observatory-probe";
const mounted: { readonly root: Root; readonly container: HTMLElement }[] = [];
const fixture: CiObservatoryRead = {
  schema: "daemon.ci-observatory/v1",
  ok: true,
  status: "ready",
  window: 100,
  flakes: [
    {
      test: "retrying contract",
      file: "packages/kernel/test/retrying.test.ts",
      attempts: 8,
      flakes: 2,
      flakeRate: 0.25,
      p50Ms: 40,
      p95Ms: 90,
      quarantined: true,
      ownerTask: "task_owner1",
      quarantinedAt: "2026-08-01",
      quarantineDays: 26,
    },
  ],
  shardDurations: [
    { shard: 1, durationMs: 500 },
    { shard: 2, durationMs: 250 },
  ],
  gateTrends: [
    {
      gate: "G32",
      metric: "durationMs",
      points: [
        { runId: "run-1", occurredAt: "2026-08-26T00:00:00.000Z", value: 12, pass: true },
        { runId: "run-2", occurredAt: "2026-08-27T00:00:00.000Z", value: 20, pass: false },
      ],
    },
  ],
  l0MedianMs: 750,
  runs: [
    {
      runId: "run-2",
      sha: "0123456789abcdef",
      branch: "main",
      prNumber: null,
      job: "integration-shard (2)",
      wallclockMs: 900,
      runner: "ubuntu",
      occurredAt: "2026-08-27T00:00:00.000Z",
      pass: false,
      testCount: 18,
      gateCount: 2,
    },
  ],
  watermark: 8,
  sourceRevision: 8,
};

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
});

async function mountView(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["ci-observatory", REPO_ID], fixture);
  const container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(CiObservatoryView, { repoId: REPO_ID })));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe("CI observatory daemon-backed views", () => {
  it("renders flake, shard, gate, and recent-run sections from one daemon read", async () => {
    const container = await mountView(),
      text = container.textContent ?? "";
    expect(container.querySelector('[data-testid="ci-observatory-view"]')).toBeTruthy();
    expect(text).toContain("Flake ranking");
    expect(text).toContain("retrying contract");
    expect(text).toContain("25.0%");
    expect(text).toContain("task_owner1 · 26d");
    expect(text).toContain("shard 1");
    expect(text).toContain("L0 median: 750ms");
    expect(text).toContain("G32 · durationMs");
    expect(text).toContain("integration-shard (2)");
    expect(text).toContain("fail");
  });
});
