// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostingProviderFromRemote } from "../src/hosting-provider.ts";

test("detects GitHub HTTPS and SSH remotes", () => {
  assert.deepEqual(hostingProviderFromRemote("https://github.com/acme/project.git"), {
    kind: "github",
    host: "github.com",
    repository: "acme/project",
  });
  assert.deepEqual(hostingProviderFromRemote("git@github.com:acme/project.git"), {
    kind: "github",
    host: "github.com",
    repository: "acme/project",
  });
});
test("detects a known provider when the repository has no authored settings file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-hosting-no-settings-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet"]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/acme/project.git"]);
    const { detectHostingProvider } = await import("../src/hosting-provider.ts");
    assert.deepEqual(await detectHostingProvider(root), {
      kind: "github",
      host: "github.com",
      repository: "acme/project",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects self-hosted GitLab and encodes its REST base", () => {
  assert.deepEqual(
    hostingProviderFromRemote("ssh://git@git.example.test:2222/group/project.git", { provider: "gitlab" }),
    {
      kind: "gitlab",
      host: "git.example.test",
      projectPath: "group/project",
      apiBaseUrl: "https://git.example.test/api/v4",
    },
  );
});

test("explicit declaration resolves an unknown host and malformed remotes fail clearly", () => {
  assert.equal(
    hostingProviderFromRemote("https://code.example.test/group/project", {
      provider: "gitlab",
      host: "code.example.test",
    }).kind,
    "gitlab",
  );
  assert.throws(() => hostingProviderFromRemote("not-a-remote"), /hosting\.provider/u);
});
