import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findErrorClassificationViolations } from "./check-error-classification.mjs";

test("error classification gate rejects substring classification", () => {
  withTempRoot((rootDir) => {
    const sourceDir = path.join(rootDir, "packages/cli/src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "bad.ts"), [
      "const message = error.message;",
      "if (message.includes(\"task not found\")) throw error;",
      "if (raw.includes(\"invalid transition\")) throw error;",
      "if (String(cause).includes(\"lock\")) throw error;"
    ].join("\n"));

    const violations = findErrorClassificationViolations(rootDir, ["packages/cli/src"]);

    assert.equal(violations.length, 3);
    assert.deepEqual(violations.map((violation) => violation.rule), [
      "message-includes",
      "raw-includes",
      "stringified-error-includes"
    ]);
  });
});

test("error classification gate allows typed error classification", () => {
  withTempRoot((rootDir) => {
    const sourceDir = path.join(rootDir, "packages/cli/src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "good.ts"), [
      "if (error._tag === \"TaskNotFound\") return \"task_not_found\";",
      "if (cause instanceof WriteLockHeldError) return \"write_conflict\";"
    ].join("\n"));

    assert.deepEqual(findErrorClassificationViolations(rootDir, ["packages/cli/src"]), []);
  });
});

function withTempRoot(fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-error-gate-"));
  try {
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
