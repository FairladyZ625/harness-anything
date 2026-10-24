// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, sha256Bytes } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const actorIdentity = {
  principal: { personId: "person-await" },
  executor: { kind: "agent" as const, id: "awaits-worker" },
};
const holder = withPolicyGroup({ actor: actorIdentity, source: "local" as const }, "admin");
const human = withPolicyGroup(
  { actor: { principal: { personId: "person-await" }, executor: null }, source: "local" as const },
  "admin",
);
const reviewer = withPolicyGroup(
  {
    actor: {
      principal: { personId: "person-reviewer" },
      executor: { kind: "agent" as const, id: "reviewer-agent" },
    },
    source: "local" as const,
  },
  "admin",
);

interface Cell {
  run: (action: Record<string, unknown>, binding?: unknown) => Promise<Record<string, unknown>>;
  read: (method: string, payload?: Record<string, unknown>, binding?: unknown) => Promise<any>;
  close: () => Promise<void>;
}

async function withCell(
  name: string,
  run: (cell: Cell, rootDir: string) => Promise<void>,
  prepare?: (rootDir: string) => void,
): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), `${name}-`));
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    git(rootDir, "branch", "-M", "main");
    writeFileSync(path.join(rootDir, ".gitignore"), "harness/\n.worktrees/\n");
    git(rootDir, "add", ".gitignore");
    git(rootDir, "commit", "-qm", "test: fixture exclusions");
    prepare?.(rootDir);
    cell = (await openRepoCell({
      repoId: workspaceId(name),
      rootDir: canonicalRoot(rootDir),
      ownerId: name,
    })) as unknown as Cell;
    await run(cell, rootDir);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

async function createTask(cell: Cell, taskId: string, title: string): Promise<string> {
  const created = await cell.run({ kind: "task-create", taskId, title }, holder);
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFixturePublication(cell as never, String(created.opId), holder as never);
  return String(created.packagePath);
}

async function relateAwaits(cell: Cell, sourceRef: string, rationale: string): Promise<void> {
  const related = await cell.run(
    {
      kind: "relation-relate",
      sourceRef,
      targetRef: "person/person-await",
      relationType: "awaits",
      rationale,
      expectedVersion: 0,
    },
    holder,
  );
  assert.equal(related.outcome, "applied", JSON.stringify(related));
}

async function relationRows(
  cell: Cell,
  query: Record<string, unknown>,
): Promise<readonly { readonly relationId: string; readonly state: string; readonly relationType: string }[]> {
  const listed = await cell.run({ kind: "relation-list", ...query }, holder);
  assert.equal(listed.outcome, "applied", JSON.stringify(listed));
  return JSON.parse(String(listed.evidence)).rows;
}

function decisionProposal(title: string, question: string) {
  return {
    kind: "decision-propose",
    body: `# ${title}\n\n## 背景\n\nProposals can reach terminal states.\n\n## 权衡\n\nCompare states.\n\n## 结论\n\nRetire waits with the transition.\n`,
    jsonInput: JSON.stringify({
      title,
      question,
      riskTier: "medium",
      urgency: "high",
      vertical: "default",
      preset: "default",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Retire them" }],
      rejected: [{ id: "RJ1", text: "Leave them", whyNot: "Zombie waits" }],
      claims: [],
      fulfillments: [],
    }),
  } as const;
}

