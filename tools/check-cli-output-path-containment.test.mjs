// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const checkerPath = path.resolve("tools/check-cli-output-path-containment.mjs");

test("CLI output-path gate rejects a renamed and path-resolved bare user output write", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-cli-output-path-"));
  try {
    const sourceDir = path.join(root, "packages/cli/src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "bare-output.ts"), [
      'import { writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'import { readOption } from "./parse-options.ts";',
      "export function emit(args: string[], rootDir: string) {",
      '  const destination = path.resolve(rootDir, readOption(args, "--out") ?? "result.txt");',
      '  writeFileSync(destination, "uncontained");',
      "}",
      ""
    ].join("\n"), "utf8");

    const result = spawnSync(process.execPath, [checkerPath, "--root", root], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/cli\/src\/bare-output\.ts:6:\d+ writeFileSync receives a user-controlled output path/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI output-path gate accepts writes only after the shared resolver", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-cli-contained-output-"));
  try {
    const sourceDir = path.join(root, "packages/cli/src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "contained-output.ts"), [
      'import { writeFileSync } from "node:fs";',
      'import { readOption } from "./parse-options.ts";',
      "export function emit(args: string[], rootDir: string) {",
      '  const requested = readOption(args, "--out") ?? "result.txt";',
      "  const resolved = resolveContainedOutputPath({ requestedPath: requested, containerRoots: [rootDir], relativeTo: rootDir });",
      '  if (resolved.ok) writeFileSync(resolved.path, "contained");',
      "}",
      ""
    ].join("\n"), "utf8");

    const result = spawnSync(process.execPath, [checkerPath, "--root", root], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
