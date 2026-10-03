// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const moduleUrl = new URL("../scripts/npm-command.mjs", import.meta.url).href;

test("npm commands preserve arguments, cwd and failures through the JS lifecycle entry", () => {
  const root = mkdtempSync(path.join(tmpdir(), "gui-npm-command-"));
  const npmCli = path.join(root, "npm entry.cjs");
  writeFileSync(
    npmCli,
    'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})); process.exit(process.argv.includes("fail") ? 7 : 0);',
  );
  const script = `import {runNpm} from ${JSON.stringify(moduleUrl)}; console.log(runNpm(process.argv.slice(1), {cwd: ${JSON.stringify(root)}, encoding: "utf8"}));`;
  const env = { ...process.env, npm_execpath: npmCli };
  try {
    const args = ["pack", "--pack-destination", path.join(root, "output with spaces")];
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, ...args], {
      env,
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output), { args, cwd: root });
    const failed = spawnSync(process.execPath, ["--input-type=module", "-e", script, "fail"], {
      env,
      encoding: "utf8",
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /status: 7/);
    delete env.npm_execpath;
    const missing = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /must run through npm run package:prepare/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
