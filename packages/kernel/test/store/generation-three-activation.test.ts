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

for (const interrupt of ["before-link", "after-link", "after-directory-sync", "none"] as const) {
  test(`activation exposes complete bytes only, including interruption ${interrupt}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-gen3-certificate-"));
    const finalPath = `${sqliteLedgerPath(root, 3)}.activation.json`;
    mkdirSync(path.dirname(finalPath), { recursive: true });
    const link = files.linkExclusive,
      sync = files.syncDirectory;
    const seen: string[] = [];
    try {
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
      assert.equal(existsSync(finalPath), interrupt !== "before-link");
      if (existsSync(finalPath)) assert.deepEqual(JSON.parse(readFileSync(finalPath, "utf8")), certificate);
      assert.deepEqual(
        seen,
        ["before-link", "after-link", "after-directory-sync"].slice(
          0,
          interrupt === "before-link" ? 1 : interrupt === "after-link" ? 2 : 3,
        ),
      );
      files.linkExclusive = link;
      files.syncDirectory = sync;
      if (interrupt === "before-link") publishGenerationThreeActivation(root, certificate);
      assert.throws(() => publishGenerationThreeActivation(root, { ...certificate, repoId: "different" }), {
        code: "EEXIST",
      });
      assert.deepEqual(JSON.parse(readFileSync(finalPath, "utf8")), certificate);
    } finally {
      files.linkExclusive = link;
      files.syncDirectory = sync;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
