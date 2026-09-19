// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { actor, evidence, initRepo } from "./task-surface.fixtures.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";

const binding = withRoleBinding({ actor, source: "local" as const }, "repo-write");

interface GraphNode {
  readonly ref: string;
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

test("fact archive retires the managed document, leaves the projection row, and unarchive restores it", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-archive-")),
    factId = "F-0000ARCH",
    factRef = `fact/${factId}`,
    factPath = `facts/${factId}.md`;
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    const canonical = canonicalRoot(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("fact-archive"),
      rootDir: canonical,
      ownerId: "fact-archive-test",
    });
    const reader = makeTaskEventReader({ repoId: workspaceId("fact-archive"), rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: reader });

    const task = await cell.run({ kind: "task-create", taskId: "task_arch", title: "Archive host" }, binding);
    assert.equal(task.outcome, "applied", JSON.stringify(task));
    const fact = await cell.run(
      {
        kind: "fact-record",
        factId,
        statement: "Archive keeps the row and drops the document.",
        evidenceSource: "test:fact-archive",
        confidence: "high",
        memoryClass: "semantic",
      },
      binding,
    );
    assert.equal(fact.outcome, "applied", JSON.stringify(fact));
    await waitForFixturePublication(cell, fact.opId, binding);
    assert.equal(
      existsSync(path.join(canonical, "harness", factPath)),
      true,
      "record must materialize the managed document",
    );

    for (const relation of [
      { sourceRef: "task/task_arch", targetRef: factRef, relationType: "produces" },
      { sourceRef: "task/task_arch", targetRef: factRef, relationType: "evidences" },
    ]) {
      const related = await cell.run(
        { kind: "relation-relate", ...relation, rationale: "Archive fixture edge.", expectedVersion: 0 },
        binding,
      );
      assert.equal(related.outcome, "applied", JSON.stringify(related));
    }

    // Negative: unknown id and unarchive-before-archive are rejected per item.
    const missing = await cell.run({ kind: "fact-archive", factId: "F-ABCDEFGH", reason: "no such fact" }, binding);
    assert.equal(missing.outcome, "op_rejected", JSON.stringify(missing));
    const premature = await cell.run({ kind: "fact-unarchive", factId, reason: "not archived yet" }, binding);
    assert.equal(premature.outcome, "op_rejected", JSON.stringify(premature));

    const archived = await cell.run({ kind: "fact-archive", factId, reason: "closeout bookkeeping" }, binding);
    assert.equal(archived.outcome, "applied", JSON.stringify(archived));
    await waitForFixturePublication(cell, archived.opId, binding);
    const archiveEvent = reader.readEvent(archived.opId);
    assert.equal(archiveEvent?.type, "fact_archived");
    assert.equal(
      existsSync(path.join(canonical, "harness", factPath)),
      false,
      "archive must retire the managed document",
    );

    // The projection row stays canonical and carries the archived flag.
    const shown = await cell.run({ kind: "fact-show", factId }, binding);
    assert.equal(shown.outcome, "applied", JSON.stringify(shown));
    const row = (evidence(shown) as { fact: { factId: string; archived: boolean; state: string } }).fact;
    assert.equal(row.factId, factId);
    assert.equal(row.archived, true);
    assert.equal(row.state, "standing");

    // Re-archiving and reclassifying an archived Fact are rejected.
    for (const rejected of [
      { kind: "fact-archive", factId, reason: "already archived" },
      { kind: "fact-reclassify", factId, domainTypes: ["closeout"], rationale: "archived facts do not reclassify" },
    ] as const) {
      const result = await cell.run(rejected as never, binding);
      assert.equal(result.outcome, "op_rejected", JSON.stringify({ rejected, result }));
    }

    // Rematerialize --all must not resurrect the retired document.
    const rematerialized = await cell.run({ kind: "fact-rematerialize", all: true } as never, binding);
    assert.ok(
      rematerialized.outcome === "applied" || rematerialized.outcome === "no_changes",
      JSON.stringify(rematerialized),
    );
    if (rematerialized.outcome === "applied") await waitForFixturePublication(cell, rematerialized.opId, binding);
    assert.equal(
      existsSync(path.join(canonical, "harness", factPath)),
      false,
      "fact rematerialize --all must skip archived Facts",
    );
    // Explicit rematerialize of an archived Fact rejects.
    const explicit = await cell.run({ kind: "fact-rematerialize", factId } as never, binding);
    assert.equal(explicit.outcome, "op_rejected", JSON.stringify(explicit));
    assert.equal(existsSync(path.join(canonical, "harness", factPath)), false);

    // Projection rebuild replays the retirement; the document stays absent.
    projection.rebuild?.();
    assert.equal(projection.readDocument(factPath).document, null, "rebuild must keep the retired document absent");
    assert.equal(projection.readFact(factId).fact?.archived, true, "rebuild must keep the archived flag");

