// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { graphView } from "../src/repo-cell-graph-view.ts";
import type { TaskQueryCell } from "../src/repo-cell-task-query.ts";
import type { RepoCellBinding, RepoTaskAction } from "../src/repo-cell-types.ts";

function fixture(finalRevision = 1, anchorRevision = 1, labelRevision = 1): TaskQueryCell {
  const cut = (revision = 1) => ({ status: "ready" as const, watermark: revision, sourceRevision: revision });
  let cutReads = 0,
    neighborhoods = 0;
  return {
    input: { repoId: "graph-cut" },
    requiredCellText: (value: string) => value,
    operationId: () => "graph-cut-read",
    readResult: () => ({}),
    projection: {
      readCut: () => cut(cutReads++ === 0 ? 1 : finalRevision),
      readEntityVersionWitness: () => ({ freshness: "current", currentVersion: 1 }),
      readDecision: () => ({ ...cut(), decision: { claims: [{ id: "C1", text: "A claim" }], chosen: [] } }),
      readTaskIndex: () => ({ ...cut(), rows: [] }),
      readDecisions: () => ({ ...cut(labelRevision), decisions: [] }),
    },
    queryRead: () => ({
      relationGraphNeighborhood: () => ({
        ...cut(neighborhoods++ === 0 ? 1 : anchorRevision),
        edges: [],
        facts: [],
        warnings: [],
      }),
    }),
  } as unknown as TaskQueryCell;
}
const read = (cell: TaskQueryCell) =>
  graphView(cell, { kind: "graph", ref: "decision/dec_1" } as RepoTaskAction, {} as RepoCellBinding);

test("graph serves a coherent projection cut", () => assert.doesNotThrow(() => read(fixture())));
for (const [name, revisions] of [
  ["a cut advancing around the unversioned root lookup", [2, 1, 1]],
  ["different decision-anchor neighborhoods", [1, 2, 1]],
  ["node labels from a different cut", [1, 1, 2]],
] as const) {
  test(`graph rejects ${name}`, () =>
    assert.throws(() => read(fixture(...revisions)), /graph spans multiple event projection cuts/u));
}
