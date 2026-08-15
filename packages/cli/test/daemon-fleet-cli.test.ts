// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cli = path.resolve("packages/cli/src/index.ts"), quotaBytes = 64 * 1024 * 1024;

test("fleet center start and edge sync mirror the authoritative ledger through the CLI", { timeout: 180_000 }, () => {
  const fixture = setup();
  try {
    const capabilities = JSON.parse(spawnSync(process.execPath, [cli, "capabilities", "--json"], { encoding: "utf8" }).stdout) as Record<string, string[]>;
    assert.deepEqual(capabilities.daemon?.filter((id) => id.startsWith("daemon-fleet")), ["daemon-fleet-center-start", "daemon-fleet-edge-sync"]);
    assert.equal(run(fixture, "center", ["daemon", "start", "--service"]).ok, true);
    register(fixture);
    assert.equal(run(fixture, "center", ["task", "create", "--id", "task-fleet", "--admin", "--title", "Fleet"]).outcome, "applied");
    assert.equal(run(fixture, "center", ["task", "start", "task-fleet", "--execution-id", "exec-fleet"]).outcome, "applied");
    const docPath = "tasks/task-fleet-fleet/notes.md", docBody = "# Fleet mirror note\n\nfirst cut\n";
    writeFileSync(path.join(fixture.repo, "harness", docPath), docBody);
    assert.equal(run(fixture, "center", ["doc", "sync", "--submit", "--execution-id", "exec-fleet", "--path", docPath]).outcome, "applied");
    const missing = maybeRun(fixture, "center", ["daemon", "fleet", "center", "start"]);
    assert.equal(missing.status, 2); assert.equal(missing.receipt.code, "missing_field"); assert.match(String(missing.receipt.nextAction), /--port --key --cert --roster --quota-bytes/u);
    const rejected = maybeRun(fixture, "center", ["daemon", "fleet", "center", "start", "--port", "0", "--key", fixture.key, "--cert", fixture.cert, "--roster", fixture.badRoster, "--quota-bytes", String(quotaBytes)]);
    assert.equal(rejected.receipt.code, "roster_invalid"); assert.match(String(rejected.receipt.nextAction), /nodes must be a non-empty array/u);
    const center = run(fixture, "center", ["daemon", "fleet", "center", "start", "--port", "0", "--key", fixture.key, "--cert", fixture.cert, "--roster", fixture.roster, "--quota-bytes", String(quotaBytes)]);
    assert.equal(center.ok, true); assert.equal(center.bind, "127.0.0.1"); assert.equal(center.stateRoot, path.join(fixture.centerUser, "fleet")); assert.equal(center.nodes, 1); assert.equal(center.assignments, 1);
    const port = center.port as number;
    assert.equal(maybeRun(fixture, "edge", ["daemon", "fleet", "edge", "sync", "--host", "127.0.0.1", "--port", String(port), "--ca", fixture.ca, "--node-id", "edge-one", "--credential", "edge-one-machine-secret", "--assignment", "assignment-edge-one", "--view-root", fixture.viewRoot, "--quota-bytes", String(quotaBytes)]).receipt.code, "daemon_unavailable");
    assert.equal(run(fixture, "edge", ["daemon", "start", "--service"]).ok, true);
    const sync = (extra: readonly string[] = []) => run(fixture, "edge", ["daemon", "fleet", "edge", "sync", "--host", "127.0.0.1", "--port", String(port), "--ca", fixture.ca, "--node-id", "edge-one", "--credential", "edge-one-machine-secret", "--assignment", "assignment-edge-one", "--view-root", fixture.viewRoot, "--quota-bytes", String(quotaBytes), ...extra]);
    const pulled = retryReplicaPending(sync);
    assert.equal(pulled.status, "fleet.ack.result/v1"); assert.equal(pulled.viewId, "edge-one-view"); assert.equal((pulled.cut as { revision: number }).revision, pulled.ackCut);
    const viewRoot = path.join(fixture.viewRoot, "repos", "fleet-demo", "views", "edge-one-view");
    assert.equal(readFileSync(path.join(viewRoot, "cuts", String(pulled.ackCut), "files", docPath), "utf8"), docBody);
    const current = JSON.parse(readFileSync(path.join(viewRoot, "current.json"), "utf8")) as { cut: { revision: number } };
    assert.equal(current.cut.revision, pulled.ackCut);
    const again = sync(); assert.equal(again.status, "fleet.replica.current/v1"); assert.deepEqual(again.cut, pulled.cut);
    const refused = maybeRun(fixture, "edge", ["daemon", "fleet", "edge", "sync", "--host", "127.0.0.1", "--port", String(port), "--ca", fixture.ca, "--node-id", "edge-one", "--credential", "wrong-secret", "--assignment", "assignment-edge-one", "--view-root", fixture.viewRoot, "--quota-bytes", String(quotaBytes)]);
    assert.equal(refused.status, 1); assert.equal(refused.receipt.code, "authentication_failed"); assert.match(String(refused.receipt.nextAction), /Reissue the credential in the center roster/u);
    const deltaBody = "# Fleet mirror note\n\nsecond cut\n"; writeFileSync(path.join(fixture.repo, "harness", docPath), deltaBody);
    assert.equal(run(fixture, "center", ["doc", "sync", "--submit", "--execution-id", "exec-fleet", "--path", docPath]).outcome, "applied");
    const delta = retryReplicaPending(sync);
    assert.equal(delta.status, "fleet.ack.result/v1"); assert.ok((delta.ackCut as number) > (pulled.ackCut as number));
    assert.equal(readFileSync(path.join(viewRoot, "cuts", String(delta.ackCut), "files", docPath), "utf8"), deltaBody);
    assert.equal(existsSync(path.join(fixture.centerUser, "fleet", "replica", "repos", "fleet-demo", "ack.sqlite")), true);
  } finally { stop(fixture, "center"); stop(fixture, "edge"); rmSync(fixture.root, { recursive: true, force: true }); }
});

