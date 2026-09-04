// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  applyObserveTailPage,
  applyObserveViewing,
  filterObserveRowsLog,
  initialObserveTail,
} from "../src/renderer/daemon-observe-model.ts";
import type { ObserveTailRead } from "../src/api/renderer-dto.ts";

/**
 * follow 数据路径的每页工作量与累计行数解耦(task_643b8b46 复核 finding 的回归判据):
 *  - 500 页 follow(其中 400 页空页)作用在 6,400 行已累计的基础上,空页快照必须原样
 *    返回(引用相等:不产生新数组、setSnapshot 同引用不触发重渲染),非空页行容器
 *    原样复用(引用相等:合并路径不整数组复制),事件去重走增量 key 索引而非整表重建 Set;
 *  - history 前插同样不换容器,157 页级联翻页不再二次方累计;
 *  - 查询过滤增量续用:同一 query 只扫两端新增行,结果容器跨快照复用。
 * 判定依据是引用相等(结构性、不受 CI 抖动影响);耗时数字是数量级证据,进任务包报告。
 * 阴性对照:把合并路径改回整数组复制(`[...rows, ...fresh]` 重建),引用相等断言必须红。
 */

const REPO_ID = "follow-cost",
  AT = "2026-09-05T00:00:00.000Z",
  SEED_PAGES = 100,
  SEED_WIDTH = 64,
  FOLLOW_PAGES = 500,
  FOLLOW_WIDTH = 8,
  LIVE_REVISION = SEED_PAGES * SEED_WIDTH;

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function eventItem(revision: number, title: string) {
  return {
    schema: "task-event/v1",
    eventId: `ev-cost-${revision}`,
    workspaceRevision: revision,
    opId: "op-cost",
    type: "task_created",
    actor: { kind: "agent", id: "agent_cost" },
    source: { channel: "cli" },
    occurredAt: AT,
    taskId: `task_${revision}`,
    payload: { task: { title } },
  };
}

function eventPage(revisions: readonly number[], direction: "history" | "follow", done: boolean): ObserveTailRead {
  return {
    schema: "daemon.observe-tail/v3",
    ok: true,
    repoId: REPO_ID,
    mode: "local",
    kind: "events",
    direction,
    status: "ready",
    items: revisions.map((revision) => eventItem(revision, `row-${revision}`)) as never,
    historyCursor:
      direction === "history" && revisions.length > 0 ? { kind: "events", revision: Math.min(...revisions) } : null,
    liveCursor: { kind: "events", revision: LIVE_REVISION },
    sourceCursor: { kind: "events", revision: LIVE_REVISION },
    done,
  };
}

function logPage(count: number, direction: "history" | "follow", done: boolean, baseOffset: number): ObserveTailRead {
  return {
    schema: "daemon.observe-tail/v3",
    ok: true,
    repoId: REPO_ID,
    mode: "local",
    kind: "repo-log",
    direction,
    status: "ready",
    items: Array.from({ length: count }, (_, index) => ({
      schema: "daemon-request-log/v1",
      at: AT,
      method: "repo.tasks.list",
      event: "request",
      ok: true,
      durationMs: index,
    })) as never,
    historyCursor:
      direction === "history" && count > 0 ? { kind: "repo-log", fileId: "f-cost", offset: baseOffset } : null,
    liveCursor: { kind: "repo-log", fileId: "f-cost", offset: baseOffset },
    sourceCursor: { kind: "repo-log", fileId: "f-cost", offset: baseOffset },
    done,
  };
}

/** 100 页 × 64 行 history 预载(6,400 行已加载,超过 OBSERVE_FOLLOW_ROW_LIMIT 之外的历史量级)。 */
function seedEvents(pages: number): ReturnType<typeof initialObserveTail> {
  let state = initialObserveTail();
  for (let page = 0; page < pages; page += 1) {
    const from = page * SEED_WIDTH + 1;
    state = applyObserveTailPage(state, eventPage(range(from, from + SEED_WIDTH - 1), "history", false));
  }
  return state;
}

