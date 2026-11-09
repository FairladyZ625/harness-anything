// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync as runGitInit, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AUTHORED_DOCUMENT_EVENT_FAMILY,
  aggregateEventFamiliesFromSnapshot,
  baselineFromSites,
  checkAggregateEventConstructionSites,
  loadAggregateEventFamilies,
  scanAggregateEventConstructionSites,
} from "./check-task-event-aggregate-entry.mjs";
import { AGGREGATE_EVENT_CONSTRUCTION_BASELINE } from "./gate-allowlists/aggregate-event-construction-baseline.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

const TASK_FAMILIES = Object.freeze([
  {
    schema: "task-event/v1",
    owner: "task",
    writers: Object.freeze(["packages/kernel/src/domain/task-lifecycle-event.ts"]),
    types: Object.freeze([
      "task_created",
      "task_transitioned",
      "task_completed",
      "task_review_responded",
      "task_archived",
      "lease_released",
      "execution_started",
    ]),
  },
  {
    schema: "agent-runtime-event/v1",
    owner: "runtime-session",
    writers: Object.freeze(["packages/kernel/src/domain/agent-runtime.ts"]),
    types: null,
  },
  AUTHORED_DOCUMENT_EVENT_FAMILY,
]);

// The gate enumerates through git, so fixture roots must be repositories; the
// local excludesFile pin keeps the host user's global ignores out of the test.
function makeGateRoot(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ])
    runGitInit("git", args, { cwd: root });
  return root;
}

function writeSource(root, rel, body) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return rel;
}

function scanFixture(root, families = TASK_FAMILIES) {
  return scanAggregateEventConstructionSites(root, families);
}

function findingsFor(sites, baseline = {}, families = TASK_FAMILIES) {
  return checkAggregateEventConstructionSites(sites, { families, baseline });
}

let repoFamilies;
function familiesForRepo() {
  return (repoFamilies ??= loadAggregateEventFamilies(repoRoot));
}

let repoSites;
function sitesForRepo() {
  return (repoSites ??= scanAggregateEventConstructionSites(repoRoot, familiesForRepo()));
}

