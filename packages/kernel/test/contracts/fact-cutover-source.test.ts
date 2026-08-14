// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("Fact product code limits facts.md to machine bootstrap, typed compilation/projection, cold rebuild, and routing", () => {
  const mentions = sourceFiles(path.join(repoRoot, "packages"))
    .filter((file) => file.split(path.sep).includes("src"))
    .filter((file) => !file.split(path.sep).includes("dist"))
    .filter((file) => readFileSync(file, "utf8").includes("facts.md"))
    .map((file) => path.relative(repoRoot, file)).sort();
  assert.deepEqual(mentions, [
    "packages/kernel/src/domain/doc-sync.contract.ts",
    "packages/kernel/src/domain/fact-event.ts",
    "packages/kernel/src/projection/cold-rebuild-source.ts",
    "packages/kernel/src/projection/rebuildable-task-projection.ts",
    "packages/preset/src/preset-bootstrap.ts"
  ]);
  for (const retired of [
    "packages/kernel/src/domain/fact-record.ts",
    "packages/kernel/src/schemas/fact-record.ts",
    "packages/kernel/schemas/json/fact-record.schema.json"
  ]) assert.equal(existsSync(path.join(repoRoot, retired)), false, retired);
});

function sourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(target));
    else if (entry.isFile() && /\.(?:ts|tsx|mjs|js)$/u.test(entry.name)) files.push(target);
  }
  return files;
}
