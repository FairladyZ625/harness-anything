// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolveBuildCommit } from "../../../packages/gui-fde/scripts/build.mjs";
import { evaluateCleanBuild } from "../clean-build.mjs";
import { makeRepo } from "./helpers.mjs";

test("G30 builds exports in a git archive without relying on stale dist", () => {
  const { rootDir } = makeRepo({
    "package.json": JSON.stringify({ private: true, scripts: { build: "node build.mjs" }, exports: "./dist/index.js" }),
    "build.mjs":
      "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('dist'); writeFileSync('dist/index.js', 'export {};');\n",
    "src/index.js": "export {};\n",
  });
  const result = evaluateCleanBuild(rootDir);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.commands, ["npm run build"]);
});

test("G30 rejects tracked generated exports before building", () => {
  const { rootDir } = makeRepo({
    "package.json": JSON.stringify({ exports: "./dist/index.js" }),
    "dist/index.js": "export const stale = true;\n",
  });
  const result = evaluateCleanBuild(rootDir);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /present before the clean build/u);
});

test("G30 resolves workspace links inside the archive tree", () => {
  const { rootDir } = makeRepo({
    "package.json": JSON.stringify({ private: true, scripts: { build: "node build.mjs" } }),
    "build.mjs":
      "import { realpathSync } from 'node:fs'; import path from 'node:path'; " +
      "if (!realpathSync('node_modules/@harness-anything/example').startsWith(process.cwd() + path.sep)) process.exit(1);\n",
    "packages/example/package.json": JSON.stringify({ name: "@harness-anything/example", private: true }),
  });
  const scope = path.join(rootDir, "node_modules/@harness-anything");
  mkdirSync(scope, { recursive: true });
  symlinkSync(path.join(rootDir, "packages/example"), path.join(scope, "example"), "dir");
  assert.equal(realpathSync(path.join(scope, "example")), realpathSync(path.join(rootDir, "packages/example")));

  const result = evaluateCleanBuild(rootDir);

  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("G30 resolves wildcard export targets when an archived source matches", () => {
  const { rootDir } = makeRepo({
    "package.json": JSON.stringify({ private: true, exports: { "./internal/*.ts": "./src/*.ts" } }),
    "src/contract.ts": "export {};\n",
  });
  const result = evaluateCleanBuild(rootDir);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("gui-fde resolveBuildCommit falls back cleanly without .git, honors HARNESS_BUILD_COMMIT, and reads git HEAD", () => {
  const gitlessDir = mkdtempSync(path.join(tmpdir(), "ha-gui-fde-gitless-"));
  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.HARNESS_BUILD_COMMIT;
    delete cleanEnv.GIT_DIR;
    delete cleanEnv.GIT_WORK_TREE;
    assert.equal(resolveBuildCommit(gitlessDir, cleanEnv), "source-archive");
    assert.equal(
      resolveBuildCommit(gitlessDir, { ...cleanEnv, HARNESS_BUILD_COMMIT: "  stamped-sha-123  " }),
      "stamped-sha-123",
    );
    const { rootDir } = makeRepo({ "README.md": "repo\n" });
    assert.match(resolveBuildCommit(rootDir, cleanEnv), /^[0-9a-f]{40}$/u);
  } finally {
    rmSync(gitlessDir, { recursive: true, force: true });
  }
});

test("G30 succeeds when a package build resolves build-id via gui-fde resolveBuildCommit inside a gitless archive tree", () => {
  const buildScriptUrl = pathToFileURL(path.resolve("packages/gui-fde/scripts/build.mjs")).href;
  const { rootDir } = makeRepo({
    "package.json": JSON.stringify({
      private: true,
      scripts: { build: "node build.mjs" },
      exports: "./dist/build-id.txt",
    }),
    "build.mjs":
      `import { mkdirSync, writeFileSync } from "node:fs";\n` +
      `import { resolveBuildCommit } from ${JSON.stringify(buildScriptUrl)};\n` +
      `const env = { ...process.env }; delete env.HARNESS_BUILD_COMMIT; delete env.GIT_DIR; delete env.GIT_WORK_TREE;\n` +
      `const id = resolveBuildCommit(process.cwd(), env);\n` +
      `if (id !== "source-archive") throw new Error("expected source-archive, got " + id);\n` +
      `mkdirSync("dist", { recursive: true });\n` +
      `writeFileSync("dist/build-id.txt", id + "\\n", "utf8");\n`,
  });
  const result = evaluateCleanBuild(rootDir);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.commands, ["npm run build"]);
});
