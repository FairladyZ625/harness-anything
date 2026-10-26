import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { workTopologyGraphOf, workTopologySummaryOf } from "../src/renderer/graph/workTopology.ts";
import type { WorkTopologyRead } from "../src/api/renderer-dto.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";

/**
 * dec_17A863CC CH3:工作页 Graph tab 与全局关系图共用同一套画布组件,只预设 work scope;
 * 拓扑状态层全部取自 daemon `repo.work.topology.read`,GUI 不自算(RJ3)。
 *
 * 这个文件钉两件事:
 *   1. 适配层是纯搬运 —— 状态词/前沿/关键路径位置逐格等于 daemon 返回值,成员行不丢台账字段;
 *   2. 没有第二张画布 —— 全仓只有一个 `EgoNeighborhood` 宿主组件,工作页专用拓扑渲染已删除。
 */

const task = (taskId: string, parentTaskId?: string): TaskRow =>
  ({
    taskId,
    title: `任务 ${taskId}`,
    projectId: "proj",
    coordinationStatus: "planned",
    rawStatus: "planned",
    ...(parentTaskId ? { parentTaskId } : {}),
  }) as TaskRow;

/** daemon 侧的真实形状:ready 前沿在 root,member 被外部边界阻塞,关键路径 root→member。 */
const topology: WorkTopologyRead = {
  schema: "daemon.work-topology/v1",
  ok: true,
  status: "ready",
  workRootTaskId: "root",
  members: [
    {
      taskId: "root",
      title: "任务 root",
      canonicalStatus: "active",
      topologyState: "in-flight",
      parentTaskId: null,
      pinned: false,
      boundary: false,
      blockers: [],
      warnings: [],
    },
    {
      taskId: "member",
      title: "任务 member",
      canonicalStatus: "planned",
      topologyState: "blocked",
      parentTaskId: "root",
      pinned: false,
      boundary: false,
      blockers: [
        { relationId: "rel-member-boundary", kind: "depends-on", sourceTaskId: "member", targetTaskId: "boundary" },
      ],
      warnings: [],
    },
  ],
  boundaryTasks: [
    {
      taskId: "boundary",
      title: "任务 boundary",
      canonicalStatus: "planned",
      topologyState: "boundary",
      parentTaskId: null,
      pinned: false,
      boundary: true,
      blockers: [],
      warnings: [],
    },
  ],
  edges: [
    {
      relationId: "rel-member-boundary",
      from: "task/member",
      to: "task/boundary",
      kind: "depends-on",
      direction: "directed",
      state: "active",
      rationale: "must ship first",
    },
  ],
  frontier: ["root"],
  criticalPath: ["root", "member"],
  completeness: "complete",
  warnings: [],
  watermark: 7,
  sourceRevision: 5,
};

