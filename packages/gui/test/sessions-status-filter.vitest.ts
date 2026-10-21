// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { agentRuntimeSessionGroupStatusWords } from "@harness-anything/daemon/protocol";
import {
  sessionStatusBucketOf,
  sessionStatusFilterWords,
  sessionStatusesInBucket,
} from "../src/renderer/sessions-model.ts";

// 状态筛选收成 运行中/成功/失败/全部(业主 2026-10-21 13:50 定案):内部状态词只经
// sessions-model 的唯一映射折算成四档,映射缺位或档词不对都在这里红。
describe("session status filter buckets", () => {
  it("offers exactly the four fixed filters in a stable order", () => {
    expect(sessionStatusFilterWords).toEqual(["running", "succeeded", "failed", "all"]);
  });

  it("maps every daemon status word into a bucket; the mapping stays exhaustive", () => {
    // Record 的键集必须与 daemon 词表同集:daemon 新增状态词而映射漏配时,
    // 类型层 Record<SessionStatus,…> 编译红,这里以运行期同断言兜底。
    expect(Object.keys(sessionStatusBucketOf).sort()).toEqual([...agentRuntimeSessionGroupStatusWords].sort());
    for (const word of agentRuntimeSessionGroupStatusWords) {
      expect(Object.values(sessionStatusBucketOf)).toContain(sessionStatusBucketOf[word]);
    }
  });

  it("derives each bucket's daemon read words in daemon vocabulary order", () => {
    // 运行中 = 在飞 + 受阻等人裁决(等的是人的决定,不是结局)。
    expect(sessionStatusesInBucket("running")).toEqual(["running", "blocked"]);
    expect(sessionStatusesInBucket("succeeded")).toEqual(["succeeded"]);
    // 失败 = 结束但没做成:失败、失联、取消、停手、无法判定、不可用、未知。
    expect(sessionStatusesInBucket("failed")).toEqual([
      "failed",
      "cancelled",
      "stopped",
      "ended-indeterminate",
      "unavailable",
      "unknown",
      "lost",
    ]);
    // 全部 = 不筛。
    expect(sessionStatusesInBucket("all")).toEqual([]);
  });

  it("keeps every bucket non-empty so no filter is a dead control", () => {
    for (const bucket of ["running", "succeeded", "failed"] as const)
      expect(sessionStatusesInBucket(bucket).length).toBeGreaterThan(0);
  });
});
