// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
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
