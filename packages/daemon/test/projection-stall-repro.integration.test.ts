// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./task-completion-review.fixture.ts";

test("repo status exposes the projection and ledger cuts after completion", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const dispatched = (await f.complete()) as Record<string, unknown>;
    const reviewed = await f.review(String(dispatched.runtimeSessionId), "review-stall");
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const closeoutPath = path.join(f.root, "harness", f.packagePath, "closeout.md");
    writeFileSync(closeoutPath, `${readFileSync(closeoutPath, "utf8")}\nEdited after submit.\n`);
    const completed = await f.complete(true);
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    const revision = f.events().length;
    const status = f.cell().status();
    assert.equal(status.projectionWatermark, revision);
    assert.equal(status.ledgerRevision, revision);
  } finally {
    await f.close();
  }
});
