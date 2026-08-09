// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { useGitCanonicalPublicationInspector } from "../../../tools/publication-inspector-test-fixture.mjs";
import { removeTemporaryTestRoot } from "../../../tools/test-temp-root-cleanup.mjs";
import {
  assertPendingReceiptSettlement,
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonAsync,
  runRawJsonMaybeFail,
  stopDaemon,
  waitForReceiptCommitted
} from "./helpers/daemon-cli.ts";
import {
  authorityEventBodies,
  authorityOperationRecords,
  createFixture
} from "./production-authority-canonical-ingress/fixture.ts";
import { publishSeededTaskFixture } from "./helpers/canonical-task-publication-fixture.ts";

test("PR canonical ingress keeps two interleaved session receipts determinate", { timeout: 60_000 }, async (context) => {
  const fixture = createFixture();
  const inspector = useGitCanonicalPublicationInspector(context, {
    rootDir: fixture.authoredRoot,
    removeRoot: async () => await removeTemporaryTestRoot(fixture.root)
  });
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    CODEX_THREAD_ID: "canonical-ingress-pr-tracer"
  };
  try {
    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical", "--canonical-root", fixture.repoRoot,
      "--user-root", userRoot, "--no-link", "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    try {
      runDaemonCommand(fixture.repoRoot, [
        "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
      ], env);
    } catch {
      // Keep observing the detached production service when startup outlives
      // the CLI command's fixed reachability wait.
    }
    const status = await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (value) => value.reachable === true,
      (value, error) => JSON.stringify({ value, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    assert.equal(status.repoCount, 1, JSON.stringify(status));

    const appended = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "progress", "append", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4",
      "--text", "PR canonical ingress tracer"
    ], env);
    assert.equal(appended.status, 0, JSON.stringify(appended.receipt));
    assert.equal(appended.receipt.ok, true, JSON.stringify(appended.receipt));
    const appendedPending = assertPendingReceiptSettlement(appended.receipt);
    await waitForReceiptCommitted(fixture.repoRoot, appendedPending.receiptId, env);
    const appendedOperations = await waitForCommittedAuthorityOperations(
      fixture.serviceRoot,
      appendedPending.authorityOperationIds
    );
    assert.match(readFileSync(path.join(
      fixture.authoredRoot,
      "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/progress.md"
    ), "utf8"), /PR canonical ingress tracer/u);

    const progressOperations = appendedOperations.filter((record) =>
      record.canonicalOperation?.kind === "progress_append");
    assert.equal(progressOperations.length, 1, JSON.stringify(appendedOperations));
    const operation = progressOperations[0]!;
    assert.equal(operation.state, "COMMITTED", JSON.stringify(operation));
    assert.equal(operation.receipt?.tag, "COMMITTED", JSON.stringify(operation));
    assert.equal(appendedPending.authorityOperationIds.includes(operation.opId!), true, JSON.stringify(operation));
    assert.equal(typeof operation.opId, "string", JSON.stringify(operation));
    const publication = await inspector.findPublicationForOperation(operation.opId!);
    assert.equal(publication.commitSha, operation.commitSha);
    assert.equal(publication.physicalChanges.some((change) => change.path ===
      "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/progress.md"), true);
    assert.equal(publication.physicalChanges.some((change) => change.path.startsWith("attribution-events/")), true);

    const interleaved = await Promise.all([
      runRawJsonAsync(fixture.repoRoot, [
        "task", "progress", "append", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4",
        "--text", "interleaved publication from alpha"
      ], { ...env, CODEX_THREAD_ID: "canonical-ingress-interleaved-alpha" }),
      runRawJsonAsync(fixture.repoRoot, [
        "task", "progress", "append", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4",
        "--text", "interleaved publication from beta"
      ], { ...env, CODEX_THREAD_ID: "canonical-ingress-interleaved-beta" })
    ]);
    assert.equal(interleaved.every((receipt) => receipt.ok === true), true, JSON.stringify(interleaved));
    const interleavedPending = interleaved.map((receipt) => assertPendingReceiptSettlement(receipt));
    assert.equal(new Set(interleavedPending.map((pending) => pending.receiptId)).size, 2);
    await Promise.all(interleavedPending.map((pending) =>
      waitForReceiptCommitted(fixture.repoRoot, pending.receiptId, env)
    ));
    const interleavedOperationIds = interleavedPending.flatMap((pending) => pending.authorityOperationIds);
    assert.equal(new Set(interleavedOperationIds).size, interleavedOperationIds.length);
    const committedInterleaved = await waitForCommittedAuthorityOperations(
      fixture.serviceRoot,
      interleavedOperationIds
    );
    assert.doesNotMatch(
      JSON.stringify(interleaved),
      /repo_write_outcome_unknown|AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR/u
    );
    const progress = readFileSync(path.join(
      fixture.authoredRoot,
      "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/progress.md"
    ), "utf8");
    assert.match(progress, /interleaved publication from alpha/u);
    assert.match(progress, /interleaved publication from beta/u);
    const interleavedRecords = committedInterleaved
      .filter((record) => record.canonicalOperation?.kind === "progress_append");
    assert.equal(interleavedRecords.length, 2, JSON.stringify(interleavedRecords));
    const authorityOrder = interleavedRecords.map((record) => {
      assert.equal(record.receipt?.tag, "COMMITTED", JSON.stringify(record));
      const append = (record.canonicalOperation?.payload as { readonly append?: unknown })?.append;
      assert.equal(typeof append, "string", JSON.stringify(record));
      const label = append.includes("alpha")
        ? "interleaved publication from alpha"
        : append.includes("beta")
          ? "interleaved publication from beta"
          : undefined;
      assert.ok(label, JSON.stringify(record));
      return { label, revision: record.receipt.revision };
    }).sort((left, right) => left.revision - right.revision);
    assert.ok(authorityOrder[0]!.revision < authorityOrder[1]!.revision, JSON.stringify(authorityOrder));
    const physicalOrder = [
      "interleaved publication from alpha",
      "interleaved publication from beta"
    ].sort((left, right) => progress.indexOf(left) - progress.indexOf(right));
    assert.deepEqual(physicalOrder, authorityOrder.map((entry) => entry.label));
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
  }
});

