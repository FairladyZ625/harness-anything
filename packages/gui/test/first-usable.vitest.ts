import { describe, expect, it, beforeEach } from "vitest";
import {
  startPerfNavigation,
  markPerf,
  getPerfTrace,
  getPerfMarker,
  elapsedSinceNavigation,
  resetPerfTraces,
  FIRST_SCREEN_DOM_CEILING,
  PERF_TRACE_GLOBAL,
} from "../src/renderer/perf/first-usable.ts";
import {
  needsForView,
  viewNeeds,
  tasksRequired,
  triadicRequired,
  executionEvidenceRequired,
} from "../src/renderer/perf/perspective-load.ts";

describe("first-usable markers", () => {
  beforeEach(() => {
    resetPerfTraces();
  });

  it("records sticky first-usable and publishes a global trace", () => {
    startPerfNavigation("executions", 100);
    markPerf("executions", "data-ready", { groups: 1 }, 150);
    markPerf("executions", "first-meaningful-rows", null, 160);
    markPerf("executions", "first-usable", { groupCount: 1 }, 180);
    // second first-usable is ignored (sticky)
    markPerf("executions", "first-usable", { groupCount: 99 }, 999);

    const marker = getPerfMarker("executions", "first-usable");
    expect(marker?.at).toBe(180);
    expect(marker?.detail).toEqual({ groupCount: 1 });
    expect(elapsedSinceNavigation("executions", "first-usable")).toBe(80);

    const globalTrace = (globalThis as Record<string, unknown>)[PERF_TRACE_GLOBAL] as {
      executions: { markers: Array<{ name: string }> };
    };
    expect(globalTrace.executions.markers.map((m) => m.name)).toEqual([
      "navigation-start",
      "data-ready",
      "first-meaningful-rows",
      "first-usable",
    ]);
    expect(getPerfTrace("executions")?.markers).toHaveLength(4);
  });

  it("keeps the first-screen DOM ceiling contract at 10_000", () => {
    expect(FIRST_SCREEN_DOM_CEILING).toBe(10_000);
  });
});

describe("perspective-gated load policy", () => {
  it("loads only current-perspective data on overview and executions", () => {
    expect(tasksRequired("overview")).toBe(true);
    expect(triadicRequired("overview")).toBe(true);
    expect(executionEvidenceRequired("overview")).toBe(false);

    expect(tasksRequired("executions")).toBe(false);
    expect(triadicRequired("executions")).toBe(false);
    expect(executionEvidenceRequired("executions")).toBe(true);

    // catalog is always needed for shell project badge
    expect(viewNeeds("executions", "catalog")).toBe(true);
    expect(needsForView("presets").has("tasks")).toBe(false);
  });
});
