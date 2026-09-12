// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { taskCreateAction } from "../src/repo-cell-action-parse.ts";

test("task creation rejects retired legacy inputs through direct and structured sources", () => {
  for (const fields of [{ fromLegacyId: "legacy-1" }, { title: "New task", fromLegacyId: "legacy-1" }]) {
    for (const action of [fields, { jsonInput: JSON.stringify(fields) }])
      assert.throws(
        () => taskCreateAction("/unused", { kind: "task-create", ...action }),
        /unsupported task create fields: fromLegacyId/u,
      );
  }
});

test("ordinary task creation retains direct overrides of structured fields", () => {
  assert.deepEqual(
    taskCreateAction("/unused", {
      kind: "task-create",
      title: "Override",
      jsonInput: JSON.stringify({ title: "Packet", slug: "packet" }),
    }),
    { kind: "task-create", title: "Override", slug: "packet" },
  );
});
