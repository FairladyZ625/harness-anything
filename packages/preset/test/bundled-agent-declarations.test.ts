// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { listBundledAgentDeclarationIds, readBundledAgentDeclaration } from "../src/index.ts";

test("bundled agent ids are enumerable and every offered id resolves to a bundled declaration", () => {
  const ids = listBundledAgentDeclarationIds();
  assert.ok(ids.includes("closeout-reviewer"), `bundled face must offer the default reviewer: ${ids.join(", ")}`);
  for (const id of ids) assert.ok(readBundledAgentDeclaration(id)?.id === id);
});

test("the schema-migration reviewer ships bundled with its role declared", () => {
  const declaration = readBundledAgentDeclaration("data-migration");
  assert.ok(declaration, "the persisted-shape review lane depends on the bundled declaration resolving");
  assert.equal(declaration!.role, "reviewer");
  assert.deepEqual(declaration!.runtimes, [], "the bundled copy leaves the model to the dispatching instance");
  for (const marker of ["attach-migrations.ts", "三件套", "changes_requested"])
    assert.ok(declaration!.instructions.includes(marker), `instructions must carry the ${marker} contract`);
});
