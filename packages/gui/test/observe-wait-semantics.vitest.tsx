// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { observeLogRow } from "../src/renderer/daemon-observe-model.ts";
import { ObserveStatsState } from "../src/renderer/daemon-observe-stats.ts";
import { ObserveSlowOpsBoard } from "../src/renderer/components/observe/ObserveSlowOpsBoard.tsx";
import { ObserveSnifferStrip } from "../src/renderer/components/observe/ObserveSnifferStrip.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

// Fixed measurements from the retained conn-log: at is handler start, not completion.
const records = [
  {
    method: "repo.agentRuntime.sessions.await",
    at: "2026-10-07T06:22:54.298Z",
    durationMs: 1067342,
    code: "provider_exit",
  },
  { method: "repo.task.run", at: "2026-10-07T06:41:25.396Z", durationMs: 22049 },
  { method: "repo.task.run", at: "2026-10-07T06:45:16.203Z", durationMs: 12023 },
];
function statsFor(items: readonly Record<string, unknown>[]) {
  const state = new ObserveStatsState();
  items.forEach((record, seq) => state.ingest(observeLogRow({ ok: true, ...record }, seq)));
  return state.snapshot();
}

describe("等待耗时与执行耗时", () => {
  it("长 await 不占执行排行或分位；真实慢 run 和原始耗时保留", () => {
    const stats = statsFor(records);
    expect(stats.maxMs).toBe(22049);
    expect(stats.p50Ms).toBe(12023);
    expect(stats.ops.map((op) => op.method)).toEqual(["repo.task.run"]);
    expect(observeLogRow(records[0]!, 0).durationMs).toBe(1067342);
    expect(stats.waits[0]).toMatchObject({ method: records[0]!.method, maxMs: 1067342, count: 1 });
  });

  it.each(["zh-CN", "en-US"] as const)("%s: 等待单独可查，慢写不被宣称为锁异常", (locale) => {
    setActiveLocale(locale);
    const stats = statsFor(records);
    const board = renderToStaticMarkup(
      createElement(ObserveSlowOpsBoard, { testId: "slow", stats, onFocusMethod: () => {} }),
    );
    expect(board).toContain("repo.task.run");
    expect(board).toContain("repo.agentRuntime.sessions.await");
    expect(board).toContain(locale === "zh-CN" ? "等待耗时" : "Wait duration");
    const strip = renderToStaticMarkup(
      createElement(ObserveSnifferStrip, {
        testId: "sniff",
        stats,
        window: "1h",
        isLogPane: true,
        onFocusSmell: () => {},
      }),
    );
    expect(strip).toContain(locale === "zh-CN" ? "慢写请求" : "Slow write request");
    expect(strip).not.toMatch(/慢锁|锁争用|Contended|Lock holder/);
  });

  it("等待失败仍计入异常，截图中的七条失败按真实错误码聚类", () => {
    const codes = [
      ...Array(4).fill("execution_credential_rejected"),
      ...Array(2).fill("unsupported_command"),
      "runtime_instance_disabled",
    ];
    const stats = statsFor(codes.map((code) => ({ ...records[0], ok: false, code })));
    expect(stats.anomalies).toBe(7);
    expect(stats.clusters.map((cluster) => cluster.count)).toEqual([4, 2, 1]);
    expect(stats.ops).toEqual([]);
    expect(stats.waits[0]!.count).toBe(7);
    expect(stats.volumes[0]!.count).toBe(7);
    expect(stats.lens.methods[0]!.value).toBe("repo.agentRuntime.sessions.await");
    expect(stats.windows["1h"].smells.map((smell) => smell.kind)).toEqual(["spike_failures"]);
  });

  it("attach 测量订阅建立，单独标注并保留慢建立异常", () => {
    setActiveLocale("zh-CN");
    const stats = statsFor([{ method: "repo.agentRuntime.attach", durationMs: 2000 }]);
    expect(stats.maxMs).toBe(2000);
    expect(stats.waits).toEqual([]);
    const board = renderToStaticMarkup(
      createElement(ObserveSlowOpsBoard, { testId: "slow", stats, onFocusMethod: () => {} }),
    );
    expect(board).toContain("订阅建立耗时");
    expect(board).toContain("text-status-blocked");
  });

  it("只有长 await 时执行排行为空，等待仍可见且无慢写告警", () => {
    setActiveLocale("zh-CN");
    const stats = statsFor(records.slice(0, 1));
    expect(stats.maxMs).toBeNull();
    expect(stats.windows["1h"].smells).toEqual([]);
    const board = renderToStaticMarkup(
      createElement(ObserveSlowOpsBoard, { testId: "slow", stats, onFocusMethod: () => {} }),
    );
    expect(board).toContain("repo.agentRuntime.sessions.await");
    expect(board).not.toContain("text-status-blocked");
  });
});