function retryReplicaPending(sync: () => Record<string, unknown>): Record<string, unknown> { let last: Record<string, unknown> = {}; for (let attempt = 0; attempt < 40; attempt += 1) { last = sync(); if (last.ok !== false || last.code !== "replica_pending") return last; } return last; }
function setup(): { root: string; repo: string; centerUser: string; edgeUser: string; viewRoot: string; key: string; cert: string; ca: string; roster: string; badRoster: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-cli-")), repo = path.join(root, "repo"), centerUser = path.join(root, "center-user"), edgeUser = path.join(root, "edge-user"), viewRoot = path.join(root, "edge-view"), tls = path.join(root, "tls");
  mkdirSync(path.join(repo, "harness"), { recursive: true }); mkdirSync(tls, { recursive: true }); mkdirSync(centerUser); mkdirSync(edgeUser);
  writeFileSync(path.join(repo, "harness", "harness.yaml"), "layout:\n  authoredRoot: harness\n", "utf8");
  writeFileSync(path.join(repo, "harness", "people.yaml"), `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Fleet Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`, "utf8");
  git(repo, "init", "--quiet"); git(repo, "config", "user.name", "Fleet CLI Test"); git(repo, "config", "user.email", "fleet-cli@example.test"); git(repo, "add", "harness"); git(repo, "commit", "--quiet", "-m", "fixture");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tls, "ca.key"), "-out", path.join(tls, "ca.pem"), "-subj", "/CN=ha-fleet-cli-ca", "-days", "1"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tls, "server.key"), "-out", path.join(tls, "server.csr"), "-subj", "/CN=localhost"], { stdio: "ignore" });
  writeFileSync(path.join(tls, "san.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n", "utf8");
  execFileSync("openssl", ["x509", "-req", "-in", path.join(tls, "server.csr"), "-CA", path.join(tls, "ca.pem"), "-CAkey", path.join(tls, "ca.key"), "-CAcreateserial", "-out", path.join(tls, "server.pem"), "-days", "1", "-extfile", path.join(tls, "san.ext")], { stdio: "ignore" });
  const roster = path.join(root, "roster.json"); writeFileSync(roster, JSON.stringify({ schema: "fleet-roster/v1", nodes: [{ nodeId: "edge-one", credential: "edge-one-machine-secret" }], assignments: [{ assignmentId: "assignment-edge-one", nodeId: "edge-one", repoId: "fleet-demo", taskId: "task-fleet", executionId: "exec-fleet", viewId: "edge-one-view", personId: "owner", executorId: "fleet-edge-agent", expiresAt: "2099-01-01T00:00:00.000Z", paths: ["tasks/task-fleet-fleet/notes.md"] }] }), "utf8");
  const badRoster = path.join(root, "bad-roster.json"); writeFileSync(badRoster, JSON.stringify({ schema: "fleet-roster/v1", nodes: [], assignments: [] }), "utf8");
  return { root, repo, centerUser, edgeUser, viewRoot, key: path.join(tls, "server.key"), cert: path.join(tls, "server.pem"), ca: path.join(tls, "ca.pem"), roster, badRoster };
}
function register(fixture: ReturnType<typeof setup>): void { assert.equal(run(fixture, "center", ["daemon", "repo", "register", "--repo-id", "fleet-demo", "--root", fixture.repo]).ok, true); }
function run(fixture: ReturnType<typeof setup>, machine: "center" | "edge", args: readonly string[]): Record<string, unknown> { const result = maybeRun(fixture, machine, args); assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`); return result.receipt; }
function maybeRun(fixture: ReturnType<typeof setup>, machine: "center" | "edge", args: readonly string[]): { status: number | null; receipt: Record<string, unknown>; stderr: string } {
  const userRoot = machine === "center" ? fixture.centerUser : fixture.edgeUser, home = path.join(userRoot, "home");
  const result = spawnSync(process.execPath, [cli, "--root", fixture.repo, "--json", ...args], { encoding: "utf8", env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: userRoot } });
  return { status: result.status, receipt: JSON.parse(result.stdout) as Record<string, unknown>, stderr: result.stderr };
}
function stop(fixture: ReturnType<typeof setup>, machine: "center" | "edge"): void { spawnSync(process.execPath, [cli, "--json", "daemon", "stop"], { encoding: "utf8", env: { ...process.env, HARNESS_DAEMON_USER_ROOT: machine === "center" ? fixture.centerUser : fixture.edgeUser } }); }
function git(root: string, ...args: string[]): string { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
