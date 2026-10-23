// harness-test-tier: contract
// A renamed layout.localRoot must not strand local state in the default `.harness` directory
// without saying so. This pins the classification (what a cache purge deletes vs. everything it
// preserves) and the user-visible diagnostic `ha doctor health` reports. The purge module is the
// only source of that classification, so the cases below assert the diagnostic agrees with it
// rather than restating a second list.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { doctorLocalRootResidue, oldLocalRootResidue } from "../src/repo-local-root-residue.ts";
import { cachePurgeDerivedDirectories } from "../src/repo-cache-purge.ts";
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

/** Write one real file under `<root>/.harness/<relative>`, creating parents. */
function strand(root: string, relative: string, content = "{}"): void {
  const target = path.join(root, ".harness", relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function fixture(t: { after: (fn: () => void) => void }): string {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-local-root-residue-"));
  t.after(() => removeTemporaryDirectory(parent));
  return repository(parent, ".harness.nosync");
}

test("a default-layout repository never reports residue, even with a populated .harness", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-local-root-residue-"));
  t.after(() => removeTemporaryDirectory(parent));
  const root = repository(parent, ".harness");
  strand(root, "presets/active/standard-task.json");
  strand(root, "settings.local.json", '{"schema":"settings-local/v1"}\n');
  assert.equal(oldLocalRootResidue(root), null, "the default root is the active root here");
  const check = doctorLocalRootResidue(root);
  assert.equal(check.id, "local-root-residue");
  assert.equal(check.status, "ok");
  assert.equal(check.count, 0);
});

test("derived comes from the cache purge list, authoritative from what that purge preserves", async (t) => {
  const root = fixture(t);
  for (const relative of cachePurgeDerivedDirectories) strand(root, `${relative}/leaf`);
  strand(root, "store/generations/3/ledger.sqlite");
  strand(root, "wal/head.json");
  // The diagnostic reports top-level entries, so a nested list item (`runtime/dispatches`) shows up
  // as its first segment. Everything on the purge list must still classify as derived.
  const topLevel = [...new Set(cachePurgeDerivedDirectories.map((relative) => relative.split("/")[0]!))].sort();
  const residue = oldLocalRootResidue(root);
  assert.ok(residue);
  // Every purge-list entry is derived here, including presets/ and conflicts/: the purge already
  // deletes them, so the diagnostic must agree with it instead of inventing its own list.
  assert.deepEqual(residue.derived, topLevel);
  assert.deepEqual(residue.authoritative, ["store", "wal"]);
  assert.deepEqual(residue.unrecognized, [], "nothing outside both production lists is present");
  const check = doctorLocalRootResidue(root);
  assert.equal(check.status, "fail", "the ledger family stranded at the old root is a failure");
  assert.equal(check.count, topLevel.length + 2);
  assert.match(check.next, /ha migrate ledger --help/u);
});

test("operations, credentials and wal.bricked-* are unrecognized: no list calls them disposable", async (t) => {
  const root = fixture(t);
  // Each of these exists in a real canonical local root and none is regenerable by a rebuild:
  // operations/ holds conversion drafts a backup reads, credentials/ holds a machine secret,
  // wal.bricked-* is a quarantined legacy WAL a person may still want.
  strand(root, "operations/conversion-drafts/draft.json");
  strand(root, "credentials/ubuntu-vm-password", "secret\n");
  strand(root, "wal.bricked-20260821-0940/head.json");
  const residue = oldLocalRootResidue(root);
  assert.ok(residue);
  assert.deepEqual(residue.derived, [], "none of these is on the cache purge list");
  assert.deepEqual(residue.authoritative, [], "none of these is a preserved ledger path either");
  assert.deepEqual(residue.unrecognized, ["credentials", "operations", "wal.bricked-20260821-0940"]);
  const check = doctorLocalRootResidue(root);
  assert.equal(check.status, "fail", "state the repository no longer reads is a finding, not a warning");
  assert.match(check.summary, /unrecognized/u);
  assert.match(check.summary, /credentials/u);
  assert.match(check.summary, /operations/u);
  assert.match(check.summary, /wal\.bricked-20260821-0940/u);
  assert.doesNotMatch(check.next, /rebuilt on demand/u);
  assert.doesNotMatch(check.next, /safe to ignore/u);
  assert.match(check.next, /does not judge/u, "the diagnostic must not call an unknown entry disposable");
});

test("conflicts/ is derived because the purge deletes it", async (t) => {
  const root = fixture(t);
  strand(root, "conflicts/doc-sync/doc-abc/local");
  strand(root, "cache/task.sqlite", "");
  const residue = oldLocalRootResidue(root);
  assert.ok(residue);
  assert.deepEqual(residue.derived, ["cache", "conflicts"]);
  assert.deepEqual(residue.unrecognized, []);
  const check = doctorLocalRootResidue(root);
  assert.equal(check.status, "warn");
  assert.match(check.summary, /cache purge deletes these too/u);
  assert.match(check.summary, /conflicts/u);
  assert.match(check.next, /A cache purge removes cache, conflicts\./u);
});

test("settings.local.json and preset-runs are unrecognized, so a rename never silently drops them", async (t) => {
  const root = fixture(t);
  strand(root, "settings.local.json", '{"schema":"settings-local/v1","locale":"zh-CN"}\n');
  strand(root, "preset-runs/witnesses/run.json");
  const residue = oldLocalRootResidue(root);
  assert.ok(residue);
  assert.deepEqual(residue.unrecognized, ["preset-runs", "settings.local.json"]);
  const check = doctorLocalRootResidue(root);
  assert.equal(check.status, "fail");
  assert.match(check.summary, /settings\.local\.json/u);
  assert.match(check.summary, /preset-runs/u);
});

test("a stale root holding only purge-list state is a warning, not a failure", async (t) => {
  const root = fixture(t);
  strand(root, "cache/task.sqlite", "");
  const check = doctorLocalRootResidue(root);
  assert.equal(check.status, "warn");
  assert.equal(check.count, 1);
  assert.match(check.summary, /only paths a cache purge deletes/u);
  assert.match(check.next, /A cache purge removes cache\./u);
});

test("an emptied durable tree strands nothing: only real files count", async (t) => {
  const root = fixture(t);
  // The exact shape Brain had after its rename: the directory tree exists, every leaf is empty.
  mkdirSync(path.join(root, ".harness", "preset-runs", "witnesses"), { recursive: true });
  mkdirSync(path.join(root, ".harness", "preset-runs", "staging"), { recursive: true });
  assert.equal(oldLocalRootResidue(root), null, "empty directories are leftovers, not stranded state");
  assert.equal(doctorLocalRootResidue(root).status, "ok");
  // A single real witness file makes the same shape a finding that names preset-runs.
  strand(root, "preset-runs/witnesses/run.json");
  assert.deepEqual(oldLocalRootResidue(root)?.unrecognized, ["preset-runs"]);
  assert.equal(doctorLocalRootResidue(root).status, "fail");
});

test("a symbolic link never turns the doctor check into a thrown error", async (t) => {
  const root = fixture(t);
  const oldRoot = path.join(root, ".harness");
  mkdirSync(path.join(oldRoot, "preset-runs"), { recursive: true });
  symlinkSync(oldRoot, path.join(oldRoot, "preset-runs", "loop"));
  const residue = oldLocalRootResidue(root);
  assert.ok(residue);
  assert.deepEqual(residue.unrecognized, ["preset-runs"], "a link is authored state, not a traversable tree");
});

test("an absent or empty default root reports nothing at all", async (t) => {
  const root = fixture(t);
  assert.equal(oldLocalRootResidue(root), null, "no directory is the normal post-migration state");
  assert.equal(doctorLocalRootResidue(root).status, "ok");
  mkdirSync(path.join(root, ".harness"));
  assert.equal(oldLocalRootResidue(root), null, "an empty leftover directory strands nothing");
});
