// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gitPathRejectionReason } from "@harness-anything/kernel/internal/domain/git-path.ts";
import { validateCanonicalWriteBundle } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { docBundle, initRepo, repoLinkBundle } from "./task-event-store.fixtures.ts";

// Use update-index --cacheinfo, the publication boundary, without requiring the host filesystem
// to create NTFS streams or HFS-aliased filenames. Both protections are explicit, not host config.
test("Git's real index agrees with the portable Git metadata restrictions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-git-path-oracle-"));
  try {
    initRepo(root);
    const oid = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
      input: "target",
      encoding: "utf8",
    }).trim();
    for (const mode of ["100644", "120000"]) {
      for (const name of [
        ".git",
        ".GIT",
        "git~1",
        ".git .",
        ".git:stream",
        "git~1::$INDEX_ALLOCATION",
        ".g\u200cit",
        "\ufeff.git",
        ".git\u206f",
        ".github",
        "foo.git",
        "git~2",
        "git~10",
        ".git.txt",
        ".git\u200b",
        ".gitmodules",
        ".gitmodules .",
        ".gitmodules:stream",
        ".git\u200cmodules",
        "gitmod~1",
        "gitmod~4",
        "gitmod~5",
        "gi7eba~1",
        "gi7eb~10",
        "gi~12345",
        "gi~01234",
        "gi7eba~10",
      ]) {
        const logical = `artifacts/${name}/file`,
          result = spawnSync(
            "git",
            [
              "-C",
              root,
              "-c",
              "core.protectHFS=true",
              "-c",
              "core.protectNTFS=true",
              "update-index",
              "--add",
              "--cacheinfo",
              mode,
              oid,
              logical,
            ],
            { encoding: "utf8" },
          ),
          rejected = gitPathRejectionReason(logical, mode === "120000") !== null;
        assert.equal(result.error, undefined);
        assert.equal(result.status === 0, !rejected, `${mode} ${JSON.stringify(logical)}: ${result.stderr}`);
        if (rejected) assert.match(result.stderr, /Invalid path|invalid path/u);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid preceding document rejects the whole bundle before event, blob or outcome writes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-git-path-bundle-"));
  initRepo(rootDir);
  const store = makeTaskEventStore({ rootDir, repoId: "git-path-bundle" });
  try {
    const bad = docBundle(store, "# Bad\n", 1, "op-bad-path", "tasks/task/artifacts/.git/HEAD"),
      good = docBundle(store, "# Good\n", 2, "op-good-path", "tasks/task/artifacts/.github/foo.git"),
      before = store.readHead();
    assert.throws(() => store.append({ ...good, preceding: [bad] }), { code: "invalid_write_plan" });
    assert.deepEqual(store.readHead(), before);
    for (const bundle of [bad, good]) {
      assert.equal(store.readEvent(bundle.event.opId), null);
      assert.equal(store.readCommandOutcome(bundle.event.opId), null);
      assert.equal(store.readContentBlob(bundle.blobs[0]!.sha256), null);
    }
    assert.throws(() => validateCanonicalWriteBundle(repoLinkBundle("context/.gitmodules", "target")), {
      code: "invalid_write_plan",
    });
    // Portable syntax remains the existing write-plan contract: no normalization into another target.
    for (const target of ["tasks/./file", "tasks/../file", "tasks//file", "tasks/.git:stream/file", "tasks/.git./file"])
      assert.throws(
        () => validateCanonicalWriteBundle(docBundle(store, "# Bad\n", 1, "op-syntax", target)),
        undefined,
        target,
      );
  } finally {
    await store.drain();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
