import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  FactAnchorRow,
  RelationCoverageRow,
} from "../src/api/renderer-dto.ts";
import type {
  DecisionRow,
  FactRef,
  RelationEdge,
  TaskRow,
} from "../src/renderer/model/types.ts";
import {
  buildFactTriage,
  computeFactTriageSignals,
  rankFactTriage,
  SIGNAL_LABEL,
  SIGNAL_SEVERITY,
} from "../src/renderer/model/fact-triage.ts";
import {
  buildEntityJumpContext,
  buildFactTriageContext,
} from "../src/renderer/model/copy-context.ts";
import { spawningDecisionOf } from "../src/renderer/model/triadic.ts";
import { buildTriadicRendererData } from "../src/renderer/triadic-data.ts";
import { FactInspector } from "../src/renderer/components/FactInspector.tsx";

function baseFact(overrides: Partial<FactRef> = {}): FactRef {
  return {
    anchor: "task_a/F-001",
    taskId: "task_a",
    category: "finding",
    text: "观察 X 成立",
    at: "2026-07-01T00:00:00.000Z",
    confidence: "high",
    ...overrides,
  };
}

function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task_a",
    title: "Task A",
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "software/coding",
    lastKnownAt: "2026-07-01T00:00:00.000Z",
    gates: [],
    docs: [],
    ...overrides,
  };
}

