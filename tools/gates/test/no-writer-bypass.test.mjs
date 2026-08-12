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

test("G01 rejects event fs writes and direct writer-token issuance", () => {
  const messages = lint([
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync('harness/events/workspace.ndjson', '{}');",
    "issueWriterGenerationToken(writer);"
  ].join("\n"));
  assert.equal(messages.length, 2);
  assert.match(messages.map((entry) => entry.message).join("\n"), /event stream.*writer owner/su);
});

test("G01 accepts unrelated file writes", () => {
  assert.deepEqual(lint("import { writeFileSync } from 'node:fs'; writeFileSync('report.json', '{}');"), []);
});
