// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { consumeKnownError } from "@harness-anything/kernel";
import { Worker } from "node:worker_threads";
import { makeTaskEventReader, makeTaskProjection, closeWriterEpochFenceDescriptors } from "@harness-anything/storage";
import { canonicalCommitClient } from "../src/daemon-host/canonical-commit-client.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { fixtureFence, settleSettingsEvent } from "./repo-settings.fixture.ts";
import { openRepoWriterCell } from "../src/daemon-host/repo-cell-open.ts";
import { acquireWorkspaceLock } from "../src/daemon-host/repo-cell-lock.ts";
import { git, initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import { docBundle } from "../../storage/test/store/task-event-store.fixtures.ts";

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
