// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { DecisionRow, TaskRow } from "../src/renderer/model/types.ts";
import { buildLedgerTimeline, ledgerIdCreatedAt, taskCreatedAt } from "../src/renderer/model/ledger-timeline.ts";

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

function decision(decisionId: string, proposedAt: string, title = decisionId): DecisionRow {
  return {
    decisionId, title, state: "in_effect", question: "q", chosen: [], rejected: [],
    claims: [], judgmentConsents: [], body: null, proposedAt,
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

describe("buildLedgerTimeline", () => {
  it("mixes tasks and decisions in creation-time descending order, newest first", () => {
    const entries = buildLedgerTimeline(
      [task(OLD), task(NEW)],
      [decision("dec_1", "2026-08-17T10:00:00.000Z")],
    );
    expect(entries.map((entry) => entry.id)).toEqual([NEW, "dec_1", OLD]);
    expect(entries.map((entry) => entry.kind)).toEqual(["task", "decision", "task"]);
  });

  it("a newly created task or decision lands on top without search", () => {
    const entries = buildLedgerTimeline(
      [task(OLD), task(MID), task(NEW)],
      [decision("dec_latest", "2026-08-19T00:00:00.000Z")],
    );
    expect(entries[0]).toMatchObject({ id: "dec_latest" });
    expect(entries[1]).toMatchObject({ id: NEW });
  });

  it("sorts entities with unknown creation time to the tail, keeping determinism", () => {
    const entries = buildLedgerTimeline(
      [task("replay-imported-task"), task(NEW)],
      [],
    );
    expect(entries.map((entry) => entry.id)).toEqual([NEW, "replay-imported-task"]);
    expect(entries[1]!.at).toBeNull();
  });

  it("empty inputs yield an empty stream", () => {
    expect(buildLedgerTimeline([], [])).toEqual([]);
  });
});
