// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { removeTemporaryDirectory } from "../../../tools/temporary-directory-cleanup.mjs";

const worker = {
    principal: { personId: "person-owner" },
    executor: { kind: "agent" as const, id: "worker-runtime" },
  },
  workerBinding = withRoleBinding({ actor: worker, source: "local" as const }, "repo-write"),
  ownerRejoin = { principal: { personId: "person-owner" }, executor: null },
  ownerRejoinBinding = withRoleBinding({ actor: ownerRejoin, source: "local" as const }, "repo-write"),
  handoff = {
    principal: { personId: "person-owner" },
    executor: { kind: "agent" as const, id: "handoff-runtime" },
  },
  handoffBinding = withRoleBinding({ actor: handoff, source: "local" as const }, "repo-write"),
  peer = { principal: { personId: "person-peer" }, executor: null },
  peerBinding = withRoleBinding({ actor: peer, source: "local" as const }, "repo-write");

function initRepo(rootDir: string): void {
  const git = (...args: readonly string[]) =>
    execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet");
  git("config", "user.name", "Settle Lifecycle Test");
  git("config", "user.email", "settle@example.invalid");
  git("config", "gc.auto", "0");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "fixture base");
}

async function reachDeliverable(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  rootDir: string,
  taskId: string,
  executionId: string,
): Promise<void> {
  const title = "Settle Lifecycle";
  await createRealizedTaskPlanFixture(
    rootDir,
    async () => {
      const created = await cell.run({ kind: "task-create", taskId, title, presetId: "docs-task" }, workerBinding);
      const shown = await cell.run(
        { kind: "receipt-show", opId: created.opId, waitFor: ["worktree_visible"], timeoutMs: 5_000 },
        workerBinding,
      );
      assert.equal(shown.wait?.state, "satisfied", JSON.stringify(shown));
      return created;
    },
    (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, workerBinding),
    title,
  );
  assert.equal(
    (
      await cell.run(
        {
          kind: "fact-record",
          taskId,
          statement: "The task has completion evidence.",
          evidenceSource: "test:settle-lifecycle",
          confidence: "high",
          memoryClass: "episodic",
          memoryTags: [],
        },
        workerBinding,
      )
    ).outcome,
    "applied",
  );
  assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, workerBinding)).outcome, "applied");
  const packagePath = `tasks/${taskId}-settle-lifecycle`,
    artifactPath = `${packagePath}/artifacts/verification.md`;
  mkdirSync(path.dirname(path.join(rootDir, "harness", artifactPath)), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", artifactPath), "Verified fixture delivery.\n");
  const artifactSync = await cell.run({ kind: "doc-submit", paths: [artifactPath] }, workerBinding);
  assert.equal(artifactSync.outcome, "applied", JSON.stringify(artifactSync));
  await waitForFixturePublication(cell, artifactSync.opId, workerBinding);
  writeFileSync(
    path.join(rootDir, "harness", `${packagePath}/closeout.md`),
    `# Closeout\n\n## Summary\n\nDone: artifact:${artifactPath}@${artifactSync.revision}\n\n` +
      "## Verification\n\nVerified.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNo sibling mechanism in this fixture.\n",
  );
  assert.equal(
    (await cell.run({ kind: "doc-submit", paths: [`${packagePath}/closeout.md`] }, workerBinding)).outcome,
    "applied",
  );
}

test("settle rejoins the owner executor-less and preserves the worker's executor attribution", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settle-rejoin-")),
    repoId = workspaceId("settle-rejoin"),
    taskId = "task_settle_rejoin",
    executionId = "exe_settle_rejoin";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "settle-rejoin" });
    await reachDeliverable(cell, rootDir, taskId, executionId);
    assert.equal((await cell.run({ kind: "task-release", taskId }, workerBinding)).outcome, "applied");

    const settled = (await cell.run({ kind: "task-settle", taskId }, ownerRejoinBinding)) as Record<string, unknown>;
    assert.equal(settled.outcome, "applied", JSON.stringify(settled));

    const reader = makeTaskEventReader({ repoId, rootDir }),
      submitted = reader.read().events.filter((event) => event.type === "execution_submitted");
    assert.equal(submitted.length, 1, "settle publishes exactly one submission cut");
    const event = submitted[0]!;
    if (event.type !== "execution_submitted") throw new Error("missing submission event");
    assert.equal(event.payload.execution.actor.executor?.id, "worker-runtime");
    assert.equal(event.actor.executor, null);
    await reader.drain();
  } finally {
    await cell?.close();
    await removeTemporaryDirectory(rootDir);
  }
});

