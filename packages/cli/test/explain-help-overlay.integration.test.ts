// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openBootstrappedRepoCell as openRepoCell } from "../../daemon/test/repo-settings.fixture.ts";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const cli = path.resolve("packages/cli/src/index.ts"),
  repoId = "explain-help-overlay";

test("ha explain and Task help overlay share one typed read, renderer, cut, and zero-write result", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-explain-help-overlay-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  try {
    initialize(root);
    await seedTasks(root);
    startDaemon(root, userRoot);
    assert.equal(
      runJson(root, userRoot, ["daemon", "repo", "register", "--repo-id", repoId, "--root", root, "--no-link"]).status,
      0,
    );

    const store = makeTaskEventStore({ repoId: workspaceId(repoId), rootDir: canonicalRoot(root) }),
      beforeStream = store.read(),
      beforeGit = git(root, "status", "--porcelain=v1"),
      catalog = requireSuccess(runJson(root, userRoot, ["explain", "task"])),
      explained = requireSuccess(runJson(root, userRoot, ["explain", "task/task-planned"])),
      overlaid = requireSuccess(runJson(root, userRoot, ["task", "--help", "--explain", "task/task-planned"]));
    assert.equal(catalog.mode, "catalog");
    assert.equal(catalog.evaluatedAtCut, null);
    assert.equal(
      catalog.subjects[0]!.actions.every(
        (row) => row.available === null && row.criteria.every(({ status }) => status === "not-evaluated"),
      ),
      true,
    );
    assert.deepEqual(overlaid, explained);

    const explainHuman = runText(root, userRoot, ["explain", "task/task-planned"]),
      overlayHuman = runText(root, userRoot, ["task", "--help", "--explain", "task/task-planned"]);
    assert.equal(explainHuman.status, 0, explainHuman.stderr);
    assert.equal(overlayHuman.status, 0, overlayHuman.stderr);
    assert.equal(overlayHuman.stdout, explainHuman.stdout);
    assert.match(explainHuman.stdout, /evaluated cut: canonical:/u);

    const active = requireSuccess(runJson(root, userRoot, ["explain", "task/task-active"]));
    assert.notDeepEqual(availability(explained), availability(active));

    const refs = Array.from({ length: 500 }, (_, index) =>
        index % 2 === 0 ? "task/task-planned" : "task/task-active",
      ),
      batch = requireSuccess(runJson(root, userRoot, ["explain", ...refs]));
    assert.equal(batch.subjects.length, 500);
    assert.deepEqual(
      batch.subjects.map(({ ref }) => ref),
      refs,
    );
    assert.equal(
      new Set(batch.subjects.flatMap(({ actions }) => actions.map(({ evaluatedAtCut }) => evaluatedAtCut))).size,
      1,
    );
    assert.equal(batch.evaluatedAtCut, explained.evaluatedAtCut);

    const failures = requireSuccess(
      runJson(root, userRoot, ["explain", "not-a-ref", "fact/F-ABCDEFGH", "task/task-missing"]),
    );
    assert.deepEqual(
      failures.subjects.map(({ failure }) => failure?.code),
      ["invalid_entity_ref", "unsupported_explain_target", "entity_not_found"],
    );
    const overMaximum = runJson(root, userRoot, ["explain", ...refs, "task/task-over-maximum"]);
    assert.equal(overMaximum.status, 2);
    assert.equal(overMaximum.value.code, "invalid_field");
    const retired = runJson(root, userRoot, ["entity", "explain", "task"]);
    assert.equal(retired.status, 2);
    assert.equal(retired.value.code, "unsupported_command");
    assert.match(String(retired.value.nextAction), /ha explain task/u);

    assert.deepEqual(store.read(), beforeStream);
    assert.equal(git(root, "status", "--porcelain=v1"), beforeGit);
  } finally {
    if (existsSync(userRoot)) runText(root, userRoot, ["daemon", "stop"]);
    rmSync(parent, { recursive: true, force: true });
  }
});

type Explanation = {
  readonly mode: string;
  readonly evaluatedAtCut: string | null;
  readonly subjects: readonly {
    readonly ref: string | null;
    readonly actions: readonly {
      readonly action: { readonly id: string };
      readonly available: boolean | null;
      readonly evaluatedAtCut: string | null;
      readonly criteria: readonly { readonly status: string }[];
    }[];
    readonly failure: { readonly code: string } | null;
  }[];
};

async function seedTasks(root: string): Promise<void> {
  const cell = await openRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(root),
      ownerId: "explain-help-overlay-seed",
      now: () => "2026-09-01T00:00:00.000Z",
    }),
    binding = {
      actor: { principal: { personId: "owner" }, executor: null },
      source: "local" as const,
    };
  try {
    const planned = await cell.run(
      { kind: "task-create", taskId: "task-planned", title: "Planned explain target" },
      binding,
    );
    assert.equal(planned.outcome, "applied", JSON.stringify(planned));
    await realizeTaskPlanFixture(root, String((planned as Record<string, unknown>).packagePath), (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    const active = await cell.run(
      { kind: "task-create", taskId: "task-active", title: "Active explain target" },
      binding,
    );
    assert.equal(active.outcome, "applied", JSON.stringify(active));
    await realizeTaskPlanFixture(root, String((active as Record<string, unknown>).packagePath), (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    const started = await cell.run({ kind: "task-start", taskId: "task-active" }, binding);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await cell.read("repo.tasks.list");
  } finally {
    await cell.close();
  }
}

function initialize(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Explain fixture\n", "utf8");
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    "utf8",
  );
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
  git(root, "config", "user.name", "Explain Test");
  git(root, "config", "user.email", "explain@example.test");
  git(root, "add", "README.md", "harness");
  git(root, "commit", "--quiet", "-m", "fixture");
}

function startDaemon(root: string, userRoot: string): void {
  const started = runJson(root, userRoot, ["daemon", "start", "--service"]);
  if (started.status === 0) return;
  assert.equal(started.value.code, "daemon_starting", JSON.stringify(started));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    if (runJson(root, userRoot, ["daemon", "status"]).status === 0) return;
  }
  assert.fail(String(started.value.nextAction));
}

function runJson(
  root: string,
  userRoot: string,
  args: readonly string[],
): { readonly status: number | null; readonly value: Record<string, unknown>; readonly stderr: string } {
  const result = runText(root, userRoot, args, true);
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    assert.fail(`Expected JSON output.\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return { status: result.status, value, stderr: result.stderr };
}

function runText(
  root: string,
  userRoot: string,
  args: readonly string[],
  json = false,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [cli, "--root", root, ...(json ? ["--json"] : []), ...args], {
    encoding: "utf8",
    env: environment(root, userRoot),
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function requireSuccess(result: ReturnType<typeof runJson>): Explanation {
  assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.value)}`);
  assert.equal(result.value.schema, "entity-action-explanation/v1");
  return result.value as unknown as Explanation;
}

function availability(value: Explanation): Readonly<Record<string, boolean | null>> {
  return Object.fromEntries(value.subjects[0]!.actions.map((row) => [row.action.id, row.available]));
}

function environment(root: string, userRoot: string): NodeJS.ProcessEnv {
  const {
    HARNESS_ACTOR: _actor,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repo,
    HARNESS_DAEMON_ID: _daemonId,
    HARNESS_DAEMON_USER_ROOT: _daemonUserRoot,
    ...base
  } = process.env;
  return {
    ...base,
    HOME: path.join(root, ".home"),
    TMPDIR: "/tmp",
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: repoId,
  };
}

function git(root: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
