// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { actor, evidence, initRepo } from "./task-surface.fixtures.ts";

const binding = { actor, source: "local" as const };

interface GraphNode {
  readonly ref: string;
  readonly kind: string;
  readonly cycle: boolean;
  readonly repeated: boolean;
  readonly truncated: boolean;
  readonly viaEdge: {
    readonly relationType: string;
    readonly traversal: string;
    readonly sourceRef: string | null;
    readonly targetRef: string | null;
  } | null;
  readonly children: readonly GraphNode[];
}

function find(node: GraphNode, ref: string): GraphNode | undefined {
  if (node.ref === ref) return node;
  for (const child of node.children) {
    const hit = find(child, ref);
    if (hit) return hit;
  }
  return undefined;
}

test("ha graph serves the task→decision→fact causal tree through the repo read path", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-graph-view-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("graph-view"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "graph-view-test",
    });
    for (const spec of [
      { taskId: "task_root", title: "Root milestone", taskClass: "milestone" },
      { taskId: "task_leaf", title: "Leaf work", parentTaskId: "task_root" },
    ]) {
      const created = await cell.run({ kind: "task-create", ...spec }, binding);
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, binding);
    }
    const proposed = await cell.run(
        {
          kind: "decision-propose",
          jsonInput: JSON.stringify({
            title: "Graph root decision",
            question: "Does the graph read serve the causal tree?",
            riskTier: "low",
            urgency: "low",
            vertical: "software/coding",
            preset: "standard-task",
            decisionClass: "ordinary",
            appliesTo: { modules: ["daemon"], productLines: [] },
            chosen: [{ id: "CH1", text: "Serve the tree" }],
            rejected: [{ id: "RJ1", text: "Hide it", whyNot: "Reviewers need the topology" }],
            claims: [{ id: "C1", text: "The tree serves evidence.", loadBearing: true }],
            fulfillments: [],
          }),
          body: "# Graph root decision\n\nOne decision deriving the leaf task.\n",
        },
        binding,
      ),
      decisionId = String(evidence(proposed).decisionId);
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    await waitForFixturePublication(cell, proposed.opId, binding);
    const fact = await cell.run(
      {
        kind: "fact-record",
        factId: "F-0000ABCD",
        statement: "The neighborhood read returns converged edges.",
        evidenceSource: "test:graph-view",
        confidence: "high",
        memoryClass: "semantic",
      },
      binding,
    );
    assert.equal(fact.outcome, "applied", JSON.stringify(fact));
    await waitForFixturePublication(cell, fact.opId, binding);
    for (const relation of [
      { sourceRef: `decision/${decisionId}/C1`, targetRef: "task/task_leaf", relationType: "derives" },
      { sourceRef: `decision/${decisionId}/C1`, targetRef: "fact/F-0000ABCD", relationType: "evidenced-by" },
    ]) {
      const related = await cell.run(
        { kind: "relation-relate", ...relation, rationale: "Fixture edge.", expectedVersion: 0 },
        binding,
      );
      assert.equal(related.outcome, "applied", JSON.stringify(related));
      await waitForFixturePublication(cell, related.opId, binding);
    }

    const fromTask = await cell.run({ kind: "graph", ref: "task_leaf" }, binding);
    assert.equal(fromTask.outcome, "applied", JSON.stringify(fromTask));
    const payload = evidence(fromTask) as {
      schema: string;
      root: GraphNode;
      query: Record<string, unknown>;
      stats: { truncated: number };
    };
    assert.equal(payload.schema, "causal-graph/v1");
    assert.equal(payload.query.resolvedRef, "task/task_leaf");
    assert.equal(typeof payload.watermark === "number" || typeof payload.root === "object", true);
    const anchor = find(payload.root, `decision/${decisionId}/C1`),
      parent = find(payload.root, "task/task_root");
    assert.equal(anchor?.viaEdge?.traversal, "upstream");
    assert.equal(anchor?.viaEdge?.sourceRef, `decision/${decisionId}/C1`);
    assert.equal(anchor?.viaEdge?.targetRef, "task/task_leaf");
    assert.equal(parent?.viaEdge?.relationType, "child");

    const fromDecision = await cell.run({ kind: "graph", ref: decisionId, depth: 2 }, binding);
    assert.equal(fromDecision.outcome, "applied", JSON.stringify(fromDecision));
    const decisionPayload = evidence(fromDecision) as { root: GraphNode };
    const claim = find(decisionPayload.root, `decision/${decisionId}/C1`);
    assert.equal(claim !== undefined, true);
    assert.equal(find(decisionPayload.root, "fact/F-0000ABCD")?.ref, "fact/F-0000ABCD");
    assert.equal(find(decisionPayload.root, "task/task_leaf")?.ref, "task/task_leaf");

    const unknown = await cell.run({ kind: "graph", ref: "task_does_not_exist" }, binding);
    assert.equal(unknown.outcome, "op_rejected");
    assert.equal(unknown.code, "graph_root_unknown", JSON.stringify(unknown));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
