// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FORMAT_GLOB } from "./check-format.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const checker = path.join(repositoryRoot, "tools/check-format.mjs");

// A scrubbed fixture repository: only the pinned Prettier config and the files a case
// writes. No .gitignore, no .gitattributes, so each case isolates the property it names.
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "check-format-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyFileSync(path.join(repositoryRoot, "prettier.config.mjs"), path.join(root, "prettier.config.mjs"));
  const write = (file, body) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
  };
  const run = () => {
    const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  return { root, write, run };
}

const DIRTY = "const value={a:1,b:2};\n";
const CLEAN = "const value = { a: 1, b: 2 };\n";

test("unformatted source fails the gate with the repair command in the message", (t) => {
  const f = fixture(t);
  f.write("src/dirty.ts", DIRTY);

  const result = f.run();

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /src\/dirty\.ts/u);
  assert.match(result.output, /prettier --write/u);
});

test("formatted source passes the gate", (t) => {
  const f = fixture(t);
  f.write("src/clean.ts", CLEAN);

  const result = f.run();

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Format check passed/u);
});

for (const file of ["src/a.ts", "src/a.tsx", "tools/a.mjs", "packages/demo/test/a.js"]) {
  test(`the gate judges ${file} the same way the lint-staged glob does`, (t) => {
    const f = fixture(t);
    f.write(file, DIRTY);

    const result = f.run();

    assert.equal(result.status, 1, result.output);
  });
}

test("the gate range is exactly the lint-staged range widened to the whole tree", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  // One glob, two consumers: the hook formats what you staged, the gate checks everything.
  assert.deepEqual(Object.keys(packageJson["lint-staged"]), ["*.{ts,tsx,js,mjs}"]);
  assert.equal(FORMAT_GLOB, `**/${Object.keys(packageJson["lint-staged"])[0]}`);
});

test("a CRLF checkout of formatted source stays green, so the gate judges layout not line endings", (t) => {
  const f = fixture(t);
  f.write("src/clean.ts", CLEAN.replaceAll("\n", "\r\n"));

  const result = f.run();

  assert.equal(result.status, 0, result.output);
});

test("gitignored build output and dependencies stay out of the gate", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, ".gitignore"), "dist/\nnode_modules/\n");
  f.write("dist/generated.ts", DIRTY);
  f.write("node_modules/dep/index.js", DIRTY);
  f.write("src/clean.ts", CLEAN);

  const result = f.run();

  assert.equal(result.status, 0, result.output);
});
