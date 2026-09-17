// harness-test-tier: integration
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const binding = withRoleBinding(
  {
    actor: {
      principal: { personId: "person-rematerialize" },
      executor: { kind: "agent", id: "agent-rematerialize" },
    },
    source: "local" as const,
  },
  "repo-write",
);

test("entity rematerialize renders relative graph links and is idempotent at one cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-rematerialize-"));
  initRepo(rootDir);
  const repoId = workspaceId("entity-rematerialize"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "rematerialize-test" }),
    reader = makeTaskEventReader({ repoId, rootDir }),
    projection = makeTaskProjection({ rootDir, eventStore: reader });
  try {
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task_remat", title: "Remat Task" }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "fact-record",
            factId: "F-00000REM",
            statement: "Rematerialize observes current relations.",
            evidenceSource: "test:entity-rematerialize",
            confidence: "high",
            memoryClass: "semantic",
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
          title: "Rematerialize Decision",
          question: "Are current relations linked in the managed document?",
          riskTier: "medium",
          urgency: "low",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: [{ id: "CH1", text: "Link the neighborhood" }],
          rejected: [{ id: "RJ1", text: "Keep bare refs", whyNot: "The graph must self-link." }],
          claims: [{ id: "C1", text: "Links resolve to canonical paths.", loadBearing: true }],
          fulfillments: [],
        }),
      },
      binding,
    );
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    const decisionId = (JSON.parse(String(proposed.evidence)) as { decisionId: string }).decisionId,
      decisionPath = `decisions/decision-${decisionId}/decision.md`;
    for (const [sourceRef, targetRef, relationType] of [
      [`decision/${decisionId}/C1`, "fact/F-00000REM", "evidenced-by"],
      [`decision/${decisionId}/CH1`, "task/task_remat", "derives"],
    ] as const) {
      const related = await cell.run(
        {
          kind: "relation-relate",
          sourceRef,
          targetRef,
          relationType,
          rationale: "Graph link fixture.",
          expectedVersion: 0,
        },
        binding,
      );
      assert.equal(related.outcome, "applied", JSON.stringify(related));
    }
    const rendered = projection.readDocument(decisionPath).document!.body;
    assert.match(rendered, /## 关联图谱 \(Causal Graph\)/u);
    assert.match(rendered, /\]\(\.\.\/\.\.\/facts\/F-00000REM\.md\)/u);
    assert.match(rendered, /\]\(\.\.\/task_remat[^)]*INDEX\.md\)|\]\(\.\.\/\.\.\/tasks?[^)]*INDEX\.md\)/u);
    // First refresh may restamp managed frontmatter to the entity revision; after that the
    // same cut must be byte-for-byte idempotent across all three entity kinds.
    const headAfterSeed = reader.readHead()?.revision ?? 0;
    for (const action of [
      { kind: "decision-rematerialize", decisionId },
      { kind: "decision-rematerialize", all: true },
      { kind: "fact-rematerialize", factId: "F-00000REM" },
      { kind: "fact-rematerialize", all: true },
      { kind: "task-rematerialize", taskId: "task_remat" },
      { kind: "task-rematerialize", all: true },
    ] as const) {
      const first = await cell.run(action as never, binding);
      assert.ok(
        first.outcome === "applied" || first.outcome === "no_changes",
        `${action.kind}: ${JSON.stringify(first)}`,
      );
      const dry = await cell.run({ ...action, dryRun: true } as never, binding);
      assert.equal(dry.outcome, "no_changes", `dry-run ${action.kind}: ${JSON.stringify(dry)}`);
      const second = await cell.run(action as never, binding);
      assert.equal(second.outcome, "no_changes", `${action.kind}: ${JSON.stringify(second)}`);
    }
    const headAfterRemat = reader.readHead()?.revision ?? 0;
    assert.ok(
      headAfterRemat >= headAfterSeed && headAfterRemat <= headAfterSeed + 3,
      `refresh appended ${headAfterRemat - headAfterSeed} events; at most one per entity kind`,
    );
    // A dirty authored document stays local: rematerialization must not clobber it.
    const file = path.join(rootDir, "harness", decisionPath);
    appendFileSync(file, "\nlocal dirty draft\n");
    let dirtyReceipt: { outcome?: string; proof?: { worktreeVisible?: boolean } | null } | null = null;
    try {
      dirtyReceipt = await cell.run({ kind: "decision-rematerialize", decisionId } as never, binding);
    } catch {
      // a rejected write is an acceptable conflict outcome
    }
    if (dirtyReceipt !== null)
      assert.ok(
        dirtyReceipt.outcome !== "applied" || dirtyReceipt.proof?.worktreeVisible === false,
        `dirty document must not be reported as worktree-visible: ${JSON.stringify(dirtyReceipt)}`,
      );
    assert.match(readFileSync(file, "utf8"), /local dirty draft\n$/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
