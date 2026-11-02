// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { listBundledAgentDeclarationIds, readBundledAgentDeclaration } from "../src/index.ts";

for (const role of ["worker", "reviewer", "commander"] as const)
  test(`bundled ${role} is a portable identity without skills or provider bindings`, () => {
    assert.ok(listBundledAgentDeclarationIds().includes(role));
    const agent = readBundledAgentDeclaration(role);
    assert.ok(agent);
    assert.equal(agent.id, role);
    assert.equal(agent.name, role);
    assert.equal(agent.role, role);
    assert.deepEqual(agent.skills, []);
    assert.deepEqual(agent.runtimes, []);
    assert.equal(agent.instance, undefined);
    assert.equal(agent.preferredInstances, undefined);
    assert.equal(agent.preset, undefined);
    assert.equal(agent.permissionMode, undefined);
    assert.deepEqual(agent.prompts ?? [], []);
    assert.doesNotMatch(agent.instructions, /harness|skills?\/|\/Users\/|[A-Z]:\\|provider|codex|claude/iu);
  });

test("bundled agent ids are enumerable and every offered id resolves to a bundled declaration", () => {
  const ids = listBundledAgentDeclarationIds();
  assert.ok(ids.includes("closeout-reviewer"), `bundled face must offer the default reviewer: ${ids.join(", ")}`);
  for (const id of ids) assert.ok(readBundledAgentDeclaration(id)?.id === id);
  const reviewer = readBundledAgentDeclaration("closeout-reviewer");
  assert.ok(reviewer);
  assert.doesNotMatch(reviewer.instructions, /an adopted or fixed finding needs no resolution/u);
  assert.doesNotMatch(
    reviewer.instructions,
    /remove that resolution and resubmit the unchanged verdict and review id/u,
  );
});
