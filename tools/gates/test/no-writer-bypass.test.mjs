// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import rule from "../eslint-rules/no-writer-bypass.js";

function lint(source, filename = "packages/example/src/bypass.ts") {
  const linter = new Linter({ configType: "flat" });
  return linter.verify(source, {
    files: ["**/*.ts"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
    plugins: { ha: { rules: { "no-writer-bypass": rule } } },
    rules: { "ha/no-writer-bypass": "error" }
  }, { filename });
}

test("G01 rejects event fs writes and direct event/lease publication calls", () => {
  const messages = lint([
    "import { appendFileSync } from 'node:fs';",
    "import { applyLeaseCasWrite as mutateLease } from './task-lease-cas.ts';",
    "appendFileSync('harness/events/workspace.ndjson', '{}');",
    "appendTaskEventAtPublicationBoundary(target, event);",
    "applyLeaseCasWrite(root, op);",
    "issueWriterGenerationToken(writer);"
  ].join("\n"));
  assert.equal(messages.length, 5);
  assert.match(messages.map((entry) => entry.message).join("\n"), /writer owner.*event stream.*writer owner.*writer owner.*writer owner/su);
});

test("G01 accepts coordinator-owned publication and unrelated file writes", () => {
  assert.deepEqual(lint("applyLeaseCasWrite(root, op);", "packages/kernel/src/store/write-journal-operations.ts"), []);
  assert.deepEqual(lint("import { writeFileSync } from 'node:fs'; writeFileSync('report.json', '{}');"), []);
});
