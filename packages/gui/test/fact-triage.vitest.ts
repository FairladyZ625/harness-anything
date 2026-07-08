import { describe, expect, it } from "vitest";
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
  SIGNAL_SEVERITY,
  SIGNAL_LABEL,
} from "../src/renderer/model/fact-triage.ts";
import { buildFactTriageContext } from "../src/renderer/model/copy-context.ts";

// ---- fixtures ----

function baseFact(overrides: Partial<FactRef> = {}): FactRef {
  return {
    anchor: "task_a/F-001",
    taskId: "task_a",
    category: "finding",
    text: "观察 X 成立",
    at: "2026-07-01T00:00:00.000Z",
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

describe("fact-triage signal computation", () => {
  it("flags INVALIDATED when fact has invalidated-by inbound edge", () => {
    const fact = baseFact();
    const relations = [
      edge("decision/dec_2", "fact/task_a/F-001", "invalidated-by", {
        rationale: "复现失败",
      }),
    ];
    const item = computeFactTriageSignals(fact, relations, [], []);
    const kinds = item.signals.map((s) => s.kind);
    expect(kinds).toContain("INVALIDATED");
    expect(item.severity).toBe(SIGNAL_SEVERITY.INVALIDATED);
  });

  it("flags INVALIDATED when fact.invalidated flag is true even without edges", () => {
    const fact = baseFact({ invalidated: true });
    const item = computeFactTriageSignals(fact, [], [], []);
    expect(item.signals.map((s) => s.kind)).toContain("INVALIDATED");
  });

  it("flags ORPHAN when no decision claim reaches the fact via evidence edges", () => {
    const fact = baseFact();
    const item = computeFactTriageSignals(fact, [], [], []);
    const kinds = item.signals.map((s) => s.kind);
    expect(kinds).toContain("ORPHAN");
    expect(item.citingDecisionIds).toEqual([]);
  });

  it("does NOT flag ORPHAN when an active decision supports the fact", () => {
    const fact = baseFact();
    const dec = baseDecision({ decisionId: "dec_1", state: "active" });
    const relations = [
      edge("decision/dec_1/CH1", "fact/task_a/F-001", "supports"),
    ];
    const item = computeFactTriageSignals(fact, relations, [dec], []);
    expect(item.signals.map((s) => s.kind)).not.toContain("ORPHAN");
    expect(item.signals.map((s) => s.kind)).not.toContain("WEAKLY_CITED");
    expect(item.citingDecisionIds).toEqual(["dec_1"]);
  });

  it("flags WEAKLY_CITED when all citing decisions are non-active", () => {
    const fact = baseFact();
    const decs = [
      baseDecision({ decisionId: "dec_1", state: "rejected" }),
      baseDecision({ decisionId: "dec_2", state: "deferred" }),
    ];
    const relations = [
      edge("decision/dec_1/CH1", "fact/task_a/F-001", "supports"),
      edge("decision/dec_2/CH1", "fact/task_a/F-001", "evidenced-by"),
    ];
    const item = computeFactTriageSignals(fact, relations, decs, []);
    const kinds = item.signals.map((s) => s.kind);
    expect(kinds).toContain("WEAKLY_CITED");
    expect(kinds).not.toContain("ORPHAN");
    expect(item.citingDecisionIds.sort()).toEqual(["dec_1", "dec_2"]);
  });

  it("does NOT flag WEAKLY_CITED when at least one citing decision is active", () => {
    const fact = baseFact();
    const decs = [
      baseDecision({ decisionId: "dec_1", state: "rejected" }),
      baseDecision({ decisionId: "dec_2", state: "active" }),
    ];
    const relations = [
      edge("decision/dec_1/CH1", "fact/task_a/F-001", "supports"),
      edge("decision/dec_2/CH1", "fact/task_a/F-001", "supports"),
    ];
    const item = computeFactTriageSignals(fact, relations, decs, []);
    expect(item.signals.map((s) => s.kind)).not.toContain("WEAKLY_CITED");
  });

  it("flags SUPERSEDES_OTHER on outbound supersedes-fact edge", () => {
    const fact = baseFact();
    const relations = [
      edge("fact/task_a/F-001", "fact/task_a/F-old", "supersedes-fact", {
        rationale: "重新测量",
      }),
    ];
    const item = computeFactTriageSignals(fact, relations, [], []);
    expect(item.signals.map((s) => s.kind)).toContain("SUPERSEDES_OTHER");
  });

  it("flags MARGINAL_SOURCE when source task has failing gates", () => {
    const fact = baseFact();
    const task = baseTask({
      gates: [
        { name: "lint", ok: false },
        { name: "test", ok: true },
      ],
    });
    const item = computeFactTriageSignals(fact, [], [], [task]);
    expect(item.signals.map((s) => s.kind)).toContain("MARGINAL_SOURCE");
  });

  it("flags MARGINAL_SOURCE when source task closeout is incomplete", () => {
    const fact = baseFact();
    const task = baseTask({ closeoutReadiness: "incomplete", gates: [] });
    const item = computeFactTriageSignals(fact, [], [], [task]);
    expect(item.signals.map((s) => s.kind)).toContain("MARGINAL_SOURCE");
  });

  it("does not flag MARGINAL_SOURCE for a healthy source task", () => {
    const fact = baseFact();
    const task = baseTask({
      closeoutReadiness: "not_required",
      gates: [{ name: "lint", ok: true }],
    });
    const item = computeFactTriageSignals(fact, [], [], [task]);
    // ORPHAN still fires (no edges), but MARGINAL_SOURCE must not
    expect(item.signals.map((s) => s.kind)).not.toContain("MARGINAL_SOURCE");
  });
});

describe("fact-triage ranking", () => {
  it("sorts by severity desc — INVALIDATED above ORPHAN", () => {
    const invalidated = baseFact({ anchor: "task_a/F-inv", invalidated: true });
    const orphan = baseFact({ anchor: "task_a/F-orphan" });
    const items = [
      computeFactTriageSignals(orphan, [], [], []),
      computeFactTriageSignals(invalidated, [], [], []),
    ];
    const ranked = rankFactTriage(items);
    expect(ranked[0].fact.anchor).toBe("task_a/F-inv");
    expect(ranked[1].fact.anchor).toBe("task_a/F-orphan");
  });

  it("breaks severity ties by fact.at desc (newer first)", () => {
    const older = baseFact({
      anchor: "task_a/F-old",
      at: "2026-06-01T00:00:00.000Z",
    });
    const newer = baseFact({
      anchor: "task_a/F-new",
      at: "2026-07-05T00:00:00.000Z",
    });
    const items = [
      computeFactTriageSignals(older, [], [], []),
      computeFactTriageSignals(newer, [], [], []),
    ];
    const ranked = rankFactTriage(items);
    expect(ranked[0].fact.anchor).toBe("task_a/F-new");
  });

  it("excludes healthy facts (severity 0) from triage pool", () => {
    const healthy = baseFact({ anchor: "task_a/F-ok" });
    const dec = baseDecision({ state: "active" });
    const relations = [
      edge("decision/dec_1/CH1", "fact/task_a/F-ok", "supports"),
    ];
    const item = computeFactTriageSignals(healthy, relations, [dec], []);
    expect(item.severity).toBe(0);
    expect(rankFactTriage([item])).toEqual([]);
  });

  it("buildFactTriage end-to-end sorts and filters", () => {
    const facts = [
      baseFact({ anchor: "task_a/F-ok" }),
      baseFact({ anchor: "task_a/F-bad", invalidated: true }),
    ];
    const decs = [baseDecision({ state: "active" })];
    const relations = [
      edge("decision/dec_1/CH1", "fact/task_a/F-ok", "supports"),
    ];
    const ranked = buildFactTriage(facts, relations, decs, []);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].fact.anchor).toBe("task_a/F-bad");
  });
});

