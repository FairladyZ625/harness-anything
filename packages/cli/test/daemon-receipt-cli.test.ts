// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cli = path.resolve("packages/cli/src/index.ts");

test("daemon control renders status and registry mutation facts without json", () => {
  const fixture = setup();
  try {
    assert.equal(runJson(fixture, ["daemon", "start", "--service"]).ok, true);

    const registered = runText(fixture, ["daemon", "repo", "register", "--repo-id", "receipt", "--root", fixture.repo]);
    assert.equal(registered.status, 0, registered.stderr); assert.match(registered.stdout, /repoId=receipt/u); assert.match(registered.stdout, new RegExp(`canonicalRoot=${escapeRegExp(realpathSync.native(fixture.repo))}`, "u")); assert.match(registered.stdout, /changed=true/u);

    const unchanged = runText(fixture, ["daemon", "repo", "register", "--repo-id", "receipt", "--root", fixture.repo]);
    assert.equal(unchanged.status, 0, unchanged.stderr); assert.match(unchanged.stdout, /repoId=receipt/u); assert.match(unchanged.stdout, /changed=false/u);

    const status = runText(fixture, ["daemon", "status"]);
    assert.equal(status.status, 0, status.stderr); assert.match(status.stdout, /pid=\d+/u); assert.match(status.stdout, /repos=1/u);

    const rebuilt = runText(fixture, ["daemon", "projection", "rebuild"]);
    assert.equal(rebuilt.status, 0, rebuilt.stderr); assert.match(rebuilt.stdout, /stateDigest=sha256:[0-9a-f]{64}/u);

    const unregistered = runText(fixture, ["daemon", "repo", "unregister", "--repo-id", "receipt"]);
    assert.equal(unregistered.status, 0, unregistered.stderr); assert.match(unregistered.stdout, /repoId=receipt/u); assert.match(unregistered.stdout, /changed=true/u);

    const alreadyUnregistered = runText(fixture, ["daemon", "repo", "unregister", "--repo-id", "receipt"]);
    assert.equal(alreadyUnregistered.status, 0, alreadyUnregistered.stderr); assert.match(alreadyUnregistered.stdout, /repoId=receipt/u); assert.match(alreadyUnregistered.stdout, /changed=false/u);
  } finally {
    runJson(fixture, ["daemon", "stop"]); rmSync(fixture.root, { recursive: true, force: true });
  }
});

function setup(): { readonly root: string; readonly repo: string; readonly userRoot: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ha-daemon-receipt-")), repo = path.join(root, "repo"), userRoot = path.join(root, "user");
  mkdirSync(path.join(repo, "harness"), { recursive: true }); mkdirSync(userRoot);
  writeFileSync(path.join(repo, "harness", "harness.yaml"), "layout:\n  authoredRoot: harness\n");
  writeFileSync(path.join(repo, "harness", "people.yaml"), `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`);
  git(repo, "init", "--quiet"); git(repo, "add", "harness"); git(repo, "commit", "--quiet", "-m", "fixture");
  return { root, repo, userRoot };
}
function runJson(fixture: ReturnType<typeof setup>, args: readonly string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, "--root", fixture.repo, "--json", ...args], { encoding: "utf8", env: environment(fixture) });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`); return JSON.parse(result.stdout) as Record<string, unknown>;
}
function runText(fixture: ReturnType<typeof setup>, args: readonly string[]) { return spawnSync(process.execPath, [cli, "--root", fixture.repo, ...args], { encoding: "utf8", env: environment(fixture) }); }
function environment(fixture: ReturnType<typeof setup>): NodeJS.ProcessEnv { return { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: fixture.userRoot }; }
function git(root: string, ...args: string[]): string { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Daemon Receipt Test", GIT_AUTHOR_EMAIL: "receipt@example.test", GIT_COMMITTER_NAME: "Daemon Receipt Test", GIT_COMMITTER_EMAIL: "receipt@example.test" } }).trim(); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
