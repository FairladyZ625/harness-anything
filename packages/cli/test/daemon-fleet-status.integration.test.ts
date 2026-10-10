// harness-test-tier: integration
import { signInProcessPolicyTestUser } from "../../daemon/test/keycloak-process-policy.fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";

const cli = path.resolve("packages/cli/src/index.ts");

// `ha daemon fleet status` is the CLI half of the shared fleet overview read: this test drives
// the command against a real daemon the way an operator at the center would, and checks the
// human and --json outputs both carry the honest center-only facts (no edges are fabricated).
test("daemon fleet status renders the shared overview read through a live daemon", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-status-")),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user");
  try {
    mkdirSync(path.join(repo, "harness"), { recursive: true });
    mkdirSync(userRoot);
    writeFileSync(
      path.join(repo, "harness", "harness.yaml"),
      [
        "schema: harness-anything/v1",
        "layout:",
        "  authoredRoot: harness",
        "settings:",
        "  defaultPreset: standard-task",
        "",
      ].join("\n"),
    );
    git(repo, "init", "--quiet");
    git(repo, "add", "harness");
    git(repo, "commit", "--quiet", "-m", "fixture");
    seedSettingsEvent({ rootDir: repo, repoId: "fleet-status" });
    await signInProcessPolicyTestUser(userRoot, "owner", ["fleet-status"], "admin");
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      HARNESS_ACTOR: "agent:harness-test",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      // Daemon controls belong to a human session; a worker's execution credential must not
      // change how this command behaves in a test environment.
      ...{ HARNESS_EXECUTION_CREDENTIAL: undefined, HARNESS_DAEMON_ID: undefined },
    };
    const run = (args: readonly string[]) =>
      spawnSync(process.execPath, [cli, "--root", repo, ...args], { encoding: "utf8", env });
    const started = run(["daemon", "start", "--service", "--json"]);
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    const registered = run(["daemon", "repo", "register", "--repo-id", "fleet-status", "--root", repo, "--json"]);
    assert.equal(JSON.parse(registered.stdout).ok, true, registered.stderr);

    const human = run(["daemon", "fleet", "status"]);
    assert.equal(human.status, 0, `${human.stderr}\n${human.stdout}`);
    assert.match(human.stdout, /fleet overview repo=fleet-status mode=local/u);
    assert.match(human.stdout, /node center role=center/u);
    assert.match(human.stdout, /online running \(center daemon process\)/u);
    assert.match(human.stdout, /doing no task leases/u);
    assert.match(human.stdout, /links 0/u);

    const jsonRun = run(["daemon", "fleet", "status", "--json"]);
    assert.equal(jsonRun.status, 0, `${jsonRun.stderr}\n${jsonRun.stdout}`);
    const overview = JSON.parse(jsonRun.stdout) as {
      schema: string;
      ok: boolean;
      nodes: readonly { nodeId: string; role: string }[];
      links: unknown[];
    };
    assert.equal(overview.schema, "daemon.fleet-overview/v1");
    assert.equal(overview.ok, true);
    assert.deepEqual(
      overview.nodes.map((node) => `${node.nodeId}:${node.role}`),
      ["center:center"],
    );
    assert.deepEqual(overview.links, []);

    const bogus = run(["daemon", "fleet", "bogus", "--json"]);
    assert.equal(bogus.status, 2);
    assert.match(String(JSON.parse(bogus.stdout).nextAction), /daemon fleet status/u);
  } finally {
    const stopped = spawnSync(
      process.execPath,
      [cli, "--root", repo, "daemon", "stop", "--daemon-id", "default", "--json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HARNESS_DAEMON_USER_ROOT: userRoot,
          HARNESS_EXECUTION_CREDENTIAL: undefined,
        },
      },
    );
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
    rmSync(root, { recursive: true, force: true });
  }
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fleet Status Test",
      GIT_AUTHOR_EMAIL: "fleet-status-test@example.invalid",
      GIT_COMMITTER_NAME: "Fleet Status Test",
      GIT_COMMITTER_EMAIL: "fleet-status-test@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}