test("settle replaces executor attribution on declared-executor handoff and foreign takeover", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settle-handoff-")),
    repoId = workspaceId("settle-handoff"),
    taskId = "task_settle_handoff",
    executionId = "exe_settle_handoff";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "settle-handoff" });
    await reachDeliverable(cell, rootDir, taskId, executionId);
    assert.equal((await cell.run({ kind: "task-release", taskId }, workerBinding)).outcome, "applied");

    const handed = (await cell.run({ kind: "task-settle", taskId }, handoffBinding)) as Record<string, unknown>;
    assert.equal(handed.outcome, "applied", JSON.stringify(handed));
    const reader = makeTaskEventReader({ repoId, rootDir }),
      events = reader.read().events,
      starts = events.filter((event) => event.type === "execution_started"),
      rejoin = starts.at(-1)!;
    if (rejoin.type !== "execution_started") throw new Error("missing rejoin event");
    assert.equal(rejoin.payload.execution.actor.executor?.id, "handoff-runtime");
    const submitted = events.filter((event) => event.type === "execution_submitted");
    assert.equal(submitted.length, 1);
    await reader.drain();
  } finally {
    await cell?.close();
    await removeTemporaryDirectory(rootDir);
  }
});

test("a different-person takeover rejoin does not inherit the recorded executor", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settle-takeover-")),
    repoId = workspaceId("settle-takeover"),
    taskId = "task_settle_takeover",
    executionId = "exe_settle_takeover";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "settle-takeover" });
    await reachDeliverable(cell, rootDir, taskId, executionId);
    assert.equal((await cell.run({ kind: "task-release", taskId }, workerBinding)).outcome, "applied");

    const started = (await cell.run({ kind: "task-start", taskId, executionId }, peerBinding)) as Record<
      string,
      unknown
    >;
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const reader = makeTaskEventReader({ repoId, rootDir }),
      rejoin = reader
        .read()
        .events.filter((event) => event.type === "execution_started")
        .at(-1)!;
    if (rejoin.type !== "execution_started") throw new Error("missing rejoin event");
    assert.equal(rejoin.payload.execution.actor.principal.personId, "person-peer");
    assert.equal(rejoin.payload.execution.actor.executor, null);
    await reader.drain();
  } finally {
    await cell?.close();
    await removeTemporaryDirectory(rootDir);
  }
});

test("settle refuses to resume another holder's submitted cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settle-foreign-")),
    repoId = workspaceId("settle-foreign"),
    taskId = "task_settle_foreign",
    executionId = "exe_settle_foreign";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "settle-foreign" });
    await reachDeliverable(cell, rootDir, taskId, executionId);
    assert.equal((await cell.run({ kind: "task-settle", taskId }, workerBinding)).outcome, "applied");

    const resumed = (await cell.run({ kind: "task-settle", taskId }, workerBinding)) as Record<string, unknown>;
    assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
    const foreign = (await cell.run({ kind: "task-settle", taskId }, peerBinding)) as Record<string, unknown>;
    assert.notEqual(foreign.outcome, "applied", JSON.stringify(foreign));
    const reader = makeTaskEventReader({ repoId, rootDir });
    assert.equal(reader.read().events.filter((event) => event.type === "execution_submitted").length, 1);
    await reader.drain();
  } finally {
    await cell?.close();
    await removeTemporaryDirectory(rootDir);
  }
});

