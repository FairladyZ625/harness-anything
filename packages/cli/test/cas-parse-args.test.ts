// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli/parse-args.ts";

test("CAS GC parser defaults to preview and requires apply for reclamation", () => {
  const preview = parseArgs(["cas", "gc"]);
  const apply = parseArgs(["cas", "gc", "--apply"]);

  assert.equal(preview.ok, true);
  assert.equal(apply.ok, true);
  if (!preview.ok || !apply.ok) return;
  assert.deepEqual(preview.value.action, { kind: "cas-gc", mode: "dry-run" });
  assert.deepEqual(apply.value.action, { kind: "cas-gc", mode: "apply" });
});
