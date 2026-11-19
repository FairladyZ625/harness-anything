// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { compileEntityDocumentRematerialization, taskLifecycleWritePlan } from "@harness-anything/kernel";
import { docSyncWritePlan } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { makeTaskEventStore, makeTaskProjection } from "../../src/index.ts";
import { readNodeMaterializationDocuments } from "../../src/storage-backend.ts";
import { localGitProcessCount } from "../../src/store/local-version-control-system.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { taskCreated } from "./relation-graph-projection.fixtures.ts";
import { docBundle, git, initRepo } from "./task-event-store.fixtures.ts";

test("Git outbox keeps a certified checkout clean through selective removal, repair and later appends", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const inRepo = (target: string) => path.join(rootDir, target),
      draft = "harness/agents/local.json",
      staged = "harness/context/staged.md",
      options = { repoId: "outbox-index", rootDir };
    mkdirSync(inRepo("harness/agents"));
    mkdirSync(inRepo("harness/context"));
    writeFileSync(inRepo(draft), "{}\n");
    writeFileSync(inRepo(staged), "committed\n");
    git(rootDir, "add", draft, staged);
    git(rootDir, "commit", "-qm", "operator baseline");

    let store = makeTaskEventStore(options),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      const taskId = "task_archive_index",
        created = taskCreated(1, taskId),
        event = {
          ...created,
          payload: { ...created.payload, task: { ...created.payload.task, status: "done" as const } },
        },
        plan = taskLifecycleWritePlan(event);
      store.append({ event, plan, blobs: [] });
      projection.apply(event, plan);
      const logical = `${projection.read(taskId).packagePath!}/task_plan.md`,
        archived = `harness/${logical}`,
        archivedBody = "# Completed package\n",
        docs = compileEntityDocumentRematerialization({
          opId: "archive-document",
          workspaceRevision: 2,
          actor: event.actor,
          source: "local",
          occurredAt: event.occurredAt,
          entityRefs: [`task/${taskId}`],
          rationale: "fixture",
          updates: [
            { path: logical, body: archivedBody, mediaType: "text/markdown", policyId: "markdown-body-replaceable/v1" },
          ],
        });
      store.append(docs);
      projection.apply(docs.event, docs.plan);
      await store.settlePendingMaterialization!("seed the include-done cut");
      assert.equal(git(rootDir, "status", "--porcelain", "--", "harness"), "");
      const head = git(rootDir, "rev-parse", "HEAD");
      projection.close();
      await store.drain();

      // Reproduce the index and disk left by a same-cut policy change on an earlier build.
      git(rootDir, "update-index", "--force-remove", "--", archived);
      unlinkSync(inRepo(archived));
      assert.equal(git(rootDir, "diff", "--cached", "--name-status"), `D\t${archived}`);
      writeFileSync(inRepo(draft), '{"dirty":true}\n');
      writeFileSync(inRepo(staged), "staged edit\n");
      git(rootDir, "add", staged);
      writeFileSync(inRepo(staged), "unstaged edit\n");

      let coldReads = 0;
      store = makeTaskEventStore({
        ...options,
        storage: { nodeTaskMaterializationPolicy: "in_flight" },
        readMaterializationDocuments: (forced, after, expected, previous) => {
          if (projection.readCut().watermark !== expected) return null;
          if (after === undefined) coldReads++;
          return readNodeMaterializationDocuments(projection, "in_flight", forced, after, previous);
        },
      });
      projection = makeTaskProjection({ rootDir, eventStore: store });
      await store.settlePendingMaterialization!("repair a previously divergent checkout");
      assert.equal(store.materializationHealth().state, "ok", JSON.stringify(store.materializationHealth()));
      assert.equal(git(rootDir, "rev-parse", "HEAD"), head, "repair keeps the existing Git cut");
      assert.equal(git(rootDir, "ls-files", "-v", "--", archived), `S ${archived}`);
      assert.equal(existsSync(inRepo(archived)), false);
      assert.equal(git(rootDir, "show", `HEAD:${archived}`), archivedBody.trim());
      assert.equal(git(rootDir, "diff", "--cached", "--name-status"), `M\t${staged}`);

      let operatorHead: string | null = null;
      for (const revision of [3, 4]) {
        const logicalPath = `context/published-${revision}.md`,
          document = docBundle(store, `# Publication ${revision}\n`, revision, `publish-${revision}`, logicalPath);
        store.append(document);
        projection.apply(document.event, document.plan);
        await store.settlePendingMaterialization!("publish an incremental cut");
        assert.equal(store.followerStatus().worktree.cut?.revision, revision);
        assert.equal(git(rootDir, "status", "--porcelain", "--", `harness/${logicalPath}`, archived), "");
        assert.equal(git(rootDir, "diff", "--cached", "--name-status"), `M\t${staged}`);
        if (operatorHead !== null) assert.equal(git(rootDir, "rev-parse", "HEAD^"), operatorHead);
        else {
          writeFileSync(inRepo("README.md"), "# Operator delivery\n");
          git(rootDir, "add", "README.md");
          git(rootDir, "commit", "-qm", "operator delivery", "--", "README.md");
          operatorHead = git(rootDir, "rev-parse", "HEAD");
        }
      }
      assert.equal(coldReads, 1, "ordinary writes use projection deltas after attach");
      assert.equal(readFileSync(inRepo(draft), "utf8"), '{"dirty":true}\n');
      assert.equal(readFileSync(inRepo(staged), "utf8"), "unstaged edit\n");
      assert.equal(git(rootDir, "show", `:${staged}`), "staged edit");
    } finally {
      await store.drain();
      projection.close();
    }
  });
});