    // Read-set and relation evidence stay intact: no orphaned-required gap, edge still active.
    const readSet = (await cell.run({ kind: "task-read-set", taskId: "task_arch" }, binding)) as unknown as Record<
      string,
      unknown
    >;
    assert.equal(readSet.outcome, "applied", JSON.stringify(readSet));
    const readSetPayload = evidence(readSet) as {
      entries: readonly { entityRef: string; freshness: string }[];
      blocked: boolean;
      blockedReasons?: readonly { code: string }[];
    };
    const factEntry = readSetPayload.entries.find((entry) => entry.entityRef === factRef);
    assert.ok(factEntry, "read-set must still list the archived Fact");
    assert.notEqual(factEntry.freshness, "orphaned");
    assert.equal(
      (readSetPayload.blockedReasons ?? []).some((reason) => reason.code === "required_target_orphaned"),
      false,
      JSON.stringify(readSetPayload.blockedReasons),
    );
    const relationRead = projection.readRelationQuery({ target: factRef, state: "active" });
    assert.ok(
      relationRead.rows.length >= 2,
      `evidence relations must stay active for an archived Fact: ${JSON.stringify(relationRead.rows)}`,
    );

    // Graph hides the archived Fact by default; --include-archived restores it.
    const graphDefault = await cell.run({ kind: "graph", ref: "task_arch" }, binding);
    assert.equal(graphDefault.outcome, "applied", JSON.stringify(graphDefault));
    assert.equal(
      find((evidence(graphDefault) as { root: GraphNode }).root, factRef),
      undefined,
      "default graph must not render archived Facts",
    );
    const graphIncluded = await cell.run({ kind: "graph", ref: "task_arch", includeArchived: true }, binding);
    assert.equal(graphIncluded.outcome, "applied", JSON.stringify(graphIncluded));
    assert.ok(
      find((evidence(graphIncluded) as { root: GraphNode }).root, factRef),
      "--include-archived must render the archived Fact",
    );

    // The GUI facts facet keeps serving the row with the archived flag: the default
    // hide lives in the renderer (dec_62CAE6CA GUI alignment), the read surface stays honest.
    const factsFacet = (await cell.read("repo.triadic.relationGraph", { facet: "facts" })) as {
      readonly facts: readonly { readonly anchor: string; readonly archived?: boolean }[];
    };
    assert.equal(
      factsFacet.facts.find((row) => row.anchor === factRef)?.archived,
      true,
      "facts facet must flag the archived Fact so the GUI default filter can hide it",
    );

    // Unarchive restores document and visibility.
    const unarchived = await cell.run({ kind: "fact-unarchive", factId, reason: "still load-bearing" }, binding);
    assert.equal(unarchived.outcome, "applied", JSON.stringify(unarchived));
    await waitForFixturePublication(cell, unarchived.opId, binding);
    assert.equal(reader.readEvent(unarchived.opId)?.type, "fact_unarchived");
    assert.equal(
      existsSync(path.join(canonical, "harness", factPath)),
      true,
      "unarchive must restore the managed document",
    );
    assert.equal(projection.readFact(factId).fact?.archived, false);
    const graphAfter = await cell.run({ kind: "graph", ref: "task_arch" }, binding);
    assert.ok(find((evidence(graphAfter) as { root: GraphNode }).root, factRef));

    // Batch: --ids-file archives each listed Fact with its own event.
    const batchIds = ["F-0000BAT1", "F-0000BAT2"];
    for (const batchId of batchIds) {
      const recorded = await cell.run(
        {
          kind: "fact-record",
          factId: batchId,
          statement: `Batch fact ${batchId}.`,
          evidenceSource: "test:fact-archive",
          confidence: "medium",
          memoryClass: "episodic",
        },
        binding,
      );
      assert.equal(recorded.outcome, "applied", JSON.stringify(recorded));
    }
    writeFileSync(path.join(canonical, "archive-ids.txt"), `${batchIds.join("\n")}\n`, "utf8");
    const headBefore = reader.readHead()?.revision ?? 0,
      batch = await cell.run({ kind: "fact-archive", idsFile: "archive-ids.txt", reason: "bulk closeout" }, binding);
    assert.equal(batch.outcome, "applied", JSON.stringify(batch));
    assert.equal(reader.readHead()!.revision, headBefore + batchIds.length, "each Fact gets its own event");
    const report = JSON.parse(String(batch.evidence)) as { factIds: string[]; results: { factId: string }[] };
    assert.deepEqual(report.factIds, batchIds);
    assert.equal(report.results.length, batchIds.length);
    for (const batchId of batchIds) assert.equal(projection.readFact(batchId).fact?.archived, true);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
