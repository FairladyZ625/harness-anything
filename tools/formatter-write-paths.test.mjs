// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("pre-commit formats and re-stages only staged source", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "formatter-write-paths-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "formatter-test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Formatter Test"]);
  execFileSync("git", ["-C", root, "config", "core.hooksPath", "tools/git-hooks"]);
  mkdirSync(path.join(root, "tools/git-hooks"), { recursive: true });
  copyFileSync(path.join(repositoryRoot, "tools/git-hooks/pre-commit"), path.join(root, "tools/git-hooks/pre-commit"));
  chmodSync(path.join(root, "tools/git-hooks/pre-commit"), 0o755);
  copyFileSync(path.join(repositoryRoot, "prettier.config.mjs"), path.join(root, "prettier.config.mjs"));
  copyFileSync(path.join(repositoryRoot, "package.json"), path.join(root, "package.json"));
  symlinkSync(
    path.join(repositoryRoot, "node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const properties = Array.from({ length: 100 }, (_, index) => `item${String(index).padStart(3, "0")}:${index}`),
    source = `const value={${properties.join(",")}};\n`;
  assert.ok(source.trimEnd().length > 1000);
  writeFileSync(path.join(root, "sample.ts"), source);
  writeFileSync(path.join(root, "unstaged.ts"), source);
  execFileSync("git", ["-C", root, "add", "sample.ts"]);
  execFileSync("git", ["-C", root, "commit", "-m", "test: format staged source"]);
  const committed = execFileSync("git", ["-C", root, "show", "HEAD:sample.ts"], {
      encoding: "utf8",
    }).replaceAll("\r\n", "\n"),
    committedLines = committed.trimEnd().split("\n");
  assert.match(committed, /const value = \{\n/u);
  assert.match(committed, /item099: 99,\n/u);
  assert.ok(committedLines.every((line) => line.length <= 120));
  assert.equal(readFileSync(path.join(root, "unstaged.ts"), "utf8"), source);
});
