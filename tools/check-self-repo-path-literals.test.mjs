// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-self-repo-path-literals.mjs");
const policyPath = path.join(repoRoot, "tools/gate-allowlists/check-self-repo-path-literals.json");
const taskRef = "task_427b738002d4d6c9c42a4cf010";

// The positive control is PR #3815's rework-before registry, copied verbatim from
// the branch into the gate fixture tree: it routes a review lane by testing
// delivery paths against this checkout's directories, so a consumer repository
// can never hit it.
const issue3815Source = readFileSync(
  path.join(repoRoot, "tools/gates/test/fixtures/self-repo-path-literals-issue-3815.ts.txt"),
  "utf8",
);

const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const forbiddenDirectories = policy.entries.forbiddenDirectories.map((entry) => entry.value);

function makeGateRoot(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ]) {
    execFileSync("git", args, { cwd: root });
  }
  return root;
}

function withGateRoot(prefix, callback) {
  const root = makeGateRoot(prefix);
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeSource(root, relative, source) {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), source, "utf8");
}

function writeFixtureAllowlist(root, { allowlistedUsages = [], forbidden = forbiddenDirectories } = {}) {
  const directory = path.join(root, "allowlist");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "check-self-repo-path-literals.json"),
    JSON.stringify(
      {
        schema: "harness-anything/gate-allowlist/v1",
        gateId: "check-self-repo-path-literals",
        entries: {
          forbiddenDirectories: forbidden.map((value) => ({ value, ref: taskRef, reason: "fixture policy" })),
          allowlistedUsages: allowlistedUsages.map((entry) => ({
            ...entry,
            ref: taskRef,
            reason: "fixture exception",
          })),
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return directory;
}

function runGate(root, allowlistDirectory) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: root,
    encoding: "utf8",
    env:
      allowlistDirectory === undefined
        ? process.env
        : { ...process.env, HARNESS_GATE_ALLOWLIST_DIR: allowlistDirectory },
  });
}

test("PR #3815 persisted-shape routing prefixes are rejected", () => {
  withGateRoot("ha-self-repo-paths-", (root) => {
    writeFixtureAllowlist(root);
    writeSource(root, "packages/daemon/src/schema-migration-review.ts", issue3815Source);

    const result = runGate(root, path.join(root, "allowlist"));

    assert.equal(result.status, 1, result.stderr);
    for (const prefix of [
      "packages/kernel/src/domain/",
      "packages/kernel/src/schemas/",
      "packages/kernel/src/store/",
      "packages/kernel/src/projection/",
      "packages/preset/src/",
      "packages/preset/assets/",
    ]) {
      assert.match(
        result.stderr,
        new RegExp(`schema-migration-review\\.ts:\\d+:\\d+: repo-root directory literal "${prefix}"`),
      );
    }
  });
});

test("contract provenance file references and their anchors pass", () => {
  withGateRoot("ha-self-repo-paths-", (root) => {
    writeFixtureAllowlist(root);
    writeSource(
      root,
      "packages/kernel/src/domain/status-vocabulary.ts",
      [
        'export const statusVocabularies = [{ module: "packages/kernel/src/domain/gate-run.ts", anchor: "gateRunStates" }];',
        'export const registry = { schema: "packages/daemon/src/protocol/daemon-protocol.contract.ts#DAEMON_RPC_SCHEMA" };',
        "export const dynamic = (name: string) => `packages/preset/src/preset.contract.ts#${name}`;",
        'export const deleted = "tools/gates/canonical-event-compat.mjs";',
      ].join("\n"),
    );

    const result = runGate(root, path.join(root, "allowlist"));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Self-repo path literal check passed/u);
  });
});

test("path mentions inside comments are not string literals", () => {
  withGateRoot("ha-self-repo-paths-", (root) => {
    writeFixtureAllowlist(root);
    writeSource(
      root,
      "packages/kernel/src/domain/comment-only.ts",
      [
        "// The domain authority is packages/kernel/src/domain/schedule.ts.",
        "/* The shipped templates live under packages/preset/assets/. */",
        "export const ok = true;",
      ].join("\n"),
    );

    const result = runGate(root, path.join(root, "allowlist"));

    assert.equal(result.status, 0, result.stderr);
  });
});

