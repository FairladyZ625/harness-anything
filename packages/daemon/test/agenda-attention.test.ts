// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { attentionScore, attentionRegionWeights, compareAttention } from "../src/agenda-attention.ts";

test("attention score reports every contribution and applies caps", () => {
  const scored = attentionScore({
    kind: "awaiting-you",
    since: "2026-09-27T00:00:00.000Z",
    now: "2026-09-29T12:00:00.000Z",
    risk: "high",
    downstreamBlocked: 8,
    pinned: true,
  });
  assert.equal(scored.score, 270);
  assert.deepEqual(scored.reasons, [
    { label: "等你答复", contribution: 100 },
    { label: "高风险 ×1.5", contribution: 50 },
    { label: "阻塞 8 个下游任务（最多计 5 个）", contribution: 60 },
    { label: "已等待 60 小时（对数增长，封顶 40）", contribution: 40 },
    { label: "已置顶", contribution: 20 },
  ]);
});

test("blocked and stalled age by day, archived items do not gain waiting points", () => {
  assert.deepEqual(
    attentionScore({
      kind: "stalled",
      since: "2026-09-01T00:00:00.000Z",
      now: "2026-09-29T12:00:00.000Z",
      risk: "low",
      downstreamBlocked: 0,
      pinned: false,
    }),
    {
      score: 60,
      reasons: [
        { label: "进行中停滞", contribution: 40 },
        { label: "29 天无活动（每天 +2，封顶 20）", contribution: 20 },
      ],
    },
  );
  assert.equal(
    attentionScore({
      kind: "archive",
      since: "2020-01-01T00:00:00.000Z",
      now: "2026-09-29T12:00:00.000Z",
      risk: "low",
      downstreamBlocked: 0,
      pinned: false,
    }).score,
    5,
  );
});

test("attention ordering is stable and region weights use the same scores", () => {
  const rows = [
    { ref: "task/b", region: "mine" as const, attention: { score: 70, reasons: [] } },
    { ref: "task/a", region: "mine" as const, attention: { score: 70, reasons: [] } },
    { ref: "task/c", region: "stuck" as const, attention: { score: 45, reasons: [] } },
  ].sort(compareAttention);
  assert.deepEqual(
    rows.map(({ ref }) => ref),
    ["task/a", "task/b", "task/c"],
  );
  const weights = attentionRegionWeights(rows, { running: 2, review: 1, queue: 3, worksNeedingAttention: 4 });
  assert.deepEqual(weights, { mine: 16, stuck: 4, run: 8, review: 5, queue: 3.5, recent: 4, works: 11.2 });
});
