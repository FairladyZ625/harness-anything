// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  mkdirSync(path.join(root, "packages/storage/src/projection"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/storage/src/projection/bad.ts"),
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

// Class fields holding arrow/function values are the dominant local style
// (hundreds of them under packages/*/src), so a reimplementation written that
// way must not be invisible. Accessors are the same surface one shape over.
test("integrity single-source check rejects class-field arrow duplicates", () => {
  const root = makeGateRoot("ha-integrity-single-source-");
  writeCanonicalStableHash(root);
  mkdirSync(path.join(root, "packages/daemon/src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/daemon/src/hash-helpers.ts"),
    [
      "export class HashHelpers {",
      "  stablePayloadHash = (value: unknown): string => String(value);",
      "  stableStringify = ((value: unknown): string => JSON.stringify(value)) as (value: unknown) => string;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /duplicate stablePayloadHash implementation/u);
  assert.match(result.stderr, /duplicate stableStringify implementation/u);
});

test("integrity single-source check rejects accessor duplicates", () => {
  const root = makeGateRoot("ha-integrity-single-source-");
  writeCanonicalStableHash(root);
  writeCanonicalFrontmatter(root);
  mkdirSync(path.join(root, "packages/daemon/src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/daemon/src/getters.ts"),
    [
      "export const helpers = {",
      "  get stableStringify(): (value: unknown) => string { return (value) => JSON.stringify(value); },",
      "};",
      "export class Reader {",
      "  get readScalar(): (frontmatter: string, key: string) => string { return (frontmatter, key) => frontmatter + key; }",
      "  set sha256Text(value: string) { void value; }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /duplicate stableStringify implementation/u);
  assert.match(result.stderr, /duplicate readScalar implementation/u);
  assert.match(result.stderr, /duplicate sha256Text implementation/u);
});

test("integrity single-source check accepts data class fields and forwarding field bindings", () => {
  const root = makeGateRoot("ha-integrity-single-source-");
  writeCanonicalStableHash(root);
  writeCanonicalFrontmatter(root);
  mkdirSync(path.join(root, "packages/daemon/src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/daemon/src/counters.ts"),
    [
      "import { stableStringify } from '@harness-anything/kernel/internal/integrity/stable-hash';",
      "export class Counters {",
      "  sha256Bytes = 0;",
      "  readonly forwarded = stableStringify;",
      "  stableStringify = this.forwarded;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const output = execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });
  assert.match(output, /Integrity single-source check passed/u);
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

// The gate's authority is the marker set itself, so the set needs a witness:
// without this pin, deleting one symbol from a marker line silently unprotects
// it while the gate and every other test stay green (ADR-0022 D3 layer 2/3 —
// ceremony cost and entry-count trend for the authority surface). Updating this
// table is the deliberate act a marker change is supposed to require.
const pinnedAuthorities = {
  "packages/kernel/src/integrity/stable-hash.ts": ["sha256Bytes", "sha256Text", "stablePayloadHash", "stableStringify"],
  "packages/kernel/src/markdown/frontmatter.ts": ["readFrontmatter", "readNestedScalar", "readScalar"],
};

function readMarkerSymbols(relativeFile) {
  const text = readFileSync(path.join(repoRoot, relativeFile), "utf8");
  const symbols = [];
  for (const match of text.matchAll(/\/\/\s*@canonical-substrate\b([^\n]*)/gu)) {
    for (const token of match[1].split(/\s+/u)) {
      if (token === "") continue;
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(token)) break;
      symbols.push(token);
    }
  }
  return symbols.sort();
}

function trackedSourceFiles() {
  const listed = execFileSync("git", ["ls-files", "-z", "packages"], { cwd: repoRoot, encoding: "utf8" });
  return listed.split("\0").filter((file) => /\.(?:ts|tsx|mts|js|jsx|mjs)$/u.test(file));
}

test("integrity single-source check pins the exact canonical symbol set per authority file", () => {
  for (const [file, expected] of Object.entries(pinnedAuthorities)) {
    assert.deepEqual(
      readMarkerSymbols(file),
      [...expected].sort(),
      `${file} declares a different canonical symbol set than the pin; changing the authority set is a governance act, not an edit`,
    );
  }
});

test("integrity single-source check declares no authority file outside the pinned set", () => {
  const marked = trackedSourceFiles().filter((file) => readMarkerSymbols(file).length > 0);
  assert.deepEqual(marked.sort(), Object.keys(pinnedAuthorities).sort());
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
