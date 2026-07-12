import { describe, expect, it } from "vitest";
import { computeGraphLayout, type LayoutInput } from "../src/renderer/graph/graphLayout.ts";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";
import { endpointToNodeId } from "../src/renderer/graph/endpoint.ts";

/**
 * 真实数据验证(dec_01KXA7811SVVT8P66HNDFZQ7DF CH1-CH5)。
 *
 * 数据快照取自 .harness/generated/triadic-graph/index.html (dec_mrczk07e,
 * HARNESS_ACTOR 决策,6 claim 混合覆盖)。本测试不读外部文件,把数据 inline,
 * 以便跑通时拥有与原型一致的"聚焦 decision → 三泳道 → claim 行 → coverage 灯"。
 */

const FOCUS_DECISION_ID = "dec_mrczk07e";

// decision/dec_mrczk07e + 6 claim (C1/C2/C3/C4/C5/CH1) + 混合覆盖。
const decision: DecisionRow = {
  decisionId: FOCUS_DECISION_ID,
  title: "环境变量不能作证人类在场:HARNESS_ACTOR 拒收 human",
  state: "active",
  riskTier: "high",
  urgency: "medium",
  question: "用户会本能地把 export HARNESS_ACTOR=human:alice 写进 shell profile…",
  chosen: [
    { id: "C1", text: "环境变量继承拒收 human", evidence: ["fact/task_01KX3PGD74EXEEV6DFM49ARDJ2/F-96WH7P98"] },
    { id: "C2", text: "agent 子进程会继承环境变量", evidence: ["fact/task_01KX2GZ3NTFARZ0WC39NXVT25K/F-PRTXCD0P"] },
    { id: "C3", text: "HARNESS_ACTOR 拒收 human", evidence: [] },
    { id: "C4", text: "人类归属走不可继承通道", evidence: ["fact/task_01KX2GZ3NTFARZ0WC39NXVT25K/F-PRTXCD0P"] },
    { id: "C5", text: "keychain 持有 credential", evidence: ["fact/task_01KX3PGD74EXEEV6DFM49ARDJ2/F-96WH7P98"] },
  ],
  rejected: [
    { id: "RJ1", text: "环境变量作证人类", evidence: [], whyNot: "进程继承可伪造" },
  ],
  claims: [
    { id: "C1", text: "环境变量继承拒收 human" },
    { id: "C2", text: "agent 子进程会继承环境变量" },
    { id: "C3", text: "HARNESS_ACTOR 拒收 human" },
    { id: "C4", text: "人类归属走不可继承通道" },
    { id: "C5", text: "keychain 持有 credential" },
    { id: "CH1", text: "整体策略" },
  ],
};

const lineageDecision: DecisionRow = {
  decisionId: "dec_mrd7jiux",
  title: "关联决策(松关联 RJ3)",
  state: "active",
  riskTier: "low",
  urgency: "low",
  question: "无关紧要",
  chosen: [{ id: "CH1", text: "x", evidence: [] }],
  rejected: [],
  claims: [{ id: "CH1", text: "x" }],
};

const tasks: TaskRow[] = [
  {
    taskId: "task_01KX2GZ3NTFARZ0WC39NXVT25K",
    title: "HARNESS_ACTOR 拒收 human:实现 + 测试",
    projectId: "p",
    coordinationStatus: "done",
    rawStatus: "done",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "passed",
    engine: "local",
    source: "local-document",
    module: "kernel",
    lastKnownAt: "2026-07-12",
    gates: [],
    docs: [],
  },
  {
    taskId: "task_01KX2GHMQDZ08J7X5CA7DTD9RT",
    title: "人类身份归属通道(keychain)",
    projectId: "p",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "incomplete",
    engine: "local",
    source: "local-document",
    module: "kernel",
    lastKnownAt: "2026-07-12",
    gates: [],
    docs: [],
  },
];

