// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { runtimeVersionGate } from "../src/runtime-version.ts";

/** The one version-floor comparison every admission boundary shares:
 *  a Claude Code below the kind's declared minimum is refused with the reason,
 *  a supported or unconstrained CLI passes, and an unreadable version fails closed. */
test("a Claude CLI below the declared floor is refused with both versions and the upgrade command", () => {
  const below = runtimeVersionGate("claude", "2.1.268 (Claude Code)");
  assert.ok(below);
  assert.equal(below.code, "minimum_version_not_met");
  assert.match(below.hint, /2\.1\.268/u);
  assert.match(below.hint, /2\.1\.280/u);
  assert.match(below.hint, /claude update/u);
  // One patch below the floor is still below it; the comparison is numeric, not textual.
  assert.equal(runtimeVersionGate("claude", "2.1.279 (Claude Code)")?.code, "minimum_version_not_met");
  assert.equal(runtimeVersionGate("claude", "2.1.99")?.code, "minimum_version_not_met");
  assert.equal(runtimeVersionGate("claude", "2.0.999")?.code, "minimum_version_not_met");
});

test("the declared floor itself and every newer Claude version pass, including a major/minor bump", () => {
  for (const version of ["2.1.280 (Claude Code)", "2.1.281", "2.1.305 (Claude Code)", "2.2.0", "3.0.0"]) {
    assert.equal(runtimeVersionGate("claude", version), null, version);
  }
});

test("a version the CLI prints without a readable triple fails closed instead of passing", () => {
  for (const version of ["claude-test", "", "2.1", "unknown (Claude Code)"]) {
    assert.equal(runtimeVersionGate("claude", version)?.code, "minimum_version_not_met", version);
  }
});

test("kinds that declare no floor are never gated by this comparison", () => {
  for (const version of ["0.146.1", "codex-test", ""]) assert.equal(runtimeVersionGate("codex", version), null);
});
