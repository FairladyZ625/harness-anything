// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  checkDaemonStatusVocabularyProjection,
  daemonStatusVocabularyProjectionFinding,
  normalizeProjectionLineEndings,
} from "./generate-daemon-status-vocabulary.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("daemon status vocabulary has one current build-time projection", () => {
  assert.doesNotThrow(() => checkDaemonStatusVocabularyProjection());
  const source = readFileSync(path.join(root, "packages/daemon/src/protocol/daemon-protocol-vocabulary.ts"), "utf8");
  assert.match(source, /daemon-status-vocabulary:generated:start/u);
  assert.match(source, /daemon-status-vocabulary:generated:end/u);
});

test("daemon status projection freshness catches edits and normalizes checkout line endings", () => {
  const source = readFileSync(path.join(root, "packages/daemon/src/protocol/daemon-protocol-vocabulary.ts"), "utf8");
  assert.match(daemonStatusVocabularyProjectionFinding(source.replace('"standing", ', "")) ?? "", /is stale/u);
  assert.equal(normalizeProjectionLineEndings("first\r\nsecond\r\n"), "first\nsecond\n");
});
