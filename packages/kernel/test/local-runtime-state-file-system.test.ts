// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  isConcurrentRenameLoss,
  isExclusiveCreateConflict
} from "../src/local/local-layout-file-system.ts";

test("Windows classifies lock EPERM by exclusive-create and rename operation context", () => {
  const eperm = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  const exists = Object.assign(new Error("already exists"), { code: "EEXIST" });

  assert.equal(isExclusiveCreateConflict(eperm, "win32"), true);
  assert.equal(isExclusiveCreateConflict(eperm, "linux"), false);
  assert.equal(isExclusiveCreateConflict(exists, "linux"), true);

  assert.equal(isConcurrentRenameLoss(eperm, "win32"), true);
  assert.equal(isConcurrentRenameLoss(eperm, "linux"), false);
});
