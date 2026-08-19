// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { assertPublishableOpId, eventObjectShard, eventObjectTarget } from "../../src/layout/ledger-object-layout.ts";

// #1587: runtime spawn composed its event opIds as `${dispatchOpId}:${suffix}`. A persisted
// opId becomes a path component, so on Windows git fast-import rejected the whole publication
// with `fatal: invalid path` — far from the code that chose the separator.
test("#1587: an opId that cannot be a filename is refused before publication", () => {
  for (const illegal of ["op:suffix", "op<1", "op>1", 'op"1', "op|1", "op?1", "op*1", "op/1", "op\\1"])
    assert.throws(() => assertPublishableOpId(illegal), /cannot be a filename/u, illegal);
  assert.equal(assertPublishableOpId("runtime-spawn-abc-installation"), "runtime-spawn-abc-installation");
});

// The rule guards publication, not naming. Synthetic receipt ids that were never events —
// `scan:<hash>`, `preview:<hash>` — legitimately carry colons, and resolving one has to answer
// "no such event" rather than throw. A guard on the shared path helper broke exactly that.
test("#1587: read-side path resolution stays total for ids that were never published", () => {
  for (const synthetic of ["scan:42a03ff4", "preview:718cb8b1"]) {
    assert.doesNotThrow(() => eventObjectShard(synthetic), synthetic);
    assert.doesNotThrow(() => eventObjectTarget(synthetic), synthetic);
  }
});

test("#1587: the separators actually in use stay distinct", () => {
  const dispatch = `runtime-spawn-${"a".repeat(32)}`;
  const targets = ["installation", "started", "outcome", "outcome-unknown", "provider", "task", "cancelled", "exited"]
    .map((suffix) => eventObjectTarget(`${dispatch}-${suffix}`));
  assert.equal(new Set(targets).size, targets.length);
  for (const target of targets) assert.doesNotMatch(target.slice("harness/events/".length), /[:<>"|?*\\]/u, target);
});
