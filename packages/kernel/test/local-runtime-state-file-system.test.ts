// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isConcurrentRenameLoss,
  isExclusiveCreateConflict
} from "../src/local/local-layout-file-system.ts";

test("Windows classifies only observed EPERM path races as runtime-state contention", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-runtime-state-race-"));
  const existing = path.join(root, "existing.lock");
  const missing = path.join(root, "missing.lock");
  writeFileSync(existing, "holder", "utf8");
  try {
    const eperm = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const exists = Object.assign(new Error("already exists"), { code: "EEXIST" });

    assert.equal(isExclusiveCreateConflict(eperm, existing, "win32"), true);
    assert.equal(isExclusiveCreateConflict(eperm, missing, "win32"), false);
    assert.equal(isExclusiveCreateConflict(eperm, existing, "linux"), false);
    assert.equal(isExclusiveCreateConflict(exists, missing, "linux"), true);

    assert.equal(isConcurrentRenameLoss(eperm, missing, "win32"), true);
    assert.equal(isConcurrentRenameLoss(eperm, existing, "win32"), false);
    assert.equal(isConcurrentRenameLoss(eperm, missing, "linux"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
