// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { assertEventOpId, eventObjectShard, eventObjectTarget } from "../../src/layout/ledger-object-layout.ts";

// #1587: runtime spawn composed its event opIds as `${dispatchOpId}:${suffix}`. Every event
// write plan turns an opId into a path component, so on Windows git fast-import rejected the
// whole publication with `fatal: invalid path` — far from the code that chose the separator.
// The guard lives on the shared choke point so no future event kind can reintroduce the class.
test("#1587: an opId that cannot be a filename on every platform is refused at composition", () => {
  for (const illegal of ["op:suffix", "op<1", "op>1", 'op"1', "op|1", "op?1", "op*1", "op/1", "op\\1"]) {
    assert.throws(() => assertEventOpId(illegal), /not a legal filename character/u, illegal);
    assert.throws(() => eventObjectShard(illegal), /not a legal filename character/u, illegal);
    assert.throws(() => eventObjectTarget(illegal), /not a legal filename character/u, illegal);
  }
});

test("#1587: the separators actually in use stay legal and still produce distinct targets", () => {
  const dispatch = `runtime-spawn-${"a".repeat(32)}`;
  const targets = ["installation", "started", "outcome", "outcome-unknown", "provider", "task", "cancelled", "exited"]
    .map((suffix) => eventObjectTarget(`${dispatch}-${suffix}`));
  assert.equal(new Set(targets).size, targets.length);
  for (const target of targets) assert.doesNotMatch(target.slice("harness/events/".length), /[:<>"|?*\\]/u, target);
  assert.equal(eventObjectTarget(dispatch).startsWith("harness/events/"), true);
});