const facts: FactRef[] = [
  {
    anchor: "task_01KX3PGD74EXEEV6DFM49ARDJ2/F-96WH7P98",
    taskId: "task_01KX3PGD74EXEEV6DFM49ARDJ2",
    category: "finding",
    text: ".zshrc export 在 agent 子进程里被 getenv 读到",
    at: "2026-07-10",
    confidence: "high",
  },
  {
    anchor: "task_01KX2GZ3NTFARZ0WC39NXVT25K/F-PRTXCD0P",
    taskId: "task_01KX2GZ3NTFARZ0WC39NXVT25K",
    category: "progress",
    text: "HARNESS_ACTOR 拒收 human 单元测试通过",
    at: "2026-07-11",
    confidence: "high",
  },
];

// 边(按原型 axis 标注对齐):每条都带 claim 锚点。
const relations: RelationEdge[] = [
  // C1 evidence + derives
  { from: `decision/${FOCUS_DECISION_ID}/C1`, to: "fact/task_01KX3PGD74EXEEV6DFM49ARDJ2/F-96WH7P98", kind: "evidenced-by", provenance: "local-document" },
  { from: `decision/${FOCUS_DECISION_ID}/C1`, to: "task/task_01KX2GZ3NTFARZ0WC39NXVT25K", kind: "derives", provenance: "local-document" },
  // C2 evidence + derives
  { from: `decision/${FOCUS_DECISION_ID}/C2`, to: "fact/task_01KX2GZ3NTFARZ0WC39NXVT25K/F-PRTXCD0P", kind: "evidenced-by", provenance: "local-document" },
  { from: `decision/${FOCUS_DECISION_ID}/C2`, to: "task/task_01KX2GZ3NTFARZ0WC39NXVT25K", kind: "derives", provenance: "local-document" },
  // C3 derives only (uncovered)
  { from: `decision/${FOCUS_DECISION_ID}/C3`, to: "task/task_01KX2GZ3NTFARZ0WC39NXVT25K", kind: "derives", provenance: "local-document" },
  // C4 evidence + derives
  { from: `decision/${FOCUS_DECISION_ID}/C4`, to: "fact/task_01KX2GZ3NTFARZ0WC39NXVT25K/F-PRTXCD0P", kind: "evidenced-by", provenance: "local-document" },
  { from: `decision/${FOCUS_DECISION_ID}/C4`, to: "task/task_01KX2GZ3NTFARZ0WC39NXVT25K", kind: "derives", provenance: "local-document" },
  // C5 evidence
  { from: `decision/${FOCUS_DECISION_ID}/C5`, to: "fact/task_01KX3PGD74EXEEV6DFM49ARDJ2/F-96WH7P98", kind: "evidenced-by", provenance: "local-document" },
  // CH1 assoc
  { from: `decision/${FOCUS_DECISION_ID}/CH1`, to: "task/task_01KX2GHMQDZ08J7X5CA7DTD9RT", kind: "relates", provenance: "local-document" },
  // lineage: another decision linked via assoc (RJ3)
  { from: "decision/dec_mrd7jiux/RJ3", to: `decision/${FOCUS_DECISION_ID}`, kind: "relates", provenance: "local-document" },
];

function baseInput(overrides: Partial<LayoutInput> = {}): LayoutInput {
  return {
    tasks,
    relations,
    decisions: [decision, lineageDecision],
    facts,
    coverageRows: [],
    focusNodeId: `decision/${FOCUS_DECISION_ID}`,
    expandedFacts: new Set(),
    filters: {
      modules: new Set(["kernel"]),
      types: new Set(["decision", "task", "fact"]),
      axes: { authority: true, evidence: true, execution: true, assoc: false }, // relates 默认关
    },
    inLoopNodes: new Set(),
    inLoopEdges: new Set(),
    ...overrides,
  };
}