describe("follow 数据路径:每页工作量不随累计行数增长", () => {
  it("events:500 页 follow(400 页空页)不重建行容器,空页快照原样返回", () => {
    let state = seedEvents(SEED_PAGES);
    expect(state.rows).toHaveLength(SEED_PAGES * SEED_WIDTH);
    // follow 追加超过 OBSERVE_FOLLOW_ROW_LIMIT 后贴底封顶丢最旧端:最终行数回到上限。
    const sameRows: boolean[] = [],
      emptyPageKeptSnapshot: boolean[] = [],
      growthPageNewSnapshot: boolean[] = [];
    let revision = LIVE_REVISION;
    const followStarted = performance.now(),
      pageCosts: number[] = [];
    for (let page = 0; page < FOLLOW_PAGES; page += 1) {
      const before = state,
        pageStarted = performance.now();
      if (page % 5 === 0) {
        state = applyObserveTailPage(state, eventPage(range(revision + 1, revision + FOLLOW_WIDTH), "follow", true));
        revision += FOLLOW_WIDTH;
        growthPageNewSnapshot.push(state !== before);
      } else {
        state = applyObserveTailPage(state, eventPage([], "follow", true));
        emptyPageKeptSnapshot.push(state === before);
      }
      sameRows.push(state.rows === before.rows);
      pageCosts.push(performance.now() - pageStarted);
    }
    const followMs = performance.now() - followStarted,
      worstPage = Math.max(...pageCosts);
    console.info(
      `[perf] events follow: ${FOLLOW_PAGES} pages (${FOLLOW_PAGES / 5} x ${FOLLOW_WIDTH} rows +` +
        ` ${FOLLOW_PAGES - FOLLOW_PAGES / 5} empty) over ${SEED_PAGES * SEED_WIDTH} loaded rows` +
        ` | total ${followMs.toFixed(1)}ms | worst page ${worstPage.toFixed(3)}ms`,
    );
    expect(sameRows.every(Boolean)).toBe(true);
    expect(emptyPageKeptSnapshot).toHaveLength(FOLLOW_PAGES - FOLLOW_PAGES / 5);
    expect(emptyPageKeptSnapshot.every(Boolean)).toBe(true);
    expect(growthPageNewSnapshot.every(Boolean)).toBe(true);
    expect(state.rows).toHaveLength(5_000);
  });

  it("repo-log:日志合并路径同样不整数组复制", () => {
    let state = initialObserveTail(),
      offset = 0;
    for (let page = 0; page < SEED_PAGES; page += 1) {
      offset += SEED_WIDTH * 88;
      state = applyObserveTailPage(state, logPage(SEED_WIDTH, "history", false, offset));
    }
    expect(state.rows).toHaveLength(SEED_PAGES * SEED_WIDTH);
    const sameRows: boolean[] = [],
      emptyPageKeptSnapshot: boolean[] = [];
    for (let page = 0; page < FOLLOW_PAGES; page += 1) {
      const before = state;
      if (page % 5 === 0) {
        offset += FOLLOW_WIDTH * 88;
        state = applyObserveTailPage(state, logPage(FOLLOW_WIDTH, "follow", true, offset));
      } else {
        state = applyObserveTailPage(state, logPage(0, "follow", true, offset));
        emptyPageKeptSnapshot.push(state === before);
      }
      sameRows.push(state.rows === before.rows);
    }
    expect(sameRows.every(Boolean)).toBe(true);
    expect(emptyPageKeptSnapshot.every(Boolean)).toBe(true);
    expect(state.rows).toHaveLength(5_000);
  });

  it("空 follow 页的每页耗时随累计行数走平(数量级证据,判定靠上面的引用相等)", () => {
    const averages: number[] = [],
      sizes: number[] = [];
    for (const pages of [16, 50, 100]) {
      // 浏览历史视角(viewing: history):follow 增长不触发贴底封顶,行数可越过上限继续累计。
      let state = applyObserveViewing(seedEvents(pages), "history");
      const revision = pages * SEED_WIDTH;
      // 先一页非空 follow 把 caughtUp 置稳,空页才可能原样返回。
      state = applyObserveTailPage(state, eventPage(range(revision + 1, revision + 4), "follow", true));
      const started = performance.now();
      for (let page = 0; page < 100; page += 1) state = applyObserveTailPage(state, eventPage([], "follow", true));
      averages.push((performance.now() - started) / 100);
      sizes.push(state.rows.length);
    }
    console.info(
      `[perf] empty follow page avg @1k/3.2k/6.4k rows: ` + averages.map((ms) => `${ms.toFixed(4)}ms`).join(" / "),
    );
    expect(sizes).toEqual([1_028, 3_204, 6_404]);
    // 宽上界:只防灾难级回归(整表扫描/复制),不追精确耗时。
    expect(averages[2]).toBeLessThan(5);
  });
});

describe("查询过滤:增量续用,只扫新增行", () => {
  function titledPage(revisions: readonly number[], direction: "history" | "follow", done: boolean): ObserveTailRead {
    return {
      ...eventPage(revisions, direction, done),
      items: revisions.map((revision, index) =>
        eventItem(revision, `${index % 2 === 0 ? "hit-cost" : "miss-cost"}-${revision}`),
      ) as never,
    };
  }

  it("同一 query 下追加/前插只匹配新增行,结果容器复用;换 query 全量重建", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(state, titledPage(range(1, 64), "history", false));
    state = applyObserveTailPage(state, titledPage(range(65, 128), "history", false));
    const first = filterObserveRowsLog(state.rows, "hit-cost", null);
    expect(first.result.length).toBe(64);
    state = applyObserveTailPage(state, titledPage(range(129, 136), "follow", true));
    const appended = filterObserveRowsLog(state.rows, "hit-cost", first);
    expect(appended.result).toBe(first.result);
    expect(appended.result.length).toBe(68);
    state = applyObserveTailPage(state, titledPage(range(-8, -1), "history", false));
    const prepended = filterObserveRowsLog(state.rows, "hit-cost", appended);
    expect(prepended.result).toBe(first.result);
    expect(prepended.result.length).toBe(72);
    const requery = filterObserveRowsLog(state.rows, "miss-cost", prepended);
    expect(requery.result).not.toBe(first.result);
    expect(requery.result.length).toBe(72);
    const unfiltered = filterObserveRowsLog(state.rows, "", requery);
    expect(unfiltered.result).toBe(state.rows);
  });

  it("行集被贴底封顶裁剪后过滤缓存作废重建", () => {
    let state = initialObserveTail();
    for (let page = 0; page < 78; page += 1)
      state = applyObserveTailPage(state, titledPage(range(page * 64 + 1, page * 64 + 64), "history", false));
    state = applyObserveTailPage(state, titledPage(range(4_993, 5_000), "history", false));
    const atCap = filterObserveRowsLog(state.rows, "hit-cost", null);
    expect(atCap.result.length).toBe(2_500);
    state = applyObserveTailPage(state, titledPage(range(5_001, 5_008), "follow", true));
    expect(state.rows.length).toBe(5_000);
    const afterDrop = filterObserveRowsLog(state.rows, "hit-cost", atCap);
    expect(afterDrop.result).not.toBe(atCap.result);
    expect(afterDrop.result.length).toBe(2_500);
  });
});
