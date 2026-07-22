// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { resolveGitMaxBufferBytes, resolveProjectionMaxChangedPaths } from "../src/runtime/operational-limits.ts";

test("operational Git limits keep defaults and accept bounded environment overrides", () => {
  assert.equal(resolveGitMaxBufferBytes({}), 256 * 1024 * 1024);
  assert.equal(resolveProjectionMaxChangedPaths({}), 50_000);
  assert.equal(resolveGitMaxBufferBytes({ HARNESS_GIT_MAX_BUFFER_BYTES: "1048576" }), 1_048_576);
  assert.equal(resolveProjectionMaxChangedPaths({ HARNESS_PROJECTION_MAX_CHANGED_PATHS: "75000" }), 75_000);
});

test("operational Git limits reject invalid or unbounded environment values", () => {
  assert.throws(() => resolveGitMaxBufferBytes({ HARNESS_GIT_MAX_BUFFER_BYTES: "0" }), /HARNESS_GIT_MAX_BUFFER_BYTES/u);
  assert.throws(() => resolveGitMaxBufferBytes({ HARNESS_GIT_MAX_BUFFER_BYTES: String(2 * 1024 * 1024 * 1024) }), /HARNESS_GIT_MAX_BUFFER_BYTES/u);
  assert.throws(() => resolveProjectionMaxChangedPaths({ HARNESS_PROJECTION_MAX_CHANGED_PATHS: "many" }), /HARNESS_PROJECTION_MAX_CHANGED_PATHS/u);
});
