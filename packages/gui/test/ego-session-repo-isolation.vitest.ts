// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EgoNeighborhood } from "../src/renderer/graph/EgoNeighborhood.tsx";
import { clearEgoSession } from "../src/renderer/graph/egoSession.ts";
import type { TaskRow, DecisionRow, RelationEdge } from "../src/renderer/model/types";
import { decisionProjectionFields } from "./decision-projection-fields.ts";

/**
 * egoSession 的仓归属隔离(CEO 返修 2026-10-02,task_baca8e2b3e32c288fbd14b71f0):
 * ref 只在仓内唯一,两个项目可以有完全相同的 `decision/d1`;会话槽按 repoId 归属,
 * 跨项目绝不互读,同项目的详情往返(卸载 → 重挂)仍原样接续。
 * 断言全部走组件行为(卡片/chip 的 DOM 形态),不做纯模块结构断言。
 */

function task(taskId: string, title: string): TaskRow {
  return {
    taskId,
    title,
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    lastKnownAt: "2026-08-01T00:00:00.000Z",
    gates: [],
    docs: [],
  };
}

function decision(decisionId: string): DecisionRow {
  return {
    decisionId,
    title: `决策 ${decisionId}`,
    state: "proposed",
    question: "Q?",
    chosen: [],
    rejected: [],
    claims: [],
    proposedAt: "2026-08-01T00:00:00.000Z",
    ...decisionProjectionFields("proposed"),
  } as DecisionRow;
}

// 两个仓用完全同名的实体(支持用法,不是低频豁免):d1 → t1 → t2 → t3,t2 再引出 t4。
const fixtures = () => ({
  tasks: [task("t1", "任务一"), task("t2", "任务二"), task("t3", "任务三"), task("t4", "任务四")],
  decisions: [decision("d1")],
  relations: [
    { from: "decision/d1", to: "task/t1", kind: "derives", provenance: "local-document" },
    { from: "task/t1", to: "task/t2", kind: "depends-on", provenance: "local-document" },
    { from: "task/t1", to: "task/t3", kind: "blocks", provenance: "local-document" },
    { from: "task/t2", to: "task/t4", kind: "depends-on", provenance: "local-document" },
  ] as RelationEdge[],
});

async function mount(repoId: string) {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  const data = fixtures();
  await act(async () => {
    root.render(
      createElement(EgoNeighborhood, {
        repoId,
        focusRef: "decision/d1",
        hops: { up: 1, down: 1 },
        tasks: data.tasks,
        decisions: data.decisions,
        facts: [],
        relations: data.relations,
        factAnchors: [],
      } as Parameters<typeof EgoNeighborhood>[0]),
    );
  });
  return { div, root: root as Root };
}

const unmount = async (root: Root) => {
  await act(async () => {
    root.unmount();
  });
};

function cardOf(div: HTMLElement, text: string) {
  return [...div.querySelectorAll<HTMLElement>("[data-testid='ego-card']")].find((c) => c.textContent?.includes(text));
}

function chipOf(div: HTMLElement, text: string) {
  return [...div.querySelectorAll<HTMLElement>("[data-testid='ego-chip']")].find((c) => c.textContent?.includes(text));
}

function click(node: HTMLElement) {
  return act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  clearEgoSession();
});

describe("egoSession repo isolation (CEO rework)", () => {
  it("两个项目相同 ref 不互读:repo-b 的新探索不接续 repo-a 的会话", async () => {
    // repo-a 探索:展开 t1(原位成卡)。
    const a1 = await mount("repo-a");
    await click(chipOf(a1.div, "任务一")!);
    expect(cardOf(a1.div, "任务一")).toBeTruthy();
    await unmount(a1.root);

    // repo-b 同名 ref 挂载:必须是全新探索 —— t1 回到 chip,不接续 repo-a 的展开。
    const b1 = await mount("repo-b");
    expect(cardOf(b1.div, "决策 d1")).toBeTruthy();
    expect(cardOf(b1.div, "任务一")).toBeFalsy();
    expect(chipOf(b1.div, "任务一")).toBeTruthy();

    // repo-b 自己的探索正常落会话(隔离不是坏仓内功能):先长出 t2 再展开它……
    await click(chipOf(b1.div, "任务一")!);
    await click(chipOf(b1.div, "任务二")!);
    expect(cardOf(b1.div, "任务二")).toBeTruthy();
    await unmount(b1.root);

    // ……而回到 repo-a 也不能捡到 repo-b 的会话(单槽只保留当前仓):t1 未展开,
    // 1 跳预算下 t2/t4 都不在画布 —— repo-b 里长出的探索没有残留。
    const a2 = await mount("repo-a");
    expect(cardOf(a2.div, "任务一")).toBeFalsy();
    expect(chipOf(a2.div, "任务一")).toBeTruthy();
    expect(a2.div.textContent).not.toContain("任务二");
    expect(a2.div.textContent).not.toContain("任务四");
    await unmount(a2.root);
  });

  it("同项目详情往返仍恢复:已展开卡与已长出邻居原样接续", async () => {
    // 探索:展开 t1 → 再展开 t2(t4 在预算外,靠展开长出)。
    const first = await mount("repo-a");
    await click(chipOf(first.div, "任务一")!);
    await click(chipOf(first.div, "任务二")!);
    expect(cardOf(first.div, "任务一")).toBeTruthy();
    expect(cardOf(first.div, "任务二")).toBeTruthy();
    expect(chipOf(first.div, "任务四")).toBeTruthy();
    await unmount(first.root);

    // 详情页往返 = 卸载后同仓同焦点重挂:焦点卡、已展开卡、已长出邻居全部恢复。
    const back = await mount("repo-a");
    expect(cardOf(back.div, "决策 d1")).toBeTruthy();
    expect(cardOf(back.div, "任务一")).toBeTruthy();
    expect(cardOf(back.div, "任务二")).toBeTruthy();
    expect(chipOf(back.div, "任务四")).toBeTruthy();
    await unmount(back.root);
  });
});
