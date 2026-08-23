// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { entityDetailTargetOf } from "../src/renderer/navigation/entityRoutes.ts";
import {
  createViewHistory,
  currentLocation,
  canGoBack,
  goBack,
  pushLocation,
  type AppLocation,
} from "../src/renderer/navigation/viewHistory.ts";
import {
  initialLocation,
  readViewHistory,
  writeViewHistory,
} from "../src/renderer/navigation/viewHistoryStorage.ts";

/**
 * W4 可寻址路由:decision/fact 打开各自的详情页,不再落列表页;
 * 新视图进入导航历史栈并可原路返回、可持久化。
 */

function loc(patch: Partial<AppLocation>): AppLocation {
  return { ...initialLocation(), ...patch };
}

describe("entity detail target routing (W4)", () => {
  it("routes decision refs to the decision detail view", () => {
    expect(entityDetailTargetOf("decision/dec_1")).toEqual({
      view: "decisionDetail",
      focusedEntityRef: "decision/dec_1",
    });
    // 带后续路径段的引用(decision/<id>/<claimId>)仍路由到该 decision 的详情页。
    expect(entityDetailTargetOf("decision/dec_1/CH1")).toEqual({
      view: "decisionDetail",
      focusedEntityRef: "decision/dec_1",
    });
  });

  it("routes fact refs to the fact detail view, preserving the full anchor", () => {
    expect(entityDetailTargetOf("fact/task_a/F-001")).toEqual({
      view: "factDetail",
      focusedEntityRef: "fact/task_a/F-001",
    });
  });

  it("leaves task refs and malformed refs to their existing routes", () => {
    expect(entityDetailTargetOf("task/task_a")).toBeNull();
    expect(entityDetailTargetOf("decision/")).toBeNull();
    // repo/<repoId>/ 前缀由 App 层先剥再路由,本函数不负责。
    expect(entityDetailTargetOf("repo/r1/decision/dec_1")).toBeNull();
  });
});

describe("detail views in the view history stack (W4)", () => {
  it("pushes detail locations and restores them via back", () => {
    let state = createViewHistory(loc({ view: "graph", focusedEntityRef: "decision/dec_1" }));
    state = pushLocation(state, loc({ view: "factDetail", focusedEntityRef: "fact/task_a/F-001" }));
    state = pushLocation(state, loc({ view: "decisionDetail", focusedEntityRef: "decision/dec_2" }));
    expect(canGoBack(state)).toBe(true);
    state = goBack(state);
    expect(currentLocation(state)).toMatchObject({ view: "factDetail", focusedEntityRef: "fact/task_a/F-001" });
    state = goBack(state);
    expect(currentLocation(state)).toMatchObject({ view: "graph", focusedEntityRef: "decision/dec_1" });
  });

  it("persists and restores detail-view locations per project", () => {
    const storage = new Map<string, string>();
    const shim = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    };
    let state = createViewHistory(loc({ view: "overview" }));
    state = pushLocation(state, loc({ view: "decisionDetail", focusedEntityRef: "decision/dec_1" }));
    state = pushLocation(state, loc({ view: "factDetail", focusedEntityRef: "fact/task_a/F-001" }));
    writeViewHistory(shim, "proj-a", state);
    const restored = readViewHistory(shim, "proj-a");
    expect(currentLocation(restored)).toMatchObject({ view: "factDetail" });
    expect(canGoBack(restored)).toBe(true);
    // 详情视图跳转链可逐级回撤。
    expect(currentLocation(goBack(restored))).toMatchObject({ view: "decisionDetail" });
  });
});
