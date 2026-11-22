// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { listBundledAgentDeclarationIds, readBundledAgentDeclaration } from "../src/index.ts";

for (const role of ["worker", "reviewer", "commander"] as const)
  test(`bundled ${role} is a portable identity without skills or provider bindings`, () => {
    assert.ok(listBundledAgentDeclarationIds("software/coding").includes(role));
    const agent = readBundledAgentDeclaration(role, "software/coding");
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
  const ids = listBundledAgentDeclarationIds("software/coding");
  assert.ok(ids.includes("closeout-reviewer"), `bundled face must offer the default reviewer: ${ids.join(", ")}`);
  for (const id of ids) assert.ok(readBundledAgentDeclaration(id, "software/coding")?.id === id);
  const reviewer = readBundledAgentDeclaration("closeout-reviewer", "software/coding");
  assert.ok(reviewer);
  assert.doesNotMatch(reviewer.instructions, /an adopted or fixed finding needs no resolution/u);
  assert.doesNotMatch(
    reviewer.instructions,
    /remove that resolution and resubmit the unchanged verdict and review id/u,
  );
  // dec_42EB7B8F636C12381A447E52A3/CH1: unknown or empty verticals never fall back to software/coding agents.
  assert.deepEqual(listBundledAgentDeclarationIds("unknown/vertical"), []);
  assert.equal(readBundledAgentDeclaration("closeout-reviewer", "unknown/vertical"), null);
});
