// harness-test-tier: integration
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { makeTaskProjectionReader } from "@harness-anything/storage";
import { withTempStoreAsync } from "../../storage/test/store/helpers.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { seedLegacyReadIndexEvents } from "./online-read-index.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

test("100000-event cache attaches before backfill and resumes a failed page through recovery", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    execFileSync("git", ["init", "-q", rootDir]);
    const progress = new EventEmitter();
    const input = {
      rootDir: canonicalRoot(rootDir),
      repoId: workspaceId("online-attach"),
      ownerId: "online-attach",
      onStatus: () => {
        progress.emit("page");
      },
    };
    let cell = await openBootstrappedRepoCell(input);
    await cell.close();
    const head = seedLegacyReadIndexEvents(rootDir, 100000, true),
      projectionPath = resolveHarnessLayout(rootDir).taskProjectionPath;
    const start = performance.now();
    cell = await openBootstrappedRepoCell(input);
    const attachMs = performance.now() - start,
      inspect = new DatabaseSync(projectionPath, { readOnly: true }),
      reader = makeTaskProjectionReader({ rootDir });
    try {
      assert.equal(cell.status().state, "attached");
      const pendingAtAttach = Number(
        inspect
          .prepare(
            "SELECT count(*) AS n FROM event_index WHERE workspace_revision>(SELECT revision FROM runtime_read_index_progress)",
          )
          .get()!.n,
      );
      assert.ok(pendingAtAttach > 0, "attach consumed the historical migration");
      assert.equal(inspect.prepare("SELECT complete FROM runtime_read_index_progress").get()!.complete, 0);
      const readStart = performance.now();
      assert.equal(
        reader.withSession((q) => q.readRuntimeDispatchByDispatchKey("key-100000"))?.event.payload.dispatchId,
        "dispatch-100000",
      );
      const readMs = performance.now() - readStart;
      await assert.doesNotReject(async () => {
        const signal = AbortSignal.timeout(5000);
        while (cell.status().state === "attached") await once(progress, "page", { signal });
      }, "a failed migration must publish an unavailable status without a foreground request");
      assert.equal(cell.status().state, "unavailable");
      assert.match(cell.status().lastError!, /injected read-index page failure/u);
      assert.equal(cell.status().queueDepth, 0);
      await assert.rejects(cell.verifyReadiness(), { code: "repo_unavailable" });
      const failedProgress = inspect.prepare("SELECT revision,complete FROM runtime_read_index_progress").get()!;
      assert.equal(failedProgress.revision, 64, "the failed page must preserve the last committed cursor");
      assert.equal(failedProgress.complete, 0);
      assert.equal(
        inspect.prepare("SELECT dispatch_key FROM runtime_dispatch_index WHERE workspace_revision=65").get(),
        undefined,
      );
      assert.equal(
        reader.withSession((q) => q.readRuntimeDispatchByDispatchKey("key-100000"))?.event.payload.dispatchId,
        "dispatch-100000",
        "the previous reader remains correct while maintenance is latched",
      );
      const repair = new DatabaseSync(projectionPath);
      try {
        repair.exec("DROP TRIGGER inject_backfill_failure");
      } finally {
        repair.close();
      }
      // Normal writer admission owns recovery; it reopens the handles and kicks maintenance.
      const recovered = await cell.run(
        { kind: "task-create", taskId: "task_after_backfill_fault", title: "After backfill fault" },
        withPolicyGroup({ actor: { principal: { personId: "fixture" }, executor: null }, source: "local" }, "admin"),
      );
      assert.equal(recovered.outcome, "applied", JSON.stringify(recovered));
      assert.equal(cell.status().state, "attached");
      assert.equal(cell.status().lastError, null);
      // Wait on durable progress, with bounded event-loop turns, never a wall-clock sleep.
      for (let turn = 0; turn < 5000; turn++) {
        if (inspect.prepare("SELECT complete FROM runtime_read_index_progress").get()!.complete === 1) break;
        await once(progress, "page", { signal: AbortSignal.timeout(30000) });
      }
      assert.equal(inspect.prepare("SELECT complete FROM runtime_read_index_progress").get()!.complete, 1);
      assert.equal(
        reader.withSession((q) => q.readRuntimeDispatchByDispatchKey("key-100000"))?.event.payload.dispatchId,
        "dispatch-100000",
      );
      t.diagnostic(
        `ONLINE_ATTACH ${JSON.stringify({ events: head, attachMs, pendingAtAttach, readMs, resumedFrom: failedProgress.revision })}`,
      );
    } finally {
      reader.close();
      inspect.close();
      await cell.close();
    }
  });
});
