// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { REPO_ATTACH_TIMEOUT_MS, REPO_ATTACH_TIMEOUT_MS_ENV, resolveRepoAttachTimeoutMs } from "../src/runtime.ts";

test("repository attach timeout keeps the production default and accepts node-local overrides", () => {
  assert.equal(resolveRepoAttachTimeoutMs({}), REPO_ATTACH_TIMEOUT_MS);
  assert.equal(resolveRepoAttachTimeoutMs({ [REPO_ATTACH_TIMEOUT_MS_ENV]: "900000" }), 900_000);
  assert.equal(resolveRepoAttachTimeoutMs({ [REPO_ATTACH_TIMEOUT_MS_ENV]: "" }), REPO_ATTACH_TIMEOUT_MS);
  for (const invalid of ["0", "-1", "1.5", "not-a-number"]) {
    assert.throws(
      () => resolveRepoAttachTimeoutMs({ [REPO_ATTACH_TIMEOUT_MS_ENV]: invalid }),
      new RegExp(`${REPO_ATTACH_TIMEOUT_MS_ENV} must be a positive integer`),
    );
  }
});
