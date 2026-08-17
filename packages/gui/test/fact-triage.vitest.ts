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
    proposedBy: { kind: "system", id: "x" },
    proposedAt: "2026-07-01T00:00:00.000Z",
    question: "Q?",
    chosen: [{ id: "CH1", text: "chosen", evidence: [] }],
    rejected: [],
    claims: [{ id: "CH1", text: "chosen", loadBearing: true, fulfillment: "evidenced" }],
    judgmentConsents: [],
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
    direction: "directed",
    state: "active",
    provenance: "local-document",
    ...extra,
  };
}

function anchor(fact = baseFact()): FactAnchorRow {
  return {
    factRef: `fact/${fact.anchor}`,
    taskId: fact.taskId,
    factId: fact.anchor.split("/").at(-1) ?? "F-001",
    sourcePath: `event:fact/${fact.anchor}`,
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
    fulfillment: "evidenced",
    coveringFactRef: `fact/${fact.anchor}`,
    refutingFactRefs: [],
    relationPath: ["rel_1"],
    basisRevision: 1,
  };
}

describe("fact-triage signal computation", () => {
  it("flags a contradiction fact that invalidates a decision", () => {
    const fact = baseFact();
    const relations = [
      edge("decision/dec_2", "fact/task_a/F-001", "refuted-by", {
        rationale: "复现失败",
      }),
    ];

    const item = computeFactTriageSignals(fact, relations, [], [anchor(fact)]);

    expect(item.signals.map((signal) => signal.kind)).toContain("INVALIDATED");
    expect(item.severity).toBe(SIGNAL_SEVERITY.INVALIDATED);
  });

  it("derives the INVALIDATED signal from the canonical direction, not the retired alias", () => {
    // Before slice 4 the triage read fact --invalidated-by--> decision, a shape the
    // kernel registry refuses; a canonical decision --refuted-by--> fact edge produced
    // no signal. The two orientations disagreed for this input.
    const fact = baseFact();
    const canonical = computeFactTriageSignals(
      fact,
      [edge("decision/dec_2", "fact/task_a/F-001", "refuted-by")],
      [],
      [anchor(fact)],
    );
    const retiredAlias = computeFactTriageSignals(
      fact,
      [edge("fact/task_a/F-001", "decision/dec_2", "invalidated-by")],
      [],
      [anchor(fact)],
    );
    expect(canonical.signals.map((signal) => signal.kind)).toContain("INVALIDATED");
    expect(retiredAlias.signals.map((signal) => signal.kind)).not.toContain("INVALIDATED");
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
      edge("decision/dec_2", `fact/${contradiction.anchor}`, "refuted-by"),
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
  it("uses projected fact liveness instead of recomputing it from renderer edges", () => {
    const rendered = buildTriadicRendererData({ graph: { ok: true, edges: [{ relationId: "conflict", sourceRef: "fact/task_a/F-new", targetRef: "fact/task_a/F-old", relationType: "supersedes-fact", direction: "directed", strength: "strong", origin: "declared", state: "active", rationale: "backend fixture deliberately conflicts", ownerRef: "fact/task_a/F-new", sourcePath: "event:conflict", recordIndex: 0 }], coverageRows: [], factAnchors: [], facts: [{ schema: "task-fact-row/v1", ref: "fact/task_a/F-old", taskId: "task_a", factId: "F-old", statement: "authoritative live row", source: "fixture", observedAt: "2026-08-18T00:00:00.000Z", confidence: "high", memoryClass: "semantic", memoryTags: [], provenance: [], liveness: "live" }], warnings: [] }, decisions: { ok: true, decisions: [], warnings: [] } });
    expect(rendered.facts[0]?.invalidated).toBe(false);
  });

  it("maps the complete event-backed Decision row without legacy DTO placeholders", () => {
    const rendered = buildTriadicRendererData({
      graph: {
        ok: true,
        edges: [
          {
            relationId: "rel_active",
            sourceRef: "decision/dec_missing/CH1",
            targetRef: "fact/task_a/F-live",
            relationType: "evidenced-by",
            direction: "directed",
            strength: "strong",
            origin: "declared",
            state: "active",
            rationale: "live evidence",
            ownerRef: "decision/dec_missing",
            sourcePath: "event:decision/dec_missing",
            recordIndex: 0,
          },
          {
            relationId: "rel_retired",
            sourceRef: "decision/dec_missing/CH1",
            targetRef: "fact/task_a/F-retired",
            relationType: "evidenced-by",
            direction: "directed",
            strength: "strong",
            origin: "declared",
            state: "retired",
            rationale: "must not be consumed",
            ownerRef: "decision/dec_missing",
            sourcePath: "event:decision/dec_missing",
            recordIndex: 1,
          },
        ],
        coverageRows: [], factAnchors: [], facts: [], warnings: [],
      },
      decisions: {
        ok: true,
        decisions: [{
          schema: "decision-row/v1",
          decisionId: "dec_missing",
          legacyId: "42",
          path: "decisions/decision-dec_missing/decision.md",
          state: "proposed",
          title: "Missing fields stay unknown",
          question: "Q?",
          riskTier: "medium",
          urgency: "medium",
          vertical: "software/coding",
          preset: "p",
          decisionClass: "ordinary",
          appliesTo: { modules: [], productLines: [] },
          proposer: { principal: { personId: "x" }, executor: null },
          arbiter: null,
          proposedAt: "2026-07-01T00:00:00.000Z",
          decidedAt: null,
          workspaceRevision: 7,
          chosen: [{ id: "CH1", text: "Ship it", rationale: "best tradeoff" }],
          rejected: [],
          claims: [{ id: "CH1", text: "Claim", loadBearing: true, fulfillment: "evidenced" }],
          judgmentConsents: [{
            schema: "decision-judgment-consent/v1",
            consentId: "djc_0123456789abcdef0123456789",
            decisionId: "dec_missing",
            action: "accept",
            targetState: "active",
            machineDigest: `sha256:${"0".repeat(64)}`,
            actor: { principal: { personId: "arbiter" }, executor: null },
            source: "local",
            consentedAt: "2026-07-02T00:00:00.000Z",
          }],
          body: {
            path: "decisions/decision-dec_missing/decision.md",
            blobSha256: "0".repeat(64),
            size: 14,
            mediaType: "text/markdown",
            body: "## 背景\ntruth",
            workspaceRevision: 7,
          }
        }],
        warnings: []
      }
    });

    expect(rendered.decisions[0]).toMatchObject({
      decisionId: "dec_missing",
      riskTier: "medium",
      urgency: "medium",
      proposedBy: { kind: "human", id: "x" },
      legacyId: "42",
      path: "decisions/decision-dec_missing/decision.md",
      decisionClass: "ordinary",
      workspaceRevision: 7,
      chosen: [{ id: "CH1", text: "Ship it", rationale: "best tradeoff", evidence: ["fact/task_a/F-live"] }],
      claims: [{ id: "CH1", text: "Claim", loadBearing: true, fulfillment: "evidenced" }],
      judgmentConsents: [{ consentId: "djc_0123456789abcdef0123456789" }],
      body: { body: "## 背景\ntruth" },
    });
    expect(rendered.relations.map((relation) => relation.relationId)).toEqual(["rel_active"]);
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

  it("keeps fact anchors without inventing fact bodies absent from L2", () => {
    const fact = baseFact();
    const rendered = buildTriadicRendererData({
      graph: {
        ok: true,
        edges: [
          {
            relationId: "rel_refuted",
            sourceRef: "decision/dec_1",
            targetRef: `fact/${fact.anchor}`,
            relationType: "refuted-by",
            direction: "directed",
            strength: "strong",
            origin: "declared",
            state: "active",
            rationale: "new observation contradicts the decision",
            ownerRef: `fact/${fact.anchor}`,
            sourcePath: "event:fact/task_a/F-ABCDEFGH",
            recordIndex: 0,
          },
        ],
        coverageRows: [],
        factAnchors: [anchor(fact)], facts: [],
        warnings: [],
      },
      decisions: { ok: true, decisions: [], warnings: [] }
    });

    expect(rendered.factAnchors).toEqual([anchor(fact)]);
    expect(rendered.facts).toEqual([]);
  });

  it("renders relation-graph fact anchors without inventing fact bodies", () => {
    // Migrated to graph-view.vitest.ts: computeSpotlightLayout entity resolution
    // (fact anchors render without inventing bodies, no dead layout dependency).
    expect(true).toBe(true);
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

    expect(markup).toContain("支撑的 decision");
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

    expect(text).toContain("当前问题");
    expect(text).toContain("task_a/F-001");
    expect(text).toContain("模块覆盖率只有 12%");
    expect(text).toContain("Task A");
    expect(text).toContain("dec_1");
    expect(text).toContain("是否上线");
    expect(text).toContain("低 confidence");
    expect(text).toContain("evidenced-by");
    expect(text).toContain("承重证据");
    expect(text).toContain("需要人判");
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

    expect(text).toContain("当前问题");
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
    expect(text).toContain("invalidated**: 是");
    expect(text).toContain("宿主 task");
    expect(text).toContain("Task A");
  });
});
