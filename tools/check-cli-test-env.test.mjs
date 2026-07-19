// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkCliTestEnv, formatCliTestEnvReport } from "./check-cli-test-env.mjs";

test("shared CLI test env construction passes", () => {
  withFixture((rootDir) => {
    writeTest(rootDir, "good.test.ts", `
      execFileSync(process.execPath, [cliEntry, "--json"], { env: cliTestEnv({ HARNESS_ACTOR: "agent:test" }) });
    `);

    assert.deepEqual(checkCliTestEnv(rootDir), []);
  });
});

test("direct process env construction turns the check red", () => {
  withFixture((rootDir) => {
    writeTest(rootDir, "leak.test.ts", `
      execFileSync(process.execPath, [cliEntry, "--json"], { env: { ...process.env, HARNESS_ACTOR: "agent:test" } });
    `);

    const violations = checkCliTestEnv(rootDir);

    assert.equal(violations.length, 1);
    assert.match(formatCliTestEnvReport(violations), /use cliTestEnv/u);
  });
});

test("inline blanking turns the check red", () => {
  withFixture((rootDir) => {
    writeTest(rootDir, "drift.test.ts", `
      const env = { CODEX_SESSION_ID: "" };
    `);

    const violations = checkCliTestEnv(rootDir);

    assert.equal(violations.length, 1);
    assert.match(formatCliTestEnvReport(violations), /duplicates cliTestEnv authority/u);
  });
});

test("non-CLI subprocess process env construction remains outside this gate", () => {
  withFixture((rootDir) => {
    writeTest(rootDir, "git.test.ts", `
      execFileSync("git", ["status"], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    `);

    assert.deepEqual(checkCliTestEnv(rootDir), []);
  });
});

function writeTest(rootDir, filename, source) {
  const testDir = path.join(rootDir, "packages", "cli", "test");
  mkdirSync(testDir, { recursive: true });
  writeFileSync(path.join(testDir, filename), source, "utf8");
}

function withFixture(run) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-test-env-check-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