describe("computeGraphLayout: ego three-lane (dec_01KXA7811SVVT8P66HNDFZQ7DF)", () => {
  it("聚焦 dec_mrczk07e 展开为 6 条 claim 行,每行带 coverage 状态", async () => {
    const out = await computeGraphLayout(baseInput());
    expect(out.resolvedFocusId).toBe(`decision/${FOCUS_DECISION_ID}`);

    // 6 claim 行都应被计算
    // 修 #10 后:coverageRows 缺失时 Path B 只升级 unknown→covered,不再误降为
    // uncovered。C3/CH1 有 evidence 时是 covered,无 evidence 则保持 unknown
    // (灰,loading/缺数据),等 kernel coverageRows 到位再由 Path A 拍板。
    expect(out.focusClaims).toHaveLength(6);
    const byClaim = new Map(out.focusClaims.map((c) => [c.claimId, c.status]));
    expect(byClaim.get("C1")).toBe("covered");
    expect(byClaim.get("C2")).toBe("covered");
    expect(byClaim.get("C3")).toBe("unknown"); // 无 evidence + coverageRows 缺 → unknown
    expect(byClaim.get("C4")).toBe("covered");
    expect(byClaim.get("C5")).toBe("covered");
    expect(byClaim.get("CH1")).toBe("unknown"); // 无 evidence + coverageRows 缺 → unknown
  });

  it("Path A 的 uncovered 是权威(kernel coverageRows 明示无证据 → 红灯)", async () => {
    // 修 #10 回归覆盖:当 kernel 给出 coverageRows 且 status="uncovered" 时,
    // Path A 必须把 claim 标 uncovered (风险视角),不被 Path B 拉回 unknown。
    const uncoveredRow = (claimId: string) => ({
      decisionRef: `decision/${FOCUS_DECISION_ID}`,
      claimRef: `decision/${FOCUS_DECISION_ID}/${claimId}`,
      status: "uncovered" as const,
      relationPath: [],
    });
    const out = await computeGraphLayout(
      baseInput({
        coverageRows: [
          uncoveredRow("C1"),
          uncoveredRow("C2"),
          uncoveredRow("C3"),
          uncoveredRow("C4"),
          uncoveredRow("C5"),
          uncoveredRow("CH1"),
        ],
      }),
    );
    const byClaim = new Map(out.focusClaims.map((c) => [c.claimId, c.status]));
    // 即使 chosen 里 C1/C2/C4/C5 有 evidence(kernel 反向判定 uncovered,模拟
    // evidence 走被 invalidated-by 等渠道失活),也以 Path A 为准。
    expect(byClaim.get("C1")).toBe("uncovered");
    expect(byClaim.get("C3")).toBe("uncovered");
    expect(byClaim.get("CH1")).toBe("uncovered");
  });

  it("渲染三个 lane 背景 + 一个 decisionFocus 节点", async () => {
    const out = await computeGraphLayout(baseInput());
    const laneNodes = out.nodes.filter((n) => n.type === "laneBackground");
    expect(laneNodes.map((n) => n.id).sort()).toEqual(["lane_claims", "lane_derives", "lane_lineage"]);

    const focus = out.nodes.find((n) => n.type === "decisionFocus");
    expect(focus).toBeDefined();
    expect(focus?.id).toBe(`decision/${FOCUS_DECISION_ID}`);
    expect((focus?.data as { claimRows: unknown[] }).claimRows).toHaveLength(6);
  });

  it("边锚到具体 claim 行(sourceHandle = claim-<id>),不再折叠成 decision 节点", async () => {
    const out = await computeGraphLayout(baseInput());
    const derivesEdges = out.edges.filter((e) => e.source?.startsWith("decision/") && e.sourceHandle?.startsWith("claim-"));
    // C1/C2/C3/C4 各有一条 derives → task,都应锚到具体 claim
    const claimHandles = new Set(derivesEdges.map((e) => e.sourceHandle));
    expect(claimHandles.has("claim-C1")).toBe(true);
    expect(claimHandles.has("claim-C2")).toBe(true);
    expect(claimHandles.has("claim-C3")).toBe(true);
    expect(claimHandles.has("claim-C4")).toBe(true);
  });

  it("relates (assoc) 默认关 → assoc 邻居不渲染", async () => {
    const out = await computeGraphLayout(baseInput());
    const assocTask = out.nodes.find((n) => n.id?.includes("GHMQDZ08J7X5CA7DTD9RT"));
    expect(assocTask).toBeUndefined();
  });

  it("打开 assoc 轴 → 松关联 task 出现在右泳道下方", async () => {
    const out = await computeGraphLayout(baseInput({
      filters: {
        modules: new Set(["kernel"]),
        types: new Set(["decision", "task", "fact"]),
        axes: { authority: true, evidence: true, execution: true, assoc: true },
      },
    }));
    const assocTask = out.nodes.find((n) => typeof n.id === "string" && n.id.includes("GHMQDZ08J7X5CA7DTD9RT"));
    expect(assocTask).toBeDefined();
  });

  it("展开 evidence fact → 渲染 fact 节点 + evidenced-by 边", async () => {
    const factRef = "fact/task_01KX2GZ3NTFARZ0WC39NXVT25K/F-PRTXCD0P";
    const out = await computeGraphLayout(baseInput({
      expandedFacts: new Set([factRef]),
    }));
    const factNode = out.nodes.find((n) => n.id === factRef);
    expect(factNode).toBeDefined();
    expect(factNode?.type).toBe("fact");

    const evidEdge = out.edges.find((e) => e.target === factRef);
    expect(evidEdge).toBeDefined();
    expect(evidEdge?.sourceHandle).toContain("claim-");
  });

  it("停止 claim 折叠 — endpoint 三段锚保留", async () => {
    // 验证 endpointClaimId 能正确取出第三段 (反例 = 旧版 slice(0,2))
    const out = await computeGraphLayout(baseInput());
    // 至少有一条边 sourceHandle 形如 "claim-Cx"
    const claimAnchored = out.edges.some((e) => /^claim-[A-Z]+\d+$/.test(e.sourceHandle ?? ""));
    expect(claimAnchored).toBe(true);
    // focus 节点的 id 仍然是 decision/<id>,未被塌成 decision/<id>/<claim>
    const focusId = out.resolvedFocusId;
    expect(focusId?.split("/").length).toBe(2);
  });

  it("默认 focus 自动选最多 claim 的 active decision", async () => {
    const out = await computeGraphLayout(baseInput({ focusNodeId: null }));
    expect(out.resolvedFocusId).toBe(`decision/${FOCUS_DECISION_ID}`);
  });

  it("点击 fact 节点路径 — fact ref 拼接与 endpointToNodeId 一致", () => {
    // 反向回归:确保 fact ref 没被错误折叠
    const factRef = "fact/task_01KX2GZ3NTFARZ0WC39NXVT25K/F-PRTXCD0P";
    expect(endpointToNodeId(factRef)).toBe(factRef);
    expect(endpointToNodeId(`decision/${FOCUS_DECISION_ID}/C1`)).toBe(`decision/${FOCUS_DECISION_ID}`);
  });

  it("修 #4/#5:focus 节点 claimRows 带 factRefs 并集(coverageRows ∪ evidence 边)", async () => {
    // C1 在 chosen 里挂了 evidence=['fact/.../F-96WH7P98'],同时 relations 里也
    // 有直接的 C1 evidenced-by 边到同一 fact。并集后 factRefs 含 1 条去重 fact。
    const out = await computeGraphLayout(baseInput());
    const focus = out.nodes.find((n) => n.type === "decisionFocus");
    const rows = (focus?.data as { claimRows: Array<{ claimId: string; factRefs?: string[] }> }).claimRows;
    const c1 = rows.find((r) => r.claimId === "C1");
    expect(c1?.factRefs).toBeDefined();
    expect(c1?.factRefs).toContain("fact/task_01KX3PGD74EXEEV6DFM49ARDJ2/F-96WH7P98");
    // CH1 无 evidence、无 coverage row(空 coverageRows)→ factRefs 为空
    const ch1 = rows.find((r) => r.claimId === "CH1");
    expect(ch1?.factRefs ?? []).toHaveLength(0);
  });

  it("修 #5:仅 coverageRows 给出 coveringFactRef(无直接 evidence 边)也进 factRefs", async () => {
    // 模拟 kernel 投影里有 transitive coverage 但 relation_edges 没直接边。
    const out = await computeGraphLayout(
      baseInput({
        coverageRows: [
          {
            decisionRef: `decision/${FOCUS_DECISION_ID}`,
            claimRef: `decision/${FOCUS_DECISION_ID}/CH1`,
            status: "covered" as const,
            coveringFactRef: "fact/task_01KX3PGD74EXEEV6DFM49ARDJ2/F-COVERED",
          },
        ],
      }),
    );
    const focus = out.nodes.find((n) => n.type === "decisionFocus");
    const rows = (focus?.data as { claimRows: Array<{ claimId: string; factRefs?: string[] }> }).claimRows;
    const ch1 = rows.find((r) => r.claimId === "CH1");
    expect(ch1?.factRefs).toContain("fact/task_01KX3PGD74EXEEV6DFM49ARDJ2/F-COVERED");
  });

  it("修 #6:多 claim 派生同一 task → 只渲染一个 task 节点(去重)", async () => {
    // C1/C2/C3/C4 都 derives 同一 task_01KX2GZ3NTFARZ0WC39NXVT25K。
    const out = await computeGraphLayout(baseInput());
    const taskNodes = out.nodes.filter(
      (n) => n.id === "task_01KX2GZ3NTFARZ0WC39NXVT25K",
    );
    expect(taskNodes).toHaveLength(1);
    // 4 条 derives 边仍然都在(sourceHandle 区分 claim),target 是同一节点。
    const derivesEdges = out.edges.filter(
      (e) => e.target === "task_01KX2GZ3NTFARZ0WC39NXVT25K" && e.sourceHandle?.startsWith("claim-"),
    );
    expect(derivesEdges).toHaveLength(4);
    const handles = new Set(derivesEdges.map((e) => e.sourceHandle));
    expect(handles.has("claim-C1")).toBe(true);
    expect(handles.has("claim-C2")).toBe(true);
    expect(handles.has("claim-C3")).toBe(true);
    expect(handles.has("claim-C4")).toBe(true);
  });

  it("修 #7:聚焦后代时 lineage 边按 canonical 方向(focus→other),claim handle 保留", async () => {
    // 真实场景:dec_focus/CH1 refines dec_ancestor。当前 focus=dec_focus
    // (descendant),other=dec_ancestor。canonical 方向 = focus→other。
    const focusDecision: DecisionRow = {
      decisionId: "dec_focus",
      title: "后代决策",
      state: "active",
      question: "Q?",
      chosen: [{ id: "CH1", text: "策略", evidence: [] }],
      rejected: [],
      claims: [{ id: "CH1", text: "策略" }],
    };
    const ancestorDecision: DecisionRow = {
      decisionId: "dec_ancestor",
      title: "祖先决策",
      state: "active",
      question: "Q?",
      chosen: [{ id: "CH1", text: "策略", evidence: [] }],
      rejected: [],
      claims: [{ id: "CH1", text: "策略" }],
    };
    const lineageRelations: RelationEdge[] = [
      {
        from: "decision/dec_focus/CH1",
        to: "decision/dec_ancestor",
        kind: "refines",
        provenance: "local-document",
      },
    ];
    const out = await computeGraphLayout({
      tasks,
      relations: lineageRelations,
      decisions: [focusDecision, ancestorDecision],
      facts,
      coverageRows: [],
      focusNodeId: "decision/dec_focus",
      expandedFacts: new Set(),
      filters: {
        modules: new Set(["kernel"]),
        types: new Set(["decision", "task", "fact"]),
        axes: { authority: true, evidence: true, execution: true, assoc: false },
      },
      inLoopNodes: new Set(),
      inLoopEdges: new Set(),
    });
    // lineage 边 source=focus(带 CH1 handle),target=ancestor
    const lineageEdge = out.edges.find((e) => e.id.startsWith("e_lineage_"));
    expect(lineageEdge).toBeDefined();
    expect(lineageEdge?.source).toBe("decision/dec_focus");
    expect(lineageEdge?.target).toBe("decision/dec_ancestor");
    expect(lineageEdge?.sourceHandle).toBe("claim-CH1");
  });

  it("修 #8:assoc decision↔decision 边打开 assoc 轴后渲染 assoc decision 节点", async () => {
    // dec_other 通过 relates 关联 dec_focus;之前 assoc 轴打开也看不到。
    const otherDecision: DecisionRow = {
      decisionId: "dec_other_assoc",
      title: "松关联决策",
      state: "active",
      question: "Q?",
      chosen: [{ id: "CH1", text: "x", evidence: [] }],
      rejected: [],
      claims: [{ id: "CH1", text: "x" }],
    };
    const assocRelations: RelationEdge[] = [
      ...relations,
      {
        from: `decision/${FOCUS_DECISION_ID}/CH1`,
        to: "decision/dec_other_assoc",
        kind: "relates",
        provenance: "local-document",
      },
    ];
    const out = await computeGraphLayout(
      baseInput({
        decisions: [decision, lineageDecision, otherDecision],
        relations: assocRelations,
        filters: {
          modules: new Set(["kernel"]),
          types: new Set(["decision", "task", "fact"]),
          axes: { authority: true, evidence: true, execution: true, assoc: true },
        },
      }),
    );
    // 至少有 dec_other_assoc 关联节点(dec_mrd7jiux 也算,baseInput 里通过 RJ3 relates)。
    const assocDecNode = out.nodes.find(
      (n) => typeof n.id === "string" && n.id === "decision/dec_other_assoc__assoc",
    );
    expect(assocDecNode).toBeDefined();
    expect(assocDecNode?.type).toBe("decision");
    // assoc 边至少有一条(dec_other_assoc 那条 id 唯一)
    const assocEdges = out.edges.filter((e) => e.id.startsWith("e_assoc_decision_"));
    expect(assocEdges.length).toBeGreaterThanOrEqual(1);
    const otherAssocEdge = assocEdges.find((e) => e.target === "decision/dec_other_assoc__assoc");
    expect(otherAssocEdge).toBeDefined();
    expect(otherAssocEdge?.source).toBe(`decision/${FOCUS_DECISION_ID}`);
  });
});

