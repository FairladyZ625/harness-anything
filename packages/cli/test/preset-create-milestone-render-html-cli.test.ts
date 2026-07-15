// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeNestedHarnessRepo } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const presetId = "create-milestone";

test("CLI create-milestone guidance does not expose retired scaffold, render, or check scripts", () => {
  withTempRoot((rootDir) => {
    const inspected = runJson(rootDir, ["preset", "inspect", presetId]);
    assert.equal(inspected.preset.manifest.schema, "preset-manifest/v3");
    assert.equal(inspected.preset.version, "2.0.0");
    assert.deepEqual(inspected.preset.entrypoints, []);

    const scripts = runJson(rootDir, ["script", "list", "--source", "preset"]);
    const scriptIds = new Set(scripts.scripts.map((script: Record<string, unknown>) => String(script.id)));
    assert.equal(scriptIds.has("preset:create-milestone:scaffold"), false);
    assert.equal(scriptIds.has("preset:create-milestone:render-html"), false);
    assert.equal(scriptIds.has("preset:create-milestone:check"), false);

    const guidance = readFileSync(
      path.resolve("packages/cli/src/commands/extensions/assets/software-coding/presets/create-milestone/PRESET.md"),
      "utf8"
    );
    assert.match(guidance, /human-readable status view/u);
    assert.match(guidance, /Run the relevant repository checks/u);
  });
});

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_ACTOR: "agent:create-milestone-render-guidance-test",
      HARNESS_GIT_AUTHOR_NAME: "Harness Test",
      HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test",
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "test",
      HARNESS_USER_HOME: path.join(rootDir, ".empty-user-home")
    }
  });
  const parsed = JSON.parse(output) as Record<string, any>;
  assert.equal(parsed.ok, true, output);
  return unwrapCommandReceipt(parsed);
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-create-milestone-render-guidance-"));
  try {
    initializeNestedHarnessRepo(rootDir);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