test("commit-anchor completion crosses production authority with daemon judgment and atomic task transition", { timeout: 60_000 }, async (context) => {
  const fixture = createFixture();
  const inspector = useGitCanonicalPublicationInspector(context, {
    rootDir: fixture.authoredRoot,
    removeRoot: async () => await removeTemporaryTestRoot(fixture.root)
  });
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNY0";
  const taskRoot = path.join(fixture.authoredRoot, "tasks", taskId);
  const sessionId = "commit-anchor-authority-tracer";
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    CODEX_THREAD_ID: sessionId
  };
  try {
    const completeHelp = execFileSync(process.execPath, [
      path.resolve("packages/cli/src/index.ts"), "--root", fixture.repoRoot,
      "task", "complete", "--help"
    ], { encoding: "utf8" });
    assertHelpOrder(completeHelp, [
      "Required sequence for --commit-anchor:",
      "1. git rev-parse HEAD",
      "2. ha task code-doc reconcile <task-id> --commit <anchor-commit>",
      "do not add --path or --pr",
      "3. ha task complete <task-id> --commit-anchor <anchor-commit> --judgment <reason> --ci passed"
    ]);
    mkdirSync(path.join(fixture.repoRoot, "tools"), { recursive: true });
    copyFileSync(
      path.resolve("tools/write-road-registry.json"),
      path.join(fixture.repoRoot, "tools/write-road-registry.json")
    );
    mkdirSync(taskRoot, { recursive: true });
    const sourceIndex = readFileSync(path.join(
      fixture.authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/INDEX.md"
    ), "utf8");
    writeFileSync(path.join(taskRoot, "INDEX.md"), sourceIndex.replaceAll("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", taskId));
    writeFileSync(path.join(taskRoot, "task_plan.md"), productionPlan("Complete from a public workspace commit."));
    writeFileSync(path.join(taskRoot, "closeout.md"), [
      "# Closeout", "", "## Summary", "", "The public commit completes the task.", "",
      "## Verification", "", "Authority verifies the commit and anchor.", "",
      "## Residual Risk", "", "None known.", ""
    ].join("\n"));
    writeFileSync(path.join(taskRoot, "code-doc-anchors.json"), `${JSON.stringify({
      schema: "code-doc-reconciliation/v1",
      taskId,
      records: [{
        id: "closeout", ledgerPath: "closeout.md", kind: "closeout",
        anchors: [{ kind: "commit", sha: fixture.publicHead }, { kind: "path", sha: fixture.publicHead, path: "README.md" }]
      }]
    }, null, 2)}\n`);
    writeFileSync(path.join(fixture.authoredRoot, "harness.yaml"), [
      "schema: harness-anything/v1", "project: production-ingress", "settings:", "  tasks:", "    leaseEnforcement: true", ""
    ].join("\n"));
    execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "add", "."], { cwd: fixture.authoredRoot });
    execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-q", "-m", "seed commit completion fixture"], { cwd: fixture.authoredRoot });
    publishSeededTaskFixture(fixture.authoredRoot, taskRoot, taskId);

    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical", "--canonical-root", fixture.repoRoot,
      "--user-root", userRoot, "--no-link", "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    try {
      runDaemonCommand(fixture.repoRoot, [
        "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
      ], env);
    } catch {
      // Observe the detached service if startup exceeds the CLI reachability wait.
    }
    await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (value) => value.reachable === true,
      (value, error) => JSON.stringify({ value, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );

    const exported = runRawJsonMaybeFail(fixture.repoRoot, [
      "session", "export", "--session", sessionId, "--runtime", "codex", "--source", "runtime",
      "--detected-at", "2026-07-31T00:00:00.000Z", "--transcript-file", fixture.transcriptPath
    ], env);
    assert.equal(exported.status, 0, JSON.stringify(exported.receipt));

    // Establish the immutable prepublish witness independently of the completion
    // receipt. The completion client does not inspect this receipt or derive a
    // follow-up step; the daemon verifier later finds this first-parent materialization.
    writeFileSync(
      path.join(taskRoot, "task_plan.md"),
      readFileSync(path.join(taskRoot, "task_plan.md"), "utf8").replace(
        "Complete from a public workspace commit.",
        "Canonical prepublish snapshot established for completion."
      )
    );
    const prepublished = runRawJsonMaybeFail(fixture.repoRoot, [
      "doc", "sync", "--submit", "--path", `tasks/${taskId}/task_plan.md`
    ], env);
    assert.equal(prepublished.status, 0, JSON.stringify(prepublished.receipt));
    assert.equal(prepublished.receipt.ok, true, JSON.stringify(prepublished.receipt));
    const materialized = runRawJsonMaybeFail(fixture.repoRoot, ["materializer", "run"], env);
    assert.equal(materialized.status, 0, JSON.stringify(materialized.receipt));
    assert.equal(materialized.receipt.ok, true, JSON.stringify(materialized.receipt));
    const reconciled = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "code-doc", "reconcile", taskId,
      "--commit", fixture.publicHead, "--force"
    ], env);
    assert.equal(reconciled.status, 0, JSON.stringify(reconciled.receipt));
    const witnessMaterialized = runRawJsonMaybeFail(fixture.repoRoot, ["materializer", "run"], env);
    assert.equal(witnessMaterialized.status, 0, JSON.stringify(witnessMaterialized.receipt));

    const completed = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "complete", taskId,
      "--commit-anchor", fixture.publicHead,
      "--judgment", "The anchored public workspace commit satisfies this task's implementation and verification scope.",
      "--ci", "passed"
    ], env);
    assert.equal(completed.status, 0, JSON.stringify(completed.receipt));
    assert.equal(completed.receipt.ok, true, JSON.stringify(completed.receipt));
    const completedPending = assertPendingReceiptSettlement(completed.receipt);
    await waitForReceiptCommitted(fixture.repoRoot, completedPending.receiptId, env);
    const completedOperations = await waitForCommittedAuthorityOperations(
      fixture.serviceRoot,
      completedPending.authorityOperationIds
    );
    const evidencePath = path.join(taskRoot, "completion-evidence.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, any>;
    assert.equal(evidence.mode, "commit-anchor");
    assert.equal(evidence.anchor.sha, fixture.publicHead);
    assert.equal(evidence.judgment.actor.principal.personId, "person_alice");
    assert.deepEqual(evidence.judgment.actor.executor, { kind: "agent", id: "codex" });
    assert.equal(evidence.judgment.sessionRef, `session/${sessionId}`);
    assert.deepEqual(evidence.gateReceipt.applicableGates, ["ci", "code-doc-reconciliation"]);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /status: done/u);
    assert.equal(authorityEventBodies(fixture.authoredRoot).some((body) =>
      body.includes(sessionId) && body.includes(`task/${taskId}`)
    ), true);

    const completionOperations = completedOperations.filter((record) =>
      record.authorityIntegrity?.canonicalMutationSet.mutations.some((mutation) =>
        mutation.entity.entityKind === "task" && mutation.action.action === "transition"));
    assert.equal(completionOperations.length, 1, JSON.stringify(completedOperations));
    const operation = completionOperations[0]!;
    assert.deepEqual(
      operation.authorityIntegrity?.canonicalMutationSet.mutations.map((mutation) => [mutation.entity.entityKind, mutation.action.action]),
      [["task", "document"], ["task", "transition"]]
    );
    const publication = await inspector.findPublicationForOperation(operation.opId!);
    assert.equal(publication.physicalChanges.some((change) => change.path === `tasks/${taskId}/completion-evidence.json`), true);
    assert.equal(publication.physicalChanges.some((change) => change.path === `tasks/${taskId}/INDEX.md`), true);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
  }
});

