// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import { workspaceEvidenceOf, workspaceGraphSlice } from "../src/renderer/model/workspace-evidence.ts";
import type { CadenceFeedEvent } from "../src/renderer/model/cadence.ts";
import type { DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types.ts";

const event = (taskId: string, summary: string | null): CadenceFeedEvent => ({
  key: `${taskId}:${summary ?? "empty"}`,
  type: "task_progressed",
  at: "2026-09-20T12:00:00.000Z",
  revision: 4,
  taskId,
  factId: null,
  decisionId: null,
  executorId: null,
  touchedPaths: [],
  gateId: null,
  gateResult: null,
  reviewVerdict: null,
  summary,
});

const relation = (from: string, kind: RelationEdge["kind"], to: string): RelationEdge => ({
  relationId: `${from}:${kind}:${to}`,
  from,
  to,
  kind,
  provenance: "local-document",
});

describe("workspace evidence scope", () => {
  it("keeps member events, payload-less indexes, invalid evidence, and scoped artifacts", () => {
    const decision = { decisionId: "dec_in", title: "Scoped choice", state: "in_effect" } as DecisionRow,
      invalidFact = {
        anchor: "fact/F-old",
        taskId: "task_in",
        category: "finding",
        text: "Old observation",
        at: "2026-09-20T10:00:00.000Z",
        confidence: "high",
        invalidated: true,
      } satisfies FactRef,
      result = workspaceEvidenceOf({
        memberTaskIds: ["task_in"],
        events: [event("task_in", null), event("task_out", "must not leak")],
        decisions: [decision],
        facts: [invalidFact],
        relations: [
          relation("decision/dec_in/C1", "derives", "task/task_in"),
          relation("task/task_in", "relates", "decision/dec_missing"),
        ],
        artifacts: [
          {
            taskId: "task_in",
            taskTitle: "Inside",
            packagePath: "tasks/task_in",
            path: "artifacts/report.md",
            kind: "md",
            mediaType: "text/markdown",
            sizeBytes: 12,
            time: "2026-09-20T12:00:00.000Z",
            timeSource: "ledger",
          },
          {
            taskId: "task_out",
            taskTitle: "Outside",
            packagePath: "tasks/task_out",
            path: "artifacts/report.md",
            kind: "md",
            mediaType: "text/markdown",
            sizeBytes: 12,
            time: "2026-09-20T12:00:00.000Z",
            timeSource: "ledger",
          },
        ],
      });
    expect(result.events.map(({ taskId }) => taskId)).toEqual(["task_in"]);
    expect(result.events[0]?.summary).toBeNull();
    expect(result.decisions.map(({ decisionId }) => decisionId)).toEqual(["dec_in"]);
    expect(result.facts[0]?.invalidated).toBe(true);
    expect(result.artifacts.map(({ taskId }) => taskId)).toEqual(["task_in"]);
    expect(result.missingRefs).toEqual(["decision/dec_missing"]);
  });

  it("shows only direct boundary nodes until an external node is expanded one layer", () => {
    const edges = [
      relation("task/task_in", "depends-on", "task/task_external"),
      relation("task/task_external", "relates", "fact/F-external"),
      relation("fact/F-external", "evidenced-by", "decision/dec_far/C1"),
      relation("task/task_other", "relates", "task/task_hidden"),
    ];
    const initial = workspaceGraphSlice(["task_in"], edges);
    expect(initial.nodeRefs).toEqual(["task/task_in", "task/task_external"]);
    expect(initial.edges).toHaveLength(1);
    expect(initial.externalRefs).toEqual(["task/task_external"]);

    const expanded = workspaceGraphSlice(["task_in"], edges, new Set(["task/task_external"]));
    expect(expanded.nodeRefs).toContain("fact/F-external");
    expect(expanded.nodeRefs).not.toContain("decision/dec_far");
    expect(expanded.nodeRefs).not.toContain("task/task_hidden");
    expect(expanded.edges).toHaveLength(2);
  });
});