test("a task entering cancelled retires the awaits Relations it initiated, and only those", async () => {
  const name = "terminal-awaits-cancel";
  await withCell(name, async (cell, rootDir) => {
    await createTask(cell, "task_cancel_me", "Cancel me");
    await createTask(cell, "task_alive", "Stay alive");
    await relateAwaits(cell, "task/task_cancel_me", "question: 还需要继续吗?");
    await relateAwaits(cell, "task/task_alive", "consent: 这个方案可以吗?");
    const depended = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: "task/task_cancel_me",
        targetRef: "task/task_alive",
        relationType: "depends-on",
        rationale: "Cancellation fixture dependency",
        expectedVersion: 0,
      },
      holder,
    );
    assert.equal(depended.outcome, "applied", JSON.stringify(depended));
    assert.deepEqual(
      (await relationRows(cell, { source: "task/task_cancel_me", relationType: "awaits" })).map(({ state }) => state),
      ["active"],
    );

    const cancelled = await cell.run(
      { kind: "task-transition", taskId: "task_cancel_me", status: "cancelled", reason: "No longer needed." },
      holder,
    );
    assert.equal(cancelled.outcome, "applied", JSON.stringify(cancelled));

    assert.deepEqual(
      (await relationRows(cell, { source: "task/task_cancel_me", relationType: "awaits" })).map(({ state }) => state),
      ["retired"],
      "the cancelled task's awaits edge retires with the terminal transition",
    );
    assert.deepEqual(
      (await relationRows(cell, { source: "task/task_alive", relationType: "awaits" })).map(({ state }) => state),
      ["active"],
      "another entity's awaits edge is untouched",
    );
    assert.deepEqual(
      (await relationRows(cell, { source: "task/task_cancel_me", relationType: "depends-on" })).map(
        ({ state }) => state,
      ),
      ["active"],
      "a non-awaits edge from the terminal task is untouched",
    );
    const retiredEvents = makeTaskEventReader({ repoId: workspaceId(name), rootDir })
      .read()
      .events.filter((event) => event.schema === "relation-event/v1" && event.type === "relation_retired");
    assert.equal(retiredEvents.length, 1, "exactly the one awaits edge retired");
    const retired = retiredEvents[0]!;
    assert.match(String((retired.payload as { readonly reason: string }).reason), /task_cancel_me/u);
    assert.match(String((retired.payload as { readonly reason: string }).reason), /cancelled/u);
    assert.notEqual(retired.opId, String(cancelled.opId), "the retirement is its own derived operation");
  });
});

test("a rejected Decision retires the awaits Relations it initiated; a proposed sibling keeps its own", async () => {
  const name = "terminal-awaits-reject";
  await withCell(name, async (cell) => {
    const first = await cell.run(decisionProposal("Reject fixture", "Reject this one?"), holder),
      second = await cell.run(decisionProposal("Proposed sibling", "Keep this one proposed?"), holder);
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    assert.equal(second.outcome, "applied", JSON.stringify(second));
    const rejectedId = JSON.parse(String(first.evidence)).decisionId as string,
      proposedId = JSON.parse(String(second.evidence)).decisionId as string;
    await relateAwaits(cell, `decision/${rejectedId}`, "consent: 同意这个方案吗?");
    await relateAwaits(cell, `decision/${proposedId}`, "question: 这个问题还成立吗?");

    const rejected = await cell.run(
      { kind: "decision-reject", decisionId: rejectedId, reason: "The proposal no longer holds." },
      human,
    );
    assert.equal(rejected.outcome, "applied", JSON.stringify(rejected));

    assert.deepEqual(
      (await relationRows(cell, { source: `decision/${rejectedId}`, relationType: "awaits" })).map(
        ({ state }) => state,
      ),
      ["retired"],
      "the rejected Decision's awaits edge retires with the transition",
    );
    assert.deepEqual(
      (await relationRows(cell, { source: `decision/${proposedId}`, relationType: "awaits" })).map(
        ({ state }) => state,
      ),
      ["active"],
      "a still-proposed Decision's awaits edge is untouched",
    );
  });
});

test("a superseded Decision retires the awaits Relations it initiated", async () => {
  const name = "terminal-awaits-supersede";
  await withCell(name, async (cell) => {
    const proposed = await cell.run(decisionProposal("Supersede fixture", "Supersede this one?"), holder);
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    const decisionId = JSON.parse(String(proposed.evidence)).decisionId as string;
    await relateAwaits(cell, `decision/${decisionId}`, "consent: 采纳前请确认。");
    const accepted = await cell.run(
      {
        kind: "decision-accept",
        decisionId,
        rationale: "Accepted on the fixture's own authority.",
        judgmentOnlyRationale: "Supersede fixture accepts on direct human judgment.",
      },
      human,
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));

    const superseded = await cell.run({ kind: "decision-transition", decisionId, targetState: "superseded" }, holder);
    assert.equal(superseded.outcome, "applied", JSON.stringify(superseded));

    assert.deepEqual(
      (await relationRows(cell, { source: `decision/${decisionId}`, relationType: "awaits" })).map(
        ({ state }) => state,
      ),
      ["retired"],
      "the superseded Decision's awaits edge retires with the transition",
    );
  });
});

