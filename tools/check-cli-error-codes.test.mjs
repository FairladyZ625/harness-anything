// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findCliErrorCodeViolations } from "./check-cli-error-codes.mjs";

test("thin error vocabulary accepts declared receipt codes", () => fixture((root) => {
  write(root, "packages/cli/src/cli/thin-command.ts", `export const thinCliLocalErrorCodes = Object.freeze(["missing_field"]);\nrejected("missing_field");\n`);
  assert.deepEqual(findCliErrorCodeViolations(root), []);
}));

test("thin error vocabulary rejects inline, duplicate, unused, and retired registries", () => fixture((root) => {
  write(root, "packages/cli/src/cli/thin-command.ts", `export const thinCliLocalErrorCodes = Object.freeze(["missing_field", "missing_field", "unused_code"]);\nrejected("missing_field");\nrejected("unknown_field");\nconst CliErrorCode = {};\n`);
  const violations = findCliErrorCodeViolations(root).join("\n");
  assert.match(violations, /missing_field is duplicated/u); assert.match(violations, /unknown_field is missing/u);
  assert.match(violations, /unused code unused_code/u); assert.match(violations, /retired CliErrorCode registry/u);
}));

function fixture(run) { const root = mkdtempSync(path.join(tmpdir(), "thin-errors-")); try { mkdirSync(path.join(root, "packages/cli/src/cli"), { recursive: true }); run(root); }
  finally { rmSync(root, { recursive: true, force: true }); } }
function write(root, relative, body) { const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); }
