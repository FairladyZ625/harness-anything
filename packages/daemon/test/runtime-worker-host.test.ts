// harness-test-tier: fast
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runtimeWorkerProviderEnvironment } from "../src/runtime-worker-host.ts";

test("provider environment excludes host Git and SSH credentials", () => {
  const source: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: "/operator/home",
    CODEX_HOME: "/runtime/codex",
    OPENAI_API_KEY: "provider-api-key",
    GH_TOKEN: "github-token",
    HARNESS_GITHUB_TOKEN: "harness-github-token",
    GIT_ASKPASS: "/operator/askpass",
    GIT_ASKPASS_REQUIRE: "force",
    GIT_SSH: "/operator/ssh",
    GIT_SSH_COMMAND: "ssh -i /operator/.ssh/id_ed25519",
    GIT_SSH_VARIANT: "ssh",
    SSH_AGENT_PID: "1234",
    SSH_ASKPASS: "/operator/askpass",
    SSH_ASKPASS_REQUIRE: "force",
    SSH_AUTH_SOCK: "/operator/agent.sock",
    GIT_CONFIG_GLOBAL: "/operator/.gitconfig",
    GIT_CONFIG_SYSTEM: "/operator/gitconfig",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_PARAMETERS: "credential.helper=osxkeychain",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "osxkeychain",
  };

  const environment = runtimeWorkerProviderEnvironment(source, process.platform);
  assert.equal(environment.HOME, source.HOME);
  assert.equal(environment.CODEX_HOME, source.CODEX_HOME);
  assert.equal(environment.OPENAI_API_KEY, source.OPENAI_API_KEY);
  for (const name of [
    "GH_TOKEN",
    "HARNESS_GITHUB_TOKEN",
    "GIT_ASKPASS",
    "GIT_ASKPASS_REQUIRE",
    "GIT_SSH",
    "GIT_SSH_VARIANT",
    "SSH_AGENT_PID",
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
    "SSH_AUTH_SOCK",
    "GIT_CONFIG_PARAMETERS",
  ])
    assert.equal(environment[name], undefined, `${name} must not reach the provider`);
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  assert.equal(environment.GIT_CONFIG_GLOBAL, nullDevice);
  assert.equal(environment.GIT_CONFIG_SYSTEM, nullDevice);
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(environment.GIT_CONFIG_COUNT, "1");
  assert.equal(environment.GIT_CONFIG_KEY_0, "credential.helper");
  assert.equal(environment.GIT_CONFIG_VALUE_0, "");
  assert.match(environment.GIT_SSH_COMMAND ?? "", /BatchMode=yes/u);
  assert.match(environment.GIT_SSH_COMMAND ?? "", /IdentityAgent=none/u);
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
});

test(
  "Git SSH cannot use host credentials in the provider environment",
  { skip: process.platform === "win32" ? "requires POSIX executable SSH fixture semantics" : false },
  () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-worker-host-")),
      bin = path.join(parent, "bin"),
      sshStub = path.join(bin, "ssh"),
      logPath = path.join(parent, "ssh-log.json");
    try {
      mkdirSync(bin);
      writeFileSync(
        sshStub,
        "#!/usr/bin/env node\n" +
          "const fs = require('node:fs');\n" +
          "fs.writeFileSync(process.env.SSH_STUB_LOG, JSON.stringify({ args: process.argv.slice(2), agent: process.env.SSH_AUTH_SOCK ?? null }));\n",
      );
      chmodSync(sshStub, 0o755);

      const baseEnvironment = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SSH_STUB_LOG: logPath,
        SSH_AUTH_SOCK: "/operator/agent.sock",
        GIT_SSH_COMMAND: sshStub,
      };
      const before = spawnSync("git", ["ls-remote", "ssh://git@example.invalid/repo"], {
        env: baseEnvironment,
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.notEqual(before.status, 0, before.stderr);
      const beforeLog = JSON.parse(readFileSync(logPath, "utf8")) as { args: string[]; agent: string | null };
      assert.equal(beforeLog.agent, "/operator/agent.sock");
      assert.equal(beforeLog.args.includes("IdentityAgent=none"), false);

      const environment = runtimeWorkerProviderEnvironment(baseEnvironment);
      environment.GIT_SSH_COMMAND = environment.GIT_SSH_COMMAND?.replace(/^ssh/u, sshStub);
      const after = spawnSync("git", ["ls-remote", "ssh://git@example.invalid/repo"], {
        env: environment,
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.notEqual(after.status, 0, after.stderr);
      const afterLog = JSON.parse(readFileSync(logPath, "utf8")) as { args: string[]; agent: string | null };
      assert.equal(afterLog.agent, null);
      assert.deepEqual(
        new Set(afterLog.args.filter((arg) => arg.startsWith("Identity") || arg.startsWith("Identities"))),
        new Set(["IdentityAgent=none", "IdentityFile=/dev/null", "IdentitiesOnly=yes"]),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