test("a task entering cancelled through the doc-carrying path also retires its awaits Relations", async () => {
  const name = "terminal-awaits-cancel-docs";
  await withCell(name, async (cell, rootDir) => {
    const taskId = "task_cancel_docs",
      packagePath = await createTask(cell, taskId, "Cancel with documents");
    await relateAwaits(cell, `task/${taskId}`, "question: 文档一起收掉吗?");
    const planPath = `${packagePath}/task_plan.md`,
      authored = path.join(rootDir, "harness", planPath),
      originalBody = readFileSync(authored, "utf8"),
      body = `${originalBody}\n## Appendix\n\nCancelled with a carried document.\n`,
      claimRef = `doc-sync-claims/${taskId}-cancel`;
    mkdirSync(path.join(rootDir, ".harness", "doc-sync-claims"), { recursive: true });
    writeFileSync(path.join(rootDir, ".harness", claimRef), body);
    const cancelled = await cell.run(
      {
        kind: "task-transition",
        taskId,
        status: "cancelled",
        reason: "No longer needed, with a carried document.",
        docChanges: [
          {
            path: planPath,
            baseBlobSha256: sha256Bytes(Buffer.from(originalBody)),
            policyId: "markdown-body-replaceable/v1",
            candidate: {
              ref: claimRef,
              sha256: sha256Bytes(Buffer.from(body)),
              size: Buffer.byteLength(body),
              mediaType: "text/markdown",
            },
          },
        ],
      },
      holder,
    );
    assert.equal(cancelled.outcome, "applied", JSON.stringify(cancelled));
    assert.deepEqual(
      (await relationRows(cell, { source: `task/${taskId}`, relationType: "awaits" })).map(({ state }) => state),
      ["retired"],
      "the doc-carrying cancellation retires the awaits edge in the same command",
    );
  });
});

test("a task completing after review and consent retires the awaits Relations it initiated", async () => {
  const name = "terminal-awaits-done";
  const taskId = "task_complete_me",
    executionId = "execution-complete-me";
  await withCell(
    name,
    async (cell, rootDir) => {
      const packagePath = await createTask(cell, taskId, "Complete me");
      await relateAwaits(cell, `task/${taskId}`, "acceptance: 请验收交付。");
      await realizeTaskPlanFixture(rootDir, packagePath, (documentPath) =>
        cell.run({ kind: "doc-submit", paths: [documentPath] }, holder),
      );
      assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, holder)).outcome, "applied");
      writeFileSync(
        path.join(rootDir, "harness", packagePath, "closeout.md"),
        "## Summary\nCompleted the terminal awaits retirement fixture.\n" +
          "## Verification\nIntegration assertions cover the awaits retirement.\n" +
          "## Residual Risk\nNone.\n" +
          "## Same Mechanism Elsewhere\nThe cancelled-task path covers the plain lifecycle runtime.\n",
      );
      assert.equal((await cell.run({ kind: "doc-submit", taskId }, holder)).outcome, "applied");
      let submitted = await cell.run({ kind: "task-submit", taskId, executionId }, holder);
      for (let attempt = 0; submitted.outcome === "pending" && attempt < 4; attempt += 1) {
        await waitForFixturePublication(cell as never, String(submitted.opId), holder as never);
        submitted = await cell.run({ kind: "task-submit", taskId, executionId }, holder);
      }
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));

      await waitForFixturePublication(cell as never, String(forward.opId), holder as never);
      const reviewId = "review-terminal-awaits",
        reportPath = `${packagePath}/artifacts/reports/terminal-awaits.md`;
      mkdirSync(path.join(rootDir, "harness", packagePath, "artifacts", "reports"), { recursive: true });
      writeFileSync(
        path.join(rootDir, "harness", reportPath),
        "# Review\nVerified the completion evidence for the awaits retirement fixture.\n",
      );
      assert.equal((await cell.run({ kind: "doc-submit", paths: [reportPath] }, holder)).outcome, "applied");
      writeFileSync(
        path.join(rootDir, "review.json"),
        JSON.stringify({
          verdict: "approved",
          reason: "Verified delivery cut.",
          evidenceChecked: ["closeout sections"],
        }),
      );
      const reviewed = await cell.run(
        { kind: "task-review-execution", taskId, executionId, reviewId, fromFile: "review.json" },
        reviewer,
      );
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const consent = await cell.run({ kind: "task-review-consent", taskId, executionId, reviewId }, holder);
      assert.equal(consent.outcome, "applied", JSON.stringify(consent));

      const completed = await cell.run({ kind: "task-complete", taskId, executionId }, holder);
      assert.equal(completed.outcome, "applied", JSON.stringify(completed));
      assert.deepEqual(
        (await relationRows(cell, { source: `task/${taskId}`, relationType: "awaits" })).map(({ state }) => state),
        ["retired"],
        "the done task's awaits edge retires with the completion",
      );
    },
    (rootDir) => {
      const ledger = path.join(rootDir, "harness");
      mkdirSync(ledger);
      initRepo(ledger);
      writeFileSync(path.join(ledger, "harness.yaml"), "settings:\n  closeout:\n    profile: strict\n");
    },
  );
});