describe("work graph reuses the global relation canvas", () => {
  it("carries the daemon topology marks onto the shared canvas rows verbatim", () => {
    const graph = workTopologyGraphOf(topology, [
      task("root"),
      task("member", "root"),
      task("boundary"),
      task("outside"),
    ]);
    // work scope = 成员 + 一跳外部边界;范围外的 task 不进工作图。
    expect(graph.tasks.map(({ taskId }) => taskId).sort()).toEqual(["boundary", "member", "root"]);
    expect(graph.missingTaskIds).toEqual([]);
    // 状态词、前沿、关键路径位置逐格来自 daemon,不是 GUI 从状态/边推的(RJ3)。
    const marks = Object.fromEntries(
      graph.tasks.map((row) => [
        row.taskId,
        {
          state: row.topologyState,
          frontier: row.topologyFrontier === true,
          position: row.topologyCriticalPathPosition,
        },
      ]),
    );
    expect(marks).toEqual({
      root: { state: "in-flight", frontier: true, position: 1 },
      member: { state: "blocked", frontier: false, position: 2 },
      boundary: { state: "boundary", frontier: false, position: undefined },
    });
    // 只有 daemon 返回的 depends-on 边;成员范围的边不在这里被补出一条。
    expect(graph.relations.map(({ from, to, kind }) => `${from}->${to}:${kind}`)).toEqual([
      "task/member->task/boundary:depends-on",
    ]);
    // 成员行仍带台账字段(卡片正文/详情链接要读它们),拓扑标记只是叠加。
    expect(graph.tasks.find(({ taskId }) => taskId === "member")?.coordinationStatus).toBe("planned");
    expect(graph.tasks.find(({ taskId }) => taskId === "member")?.parentTaskId).toBe("root");
  });

  it("reports members the task projection has not served instead of inventing rows", () => {
    const graph = workTopologyGraphOf(topology, [task("root")]);
    expect(graph.tasks.map(({ taskId }) => taskId)).toEqual(["root"]);
    expect(graph.missingTaskIds.sort()).toEqual(["boundary", "member"]);
  });

  it("summarises only daemon-published counts, including an absent critical path", () => {
    const summary = workTopologySummaryOf(topology);
    expect(summary).toMatchObject({
      members: 2,
      boundary: 1,
      frontier: 1,
      inFlight: 1,
      blocked: 1,
      awaitingRuling: 0,
      criticalPathTasks: 2,
      revision: 5,
      completeness: "complete",
    });
    // daemon 给不出路径(环/缺端点/截断)时保持 null,不编一条。
    expect(workTopologySummaryOf({ ...topology, criticalPath: null }).criticalPathTasks).toBeNull();
    expect(workTopologySummaryOf({ ...topology, warnings: ["cycle"], completeness: "partial" })).toMatchObject({
      completeness: "partial",
      warnings: ["cycle"],
    });
  });
});

describe("one canvas implementation only", () => {
  const renderer = path.join(import.meta.dirname, "../src/renderer");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith(".tsx") || full.endsWith(".ts") ? [full] : [];
    });
  const sources = walk(renderer).map((file) => ({ file, body: readFileSync(file, "utf8") }));

  it("mounts the page canvas host in exactly one component", () => {
    // 页面级画布宿主只有 RelationCanvas;详情页的嵌入式邻域(EntityDetailView)是同一个
    // EgoNeighborhood 的另一种使用形态,不是第二张页面画布。
    const hosts = sources
      .filter(({ body }) => /<EgoNeighborhood\b/u.test(body))
      .map(({ file }) => path.relative(renderer, file))
      .sort();
    expect(hosts).toEqual([path.join("graph", "RelationCanvas.tsx"), path.join("views", "EntityDetailView.tsx")]);
    const pageHosts = sources
      .filter(({ body }) => /<RelationCanvas\b/u.test(body))
      .map(({ file }) => path.relative(renderer, file))
      .sort();
    expect(pageHosts).toEqual([path.join("views", "GraphView.tsx"), path.join("views/workspace", "WorkGraphTab.tsx")]);
  });

  it("keeps the work tab and the global page on that same host", () => {
    const workTab = readFileSync(path.join(renderer, "views/workspace/WorkGraphTab.tsx"), "utf8"),
      globalPage = readFileSync(path.join(renderer, "views/GraphView.tsx"), "utf8");
    for (const body of [workTab, globalPage]) {
      expect(body).toContain("graph/RelationCanvas");
      expect(body).toContain("<RelationCanvas");
    }
    // work 页预设 scope=work,全局页 scope=global;这是两者唯一的范围差异。
    expect(workTab).toContain('scope="work"');
    expect(globalPage).toContain('scope="global"');
  });

  it("has no residual work-only topology renderer", () => {
    const offenders = sources
      .filter(({ body }) => /topologyNodeToTaskRow|workspaceGraphSlice|topologyOnly/u.test(body))
      .map(({ file }) => path.relative(renderer, file));
    expect(offenders).toEqual([]);
  });

  it("keeps the renderer free of client-side ready/blocked decisions", () => {
    const workTab = readFileSync(path.join(renderer, "views/workspace/WorkGraphTab.tsx"), "utf8");
    // 状态层只读 daemon 字段;出现 blockingOf / 自行遍历前置边判可开工就是 RJ3 违规。
    expect(workTab).not.toMatch(/blockingOf|isReady|readyTasks|frontierOf/u);
    expect(workTab).toContain("workTopologySummaryOf");
  });
});
