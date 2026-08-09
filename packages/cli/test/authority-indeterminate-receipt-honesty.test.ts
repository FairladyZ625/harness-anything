// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator, runLedgerMaterializer, taskEntityId } from "../../kernel/src/index.ts";
import {
  assertPendingReceiptSettlement,
  pollUntil,
  runDaemonCommand,
  runRawJsonAsyncMaybeFail,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import {
  createFixture,
  git,
  latestAuthorityOperation
} from "./production-authority-canonical-ingress/fixture.ts";
import { publishSeededTaskFixture } from "./helpers/canonical-task-publication-fixture.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";

const sourceTaskId = "task_01KZBDD4300HV864TP0F7YZK1J";
const targetTaskId = "task_01KZBCN84T1MDXM2643C07J9FT";
const relationId = "rel_41a981ddac2537bb";
const rationale = "本任务的全部起点数据(265 个 integration 测试的前缀分布、100 提交回放的 97.1% 命中率、回放方法本身)由那条线第一轮产出;它落盘之后本任务才有可比的基准。";

test("task relate reports an inspect-first indeterminate receipt when canonical publication proof races a legal head advance", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, ".daemon-user");
  const gitShimRoot = path.join(fixture.root, "controlled-git-shim");
  const shimArmed = path.join(fixture.root, "stale-head-shim-armed");
  const shimReady = path.join(fixture.root, "stale-head-captured");
  const shimRelease = path.join(fixture.root, "release-stale-head");
  const shimCounter = path.join(fixture.root, "git-shim-head-count");
  const shimCaptured = path.join(fixture.root, "git-shim-captured-head");
  const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_PROFILE: "isolated",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    HARNESS_DAEMON_MATERIALIZER_POLL_MS: "3600000",
    PATH: `${gitShimRoot}:${process.env.PATH ?? ""}`,
    CODEX_THREAD_ID: "receipt-honesty-controlled-relate"
  };
  try {
    seedIncidentTask(fixture.authoredRoot, sourceTaskId);
    seedIncidentTask(fixture.authoredRoot, targetTaskId);
    mkdirSync(gitShimRoot, { recursive: true });
    const gitShimPath = path.join(gitShimRoot, "git");
    writeFileSync(gitShimPath, controlledStaleHeadGitShim({
      realGit,
      authoredRoot: fixture.authoredRoot,
      armedPath: shimArmed,
      readyPath: shimReady,
      releasePath: shimRelease,
      counterPath: shimCounter,
      capturedPath: shimCaptured,
      captureCall: 3
    }));
    chmodSync(gitShimPath, 0o755);

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
      // The detached service can outlive the CLI's fixed startup wait.
    }
    await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (status) => status.reachable === true,
      (status, error) => JSON.stringify({ status, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );

    writeFileSync(shimArmed, "armed\n");
    const relate = runRawJsonAsyncMaybeFail(fixture.repoRoot, [
      "task", "relate", sourceTaskId, "depends-on", targetTaskId, "--rationale", rationale
    ], env);
    await pollUntil(
      () => ({ paused: existsSync(shimReady) }),
      (state) => state.paused,
      (state) => JSON.stringify(state),
      { timeoutMs: 10_000 }
    );

    const staleExpectedPreviousHead = readFileSync(shimCaptured, "utf8").trim();
    assert.equal(git(fixture.authoredRoot, "rev-parse", "HEAD"), staleExpectedPreviousHead);

    const controlledAdvanceHead = publishControlledAuthorityAdvance(fixture.repoRoot);
    const headAfterControlledAdvance = git(fixture.authoredRoot, "rev-parse", "HEAD");
    assert.equal(headAfterControlledAdvance, controlledAdvanceHead);
    assert.notEqual(staleExpectedPreviousHead, headAfterControlledAdvance);
    assert.equal(
      git(fixture.authoredRoot, "rev-parse", `${controlledAdvanceHead}^1`),
      staleExpectedPreviousHead
    );
    assert.equal(
      git(
        fixture.authoredRoot,
        "merge-base",
        "--is-ancestor",
        staleExpectedPreviousHead,
        controlledAdvanceHead
      ),
      ""
    );
    writeFileSync(shimRelease, "release\n");

    const result = await relate;
    if (process.env.HARNESS_CAPTURE_RECEIPT_HONESTY === "1") {
      process.stdout.write(`RECEIPT_HONESTY_CLI_OUTPUT_START\n${result.stdout}RECEIPT_HONESTY_CLI_OUTPUT_END\n`);
    }
    const operation = await pollUntil(
      () => latestAuthorityOperation(fixture.serviceRoot),
      (record) => record.state === "INDETERMINATE",
      (record, error) => JSON.stringify({ record, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    const finalHead = git(fixture.authoredRoot, "rev-parse", "HEAD");
    const finalParents = git(
      fixture.authoredRoot,
      "rev-list",
      "--parents",
      "-n",
      "1",
      finalHead
    ).split(" ").slice(1);
    assert.equal(finalParents.length, 2);
    const finalSessionCommit = finalParents[1];
    assert.ok(finalSessionCommit);
    const finalSessionParents = git(
      fixture.authoredRoot,
      "rev-list",
      "--parents",
      "-n",
      "1",
      finalSessionCommit
    ).split(" ").slice(1);
    assert.deepEqual(finalSessionParents, [finalParents[0]]);
    assert.match(
      git(
        fixture.authoredRoot,
        "show",
        `${finalHead}:tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/progress.md`
      ),
      /controlled canonical head advance before relate publication proof/u
    );
    assert.equal(
      git(
        fixture.authoredRoot,
        "merge-base",
        "--is-ancestor",
        staleExpectedPreviousHead,
        finalHead
      ),
      ""
    );
    assert.equal(git(fixture.authoredRoot, "diff", "--quiet", finalHead, finalSessionCommit), "");
    assert.equal(operation.state, "INDETERMINATE", JSON.stringify(operation));
    assert.equal(operation.receipt?.tag, "INDETERMINATE", JSON.stringify(operation));
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.receipt.ok, true, result.stdout);
    const pending = assertPendingReceiptSettlement(result.receipt);
    assert.deepEqual(pending.authorityOperationIds, [operation.opId]);
    const settlementStatus = await pollUntil(
      () => runDaemonCommand(
        fixture.repoRoot,
        ["receipt", "status", pending.receiptId, "--json"],
        env
      ),
      (receipt) => receipt.details?.data?.state === "settlement-failed",
      (receipt, error) => JSON.stringify({ receipt, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    const failedSettlement = settlementStatus.details?.data?.receipt?.settlement;
    assert.equal(failedSettlement?.canonicalVisibility, "failed", JSON.stringify(settlementStatus));
    assert.equal(failedSettlement?.receiptId, pending.receiptId, JSON.stringify(settlementStatus));
    assert.equal(failedSettlement?.failure?.stage, "publication-proof", JSON.stringify(settlementStatus));
    assert.equal(failedSettlement?.failure?.retryable, true, JSON.stringify(settlementStatus));
    assert.equal(failedSettlement?.failure?.recoveryCommand, "ha materializer run --json", JSON.stringify(settlementStatus));
    const publicationEvidence = String(failedSettlement?.failure?.message);
    assert.match(publicationEvidence, /PUBLICATION_PROOF_FAILED/u);
    assert.match(publicationEvidence, /AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR/u);
    assert.match(publicationEvidence, new RegExp(`expectedPreviousHead=${staleExpectedPreviousHead}`, "u"));
    assert.match(publicationEvidence, new RegExp(`head=${finalHead}`, "u"));
    assert.match(publicationEvidence, new RegExp(`actualParents=${finalParents.join(",")}`, "u"));
    assert.match(publicationEvidence, new RegExp(`actualSessionParents=${finalSessionParents.join(",")}`, "u"));
    assert.match(publicationEvidence, /mergeTreeMatchesSession=true/u);

    const sourceIndex = readFileSync(path.join(fixture.authoredRoot, "tasks", sourceTaskId, "INDEX.md"), "utf8");
    assert.match(sourceIndex, new RegExp(`relation_id: ${relationId}`, "u"));
    assert.match(sourceIndex, new RegExp(`target: task/${targetTaskId}`, "u"));
    if (process.env.HARNESS_CAPTURE_CANONICAL_PUBLICATION_RACE === "1") {
      process.stdout.write([
        "CANONICAL_PUBLICATION_RACE_EVIDENCE_START",
        JSON.stringify({
          expectedPreviousHead: staleExpectedPreviousHead,
          controlledAdvanceHead,
          publicationHead: finalHead,
          publicationParents: finalParents,
          sessionParents: finalSessionParents,
          expectedPreviousHeadIsAncestorOfControlledAdvance: true,
          expectedPreviousHeadIsAncestorOfPublication: true,
          canonicalMutationPresent: true,
          validatorCode: "AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR",
          receiptCode: failedSettlement?.failure?.code,
          inspectFirst: true,
          mergeTreeMatchesSession: true
        }, null, 2),
        "CANONICAL_PUBLICATION_RACE_EVIDENCE_END",
        ""
      ].join("\n"));
    }
  } finally {
    writeFileSync(shimRelease, "release\n");
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function publishControlledAuthorityAdvance(rootDir: string): string {
  const lockPath = path.join(rootDir, ".harness/locks/global.lock");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    readonly ownerToken: string;
    readonly ownerKind?: "daemon";
  };
  const coordinator = makeJournaledWriteCoordinator({
    rootDir,
    heldGlobalLock: { path: lockPath, ownerToken: lock.ownerToken, ownerKind: lock.ownerKind },
    attribution: {
      actor: {
        principal: { kind: "person", personId: "person_fixture" },
        executor: { kind: "agent", id: "fixture-writer" }
      },
      principalSource: {
        kind: "local-configured",
        authority: "harness.yaml",
        authoritySha256: `sha256:${"0".repeat(64)}`
      },
      executorSource: "client-asserted"
    },
    sessionId: "receipt-honesty-controlled-advance",
    commitAuthor: { name: "Harness Test", email: "harness@example.test" }
  });
  Effect.runSync(coordinator.enqueue({
    opId: "op_receipt_honesty_controlled_advance",
    entityId: taskEntityId("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4"),
    kind: "progress_append",
    payload: {
      path: "progress.md",
      append: "controlled canonical head advance before relate publication proof\n"
    }
  }));
  const report = Effect.runSync(coordinator.flush("explicit"));
  assert.equal(report.committed, true);
  assert.equal(report.opCount, 1);
  const materialized = runLedgerMaterializer(rootDir, {
    heldGlobalLock: { path: lockPath, ownerToken: lock.ownerToken, ownerKind: lock.ownerKind },
    sessionId: "receipt-honesty-controlled-advance"
  });
  assert.equal(materialized.merged, 1, JSON.stringify(materialized));
  return git(path.join(rootDir, "harness"), "rev-parse", "HEAD");
}

function seedIncidentTask(authoredRoot: string, taskId: string): void {
  const taskRoot = path.join(authoredRoot, "tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  const template = readFileSync(path.join(
    authoredRoot,
    "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/INDEX.md"
  ), "utf8");
  writeFileSync(
    path.join(taskRoot, "INDEX.md"),
    template.replaceAll("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", taskId)
  );
  writeSubstantiveTaskPlan(authoredRoot, `tasks/${taskId}`);
  git(authoredRoot, "add", `tasks/${taskId}`);
  git(authoredRoot, "commit", "-q", "-m", `test: stage ${taskId} publication fixture`);
  publishSeededTaskFixture(authoredRoot, taskRoot, taskId);
}

function controlledStaleHeadGitShim(input: {
  readonly realGit: string;
  readonly authoredRoot: string;
  readonly armedPath: string;
  readonly readyPath: string;
  readonly releasePath: string;
  readonly counterPath: string;
  readonly capturedPath: string;
  readonly captureCall: number;
}): string {
  return [
    "#!/bin/sh",
    `if [ -e '${input.armedPath}' ] && [ "$1" = '-C' ] && [ "$2" = '${input.authoredRoot}' ] \\`,
    "  && [ \"$3\" = 'rev-parse' ] && [ \"$4\" = '--verify' ] && [ \"$5\" = 'HEAD' ]; then",
    `  count=$(test -e '${input.counterPath}' && cat '${input.counterPath}' || printf '0')`,
    "  count=$((count + 1))",
    `  printf '%s\\n' "$count" > '${input.counterPath}'`,
    `  if [ "$count" -eq '${input.captureCall}' ]; then`,
    `    captured=$('${input.realGit}' "$@") || exit $?`,
    `    printf '%s\\n' "$captured" > '${input.capturedPath}'`,
    `    : > '${input.readyPath}'`,
    "    attempts=0",
    `    while [ ! -e '${input.releasePath}' ]; do`,
    "      attempts=$((attempts + 1))",
    "      if [ \"$attempts\" -gt 400 ]; then exit 91; fi",
    "      sleep 0.05",
    "    done",
    "    printf '%s\\n' \"$captured\"",
    "    exit 0",
    "  fi",
    "fi",
    `exec '${input.realGit}' "$@"`,
    ""
  ].join("\n");
}
