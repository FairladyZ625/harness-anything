// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

import { actor, evidence, initRepo } from "./task-surface.fixtures.ts";
test("wide task reads keep byte-identical unparameterized results and serve narrow pages through the cell", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-query-real-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-query-real"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-query-real",
      now: () => "2026-08-16T00:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    for (const [index, title] of [
      ["Alpha", "Alpha"],
      ["Beta", "Beta"],
      ["Gamma", "Gamma"],
      ["Delta", "Delta"],
      ["Epsilon", "Epsilon"],
    ] as const) {
      const taskId = `task_real_${index}`;
      const created = await cell.run({ kind: "task-create", taskId, title }, binding);
      assert.equal(created.outcome, "applied");
      if (index === "Beta" || index === "Delta")
        await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
          cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
        );
    }
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-start",
            taskId: "task_real_Beta",
            executionId: "exe_real_beta",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-start",
            taskId: "task_real_Delta",
            executionId: "exe_real_delta",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-relate",
            taskId: "task_real_Alpha",
            target: "task/task_real_Beta",
            relationType: "depends-on",
            rationale: "Alpha waits for Beta",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-relate",
            taskId: "task_real_Gamma",
            target: "task/task_real_Delta",
            relationType: "depends-on",
            rationale: "Gamma waits for Delta",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    const proposed = await cell.run(
      {
        kind: "decision-propose",
        jsonInput: JSON.stringify({
          title: "Place Alpha",
          question: "Should the list retain Decision-derived placement?",
          riskTier: "medium",
          urgency: "medium",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon-query"], productLines: ["gui"] },
          chosen: [{ id: "CH1", text: "Place it" }],
          rejected: [
            {
              id: "RJ1",
              text: "Drop placement",
              whyNot: "The GUI contract needs it.",
            },
          ],
          claims: [],
          fulfillments: [],
          relations: [
            {
              anchor: "CH1",
              type: "derives",
              target: "task/task_real_Alpha",
              rationale: "The Decision supplies task placement.",
            },
          ],
        }),
      },
      binding,
    );
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    const spawningDecisionId = String(evidence(proposed).decisionId);
    assert.match(spawningDecisionId, /^dec_/u);
    const factReceipt = await cell.run(
      {
        kind: "fact-record",
        taskId: "task_real_Alpha",
        statement: "Alpha depends on Beta for query equivalence",
        evidenceSource: "task-relation/depends-on",
        confidence: "high",
        memoryClass: "semantic",
      },
      binding,
    );
    assert.equal(factReceipt.outcome, "applied", JSON.stringify(factReceipt));

    const taskBytes = JSON.stringify(await cell.read("repo.tasks.list", {})),
      graphBytes = JSON.stringify(await cell.read("repo.triadic.relationGraph", {}));
    const unparameterized = JSON.parse(taskBytes) as {
      page?: unknown;
      rows: {
        taskId: string;
        blockingAssessment: { blockers: { targetTaskId: string }[] };
      }[];
    };
    assert.equal(unparameterized.page, undefined, "unparameterized task list must not carry a page facet");
    assert.deepEqual(
      unparameterized.rows
        .find(({ taskId }) => taskId === "task_real_Alpha")
        ?.blockingAssessment.blockers.map(({ targetTaskId }) => targetTaskId),
      ["task_real_Beta"],
      "unparameterized guiTasks must judge blockers from the complete relation graph",
    );
    const alphaPlacement = (
      unparameterized.rows.find(({ taskId }) => taskId === "task_real_Alpha") as {
        placement: { moduleKeys: string[]; productLines: string[]; spawningDecisionIds: string[] };
      }
    ).placement;
    assert.deepEqual(
      {
        moduleKeys: alphaPlacement.moduleKeys,
        productLines: alphaPlacement.productLines,
        spawningDecisionIds: alphaPlacement.spawningDecisionIds,
      },
      { moduleKeys: ["daemon-query"], productLines: ["gui"], spawningDecisionIds: [spawningDecisionId] },
    );
    await cell.close();
    cell = await openRepoCell({
      repoId: workspaceId("task-query-real"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-query-real-reopen",
      now: () => "2026-08-16T00:00:00.000Z",
    });
    assert.equal(
      JSON.stringify(await cell.read("repo.tasks.list", {})),
      taskBytes,
      "unparameterized task list must be byte-identical across reopen",
    );
    assert.equal(
      JSON.stringify(await cell.read("repo.triadic.relationGraph", {})),
      graphBytes,
      "unparameterized relation graph must be byte-identical across reopen",
    );

    const active = await cell.read("repo.tasks.list", { status: "active" });
    assert.deepEqual(
      active.rows.map((row) => row.taskId),
      ["task_real_Beta", "task_real_Delta"],
    );
    assert.equal(active.rows.length, 2);
    assert.equal(active.page, undefined);
    const windowed = await cell.read("repo.tasks.list", {
      updatedAfter: "2026-08-15T00:00:00.000Z",
    });
    assert.deepEqual(
      windowed.rows.map((row) => row.taskId),
      JSON.parse(taskBytes)
        .rows.filter((row: { updatedAt: string }) => row.updatedAt >= "2026-08-15T00:00:00.000Z")
        .map((row: { taskId: string }) => row.taskId),
    );
    const changed = await cell.read("repo.tasks.list", {
      changedAfterRevision: 7,
    });
    assert.deepEqual(
      changed.rows.map((row) => row.taskId),
      JSON.parse(taskBytes)
        .rows.filter((row: { workspaceRevision: number }) => row.workspaceRevision > 7)
        .map((row: { taskId: string }) => row.taskId),
    );
    let page = await cell.read("repo.tasks.list", { limit: 2 }),
      paged: typeof page.rows = [];
    while (true) {
      paged = [...paged, ...page.rows];
      if (!page.page?.nextCursor) break;
      page = await cell.read("repo.tasks.list", {
        limit: 2,
        cursor: page.page.nextCursor,
      });
    }
    assert.equal(page.page?.nextCursor, null);
    const unparameterizedRows = JSON.parse(taskBytes).rows;
    assert.equal(
      JSON.stringify(paged),
      JSON.stringify(unparameterizedRows),
      "paged walk must concatenate to the unparameterized rows",
    );
    const graphPage = await cell.read("repo.triadic.relationGraph", {
      limit: 1,
    });
    const graphEdges = JSON.parse(graphBytes).edges as { relationId: string; relationType: string }[];
    assert.deepEqual(
      graphEdges.map((edge) => edge.relationType).sort(),
      ["depends-on", "depends-on", "derives", "executes", "executes", "produces"],
      "fixture carries two depends-on task edges, one Decision derives edge, two execution→task executes edges, and one task→fact produces edge",
    );
    assert.equal(graphPage.edges.length, 1);
    assert.equal(graphPage.page?.limit, 1);
    assert.ok(graphPage.page?.nextCursor, "one edge per page must leave a next cursor when more edges remain");
    let graphWalk = await cell.read("repo.triadic.relationGraph", { limit: 1 }),
      walked: typeof graphWalk.edges = [];
    while (true) {
      walked = [...walked, ...graphWalk.edges];
      if (!graphWalk.page?.nextCursor) break;
      graphWalk = await cell.read("repo.triadic.relationGraph", {
        limit: 1,
        cursor: graphWalk.page.nextCursor,
      });
    }
    assert.deepEqual(
      walked.map((edge) => edge.relationId),
      graphEdges.map((edge) => edge.relationId),
      "relation graph pages must concatenate to the unparameterized edges",
    );
    let taskActionPage = evidence(await cell.run({ kind: "task-list", limit: 2 }, binding)),
      taskActionRows = [...(taskActionPage.rows as { taskId: string }[])];
    while ((taskActionPage.page as { nextCursor: string | null }).nextCursor) {
      taskActionPage = evidence(
        await cell.run(
          {
            kind: "task-list",
            limit: 2,
            cursor: (taskActionPage.page as { nextCursor: string }).nextCursor,
          },
          binding,
        ),
      );
      taskActionRows = [...taskActionRows, ...(taskActionPage.rows as { taskId: string }[])];
    }
    assert.deepEqual(
      taskActionRows.map(({ taskId }) => taskId),
      unparameterizedRows.map((row: { taskId: string }) => row.taskId),
    );
    const relationActionFull = evidence(await cell.run({ kind: "relation-list" }, binding));
    let relationActionPage = evidence(await cell.run({ kind: "relation-list", limit: 1 }, binding)),
      relationActionRows = [...(relationActionPage.rows as { relationId: string }[])];
    while ((relationActionPage.page as { nextCursor: string | null }).nextCursor) {
      relationActionPage = evidence(
        await cell.run(
          {
            kind: "relation-list",
            limit: 1,
            cursor: (relationActionPage.page as { nextCursor: string }).nextCursor,
          },
          binding,
        ),
      );
      relationActionRows = [...relationActionRows, ...(relationActionPage.rows as { relationId: string }[])];
    }
    assert.deepEqual(
      relationActionRows.map(({ relationId }) => relationId),
      (relationActionFull.rows as { relationId: string }[]).map(({ relationId }) => relationId),
    );
    const graphState = await cell.read("repo.triadic.relationGraph", {
      status: "active",
    });
    assert.ok(graphState.edges.every((edge) => edge.state === "active"));
    const edgeFacet = await cell.read("repo.triadic.relationGraph", {
        facet: "edges",
        relationType: "derives",
        state: "active",
        direction: "directed",
      }),
      factsFacet = await cell.read("repo.triadic.relationGraph", { facet: "facts" }),
      coverageFacet = await cell.read("repo.triadic.relationGraph", { facet: "coverageRows" }),
      anchorsFacet = await cell.read("repo.triadic.relationGraph", { facet: "factAnchors" });
    assert.deepEqual(
      edgeFacet.edges.map(({ relationType, state, direction }) => ({ relationType, state, direction })),
      [{ relationType: "derives", state: "active", direction: "directed" }],
    );
    assert.deepEqual([edgeFacet.coverageRows, edgeFacet.factAnchors, edgeFacet.facts], [[], [], []]);
    assert.deepEqual(
      factsFacet.facts.map(({ anchor, text, category, taskId }) => ({ anchor, text, category, taskId })),
      [
        {
          anchor: `fact/${String((factReceipt as Record<string, unknown>).factId)}`,
          text: "Alpha depends on Beta for query equivalence",
          category: "lesson",
          taskId: "task_real_Alpha",
        },
      ],
    );
    assert.deepEqual([factsFacet.edges, factsFacet.coverageRows, factsFacet.factAnchors], [[], [], []]);
    assert.equal(coverageFacet.facet, "coverageRows");
    assert.deepEqual([coverageFacet.edges, coverageFacet.factAnchors, coverageFacet.facts], [[], [], []]);
    assert.equal(anchorsFacet.factAnchors.length, 1);
    assert.deepEqual([anchorsFacet.edges, anchorsFacet.coverageRows, anchorsFacet.facts], [[], [], []]);
    const decisionSummary = await cell.read("repo.decisions.list", { projection: "summary" }),
      decisionFull = await cell.read("repo.decisions.list", { projection: "full" });
    assert.equal(decisionSummary.projection, "summary");
    assert.deepEqual(Object.keys(decisionSummary.decisions[0]!).sort(), ["appliesTo", "decisionId", "state", "title"]);
    assert.equal(decisionFull.projection, "full");
    assert.equal(Object.hasOwn(decisionFull.decisions[0]!, "readiness"), true);
    await assert.rejects(cell.read("repo.tasks.list", { status: "not-a-status" }), /status is invalid/u);
    await assert.rejects(cell.read("repo.triadic.relationGraph", { limit: 0 }), /limit must be an integer/u);
    await assert.rejects(cell.read("repo.triadic.relationGraph", { facet: "unknown" as "facts" }), /invalid/u);
    await assert.rejects(
      cell.read("repo.triadic.relationGraph", { facet: "facts", relationType: "derives" }),
      /invalid/u,
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fact search action forwards observed-time windows and preserves keyset page equivalence", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-query-real-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("fact-query-real"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "fact-query-real",
      now: () => "2026-08-16T00:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-create",
            taskId: "task_fact_query",
            title: "Fact query",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    for (let index = 1; index <= 5; index += 1)
      assert.equal(
        (
          await cell.run(
            {
              kind: "fact-record",
              taskId: "task_fact_query",
              factId: `F-${String(index).padStart(8, "0")}`,
              statement: `Fact observation ${index}`,
              evidenceSource: "fact-query-fixture",
              observedAt: `2026-08-15T00:00:0${index}.000Z`,
              confidence: "high",
              memoryClass: "semantic",
            },
            binding,
          )
        ).outcome,
        "applied",
      );
    const full = evidence(await cell.run({ kind: "fact-search", taskId: "task_fact_query" }, binding)),
      first = evidence(await cell.run({ kind: "fact-search", taskId: "task_fact_query", limit: 2 }, binding));
    assert.deepEqual(
      (full.facts as { factId: string }[]).map(({ factId }) => factId),
      ["F-00000005", "F-00000004", "F-00000003", "F-00000002", "F-00000001"],
    );
    assert.equal((first.page as { limit: number }).limit, 2);
    let cursor = (first.page as { nextCursor: string | null }).nextCursor,
      rows = [...(first.facts as { factId: string }[])];
    while (cursor) {
      const next = evidence(
        await cell.run({ kind: "fact-search", taskId: "task_fact_query", limit: 2, cursor }, binding),
      );
      rows = [...rows, ...(next.facts as { factId: string }[])];
      cursor = (next.page as { nextCursor: string | null }).nextCursor;
    }
    assert.deepEqual(rows, full.facts);
    const window = evidence(
      await cell.run(
        {
          kind: "fact-search",
          taskId: "task_fact_query",
          observedAfter: "2026-08-15T00:00:03.000Z",
          observedBefore: "2026-08-15T00:00:04.000Z",
        },
        binding,
      ),
    );
    assert.deepEqual(
      (window.facts as { factId: string }[]).map(({ factId }) => factId),
      ["F-00000004", "F-00000003"],
    );
    const invalidDate = await cell.run(
        {
          kind: "fact-search",
          taskId: "task_fact_query",
          observedAfter: "not-a-date",
        },
        binding,
      ),
      invertedWindow = await cell.run(
        {
          kind: "fact-search",
          taskId: "task_fact_query",
          observedAfter: "2026-08-16T00:00:00.000Z",
          observedBefore: "2026-08-15T00:00:00.000Z",
        },
        binding,
      ),
      invalidLimit = await cell.run({ kind: "fact-search", taskId: "task_fact_query", limit: 0 }, binding);
    const unknownField = await cell.run(
      {
        kind: "fact-search",
        taskId: "task_fact_query",
        permissionMode: "read-only",
      },
      binding,
    );
    assert.equal(invalidDate.outcome, "op_rejected");
    assert.match(String(invalidDate.nextAction), /ISO-8601/u);
    assert.equal(invertedWindow.outcome, "op_rejected");
    assert.match(String(invertedWindow.nextAction), /later/u);
    assert.equal(invalidLimit.outcome, "op_rejected");
    assert.match(String(invalidLimit.nextAction), /between 1 and 500/u);
    assert.equal(unknownField.outcome, "op_rejected");
    assert.equal(
      unknownField.nextAction,
      'Fact search filters contain an unknown field "permissionMode"; allowed fields: "kind", "query", "taskId", "confidence", "memoryClass", "observedAfter", "observedBefore", "limit", "cursor".',
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