function baseDecision(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "dec_1",
    title: "Decision One",
    state: "active",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "p",
    proposedAt: "2026-07-01T00:00:00.000Z",
    question: "Q?",
    chosen: [{ id: "CH1", text: "chosen", evidence: [] }],
    rejected: [],
    claims: [{ id: "CH1", text: "chosen" }],
    provenance: [],
    lastChangedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function edge(
  from: string,
  to: string,
  kind: RelationEdge["kind"],
  extra: Partial<RelationEdge> = {},
): RelationEdge {
  return {
    from,
    to,
    kind,
    provenance: "local-document",
    ...extra,
  };
}

function anchor(fact = baseFact()): FactAnchorRow {
  return {
    factRef: `fact/${fact.anchor}`,
    taskId: fact.taskId,
    factId: fact.anchor.split("/").at(-1) ?? "F-001",
    sourcePath: `harness/tasks/${fact.taskId}/facts.md`,
  };
}

function coverage(
  fact = baseFact(),
  decisionId = "dec_1",
): RelationCoverageRow {
  return {
    decisionRef: `decision/${decisionId}`,
    claimRef: `decision/${decisionId}/CH1`,
    status: "covered",
    coveringFactRef: `fact/${fact.anchor}`,
    relationPath: ["rel_1"],
  };
}

describe("fact-triage signal computation", () => {
  it("flags a contradiction fact that invalidates a decision", () => {
    const fact = baseFact();
    const relations = [
      edge("fact/task_a/F-001", "decision/dec_2", "invalidated-by", {
        rationale: "复现失败",
      }),
    ];

    const item = computeFactTriageSignals(fact, relations, [], [anchor(fact)]);

    expect(item.signals.map((signal) => signal.kind)).toContain("INVALIDATED");
    expect(item.severity).toBe(SIGNAL_SEVERITY.INVALIDATED);
  });

  it("flags an orphan from factAnchors minus covered coverageRows", () => {
    const fact = baseFact();

    const item = computeFactTriageSignals(fact, [], [], [anchor(fact)]);

    expect(item.signals.map((signal) => signal.kind)).toContain("ORPHAN");
    expect(item.citingDecisionIds).toEqual([]);
  });

  it("does not flag an orphan when coverageRows names the fact as coverage", () => {
    const fact = baseFact();

    const item = computeFactTriageSignals(
      fact,
      [],
      [coverage(fact, "dec_1")],
      [anchor(fact)],
    );

    expect(item.signals.map((signal) => signal.kind)).not.toContain("ORPHAN");
    expect(item.citingDecisionIds).toEqual(["dec_1"]);
  });

  it("does not orphan a second direct evidence fact omitted by first-match coverage", () => {
    const first = baseFact({ anchor: "task_a/F-first" });
    const second = baseFact({ anchor: "task_a/F-second" });
    const relations = [
      edge("decision/dec_1/CH1", `fact/${first.anchor}`, "evidenced-by"),
      edge("decision/dec_1/CH1", `fact/${second.anchor}`, "evidenced-by"),
    ];

    const item = computeFactTriageSignals(
      second,
      relations,
      [coverage(first)],
      [anchor(first), anchor(second)],
    );

    expect(item.signals.map((signal) => signal.kind)).not.toContain("ORPHAN");
    expect(item.citingDecisionIds).toEqual(["dec_1"]);
  });

  it("flags low confidence from the fact projection field", () => {
    const fact = baseFact({ confidence: "low" });

    const item = computeFactTriageSignals(
      fact,
      [],
      [coverage(fact)],
      [anchor(fact)],
    );

    expect(item.signals.map((signal) => signal.kind)).toContain("LOW_CONFIDENCE");
    expect(item.signals.map((signal) => signal.kind)).not.toContain("ORPHAN");
  });

  it("flags the old target fact, not the new source fact, as superseded", () => {
    const oldFact = baseFact({ anchor: "task_a/F-old" });
    const newFact = baseFact({ anchor: "task_a/F-new" });
    const relations = [
      edge("fact/task_a/F-new", "fact/task_a/F-old", "supersedes-fact", {
        rationale: "重新测量",
      }),
    ];

    const oldItem = computeFactTriageSignals(
      oldFact,
      relations,
      [],
      [anchor(oldFact), anchor(newFact)],
    );
    const newItem = computeFactTriageSignals(
      newFact,
      relations,
      [],
      [anchor(oldFact), anchor(newFact)],
    );

    expect(oldItem.signals.map((signal) => signal.kind)).toContain("SUPERSEDED");
    expect(newItem.signals.map((signal) => signal.kind)).not.toContain("SUPERSEDED");
  });
});

describe("fact-triage ranking", () => {
  it("prioritizes contradiction, orphan, low confidence, then superseded", () => {
    const contradiction = baseFact({ anchor: "task_a/F-contradiction" });
    const orphan = baseFact({ anchor: "task_a/F-orphan" });
    const low = baseFact({ anchor: "task_a/F-low", confidence: "low" });
    const superseded = baseFact({ anchor: "task_a/F-old" });
    const facts = [superseded, low, orphan, contradiction];
    const anchors = facts.map(anchor);
    const coverageRows = [coverage(contradiction), coverage(low), coverage(superseded)];
    const relations = [
      edge(`fact/${contradiction.anchor}`, "decision/dec_2", "invalidated-by"),
      edge("fact/task_a/F-new", `fact/${superseded.anchor}`, "supersedes-fact"),
    ];

    const ranked = buildFactTriage(facts, relations, coverageRows, anchors);

    expect(ranked.map((item) => item.fact.anchor)).toEqual([
      contradiction.anchor,
      orphan.anchor,
      low.anchor,
      superseded.anchor,
    ]);
  });

  it("breaks severity ties by fact.at desc", () => {
    const older = baseFact({
      anchor: "task_a/F-old",
      at: "2026-06-01T00:00:00.000Z",
    });
    const newer = baseFact({
      anchor: "task_a/F-new",
      at: "2026-07-05T00:00:00.000Z",
    });
    const items = [
      computeFactTriageSignals(older, [], [], [anchor(older)]),
      computeFactTriageSignals(newer, [], [], [anchor(newer)]),
    ];

    const ranked = rankFactTriage(items);

    expect(ranked[0].fact.anchor).toBe("task_a/F-new");
  });

  it("excludes a covered, high-confidence fact with no danger edges", () => {
    const healthy = baseFact({ anchor: "task_a/F-ok" });
    const item = computeFactTriageSignals(
      healthy,
      [],
      [coverage(healthy)],
      [anchor(healthy)],
    );

    expect(item.severity).toBe(0);
    expect(rankFactTriage([item])).toEqual([]);
  });
});

describe("fact-triage signal metadata", () => {
  it("defines a label and positive severity for every signal", () => {
    for (const kind of Object.keys(SIGNAL_SEVERITY) as Array<
      keyof typeof SIGNAL_SEVERITY
    >) {
      expect(SIGNAL_LABEL[kind]).toBeTruthy();
      expect(SIGNAL_SEVERITY[kind]).toBeGreaterThan(0);
    }
  });
});

describe("cross-entity navigation projection", () => {
  it("keeps absent decision DTO fields explicit instead of synthesizing placeholders", () => {
    const rendered = buildTriadicRendererData({
      graph: { ok: true, edges: [], coverageRows: [], factAnchors: [], warnings: [] },
      decisions: {
        ok: true,
        decisions: [{
          schema: "d4-decision-row/v1",
          decisionId: "dec_missing",
          state: "proposed",
          title: "Missing fields stay unknown",
          question: "Q?",
          chosen: [],
          rejected: [],
          path: "harness/decisions/decision-dec_missing/decision.md",
          moduleKeys: [],
          productLineKeys: []
        }],
        warnings: []
      },
      factResults: []
    });

    expect(rendered.decisions[0]).toMatchObject({
      decisionId: "dec_missing",
      riskTier: undefined,
      urgency: undefined,
      attribution: undefined,
      provenance: undefined
    });
  });

  it("derives the TaskDetail decision source from the real relation graph", () => {
    const relations = [
      edge("decision/dec_parent", "task/task_a", "derives"),
    ];

    expect(
      spawningDecisionOf(
        baseTask({ spawningDecision: "task_parent" }),
        relations,
      ),
    ).toBe("dec_parent");
  });

  it("marks the source fact of invalidated-by as invalidated", () => {
    const fact = baseFact();
    const rendered = buildTriadicRendererData({
      graph: {
        ok: true,
        edges: [
          {
            relationId: "rel_invalidated",
            sourceRef: `fact/${fact.anchor}`,
            targetRef: "decision/dec_1",
            relationType: "invalidated-by",
            direction: "directed",
            strength: "strong",
            origin: "declared",
            state: "active",
            rationale: "new observation contradicts the decision",
            ownerRef: `fact/${fact.anchor}`,
            sourcePath: "harness/tasks/task_a/facts.md",
            recordIndex: 0,
          },
        ],
        coverageRows: [],
        factAnchors: [anchor(fact)],
        warnings: [],
      },
      decisions: { ok: true, decisions: [], warnings: [] },
      factResults: [
        {
          ok: true,
          taskId: fact.taskId,
          path: "harness/tasks/task_a/facts.md",
          facts: [
            {
              schema: "task-fact-row/v1",
              ref: `fact/${fact.anchor}`,
              taskId: fact.taskId,
              factId: "F-001",
              statement: fact.text,
              source: "test",
              observedAt: fact.at,
              confidence: fact.confidence,
              memoryClass: "semantic",
              memoryTags: [],
            },
          ],
        },
      ],
    });

    expect(rendered.facts[0].invalidated).toBe(true);
  });

  it("shows an indirectly covered decision in FactInspector", () => {
    const fact = baseFact();
    const markup = renderToStaticMarkup(
      createElement(FactInspector, {
        factRef: `fact/${fact.anchor}`,
        facts: [fact],
        tasks: [baseTask()],
        decisions: [baseDecision()],
        relations: [],
        coverageRows: [coverage(fact)],
        onClose: () => undefined,
      }),
    );

    expect(markup).toContain("supporting decision");
    expect(markup).toContain("dec_1");
  });
});

describe("copy-context builder", () => {
  it("produces agent-ready text with problem, fact, task, decision and edges", () => {
    const fact = baseFact({
      text: "模块覆盖率只有 12%",
      confidence: "low",
    });
    const decision = baseDecision({
      decisionId: "dec_1",
      title: "是否上线",
      question: "覆盖率够吗?",
    });
    const relations = [
      edge("decision/dec_1/CH1", "fact/task_a/F-001", "evidenced-by", {
        rationale: "承重证据",
      }),
    ];
    const item = computeFactTriageSignals(
      fact,
      relations,
      [coverage(fact)],
      [anchor(fact)],
    );

    const text = buildFactTriageContext(
      item,
      relations,
      [decision],
      [baseTask()],
    );

    expect(text).toContain("Current Problem");
    expect(text).toContain("task_a/F-001");
    expect(text).toContain("模块覆盖率只有 12%");
    expect(text).toContain("Task A");
    expect(text).toContain("dec_1");
    expect(text).toContain("是否上线");
    expect(text).toContain("low confidence");
    expect(text).toContain("evidenced-by");
    expect(text).toContain("承重证据");
    expect(text).toContain("Need someone to judge");
  });

  it("expands a decision context through claim-level edges", () => {
    const fact = baseFact();
    const decision = baseDecision({ title: "选择关系投影方案" });
    const task = baseTask({ title: "落实关系投影" });
    const relations = [
      edge("decision/dec_1/CH1", "fact/task_a/F-001", "evidenced-by"),
      edge("decision/dec_1", "task/task_a", "derives"),
    ];

    const text = buildEntityJumpContext(
      "decision/dec_1",
      relations,
      [decision],
      [fact],
      [task],
      "正在检查这条 decision 的证据覆盖与派生工作",
    );

    expect(text).toContain("Current Problem");
    expect(text).toContain("正在检查这条 decision 的证据覆盖与派生工作");
    expect(text).toContain("选择关系投影方案");
    expect(text).toContain("落实关系投影");
    expect(text).toContain("观察 X 成立");
    expect(text).toContain("decision/dec_1/CH1");
    expect(text).toContain("evidenced-by");
    expect(text).toContain("derives");
  });

  it("includes fact confidence, invalidation and host task without a produces edge", () => {
    const fact = baseFact({ confidence: "low", invalidated: true });

    const text = buildEntityJumpContext(
      `fact/${fact.anchor}`,
      [],
      [],
      [fact],
      [baseTask()],
    );

    expect(text).toContain("confidence**: low");
    expect(text).toContain("invalidated**: Yes");
    expect(text).toContain("Host task");
    expect(text).toContain("Task A");
  });
});