describe("fact-triage signal metadata", () => {
  it("every signal kind has a label and severity", () => {
    for (const kind of Object.keys(SIGNAL_SEVERITY) as Array<
      keyof typeof SIGNAL_SEVERITY
    >) {
      expect(SIGNAL_LABEL[kind]).toBeTruthy();
      expect(SIGNAL_SEVERITY[kind]).toBeGreaterThan(0);
    }
  });
});

describe("copy-context builder", () => {
  it("produces agent-ready markdown with fact + signals + decisions", () => {
    const fact = baseFact({ text: "模块覆盖率只有 12%" });
    const dec = baseDecision({
      decisionId: "dec_1",
      state: "rejected",
      title: "是否上线",
      question: "覆盖率够吗?",
    });
    const relations = [
      edge("decision/dec_1/CH1", "fact/task_a/F-001", "supports"),
    ];
    const item = computeFactTriageSignals(fact, relations, [dec], []);
    const text = buildFactTriageContext(item, relations, [dec], []);
    expect(text).toContain("task_a/F-001");
    expect(text).toContain("模块覆盖率只有 12%");
    expect(text).toContain("dec_1");
    expect(text).toContain("是否上线");
    expect(text).toContain("低置信");
    expect(text).toContain("需要人判");
  });

  it("includes relation edges in the context block", () => {
    const fact = baseFact();
    const relations = [
      edge("decision/dec_1/CH1", "fact/task_a/F-001", "supports", {
        rationale: "承重证据",
      }),
    ];
    const item = computeFactTriageSignals(fact, relations, [], []);
    const text = buildFactTriageContext(item, relations, [], []);
    expect(text).toContain("supports");
    expect(text).toContain("承重证据");
  });

  it("handles orphan fact with no decisions gracefully", () => {
    const fact = baseFact();
    const item = computeFactTriageSignals(fact, [], [], []);
    const text = buildFactTriageContext(item, [], [], []);
    expect(text).toContain("孤儿 fact");
    expect(text).toContain("无——该 fact 未被任何 decision claim");
  });
});