test("settle submits then stops with structured guidance when the preset snapshot drifted", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settle-preset-")),
    repoId = workspaceId("settle-preset"),
    taskId = "task_settle_preset",
    executionId = "exe_settle_preset",
    source = path.join(rootDir, "source/upgrade-task"),
    packageBody = (version: string) =>
      JSON.stringify({
        schema: "preset-manifest/v3",
        id: "upgrade-task",
        title: "Upgrade Task",
        vertical: "software/coding",
        version,
        kind: "template-content",
        outputShape: "repository-diff",
        kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
        capabilityImports: [],
        profiles: [
          {
            id: "baseline",
            title: "Baseline",
            completionGates: ["ci", "code-doc-reconciliation"],
            templateSelections: [],
          },
        ],
        defaultProfile: "baseline",
      });
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "preset.json"), packageBody("3.1.0"));
    writeFileSync(
      path.join(source, "PRESET.md"),
      "---\nschema: preset-document/v1\ndescription: Upgrade fixture.\nwhenToUse: Test upgrade.\n---\n# Upgrade\n",
    );
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "settle-preset" });
    assert.equal(
      (await cell.run({ kind: "preset-install", packageSource: "source/upgrade-task" }, workerBinding)).outcome,
      "pending",
    );
    const title = "Settle Preset";
    await createRealizedTaskPlanFixture(
      rootDir,
      async () => {
        const created = await cell!.run(
          { kind: "task-create", taskId, title, presetId: "upgrade-task" },
          workerBinding,
        );
        const shown = await cell!.run(
          { kind: "receipt-show", opId: created.opId, waitFor: ["worktree_visible"], timeoutMs: 5_000 },
          workerBinding,
        );
        assert.equal(shown.wait?.state, "satisfied", JSON.stringify(shown));
        return created;
      },
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, workerBinding),
      title,
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "fact-record",
            taskId,
            statement: "The task has completion evidence.",
            evidenceSource: "test:settle-lifecycle",
            confidence: "high",
            memoryClass: "episodic",
            memoryTags: [],
          },
          workerBinding,
        )
      ).outcome,
      "applied",
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, workerBinding)).outcome, "applied");
    const packagePath = `tasks/${taskId}-settle-preset`,
      artifactPath = `${packagePath}/artifacts/verification.md`;
    mkdirSync(path.dirname(path.join(rootDir, "harness", artifactPath)), { recursive: true });
    writeFileSync(path.join(rootDir, "harness", artifactPath), "Verified fixture delivery.\n");
    const artifactSync = await cell.run({ kind: "doc-submit", paths: [artifactPath] }, workerBinding);
    assert.equal(artifactSync.outcome, "applied", JSON.stringify(artifactSync));
    await waitForFixturePublication(cell, artifactSync.opId, workerBinding);
    writeFileSync(
      path.join(rootDir, "harness", `${packagePath}/closeout.md`),
      `# Closeout\n\n## Summary\n\nDone: artifact:${artifactPath}@${artifactSync.revision}\n\n` +
        "## Verification\n\nVerified.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNo sibling mechanism in this fixture.\n",
    );
    assert.equal(
      (await cell.run({ kind: "doc-submit", paths: [`${packagePath}/closeout.md`] }, workerBinding)).outcome,
      "applied",
    );
    // The recorded snapshot is still the 3.1.0 package; reinstalling 3.2.0 moves the
    // compiled digest, so the post-submit preset check must stop with upgrade guidance.
    writeFileSync(path.join(source, "preset.json"), packageBody("3.2.0"));
    assert.equal(
      (await cell.run({ kind: "preset-install", packageSource: "source/upgrade-task" }, workerBinding)).outcome,
      "pending",
    );

    const settled = (await cell.run({ kind: "task-settle", taskId }, workerBinding)) as Record<string, unknown>;
    assert.equal(settled.outcome, "op_rejected", JSON.stringify(settled));
    assert.equal(settled.code, "preset_snapshot_mismatch", JSON.stringify(settled));
    const next = (settled.next as readonly { readonly action: string }[] | undefined)?.map((entry) => entry.action);
    assert.ok(
      next?.some((action) => action.includes(`ha preset upgrade ${taskId}`)),
      JSON.stringify(settled.next),
    );
    const reader = makeTaskEventReader({ repoId, rootDir });
    assert.equal(reader.read().events.filter((event) => event.type === "execution_submitted").length, 1);
    await reader.drain();
  } finally {
    await cell?.close();
    await removeTemporaryDirectory(rootDir);
  }
});

test("settle stops on the closeout gate instead of fabricating a draft", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settle-closeout-")),
    repoId = workspaceId("settle-closeout"),
    taskId = "task_settle_closeout",
    executionId = "exe_settle_closeout";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "settle-closeout" });
    const title = "Settle Closeout";
    await createRealizedTaskPlanFixture(
      rootDir,
      async () => {
        const created = await cell!.run({ kind: "task-create", taskId, title, presetId: "docs-task" }, workerBinding);
        const shown = await cell!.run(
          { kind: "receipt-show", opId: created.opId, waitFor: ["worktree_visible"], timeoutMs: 5_000 },
          workerBinding,
        );
        assert.equal(shown.wait?.state, "satisfied", JSON.stringify(shown));
        return created;
      },
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, workerBinding),
      title,
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "fact-record",
            taskId,
            statement: "The task has completion evidence.",
            evidenceSource: "test:settle-lifecycle",
            confidence: "high",
            memoryClass: "episodic",
            memoryTags: [],
          },
          workerBinding,
        )
      ).outcome,
      "applied",
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, workerBinding)).outcome, "applied");

    const settled = (await cell.run({ kind: "task-settle", taskId }, workerBinding)) as Record<string, unknown>;
    assert.equal(settled.outcome, "op_rejected", JSON.stringify(settled));
    const reader = makeTaskEventReader({ repoId, rootDir });
    assert.equal(
      reader.read().events.some((event) => event.type === "execution_submitted"),
      false,
    );
    await reader.drain();
  } finally {
    await cell?.close();
    await removeTemporaryDirectory(rootDir);
  }
});
