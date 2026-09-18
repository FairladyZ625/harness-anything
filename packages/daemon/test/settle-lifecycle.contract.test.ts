// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  options: { publicDelivery?: boolean; syncCloseout?: boolean } = {},
): Promise<void> {
  const title = "Settle Lifecycle";
  await createRealizedTaskPlanFixture(
    rootDir,
    async () => {
      const created = await cell.run(
        { kind: "task-create", taskId, title, presetId: options.publicDelivery ? "standard-task" : "docs-task" },
        workerBinding,
      );
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
  let summary = `Done: artifact:${artifactPath}@${artifactSync.revision}`;
  if (options.publicDelivery) {
    writeFileSync(path.join(rootDir, "delivery.md"), "# Delivered documentation\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
    git("add", "delivery.md");
    git("commit", "-qm", "docs: fixture delivery");
    summary = `Delivered ${git("rev-parse", "HEAD")}`;
  }
  writeFileSync(
    path.join(rootDir, "harness", `${packagePath}/closeout.md`),
    `# Closeout\n\n## Summary\n\n${summary}\n\n` +
      "## Verification\n\nVerified.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNo sibling mechanism in this fixture.\n",
  );
  if (options.syncCloseout === false) return;
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
    await reachDeliverable(cell, rootDir, taskId, executionId, { syncCloseout: false });
    assert.equal((await cell.run({ kind: "task-release", taskId }, workerBinding)).outcome, "applied");

    const settled = (await cell.run({ kind: "task-settle", taskId }, ownerRejoinBinding)) as Record<string, unknown>;
    assert.equal(settled.outcome, "applied", JSON.stringify(settled));

    const replay = await cell.run({ kind: "task-settle", taskId }, ownerRejoinBinding);
    assert.equal(replay.outcome, "applied", JSON.stringify(replay));
    assert.equal(replay.opId, settled.opId, "same owner resumes the original operation");
    const reader = makeTaskEventReader({ repoId, rootDir }),
      submitted = reader.read().events.filter((event) => event.type === "execution_submitted");
    assert.equal(submitted.length, 1, "settle publishes exactly one submission cut");
    const event = submitted[0]!;
    if (event.type !== "execution_submitted") throw new Error("missing submission event");
    assert.equal(event.payload.execution.actor.executor?.id, "worker-runtime");
    assert.equal(event.actor.executor, null);
    assert.equal(event.source, "local");
    const starts = reader.read().events.filter((entry) => entry.type === "execution_started");
    assert.equal(starts.at(-1)?.actor.executor, null, "rejoin caller is the lease holder");
    const closeout = path.join(rootDir, "harness", `tasks/${taskId}-settle-lifecycle/closeout.md`),
      original = readFileSync(closeout, "utf8");
    writeFileSync(closeout, original.replace("Verified.", "Changed verification."));
    const beforeForeign = reader.read().revision;
    for (const caller of [workerBinding, peerBinding, { ...ownerRejoinBinding, source: "remote_direct" as const }]) {
      const foreign = await cell.run({ kind: "task-settle", taskId }, caller);
      assert.equal(foreign.outcome, "op_rejected");
      assert.equal(reader.read().revision, beforeForeign, "recovery authority rejects before doc side effects");
    }
    const changed = await cell.run({ kind: "task-settle", taskId }, ownerRejoinBinding);
    assert.equal(changed.code, "invalid_transition", JSON.stringify(changed));
    assert.equal(reader.read().events.filter((entry) => entry.type === "execution_submitted").length, 1);
    assert.match(JSON.stringify(changed), /--as-owner/u, "owner recovery guidance must preserve attribution");
    const amended = await cell.run({ kind: "task-submit", taskId, amend: true, asOwner: true }, ownerRejoinBinding);
    assert.equal(amended.outcome, "applied", JSON.stringify(amended));
    const shown = await cell.run({ kind: "task-show", taskId }, ownerRejoinBinding);
    assert.match(String(shown.evidence), /Changed verification/u);
    assert.equal(
      reader
        .read()
        .events.filter((entry) => entry.type === "execution_submitted")
        .at(-1)?.payload.execution.actor.executor?.id,
      "worker-runtime",
    );

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

test("settle submits then migrates a drifted preset snapshot with a real upgrade event", async () => {
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
    // compiled digest, so settle runs the same atomic preset upgrade itself instead of
    // bouncing the agent on preset_snapshot_mismatch.
    writeFileSync(path.join(source, "preset.json"), packageBody("3.2.0"));
    assert.equal(
      (await cell.run({ kind: "preset-install", packageSource: "source/upgrade-task" }, workerBinding)).outcome,
      "pending",
    );

    const settled = (await cell.run({ kind: "task-settle", taskId }, workerBinding)) as Record<string, unknown>;
    assert.equal(settled.outcome, "applied", JSON.stringify(settled));
    const reader = makeTaskEventReader({ repoId, rootDir }),
      events = reader.read().events;
    assert.equal(events.filter((event) => event.type === "execution_submitted").length, 1);
    assert.equal(
      events.filter((event) => event.type === "preset_snapshot_upgraded").length,
      1,
      "settle migrates the drifted snapshot with a real upgrade event, not a forged digest",
    );
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

test("owner retries preparation failure on the same submitted cut without a second submit event", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settle-prepare-")),
    repoId = workspaceId("settle-prepare"),
    taskId = "task_settle_prepare",
    executionId = "exe_settle_prepare";
  initRepo(rootDir);
  let armed = false,
    interrupted = false;
  const cell = await openRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "settle-prepare",
    killpoint: (point) => {
      if (
        armed &&
        point === "before_event_write" &&
        reader.read().events.some((event) => event.type === "execution_submitted")
      ) {
        interrupted = true;
        throw new Error("fixture interrupts evidence preparation after submission");
      }
    },
  });
  const reader = makeTaskEventReader({ repoId, rootDir });
  try {
    await reachDeliverable(cell, rootDir, taskId, executionId, { publicDelivery: true });
    assert.equal((await cell.run({ kind: "task-release", taskId }, workerBinding)).outcome, "applied");
    armed = true;
    const failed = await cell.run({ kind: "task-settle", taskId }, ownerRejoinBinding);
    assert.equal(interrupted, true, JSON.stringify(failed));
    // The outer receipt preserves the already durable submission while reporting the
    // interrupted follow-up; it must not imply the missing witness was prepared.
    assert.equal(failed.code, "publication_indeterminate", JSON.stringify(failed));
    assert.equal(
      reader.read().events.some((event) => event.type === "code_doc_reconciled"),
      false,
    );
    armed = false;
    const cut = reader.read().events.find((event) => event.type === "execution_submitted");
    assert.ok(cut);
    const resumed = await cell.run({ kind: "task-settle", taskId }, ownerRejoinBinding);
    assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
    assert.deepEqual(
      reader.read().events.filter((event) => event.type === "execution_submitted"),
      [cut],
    );
    assert.ok(reader.read().events.some((event) => event.type === "code_doc_reconciled"));
  } finally {
    await cell.close();
    await reader.drain();
    await removeTemporaryDirectory(rootDir);
  }
});

test("settle preserves the submitted file manifest after main merges the delivery", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settle-merged-")),
    repoId = workspaceId("settle-merged"),
    taskId = "task_settle_merged",
    executionId = "exe_settle_merged",
    git = (...args: string[]) => execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    writeFileSync(path.join(rootDir, "retired.txt"), "old delivery path\n");
    git("add", "retired.txt");
    git("commit", "-qm", "test: seed removed path");
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "settle-merged" });
    await reachDeliverable(cell, rootDir, taskId, executionId, { publicDelivery: true });
    await cell.close();
    cell = undefined;
    const closeout = path.join(rootDir, "harness", `tasks/${taskId}-settle-lifecycle/closeout.md`),
      original = readFileSync(closeout, "utf8"),
      firstDelivery = original.match(/\b[0-9a-f]{40}\b/u)?.[0];
    assert.ok(firstDelivery);
    const base = git("rev-parse", `${firstDelivery}^1`);
    git("update-ref", "refs/remotes/origin/main", base);
    git("rm", "retired.txt");
    git("commit", "-qm", "test: remove an earlier delivery path");
    writeFileSync(path.join(rootDir, "later.md"), "# Later delivery\n");
    git("add", "later.md");
    git("commit", "-qm", "test: finish multi-commit delivery");
    const delivery = git("rev-parse", "HEAD");
    writeFileSync(closeout, original.replace(firstDelivery, delivery));
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "settle-merged" });
    const first = await cell.run({ kind: "task-settle", taskId }, workerBinding);
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    const reader = makeTaskEventReader({ repoId, rootDir }),
      submissions = () => reader.read().events.filter((event) => event.type === "execution_submitted"),
      before = submissions();
    assert.equal(before.length, 1);
    const packet = before[0]!.payload.execution.submission!;
    assert.ok(packet.deliverables.includes("delivery.md"));
    assert.ok(packet.deliverables.includes("later.md"));
    assert.ok(packet.outputs.includes("Deleted-Production-Paths: retired.txt"));
    const merged = git("commit-tree", `${delivery}^{tree}`, "-p", base, "-p", delivery, "-m", "test: merge delivery");
    git("update-ref", "refs/remotes/origin/main", merged);
    const replay = await cell.run({ kind: "task-settle", taskId }, workerBinding);
    assert.equal(replay.outcome, "applied", JSON.stringify(replay));
    assert.equal(replay.opId, first.opId);
    assert.deepEqual(submissions(), before, "main advancement must not replace the frozen submission");
    writeFileSync(closeout, readFileSync(closeout, "utf8").replace("Verified.", "Changed verification after merge."));
    const changed = await cell.run({ kind: "task-settle", taskId }, workerBinding);
    assert.equal(changed.code, "invalid_transition", JSON.stringify(changed));
    assert.deepEqual(submissions(), before, "real prose changes still require explicit amendment");
    await reader.drain();
  } finally {
    await cell?.close();
    await removeTemporaryDirectory(rootDir);
  }
});
