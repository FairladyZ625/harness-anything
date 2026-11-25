// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scanWindowsPortability } from "./check-windows-portability.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const taskRef = "task_60653ee4139523060fac49b667";

async function withSyntheticRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-check-windows-portability-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function writeSource(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function writeAllowlist(
  root,
  { hardcodedTmpSock = [], unguardedCmdSpawn = [], unguardedPosixModeAssertion = [] } = {},
) {
  const allowlistRoot = path.join(root, ".allowlists");
  mkdirSync(allowlistRoot, { recursive: true });
  const wrap = (entries) =>
    entries.map((entry) => ({
      ...entry,
      ref: taskRef,
      reason: "fixture baseline",
    }));
  writeFileSync(
    path.join(allowlistRoot, "check-windows-portability.json"),
    JSON.stringify(
      {
        schema: "harness-anything/gate-allowlist/v1",
        gateId: "check-windows-portability",
        entries: {
          hardcodedTmpSock: wrap(hardcodedTmpSock),
          unguardedCmdSpawn: wrap(unguardedCmdSpawn),
          unguardedPosixModeAssertion: wrap(unguardedPosixModeAssertion),
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return allowlistRoot;
}

test("positive control: rejects hardcoded /tmp/*.sock literals and template strings", async () => {
  await withSyntheticRoot(async (root) => {
    const allowlistRoot = writeAllowlist(root);
    writeSource(
      root,
      "packages/daemon/test/posix-sock.test.ts",
      [
        'const a = "/tmp/daemon.sock";',
        'const b = "/private/tmp/agent.sock";',
        "const c = (id: string) => `/tmp/harness-${id}.sock`;",
        'const d = \'unix_sockets={"/tmp/harness-501/r.sock"="allow"}\';',
        "export { a, b, c, d };",
      ].join("\n"),
    );

    const result = await scanWindowsPortability(root, { allowlistRoot, report: false });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 4);
    for (const violation of result.violations) {
      assert.match(violation, /\[hardcoded-tmp-sock\]/u);
    }
  });
});

test("negative control: allows os.tmpdir(), named pipes, and comments mentioning /tmp/*.sock", async () => {
  await withSyntheticRoot(async (root) => {
    const allowlistRoot = writeAllowlist(root);
    writeSource(
      root,
      "packages/daemon/test/portable-sock.test.ts",
      [
        'import { tmpdir } from "node:os";',
        'import path from "node:path";',
        "// Never hardcode /tmp/daemon.sock in tests.",
        "/* Legacy paths looked like /private/tmp/agent.sock */",
        'export const endpoint = process.platform === "win32" ? "\\\\\\\\.\\\\pipe\\\\ha-test" : path.join(tmpdir(), "ha-test.sock");',
        "export const dynamic = `${tmpdir()}/relay.sock`;",
      ].join("\n"),
    );

    const result = await scanWindowsPortability(root, { allowlistRoot, report: false });
    assert.equal(result.ok, true, result.violations.join("\n"));
    assert.equal(result.violations.length, 0);
  });
});

test("positive control: rejects unguarded spawnSync/execFileSync of .cmd and bare npm shims", async () => {
  await withSyntheticRoot(async (root) => {
    const allowlistRoot = writeAllowlist(root);
    writeSource(
      root,
      "tools/bad-spawn.mjs",
      [
        'import { execFileSync, spawnSync } from "node:child_process";',
        'import path from "node:path";',
        'spawnSync("npm.cmd", ["run", "build"]);',
        'execFileSync("npm.cmd", ["pack"], { cwd: "." });',
        'execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], { cwd: ".", shell: false });',
        'spawnSync("npm", ["test"], { cwd: "." });',
        'const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";',
        'spawnSync(npmBin, ["ci"], { cwd: "." });',
        'execFileSync(path.join("bin", "tool.cmd"), ["--version"], { cwd: "." });',
      ].join("\n"),
    );

    const result = await scanWindowsPortability(root, { allowlistRoot, report: false });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 6, result.violations.join("\n"));
    for (const violation of result.violations) {
      assert.match(violation, /\[unguarded-cmd-spawn\]/u);
    }
  });
});

test("negative control: allows shell-guarded, cmdShellInvocation, execPath, and non-win32 spawns", async () => {
  await withSyntheticRoot(async (root) => {
    const allowlistRoot = writeAllowlist(root);
    writeSource(
      root,
      "tools/good-spawn.mjs",
      [
        'import { execFileSync, spawnSync } from "node:child_process";',
        'import { cmdShellInvocation } from "../packages/storage/src/store/cmd-command-line.ts";',
        'execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], { cwd: ".", shell: process.platform === "win32" });',
        'spawnSync("npm", ["pack"], { cwd: ".", ...(process.platform === "win32" ? { shell: true } : {}) });',
        'const inv = cmdShellInvocation("npm.cmd", ["ci"], process.env);',
        'spawnSync(inv.command, inv.args, { cwd: "." });',
        'execFileSync(process.platform === "win32" ? process.execPath : "npm", ["--version"], { cwd: "." });',
        'if (process.platform !== "win32") execFileSync("npm", ["test"], { cwd: "." });',
        'execFileSync("git", ["status"], { cwd: "." });',
      ].join("\n"),
    );

    const result = await scanWindowsPortability(root, { allowlistRoot, report: false });
    assert.equal(result.ok, true, result.violations.join("\n"));
    assert.equal(result.violations.length, 0);
  });
});

test("positive control: rejects unguarded 0o600/0o700 mode assertions including inverted win32 guard", async () => {
  await withSyntheticRoot(async (root) => {
    const allowlistRoot = writeAllowlist(root);
    writeSource(
      root,
      "packages/daemon/test/bad-mode.test.ts",
      [
        'import assert from "node:assert/strict";',
        'import { statSync } from "node:fs";',
        "export function check(file: string, dir: string, expect: any) {",
        "  assert.equal(statSync(file).mode & 0o777, 0o600);",
        "  assert.strictEqual(statSync(dir).mode & 0o777, 0o700);",
        "  expect(statSync(file).mode & 0o777).toBe(0o600);",
        '  if (process.platform === "win32") {',
        "    assert.equal(statSync(file).mode & 0o777, 0o600);",
        "  }",
        "}",
      ].join("\n"),
    );

    const result = await scanWindowsPortability(root, { allowlistRoot, report: false });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 4, result.violations.join("\n"));
    for (const violation of result.violations) {
      assert.match(violation, /\[unguarded-posix-mode-assertion\]/u);
    }
  });
});

test("negative control: allows win32-guarded mode assertions and non-assertion mode creation", async () => {
  await withSyntheticRoot(async (root) => {
    const allowlistRoot = writeAllowlist(root);
    writeSource(
      root,
      "packages/daemon/test/good-mode.test.ts",
      [
        'import assert from "node:assert/strict";',
        'import { mkdirSync, statSync } from "node:fs";',
        'import test from "node:test";',
        "export function check(file: string, dir: string) {",
        "  mkdirSync(dir, { recursive: true, mode: 0o700 });",
        '  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);',
        '  if (process.platform === "win32") {',
        "    assert.ok(statSync(file).isFile());",
        "  } else {",
        "    assert.equal(statSync(dir).mode & 0o777, 0o700);",
        "  }",
        '  assert.equal(statSync(file).mode & 0o777, process.platform === "win32" ? 0o666 : 0o600);',
        '  if (process.platform === "win32") return;',
        "  assert.equal(statSync(file).mode & 0o777, 0o600);",
        "}",
        'test("posix-only", { skip: process.platform === "win32" && "requires POSIX permissions" }, () => {',
        '  assert.equal(statSync("x").mode & 0o777, 0o600);',
        "});",
      ].join("\n"),
    );

    const result = await scanWindowsPortability(root, { allowlistRoot, report: false });
    assert.equal(result.ok, true, result.violations.join("\n"));
    assert.equal(result.violations.length, 0);
  });
});

test("ratchet allows frozen count, blocks growth, and fails stale allowlist entries", async () => {
  await withSyntheticRoot(async (root) => {
    writeSource(
      root,
      "packages/daemon/test/legacy.test.ts",
      ['export const first = "/tmp/one.sock";', 'export const second = "/tmp/two.sock";'].join("\n"),
    );

    const exactAllowlist = writeAllowlist(root, {
      hardcodedTmpSock: [{ path: "packages/daemon/test/legacy.test.ts", count: 2 }],
    });
    const exactResult = await scanWindowsPortability(root, { allowlistRoot: exactAllowlist, report: false });
    assert.equal(exactResult.ok, true, exactResult.violations.join("\n"));
    assert.equal(exactResult.allowlistedHits, 2);

    const lowerAllowlist = writeAllowlist(root, {
      hardcodedTmpSock: [{ path: "packages/daemon/test/legacy.test.ts", count: 1 }],
    });
    const growthResult = await scanWindowsPortability(root, { allowlistRoot: lowerAllowlist, report: false });
    assert.equal(growthResult.ok, false);
    assert.match(growthResult.violations[0], /exceeds frozen baseline 1/u);

    const staleAllowlist = writeAllowlist(root, {
      hardcodedTmpSock: [{ path: "packages/daemon/test/legacy.test.ts", count: 3 }],
    });
    const staleResult = await scanWindowsPortability(root, { allowlistRoot: staleAllowlist, report: false });
    assert.equal(staleResult.ok, false);
    assert.match(staleResult.violations[0], /stale allowlist entry: packages\/daemon\/test\/legacy\.test\.ts/u);
  });
});

test("empty scan root fails closed", async () => {
  await withSyntheticRoot(async (root) => {
    const allowlistRoot = writeAllowlist(root);
    writeSource(root, "packages/README.md", "no source files\n");

    await assert.rejects(
      () => scanWindowsPortability(root, { allowlistRoot, report: false }),
      /required scan roots .* contain no source files/u,
    );
  });
});

test("live repository passes check-windows-portability with zero violations", async () => {
  const result = await scanWindowsPortability(repoRoot, { report: false });
  assert.equal(result.ok, true, result.violations.join("\n"));
  assert.equal(result.violations.length, 0);
  assert.ok(result.scannedFiles > 1000, `expected >1000 source/test files scanned, got ${result.scannedFiles}`);
});
