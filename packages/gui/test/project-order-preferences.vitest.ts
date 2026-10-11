// harness-test-tier: fast
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  emptyProjectOrder,
  orderProjects,
  readProjectOrder,
  toggleProjectPin,
  writeProjectOrder,
} from "../src/renderer/project-order-preferences.ts";

/** 项目置顶顺序偏好(业主 2026-10-11):localStorage 单观看者偏好,不进台账。 */

function shim() {
  const storage = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
    dump: () => [...storage.entries()],
  };
}

describe("project-order-preferences", () => {
  it("空/坏存储回退空偏好,不抛错", () => {
    const { storage } = shim();
    expect(readProjectOrder(storage)).toEqual(emptyProjectOrder);
    storage.setItem("harness:gui:project-order", "{not json");
    expect(readProjectOrder(storage)).toEqual(emptyProjectOrder);
    storage.setItem("harness:gui:project-order", JSON.stringify({ pinned: ["a", 3, null, "b"] }));
    expect(readProjectOrder(storage)).toEqual({ pinned: ["a", "b"] });
  });

  it("置顶追加尾部、取消移除;读写走 harness:gui:project-order 键", () => {
    const { storage, dump } = shim();
    let prefs = emptyProjectOrder;
    prefs = toggleProjectPin(prefs, "b");
    prefs = toggleProjectPin(prefs, "a");
    expect(prefs.pinned).toEqual(["b", "a"]);
    prefs = toggleProjectPin(prefs, "b");
    expect(prefs.pinned).toEqual(["a"]);
    writeProjectOrder(storage, prefs);
    expect(dump()).toEqual([["harness:gui:project-order", JSON.stringify({ pinned: ["a"] })]]);
    expect(readProjectOrder(storage)).toEqual({ pinned: ["a"] });
  });

  it("orderProjects:置顶按置顶顺序在前,其余保持传入顺序(稳定划分)", () => {
    const repos = [{ repoId: "x" }, { repoId: "p1" }, { repoId: "y" }, { repoId: "p2" }, { repoId: "z" }];
    expect(orderProjects(repos, ["p2", "p1"]).map(({ repoId }) => repoId)).toEqual(["p2", "p1", "x", "y", "z"]);
    // 已不存在的置顶 id 不产生幽灵行。
    expect(orderProjects(repos, ["gone", "p1"])).toHaveLength(5);
  });
});
