// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import type { RepositoryReadFrame } from "@harness-anything/daemon/protocol";
import { RepositoryReadNotice } from "../src/renderer/components/RepositoryReadNotice.tsx";
import { harnessClient, type TaskListSuccess } from "../src/renderer/api-client.ts";
import { joinLedgerCut } from "../src/renderer/task-data.ts";
import { readUseCaseProjection } from "../src/renderer/use-case-projection-client.ts";
import { repositoryReadFrame } from "../src/renderer/repository-read-frame.ts";
import { resetGuiTransportForTest } from "../src/renderer/gui-transport.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { SquadRunList } from "../src/renderer/components/sessions/SquadRunList.tsx";
import { squadRunSummaryRow } from "./squad-run-fixtures.ts";
import { artifactsClient } from "../src/renderer/artifacts-client.ts";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
  resetGuiTransportForTest();
});
function frame(revision = 42, state: "fresh" | "stale" = "fresh"): RepositoryReadFrame {
  return {
    cut: { revision, headDigest: `head-${revision}` },
    freshness: {
      state,
      confirmedAt: "2026-10-07T00:00:00.000Z",
      ageMs: state === "stale" ? 120_000 : 0,
      lagRevisions: 0,
      maxAgeMs: 60_000,
      maxLagRevisions: 32,
    },
    warning: state === "stale" ? "可能过期：最后一次中心确认已过期" : null,
  };
}
function list(revision: number): TaskListSuccess {
  return {
    ok: true,
    status: "ready",
    rows: [],
    invalidRows: [],
    watermark: revision,
    sourceRevision: revision,
    warnings: [],
    ...frame(revision),
  };
}

it("retains cuts through task parsing and named projection unwrapping, and rejects unavailable reads", async () => {
  let result: unknown = list(42);
  vi.stubGlobal("harness", { request: vi.fn(async () => result) });
  expect(repositoryReadFrame(await harnessClient.getTasks({ repoId: "edge" }))).toEqual(frame());
  result = {
    ok: true,
    schema: "daemon.use-case-projection/v1",
    name: "schedule-plane",
    projection: { ok: true, rows: [] },
    ...frame(43, "stale"),
  };
  expect(repositoryReadFrame(await readUseCaseProjection({ repoId: "edge", name: "schedule-plane" }))).toEqual(
    frame(43, "stale"),
  );
  result = {
    ok: false,
    code: "replica_unavailable",
    rejectionExplanation: "This cut cannot answer this query.",
    error: { code: "replica_unavailable" },
  };
  await expect(harnessClient.getTasks({ repoId: "edge" })).rejects.toMatchObject({
    code: "replica_unavailable",
    message: "This cut cannot answer this query.",
  });
  vi.stubGlobal("harness", { listArtifacts: vi.fn(async () => result) });
  await expect(artifactsClient.list("edge", "all")).rejects.toMatchObject({
    code: "replica_unavailable",
    message: "This cut cannot answer this query.",
  });
});

it("keeps the older proven cut during pagination and advances metadata with a complete delta", () => {
  const base = list(10),
    next = list(20);
  expect(joinLedgerCut(base, next, "resume").cut?.revision).toBe(10);
  expect(joinLedgerCut(base, next, "delta").cut?.revision).toBe(20);
  expect(() => repositoryReadFrame({ ...frame(), freshness: { state: "fresh" } })).toThrow(/complete replica cut/);
});

it("shows fresh, stale and unavailable on the mounted repository and preserves the last cut on error", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    key = ["tasks", "edge"],
    observer = new QueryObserver(client, { queryKey: key, enabled: false }),
    unsubscribe = observer.subscribe(() => undefined),
    container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    unsubscribe();
    client.clear();
    container.remove();
  });
  client.setQueryData(key, list(42));
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RepositoryReadNotice, { repoId: "edge" })),
    ),
  );
  expect(container.querySelector("[data-state='fresh']")).not.toBeNull();
  expect(container.textContent).toContain("revision 42");
  await act(async () => {
    client.setQueryData(key, { ...list(42), ...frame(42, "stale") });
  });
  expect(container.querySelector("[data-state='stale']")).not.toBeNull();
  expect(container.textContent).toContain("last report, not current liveness");
  await act(async () => {
    client
      .getQueryCache()
      .find({ queryKey: key })!
      .setState({
        status: "error",
        error: Object.assign(new Error("Missing replica"), { code: "replica_unavailable" }),
      });
  });
  expect(container.querySelector("[data-state='unavailable']")).not.toBeNull();
  expect(container.textContent).toContain("do not represent empty data");
  expect(container.textContent).toContain("revision 42");
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RepositoryReadNotice, { repoId: "another-edge" })),
    ),
  );
  expect(container.textContent).toBe("");
});

it("labels an accepted running Squad as a last report with its accepted time and revision", () => {
  const html = renderToStaticMarkup(
    createElement(SquadRunList, {
      runs: [{ ...squadRunSummaryRow, phase: "workers_running", runningCount: 2 }],
      truncated: false,
      totalRuns: 1,
      squadNames: new Map(),
      query: "",
      range: "all",
      selectedId: null,
      onSelectRun: () => undefined,
    }),
  );
  expect(html).toContain("Last reported");
  expect(html).toContain("revision 3");
  expect(html).toContain("2026");
  expect(html).not.toContain("box-shadow");
});