test("attach repairs the index after the ref advances and the publisher exits before indexing", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const options = { repoId: "outbox-index-interrupted", rootDir },
      logical = "context/interrupted.md",
      target = `harness/${logical}`;
    const interrupted = makeTaskEventStore({
      ...options,
      killpoint: (point) => {
        if (point === "after_git_ref_update") throw new Error("after ref before index");
      },
    });
    try {
      interrupted.append(docBundle(interrupted, "# Interrupted\n", 1, "interrupted", logical));
      await interrupted.settlePendingMaterialization!("interrupt after updating the branch");
      assert.equal(interrupted.materializationHealth().lastError, "after ref before index");
      assert.equal(git(rootDir, "diff", "--cached", "--name-status", "--", target), `D\t${target}`);
    } finally {
      await interrupted.drain();
    }
    const head = git(rootDir, "rev-parse", "HEAD"),
      recovered = makeTaskEventStore(options);
    try {
      await recovered.settlePendingMaterialization!("recover the certified cut");
      assert.equal(recovered.followerStatus().worktree.cut?.revision, 1);
      assert.equal(git(rootDir, "rev-parse", "HEAD"), head);
      assert.equal(git(rootDir, "status", "--porcelain", "--", "harness"), "");
      assert.equal(readFileSync(path.join(rootDir, target), "utf8"), "# Interrupted\n");
    } finally {
      await recovered.drain();
    }
  });
});

test("attach recovers a retirement already in Git while its preimage is still on disk", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const options = { repoId: "outbox-retirement-interrupted", rootDir },
      logical = "context/retired.md",
      target = `harness/${logical}`,
      authored = path.join(rootDir, target);
    let interrupt = false,
      store = makeTaskEventStore({
        ...options,
        killpoint: (point) => {
          if (interrupt && point === "after_git_ref_update") throw new Error("retirement before indexing");
        },
      }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      const created = docBundle(store, "# To retire\n", 1, "create", logical);
      assert.equal(created.event.schema, "doc-event/v1");
      store.append(created);
      projection.apply(created.event, created.plan);
      await store.settlePendingMaterialization!("seed retired preimage");
      const original = created.event.payload.changes[0]!,
        retirement = {
          ...created.event,
          eventId: "event-retire",
          opId: "retire",
          workspaceRevision: 2,
          payload: {
            executionId: null,
            baseLedgerSha: store.currentCut(),
            retirementReason: "superseded",
            changes: [
              {
                path: original.path,
                baseBlobSha256: original.candidate!.sha256,
                candidate: null,
                policyId: original.policyId,
                regionProofs: [],
              },
            ],
          },
        },
        plan = docSyncWritePlan(retirement);
      interrupt = true;
      store.append({ event: retirement, plan, blobs: [] });
      projection.apply(retirement, plan);
      await store.settlePendingMaterialization!("leave the worktree at the previous revision");
      assert.equal(store.materializationHealth().lastError, "retirement before indexing");
      assert.equal(git(rootDir, "ls-tree", "--name-only", "HEAD", "--", target), "");
      assert.equal(readFileSync(authored, "utf8"), "# To retire\n");
      await store.drain();
      projection.close();

      store = makeTaskEventStore({
        ...options,
        readMaterializationDocuments: (forced, after, expected, previous) =>
          projection.readCut().watermark === expected
            ? readNodeMaterializationDocuments(projection, "include_done", forced, after, previous)
            : null,
      });
      projection = makeTaskProjection({ rootDir, eventStore: store });
      await store.settlePendingMaterialization!("recover retirement from the previous cut");
      assert.equal(store.followerStatus().worktree.cut?.revision, 2);
      assert.equal(existsSync(authored), false);
      assert.equal(git(rootDir, "status", "--porcelain", "--", "harness"), "");
    } finally {
      await store.drain();
      projection.close();
    }
  });
});

test("a warm outbox cut uses the same Git operations with thousands of unrelated index entries", async (t) => {
  const runs: { entries: number; processes: number[]; milliseconds: number[] }[] = [];
  for (const entries of [20, 20_000]) {
    await withTempStoreAsync(async (rootDir) => {
      initRepo(rootDir);
      const oid = git(rootDir, "rev-parse", "HEAD:harness/.gitattributes"),
        index = Array.from(
          { length: entries },
          (_, i) => `100644 ${oid}\tharness/tasks/task_history_${i}/task_plan.md\0`,
        ).join("");
      execFileSync("git", ["-C", rootDir, "update-index", "-z", "--index-info"], { input: index });
      git(rootDir, "commit", "-qm", "unrelated task history");
      const store = makeTaskEventStore({ repoId: `outbox-sized-${entries}`, rootDir }),
        run = { entries, processes: [] as number[], milliseconds: [] as number[] };
      try {
        for (const revision of [1, 2, 3, 4]) {
          const before = localGitProcessCount(),
            started = performance.now();
          store.append(
            docBundle(store, "# One changed document\n", revision, `op-${revision}`, `context/only-${revision}.md`),
          );
          assert.equal(localGitProcessCount(), before, "SQLite acceptance does not start Git");
          await store.settlePendingMaterialization!("measure a fixed-size cut");
          assert.equal(store.followerStatus().worktree.cut?.revision, revision);
          if (revision === 1) continue;
          run.processes.push(localGitProcessCount() - before);
          run.milliseconds.push(Math.round(performance.now() - started));
        }
        assert.equal(git(rootDir, "diff", "--cached", "--name-only"), "");
        runs.push(run);
      } finally {
        await store.drain();
      }
    });
  }
  t.diagnostic(JSON.stringify(runs));
  assert.deepEqual(runs[0]?.processes, runs[1]?.processes);
});
