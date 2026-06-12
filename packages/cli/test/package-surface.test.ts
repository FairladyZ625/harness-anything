import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const cliPackage = JSON.parse(readFileSync("packages/cli/package.json", "utf8")) as {
  readonly name: string;
  readonly private: boolean;
  readonly scripts?: Record<string, string>;
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, string>;
  readonly files?: readonly string[];
  readonly dependencies?: Record<string, string>;
  readonly publishConfig?: unknown;
};

test("CLI package exposes the harness-anything package artifact surface without publish config", () => {
  assert.equal(cliPackage.name, "@harness-anything/cli");
  assert.equal(cliPackage.private, true);
  assert.equal(cliPackage.publishConfig, undefined);
  assert.equal(cliPackage.scripts?.build, "tsc -p tsconfig.build.json");
  assert.equal(cliPackage.bin?.["harness-anything"], "./dist/cli/src/index.js");
  assert.equal(cliPackage.exports?.["."], "./dist/cli/src/index.js");
  assert.equal(cliPackage.files?.includes("dist"), true);
  assert.equal(cliPackage.dependencies?.effect, "3.21.2");
  const cliEntry = path.resolve("packages/cli/src/index.ts");
  assert.equal(readFileSync(cliEntry, "utf8").startsWith("#!/usr/bin/env node"), true);
  assert.equal((statSync(cliEntry).mode & 0o111) !== 0, true);
});
