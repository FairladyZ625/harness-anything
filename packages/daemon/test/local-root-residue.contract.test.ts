// harness-test-tier: contract
// A renamed layout.localRoot must not strand durable local state in the default `.harness`
// directory without saying so. This pins both the detection (which entries are durable and which
// are reproducible derived state) and the user-visible diagnostic `ha doctor health` reports.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { doctorLocalRootResidue, oldLocalRootResidue } from "../src/repo-local-root-residue.ts";
import { removeTemporaryDirectory } from "../../../tools/temporary-directory-cleanup.mjs";

function repository(parent: string, localRoot: string): string {
  const root = path.join(parent, `repo-${localRoot.replace(/[^a-z0-9]/giu, "-")}`);
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness", "harness.yaml"),
    `schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: ${localRoot}\n`,
  );
  return root;
}

test("a default-layout repository never reports residue, even with a populated .harness", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-local-root-residue-"));
  t.after(() => removeTemporaryDirectory(parent));
  const root = repository(parent, ".harness");
  mkdirSync(path.join(root, ".harness", "presets", "active"), { recursive: true });
  writeFileSync(path.join(root, ".harness", "settings.local.json"), '{"schema":"settings-local/v1"}\n');
  assert.equal(oldLocalRootResidue(root), null, "the default root is the active root here");
  const check = doctorLocalRootResidue(root);
  assert.equal(check.id, "local-root-residue");
  assert.equal(check.status, "ok");
  assert.equal(check.count, 0);
});

test("a renamed local root reports stranded durable state and names the exact entries", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-local-root-residue-"));
  t.after(() => removeTemporaryDirectory(parent));
  const root = repository(parent, ".harness.nosync");
  // The old root as a rename leaves it: durable local state plus reproducible residue.
  mkdirSync(path.join(root, ".harness", "presets", "active"), { recursive: true });
  mkdirSync(path.join(root, ".harness", "wal"), { recursive: true });
  mkdirSync(path.join(root, ".harness", "cache"), { recursive: true });
  mkdirSync(path.join(root, ".harness", "preset-runs", "witnesses"), { recursive: true });
  writeFileSync(
    path.join(root, ".harness", "settings.local.json"),
    '{"schema":"settings-local/v1","locale":"zh-CN"}\n',
  );
  writeFileSync(path.join(root, ".harness", "cache", "task.sqlite"), "");
  const residue = oldLocalRootResidue(root);
  assert.ok(residue);
  assert.deepEqual(residue.durable, ["preset-runs", "presets", "settings.local.json", "wal"]);
  assert.deepEqual(residue.derived, ["cache"], "a projection cache is reproducible, not stranded data");
  const check = doctorLocalRootResidue(root);
  assert.equal(check.status, "fail", "durable local state the repository no longer reads is a failure to surface");
  assert.equal(check.count, 4);
  assert.match(check.summary, /settings\.local\.json/u);
  assert.match(check.summary, /presets/u);
  assert.match(check.summary, /safe to ignore: cache/u);
  // The next action must not tell a person to copy a ledger by hand: store/ and wal/ have a
  // conversion path, and guessing at one is exactly what the migration rules forbid.
  assert.match(check.next, /ha migrate ledger --help/u);
});

test("a stale root holding only derived state is a warning, not a failure", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-local-root-residue-"));
  t.after(() => removeTemporaryDirectory(parent));
  const root = repository(parent, ".harness.nosync");
  mkdirSync(path.join(root, ".harness", "cache"), { recursive: true });
  writeFileSync(path.join(root, ".harness", "cache", "task.sqlite"), "");
  const check = doctorLocalRootResidue(root);
  assert.equal(check.status, "warn");
  assert.equal(check.count, 1);
  assert.match(check.summary, /only derived state/u);
  assert.match(check.next, /rebuilt on demand/u);
});

test("an absent or empty default root reports nothing at all", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-local-root-residue-"));
  t.after(() => removeTemporaryDirectory(parent));
  const root = repository(parent, ".harness.nosync");
  assert.equal(oldLocalRootResidue(root), null, "no directory is the normal post-migration state");
  assert.equal(doctorLocalRootResidue(root).status, "ok");
  mkdirSync(path.join(root, ".harness"));
  assert.equal(oldLocalRootResidue(root), null, "an empty leftover directory strands nothing");
});
