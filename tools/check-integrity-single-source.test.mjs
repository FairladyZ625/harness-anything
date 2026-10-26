// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "tools/check-integrity-single-source.mjs");

// The gate enumerates through git, so fixture roots must be repositories; the
// local excludesFile pin keeps the host user's global ignores out of the test.
function makeGateRoot(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ])
    execFileSync("git", args, { cwd: root });
  return root;
}

// Canonical fixtures mirror the marker form the reformed gate reads from
// source: authority declarations live next to the implementations.
function writeCanonicalStableHash(root) {
  mkdirSync(path.join(root, "packages/kernel/src/integrity"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/kernel/src/integrity/stable-hash.ts"),
    [
      "// @canonical-substrate sha256Text sha256Bytes stablePayloadHash stableStringify",
      "export function sha256Text(text) { return text; }",
      "export function sha256Bytes(bytes) { return bytes; }",
      "export function stablePayloadHash(value) { return value; }",
      "export function stableStringify(value) { return String(value); }",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writeCanonicalFrontmatter(root) {
  mkdirSync(path.join(root, "packages/kernel/src/markdown"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/kernel/src/markdown/frontmatter.ts"),
    [
      "// @canonical-substrate readFrontmatter readScalar readNestedScalar",
      "export function readFrontmatter(body) { return body; }",
      "export function readScalar(frontmatter, key) { return frontmatter + key; }",
      "export function readNestedScalar(block, key) { return block + key; }",
      "",
    ].join("\n"),
    "utf8",
  );
}

function runGate(root) {
  return spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });
}

test("integrity single-source check rejects duplicate stable hash helpers", () => {
  const root = makeGateRoot("ha-integrity-single-source-");
  writeCanonicalStableHash(root);
  mkdirSync(path.join(root, "packages/kernel/src/projection"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/kernel/src/projection/bad.ts"),
    "function stablePayloadHash(value) { return value; }\n",
    "utf8",
  );

  const result = runGate(root);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /duplicate stablePayloadHash implementation/u);
});

test("integrity single-source check rejects duplicate frontmatter scalar helpers", () => {
  const root = makeGateRoot("ha-integrity-single-source-");
  writeCanonicalFrontmatter(root);
  mkdirSync(path.join(root, "packages/cli/src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/cli/src/bad.ts"),
    "export function readScalar(frontmatter, key) { return frontmatter + key; }\n",
    "utf8",
  );

  const result = runGate(root);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /duplicate readScalar implementation/u);
});

test("integrity single-source check rejects object-literal and arrow-property duplicates", () => {
  const root = makeGateRoot("ha-integrity-single-source-");
  writeCanonicalStableHash(root);
  mkdirSync(path.join(root, "packages/daemon/src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/daemon/src/hash-shim.ts"),
    [
      "export const hashShim = {",
      "  stablePayloadHash(value) { return String(value); },",
      "  stableStringify: (value) => String(value),",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /duplicate stablePayloadHash implementation/u);
  assert.match(result.stderr, /duplicate stableStringify implementation/u);
});

test("integrity single-source check rejects class-method duplicates", () => {
  const root = makeGateRoot("ha-integrity-single-source-");
  writeCanonicalFrontmatter(root);
  mkdirSync(path.join(root, "packages/daemon/src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/daemon/src/frontmatter-reader.ts"),
    ["export class FrontmatterReader {", "  readScalar(frontmatter, key) { return frontmatter + key; }", "}", ""].join(
      "\n",
    ),
    "utf8",
  );

  const result = runGate(root);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /duplicate readScalar implementation/u);
});

test("integrity single-source check rejects markers claiming symbols the file does not define", () => {
  const root = makeGateRoot("ha-integrity-single-source-");
  writeCanonicalStableHash(root);
  mkdirSync(path.join(root, "packages/kernel/src/markdown"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/kernel/src/markdown/frontmatter.ts"),
    [
      "// @canonical-substrate readFrontmatter readScalar notDefinedHere",
      "export function readFrontmatter(body) { return body; }",
      "export function readScalar(frontmatter, key) { return frontmatter + key; }",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /marker does not define notDefinedHere in this file/u);
});

test("integrity single-source check rejects the same symbol claimed by two files", () => {
  const root = makeGateRoot("ha-integrity-single-source-");
  writeCanonicalStableHash(root);
  mkdirSync(path.join(root, "packages/kernel/src/other"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/kernel/src/other/fake-authority.ts"),
    [
      "// @canonical-substrate stablePayloadHash",
      "export function stablePayloadHash(value) { return value; }",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /claims for stablePayloadHash in multiple files/u);
});

test("integrity single-source check fails closed when no marker declares any authority", () => {
  const root = makeGateRoot("ha-integrity-single-source-");
  mkdirSync(path.join(root, "packages/kernel/src"), { recursive: true });
  writeFileSync(path.join(root, "packages/kernel/src/plain.ts"), "export const ok = true;\n", "utf8");

  const result = runGate(root);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /no @canonical-substrate declarations found/u);
});

test("integrity single-source check rejects a marker that lists no symbols", () => {
  const root = makeGateRoot("ha-integrity-single-source-");
  writeCanonicalStableHash(root);
  mkdirSync(path.join(root, "packages/kernel/src/markdown"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/kernel/src/markdown/frontmatter.ts"),
    [
      "// @canonical-substrate — prose only, no symbol list",
      "export function readScalar(frontmatter, key) { return frontmatter + key; }",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /marker declares no symbols/u);
});

test("integrity single-source check rejects an inlined stable payload hash pipeline", () => {
  const root = makeGateRoot("ha-integrity-single-source-");
  writeCanonicalStableHash(root);
  mkdirSync(path.join(root, "packages/daemon/src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/daemon/src/payload-digest.ts"),
    [
      "import { createHash } from 'node:crypto';",
      "export const digest = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /duplicate stable payload hash implementation/u);
});

test("integrity single-source check accepts imports, call sites, data properties, and unrelated byte hashes", () => {
  const root = makeGateRoot("ha-integrity-single-source-");
  writeCanonicalStableHash(root);
  writeCanonicalFrontmatter(root);
  mkdirSync(path.join(root, "packages/daemon/test/fixtures"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/daemon/test/fixtures/good.ts"),
    [
      "import { createHash } from 'node:crypto';",
      "import { stablePayloadHash } from '@harness-anything/kernel/internal/integrity/stable-hash';",
      "export const counters = { sha256Bytes: 0, sha256Calls: 0 };",
      "export const snapshot = { sha256Bytes: counters.sha256Bytes };",
      "export const ok = [stablePayloadHash({ a: 1 }), createHash('sha256').update('bytes').digest('hex')];",
      "",
    ].join("\n"),
    "utf8",
  );

  const output = execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });
  assert.match(output, /Integrity single-source check passed/u);
});

const requiredScanRoots = ["packages"];
for (const omitted of requiredScanRoots) {
  for (const state of ["missing", "empty", "excluded-only"]) {
    test(`check-integrity-single-source rejects ${state} required scan root ${omitted}`, () => {
      const root = makeGateRoot("ha-gate-discovery-");
      try {
        for (const scanRoot of requiredScanRoots) {
          if (scanRoot === omitted && state === "missing") continue;
          mkdirSync(path.join(root, scanRoot), { recursive: true });
          if (scanRoot !== omitted) writeFileSync(path.join(root, scanRoot, "good.ts"), "export const ok = true;\n");
          if (scanRoot === omitted && state === "excluded-only") {
            mkdirSync(path.join(root, scanRoot, "dist"), { recursive: true });
            writeFileSync(path.join(root, scanRoot, "dist/ignored.ts"), "export const ignored = true;\n");
            writeFileSync(path.join(root, ".gitignore"), "dist/\n");
          }
        }
        const result = runGate(root);
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stderr, /ENOENT|no source files/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