async function waitForCommittedAuthorityOperations(
  serviceRoot: string,
  opIds: ReadonlyArray<string>
) {
  assert.ok(opIds.length > 0, "pending receipt must identify its authority operations");
  const records = await pollUntil(
    () => authorityOperationRecords(serviceRoot),
    (candidate) => {
      const byId = new Map(candidate.map((record) => [record.opId, record]));
      return opIds.every((opId) => byId.get(opId)?.state === "COMMITTED");
    },
    (candidate, error) => JSON.stringify({ opIds, candidate, error: String(error ?? "") }),
    { timeoutMs: 20_000 }
  );
  const byId = new Map(records.map((record) => [record.opId, record]));
  return opIds.map((opId) => byId.get(opId)!);
}

test("doc sync submit dispatches prose to the production writer child", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0";
  const planPath = path.join(fixture.authoredRoot, `tasks/${taskId}/task_plan.md`);
  const sessionBranch = "sessions/doc-sync-production-writer-child";
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    CODEX_THREAD_ID: "doc-sync-production-writer-child"
  };
  try {
    mkdirSync(path.join(fixture.repoRoot, "tools"), { recursive: true });
    copyFileSync(
      path.resolve("tools/write-road-registry.json"),
      path.join(fixture.repoRoot, "tools/write-road-registry.json")
    );
    writeFileSync(planPath, productionPlan("Original governed prose."));
    execFileSync("git", [
      "-c", "user.name=Harness Test",
      "-c", "user.email=harness@example.test",
      "add", `tasks/${taskId}/task_plan.md`
    ], { cwd: fixture.authoredRoot });
    execFileSync("git", [
      "-c", "user.name=Harness Test",
      "-c", "user.email=harness@example.test",
      "commit", "-q", "-m", "seed doc sync fixture"
    ], { cwd: fixture.authoredRoot });
    const trunkBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: fixture.authoredRoot,
      encoding: "utf8"
    }).trim();

    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot,
      "--no-link", "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    try {
      runDaemonCommand(fixture.repoRoot, [
        "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
      ], env);
    } catch {
      // Startup can outlive the command's reachability wait.
    }
    await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, [
        "daemon", "status", "--user-root", userRoot, "--json"
      ], env),
      (value) => value.reachable === true,
      (value, error) => JSON.stringify({ value, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    writeFileSync(planPath, productionPlan("Updated through the writer child."));

    const submitted = runRawJsonMaybeFail(fixture.repoRoot, [
      "doc", "sync", "--submit"
    ], env);
    assert.equal(submitted.status, 0, JSON.stringify(submitted.receipt));
    assert.equal(submitted.receipt.ok, true, JSON.stringify(submitted.receipt));
    assert.equal(submitted.receipt.details?.data?.report?.status, "accepted");
    assert.equal(
      submitted.receipt.details?.data?.report?.appliedChanges?.length,
      1,
      JSON.stringify(submitted.receipt)
    );
    assert.equal(
      submitted.receipt.details?.data?.report?.appliedChanges?.[0]?.path,
      `tasks/${taskId}/task_plan.md`,
      JSON.stringify(submitted.receipt)
    );
    // Worktree contract (dec_01KZJMH1CZX3ZXBRJYG8WZA1F3): the publisher must
    // never checkout/reset the shared user worktree. HEAD stays on the trunk
    // branch (the sha may advance if the background materializer merges the
    // session before this assertion runs), and the authored file keeps the
    // user's submitted content through the whole publication window. The
    // path may read as modified until the materializer lands the merge, so
    // index cleanliness is intentionally not asserted here.
    assert.equal(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: fixture.authoredRoot,
        encoding: "utf8"
      }).trim(),
      trunkBranch
    );
    assert.match(readFileSync(planPath, "utf8"), /Updated through the writer child/u);
    assert.match(
      execFileSync("git", ["show", `${sessionBranch}:tasks/${taskId}/task_plan.md`], {
        cwd: fixture.authoredRoot,
        encoding: "utf8"
      }),
      /Updated through the writer child/u
    );
    assert.match(
      execFileSync("git", ["log", "-1", "--format=%s", sessionBranch], {
        cwd: fixture.authoredRoot,
        encoding: "utf8"
      }).trim(),
      /^entity\(doc-sync-submit\): doc-sync\//u
    );
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function productionPlan(goal: string): string {
  return [
    "# Plan", "",
    "## Brief", "Brief.",
    "## Goal", goal,
    "## Context", "Context.",
    "## Constraints", "Constraints.",
    "## Checkpoint", "Checkpoint.",
    "## CI/Gate Authority Stop Condition", "Stop.",
    "## Implementation Plan", "Plan.",
    "## Verification", "Verify.",
    ""
  ].join("\n");
}

function assertHelpOrder(help: string, fragments: ReadonlyArray<string>): void {
  let previous = -1;
  for (const fragment of fragments) {
    const index = help.indexOf(fragment, previous + 1);
    assert.ok(index > previous, `Expected help fragment after offset ${previous}: ${fragment}\n${help}`);
    previous = index;
  }
}
