// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { windowDimensionRows } from "../src/renderer/views/OverviewView.tsx";

describe("overview dimension table paging (archive-line parity)", () => {
  it("windows rows at the fixed page size without silent truncation", () => {
    const rows = Array.from({ length: 90 }, (_, i) => `root-${i}`);
    const first = windowDimensionRows(rows, 0);
    expect(first.visible).toHaveLength(40);
    expect(first).toMatchObject({ page: 0, pageCount: 3, total: 90 });
    expect(windowDimensionRows(rows, 2).visible).toHaveLength(10);
  });

  it("clamps out-of-range pages and keeps a single page for small sets", () => {
    expect(windowDimensionRows(["a"], 5)).toMatchObject({ page: 0, pageCount: 1, total: 1 });
    expect(windowDimensionRows([], 0)).toMatchObject({ page: 0, pageCount: 1, total: 0 });
    const rows = Array.from({ length: 50 }, (_, i) => `m-${i}`);
    expect(windowDimensionRows(rows, 99).page).toBe(1);
  });
});
