import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "tools/scan-forbidden-symbols.mjs");

test("forbidden symbol scan rejects unknown write task sentinel", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-forbidden-symbols-"));
  mkdirSync(path.join(root, "packages/kernel/src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/kernel/src/bad.ts"),
    "export const bad = { taskId : 'unknown' };",
    "utf8"
  );

  assert.throws(
    () => execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    /forbidden symbol taskId: "unknown"/
  );
});

test("forbidden symbol scan rejects layout override globals", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-forbidden-symbols-"));
  mkdirSync(path.join(root, "packages/cli/src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/cli/src/bad.ts"),
    "setHarnessLayoutOverrides({ authoredRoot: 'harness' });",
    "utf8"
  );

  assert.throws(
    () => execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    /forbidden symbol setHarnessLayoutOverrides/
  );
});

test("forbidden symbol scan accepts package source without banned tokens", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-forbidden-symbols-"));
  mkdirSync(path.join(root, "packages/kernel/src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/kernel/src/good.ts"),
    "export const ok = { taskId: \"task-1\" };",
    "utf8"
  );

  const output = execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });

  assert.match(output, /Forbidden symbol scan passed/);
});
