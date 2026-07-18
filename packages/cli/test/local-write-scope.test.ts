// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { ParsedCommand } from "../src/cli/types.ts";
import {
  isDeclaredLocalMigrationCommand,
  isDeclaredLocalMigrationWriteAction
} from "../src/composition/local-write-scope.ts";

const action = (kind: string): ParsedCommand["action"] => ({ kind } as ParsedCommand["action"]);

test("local migration scope is action-exact and separates read companions from writers", () => {
  for (const kind of [
    "adopt-multica",
    "migrate-plan",
    "migrate-structure",
    "migrate-anchors",
    "migrate-fact-execution",
    "migrate-retired-attribution-fields",
    "migrate-provenance",
    "migrate-run",
    "migrate-verify",
    "legacy-scan",
    "legacy-intake-plan",
    "legacy-copy-safe-docs",
    "legacy-index",
    "legacy-verify"
  ]) {
    assert.equal(isDeclaredLocalMigrationCommand(action(kind)), true, kind);
  }

  for (const kind of ["migrate-plan", "migrate-verify", "legacy-scan", "legacy-intake-plan", "legacy-index", "legacy-verify"]) {
    assert.equal(isDeclaredLocalMigrationWriteAction(action(kind)), false, kind);
  }

  for (const kind of ["new-task", "record-fact", "migrate-surprise"]) {
    assert.equal(isDeclaredLocalMigrationCommand(action(kind)), false, kind);
    assert.equal(isDeclaredLocalMigrationWriteAction(action(kind)), false, kind);
  }
});
