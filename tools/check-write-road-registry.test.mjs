// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findWriteRoadRegistryViolations } from "./check-write-road-registry.mjs";

test("write-road registry accepts exact daemon, event-store, projection, and bootstrap roads", () =>
  withFixture((root) => {
    assert.deepEqual(findWriteRoadRegistryViolations(root), []);
  }));

test("write-road registry rejects an undeclared physical write sink", () =>
  withFixture((root) => {
    write(
      root,
      "packages/application/src/local-fallback.ts",
      `import { writeFileSync } from "node:fs";\nwriteFileSync(target, body);\n`,
    );
    assert.match(findWriteRoadRegistryViolations(root).join("\n"), /physical write sink is not declared/u);
  }));

test("write-road registry rejects an undeclared promise-based write sink", () =>
  withFixture((root) => {
    write(
      root,
      "packages/daemon/src/async-log.ts",
      `import { appendFile } from "node:fs/promises";\nawait appendFile(target, body);\n`,
    );
    assert.match(
      findWriteRoadRegistryViolations(root).join("\n"),
      /async-log\.ts: physical write sink is not declared/u,
    );
  }));

test("write-road registry binds the workspace admission lock to RepoCell", () =>
  withFixture((root) => {
    const file = path.join(root, "tools/write-road-registry.json"),
      registry = JSON.parse(readFileSync(file, "utf8"));
    registry.physicalWriteFiles = [];
    writeFileSync(file, JSON.stringify(registry));
    assert.match(
      findWriteRoadRegistryViolations(root).join("\n"),
      /repo-cell\.ts: physical write sink is not declared/u,
    );
  }));

test("write-road registry classifies sqlite read-only by construction site, not by file", () =>
  withFixture((root) => {
    write(
      root,
      "packages/kernel/src/projection/mixed-projection.ts",
      [
        'import { DatabaseSync } from "node:sqlite";',
        'export function readTruth(path) { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare("SELECT 1").all(); } finally { db.close(); } }',
        'export function writeTruth(path) { const db = new DatabaseSync(path); try { db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)"); } finally { db.close(); } }',
        "",
      ].join("\n"),
    );
    assert.match(
      findWriteRoadRegistryViolations(root).join("\n"),
      /mixed-projection\.ts: physical write sink is not declared/u,
    );
  }));

