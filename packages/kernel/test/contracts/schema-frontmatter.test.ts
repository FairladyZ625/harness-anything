import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Schema } from "effect";
import { TaskFrontmatterSchema } from "../../src/schemas/registry.ts";

const validFixtureUrl = new URL("../../fixtures/schemas/task-frontmatter/valid.json", import.meta.url);

test("task frontmatter schema decodes and encodes the valid fixture", async () => {
  const fixture = JSON.parse(await readFile(validFixtureUrl, "utf8")) as unknown;
  const decoded = Schema.decodeUnknownSync(TaskFrontmatterSchema)(fixture);
  const encoded = Schema.encodeSync(TaskFrontmatterSchema)(decoded);

  assert.deepEqual(encoded, fixture);
});
