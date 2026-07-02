import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "tools/check-integrity-single-source.mjs");

test("integrity single-source check rejects duplicate stable hash helpers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integrity-single-source-"));
  mkdirSync(path.join(root, "packages/kernel/src/projection"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/kernel/src/projection/bad.ts"),
    "function stablePayloadHash(value) { return value; }\n",
    "utf8"
  );

  assert.throws(
    () => execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    /duplicate stablePayloadHash implementation/
  );
});

test("integrity single-source check rejects duplicate frontmatter scalar helpers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integrity-single-source-"));
  mkdirSync(path.join(root, "packages/adapters/local/src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/adapters/local/src/bad.ts"),
    "export function readScalar(frontmatter, key) { return frontmatter + key; }\n",
    "utf8"
  );

  assert.throws(
    () => execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    /duplicate readScalar implementation/
  );
});

test("integrity single-source check accepts imports and unrelated byte hashes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integrity-single-source-"));
  mkdirSync(path.join(root, "packages/kernel/src/integrity"), { recursive: true });
  mkdirSync(path.join(root, "packages/kernel/src/markdown"), { recursive: true });
  mkdirSync(path.join(root, "packages/cli/src/commands"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/kernel/src/integrity/stable-hash.ts"),
    "export function sha256Text(text) { return text; }\nexport function stablePayloadHash(value) { return value; }\nexport function stableStringify(value) { return String(value); }\n",
    "utf8"
  );
  writeFileSync(
    path.join(root, "packages/kernel/src/markdown/frontmatter.ts"),
    "export function readFrontmatter(body) { return body; }\nexport function readScalar(frontmatter, key) { return frontmatter + key; }\nexport function readNestedScalar(block, key) { return block + key; }\n",
    "utf8"
  );
  writeFileSync(
    path.join(root, "packages/cli/src/commands/good.ts"),
    "import { createHash } from 'node:crypto';\nimport { stablePayloadHash } from '../../../kernel/src/integrity/stable-hash.ts';\nexport const ok = [stablePayloadHash({ a: 1 }), createHash('sha256').update('bytes').digest('hex')];\n",
    "utf8"
  );

  const output = execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });

  assert.match(output, /Integrity single-source check passed/);
});
