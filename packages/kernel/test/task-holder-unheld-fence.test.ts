// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskHolderService, type TaskHolderPrincipal } from "../src/index.ts";

const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";
const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7";
const principal: TaskHolderPrincipal = {
  principal: { personId: "person_alice" },
  executor: { kind: "agent", id: "codex" },
  responsibleHuman: "person_alice"
};

test("unheld terminal fence excludes a concurrent holder mutation and rejects a live holder", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-unheld-fence-"));
  try {
    const holder = makeTaskHolderService({ rootInput: { rootDir } });
    let reservationSettled = false;
    let reservation: ReturnType<typeof holder.reserveExecution> | undefined;

    await holder.withUnheldTask({ taskId }, async () => {
      reservation = holder.reserveExecution({ taskId, executionId, principal })
        .finally(() => { reservationSettled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(reservationSettled, false);
    });

    await reservation;
    let terminalCallbackRan = false;
    await assert.rejects(
      holder.withUnheldTask({ taskId }, async () => { terminalCallbackRan = true; }),
      /TASK_LIFECYCLE_HOLDER_RELEASE_REQUIRED/u
    );
    assert.equal(terminalCallbackRan, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
