// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cli = path.resolve("packages/cli/src/index.ts");
const kinds = ["task", "fact", "decision", "agent", "squad", "policy", "execution", "review", "runtime-session"];

test("ha entity explain returns the uniform contract for all nine kinds", (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-kind-authority-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  try {
    setupRepository(root);
    assert.equal(run(root, userRoot, ["daemon", "start", "--service"]).ok, true);
    assert.equal(
      run(root, userRoot, ["daemon", "repo", "register", "--repo-id", "kind-authority", "--root", root, "--no-link"])
        .ok,
      true,
    );
    for (const kind of kinds) {
      const receipt = run(root, userRoot, ["entity", "explain", kind]);
      assert.equal(receipt.outcome, "applied", kind);
      const explanation = JSON.parse(String(receipt.evidence)) as { schema: string; kind: string };
      assert.deepEqual(
        { schema: explanation.schema, kind: explanation.kind },
        {
          schema: "entity-kind-explanation/v1",
          kind,
        },
      );
      context.diagnostic(`ha entity explain ${kind}: ${JSON.stringify(explanation)}`);
    }
  } finally {
    runBestEffort(root, userRoot, ["daemon", "stop"]);
    rmSync(parent, { recursive: true, force: true });
  }
});

function setupRepository(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf8");
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n", "utf8");
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `schema: harness-people/v1
people:
  - personId: owner
    displayName: Owner
    primaryEmail: owner@example.test
    roles: [owner]
    credentials:
      - kind: unix-socket-owner-boundary
        issuer: host:${hostname()}
        subject: ${process.getuid?.() ?? 0}
roles:
  - roleId: owner
    commandClasses: [admin, repo-write, repo-read, arbiter]
`,
    "utf8",
  );
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Kind Authority Test");
  git(root, "config", "user.email", "kind-authority@example.test");
  git(root, "add", "README.md", "harness/harness.yaml", "harness/people.yaml");
  git(root, "commit", "--quiet", "-m", "fixture");
}

function environment(root: string, userRoot: string): NodeJS.ProcessEnv {
  const {
    HARNESS_ACTOR: _actor,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repoId,
    HARNESS_DAEMON_ID: _daemonId,
    ...base
  } = process.env;
  return {
    ...base,
    HOME: path.join(root, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: userRoot,
  };
}

function run(root: string, userRoot: string, args: readonly string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: environment(root, userRoot),
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function runBestEffort(root: string, userRoot: string, args: readonly string[]): void {
  spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: environment(root, userRoot),
  });
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
