import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findCapabilitiesKindSourceViolations } from "./check-capabilities-kind-source.mjs";

const scriptPath = path.resolve(import.meta.dirname, "check-capabilities-kind-source.mjs");

test("capabilities kind source check rejects hardcoded task and decision set literals", () => {
  const source = 'const knownEntityKinds = new Set(["task", "decision", "fact"]);\n';

  assert.deepEqual(findCapabilitiesKindSourceViolations(source, "fixture.ts"), [
    "fixture.ts:1: capabilities parser must derive entity kinds from registries, not hardcode a kind list."
  ]);
});

test("capabilities kind source check accepts registry-derived sets", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-capabilities-kind-source-"));
  writeFile(root, "packages/cli/src/cli/parsers/capabilities.ts", [
    'import { capabilityEntityKinds } from "../capability-entity-kinds.ts";',
    "const knownEntityKinds = new Set(capabilityEntityKinds);",
    ""
  ].join("\n"));

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Capabilities kind source check passed/u);
});

function writeFile(root, relativePath, body) {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, body, "utf8");
}
