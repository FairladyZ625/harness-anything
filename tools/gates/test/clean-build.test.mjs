// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCleanBuild } from "../clean-build.mjs";
import { makeRepo } from "./helpers.mjs";

test("G30 builds exports in a git archive without relying on stale dist", () => {
  const { rootDir } = makeRepo({
    "package.json": JSON.stringify({ private: true, scripts: { build: "node build.mjs" }, exports: "./dist/index.js" }),
    "build.mjs": "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('dist'); writeFileSync('dist/index.js', 'export {};');\n",
    "src/index.js": "export {};\n"
  });
  const result = evaluateCleanBuild(rootDir);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.commands, ["npm run build"]);
});

test("G30 rejects tracked generated exports before building", () => {
  const { rootDir } = makeRepo({
    "package.json": JSON.stringify({ exports: "./dist/index.js" }),
    "dist/index.js": "export const stale = true;\n"
  });
  const result = evaluateCleanBuild(rootDir);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /present before the clean build/u);
});
