// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { consumeKnownError } from "@harness-anything/kernel";
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
import { fixtureFence, settleSettingsEvent, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { policyTestCenter, provisionPolicyTestRepository, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { actor } from "./task-surface.fixtures.ts";
import { docBundle, git, initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";

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
        rmSync(rootDir, { recursive: true, force: true });
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
        rmSync(rootDir, { recursive: true, force: true });
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

// DM-2: Exercise production openRepoCellProxy -> openWriterSupervisor -> shared repo-orchestration-worker.
// Suspend Repo A's real git subprocess (`fast-import` and `update-ref`), and verify Repo B and Repo A
// both complete cell.run to `accepted_durable` while Git remains suspended.
for (const suspendedSubcommand of ["fast-import", "update-ref"] as const)
  test(
    `DM-2 (${suspendedSubcommand}): cell.run reaches accepted_durable across shared orchestration worker while git is suspended`,
    { timeout: 60_000 },
    async () => {
      const parent = mkdtempSync(path.join(tmpdir(), `ha-dm2-${suspendedSubcommand}-`)),
        controlDir = path.join(parent, "control"),
        binDir = path.join(parent, "bin"),
        repoAPath = path.join(parent, "repo-a"),
        repoBPath = path.join(parent, "repo-b");
      mkdirSync(controlDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      mkdirSync(repoAPath, { recursive: true });
      mkdirSync(repoBPath, { recursive: true });
      const repoARoot = canonicalRoot(repoAPath),
        repoBRoot = canonicalRoot(repoBPath),
        repoAId = workspaceId("dm2-repo-a"),
        repoBId = workspaceId("dm2-repo-b"),
        epochsRoot = path.join(parent, "epochs"),
        armFile = path.join(controlDir, "arm"),
        enteredFile = path.join(controlDir, "entered"),
        releaseFile = path.join(controlDir, "release"),
        realGit = resolveSystemGit(),
        originalPath = process.env.PATH ?? "",
        gitShimPath = path.join(binDir, "git");
      initRepo(repoARoot);
      initRepo(repoBRoot);

      // Wrapper script intercepts only armed invocations for repoARoot + target subcommand, pausing via fs.watch.
      writeFileSync(
        gitShimPath,
        `#!${process.execPath}
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGit)};
const repoA = ${JSON.stringify(repoARoot)};
const targetCmd = ${JSON.stringify(suspendedSubcommand)};
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
}

const result = spawnSync(realGit, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
        "utf8",
      );
      chmodSync(gitShimPath, 0o755);

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

        // While Repo A's git subprocess is suspended, both Repo B (sharing the singleton orchestration worker)
        // and Repo A itself must finish cell.run cleanly and reach durable SQLite acceptance (`accepted_durable`).
        const [cmdB2, cmdA2] = await Promise.all([
          cellB.run(decisionProposeAction("DM2 concurrent B2"), bindingB),
          cellA.run(decisionProposeAction("DM2 concurrent A2"), bindingA),
        ]);
        assert.equal(cmdB2.outcome, "applied");
        assert.equal(cmdA2.outcome, "applied");
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
        await waitForFixturePublication(cellA, cmdA2.opId, bindingA);
        await waitForFixturePublication(cellB, cmdB2.opId, bindingB);
      } finally {
        // Ensure a failed assertion never leaves the child shim blocked waiting for release.
        writeFileSync(releaseFile, "release", "utf8");
        await cellA?.close();
        await cellB?.close();
        process.env.PATH = originalPath;
        closeWriterEpochFenceDescriptors();
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );
