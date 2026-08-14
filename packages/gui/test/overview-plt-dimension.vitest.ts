// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { dimensionKeysOf, dimensionLabel } from "../src/renderer/views/OverviewView.tsx";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import { UNASSIGNED_PLT_LANE } from "../src/renderer/views/SwimlaneBoard.tsx";

function task(patch: Partial<TaskRow>): TaskRow {
  return {
    taskId: "task_a", title: "Task A", projectId: "proj",
    coordinationStatus: "active", rawStatus: "active", freshness: "fresh",
    packageDisposition: "active", closeoutReadiness: "not_required",
    engine: "local", source: "local-document", module: "kernel",
    lastKnownAt: "2026-08-01T00:00:00.000Z", gates: [], docs: [],
    ...patch,
  };
}

describe("overview PLT dimension (REQ-GUI-01 PLT×status matrix)", () => {
  it("derives PLT rows from task placement projection, multi-PLT counted per line", () => {
    const multi = task({ productLines: ["plt-a", "plt-b"] });
    expect(dimensionKeysOf(multi, "plt")).toEqual(["plt-a", "plt-b"]);
    expect(dimensionKeysOf(multi, "root")).toEqual(["task_a"]);
    expect(dimensionKeysOf(multi, "module")).toEqual(["kernel"]);
  });

  it("keeps unprojected PLT explicit instead of inventing a product line", () => {
    const bare = task({});
    expect(dimensionKeysOf(bare, "plt")).toEqual([UNASSIGNED_PLT_LANE]);
    expect(dimensionLabel(UNASSIGNED_PLT_LANE, "plt", [])).toBe("未投影 PLT");
    expect(dimensionLabel("plt-a", "plt", [])).toBe("plt-a");
  });

  it("uses the same lane key as the swimlane board so drill lands on the lane", () => {
    // App.drillToBoard 把 plt 维度映射为 productLine 分组;latch key 必须一致。
    expect(DEFAULT_TASK_FILTERS.module).toBe("all");
    const bare = task({});
    expect(dimensionKeysOf(bare, "plt")[0]).toBe(UNASSIGNED_PLT_LANE);
  });
});
