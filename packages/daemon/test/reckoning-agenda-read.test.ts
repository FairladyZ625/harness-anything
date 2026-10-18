// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { deriveScheduleItems } from "../src/reckoning-agenda-read.ts";
import type { ScheduleRunsResult } from "../src/protocol/schedule-runs-contract.ts";
import type { TaskProjection } from "@harness-anything/kernel";

const projection = (openTask = false) =>
  ({
    read: () => ({ snapshot: { task: openTask ? { status: "active" } : null } }),
  }) as unknown as TaskProjection;

function row(
  scheduledFor: string,
  reportText: string | null,
  outcome: "succeeded" | "failed" | "missed" = "succeeded",
) {
  return {
    occurrenceId: scheduledFor,
    kind: "scheduled" as const,
    scheduledFor,
    claimedAt: scheduledFor,
    endedAt: scheduledFor,
    nodeId: "node",
    claimFence: "fence",
    outcome,
    durationMs: 1,
    reportRef: reportText === null ? null : "artifact:runtime-result/sha256/" + "a".repeat(64),
    reportText,
    detail: null,
    missedReason: null,
    dispatchId: null,
    runtimeSessionId: null,
    attemptIndex: 0,
    outputs: { facts: [], decisions: [], tasks: [] },
  };
}

const observedReportPrefix: Readonly<Record<string, string>> = {
  "2026-10-14":
    "# Nightly Reckoning\n\n**窗口**:2026-10-13T15:30Z → 2026-10-14T15:30Z(24h)。**信号**:`ha schedule reckon` 返回 15 个 abnormal-session。\n\n## 发现 1(建议修机制，优先)：结算的 delivery witness 看不见刚完成的 `ha task submit`,把成功交付判成 stopped",
  "2026-10-15":
    "# Nightly Reckoning\n\n**窗口**：2026-10-14T15:33Z → 2026-10-15T15:33Z。**信号**：`ha schedule reckon` 返回 9 个 abnormal-session。\n\n## 发现 1（结构性，第一问修机制，连续第二个窗口）：结算见证把已提交交付判成「无交付」",
  "2026-10-16":
    "# Nightly Reckoning\n\n**窗口**：2026-10-15T15:32Z → 2026-10-16T15:32Z（occurrence_63e5a9e8，本节点本地投影）。**信号**：`ha schedule reckon` 返回 6 条。\n\n## 发现 1（结构性，第三晚连报，第一问修机制）：结算见证继续把已提交交付判成「无交付」",
  "2026-10-17":
    "所有证据链闭合。汇总输出最终复盘报告。\n\n# Nightly Reckoning\n\n**窗口**:2026-10-16T15:32Z → 2026-10-17T15:32Z(24 小时，本地投影;边界节点视角)。入口说明:实际按 schedule mission 用 `ha schedule reckon` 完成。",
};

function report({
  status = "unresolved",
  key = "delivery-witness",
  ownerTaskRef = null,
  long = false,
  scheduledFor = "2026-10-14",
} = {}) {
  const finding = {
    key,
    title: "Delivery witness mismatch",
    status,
    action: "fix-source",
    evidenceCount: long ? 2 : 1,
    evidenceRefs: ["execution/one", "execution/two"],
    ownerTaskRef,
  };
  return [
    observedReportPrefix[scheduledFor] ?? observedReportPrefix["2026-10-14"],
    "",
    "HARNESS-OUTCOME: succeeded",
    "",
    "```harness-reckoning",
    JSON.stringify({
      schema: "harness-reckoning/v1",
      windows: [
        { kind: "short", complete: true, findings: [finding] },
        ...(long ? [{ kind: "long", complete: true, findings: [finding] }] : []),
      ],
    }),
    "```",
  ].join("\n");
}

function read(...runs: ReturnType<typeof row>[]): ScheduleRunsResult {
  return {
    ok: true,
    status: "ready",
    scheduleId: "arbitrary-detect-schedule",
    runs: runs.reverse(),
    totals: {
      runs: runs.length,
      missed: runs.filter(({ outcome }) => outcome === "missed").length,
      failed: runs.filter(({ outcome }) => outcome === "failed").length,
    },
    truncated: false,
    watermark: 4,
    sourceRevision: 4,
  };
}

test("10/14-10/17 replay promotes repeated finding once, then clears on resolved", () => {
  const first = report({ scheduledFor: "2026-10-14" });
  assert.deepEqual(deriveScheduleItems(read(row("2026-10-14T23:00:00Z", first)), projection()), []);
  const repeated = deriveScheduleItems(
    read(
      row("2026-10-14T23:00:00Z", first),
      row("2026-10-15T23:00:00Z", report({ scheduledFor: "2026-10-15" })),
      row("2026-10-16T23:00:00Z", report({ scheduledFor: "2026-10-16" })),
    ),
    projection(),
  );
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0]?.ref, "audit/arbitrary-detect-schedule/delivery-witness");
  assert.equal(repeated[0]?.since, "2026-10-14T23:00:00Z");
  assert.deepEqual(
    deriveScheduleItems(
      read(
        row("2026-10-16T23:00:00Z", report({ scheduledFor: "2026-10-16" })),
        row("2026-10-17T23:00:00Z", report({ status: "resolved", scheduledFor: "2026-10-17" })),
      ),
      projection(),
    ),
    [],
  );
});

test("failed, missed, incomplete, and one-off mismatch break short streak without long state", () => {
  const first = report();
  assert.deepEqual(
    deriveScheduleItems(
      read(
        row("2026-10-14T23:00:00Z", first),
        row("2026-10-15T23:00:00Z", null, "failed"),
        row("2026-10-16T23:00:00Z", first),
      ),
      projection(),
    ),
    [],
  );
  const incomplete = report();
  const incompleteReport = incomplete.replace('"complete":true', '"complete":false');
  assert.deepEqual(
    deriveScheduleItems(
      read(
        row("2026-10-14T23:00:00Z", first),
        row("2026-10-15T23:00:00Z", incompleteReport),
        row("2026-10-16T23:00:00Z", first),
      ),
      projection(),
    ),
    [],
  );
});

test("long window needs two evidence points and open owner task suppresses duplicate", () => {
  const long = report({ long: true, ownerTaskRef: "task/owner" });
  const suppressed = deriveScheduleItems(read(row("2026-10-17T23:00:00Z", long)), projection(true));
  assert.deepEqual(suppressed, []);
  assert.equal(deriveScheduleItems(read(row("2026-10-17T23:00:00Z", long)), projection()).length, 1);
  const oneEvidence = report({ long: true }).replaceAll('"evidenceCount":2', '"evidenceCount":1');
  assert.deepEqual(deriveScheduleItems(read(row("2026-10-17T23:00:00Z", oneEvidence)), projection()), []);
});
