// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { consumeKnownError, OPAQUE_TEXTUAL_POLICY_ID, sha256Text } from "@harness-anything/kernel";
import {
  attachSqliteGitFollower,
  closeWriterEpochFenceDescriptors,
  makeTaskEventReader,
  makeTaskProjection,
  openSqliteEventStore,
  publishPendingSqliteGitOutbox,
  readCertifiedGitFollower,
} from "@harness-anything/storage";
import { makeSqliteTaskEventStore } from "@harness-anything/storage/sqlite";
import { waitForArrival, watchFileArrival } from "../../../tools/fixtures/event-arrival.ts";
import { canonicalCommitClient } from "../src/daemon-host/canonical-commit-client.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { openRepoCellProxy } from "../src/daemon-host/repo-cell-proxy.ts";
import { acquireWorkspaceLock } from "../src/daemon-host/repo-cell-lock.ts";
import { openRepoWriterCell } from "../src/daemon-host/repo-cell-open.ts";
import { withRepoCellWriteSlot } from "../src/daemon-host/repo-cell.ts";
import { fixtureFence, settleSettingsEvent, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { policyTestCenter, provisionPolicyTestRepository, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { actor } from "./task-surface.fixtures.ts";
import { docBundle, git, initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

// dec_04A9211B073F29F0FC1E1CA573 CH2 / review F2: suspend the actual publication lock,
// then synchronously await the real canonical Worker before allowing Git to proceed.
for (const [ordinal, command] of ["update-ref", "update-index"].entries())
  test(
    `same-repo canonical COMMIT completes while follower ${command} fence is suspended`,
    { timeout: 30_000 },
    async (t) => {
      const rootDir = mkdtempSync(path.join(tmpdir(), "ha-outbox-concurrency-")),
        repoId = workspaceId("outbox-concurrency"),
        descriptor = fixtureFence(repoId, rootDir, path.join(rootDir, "epochs"));
      initRepo(rootDir);
      const writer = new Worker(new URL("../src/writer-cell/repo-writer-worker.ts", import.meta.url), {
        execArgv: ["--experimental-strip-types"],
        workerData: { config: { repoId, rootDir, defaultWriterEpochFence: descriptor } },
      });
      const client = canonicalCommitClient(writer.postMessage.bind(writer)),
        canonicalWriter = client.forFence(() => descriptor);
      let cell: Awaited<ReturnType<typeof openRepoWriterCell>> | undefined;
      let lock: Awaited<ReturnType<typeof acquireWorkspaceLock>> | undefined;
      const nativeExec = DatabaseSync.prototype.exec;
      try {
        await settleSettingsEvent({ repoId, rootDir, writerEpochFence: descriptor });
        lock = await acquireWorkspaceLock(canonicalRoot(rootDir));
        // This is the production orchestration-cell entry. Keep it on this thread
        // so the lock probe observes its SQLite fence; the canonical Worker is real.
        cell = await openRepoWriterCell(
          {
            repoId,
            rootDir: canonicalRoot(rootDir),
            ownerId: "outbox-test",
            defaultWriterEpochFence: descriptor,
            canonicalWriter: ({ writerFence }) => client.forFence(writerFence),
          },
          lock,
        );
        assert.equal(cell.status().state, "attached", JSON.stringify(cell.status()));
        await cell.settlePendingMaterialization("initial cut");
        const reader = makeTaskEventReader({ repoId, rootDir }),
          projection = makeTaskProjection({ rootDir, eventStore: reader });
        try {
          const before = reader.currentCut().revision;
          canonicalWriter.append(docBundle(reader, "first", before + 1, "first", "context/first.md"));
          projection.catchUp?.();
          let suspended = false,
            fences = 0;
          let commitFailure: unknown;
          // The first two publication fences enclose ref CAS and index settlement.
          // Suspend immediately after the real SQLite lock is acquired, before Git.
          t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
            nativeExec.call(this, sql);
            if (sql !== "BEGIN IMMEDIATE" || ++fences !== ordinal + 1) return;
            suspended = true;
            try {
              const receipt = canonicalWriter.append(
                docBundle(reader, "second", before + 2, "second", "context/second.md"),
              );
              assert.equal(receipt.revision, before + 2);
              assert.equal(reader.readCommandOutcome("second")?.status, "accepted_durable");
              assert.equal(reader.currentCut().revision, before + 2);
            } catch (error) {
              // Return from BEGIN so its owning transaction can always commit/rollback.
              // The outer assertion reports this error after publication releases its lock.
              consumeKnownError(error);
              commitFailure = error;
            }
          });
          await cell.settlePendingMaterialization("suspend Git while canonical append proceeds");
          assert.ifError(commitFailure);
          assert.equal(suspended, true, `must suspend the real ${command} fence`);
          t.mock.restoreAll();
          projection.catchUp?.();
          await cell.settlePendingMaterialization("converge to latest canonical cut");
          assert.equal(
            JSON.parse(git(rootDir, "show", "HEAD:harness/events/segments/manifest.json")).cut.revision,
            before + 2,
          );
          assert.equal(git(rootDir, "show", "HEAD:harness/context/second.md"), "second");
        } finally {
          projection.close();
          await reader.drain();
        }
      } finally {
        t.mock.restoreAll();
        await cell?.close();
        await lock?.close();
        client.close();
        await writer.terminate();
        closeWriterEpochFenceDescriptors();
        removeTempRepository(rootDir);
      }
    },
  );

// DM-1: Freeze SQLite read snapshot at revision N, append N+1 on canonicalWriter before closure reads,
// and prove N's Git tree + manifest strictly exclude N+1 while converging cut-by-cut after restart.
for (const mode of ["incremental", "cold"] as const)
  test(
    `DM-1 (${mode}): concurrent append(N+1) before closure reads does not leak into cut N Git tree or manifest`,
    { timeout: 30_000 },
    async (t) => {
      const rootDir = mkdtempSync(path.join(tmpdir(), `ha-dm1-${mode}-`)),
        repoId = workspaceId(`dm1-${mode}`),
        descriptor = fixtureFence(repoId, rootDir, path.join(rootDir, "epochs"));
      initRepo(rootDir);
      const writer = new Worker(new URL("../src/writer-cell/repo-writer-worker.ts", import.meta.url), {
        execArgv: ["--experimental-strip-types"],
        workerData: { config: { repoId, rootDir, defaultWriterEpochFence: descriptor } },
      });
      const client = canonicalCommitClient(writer.postMessage.bind(writer)),
        canonicalWriter = client.forFence(() => descriptor);
      const probeDb = new DatabaseSync(":memory:"),
        statementProto = Object.getPrototypeOf(probeDb.prepare("SELECT 1 AS ok")) as {
          all: (...args: unknown[]) => unknown[];
          sourceSQL: string;
        },
        nativeAll = statementProto.all;
      probeDb.close();
      let store: ReturnType<typeof makeSqliteTaskEventStore> | undefined;
      try {
        await settleSettingsEvent({ repoId, rootDir, writerEpochFence: descriptor });
        const reader = makeTaskEventReader({ repoId, rootDir });
        try {
          const base = reader.currentCut().revision;
          canonicalWriter.append(docBundle(reader, "cut-n-body", base + 1, "cut-n", "context/first.md"));
          const targetRevision = base + 1;

          let injectedConcurrentAppend = false;
          const targetSqlFragment =
            mode === "cold" ? "FROM document_head ORDER BY path" : "FROM event WHERE revision>?";

          if (mode === "incremental") {
            const seedStore = makeSqliteTaskEventStore({
              repoId,
              rootDir,
              writerFence: () => descriptor,
              attachGitFollower: attachSqliteGitFollower,
              mutable: true,
            });
            // Publish initial cut(s) cleanly first, then close and append one more baseline N with concurrent N+1.
            await seedStore.settlePendingMaterialization?.("seed");
            await seedStore.drain();
            const nextBase = reader.currentCut().revision;
            canonicalWriter.append(docBundle(reader, "inc-n-body", nextBase + 1, "cut-n-inc", "context/inc-n.md"));
            const storeN = makeSqliteTaskEventStore({
              repoId,
              rootDir,
              writerFence: () => descriptor,
              attachGitFollower: attachSqliteGitFollower,
              mutable: true,
            });
            store = storeN;
            // First publish settles `cut-n-inc` at revision `nextBase + 1` so `settledWorktreeRevision` advances
            // past `null` (cold `from = 0` becomes `from = nextBase + 1 > 0`). Then append N = nextBase + 2.
            await storeN.settlePendingMaterialization?.("warm worktree revision");
            assert.equal(storeN.followerStatus().git.cut?.revision, nextBase + 1);
            const revN = nextBase + 2;
            canonicalWriter.append(docBundle(reader, "step-n-body", revN, "cut-n-step", "context/step-n.md"));
            t.mock.method(statementProto, "all", function (this: { readonly sourceSQL: string }, ...args: unknown[]) {
              if (!injectedConcurrentAppend && this.sourceSQL.includes(targetSqlFragment)) {
                injectedConcurrentAppend = true;
                const receipt = canonicalWriter.append(
                  docBundle(reader, "step-n1-body", revN + 1, "cut-n-plus-1", "context/step-n1.md"),
                );
                assert.equal(receipt.revision, revN + 1);
                assert.equal(reader.readCommandOutcome("cut-n-plus-1")?.status, "accepted_durable");
              }
              return nativeAll.apply(this, args);
            });
            await storeN.settlePendingMaterialization?.("publish cut N while N+1 commits");
            t.mock.restoreAll();
            assert.equal(injectedConcurrentAppend, true, "must inject concurrent append before closure events read");
            assert.equal(storeN.materializationHealth().lastError, undefined);
            assert.equal(storeN.followerStatus().git.status, "verified");
            const commitAtN = git(rootDir, "rev-parse", "HEAD").trim(),
              manifestAtN = JSON.parse(git(rootDir, "show", `${commitAtN}:harness/events/segments/manifest.json`));
            assert.equal(manifestAtN.cut.revision, revN, "cut N manifest must pin N, not N+1");
            assert.equal(git(rootDir, "show", `${commitAtN}:harness/context/step-n.md`), "step-n-body");
            assert.throws(
              () => git(rootDir, "show", `${commitAtN}:harness/context/step-n1.md`),
              "cut N Git tree must strictly exclude concurrent N+1",
            );
            await storeN.drain();
            store = undefined;

            // Simulate process restart and drain pending N+1 cleanly via outbox recovery.
            const restarted = await publishPendingSqliteGitOutbox({ repoId, rootDir });
            assert.equal(restarted.followerStatus.git.cut?.revision, revN + 1);
            assert.equal(git(rootDir, "rev-parse", "HEAD~1").trim(), commitAtN);
            assert.equal(git(rootDir, "show", "HEAD:harness/context/step-n1.md"), "step-n1-body");
            const certifiedReader = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3, readOnly: true });
            try {
              const certified = readCertifiedGitFollower({ rootInput: rootDir, repoId, store: certifiedReader });
              assert.equal(certified.cut.revision, revN + 1);
            } finally {
              certifiedReader.close();
            }
          } else {
            // Cold mode (`from === 0`): inject N+1 after cut() fixes N and before `document_head` + `directoryClaims` read.
            const coldStore = makeSqliteTaskEventStore({
              repoId,
              rootDir,
              writerFence: () => descriptor,
              attachGitFollower: attachSqliteGitFollower,
              mutable: true,
            });
            store = coldStore;
            t.mock.method(statementProto, "all", function (this: { readonly sourceSQL: string }, ...args: unknown[]) {
              if (!injectedConcurrentAppend && this.sourceSQL.includes(targetSqlFragment)) {
                injectedConcurrentAppend = true;
                const receipt = canonicalWriter.append(
                  docBundle(reader, "cold-n1-body", targetRevision + 1, "cut-n-plus-1-cold", "context/second.md"),
                );
                assert.equal(receipt.revision, targetRevision + 1);
                assert.equal(reader.readCommandOutcome("cut-n-plus-1-cold")?.status, "accepted_durable");
              }
              return nativeAll.apply(this, args);
            });
            await coldStore.settlePendingMaterialization?.("publish cold cut N while N+1 commits");
            t.mock.restoreAll();
            assert.equal(injectedConcurrentAppend, true, "must inject concurrent append before document_head read");
            assert.equal(coldStore.materializationHealth().lastError, undefined);
            assert.equal(coldStore.followerStatus().git.status, "verified");
            const commitAtN = git(rootDir, "rev-parse", "HEAD").trim(),
              manifestAtN = JSON.parse(git(rootDir, "show", `${commitAtN}:harness/events/segments/manifest.json`));
            assert.equal(manifestAtN.cut.revision, targetRevision, "cold cut N manifest must pin N, not N+1");
            assert.equal(git(rootDir, "show", `${commitAtN}:harness/context/first.md`), "cut-n-body");
            assert.throws(
              () => git(rootDir, "show", `${commitAtN}:harness/context/second.md`),
              "cold cut N Git tree must strictly exclude concurrent N+1",
            );
            await coldStore.drain();
            store = undefined;

            const restarted = await publishPendingSqliteGitOutbox({ repoId, rootDir });
            assert.equal(restarted.followerStatus.git.cut?.revision, targetRevision + 1);
            assert.equal(git(rootDir, "rev-parse", "HEAD~1").trim(), commitAtN);
            assert.equal(git(rootDir, "show", "HEAD:harness/context/second.md"), "cold-n1-body");
            const certifiedReader = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3, readOnly: true });
            try {
              const certified = readCertifiedGitFollower({ rootInput: rootDir, repoId, store: certifiedReader });
              assert.equal(certified.cut.revision, targetRevision + 1);
            } finally {
              certifiedReader.close();
            }
          }
        } finally {
          await reader.drain();
        }
      } finally {
        t.mock.restoreAll();
        if (store) await store.drain();
        client.close();
        await writer.terminate();
        closeWriterEpochFenceDescriptors();
        removeTempRepository(rootDir);
      }
    },
  );

