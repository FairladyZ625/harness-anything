// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CiFocusDetail, CiFocusList } from "../src/renderer/views/overview-ci.tsx";
import fixture from "../test-support/ci-observation-dto.json";
import type { CiObservatoryRead } from "../src/api/renderer-dto.ts";
const ciPresentationFixture = ({ cached = false } = {}) =>
  (cached ? fixture.cold : fixture.hot) as unknown as CiObservatoryRead;
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
it("shared DTO shows failures, timeout, owner/error and missing statistics; request reveals full details", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    setActiveLocale(locale);
    const host = document.createElement("div"),
      root = createRoot(host),
      fetch = vi.fn();
    const ci = ciPresentationFixture();
    act(() =>
      root.render(
        createElement(CiFocusDetail, {
          ci,
          run: ci.runs.find((run) => run.fileOutcomes.length > 0),
          error: null,
          fetching: false,
          onFetch: fetch,
        }),
      ),
    );
    expect(host.textContent).toContain("Expected result to equal 42");
    expect(host.textContent).toContain("fixture.test.ts:27:5");
    expect(host.textContent).toContain("timeout.test.ts · timeout · 810000/810000");
    expect(host.textContent).toContain("claim_fence_expired");
    expect(host.textContent).toContain("HTTP 401");
    expect(host.textContent).toContain("fence-present");
    expect(host.querySelector('[data-testid="ci-statistics"]')?.textContent).toContain("pending");
    expect(host.querySelector('[data-testid="ci-statistics"]')?.textContent).not.toContain("p95=0");
    expect(host.querySelector('[data-testid="ci-cold-detail"]')).toBeNull();
    act(() => (host.querySelector('[data-testid="ci-fetch-details"]') as HTMLButtonElement).click());
    expect(fetch).toHaveBeenCalledTimes(1);
    const cold = ciPresentationFixture({ cached: true });
    act(() =>
      root.render(
        createElement(CiFocusDetail, {
          ci: cold,
          run: cold.runs.find((run) => run.fileOutcomes.length > 0),
          error: null,
          fetching: false,
          onFetch: fetch,
        }),
      ),
    );
    expect(host.querySelector('[data-testid="ci-cold-detail"]')?.textContent).toContain("Full assertion stack");
    expect(host.querySelector('[data-testid="ci-recoveries"]')?.textContent).toContain("1 → 2");
    expect(host.querySelector('[data-testid="ci-statistics"]')?.textContent).toContain("n=");
    act(() => root.unmount());
  }
});

it("empty observations and workflow with no artifact do not imply all tests passed; reads retain visible failure", () => {
  setActiveLocale("en-US");
  const host = document.createElement("div"),
    root = createRoot(host),
    ci = ciPresentationFixture();
  const workflow = {
    ...ci.runs[0],
    scope: "workflow" as const,
    pass: null,
    testCount: null,
    failedTests: [],
    fileOutcomes: [],
    detail: null,
    detailAvailability: "unavailable" as const,
    measurementCoverage: {
      status: "no-test-artifact" as const,
      missingReason: null,
      startedFileCount: null,
      completedFileCount: null,
    },
  };
  act(() =>
    root.render(
      createElement(CiFocusDetail, {
        ci,
        run: workflow,
        error: "center_unreachable",
        fetching: false,
        onFetch: vi.fn(),
      }),
    ),
  );
  expect(host.textContent).toContain("no-test-artifact");
  expect(host.textContent).not.toContain("0 tests passed");
  expect(host.querySelector('[data-testid="ci-read-error"]')?.textContent).toBe("center_unreachable");
  act(() => root.render(createElement(CiFocusList, { ci: { ...ci, runs: [] }, selectedId: null, onSelect: vi.fn() })));
  expect(host.textContent).toContain("No CI observations");
  act(() => root.unmount());
});

it("a ledger cut advance refreshes both hot and explicitly requested detail queries", async () => {
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  const { invalidateLedgerDependents } = await import("../src/renderer/task-data.ts");
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const observers = [false, true].map((fetchDetails) => {
    const queryKey = ["ci-observatory", "repo-refresh", fetchDetails];
    client.setQueryData(queryKey, { sourceRevision: 1 });
    const observer = new QueryObserver(client, { queryKey, queryFn: async () => ({ sourceRevision: 2 }) });
    const unsubscribe = observer.subscribe(() => {});
    return { queryKey, observer, unsubscribe };
  });
  try {
    await invalidateLedgerDependents(client, "repo-refresh");
    for (const { queryKey } of observers) expect(client.getQueryData(queryKey)).toEqual({ sourceRevision: 2 });
  } finally {
    for (const { observer, unsubscribe } of observers) {
      unsubscribe();
      observer.destroy();
    }
    client.clear();
  }
});
