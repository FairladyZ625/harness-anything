// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import { workspaceEvidenceOf } from "../src/renderer/model/workspace-evidence.ts";
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
  it("keeps member events, payload-less indexes, invalid evidence, and scoped decisions", () => {
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
      });
    expect(result.events.map(({ taskId }) => taskId)).toEqual(["task_in"]);
    expect(result.events[0]?.summary).toBeNull();
    expect(result.decisions.map(({ decisionId }) => decisionId)).toEqual(["dec_in"]);
    expect(result.facts[0]?.invalidated).toBe(true);
    expect(result.missingRefs).toEqual(["decision/dec_missing"]);
  });
});
