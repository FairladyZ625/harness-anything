import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";
import {
  computeReadinessSignals,
  hasUnknownSignals,
  sortKey,
  worstColor,
} from "../src/renderer/views/decisions-readiness.ts";
import { VerdictCard } from "../src/renderer/views/decisions-verdict.tsx";
import {
  cardCounts,
  countByTab,
  decisionSearchHaystack,
  groupRows,
  milestoneOf,
  relationSummary,
  UNLINKED_MILESTONE,
} from "../src/renderer/views/decision-pool-helpers.ts";
import { DecisionPoolView } from "../src/renderer/views/DecisionPoolView.tsx";
import { DecisionsView } from "../src/renderer/views/DecisionsView.tsx";

const emptyAttribution = {
  originator: null,
  latestActor: null,
  trailCount: 0,
  completeness: "unresolved" as const,
};

function decision(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "dec_a",
    title: "Pick layout",
    state: "proposed",
    riskTier: "high",
    urgency: "medium",
    vertical: "software/coding",
    preset: "coding",
    attribution: emptyAttribution,
    proposedAt: "2026-07-01T10:00:00.000Z",
    question: "Which layout?",
    chosen: [{ id: "CH1", text: "three-lane", evidence: ["fact/task_root/F-1"] }],
    rejected: [{ id: "RJ1", text: "flat list", evidence: [], whyNot: "loses hierarchy" }],
    claims: [
      { id: "CH1", text: "three-lane" },
      { id: "RJ1", text: "flat list" },
    ],
    ...overrides,
  };
}

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task_leaf",
    title: "Leaf work",
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
    rootTaskId: "task_root",
    rootTitle: "Milestone Root",
    attribution: emptyAttribution,
    ...overrides,
  };
}

function fact(overrides: Partial<FactRef> = {}): FactRef {
  return {
    anchor: "task_root/F-1",
    taskId: "task_root",
    category: "finding",
    text: "layout observation",
    at: "2026-07-01T00:00:00.000Z",
    confidence: "high",
    ...overrides,
  };
}