test("a directory literal in a cli source is rejected", () => {
  withGateRoot("ha-self-repo-paths-", (root) => {
    writeFixtureAllowlist(root);
    writeSource(root, "packages/cli/src/routing.ts", 'export const root = "packages/kernel/src/";\n');

    const result = runGate(root, path.join(root, "allowlist"));

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /cli\/src\/routing\.ts:1:\d+: repo-root directory literal/u);
  });
});

test("a template-literal directory prefix is rejected", () => {
  withGateRoot("ha-self-repo-paths-", (root) => {
    writeFixtureAllowlist(root);
    writeSource(
      root,
      "packages/kernel/src/domain/template.ts",
      "export const under = (name: string) => `packages/kernel/src/${name}`;\n",
    );

    const result = runGate(root, path.join(root, "allowlist"));

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /repo-root directory literal "packages\/kernel\/src\/" matches/u);
  });
});

test("a directory literal for another repository's package is allowed", () => {
  withGateRoot("ha-self-repo-paths-", (root) => {
    writeFixtureAllowlist(root);
    writeSource(
      root,
      "packages/daemon/src/squad-leader-decision.ts",
      'export const example = { ownedPaths: ["packages/example/src/"] };\n',
    );

    const result = runGate(root, path.join(root, "allowlist"));

    assert.equal(result.status, 0, result.stderr);
  });
});

test("the harness layout contract is not a monorepo-private path", () => {
  // harness/tasks/ and harness/decisions/ exist in every managed repository, so
  // product code may locate its own task and decision documents there. Only
  // paths that exist solely in this monorepo may be forbidden.
  for (const value of forbiddenDirectories) assert.match(value, /^(?:packages|tools)\//u);

  withGateRoot("ha-self-repo-paths-", (root) => {
    writeFixtureAllowlist(root);
    writeSource(
      root,
      "packages/daemon/src/task-review-dispatch.ts",
      [
        "export const decisionPath = (decisionId: string) => `harness/decisions/decision-${decisionId}`;",
        'export const layoutRoots = ["harness/tasks/", "harness/decisions/"];',
      ].join("\n"),
    );

    const result = runGate(root, path.join(root, "allowlist"));

    assert.equal(result.status, 0, result.stderr);
  });
});

test("an allowlisted usage passes and is reported as such", () => {
  withGateRoot("ha-self-repo-paths-", (root) => {
    writeFixtureAllowlist(root, {
      allowlistedUsages: [
        {
          path: "packages/cli/src/cli/thin-command-doctor.ts",
          prefixes: ["packages/preset/assets/"],
        },
      ],
    });
    writeSource(
      root,
      "packages/cli/src/cli/thin-command-doctor.ts",
      'export const doctorDocDirs = ["packages/preset/assets/software-coding/templates"];\n',
    );

    const result = runGate(root, path.join(root, "allowlist"));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 allowlisted hit/u);
  });
});

test("a stale allowlist entry fails instead of rotting", () => {
  withGateRoot("ha-self-repo-paths-", (root) => {
    writeFixtureAllowlist(root, {
      allowlistedUsages: [
        {
          path: "packages/cli/src/cli/thin-command-doctor.ts",
          prefixes: ["packages/preset/assets/"],
        },
      ],
    });
    writeSource(root, "packages/cli/src/cli/thin-command-doctor.ts", "export const doctor = true;\n");

    const result = runGate(root, path.join(root, "allowlist"));

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /stale allowlist entry: packages\/cli\/src\/cli\/thin-command-doctor\.ts/u);
  });
});

test("an empty product source root fails closed", () => {
  withGateRoot("ha-self-repo-paths-", (root) => {
    writeFixtureAllowlist(root);
    writeSource(root, "packages/README.md", "no source here\n");

    const result = runGate(root, path.join(root, "allowlist"));

    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /required scan root packages\/\*\/src has no source files/u);
  });
});

test("an emptied forbidden policy fails closed", () => {
  withGateRoot("ha-self-repo-paths-", (root) => {
    writeFixtureAllowlist(root, { forbidden: [] });
    writeSource(root, "packages/kernel/src/domain/ok.ts", "export const ok = true;\n");

    const result = runGate(root, path.join(root, "allowlist"));

    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /forbiddenDirectories must not be empty/u);
  });
});

test("the current repository passes with its reviewed exceptions", () => {
  const result = runGate(repoRoot);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Self-repo path literal check passed/u);
});