test("write-road registry does not flag a file whose sqlite sites are all read-only", () =>
  withFixture((root) => {
    write(
      root,
      "packages/kernel/src/projection/read-only-projection.ts",
      [
        'import { DatabaseSync } from "node:sqlite";',
        'export function readTruth(path) { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare("SELECT 1").all(); } finally { db.close(); } }',
        'export function readOther(other) { const db = new DatabaseSync(other, { readOnly: true }); return db.prepare("SELECT 2").all(); }',
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(findWriteRoadRegistryViolations(root).join("\n"), /read-only-projection\.ts/u);
  }));

test("write-road registry rejects stale legacy rows", () =>
  withFixture((root) => {
    const file = path.join(root, "tools/write-road-registry.json"),
      registry = JSON.parse(readFileSync(file, "utf8"));
    registry.rows.push({ id: "write-coordinator.runtime-substrate", actions: [], evidence: [] });
    writeFileSync(file, JSON.stringify(registry));
    assert.match(findWriteRoadRegistryViolations(root).join("\n"), /stale or unknown row write-coordinator/u);
  }));

for (const [label, mutate, expected] of [
  ["missing row", (registry) => registry.rows.shift(), /must occur exactly once/u],
  ["duplicate row", (registry) => registry.rows.push(registry.rows[0]), /must occur exactly once/u],
  ["wrong action", (registry) => (registry.rows[0].actions[0] = "task-unknown"), /actions must equal/u],
  ["omitted action", (registry) => registry.rows[0].actions.pop(), /actions must equal/u],
  ["reordered actions", (registry) => registry.rows[0].actions.reverse(), /actions must equal/u],
  ["wrong authority", (registry) => (registry.rows[0].authority = "other.ts"), /authority\/store\/leasePolicy/u],
  ["wrong store", (registry) => (registry.rows[0].store = "other.ts"), /authority\/store\/leasePolicy/u],
  ["wrong lease policy", (registry) => (registry.rows[0].leasePolicy = "none"), /authority\/store\/leasePolicy/u],
  ["empty evidence", (registry) => (registry.rows[0].evidence = []), /evidence must be non-empty/u],
  ["missing evidence path", (registry) => (registry.rows[0].evidence = ["missing.ts"]), /missing evidence/u],
  ["stale physical sink", (registry) => registry.physicalWriteFiles.push("missing.ts"), /stale physicalWriteFiles/u],
]) {
  test(`write-road registry rejects ${label}`, () =>
    withFixture((root) => {
      const file = path.join(root, "tools/write-road-registry.json"),
        registry = JSON.parse(readFileSync(file, "utf8"));
      mutate(registry);
      writeFileSync(file, JSON.stringify(registry));
      assert.match(findWriteRoadRegistryViolations(root).join("\n"), expected);
    }));
}

test("write-road declarations cannot lose their inventory or their thin CLI consumer", () =>
  withFixture((root) => {
    const declaration = path.join(root, "packages/kernel/src/domain/action-declaration.ts"),
      original = readFileSync(declaration, "utf8");
    writeFileSync(declaration, original.replace("export const actionDeclarations", "const actionDeclarations"));
    assert.match(findWriteRoadRegistryViolations(root).join("\n"), /actionDeclarations must be exported as an array/u);
    writeFileSync(
      declaration,
      original.replace(
        'closure("task-complete", "task/complete", "lifecycle.event-publication")',
        'closure("task-complete", "task/complete")',
      ),
    );
    assert.match(findWriteRoadRegistryViolations(root).join("\n"), /actions must equal/u);
    writeFileSync(declaration, original.replaceAll("...(writeRoad === undefined ? {} : { writeRoad }),", ""));
    assert.match(
      findWriteRoadRegistryViolations(root).join("\n"),
      /missing lifecycle.event-publication action declarations/u,
    );
    writeFileSync(declaration, original);
    write(root, "packages/cli/src/cli/thin-command.ts", "export {};\n");
    assert.match(findWriteRoadRegistryViolations(root).join("\n"), /thin CLI is missing lifecycle action/u);
  }));

function withFixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "w3-write-roads-"));
  try {
    write(
      root,
      "packages/kernel/src/domain/action-declaration.ts",
      readFileSync(new URL("../packages/kernel/src/domain/action-declaration.ts", import.meta.url), "utf8"),
    );
    write(
      root,
      "packages/cli/src/cli/thin-command.ts",
      `const actions = ["task-create", "task-submit", "task-review-execution", "task-complete", "repo-bootstrap"];\n`,
    );
    write(
      root,
      "packages/daemon/src/repo-cell.ts",
      `import { openSync } from "node:fs";\nopenSync(lockPath, "wx");\nconst store = makeTaskEventStore({ rootDir });\nconst service = makeTaskLifecycleService({ eventStore: store, projection });\nlet tail = Promise.resolve(); tail = tail.then(() => service.execute(command));\n`,
    );
    write(
      root,
      "packages/kernel/src/store/task-event-store.ts",
      `const CANONICAL_EVENT_REF = "refs/ha/canonical"; prepareCommit(); finalizeRefs();\n`,
    );
    write(
      root,
      "packages/application/src/task-lifecycle-service.ts",
      `export function makeTaskLifecycleService(options) { options.eventStore.append(event); }\n`,
    );
    write(
      root,
      "tools/write-road-registry.json",
      JSON.stringify(
        {
          schema: "harness-anything/write-road-registry/v2",
          rows: [
            {
              id: "lifecycle.event-publication",
              actions: ["task-complete", "task-create", "task-review-execution", "task-submit"],
              authority: "packages/daemon/src/repo-cell.ts",
              store: "packages/kernel/src/store/task-event-store.ts",
              leasePolicy: "domain-contract",
              evidence: ["packages/daemon/src/repo-cell.ts", "packages/kernel/src/store/task-event-store.ts"],
            },
            {
              id: "workspace.bootstrap",
              actions: [
                "ledger-backup",
                "ledger-restore-drill",
                "daemon-repo-register",
                "repo-purge",
                "repo-unbind",
                "rbac-bootstrap",
                "repo-bootstrap",
              ],
              authority: "packages/daemon/src/daemon-host.ts",
              evidence: ["packages/daemon/src/daemon-host.ts"],
            },
            {
              id: "daemon.runtime-control",
              actions: ["daemon-start", "daemon-stop"],
              authority: "packages/daemon/src/runtime.ts",
              evidence: ["packages/daemon/src/runtime.ts"],
            },
            {
              id: "projection.sqlite",
              source: "task-event-store",
              authority: "packages/kernel/src/projection/rebuildable-task-projection.ts",
              evidence: ["packages/kernel/src/projection/rebuildable-task-projection.ts"],
            },
          ],
          physicalWriteFiles: ["packages/daemon/src/repo-cell.ts"],
        },
        null,
        2,
      ),
    );
    for (const file of [
      "packages/daemon/src/daemon-host.ts",
      "packages/daemon/src/runtime.ts",
      "packages/kernel/src/projection/rebuildable-task-projection.ts",
    ])
      write(root, file, "export {};\n");
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function write(root, relative, body) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}
