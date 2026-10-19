// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { listBundledAgentDeclarationIds, readBundledAgentDeclaration } from "../src/index.ts";

test("bundled agent ids are enumerable and every offered id resolves to a bundled declaration", () => {
  const ids = listBundledAgentDeclarationIds();
  assert.ok(ids.includes("closeout-reviewer"), `bundled face must offer the default reviewer: ${ids.join(", ")}`);
  for (const id of ids) assert.ok(readBundledAgentDeclaration(id)?.id === id);
});