test("gate accepts the repository baseline", () => {
  const result = spawnSync("node", [path.join(repoRoot, "tools/check-task-event-aggregate-entry.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Aggregate event construction check passed \(\d+ sites, \d+ only-decrease baseline entries\)/u,
  );
  assert.deepEqual(
    checkAggregateEventConstructionSites(sitesForRepo(), {
      families: familiesForRepo(),
      baseline: AGGREGATE_EVENT_CONSTRUCTION_BASELINE,
    }),
    [],
  );
});

// Migration guard for dec_499E4E98A3D4754132B3BCA1E6 CH1: the schema→owner rewrite
// must keep ratcheting every site the deleted task_* table used to record.
test("every pre-existing task construction site is still ratcheted", () => {
  const families = familiesForRepo(),
    keys = new Set(sitesForRepo().map(siteKey));
  const preExisting = [
    "task-event/v1|packages/kernel/src/domain/task-completion-generation-retirement.ts|envelope-call|task_completion_generation_retired",
    "task-event/v1|packages/daemon/src/repo-cell-task-command-docs.ts|dynamic-event|<dynamic>",
    "task-event/v1|packages/kernel/src/domain/task-lifecycle-event.ts|literal-type|task_amended",
    "task-event/v1|packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_archived",
    "task-event/v1|packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_contract_migrated",
    "task-event/v1|packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_deleted",
    "task-event/v1|packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_reopened",
    "task-event/v1|packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_superseded",
    "task-event/v1|packages/kernel/src/domain/task-lifecycle-command-transitions.ts|envelope-call|task_created",
    "task-event/v1|packages/kernel/src/domain/task-lifecycle-command-transitions.ts|envelope-call|task_transitioned",
    "task-event/v1|packages/kernel/src/domain/task-lifecycle-contract-support.ts|dynamic-event|<dynamic>",
    "task-event/v1|packages/kernel/src/domain/task-lifecycle-review-transitions.ts|envelope-call|task_completed",
    "task-event/v1|packages/kernel/src/domain/task-lifecycle-review-transitions.ts|envelope-call|task_review_responded",
    "task-progress-event/v1|packages/kernel/src/domain/task-progress-event.ts|literal-type|task_progress_appended",
    "task-bootstrap-event/v1|packages/preset/src/preset-bootstrap.ts|literal-type|task_bootstrapped",
  ];
  assert.equal(preExisting.length, 15);
  for (const key of preExisting) assert.ok(keys.has(key), `missing pre-existing site ${key}`);
  assert.deepEqual(
    checkAggregateEventConstructionSites(scanAggregateEventConstructionSites(repoRoot, families), {
      families,
      baseline: AGGREGATE_EVENT_CONSTRUCTION_BASELINE,
    }),
    [],
  );
});

test("a non-owner module constructing agent-runtime-event fails, the owner module passes", () => {
  const root = makeGateRoot("ha-aggregate-owner-");
  try {
    const body =
      'export const event = { schema: "agent-runtime-event/v1", type: "runtime_dispatch_requested", payload: {} };\n';
    writeSource(root, "packages/rogue/src/rogue.ts", body);
    const findings = findingsFor(scanFixture(root));
    assert.match(
      findings.join("\n"),
      /packages\/rogue\/src\/rogue\.ts.*outside the declared writers of runtime-session/u,
    );

    writeSource(root, "packages/kernel/src/domain/agent-runtime.ts", body);
    rmSync(path.join(root, "packages/rogue"), { recursive: true, force: true });
    assert.deepEqual(findingsFor(scanFixture(root)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task event types must be declared and owner-prefixed types cannot hide outside writers", () => {
  const root = makeGateRoot("ha-aggregate-undeclared-");
  try {
    writeSource(
      root,
      "packages/rogue/src/rogue.ts",
      [
        'export const withSchema = { schema: "task-event/v1", type: "task_rogue", payload: {} };',
        'export const bare = { type: "task_rogue_payload" };',
        "",
      ].join("\n"),
    );
    const findings = findingsFor(scanFixture(root));
    assert.equal(
      findings.filter((finding) => finding.includes("is not declared by schema task-event/v1")).length,
      2,
      findings.join("\n"),
    );
    assert.match(findings.join("\n"), /task_rogue.*outside the declared writers/u);
    assert.match(findings.join("\n"), /task_rogue_payload.*outside the declared writers/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("baseline counts only decrease and stale or obsolete entries fail", () => {
  const root = makeGateRoot("ha-aggregate-baseline-");
  try {
    const legacy = writeSource(root, "packages/legacy/src/legacy.ts", 'envelope(command, "task_created", {});\n');
    const key = `task-event/v1|${legacy}|envelope-call|task_created`;
    assert.deepEqual(findingsFor(scanFixture(root), { [key]: 1 }), []);

    writeSource(root, legacy, 'envelope(command, "task_created", {});\nenvelope(command, "task_created", {});\n');
    assert.match(
      findingsFor(scanFixture(root), { [key]: 1 }).join("\n"),
      /found 2 construction sites, baseline records 1/u,
    );
    assert.match(
      findingsFor(scanFixture(root), { "task-event/v1|packages/gone/src/gone.ts|literal-type|task_created": 1 }).join(
        "\n",
      ),
      /stale baseline entry has no construction site/u,
    );

    const owner = writeSource(
      root,
      "packages/kernel/src/domain/task-lifecycle-event.ts",
      'envelope(command, "task_created", {});\n',
    );
    assert.match(
      findingsFor(scanFixture(root), {
        [`task-event/v1|${owner}|envelope-call|task_created`]: 1,
      }).join("\n"),
      /baseline entry is obsolete/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// dec_6B912A63D279A922FA1288536D CH1: authored_document_* events still have one
// constructor per type, and the aggregate module is not a writer escape hatch.
test("authored_document_* keeps its exact single-constructor ratchet", () => {
  const root = makeGateRoot("ha-authored-document-entry-");
  try {
    const aggregate = writeSource(
      root,
      "packages/kernel/src/domain/authored-document.ts",
      [
        'authoredDocumentEnvelope(command, "authored_document_revised", {});',
        'const e = { schema: "authored-document-event/v1", type, payload };',
        "",
      ].join("\n"),
    );
    const families = [AUTHORED_DOCUMENT_EVENT_FAMILY],
      sites = scanFixture(root, families),
      baseline = baselineFromSites(sites, families);
    assert.equal(Object.keys(baseline).length, 2);
    assert.deepEqual(findingsFor(sites, baseline, families), []);

    writeSource(
      root,
      aggregate,
      [
        'authoredDocumentEnvelope(command, "authored_document_revised", {});',
        'authoredDocumentEnvelope(command, "authored_document_revised", {});',
        'const e = { schema: "authored-document-event/v1", type, payload };',
        "",
      ].join("\n"),
    );
    assert.match(
      findingsFor(scanFixture(root, families), baseline, families).join("\n"),
      /found 2 construction sites, baseline records 1/u,
    );

    writeSource(
      root,
      "packages/daemon/src/edge-plan-ready.ts",
      'authoredDocumentEnvelope(command, "authored_document_revised", {});\n',
    );
    assert.match(
      findingsFor(scanFixture(root, families), baseline, families).join("\n"),
      /edge-plan-ready\.ts.*outside the declared writers of document/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("families are derived from canonicalEventSchemas owners and their state-store writers", () => {
  const snapshot = {
    stateStores: [
      {
        kind: "task",
        stateStores: [
          {
            id: "task.task-events",
            role: "authority",
            medium: {
              kind: "canonical-event",
              schema: "task-event/v1",
              types: ["task_created", "task_archived"],
              writers: ["packages/kernel/src/domain/task-lifecycle-event.ts"],
            },
          },
        ],
      },
    ],
    canonicalEvents: [{ schema: "task-event/v1", owner: "task" }],
  };
  assert.deepEqual(aggregateEventFamiliesFromSnapshot(snapshot, []), [
    {
      schema: "task-event/v1",
      owner: "task",
      writers: ["packages/kernel/src/domain/task-lifecycle-event.ts"],
      types: ["task_created", "task_archived"],
    },
  ]);
  assert.throws(
    () =>
      aggregateEventFamiliesFromSnapshot(
        { stateStores: [], canonicalEvents: [{ schema: "peer-event/v1", owner: "task" }] },
        [],
      ),
    /has no authority canonical-event state store/u,
  );
  const wildcard = aggregateEventFamiliesFromSnapshot(
    {
      ...snapshot,
      stateStores: [
        {
          kind: "task",
          stateStores: [
            {
              ...snapshot.stateStores[0].stateStores[0],
              medium: { ...snapshot.stateStores[0].stateStores[0].medium, types: ["*"] },
            },
          ],
        },
      ],
    },
    [],
  );
  assert.equal(wildcard[0].types, null);
});

test("the deleted hand-written task allowlist cannot reappear", async () => {
  const gate = await import("./check-task-event-aggregate-entry.mjs"),
    source = readFileSync(path.join(repoRoot, "tools/check-task-event-aggregate-entry.mjs"), "utf8");
  assert.equal(Object.hasOwn(gate, "TASK_EVENT_CONSTRUCTION_ALLOWLIST"), false);
  assert.equal(Object.hasOwn(gate, "AUTHORED_DOCUMENT_EVENT_CONSTRUCTION_ALLOWLIST"), false);
  assert.doesNotMatch(source, /TASK_EVENT_CONSTRUCTION_ALLOWLIST|AUTHORED_DOCUMENT_EVENT_CONSTRUCTION_ALLOWLIST/u);
});

const requiredScanRoots = ["packages"];
for (const omitted of requiredScanRoots) {
  for (const state of ["missing", "empty", "excluded-only"]) {
    test(`check-task-event-aggregate-entry rejects ${state} required scan root ${omitted}`, () => {
      const root = makeGateRoot("ha-gate-discovery-");
      try {
        for (const scanRoot of requiredScanRoots) {
          if (scanRoot === omitted && state === "missing") continue;
          mkdirSync(path.join(root, scanRoot), { recursive: true });
          if (scanRoot !== omitted) writeFileSync(path.join(root, scanRoot, "good.ts"), "export const ok = true;\n");
          if (scanRoot === omitted && state === "excluded-only") {
            mkdirSync(path.join(root, scanRoot, "dist"), { recursive: true });
            writeFileSync(path.join(root, scanRoot, "dist/ignored.ts"), "export const ignored = true;\n");
            writeFileSync(path.join(root, ".gitignore"), "dist/\n");
          }
        }
        assert.throws(() => scanFixture(root), /no source files/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("zero constructors are legal when production source discovery is intact", () => {
  const root = makeGateRoot("ha-aggregate-clean-");
  try {
    writeSource(root, "packages/clean/src/good.ts", "export const ok = true;\n");
    assert.deepEqual(scanFixture(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function siteKey(site) {
  return `${site.schema}|${site.path}|${site.form}|${site.eventType}`;
}
