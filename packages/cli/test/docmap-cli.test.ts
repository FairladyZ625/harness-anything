import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI doc list and map read authored docmap manifest without writing state", () => {
  withTempRoot((rootDir) => {
    writeDocmap(rootDir, {
      schema: "docmap/v1",
      documents: [
        doc("adr-0011", "context/architecture/adr/ADR-0011.md", ["m4-loadbearing"], ["kernel"]),
        doc("testing-standard", "governance/standards/testing-standard.md", [], []),
        { ...doc("old-doc", "context/old.md", ["m4-loadbearing"], []), supersededBy: "adr-0011" }
      ]
    });

    const listed = runJson(rootDir, ["doc", "list", "--module", "m4-loadbearing"]);
    assert.equal(listed.ok, true);
    assert.equal(listed.command, "doc-list");
    assert.equal(listed.rows, 2);
    assert.equal(listed.paths.primary, "harness/docmap.json");
    assert.deepEqual(listed.report.documents.map((entry: { readonly id: string }) => entry.id), ["adr-0011", "old-doc"]);

    const mapped = runJson(rootDir, ["doc", "map", "--module", "m4-loadbearing"]);
    assert.equal(mapped.ok, true);
    assert.equal(mapped.command, "doc-map");
    assert.equal(mapped.rows, 2);
    assert.deepEqual(mapped.report.readSet.mandatory.map((entry: { readonly id: string }) => entry.id), ["adr-0011"]);
    assert.deepEqual(mapped.report.readSet.recommended.map((entry: { readonly id: string }) => entry.id), ["testing-standard"]);
  });
});

test("CLI doc map treats missing manifest as an empty declaration", () => {
  withTempRoot((rootDir) => {
    const mapped = runJson(rootDir, ["doc", "map", "--module", "m4-loadbearing"]);

    assert.equal(mapped.ok, true);
    assert.equal(mapped.command, "doc-map");
    assert.equal(mapped.rows, 0);
    assert.equal(mapped.paths.primary, "harness/docmap.json");
    assert.deepEqual(mapped.report.readSet, { mandatory: [], recommended: [] });
  });
});

test("CLI doc list fails closed on invalid manifest", () => {
  withTempRoot((rootDir) => {
    writeDocmap(rootDir, {
      schema: "docmap/v1",
      documents: [
        doc("bad", "../outside.md", ["m4-loadbearing"], [])
      ]
    });

    const failure = runJson(rootDir, ["doc", "list"], false);
    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "docmap_invalid");
  });
});

function doc(id: string, docPath: string, modules: string[], productLines: string[]) {
  return {
    id,
    path: docPath,
    kind: "adr",
    scope: { modules, productLines },
    owner: "architecture",
    brief: `${id} brief`
  };
}

function writeDocmap(rootDir: string, value: unknown): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  writeFileSync(path.join(harnessRoot, "docmap.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-docmap-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return JSON.parse(failure.stdout ?? "{}") as Record<string, any>;
  }
}