describe("computeGraphLayout: simpleEgo (task focus) filter (#9)", () => {
  it("task focus:关闭 decision 类型 → decision 邻居被过滤,fact/task 不受影响", async () => {
    const focusTaskId = "task_01KX2GZ3NTFARZ0WC39NXVT25K";
    // ego 关系:fact 与 focus task 同宿主(dec→fact 的 fact.taskId = focusTaskId);
    // 以及 decision→focus task 的 derives。
    const factRefOfFocus = `fact/${focusTaskId}/F-PRTXCD0P`;
    const egoRelations: RelationEdge[] = [
      // focus task 同宿主的 fact(用 produces 表达 task→fact 邻接)
      {
        from: `task/${focusTaskId}`,
        to: factRefOfFocus,
        kind: "produces",
        provenance: "local-document",
      },
      // decision → focus task (derives)
      {
        from: "decision/dec_mrczk07e/C1",
        to: `task/${focusTaskId}`,
        kind: "derives",
        provenance: "local-document",
      },
    ];
    const out = await computeGraphLayout({
      tasks,
      relations: egoRelations,
      decisions: [decision],
      facts,
      coverageRows: [],
      focusNodeId: focusTaskId,
      expandedFacts: new Set(),
      filters: {
        modules: new Set(["kernel"]),
        // 关 decision,留 task + fact
        types: new Set(["task", "fact"]),
        axes: { authority: true, evidence: true, execution: true, assoc: false },
      },
      inLoopNodes: new Set(),
      inLoopEdges: new Set(),
    });
    const nodeTypes = new Set(out.nodes.map((n) => n.type));
    expect(nodeTypes.has("task")).toBe(true); // focus 自身
    expect(nodeTypes.has("fact")).toBe(true); // fact 邻居保留
    expect(nodeTypes.has("decision")).toBe(false); // 修 #9:decision 被 types 过滤掉
  });
});
