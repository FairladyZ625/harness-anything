// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localRuntimeStateFileSystem as files } from "../../src/local/local-layout-file-system.ts";
import {
  publishGenerationThreeActivation,
  type GenerationThreeActivation,
} from "../../src/store/generation-three-activation.ts";
import { sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";

const certificate: GenerationThreeActivation = {
  schema: "generation-activation/v3",
  repoId: "certificate-fixture",
  generation: 3,
  sourceCut: { repoId: "certificate-fixture", generation: 2, revision: 4, headDigest: `sha256:${"a".repeat(64)}` },
  importedPrefixRevision: 4,
  acceptedCut: { repoId: "certificate-fixture", revision: 5, headDigest: `sha256:${"b".repeat(64)}` },
};

for (const interrupt of ["during-write", "before-link", "after-link", "after-directory-sync", "none"] as const) {
  test(`activation exposes complete bytes only, including interruption ${interrupt}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-gen3-certificate-"));
    const finalPath = `${sqliteLedgerPath(root, 3)}.activation.json`;
    mkdirSync(path.dirname(finalPath), { recursive: true });
    const create = files.createExclusiveText,
      link = files.linkExclusive,
      sync = files.syncDirectory;
    const seen: string[] = [];
    try {
      files.createExclusiveText = (file, bytes, sync) => {
        if (interrupt === "during-write") {
          create(file, bytes.slice(0, Math.floor(bytes.length / 2)), sync);
          seen.push("during-write");
          throw new Error("injected-during-write");
        }
        return create(file, bytes, sync);
      };
      files.linkExclusive = (temporary, final) => {
        assert.equal(path.dirname(temporary), path.dirname(final));
        assert.equal(existsSync(final), false);
        assert.deepEqual(JSON.parse(readFileSync(temporary, "utf8")), certificate);
        seen.push("before-link");
        if (interrupt === "before-link") throw new Error("injected-before-link");
        link(temporary, final);
        assert.deepEqual(JSON.parse(readFileSync(final, "utf8")), certificate);
        seen.push("after-link");
        if (interrupt === "after-link") throw new Error("injected-after-link");
      };
      files.syncDirectory = (directory) => {
        sync(directory);
        seen.push("after-directory-sync");
        if (interrupt === "after-directory-sync") throw new Error("injected-after-directory-sync");
      };
      if (interrupt === "none") publishGenerationThreeActivation(root, certificate);
      else
        assert.throws(() => publishGenerationThreeActivation(root, certificate), new RegExp(`injected-${interrupt}`));
      assert.equal(existsSync(finalPath), !["during-write", "before-link"].includes(interrupt));
      if (existsSync(finalPath)) assert.deepEqual(JSON.parse(readFileSync(finalPath, "utf8")), certificate);
      assert.deepEqual(
        seen,
        interrupt === "during-write"
          ? ["during-write"]
          : ["before-link", "after-link", "after-directory-sync"].slice(
              0,
              interrupt === "before-link" ? 1 : interrupt === "after-link" ? 2 : 3,
            ),
      );
      files.createExclusiveText = create;
      files.linkExclusive = link;
      files.syncDirectory = sync;
      if (["during-write", "before-link"].includes(interrupt)) publishGenerationThreeActivation(root, certificate);
      assert.throws(() => publishGenerationThreeActivation(root, { ...certificate, repoId: "different" }), {
        code: "EEXIST",
      });
      assert.deepEqual(JSON.parse(readFileSync(finalPath, "utf8")), certificate);
    } finally {
      files.createExclusiveText = create;
      files.linkExclusive = link;
      files.syncDirectory = sync;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
