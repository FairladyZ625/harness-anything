// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHermeticTestEnvironment, gitFixtureIdentityGuidance } from "./test-process-environment.mjs";

test("hermetic test environment rejects ambient Git identity and preserves the npm cache", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "ha-hermetic-git-"));
  const environment = createHermeticTestEnvironment({
    ...process.env,
    HOME: "/developer/home",
    npm_config_cache: "/developer/npm-cache"
  });
  try {
    execFileSync("git", ["-C", fixture, "init", "-q"], { env: environment.env });
    const implicitCommit = spawnSync("git", ["-C", fixture, "commit", "--allow-empty", "-m", "implicit"], {
      encoding: "utf8",
      env: environment.env
    });
    assert.equal(implicitCommit.status, 128);
    assert.match(implicitCommit.stderr, /identity|email/iu);
    assert.equal(environment.env.HOME, environment.home);
    assert.equal(environment.env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(environment.env.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(environment.env.npm_config_cache, "/developer/npm-cache");

    execFileSync("git", [
      "-C", fixture,
      "-c", "user.email=harness@example.test",
      "-c", "user.name=Harness Test",
      "commit", "--allow-empty", "-m", "explicit"
    ], { env: environment.env, stdio: "ignore" });
  } finally {
    environment.cleanup();
    rmSync(fixture, { recursive: true, force: true });
  }
  assert.equal(existsSync(environment.home), false);
});

test("hermetic test environment removes Git author and agent-session fallbacks", () => {
  const environment = createHermeticTestEnvironment({
    ...process.env,
    GIT_AUTHOR_NAME: "Developer",
    GIT_AUTHOR_EMAIL: "developer@example.test",
    HARNESS_GIT_AUTHOR_NAME: "Developer",
    HARNESS_GIT_AUTHOR_EMAIL: "developer@example.test",
    CLAUDE_CODE_SESSION_ID: "developer-session",
    CODEX_THREAD_ID: "developer-thread"
  });
  try {
    assert.equal(environment.env.GIT_AUTHOR_NAME, undefined);
    assert.equal(environment.env.GIT_AUTHOR_EMAIL, undefined);
    assert.equal(environment.env.HARNESS_GIT_AUTHOR_NAME, "Developer");
    assert.equal(environment.env.HARNESS_GIT_AUTHOR_EMAIL, "developer@example.test");
    assert.equal(environment.env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(environment.env.CODEX_THREAD_ID, undefined);
    assert.equal(environment.env.PATH, process.env.PATH);
  } finally {
    environment.cleanup();
  }
});

test("Git identity failures teach the fixture-local repair command", () => {
  assert.match(gitFixtureIdentityGuidance("Author identity unknown"), /git -c user\.email=.* -c user\.name=/u);
  assert.match(gitFixtureIdentityGuidance("Author identity unknown"), /rerun the same test command/u);
  assert.equal(gitFixtureIdentityGuidance("ordinary assertion failure"), null);
});
