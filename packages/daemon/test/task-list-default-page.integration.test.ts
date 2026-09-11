// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { actor, evidence, initRepo } from "./task-surface.fixtures.ts";

test("task list defaults to 50 rows and exposes a continuation cursor", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-list-default-page-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-list-default-page"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-list-default-page",
      now: () => "2026-08-15T03:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    for (let index = 0; index < 51; index += 1)
      assert.equal(
        (
          await cell.run(
            { kind: "task-create", taskId: `task_${String(index).padStart(2, "0")}`, title: `Task ${index}` },
            binding,
          )
        ).outcome,
        "applied",
      );
    const listed = evidence(await cell.run({ kind: "task-list" }, binding));
    assert.equal(listed.rows.length, 50);
    assert.equal(listed.page.limit, 50);
    assert.equal(typeof listed.page.nextCursor, "string");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
