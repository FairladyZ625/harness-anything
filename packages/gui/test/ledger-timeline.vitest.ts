// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { ledgerIdCreatedAt, sortTasksByCreatedDesc, taskCreatedAt } from "../src/renderer/model/ledger-timeline.ts";

// kernel generateTaskId 形态:task_ + base32(ms,10) + 16 位熵。
const OLD = "task_01M0507380ABCDEFGHJKMNPQRS"; // 2026-08-16T10:00:00Z
const MID = "task_01M07JKT80ABCDEFGHJKMNPQRS"; // 2026-08-17T10:00:00Z
const NEW = "task_01M0A39KE0ABCDEFGHJKMNPQRS"; // 2026-08-18T09:30:00Z

function task(taskId: string, title = taskId): TaskRow {
  return {
    taskId, title, projectId: "repo-a", coordinationStatus: "active", rawStatus: "active",
    freshness: "fresh", packageDisposition: "active", closeoutReadiness: "not_required",
    engine: "local", source: "local-document", module: "unassigned",
    lastKnownAt: "2026-08-01T00:00:00.000Z", gates: [], docs: [],
  };
}

describe("ledger id creation-time decode", () => {
  it("decodes the kernel base32 timestamp segment of a minted task id", () => {
    expect(ledgerIdCreatedAt(NEW)).toBe("2026-08-18T09:30:00.000Z");
    expect(taskCreatedAt(task(OLD))).toBe("2026-08-16T10:00:00.000Z");
  });

  it("returns null for non-minted ids instead of inventing a time", () => {
    expect(ledgerIdCreatedAt("configure-verify-smoke")).toBeNull();
    expect(ledgerIdCreatedAt("task_short")).toBeNull();
    // decision 哈希 id 即使 26 位字符合法,也不属于 task_ mint 形态,不得解码冒充创建时间。
    expect(ledgerIdCreatedAt("dec_" + "A".repeat(26))).toBeNull();
    expect(ledgerIdCreatedAt("dec_" + "9".repeat(26))).toBeNull();
  });
});

describe("sortTasksByCreatedDesc (overview task stream)", () => {
  it("orders tasks newest first so a newly created task lands on top without search", () => {
    expect(sortTasksByCreatedDesc([task(OLD), task(MID), task(NEW)]).map((row) => row.taskId))
      .toEqual([NEW, MID, OLD]);
  });

  it("sorts entities with unknown creation time to the tail, keeping determinism", () => {
    const rows = sortTasksByCreatedDesc([task("replay-imported-task"), task(NEW)]);
    expect(rows.map((row) => row.taskId)).toEqual([NEW, "replay-imported-task"]);
    expect(taskCreatedAt(rows[1]!)).toBeNull();
  });

  it("empty input yields an empty stream and never mutates the input array", () => {
    const input: TaskRow[] = [];
    expect(sortTasksByCreatedDesc(input)).toEqual([]);
    const original = [task(OLD), task(NEW)];
    sortTasksByCreatedDesc(original);
    expect(original.map((row) => row.taskId)).toEqual([OLD, NEW]);
  });
});