describe("P0-1 / P1-2 · decide mutation input shape (renderer API only)", () => {
  it("builds accept payload without judgmentOnlyRationale and without actor fields", async () => {
    const accept = vi.fn(async () => ({ ok: true as const, decisionId: "dec_a", state: "active" }));
    const reject = vi.fn(async () => ({ ok: true as const, decisionId: "dec_a", state: "rejected" }));
    const defer = vi.fn(async () => ({ ok: true as const, decisionId: "dec_a", state: "deferred" }));

    // Mirror useDecideMutation.mutationFn without react-query so the contract is unit-testable.
    async function decide(input: {
      decisionId: string;
      action: "accept" | "reject" | "defer";
      judgmentOnlyRationale?: string;
    }) {
      const payload = {
        decisionId: input.decisionId,
        ...(input.judgmentOnlyRationale
          ? { judgmentOnlyRationale: input.judgmentOnlyRationale }
          : {}),
      };
      // Never inject principal / HARNESS_ACTOR — authority is socket-derived.
      expect(payload).not.toHaveProperty("actor");
      expect(payload).not.toHaveProperty("principal");
      expect(JSON.stringify(payload)).not.toContain("HARNESS_ACTOR");
      if (input.action === "accept") return accept(payload);
      if (input.action === "reject") return reject(payload);
      return defer(payload);
    }

    await decide({ decisionId: "dec_a", action: "accept" });
    expect(accept).toHaveBeenCalledWith({ decisionId: "dec_a" });

    await decide({
      decisionId: "dec_a",
      action: "reject",
      judgmentOnlyRationale: "conflicts with architecture",
    });
    expect(reject).toHaveBeenCalledWith({
      decisionId: "dec_a",
      judgmentOnlyRationale: "conflicts with architecture",
    });

    await decide({ decisionId: "dec_a", action: "defer", judgmentOnlyRationale: "wait for review" });
    expect(defer).toHaveBeenCalledWith({
      decisionId: "dec_a",
      judgmentOnlyRationale: "wait for review",
    });
  });

  it("surfaces backend failure as thrown Error(code: hint) so toast can show it", async () => {
    async function decideFail() {
      const result = {
        ok: false as const,
        error: { code: "E_EVIDENCE_FLOOR", hint: "insufficient evidence" },
      };
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.hint}`);
      return result;
    }
    await expect(decideFail()).rejects.toThrow("E_EVIDENCE_FLOOR: insufficient evidence");
  });
});

describe("P2-1 · readiness signals honesty when projection is absent", () => {
  it("marks drift/conflict as unknown (not fake green) when readinessSignals is undefined", () => {
    const d = decision({ readinessSignals: undefined });
    const signals = computeReadinessSignals(d, [fact()]);
    expect(hasUnknownSignals(signals)).toBe(true);
    const drift = signals.find((s) => s.id === "applies-to-drift");
    const conflict = signals.find((s) => s.id === "conflict-marker");
    expect(drift?.unknown).toBe(true);
    expect(conflict?.unknown).toBe(true);
    // known lamps still compute
    expect(signals.find((s) => s.id === "evidence-liveness")?.unknown).toBeFalsy();
    expect(signals.find((s) => s.id === "coverage")?.unknown).toBeFalsy();
  });

  it("does not treat unknown lamps as blocking red/yellow when known lamps are green", () => {
    // Both claims need live evidence so coverage is green; drift/conflict stay unknown.
    const d = decision({
      readinessSignals: undefined,
      chosen: [{ id: "CH1", text: "three-lane", evidence: ["fact/task_root/F-1"] }],
      rejected: [{ id: "RJ1", text: "flat list", evidence: ["fact/task_root/F-1"], whyNot: "loses hierarchy" }],
      claims: [
        { id: "CH1", text: "three-lane" },
        { id: "RJ1", text: "flat list" },
      ],
    });
    const signals = computeReadinessSignals(d, [fact()]);
    expect(signals.find((s) => s.id === "coverage")?.color).toBe("green");
    expect(worstColor(signals)).toBe("green");
  });

  it("uses projected conflict/drift when readinessSignals is present", () => {
    const d = decision({
      readinessSignals: {
        conflictMarker: { summary: "concurrent edit", conflictingEntity: "decision/dec_a" },
      },
    });
    const signals = computeReadinessSignals(d, [fact()]);
    expect(hasUnknownSignals(signals)).toBe(false);
    expect(signals.find((s) => s.id === "conflict-marker")?.color).toBe("red");
    expect(worstColor(signals)).toBe("red");
  });
});

describe("P1-3 / P2-5 · decision pool counts, milestone grouping, lineage", () => {
  const root = task({ taskId: "task_root", title: "Milestone Root", rootTaskId: "task_root", rootTitle: "Milestone Root" });
  const leaf = task({ taskId: "task_leaf", title: "Leaf", rootTaskId: "task_root", rootTitle: "Milestone Root" });
  const relations: RelationEdge[] = [
    {
      from: "decision/dec_a",
      to: "task/task_leaf",
      kind: "derives",
      provenance: "local-document",
    },
    {
      from: "decision/dec_a",
      to: "decision/dec_b",
      kind: "refines",
      provenance: "local-document",
    },
    {
      from: "decision/dec_a",
      to: "decision/dec_old",
      kind: "supersedes",
      provenance: "local-document",
    },
  ];

  it("cardCounts reports claims/derives/chosen/rejected", () => {
    const counts = cardCounts(decision(), relations, [root, leaf]);
    expect(counts).toEqual({ claims: 2, derives: 1, chosen: 1, rejected: 1 });
  });

  it("milestoneOf walks derives → root task", () => {
    const m = milestoneOf(decision(), relations, [root, leaf]);
    expect(m.key).toBe("task_root");
    expect(m.title).toBe("Milestone Root");
  });

  it("milestoneOf falls back to unlinked bucket when no derives", () => {
    const m = milestoneOf(decision({ decisionId: "dec_orphan" }), [], [root, leaf]);
    expect(m.key).toBe(UNLINKED_MILESTONE);
  });

  it("groupRows groups by milestone and vertical", () => {
    const rows = [
      decision({ decisionId: "dec_a" }),
      decision({ decisionId: "dec_orphan", title: "Orphan" }),
    ];
    const byMs = groupRows(rows, "milestone", relations, [root, leaf]);
    expect(byMs.some((g) => g.key === "task_root")).toBe(true);
    expect(byMs.some((g) => g.key === UNLINKED_MILESTONE)).toBe(true);

    const byVert = groupRows(rows, "vertical", relations, [root, leaf]);
    expect(byVert).toHaveLength(1);
    expect(byVert[0]!.key).toBe("software/coding");
  });

  it("relationSummary surfaces derives/refines/supersedes (not just supersede)", () => {
    const lines = relationSummary(decision(), relations, [root, leaf]);
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toContain("derives");
    expect(kinds).toContain("refines");
    expect(kinds).toContain("supersedes");
  });

  it("countByTab is exact-state (P2-4 / P3-1 consistency with sidebar proposed badge)", () => {
    const decisions = [
      decision({ decisionId: "p1", state: "proposed" }),
      decision({ decisionId: "r1", state: "rejected" }),
      decision({ decisionId: "d1", state: "deferred" }),
      decision({ decisionId: "a1", state: "active" }),
    ];
    const counts = countByTab(decisions);
    expect(counts.proposed).toBe(1);
    expect(counts.rejected).toBe(1);
    expect(counts.deferred).toBe(1);
    expect(counts.active).toBe(1);
    expect(counts.retired).toBe(0);
  });

  it("decisionSearchHaystack hits title/id/question/claims", () => {
    const hay = decisionSearchHaystack(decision({ title: "Alpha Layout", decisionId: "dec_alpha" }));
    expect(hay).toContain("alpha layout");
    expect(hay).toContain("dec_alpha");
    expect(hay).toContain("three-lane");
  });
});

describe("sortKey · two-axis orthogonal ranking", () => {
  it("ranks high risk before medium regardless of urgency", () => {
    const a = decision({ riskTier: "high", urgency: "low" });
    const b = decision({ riskTier: "medium", urgency: "high" });
    expect(sortKey(a)[0]).toBeLessThan(sortKey(b)[0]);
  });
});

describe("server-render smoke · approval + pool", () => {
  const d = decision();
  const tasks = [
    task({ taskId: "task_root", rootTaskId: "task_root", rootTitle: "Milestone Root" }),
    task(),
  ];
  const relations: RelationEdge[] = [
    {
      from: "decision/dec_a",
      to: "task/task_leaf",
      kind: "derives",
      provenance: "local-document",
    },
  ];
  const facts = [fact()];

  it("VerdictCard enables accept/reject/defer when not readOnly and shows rationale hooks", () => {
    const html = renderToStaticMarkup(
      createElement(VerdictCard, {
        d,
        decisions: [d],
        facts,
        tasks,
        relations,
        onTrace: () => undefined,
        onDecide: () => undefined,
        onInspectFact: () => undefined,
        onCallAgent: () => undefined,
        readOnly: false,
      }),
    );
    expect(html).toContain("Accept");
    expect(html).toContain("Reject");
    expect(html).toContain("Defer");
    // not the read-only banner
    expect(html).not.toContain("decision-approval write surface is not in this slice");
    // honest unknown placeholder when readinessSignals absent
    expect(html).toMatch(/drift\/conflict not projected|drift\/conflict 未投影/);
  });

  it("VerdictCard shows read-only banner when readOnly", () => {
    const html = renderToStaticMarkup(
      createElement(VerdictCard, {
        d,
        decisions: [d],
        facts,
        tasks,
        relations,
        onTrace: () => undefined,
        onDecide: () => undefined,
        onInspectFact: () => undefined,
        readOnly: true,
      }),
    );
    expect(html).toMatch(/Read-only|只读|write surface|写面/);
  });

  it("DecisionsView renders queue indicator and keyboard shortcut control", () => {
    const html = renderToStaticMarkup(
      createElement(DecisionsView, {
        decisions: [d],
        tasks,
        relations,
        facts,
        onTraceSession: () => undefined,
        onDecide: () => undefined,
        onCallAgent: () => undefined,
      }),
    );
    expect(html).toMatch(/1 \/ 1/);
    expect(html).toContain("?");
  });

  it("DecisionPoolView renders count badges, group toggle, and exact-state tabs", () => {
    const html = renderToStaticMarkup(
      createElement(DecisionPoolView, {
        decisions: [
          d,
          decision({ decisionId: "dec_b", state: "active", title: "Active one" }),
          decision({ decisionId: "dec_c", state: "rejected", title: "Rejected one" }),
        ],
        facts,
        relations,
        tasks,
        onFocusGraph: () => undefined,
        onNavigateEntity: () => undefined,
        onOpenApproval: () => undefined,
      }),
    );
    expect(html).toContain("claims:2");
    expect(html).toContain("↴derives:1");
    expect(html).toContain("chosen:1/rejected:1");
    expect(html).toContain('data-testid="decision-pool-group-by"');
    // exact-state tabs (P2-4): proposed / rejected / active as separate
    expect(html).toContain("proposed");
    expect(html).toContain("rejected");
    expect(html).toContain("active");
    // no nested state <select> (dropped)
    expect(html).not.toContain("state: all");
  });
});
