import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDocmapReadSet, readDocmapManifest } from "../../src/index.ts";

test("docmap manifest reader normalizes authored-root relative docs and computes scoped read set", () => {
  withTempRoot((rootDir) => {
    writeDocmap(rootDir, {
      schema: "docmap/v1",
      documents: [
        doc("adr-0011", "context/architecture/adr/ADR-0011.md", ["m4-loadbearing"], ["kernel"]),
        doc("global-standard", "governance/standards/testing-standard.md", [], []),
        { ...doc("old", "context/old.md", ["m4-loadbearing"], []), supersededBy: "adr-0011" }
      ]
    });

    const result = readDocmapManifest(rootDir);
    const readSet = buildDocmapReadSet(result.manifest, { moduleKey: "m4-loadbearing" });

    assert.equal(result.relativePath, "harness/docmap.json");
    assert.deepEqual(result.manifest.documents.map((entry) => entry.path), [
      "context/architecture/adr/ADR-0011.md",
      "context/old.md",
      "governance/standards/testing-standard.md"
    ]);
    assert.deepEqual(readSet.mandatory.map((entry) => entry.id), ["adr-0011"]);
    assert.deepEqual(readSet.recommended.map((entry) => entry.id), ["global-standard"]);
  });
});

test("docmap manifest reader rejects unsafe document paths", () => {
  withTempRoot((rootDir) => {
    writeDocmap(rootDir, {
      schema: "docmap/v1",
      documents: [
        doc("bad", "../outside.md", ["m4-loadbearing"], [])
      ]
    });

    assert.throws(() => readDocmapManifest(rootDir), /docmap/i);
  });
});

test("docmap manifest reader rejects duplicate document ids", () => {
  withTempRoot((rootDir) => {
    writeDocmap(rootDir, {
      schema: "docmap/v1",
      documents: [
        doc("duplicate", "adr/ADR-0001-one.md", [], []),
        doc("duplicate", "adr/ADR-0002-two.md", [], [])
      ]
    });

    assert.throws(() => readDocmapManifest(rootDir), /duplicate document ids/u);
  });
});

function doc(id: string, docPath: string, modules: string[], productLines: string[]) {
  return {
    id,
    path: docPath,
    kind: "adr",
    scope: { modules, productLines },
    updatedAt: "2026-07-07T00:00:00.000Z"
  };
}

function writeDocmap(rootDir: string, value: unknown): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  writeFileSync(path.join(harnessRoot, "docmap.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-docmap-kernel-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
