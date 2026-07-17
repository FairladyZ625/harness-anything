// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  decodeDaemonLogEntry,
  decodeDaemonLogListInput,
  decodeDaemonLogPage
} from "../src/index.ts";

const fixtureRoot = path.resolve("packages/daemon/fixtures/api-schemas");

test("daemon log schema fixtures prove valid and invalid boundaries", () => {
  const contracts = [
    ["daemon-log-entry__v1", decodeDaemonLogEntry],
    ["daemon-log-list-input__v1", decodeDaemonLogListInput],
    ["daemon-log-page__v1", decodeDaemonLogPage]
  ] as const;
  for (const [fixture, decode] of contracts) {
    assert.doesNotThrow(() => decode(readFixture(fixture, "valid.json")), fixture);
    assert.throws(() => decode(readFixture(fixture, "invalid.json")), fixture);
  }
});

function readFixture(directory: string, fileName: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtureRoot, directory, fileName), "utf8")) as unknown;
}
