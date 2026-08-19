// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection, sha256Text, stableStringify } from "../../kernel/src/index.ts";

const cli = path.resolve("packages/cli/src/index.ts");

test("CLI merges two independently initialized Git Harness repositories into a third center", (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-cli-multi-source-")), first = path.join(parent, "first"), second = path.join(parent, "second"), center = path.join(parent, "center"), userRoot = path.join(parent, "user");
  try {
    initialize(first, userRoot, "source-first"); initialize(second, userRoot, "source-second"); initialize(center, userRoot, "center");
    addSourceData(first, "alpha", "person_alpha"); addSourceData(second, "beta", "person_beta");
    const receipt = run(center, userRoot, ["migrate", "import", "--source", first, "--source", second]);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt)); assert.equal(receipt.exitCode, 0); assert.match(String(receipt.summary), /Migration import batch \(2\/2 sources processed\)/u); assert.match(String(receipt.summary), /REMAP task task_shared -> task_shared__[0-9a-f]{10}/u);
    const events = makeTaskEventStore({ repoId: "center", rootDir: center }).read().events.filter((event) => event.schema === "migration-import-event/v1" && event.payload.entity.kind === "task" && event.payload.migratedFrom === "task_shared");
    assert.equal(events.length, 2); assert.equal(new Set(events.map(({ opId }) => opId)).size, 2); assert.equal(events.some((event) => event.payload.entity.kind === "task" && event.payload.entity.task.taskId.startsWith("task_shared__")), true);
    const maps = readdirSync(path.join(center, "harness/migrations"), { recursive: true }).filter((entry) => String(entry).endsWith("id-map.json")).map((entry) => JSON.parse(readFileSync(path.join(center, "harness/migrations", String(entry)), "utf8")) as { readonly remappings: readonly { readonly entityType: string; readonly sourceId: string; readonly targetId: string }[] });
    assert.equal(maps.length, 2); assert.equal(maps.flatMap(({ remappings }) => remappings).some(({ entityType, sourceId, targetId }) => entityType === "task" && sourceId === "task_shared" && targetId.startsWith("task_shared__")), true);
    run(center, userRoot, ["daemon", "stop"]);
    const store = makeTaskEventStore({ repoId: "center", rootDir: center }), digest = (file: string): string => { const projection = makeTaskProjection({ rootDir: center, eventStore: store, projectionPath: file, now: () => "2026-08-19T00:00:00.000Z" }); projection.rebuild(); return sha256Text(stableStringify({ tasks: projection.list(), decisions: projection.listDecisions({}), facts: projection.readFactGraph() })); }, firstDigest = digest(path.join(parent, "cold-one.sqlite")), secondDigest = digest(path.join(parent, "cold-two.sqlite"));
    assert.equal(firstDigest, secondDigest); context.diagnostic(`cli.outcome=${String(receipt.outcome)}\ncli.sources=2\ncenter.taskMigrationEvents=${events.length}\ncenter.idMaps=${maps.length}\ncenter.remapRecorded=true\ncold.digest.one=${firstDigest}\ncold.digest.two=${secondDigest}`);
  } finally { stop(userRoot, center); rmSync(parent, { recursive: true, force: true }); }
});

function initialize(root: string, userRoot: string, repoId: string): void { mkdirSync(root, { recursive: true }); git(root, "init", "-q"); git(root, "config", "user.name", "CLI Migration Test"); git(root, "config", "user.email", "cli-migration@example.invalid"); git(root, "commit", "--allow-empty", "-qm", "project root"); const receipt = run(root, userRoot, ["init", "--repo-id", repoId, "--person-id", "person_zeyu", "--display-name", "Zeyu Li"]); assert.equal(receipt.ok, true, JSON.stringify(receipt)); run(root, userRoot, ["daemon", "stop"]); }
function addSourceData(root: string, label: string, personId: string): void { const authoredRoot = path.join(root, "harness"), taskRoot = path.join(authoredRoot, `tasks/task_shared-${label}`); mkdirSync(taskRoot, { recursive: true }); writeFileSync(path.join(authoredRoot, "people.yaml"), `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "person_zeyu", displayName: "Zeyu Li", roles: ["owner"], credentials: [] }, { personId, displayName: label, roles: ["owner"], credentials: [{ kind: "email-address", issuer: "example.invalid", subject: `${label}@example.invalid` }] }], roles: [{ roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] }] }, null, 2)}\n`); writeFileSync(path.join(taskRoot, "INDEX.md"), `---\nschema: task-package/v2\ntask_id: task_shared\ntitle: Shared ${label}\nlifecycle:\n  status: planned\n  engine: local\n  bindingCreatedAt: 2026-08-19T00:00:00.000Z\nvertical: software/coding\npreset: standard-task\nprofile: baseline\n---\n\n# Shared ${label}\n`); const gitRoot = git(authoredRoot, "rev-parse", "--show-toplevel"); git(gitRoot, "add", "."); git(gitRoot, "commit", "-qm", `add ${label} source data`); }
function run(root: string, userRoot: string, args: readonly string[]): Record<string, unknown> { const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env: environment(root, userRoot) }); assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`); return JSON.parse(result.stdout) as Record<string, unknown>; }
function environment(root: string, userRoot: string): NodeJS.ProcessEnv { const { HARNESS_ACTOR: _actor, ...base } = process.env; return { ...base, HOME: path.join(root, ".home"), GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: userRoot }; }
function stop(userRoot: string, root: string): void { spawnSync(process.execPath, [cli, "--root", root, "--json", "daemon", "stop"], { encoding: "utf8", env: environment(root, userRoot) }); }
function git(root: string, ...args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
