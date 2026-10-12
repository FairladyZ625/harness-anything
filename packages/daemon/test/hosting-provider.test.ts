// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchCiObservations } from "../src/ci-observation-actions.ts";
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

test("GitLab observer selects the newest pipeline for its delivery branch and retains redacted failed trace", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gitlab-observer-")),
    originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(path.join(root, "harness"));
  writeFileSync(
    path.join(root, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  execFileSync("git", ["-C", root, "init", "--quiet"]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://gitlab.com/group/project.git"]);
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    assert.equal(new Headers(init?.headers).get("PRIVATE-TOKEN"), "gitlab-secret");
    if (url.includes("/pipelines?"))
      return Response.json([
        { id: 20, status: "failed", ref: "main", sha: "a".repeat(40), created_at: "2026-10-12T00:00:00Z" },
        { id: 19, status: "success", ref: "main", sha: "a".repeat(40), created_at: "2026-10-11T00:00:00Z" },
      ]);
    if (url.includes("/pipelines/20/jobs"))
      return Response.json([{ id: 200, name: "integration", status: "failed", web_url: "https://gitlab.com/job/200" }]);
    if (url.includes("/jobs/200/trace")) return new Response("failed test\ngitlab-secret\n", { status: 200 });
    throw new Error(`Unexpected GitLab request ${url}`);
  }) as typeof fetch;
  const result = await fetchCiObservations(
    {
      rootDir: root,
      settings: { read: () => ({ ci: { workflows: ["ci"] } }) },
      cellCodedError: (code, message) => Object.assign(new Error(message), { code }),
      input: {
        prepareDaemonGitEnvironment: async (_id, provider) =>
          provider === "gitlab" ? { GITLAB_TOKEN: "gitlab-secret" } : null,
      },
    } as never,
    { kind: "ci-observe-pull", instanceId: "instance-gitlab", limit: 1 } as never,
  );
  assert.deepEqual(
    result.runs.map(({ databaseId }) => databaseId),
    [20],
  );
  assert.equal(result.runs[0]!.provider, "gitlab-pipeline");
  assert.equal(
    result.runs[0]!.jobs[0]!.artifact.detail.diagnostics[0] &&
      JSON.stringify(result.runs[0]!.jobs[0]!.artifact.detail.diagnostics[0]).includes("[REDACTED]"),
    true,
  );
  assert.equal(
    calls.some((url) => url.includes("/jobs/200/trace")),
    true,
  );
});