function resolveSystemGit(): string {
  const output = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" }).trim();
  const first = output.split(/\r?\n/u).find((line) => line.trim().length > 0);
  assert.ok(first, "system git executable must exist in PATH");
  return first.trim();
}

function decisionProposeAction(title: string) {
  return {
    kind: "decision-propose" as const,
    jsonInput: JSON.stringify({
      title,
      question: `Should ${title} proceed?`,
      riskTier: "low",
      urgency: "low",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["storage"], productLines: [] },
      chosen: [{ id: "CH1", text: "Proceed without blocking" }],
      rejected: [{ id: "RJ1", text: "Block event loop", whyNot: "Stalls unrelated commands" }],
      claims: [],
      fulfillments: [],
    }),
    body: `# ${title}\n\n## 背景\n\nNon-blocking follower check.\n\n## 权衡\n\nAsync child process.\n\n## 结论\n\nAccept.\n`,
  };
}

function pauseGitPublication(parent: string, repoRoot: string, subcommand: string) {
  const controlDir = path.join(parent, "control"),
    binDir = path.join(parent, "bin"),
    armFile = path.join(controlDir, "arm"),
    enteredFile = path.join(controlDir, "entered"),
    releaseFile = path.join(controlDir, "release"),
    realGit = resolveSystemGit(),
    gitShimPath = path.join(binDir, "git");
  mkdirSync(controlDir);
  mkdirSync(binDir);
  // Wrapper script intercepts only armed invocations for repoARoot + target subcommand, pausing via fs.watch.
  writeFileSync(
    gitShimPath,
    `#!${process.execPath}
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGit)};
const repoA = ${JSON.stringify(repoRoot)};
const targetCmd = ${JSON.stringify(subcommand)};
const armFile = ${JSON.stringify(armFile)};
const enteredFile = ${JSON.stringify(enteredFile)};
const releaseFile = ${JSON.stringify(releaseFile)};
const controlDir = ${JSON.stringify(controlDir)};

const cIdx = args.indexOf("-C");
const targetCwd = cIdx >= 0 ? path.resolve(args[cIdx + 1]) : process.cwd();
const matchesTarget = targetCwd === path.resolve(repoA) && args.includes(targetCmd);

if (matchesTarget && fs.existsSync(armFile) && !fs.existsSync(releaseFile)) {
  let claimed = false;
  try {
    fs.writeFileSync(enteredFile, targetCmd, { flag: "wx" });
    claimed = true;
  } catch {}
  if (claimed && !fs.existsSync(releaseFile)) {
    await new Promise((resolve) => {
      const watcher = fs.watch(controlDir, () => {
        if (fs.existsSync(releaseFile)) {
          watcher.close();
          resolve();
        }
      });
      if (fs.existsSync(releaseFile)) {
        watcher.close();
        resolve();
      }
    });
  }
  if (claimed && fs.readFileSync(releaseFile, "utf8") === "fail") process.exit(1);
}

const result = spawnSync(realGit, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    "utf8",
  );
  chmodSync(gitShimPath, 0o755);
  return { binDir, armFile, enteredFile, releaseFile };
}

// DM-2: Exercise production openRepoCellProxy -> openWriterSupervisor -> shared repo-orchestration-worker.
// Suspend Repo A's real git subprocess (`fast-import` and `update-ref`), and verify Repo B and Repo A
// both complete cell.run to `accepted_durable` while Git remains suspended.
for (const scenario of ["fast-import", "update-ref", "first-attempt-fails"] as const)
  test(
    `Git outbox (${scenario}): the same repo writes during review preparation and failed publication is retryable`,
    { timeout: 60_000 },
    async (t) => {
      const failFirstAttempt = scenario === "first-attempt-fails",
        suspendedSubcommand = failFirstAttempt ? "fast-import" : scenario,
        parent = mkdtempSync(path.join(tmpdir(), `ha-outbox-${scenario}-`)),
        repoAPath = path.join(parent, "repo-a"),
        repoBPath = path.join(parent, "repo-b");
      mkdirSync(repoAPath, { recursive: true });
      mkdirSync(repoBPath, { recursive: true });
      const repoARoot = canonicalRoot(repoAPath),
        repoBRoot = canonicalRoot(repoBPath),
        repoAId = workspaceId("dm2-repo-a"),
        repoBId = workspaceId("dm2-repo-b"),
        epochsRoot = path.join(parent, "epochs"),
        originalPath = process.env.PATH ?? "";
      initRepo(repoARoot);
      initRepo(repoBRoot);

      const { binDir, armFile, enteredFile, releaseFile } = pauseGitPublication(parent, repoARoot, suspendedSubcommand);

      let cellA: Awaited<ReturnType<typeof openRepoCellProxy>> | undefined,
        cellB: Awaited<ReturnType<typeof openRepoCellProxy>> | undefined;
      try {
        process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
        provisionPolicyTestRepository(repoAId);
        provisionPolicyTestRepository(repoBId);
        const fenceA = fixtureFence(repoAId, repoARoot, epochsRoot),
          fenceB = fixtureFence(repoBId, repoBRoot, epochsRoot);
        await settleSettingsEvent({ repoId: repoAId, rootDir: repoARoot, writerEpochFence: fenceA });
        await settleSettingsEvent({ repoId: repoBId, rootDir: repoBRoot, writerEpochFence: fenceB });

        cellA = await openRepoCellProxy({
          repoId: repoAId,
          rootDir: repoARoot,
          ownerId: "dm2-owner-a",
          keycloakCenter: policyTestCenter,
          defaultWriterEpochFence: fenceA,
        });
        cellB = await openRepoCellProxy({
          repoId: repoBId,
          rootDir: repoBRoot,
          ownerId: "dm2-owner-b",
          keycloakCenter: policyTestCenter,
          defaultWriterEpochFence: fenceB,
        });
        assert.equal(cellA.status().state, "attached");
        assert.equal(cellB.status().state, "attached");

        const bindingA = withPolicyGroup(
            { actor, source: "local" as const, writerEpoch: fenceA.epoch, writerEpochFence: fenceA },
            "contributor",
          ),
          bindingB = withPolicyGroup(
            { actor, source: "local" as const, writerEpoch: fenceB.epoch, writerEpochFence: fenceB },
            "contributor",
          );

        // Settle initial state before arming suspension.
        const seedA = await cellA.run(decisionProposeAction("DM2 seed A"), bindingA);
        assert.equal(seedA.outcome, "applied");
        await waitForFixturePublication(cellA, seedA.opId, bindingA);
        const seedB = await cellB.run(decisionProposeAction("DM2 seed B"), bindingB);
        assert.equal(seedB.outcome, "applied");
        await waitForFixturePublication(cellB, seedB.opId, bindingB);

        // Arm the controlled git suspension and trigger Repo A command 1 -> suspends background follower.
        writeFileSync(armFile, "armed", "utf8");
        const cmdA1 = await cellA.run(decisionProposeAction("DM2 suspended A1"), bindingA);
        assert.equal(cmdA1.outcome, "applied");

        await waitForArrival(() => (existsSync(enteredFile) ? true : null), watchFileArrival(enteredFile));
        assert.equal(existsSync(releaseFile), false, "git subprocess must be suspended now");

        // dec_04A9211B073F29F0FC1E1CA573 CH2, DM-3/DM-4: send the Decision dispatch first.
        // A later catalog request on the same proxy is the delivery barrier for the dispatch.
        // The deliberately stale digest can only be checked after preparation; no provider is needed.
        let dispatchFinished = false;
        const { decisionId } = JSON.parse(String(cmdA1.evidence)),
          dispatchAction = {
            kind: "decision-dispatch-review",
            decisionId,
            expectedDigest: `sha256:${"0".repeat(64)}`,
          },
          authoredDecision = path.join(repoARoot, "harness", "decisions", `decision-${decisionId}`, "decision.md"),
          dispatchBinding = withPolicyGroup(bindingA, "admin"),
          dispatch = cellA.run(dispatchAction, dispatchBinding).finally(() => {
            dispatchFinished = true;
          });
        await Promise.resolve();
        await cellA.catalog.snapshot();
        assert.equal(existsSync(authoredDecision), false, "the target Decision is still only in the ledger");
        if (failFirstAttempt) {
          writeFileSync(releaseFile, "fail", "utf8");
          const failed = await dispatch;
          assert.equal(failed.code, "materialization_failed", JSON.stringify(failed));
          assert.match(failed.rejectionExplanation ?? "", /retry/iu);
          await waitForArrival(() => (existsSync(authoredDecision) ? true : null), watchFileArrival(authoredDecision));
          const retried = await cellA.run(dispatchAction, dispatchBinding);
          assert.equal(retried.code, "version_conflict", JSON.stringify(retried));
          return;
        }

        // While Repo A's git subprocess is suspended, both Repo B (sharing the singleton orchestration worker)
        // and Repo A itself must finish cell.run cleanly and reach durable SQLite acceptance (`accepted_durable`).
        // The deadline only bounds the negative control so cleanup can release the Git child.
        const signal = AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]);
        const [cmdB2, cmdA2] = await Promise.all([
          cellB.run(decisionProposeAction("DM2 concurrent B2"), bindingB, signal),
          cellA.run(decisionProposeAction("DM2 concurrent A2"), bindingA, signal),
        ]);
        assert.equal(cmdB2.outcome, "applied");
        assert.equal(cmdA2.outcome, "applied");
        assert.equal(dispatchFinished, false, "the dispatch is still waiting for Git");
        assert.equal(existsSync(releaseFile), false, "cell.run calls must finish before git is released");

        const readerA = makeTaskEventReader({ repoId: repoAId, rootDir: repoARoot }),
          readerB = makeTaskEventReader({ repoId: repoBId, rootDir: repoBRoot });
        try {
          assert.equal(readerB.readCommandOutcome(cmdB2.opId)?.status, "accepted_durable");
          assert.equal(readerA.readCommandOutcome(cmdA2.opId)?.status, "accepted_durable");
        } finally {
          await readerA.drain();
          await readerB.drain();
        }

        // Release suspended git and confirm both repositories converge cleanly in Git.
        writeFileSync(releaseFile, "release", "utf8");
        const rejected = await dispatch;
        assert.equal(rejected.code, "version_conflict", JSON.stringify(rejected));
        await waitForFixturePublication(cellA, cmdA2.opId, bindingA);
        await waitForFixturePublication(cellB, cmdB2.opId, bindingB);
      } finally {
        // Ensure a failed assertion never leaves the child shim blocked waiting for release.
        writeFileSync(releaseFile, "release", "utf8");
        await cellA?.close();
        await cellB?.close();
        process.env.PATH = originalPath;
        closeWriterEpochFenceDescriptors();
        removeTempRepository(parent);
      }
    },
  );

// dec_04A9211B073F29F0FC1E1CA573 CH2, DM-4: the worktree may advance independently
// of the writer queue. Hold the replacement turn until the local submit has queued behind it.
test(
  "DM-4: queued local doc-submit cannot replace a newer canonical HTML with stale worktree bytes",
  { timeout: 60_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-doc-submit-cut-")),
      rootDir = canonicalRoot(path.join(parent, "repo"), true),
      repoId = workspaceId("doc-submit-cut"),
      originalPath = process.env.PATH ?? "",
      logical = "context/research/cut/index.html",
      authored = path.join(rootDir, "harness", logical),
      covered = "context/research/cut/covered.html",
      coveredFile = path.join(rootDir, "harness", covered),
      oldBody = "<p>Previously published</p>\n",
      newBody = "<p>New canonical replacement</p>\n",
      localEdit = "<p>Explicit edit after publication</p>\n",
      replaceQueued = Promise.withResolvers<void>(),
      releaseReplace = Promise.withResolvers<void>();
    mkdirSync(rootDir);
    initRepo(rootDir);
    const { binDir, armFile, enteredFile, releaseFile } = pauseGitPublication(parent, rootDir, "update-index");
    let cell: Awaited<ReturnType<typeof openRepoWriterCell>> | undefined;
    let lock: Awaited<ReturnType<typeof acquireWorkspaceLock>> | undefined;
    let reader: ReturnType<typeof makeTaskEventReader> | undefined;
    try {
      process.env.PATH = [binDir, originalPath].join(path.delimiter);
      provisionPolicyTestRepository(repoId);
      const fence = fixtureFence(repoId, rootDir, path.join(parent, "epochs"));
      await settleSettingsEvent({ repoId, rootDir, writerEpochFence: fence });
      lock = await acquireWorkspaceLock(rootDir);
      cell = await openRepoWriterCell(
        { repoId, rootDir, ownerId: "doc-submit-cut", defaultWriterEpochFence: fence },
        lock,
      );
      const writer = cell,
        binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
        nodeBinding = { ...binding, source: { kind: "node", nodeId: "node-one" } as const },
        localSubmit = { kind: "doc-submit", paths: [logical] } as const;
      async function queueLocalSubmit(selected: string, beforeScan?: () => Promise<unknown>) {
        const queued = Promise.withResolvers<void>(),
          receipt = withRepoCellWriteSlot(
            async (work) => {
              await beforeScan?.();
              return await work();
            },
            () => writer.run({ kind: "doc-submit", paths: [selected] }, binding, t.signal),
            queued.resolve,
          );
        await Promise.race([queued.promise, receipt.then((result) => assert.fail(JSON.stringify(result)))]);
        return { receipt };
      }
      assert.equal(writer.status().state, "attached", JSON.stringify(writer.status()));
      mkdirSync(path.dirname(authored), { recursive: true });
      writeFileSync(authored, oldBody);
      writeFileSync(coveredFile, oldBody);
      const seeded = await writer.run({ kind: "doc-submit", paths: [logical, covered] }, binding);
      assert.equal(seeded.outcome, "applied", JSON.stringify(seeded));
      await waitForFixturePublication(writer, seeded.opId, binding);

      reader = makeTaskEventReader({ repoId, rootDir });
      const base = reader.currentCut(),
        sha = sha256Text(newBody),
        claim = path.join(rootDir, ".harness", "doc-sync-claims", sha);
      mkdirSync(path.dirname(claim), { recursive: true });
      writeFileSync(claim, newBody);
      const replacement = withRepoCellWriteSlot(
        async (work) => {
          await releaseReplace.promise;
          return await work();
        },
        () =>
          writer.run(
            {
              kind: "doc-submit",
              executionId: null,
              baseLedgerSha: base,
              changes: [
                {
                  path: logical,
                  baseBlobSha256: sha256Text(oldBody),
                  policyId: OPAQUE_TEXTUAL_POLICY_ID,
                  candidate: {
                    ref: "doc-sync-claims/" + sha,
                    sha256: sha,
                    size: Buffer.byteLength(newBody),
                    mediaType: "text/html",
                  },
                },
              ],
            },
            nodeBinding,
            t.signal,
          ),
        replaceQueued.resolve,
      );
      await Promise.race([replaceQueued.promise, replacement.then((receipt) => assert.fail(JSON.stringify(receipt)))]);
      writeFileSync(coveredFile, localEdit);
      const { receipt: submitCovered } = await queueLocalSubmit(covered, () =>
        waitForArrival(() => (existsSync(enteredFile) ? true : null), watchFileArrival(enteredFile)),
      );
      const { receipt: repeatCovered } = await queueLocalSubmit(covered);
      const { receipt: submit } = await queueLocalSubmit(logical);
      assert.deepEqual(reader.currentCut(), base, "the local submits queued before the replacement was accepted");

      writeFileSync(armFile, "armed");
      releaseReplace.resolve();
      const replaced = await replacement;
      assert.equal(replaced.status, "accepted_durable", JSON.stringify(replaced));
      const coveredEdit = await submitCovered;
      assert.equal(coveredEdit.status, "accepted_durable", JSON.stringify(coveredEdit));
      assert.equal((await writer.run({ kind: "doc-show", path: covered }, binding)).evidence, localEdit);
      const unchanged = await repeatCovered;
      assert.equal(unchanged.outcome, "no_changes", JSON.stringify(unchanged));
      assert.equal(readFileSync(authored, "utf8"), oldBody);
      const blocked = await submit;
      const duringPause = await writer.run({ kind: "doc-show", path: logical }, binding);
      assert.equal(duringPause.evidence, newBody, "stale disk bytes must not overwrite the canonical replacement");
      assert.equal(blocked.code, "materialization_failed", JSON.stringify(blocked));
      assert.match(blocked.rejectionExplanation ?? "", /retry/iu);
      assert.equal(reader.readEvent(blocked.opId), null);
      assert.equal(reader.currentCut().revision, coveredEdit.revision);

      const ordinary = await writer.run(decisionProposeAction("Write during stale doc submit"), binding, t.signal);
      assert.equal(reader.readCommandOutcome(ordinary.opId)?.status, "accepted_durable");
      assert.equal(existsSync(releaseFile), false);
      writeFileSync(releaseFile, "release");
      await waitForFixturePublication(writer, ordinary.opId, binding);
      assert.equal(readFileSync(authored, "utf8"), newBody);
      const retry = await writer.run(localSubmit, binding);
      assert.equal(retry.outcome, "no_changes", JSON.stringify(retry));

      writeFileSync(authored, localEdit);
      const edited = await writer.run(localSubmit, binding);
      assert.equal(edited.status, "accepted_durable", JSON.stringify(edited));
      assert.equal((await writer.run({ kind: "doc-show", path: logical }, binding)).evidence, localEdit);
    } finally {
      releaseReplace.resolve();
      writeFileSync(releaseFile, "release");
      await cell?.close();
      await reader?.drain();
      await lock?.close();
      process.env.PATH = originalPath;
      closeWriterEpochFenceDescriptors();
      removeTempRepository(parent);
    }
  },
);

test(
  "DM-4: queued doc-submit cannot recreate a retirement from unmaterialized bytes",
  { timeout: 60_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-doc-retire-cut-")),
      rootDir = canonicalRoot(path.join(parent, "repo"), true),
      repoId = workspaceId("doc-retire-cut"),
      originalPath = process.env.PATH ?? "",
      logical = "context/retirement.md",
      authored = path.join(rootDir, "harness", logical),
      retireQueued = Promise.withResolvers<void>(),
      releaseRetire = Promise.withResolvers<void>();
    mkdirSync(rootDir);
    initRepo(rootDir);
    const { binDir, armFile, enteredFile, releaseFile } = pauseGitPublication(parent, rootDir, "update-index");
    let cell: Awaited<ReturnType<typeof openRepoWriterCell>> | undefined;
    let lock: Awaited<ReturnType<typeof acquireWorkspaceLock>> | undefined;
    let reader: ReturnType<typeof makeTaskEventReader> | undefined;
    try {
      process.env.PATH = [binDir, originalPath].join(path.delimiter);
      provisionPolicyTestRepository(repoId);
      const fence = fixtureFence(repoId, rootDir, path.join(parent, "epochs"));
      await settleSettingsEvent({ repoId, rootDir, writerEpochFence: fence });
      lock = await acquireWorkspaceLock(rootDir);
      cell = await openRepoWriterCell(
        { repoId, rootDir, ownerId: "doc-retire-cut", defaultWriterEpochFence: fence },
        lock,
      );
      const writer = cell,
        binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
        submit = { kind: "doc-submit", paths: [logical] } as const,
        oldBody = "# Retired preimage\n";
      mkdirSync(path.dirname(authored), { recursive: true });
      writeFileSync(authored, oldBody);
      const seeded = await writer.run(submit, binding);
      assert.equal(seeded.outcome, "applied", JSON.stringify(seeded));
      await waitForFixturePublication(writer, seeded.opId, binding);
      reader = makeTaskEventReader({ repoId, rootDir });
      const retired = withRepoCellWriteSlot(
        async (work) => {
          await releaseRetire.promise;
          return await work();
        },
        () => writer.run({ kind: "doc-retire", paths: [logical], reason: "superseded" }, binding, t.signal),
        retireQueued.resolve,
      );
      await Promise.race([retireQueued.promise, retired.then((result) => assert.fail(JSON.stringify(result)))]);
      const submitQueued = Promise.withResolvers<void>(),
        submitted = withRepoCellWriteSlot(
          async (work) => {
            await waitForArrival(() => (existsSync(enteredFile) ? true : null), watchFileArrival(enteredFile));
            return await work();
          },
          () => writer.run(submit, binding, t.signal),
          submitQueued.resolve,
        );
      await Promise.race([submitQueued.promise, submitted.then((result) => assert.fail(JSON.stringify(result)))]);
      writeFileSync(armFile, "armed");
      releaseRetire.resolve();
      const retirement = await retired;
      assert.equal(retirement.status, "accepted_durable", JSON.stringify(retirement));
      const blocked = await submitted;
      assert.equal(readFileSync(authored, "utf8"), oldBody);
      assert.equal(blocked.code, "materialization_failed", JSON.stringify(blocked));
      assert.match(blocked.rejectionExplanation ?? "", /retry/iu);
      assert.equal(reader.currentCut().revision, retirement.revision);
      assert.equal((await writer.run({ kind: "doc-show", path: logical }, binding)).code, "document_not_found");

      writeFileSync(releaseFile, "release");
      await waitForFixturePublication(writer, retirement.opId, binding);
      assert.equal(existsSync(authored), false);
      const absent = await writer.run(submit, binding);
      assert.equal(absent.code, "document_not_found", JSON.stringify(absent));
      assert.equal(reader.currentCut().revision, retirement.revision);
      writeFileSync(authored, "# Authored after retirement\n");
      const recreated = await writer.run(submit, binding);
      assert.equal(recreated.status, "accepted_durable", JSON.stringify(recreated));
    } finally {
      releaseRetire.resolve();
      writeFileSync(releaseFile, "release");
      await cell?.close();
      await reader?.drain();
      await lock?.close();
      process.env.PATH = originalPath;
      closeWriterEpochFenceDescriptors();
      removeTempRepository(parent);
    }
  },
);

test("doc status accepts a Git candidate inventory larger than Node's default pipe buffer", async (t) => {
  const rootDir = canonicalRoot(mkdtempSync(path.join(tmpdir(), "ha-doc-large-status-"))),
    repoId = workspaceId("doc-large-status"),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  t.after(() => removeTempRepository(rootDir));
  initRepo(rootDir);
  provisionPolicyTestRepository(repoId);
  const fence = fixtureFence(repoId, rootDir, path.join(rootDir, ".harness", "epochs"));
  await settleSettingsEvent({ repoId, rootDir, writerEpochFence: fence });
  const lock = await acquireWorkspaceLock(rootDir);
  const cell = await openRepoWriterCell(
    { repoId, rootDir, ownerId: "doc-large-status", defaultWriterEpochFence: fence },
    lock,
  );
  try {
    const oid = git(rootDir, "rev-parse", "HEAD:harness/.gitattributes"),
      prefix = `harness/.ha-visible-fixture/${"x".repeat(132)}`,
      index = Array.from({ length: 7_000 }, (_, i) => `100644 ${oid}\t${prefix}/row-${i}.md\0`).join("");
    execFileSync("git", ["-C", rootDir, "update-index", "-z", "--index-info"], { input: index });
    const status = ["-C", rootDir, "--no-optional-locks", "status", "--porcelain=v1", "-z", "--", "harness"];
    assert.throws(() => execFileSync("git", status), { code: "ENOBUFS" });
    const receipt = await cell.run({ kind: "doc-status", paths: [] }, binding);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  } finally {
    await cell.close();
    await lock.close();
    closeWriterEpochFenceDescriptors();
  }
});
